using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Npgsql;
using NSubstitute;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollection))]
public sealed class AuthoringUserBanConcurrencyTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task ModerateCommentsAsync_ConcurrentAccountDeletionDoesNotRestoreBannedStatus()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(setupDb);
        SeedUser(setupDb, 7);
        SeedArticle(setupDb, 42);
        SeedPublicPendingComment(setupDb, 100, 42, 7);
        using SqlSugarClient serviceDb = PostgresSqlSugarTestClient.Create(connectionString);
        var blacklist = new RecordingBlacklistService();
        AuthoringWorkflowService service = CreateService(serviceDb, blacklist);

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

    private static void CreateTables(SqlSugarClient db)
        => PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(User),
            typeof(Article),
            typeof(Comment),
            typeof(CommentRegionCompliance));

    private static void SeedUser(SqlSugarClient db, int userId)
        => db.Ado.ExecuteCommand(
            """
            INSERT INTO sys_user
                (id, public_handle, status, identity_kind, passkey_enabled, recovery_enabled, privacy_initialized_at)
            VALUES
                (@Id, @PublicHandle, 0, @IdentityKind, false, false, @PrivacyInitializedAt);
            """,
            new SugarParameter("@Id", userId),
            new SugarParameter("@PublicHandle", $"user-{userId}"),
            new SugarParameter("@IdentityKind", AnonymousIdentityRuntime.AnonymousAccountKind),
            new SugarParameter("@PrivacyInitializedAt", DateTime.UtcNow));

    private static void SeedArticle(SqlSugarClient db, int articleId)
        => db.Ado.ExecuteCommand(
            """
            INSERT INTO article
                (id, title, categoryid, views, createtime, isdeleted, status, published_at, scheduled_publish_at)
            VALUES
                (@Id, @Title, 1, 0, @PublishedAt, false, @Status, @PublishedAt, NULL);
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

    private static AuthoringWorkflowService CreateService(SqlSugarClient db, IBlacklistService blacklist)
    {
        var contentFilter = Substitute.For<IContentFilterService>();
        contentFilter.ValidateContent(Arg.Any<string>())
            .Returns(new ContentValidationResult(true, string.Empty, string.Empty));
        return new AuthoringWorkflowService(
            db,
            Substitute.For<IArticleService>(),
            contentFilter,
            blacklist,
            Substitute.For<ICacheInvalidationDispatcher>(),
            Substitute.For<IMessageRealtimePublisher>(),
            Substitute.For<IMessageCommandService>(),
            new AuditLogChannel(),
            new ConfigurationBuilder().Build(),
            Substitute.For<ILogger<AuthoringWorkflowService>>());
    }

    private sealed class RecordingBlacklistService : IBlacklistService
    {
        public List<int> BannedUsers { get; } = [];

        public Task BanUserAsync(int userId, string? reason)
        {
            BannedUsers.Add(userId);
            return Task.CompletedTask;
        }

        public Task UnbanUserAsync(int userId) => Task.CompletedTask;

        public Task<BanStateSnapshot> GetBanStateAsync(int accountId, string accountSubjectHash)
            => Task.FromResult(new BanStateSnapshot(false, null, null));
    }
}
