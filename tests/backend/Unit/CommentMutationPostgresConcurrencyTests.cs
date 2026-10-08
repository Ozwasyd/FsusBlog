using System.Collections.Concurrent;

using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.Moderation;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

using Npgsql;

using NSubstitute;

using SqlSugar;
namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Concurrency")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class CommentMutationPostgresConcurrencyTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task CreatePublicCommentAsync_ConcurrentSameMutationCreatesExactlyOnceAndReplaysResult()
    {
        string connectionString = await CreateDatabaseAsync();
        using (SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString))
        {
            SeedUser(setupDb, 7);
            SeedArticle(setupDb, 42);
        }
        var invalidations = new RecordingCacheInvalidationDispatcher();
        IMessageRealtimePublisher realtime = Substitute.For<IMessageRealtimePublisher>();
        var logger = new RecordingLogger<CommentCommandService>();
        using var barrier = new Barrier(2);
        const string MutationId = "018ff010-1234-7abc-8def-0123456789ab";
        CommentCreateRequestCoreModel request = CreatePublicRequest("same comment");

        CommentCreateResult[] results = await Task.WhenAll(
            StartBarrierTaskAsync(barrier, async () =>
            {
                using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
                return await CreateCommentService(db, invalidations, realtime, CreatePublicAttribution(), logger)
                    .CreateAttributablePublicCommentResultAsync(new AccountPrincipalContext(7, "session-a"), request, MutationId);
            }),
            StartBarrierTaskAsync(barrier, async () =>
            {
                using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
                return await CreateCommentService(db, invalidations, realtime, CreatePublicAttribution(), logger)
                    .CreateAttributablePublicCommentResultAsync(new AccountPrincipalContext(7, "session-b"), request, MutationId);
            })).WaitAsync(TimeSpan.FromSeconds(20));

        using SqlSugarClient assertDb = PostgresSqlSugarTestClient.Create(connectionString);
        Assert.True(results.All(static result => result.Created), logger.Details);
        Assert.Equal(1, assertDb.Queryable<Comment>().Count());
        Assert.All(results, static result => Assert.True(result.Created));
        Assert.Equal(results[0].CommentId, results[1].CommentId);
        Assert.Equal(results[0].RootId, results[1].RootId);
        Assert.Equal(1, results.Count(static result => result.IdempotencyReplay));
        Assert.Equal(1, results.Count(static result => !result.IdempotencyReplay));
        Assert.Single(invalidations.Scopes);
    }

    [Fact]
    public async Task CreatePublicCommentAsync_SameMutationDifferentContentReturnsConflictWithoutSecondWrite()
    {
        string connectionString = await CreateDatabaseAsync();
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        SeedUser(db, 7);
        SeedArticle(db, 42);
        var invalidations = new RecordingCacheInvalidationDispatcher();
        IMessageRealtimePublisher realtime = Substitute.For<IMessageRealtimePublisher>();
        var logger = new RecordingLogger<CommentCommandService>();
        CommentCommandService service = CreateCommentService(db, invalidations, realtime, CreatePublicAttribution(), logger);
        const string MutationId = "018ff011-1234-7abc-8def-0123456789ab";

        CommentCreateResult created = await service.CreateAttributablePublicCommentResultAsync(
            new AccountPrincipalContext(7, "session-a"),
            CreatePublicRequest("first content"),
            MutationId);
        CommentCreateResult conflict = await service.CreateAttributablePublicCommentResultAsync(
            new AccountPrincipalContext(7, "session-a"),
            CreatePublicRequest("changed content"),
            MutationId);

        Assert.True(created.Created, logger.Details);
        Assert.False(conflict.Created);
        Assert.Equal("comment_mutation_content_conflict", conflict.FailureCode);
        Assert.Equal(1, db.Queryable<Comment>().Count());
        Assert.Single(invalidations.Scopes);
    }

    [Fact]
    public async Task CreateAnonymousCommentAsync_SameTicketReplaysAndChangedContentConflicts()
    {
        string connectionString = await CreateDatabaseAsync();
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        SeedArticle(db, 42);
        var invalidations = new RecordingCacheInvalidationDispatcher();
        IMessageRealtimePublisher realtime = Substitute.For<IMessageRealtimePublisher>();
        ICommentAttributionPrivacyService attribution = CreateAnonymousAttribution();
        var logger = new RecordingLogger<CommentCommandService>();
        CommentCommandService service = CreateCommentService(db, invalidations, realtime, attribution, logger);
        byte[] ticket = Enumerable.Range(1, 32).Select(static value => (byte)value).ToArray();
        AnonymousCommentCreateRequestCoreModel request = CreateAnonymousRequest(ticket, "anonymous content");

        CommentCreateResult created = await service.CreateStrongAnonymousCommentResultAsync(request);
        CommentCreateResult replay = await service.CreateStrongAnonymousCommentResultAsync(request);
        CommentCreateResult conflict = await service.CreateStrongAnonymousCommentResultAsync(
            CreateAnonymousRequest(ticket, "changed anonymous content"));

        Assert.True(created.Created, logger.Details);
        Assert.True(replay.Created);
        Assert.False(created.IdempotencyReplay);
        Assert.True(replay.IdempotencyReplay);
        Assert.Equal(created.CommentId, replay.CommentId);
        Assert.False(conflict.Created);
        Assert.Equal("comment_mutation_content_conflict", conflict.FailureCode);
        Assert.Equal(1, db.Queryable<Comment>().Count());
        Assert.Single(invalidations.Scopes);
        await attribution.Received(1).ReadStrongAnonymousTicketAsync(
            Arg.Any<AnonymousCommentCreateRequestCoreModel>(),
            Arg.Any<string>(),
            Arg.Any<CancellationToken>());
        await attribution.Received(1).FinalizeStrongAnonymousTicketAsync(
            Arg.Any<AnonymousCommentCreateRequestCoreModel>(),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task DeleteCommentAsync_ConcurrentWritersProduceOneDeleteAndOneInvalidation()
    {
        string connectionString = await CreateDatabaseAsync();
        using (SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString))
        {
            SeedUser(setupDb, 7);
            SeedArticle(setupDb, 42);
            SeedComment(setupDb, 100, articleId: 42, userId: 7, parentId: null, rootId: null, CommentModerationStatus.Approved);
            SeedComment(setupDb, 101, articleId: 42, userId: 7, parentId: 100, rootId: 100, CommentModerationStatus.Approved);
        }
        var invalidations = new RecordingCacheInvalidationDispatcher();
        IMessageRealtimePublisher realtime = Substitute.For<IMessageRealtimePublisher>();
        using var barrier = new Barrier(2);

        bool[] results = await Task.WhenAll(
            StartBarrierTaskAsync(barrier, async () =>
            {
                using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
                return await CreateCommentService(db, invalidations, realtime)
                    .DeleteCommentAsync(101, currentUserId: 7, isAdmin: false, reason: "first-racer");
            }),
            StartBarrierTaskAsync(barrier, async () =>
            {
                using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
                return await CreateCommentService(db, invalidations, realtime)
                    .DeleteCommentAsync(101, currentUserId: 7, isAdmin: false, reason: "second-racer");
            })).WaitAsync(TimeSpan.FromSeconds(20));

        using SqlSugarClient assertDb = PostgresSqlSugarTestClient.Create(connectionString);
        Comment comment = assertDb.Queryable<Comment>().InSingle(101);
        CommentCacheInvalidationScope scope = Assert.Single(invalidations.Scopes);
        Assert.Equal(1, results.Count(static result => result));
        Assert.Equal(1, results.Count(static result => !result));
        Assert.True(comment.IsDeleted);
        Assert.Equal(CommentModerationStatus.Hidden, comment.ModerationStatus);
        Assert.Contains(comment.DeleteReason, new[] { "first-racer", "second-racer" });
        Assert.Equal(42, scope.ArticleId);
        Assert.Equal(100, scope.RootId);
        Assert.Equal(7, scope.AccountId);
        Assert.True(scope.PublicArticleChanged);
        Assert.True(scope.UserCommentsChanged);
        await realtime.Received(1).PushCommentRemoveAsync(42, 101, 100, 100);
    }

    [Fact]
    public async Task DeleteCommentAsync_DatabaseFailureRollsBackAndSkipsInvalidation()
    {
        string connectionString = await CreateDatabaseAsync();
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        SeedUser(db, 7);
        SeedArticle(db, 42);
        SeedComment(db, 101, articleId: 42, userId: 7, parentId: null, rootId: null, CommentModerationStatus.Approved);
        db.Ado.ExecuteCommand(
            """
            CREATE OR REPLACE FUNCTION reject_comment_update_for_test()
            RETURNS trigger AS $$
            BEGIN
                RAISE EXCEPTION 'synthetic comment update failure';
            END;
            $$ LANGUAGE plpgsql;
            CREATE TRIGGER reject_comment_update_for_test
            BEFORE UPDATE ON comment
            FOR EACH ROW EXECUTE FUNCTION reject_comment_update_for_test();
            """);
        var invalidations = new RecordingCacheInvalidationDispatcher();
        IMessageRealtimePublisher realtime = Substitute.For<IMessageRealtimePublisher>();
        CommentCommandService service = CreateCommentService(db, invalidations, realtime);

        bool deleted = await service.DeleteCommentAsync(101, currentUserId: 7, isAdmin: false, reason: "must-rollback");

        Comment comment = db.Queryable<Comment>().InSingle(101);
        Assert.False(deleted);
        Assert.False(comment.IsDeleted);
        Assert.Null(comment.DeleteReason);
        Assert.Equal(CommentModerationStatus.Approved, comment.ModerationStatus);
        Assert.Empty(invalidations.Scopes);
        await realtime.DidNotReceiveWithAnyArgs().PushCommentRemoveAsync(default, default, default, default);
    }

    [Fact]
    public async Task DeleteCommentAsync_DeletedArticleTargetIsInvisibleAndProducesNoSideEffects()
    {
        string connectionString = await CreateDatabaseAsync();
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        SeedUser(db, 7);
        SeedArticle(db, 42, isDeleted: true);
        SeedComment(db, 101, articleId: 42, userId: 7, parentId: null, rootId: null, CommentModerationStatus.Approved);
        var invalidations = new RecordingCacheInvalidationDispatcher();
        IMessageRealtimePublisher realtime = Substitute.For<IMessageRealtimePublisher>();

        bool deleted = await CreateCommentService(db, invalidations, realtime)
            .DeleteCommentAsync(101, currentUserId: 7, isAdmin: false);

        Assert.False(deleted);
        Assert.False(db.Queryable<Comment>().InSingle(101).IsDeleted);
        Assert.Empty(invalidations.Scopes);
        await realtime.DidNotReceiveWithAnyArgs().PushCommentRemoveAsync(default, default, default, default);
    }

    [Fact]
    public async Task ModerateCommentAsync_ConcurrentCasAllowsOneWriteAndOneInvalidation()
    {
        string connectionString = await CreateDatabaseAsync();
        using (SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString))
        {
            SeedUser(setupDb, 7);
            SeedArticle(setupDb, 42);
            SeedComment(setupDb, 200, articleId: 42, userId: 7, parentId: null, rootId: null, CommentModerationStatus.Pending);
        }
        var invalidations = new RecordingCacheInvalidationDispatcher();
        IMessageRealtimePublisher realtime = Substitute.For<IMessageRealtimePublisher>();
        await using var holder = new NpgsqlConnection(connectionString);
        await holder.OpenAsync();
        await using NpgsqlTransaction heldUpdate = await holder.BeginTransactionAsync();
        await using (var command = new NpgsqlCommand(
            "SELECT id FROM comment WHERE id = 200 FOR UPDATE;",
            holder,
            heldUpdate))
        {
            Assert.Equal(200L, (long)(await command.ExecuteScalarAsync())!);
        }
        using var barrier = new Barrier(2);
        var request = new CommentModerationRequest(CommentModerationStatus.Hidden, "concurrent-policy");

        Task<bool>[] tasks =
        [
            StartBarrierTaskAsync(barrier, async () =>
            {
                using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
                return await CreateAuthoringService(db, invalidations, realtime)
                    .ModerateCommentAsync(99, 200, request);
            }),
            StartBarrierTaskAsync(barrier, async () =>
            {
                using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
                return await CreateAuthoringService(db, invalidations, realtime)
                    .ModerateCommentAsync(99, 200, request);
            })
        ];
        await Task.Delay(TimeSpan.FromMilliseconds(250));
        Assert.All(tasks, task => Assert.False(task.IsCompleted));
        await heldUpdate.CommitAsync();

        bool[] results = await Task.WhenAll(tasks).WaitAsync(TimeSpan.FromSeconds(10));
        using SqlSugarClient assertDb = PostgresSqlSugarTestClient.Create(connectionString);
        Comment comment = assertDb.Queryable<Comment>().InSingle(200);
        CommentCacheInvalidationScope scope = Assert.Single(invalidations.Scopes);
        Assert.Equal(1, results.Count(static result => result));
        Assert.Equal(1, results.Count(static result => !result));
        Assert.Equal(CommentModerationStatus.Hidden, comment.ModerationStatus);
        Assert.Equal("concurrent-policy", comment.ModerationReason);
        Assert.Equal(99L, comment.ModeratedByAdminPrincipalId);
        Assert.Equal(42, scope.ArticleId);
        Assert.Equal(200L, scope.RootId);
        Assert.False(scope.PublicArticleChanged);
        Assert.True(scope.UserCommentsChanged);
    }

    [Fact]
    public async Task ModerateCommentAsync_TransitionMatrixPersistsOnlyAllowedPairs()
    {
        string connectionString = await CreateDatabaseAsync();
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        SeedUser(db, 7);
        SeedArticle(db, 42);
        var invalidations = new RecordingCacheInvalidationDispatcher();
        IMessageRealtimePublisher realtime = Substitute.For<IMessageRealtimePublisher>();
        AuthoringModerationWorkflowService service = CreateAuthoringService(db, invalidations, realtime);
        CommentModerationStatus[] states = Enum.GetValues<CommentModerationStatus>();
        int index = 0;
        int allowedCount = 0;

        foreach (CommentModerationStatus from in states)
        {
            foreach (CommentModerationStatus to in states)
            {
                long commentId = 300 + index++;
                SeedComment(db, commentId, articleId: 42, userId: 7, parentId: null, rootId: null, from);
                bool expected = CommentModerationTransitions.IsAllowed(from, to);

                bool updated = await service.ModerateCommentAsync(
                    actorAdminPrincipalId: 99,
                    commentId,
                    new CommentModerationRequest(to, $"matrix:{from}->{to}"));

                Comment persisted = db.Queryable<Comment>().InSingle(commentId);
                Assert.Equal(expected, updated);
                Assert.Equal(expected ? to : from, persisted.ModerationStatus);
                if (expected)
                {
                    allowedCount++;
                    Assert.Equal(99L, persisted.ModeratedByAdminPrincipalId);
                }
                else
                {
                    Assert.Null(persisted.ModeratedByAdminPrincipalId);
                }
            }
        }

        Assert.Equal(allowedCount, invalidations.Scopes.Count);
    }

    private async Task<string> CreateDatabaseAsync()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(User),
            typeof(Article),
            typeof(ArticlePublicationRecord),
            typeof(Comment),
            typeof(CommentRevision),
            typeof(CommentBlockedRegion),
            typeof(CommentRegionCompliance),
            typeof(CommentModerationEvent));
        return connectionString;
    }

    private static CommentCommandService CreateCommentService(
        SqlSugarClient db,
        ICacheInvalidationDispatcher invalidations,
        IMessageRealtimePublisher realtime,
        ICommentAttributionPrivacyService? attribution = null,
        ILogger<CommentCommandService>? logger = null)
    {
        var notifications = new CommentNotificationService(
            realtime,
            Substitute.For<IMessageCommandService>(),
            NullLogger<CommentNotificationService>.Instance);
        var moderation = new CommentModerationService(
            db,
            new RegionLegalModerationService(),
            invalidations,
            notifications,
            NullLogger<CommentModerationService>.Instance);
        return new CommentCommandService(
            db,
            logger ?? NullLogger<CommentCommandService>.Instance,
            notifications,
            moderation,
            attribution ?? new CommentAttributionPrivacyService(
                NullLogger<CommentAttributionPrivacyService>.Instance),
            invalidations);
    }

    private static ICommentAttributionPrivacyService CreatePublicAttribution()
    {
        ICommentAttributionPrivacyService attribution = Substitute.For<ICommentAttributionPrivacyService>();
        attribution.ResolvePublicActorAsync(
                Arg.Any<int>(),
                Arg.Any<CommentDto>(),
                Arg.Any<string>(),
                Arg.Any<string?>(),
                Arg.Any<CancellationToken>())
            .Returns(call => new CommentActor(
                call.ArgAt<int>(0),
                CommentAuthorModes.Public,
                "user-7",
                null,
                "user-7",
                "zh-CN",
                null,
                null,
                "public-subject",
                "common",
                false));
        return attribution;
    }

    private static ICommentAttributionPrivacyService CreateAnonymousAttribution()
    {
        ICommentAttributionPrivacyService attribution = Substitute.For<ICommentAttributionPrivacyService>();
        attribution.ReadStrongAnonymousTicketAsync(
                Arg.Any<AnonymousCommentCreateRequestCoreModel>(),
                Arg.Any<string>(),
                Arg.Any<CancellationToken>())
            .Returns(new AnonymousCommentTicketPayload(
                42,
                "comment:v1:article:42:top",
                null,
                null,
                null,
                "anonymous-nullifier",
                "common",
                false,
                DateTimeOffset.UtcNow.AddMinutes(2).ToUnixTimeMilliseconds()));
        attribution.ResolveStrongAnonymousActorAsync(
                Arg.Any<AnonymousCommentTicketPayload>(),
                Arg.Any<AnonymousCommentCreateRequestCoreModel>(),
                Arg.Any<string?>(),
                Arg.Any<CancellationToken>())
            .Returns(new CommentActor(
                null,
                CommentAuthorModes.ZkAnonymous,
                null,
                "anon-test",
                "匿名读者",
                "zh-CN",
                null,
                null,
                "anonymous-subject",
                "common",
                false));
        return attribution;
    }

    private static CommentCreateRequestCoreModel CreatePublicRequest(string content)
        => new(
            42,
            content,
            null,
            null,
            null,
            CommentAuthorModes.Public,
            true,
            null,
            "zh-CN",
            null,
            []);

    private static AnonymousCommentCreateRequestCoreModel CreateAnonymousRequest(byte[] ticket, string content)
        => new(
            42,
            content,
            null,
            null,
            null,
            "comment:v1:article:42:top",
            "zh-CN",
            ticket);

    private static AuthoringModerationWorkflowService CreateAuthoringService(
        SqlSugarClient db,
        ICacheInvalidationDispatcher invalidations,
        IMessageRealtimePublisher realtime)
    {
        var contentFilter = Substitute.For<IContentFilterService>();
        contentFilter.ValidateContent(Arg.Any<string>())
            .Returns(new ContentValidationResult(true, string.Empty, string.Empty));
        return new AuthoringModerationWorkflowService(
            db,
            contentFilter,
            Substitute.For<IBanStateProjectionObligationCoordinator>(),
            invalidations,
            realtime,
            Substitute.For<IMessageCommandService>(),
            new AuthoringAuditWriter(new AuditLogChannel()),
            Substitute.For<ILogger<AuthoringModerationWorkflowService>>());
    }

    private static void SeedUser(SqlSugarClient db, int userId)
        => db.Ado.ExecuteCommand(
            """
            INSERT INTO sys_user
                (id, public_handle, status, identity_kind, passkey_enabled, recovery_enabled, privacy_initialized_at)
            VALUES
                (@Id, @PublicHandle, 0, 'anonymous_account', false, false, @PrivacyInitializedAt);
            """,
            new SugarParameter("@Id", userId),
            new SugarParameter("@PublicHandle", $"user-{userId}"),
            new SugarParameter("@PrivacyInitializedAt", DateTime.UtcNow));

    private static void SeedArticle(SqlSugarClient db, int articleId, bool isDeleted = false)
    {
        db.Ado.ExecuteCommand(
            """
            INSERT INTO article
                (id, title, categoryid, views, createtime, metadata_updated_at, isdeleted, status, published_at, scheduled_publish_at)
            VALUES
                (@Id, @Title, 1, 0, @PublishedAt, @PublishedAt, @IsDeleted, @Status, @PublishedAt, NULL);
            """,
            new SugarParameter("@Id", articleId),
            new SugarParameter("@Title", $"Article {articleId}"),
            new SugarParameter("@IsDeleted", isDeleted),
            new SugarParameter("@Status", (int)(isDeleted ? ArticleStatus.Deleted : ArticleStatus.Published)),
            new SugarParameter("@PublishedAt", DateTime.UtcNow.AddMinutes(-1)));
        if (isDeleted)
        {
            return;
        }

        long publicationId = db.Insertable(new ArticlePublicationRecord
        {
            ArticleId = articleId,
            PublicationNo = 1,
            ArticleRevisionId = 1,
            RevisionNo = 1,
            RightsSnapshotId = 1,
            TransitionKind = "publish",
            PublishedAt = DateTime.UtcNow.AddMinutes(-1),
            CreatedAt = DateTime.UtcNow.AddMinutes(-1)
        }).ExecuteReturnBigIdentity();
        db.Ado.ExecuteCommand(
            "UPDATE article SET current_publication_id = @PublicationId WHERE id = @ArticleId;",
            new SugarParameter("@PublicationId", publicationId),
            new SugarParameter("@ArticleId", articleId));
    }

    private static void SeedComment(
        SqlSugarClient db,
        long commentId,
        int articleId,
        int userId,
        long? parentId,
        long? rootId,
        CommentModerationStatus status)
        => db.Insertable(new Comment
        {
            Id = commentId,
            ArticleId = articleId,
            Content = $"comment {commentId}",
            UserId = userId,
            AuthorMode = CommentAuthorModes.Public,
            PublicHandle = $"user-{userId}",
            CreateTime = DateTime.UtcNow.AddMinutes(-1),
            ParentId = parentId,
            RootId = rootId,
            Depth = parentId.HasValue ? 1 : 0,
            IsDeleted = false,
            ModerationStatus = status
        }).ExecuteCommand();

    private static Task<T> StartBarrierTaskAsync<T>(Barrier barrier, Func<Task<T>> action)
        => Task.Factory.StartNew(
            async () =>
            {
                Assert.True(
                    barrier.SignalAndWait(TimeSpan.FromSeconds(20)),
                    "Timed out waiting for concurrent comment mutations.");
                return await action();
            },
            CancellationToken.None,
            TaskCreationOptions.LongRunning,
            TaskScheduler.Default).Unwrap();

    private sealed class RecordingCacheInvalidationDispatcher : ICacheInvalidationDispatcher
    {
        public ConcurrentQueue<CommentCacheInvalidationScope> Scopes { get; } = new();

        public Task InvalidateArticleMutationAsync(int? articleId = null, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateSeoAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateComplianceAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateSystemPageAsync(string slug, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateCategoryTagAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateCommentPolicyAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;

        public Task InvalidateCommentMutationAsync(CommentCacheInvalidationScope? scope = null, CancellationToken cancellationToken = default)
        {
            if (scope is not null)
            {
                Scopes.Enqueue(scope);
            }
            return Task.CompletedTask;
        }

        public Task InvalidateStatsAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateArticleViewAsync(int articleId, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateHotArticlesAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
    }

    private sealed class RecordingLogger<T> : ILogger<T>
    {
        private readonly ConcurrentQueue<string> _entries = new();

        public string Details => string.Join(Environment.NewLine, _entries);

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
            => _entries.Enqueue($"{logLevel}: {formatter(state, exception)}{Environment.NewLine}{exception}");
    }
}
