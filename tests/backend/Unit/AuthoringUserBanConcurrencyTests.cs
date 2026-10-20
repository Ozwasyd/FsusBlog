using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Distributed;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

using Npgsql;

using NSubstitute;

using SqlSugar;
namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class AuthoringUserBanConcurrencyTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task AdminChangeStatusAsync_AtomicallyTransitionsActiveSessionModes()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(setupDb);
        await SeedUserAsync(setupDb, 19);
        setupDb.Insertable(new UserSession
        {
            SessionId = "status-mode-session",
            UserId = 19,
            RefreshTokenHash = "status-mode-refresh",
            RefreshFamilyId = "status-mode-family",
            IdleExpiresAt = DateTime.UtcNow.AddHours(1),
            AbsoluteExpiresAt = DateTime.UtcNow.AddDays(1),
            AuthenticationMethod = UserSessionAuthenticationMethods.Passkey,
            AuthenticationStrength = UserSessionAuthenticationStrengths.WebAuthnUv,
            AuthenticatedAtUtc = DateTime.UtcNow
        }).ExecuteCommand();
        using SqlSugarClient serviceDb = PostgresSqlSugarTestClient.Create(connectionString);
        var cache = Substitute.For<IUserSessionValidationCache>();
        cache.PublishManyAsync(
                Arg.Any<IReadOnlyList<UserSessionValidationCacheState>>(),
                true,
                Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);
        UserAdminModerationService service = CreateAdminService(
            serviceDb,
            new RecordingBanStateObligations(),
            cache);

        (bool banned, _) = await service.AdminChangeStatusAsync(new AdminChangeStatusDto
        {
            AccountId = 19,
            Status = 1,
            Reason = "policy"
        });
        Assert.True(banned);
        Assert.Equal(UserSessionMode.Restricted, setupDb.Queryable<UserSession>().InSingle("status-mode-session").SessionMode);
        await cache.Received(1).PublishManyAsync(
            Arg.Is<IReadOnlyList<UserSessionValidationCacheState>>(states =>
                states.Count == 1 && states[0].SessionMode == UserSessionMode.Restricted),
            true,
            Arg.Any<CancellationToken>());

        (bool unbanned, _) = await service.AdminChangeStatusAsync(new AdminChangeStatusDto
        {
            AccountId = 19,
            Status = 0
        });
        Assert.True(unbanned);
        Assert.Equal(UserSessionMode.Normal, setupDb.Queryable<UserSession>().InSingle("status-mode-session").SessionMode);
        await cache.Received(1).PublishManyAsync(
            Arg.Is<IReadOnlyList<UserSessionValidationCacheState>>(states =>
                states.Count == 1 && states[0].SessionMode == UserSessionMode.Normal),
            true,
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task ModerateCommentsAsync_ConcurrentAccountDeletionDoesNotRestoreBannedStatus()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(setupDb);
        await SeedUserAsync(setupDb, 7);
        SeedArticle(setupDb, 42);
        SeedPublicPendingComment(setupDb, 100, 42, 7);
        using SqlSugarClient serviceDb = PostgresSqlSugarTestClient.Create(connectionString);
        var blacklist = new RecordingBanStateObligations();
        AuthoringModerationWorkflowService service = CreateService(serviceDb, blacklist);

        await using var holder = new NpgsqlConnection(connectionString);
        await holder.OpenAsync();
        await using NpgsqlTransaction deletion = await holder.BeginTransactionAsync();
        await using (var deleteCommand = new NpgsqlCommand(
            "UPDATE sys_user SET status = 2, deleted_at = now() WHERE id = 7;",
            holder,
            deletion))
        {
            Assert.Equal(1, await deleteCommand.ExecuteNonQueryAsync());
        }

        Task<CommentModerationBulkResponse> moderationTask = service.ModerateCommentsAsync(
            99,
            new CommentModerationBulkRequest(
                ["100"],
                CommentModerationStatus.Hidden,
                "policy",
                BanUsers: true),
            CancellationToken.None);
        await Task.Delay(TimeSpan.FromMilliseconds(300));
        Assert.False(moderationTask.IsCompleted);

        await deletion.CommitAsync();
        CommentModerationBulkResponse response = await moderationTask.WaitAsync(TimeSpan.FromSeconds(10));

        var user = setupDb.Queryable<User>().InSingle(7);
        Assert.Equal(1, response.Updated);
        Assert.Equal(0, response.BannedUsers);
        Assert.Empty(blacklist.BannedUsers);
        Assert.Equal(2, user.Status);
        Assert.NotNull(user.DeletedAt);
    }

    [Fact]
    public async Task AdminChangeStatusAsync_ConcurrentAccountDeletionDoesNotRestoreBannedStatus()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(setupDb);
        await SeedUserAsync(setupDb, 17);
        using SqlSugarClient serviceDb = PostgresSqlSugarTestClient.Create(connectionString);
        var blacklist = new RecordingBanStateObligations();
        UserAdminModerationService service = CreateAdminService(serviceDb, blacklist);

        await using var holder = new NpgsqlConnection(connectionString);
        await holder.OpenAsync();
        await using NpgsqlTransaction deletion = await holder.BeginTransactionAsync();
        await using (var deleteCommand = new NpgsqlCommand(
            "UPDATE sys_user SET status = 2, deleted_at = now() WHERE id = 17;",
            holder,
            deletion))
        {
            Assert.Equal(1, await deleteCommand.ExecuteNonQueryAsync());
        }

        Task<(bool Success, string Message)> statusTask = service.AdminChangeStatusAsync(new AdminChangeStatusDto
        {
            AccountId = 17,
            Status = 1,
            Reason = "policy"
        });
        await Task.Delay(TimeSpan.FromMilliseconds(300));
        Assert.False(statusTask.IsCompleted);

        await deletion.CommitAsync();
        (bool success, string message) = await statusTask.WaitAsync(TimeSpan.FromSeconds(10));

        var user = setupDb.Queryable<User>().InSingle(17);
        Assert.False(success);
        Assert.Equal("已注销账户不可变更状态", message);
        Assert.Empty(blacklist.BannedUsers);
        Assert.Equal(2, user.Status);
        Assert.NotNull(user.DeletedAt);
    }

    [Fact]
    public async Task AdminChangeStatusAsync_ConcurrentRowVersionMismatchReturnsConflictWithoutBlacklistWrite()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(setupDb);
        await SeedUserAsync(setupDb, 18);
        using SqlSugarClient serviceDb = PostgresSqlSugarTestClient.Create(connectionString);
        var blacklist = new RecordingBanStateObligations();
        UserAdminModerationService service = CreateAdminService(serviceDb, blacklist);

        await using var holder = new NpgsqlConnection(connectionString);
        await holder.OpenAsync();
        await using NpgsqlTransaction concurrentChange = await holder.BeginTransactionAsync();
        await using (var updateCommand = new NpgsqlCommand(
            "UPDATE sys_user SET riskflags = 8 WHERE id = 18;",
            holder,
            concurrentChange))
        {
            Assert.Equal(1, await updateCommand.ExecuteNonQueryAsync());
        }

        Task<(bool Success, string Message)> statusTask = service.AdminChangeStatusAsync(new AdminChangeStatusDto
        {
            AccountId = 18,
            Status = 1,
            Reason = "policy"
        });
        await Task.Delay(TimeSpan.FromMilliseconds(300));
        Assert.False(statusTask.IsCompleted);

        await concurrentChange.CommitAsync();
        (bool success, string message) = await statusTask.WaitAsync(TimeSpan.FromSeconds(10));

        var user = setupDb.Queryable<User>().InSingle(18);
        Assert.False(success);
        Assert.Equal("账户状态已变化，请刷新后重试", message);
        Assert.Empty(blacklist.BannedUsers);
        Assert.Equal(0, user.Status);
        Assert.Equal(8, user.RiskFlags);
    }

    [Theory]
    [InlineData(0, 1)]
    [InlineData(1, 0)]
    public async Task AdminChangeStatusAsync_MissingIssuedSubjectRollsBack(int initialStatus, int requestedStatus)
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(setupDb);
        await SeedUserAsync(setupDb, 19);
        Assert.Equal(1, setupDb.Ado.ExecuteCommand(
            "UPDATE sys_user SET account_subject_hash = NULL, status = @Status WHERE id = 19;",
            new SugarParameter("@Status", initialStatus)));
        long generation = setupDb.Queryable<User>().InSingle(19).BanStateGeneration;
        using SqlSugarClient serviceDb = PostgresSqlSugarTestClient.Create(connectionString);
        var obligations = Substitute.For<IBanStateProjectionObligationCoordinator>();
        var cache = Substitute.For<IUserSessionValidationCache>();
        UserAdminModerationService service = CreateAdminService(serviceDb, obligations, cache);

        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => service.AdminChangeStatusAsync(new AdminChangeStatusDto
            {
                AccountId = 19,
                Status = requestedStatus,
                Reason = "policy"
            }));

        Assert.Equal("account status projection identity is missing", error.Message);
        User user = setupDb.Queryable<User>().InSingle(19);
        Assert.Equal(initialStatus, user.Status);
        Assert.Equal(generation, user.BanStateGeneration);
        Assert.Null(user.AccountSubjectHash);
        Assert.Empty(obligations.ReceivedCalls());
        Assert.Empty(cache.ReceivedCalls());
    }

    private static void CreateTables(SqlSugarClient db)
        => PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(User),
            typeof(UserSession),
            typeof(Article),
            typeof(Comment),
            typeof(CommentRegionCompliance),
            typeof(CommentModerationEvent));

    private static Task SeedUserAsync(SqlSugarClient db, int userId)
        => AuthoringUserBanAccountFixture.SeedAsync(db, userId);

    private static void SeedArticle(SqlSugarClient db, int articleId)
        => db.Ado.ExecuteCommand(
            """
            INSERT INTO article
                (id, title, categoryid, views, createtime, metadata_updated_at, isdeleted, status, published_at, scheduled_publish_at)
            VALUES
                (@Id, @Title, 1, 0, @PublishedAt, @PublishedAt, false, @Status, @PublishedAt, NULL);
            """,
            new SugarParameter("@Id", articleId),
            new SugarParameter("@Title", $"Article {articleId}"),
            new SugarParameter("@Status", (int)ArticleStatus.Published),
            new SugarParameter("@PublishedAt", DateTime.UtcNow.AddMinutes(-1)));

    private static void SeedPublicPendingComment(SqlSugarClient db, long commentId, int articleId, int userId)
        => db.Insertable(new Comment
        {
            Id = commentId,
            ArticleId = articleId,
            Content = "pending public comment",
            UserId = userId,
            AuthorMode = CommentAuthorModes.Public,
            PublicHandle = "public-user",
            CreateTime = DateTime.UtcNow.AddMinutes(-1),
            IsDeleted = false,
            ModerationStatus = CommentModerationStatus.Pending,
            Depth = 0
        }).ExecuteCommand();

    private static AuthoringModerationWorkflowService CreateService(
        SqlSugarClient db,
        IBanStateProjectionObligationCoordinator blacklist)
    {
        var contentFilter = Substitute.For<IContentFilterService>();
        contentFilter.ValidateContent(Arg.Any<string>())
            .Returns(new ContentValidationResult(true, string.Empty, string.Empty));
        return new AuthoringModerationWorkflowService(
            db,
            contentFilter,
            blacklist,
            Substitute.For<ICacheInvalidationDispatcher>(),
            Substitute.For<IMessageRealtimePublisher>(),
            Substitute.For<IMessageCommandService>(),
            new AuthoringAuditWriter(new AuditLogChannel()),
            Substitute.For<ILogger<AuthoringModerationWorkflowService>>());
    }

    private static UserService CreateUserService(SqlSugarClient db, IBlacklistService blacklist)
    {
        var messages = Substitute.For<IMessageCommandService>();
        messages.SendAccountBannedNoticeAsync(Arg.Any<int>(), Arg.Any<string>())
            .Returns(Task.CompletedTask);
        messages.SendAccountUnbannedNoticeAsync(Arg.Any<int>())
            .Returns(Task.CompletedTask);
        var realtime = Substitute.For<IMessageRealtimePublisher>();
        realtime.PushAccountStatusAsync(Arg.Any<long>(), Arg.Any<int>(), Arg.Any<string?>())
            .Returns(Task.CompletedTask);

        return new UserService(
            _db: db,
            _logger: NullLogger<UserService>.Instance,
            _accountStates: Substitute.For<IAccountStateProjectionMutationPublisher>(),
            _totpService: Substitute.For<ITotpService>());
    }

    private static UserAdminModerationService CreateAdminService(
        SqlSugarClient db,
        IBanStateProjectionObligationCoordinator blacklist,
        IUserSessionValidationCache? sessionValidation = null)
    {
        var messages = Substitute.For<IMessageCommandService>();
        messages.SendAccountBannedNoticeAsync(Arg.Any<int>(), Arg.Any<string>()).Returns(Task.CompletedTask);
        messages.SendAccountUnbannedNoticeAsync(Arg.Any<int>()).Returns(Task.CompletedTask);
        return new UserAdminModerationService(
            db,
            NullLogger<UserAdminModerationService>.Instance,
            blacklist,
            messages,
            Substitute.For<IAccountStateProjectionMutationPublisher>(),
            sessionValidation);
    }

    private sealed class RecordingBanStateObligations : IBanStateProjectionObligationCoordinator
    {
        public List<int> BannedUsers { get; } = [];

        public Task<DistributedInvalidationEvent?> PrepareAsync(
            IReadOnlyCollection<BanStateProjectionUpdate> updates,
            CancellationToken cancellationToken = default)
            => Task.FromResult<DistributedInvalidationEvent?>(null);

        public Task<DistributedInvalidationPublishResult?> ApplyLocalAndPublishPreparedAsync(
            DistributedInvalidationEvent? invalidation,
            IReadOnlyCollection<BanStateProjectionUpdate> updates,
            CancellationToken cancellationToken = default)
        {
            foreach (BanStateProjectionUpdate update in updates)
            {
                if (update.Status == BanStateProjectionStatus.Banned)
                {
                    BannedUsers.Add(1);
                }
            }
            return Task.FromResult<DistributedInvalidationPublishResult?>(null);
        }
    }
}
