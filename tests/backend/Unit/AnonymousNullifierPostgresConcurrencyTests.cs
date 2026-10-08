using System.Collections.Concurrent;

using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Moderation;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;
namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Concurrency")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class AnonymousNullifierPostgresConcurrencyTests(PostgresSchemaMigrationFixture fixture)
{
    private const string NullifierHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string ModerationPepper = "unit-test-moderation-pepper-with-at-least-thirty-two-chars";

    [Fact]
    public async Task TryConsumeAsync_SameScopeRaceStopsAtPolicyLimitWithStableState()
    {
        const int Attempts = 12;
        const int Limit = 3;
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using (SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString))
        {
            PostgresSqlSugarTestClient.InitTables(setupDb, typeof(CommentAnonymousNullifier));
        }
        using var barrier = new Barrier(Attempts);

        NullifierReservationResult[] results = await Task.WhenAll(Enumerable.Range(0, Attempts)
            .Select(index => StartBarrierTaskAsync(barrier, async () =>
            {
                using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
                var service = new CommentAnonymousNullifierService(db, BuildConfiguration(Limit));
                return await service.TryConsumeAsync(
                    NullifierHash,
                    "article:42",
                    commentId: 10_000 + index,
                    CancellationToken.None);
            }))).WaitAsync(TimeSpan.FromSeconds(30));

        using SqlSugarClient assertDb = PostgresSqlSugarTestClient.Create(connectionString);
        CommentAnonymousNullifier row = Assert.Single(assertDb.Queryable<CommentAnonymousNullifier>().ToList());
        NullifierReservationResult[] rejected = [.. results.Where(static result => !result.Allowed)];
        long[] allowedCommentIds = [.. results
            .Select((result, index) => (result, commentId: 10_000L + index))
            .Where(static item => item.result.Allowed)
            .Select(static item => item.commentId)];

        Assert.Equal(Limit, results.Count(static result => result.Allowed));
        Assert.Equal(Attempts - Limit, rejected.Length);
        Assert.All(rejected, result =>
        {
            Assert.Equal("scope_limit_exceeded", result.Status);
            Assert.Equal(Limit, result.CurrentUseCount);
        });
        Assert.Equal(Limit, row.UseCount);
        Assert.Contains(row.FirstCommentId!.Value, allowedCommentIds);
        Assert.Contains(row.LastCommentId!.Value, allowedCommentIds);
        Assert.False(row.Blocked);
    }

    [Fact]
    public async Task TryConsumeAsync_SameNullifierDifferentScopesAndWhitespaceNormalization_EnforcesIndependentLimitsAndNormalizedIdentity()
    {
        const int AttemptsPerScope = 4;
        const int TotalAttempts = AttemptsPerScope * 2;
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using (SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString))
        {
            PostgresSqlSugarTestClient.InitTables(setupDb, typeof(CommentAnonymousNullifier));
        }
        using var barrier = new Barrier(TotalAttempts);

        (string scope, NullifierReservationResult result)[] results = await Task.WhenAll(
            Enumerable.Range(0, TotalAttempts).Select(index => StartBarrierTaskAsync(barrier, async () =>
            {
                using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
                var service = new CommentAnonymousNullifierService(db, BuildConfiguration(limit: 1));
                string normalizedScope = index % 2 == 0
                    ? "comment:v1:article:42:top"
                    : "comment:v1:article:43:top";
                bool useWhitespaceVariant = index >= AttemptsPerScope;
                string scope = useWhitespaceVariant ? $"  {normalizedScope}  " : normalizedScope;
                string nullifierHash = useWhitespaceVariant ? $"  {NullifierHash}  " : NullifierHash;
                NullifierReservationResult result = await service.TryConsumeAsync(
                    nullifierHash,
                    scope,
                    commentId: 20_000 + index,
                    CancellationToken.None);
                return (scope: normalizedScope, result);
            }))).WaitAsync(TimeSpan.FromSeconds(30));

        using SqlSugarClient assertDb = PostgresSqlSugarTestClient.Create(connectionString);
        List<CommentAnonymousNullifier> rows = assertDb.Queryable<CommentAnonymousNullifier>()
            .OrderBy(static row => row.Scope)
            .ToList();

        Assert.Equal(2, rows.Count);

        var scope42Results = results.Where(item => item.scope == "comment:v1:article:42:top").ToArray();
        var scope43Results = results.Where(item => item.scope == "comment:v1:article:43:top").ToArray();

        Assert.Equal(1, scope42Results.Count(item => item.result.Allowed));
        Assert.Equal(AttemptsPerScope - 1, scope42Results.Count(item => !item.result.Allowed));
        Assert.Equal(1, scope43Results.Count(item => item.result.Allowed));
        Assert.Equal(AttemptsPerScope - 1, scope43Results.Count(item => !item.result.Allowed));

        CommentAnonymousNullifier row42 = Assert.Single(rows, static row => row.Scope == "comment:v1:article:42:top");
        CommentAnonymousNullifier row43 = Assert.Single(rows, static row => row.Scope == "comment:v1:article:43:top");

        Assert.Equal(1, row42.UseCount);
        Assert.Equal(NullifierHash, row42.NullifierHash);
        Assert.False(row42.Blocked);

        Assert.Equal(1, row43.UseCount);
        Assert.Equal(NullifierHash, row43.NullifierHash);
        Assert.False(row43.Blocked);
    }

    [Fact]
    public async Task CreateStrongAnonymousCommentAsync_SameNullifierRaceCommitsOnlyAllowedComments()
    {
        const int Attempts = 8;
        const int Limit = AnonymousCommentScopePolicy.TopLevelUsesPerCredential;
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using (SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString))
        {
            CreateCommentTables(setupDb);
            SeedArticle(setupDb, 42);
        }
        var invalidations = new RecordingCacheInvalidationDispatcher();
        using var barrier = new Barrier(Attempts);

        bool[] results = await Task.WhenAll(Enumerable.Range(0, Attempts)
            .Select(index => StartBarrierTaskAsync(barrier, async () =>
            {
                using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
                byte[] ticket = CreateTicket(index);
                var ticketService = new FixedTicketService(CreateTicketPayload());
                var nullifierService = new CommentAnonymousNullifierService(db, BuildConfiguration(Limit));
                CommentCommandService service = CreateCommentService(
                    db,
                    ticketService,
                    nullifierService,
                    invalidations,
                    mutationOutbox: new CommentMutationOutboxWriter(db));
                return await service.CreateStrongAnonymousCommentAsync(
                    CreateCommentRequest(ticket, $"anonymous race {index}"),
                    RegionDecision(),
                    CancellationToken.None);
            }))).WaitAsync(TimeSpan.FromSeconds(30));

        using SqlSugarClient assertDb = PostgresSqlSugarTestClient.Create(connectionString);
        List<Comment> comments = assertDb.Queryable<Comment>().OrderBy(static comment => comment.Id).ToList();
        CommentAnonymousNullifier nullifier = Assert.Single(assertDb.Queryable<CommentAnonymousNullifier>().ToList());
        List<CommentRegionCompliance> compliance = assertDb.Queryable<CommentRegionCompliance>().ToList();
        List<CommentMutationOutboxEvent> outbox = assertDb.Queryable<CommentMutationOutboxEvent>().ToList();

        int successfulCount = results.Count(static result => result);
        Assert.Equal(Limit, successfulCount);
        Assert.Equal(Attempts - Limit, results.Count(static result => !result));
        Assert.Equal(successfulCount, comments.Count);
        Assert.Equal(successfulCount, compliance.Count);
        Assert.All(comments, comment =>
        {
            Assert.Equal(NullifierHash, comment.AnonymousNullifierHash);
            Assert.Equal("comment:v1:article:42:top", comment.AnonymousScope);
            Assert.False(comment.IsDeleted);
        });
        Assert.Equal(Limit, nullifier.UseCount);
        Assert.Contains(comments, comment => comment.Id == nullifier.FirstCommentId);
        Assert.Contains(comments, comment => comment.Id == nullifier.LastCommentId);
        Assert.Equal(successfulCount * 2, outbox.Count);
        Assert.All(comments, comment =>
        {
            CommentMutationOutboxEvent[] commentEvents = [.. outbox.Where(item => item.CommentId == comment.Id)];
            Assert.Equal(2, commentEvents.Length);
            Assert.Contains(commentEvents, item => item.EventType == CommentMutationEventTypes.Created);
            Assert.Contains(commentEvents, item => item.EventType == CommentMutationEventTypes.VisibilityChanged);
        });
        Assert.Empty(invalidations.Scopes);

        AnonymousCommentTicketPayload crossArticlePayload = CreateTicketPayload() with
        {
            ArticleId = 43,
            Scope = AnonymousCommentScopePolicy.CreateTopLevelScope(43)
        };
        CommentCommandService crossArticleService = CreateCommentService(
            assertDb,
            new FixedTicketService(crossArticlePayload),
            new CommentAnonymousNullifierService(assertDb, BuildConfiguration(limit: 1)),
            invalidations,
            mutationOutbox: new CommentMutationOutboxWriter(assertDb));
        bool crossArticleCreated = await crossArticleService.CreateStrongAnonymousCommentAsync(
            CreateCommentRequest(CreateTicket(201), "cross article mismatch"),
            RegionDecision(),
            CancellationToken.None);

        AnonymousCommentTicketPayload threadPayload = CreateTicketPayload() with
        {
            Scope = AnonymousCommentScopePolicy.CreateThreadScope(42, 123),
            RootId = 123
        };
        CommentCommandService threadMismatchService = CreateCommentService(
            assertDb,
            new FixedTicketService(threadPayload),
            new CommentAnonymousNullifierService(assertDb, BuildConfiguration(limit: 1)),
            invalidations,
            mutationOutbox: new CommentMutationOutboxWriter(assertDb));
        bool threadMismatchCreated = await threadMismatchService.CreateStrongAnonymousCommentAsync(
            CreateCommentRequest(CreateTicket(202), "thread mismatch"),
            RegionDecision(),
            CancellationToken.None);

        Assert.False(crossArticleCreated);
        Assert.False(threadMismatchCreated);
        Assert.Equal(successfulCount, assertDb.Queryable<Comment>().Count());
        Assert.Equal(successfulCount, assertDb.Queryable<CommentRegionCompliance>().Count());
        Assert.Single(assertDb.Queryable<CommentAnonymousNullifier>().ToList());
        Assert.Equal(successfulCount * 2, assertDb.Queryable<CommentMutationOutboxEvent>().Count());
        Assert.Empty(invalidations.Scopes);
    }

    [Fact]
    public async Task CreateStrongAnonymousCommentAsync_FailureAfterConsumeRollsBackCommentAndNullifier()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        CreateCommentTables(db);
        SeedArticle(db, 42);
        var invalidations = new RecordingCacheInvalidationDispatcher();
        var inner = new CommentAnonymousNullifierService(db, BuildConfiguration(limit: 1));
        var consumeThenFail = new ConsumeThenFailNullifierService(inner);
        CommentCommandService service = CreateCommentService(
            db,
            new FixedTicketService(CreateTicketPayload()),
            consumeThenFail,
            invalidations,
            mutationOutbox: new CommentMutationOutboxWriter(db));

        bool created = await service.CreateStrongAnonymousCommentAsync(
            CreateCommentRequest(CreateTicket(99), "rollback after consume"),
            RegionDecision(),
            CancellationToken.None);

        Assert.False(created);
        Assert.Equal(1, consumeThenFail.ConsumeAttempts);
        Assert.Equal(0, db.Queryable<Comment>().Count());
        Assert.Equal(0, db.Queryable<CommentRegionCompliance>().Count());
        Assert.Equal(0, db.Queryable<CommentAnonymousNullifier>().Count());
        Assert.Equal(0, db.Queryable<CommentMutationOutboxEvent>().Count());
        Assert.Empty(invalidations.Scopes);
    }

    [Fact]
    public async Task CreateStrongAnonymousCommentAsync_InitiallyHiddenNeverPublishesRemoveEvent()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        CreateCommentTables(db);
        SeedArticle(db, 42);
        var invalidations = new RecordingCacheInvalidationDispatcher();
        IMessageRealtimePublisher realtime = Substitute.For<IMessageRealtimePublisher>();
        var antiSpam = Substitute.For<IAntiSpamModerationService>();
        antiSpam.ScoreCommentAsync(Arg.Any<AntiSpamCommentModerationContext>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<AntiSpamModerationResult?>(CreateRiskModelResult()));
        var dispositionPolicy = Substitute.For<ICommentModerationDispositionPolicy>();
        dispositionPolicy.Decide(
                Arg.Any<Comment>(),
                Arg.Any<RegionModerationDecision>(),
                Arg.Any<AntiSpamModerationResult>())
            .Returns(new CommentModerationDisposition(
                CommentModerationStatus.Hidden,
                "high-risk",
                AutoApplied: true,
                RequiresHumanReview: true,
                CommentModerationDispositionModes.AutoHideHighRisk,
                new Dictionary<string, string> { ["reason"] = "high-risk" }));
        CommentCommandService service = CreateCommentService(
            db,
            new FixedTicketService(CreateTicketPayload()),
            new CommentAnonymousNullifierService(db, BuildConfiguration(limit: 1)),
            invalidations,
            realtime,
            antiSpam,
            dispositionPolicy);

        bool created = await service.CreateStrongAnonymousCommentAsync(
            CreateCommentRequest(CreateTicket(77), "automatic moderation target"),
            RegionDecision(),
            CancellationToken.None);

        Assert.True(created);
        Comment comment = Assert.Single(db.Queryable<Comment>().ToList());
        Assert.Equal(CommentModerationStatus.Hidden, comment.ModerationStatus);
        Assert.Equal("hidden_region_review", comment.ModerationReason);
        CommentCacheInvalidationScope[] scopes = invalidations.Scopes.ToArray();
        Assert.Single(scopes);
        Assert.False(scopes[0].PublicArticleChanged);
        Assert.All(scopes, scope =>
        {
            Assert.Equal(42, scope.ArticleId);
            Assert.Equal(comment.Id, scope.RootId);
        });
        await realtime.DidNotReceive().PushCommentRemoveAsync(Arg.Any<int>(), Arg.Any<long>(), Arg.Any<long?>(), Arg.Any<long?>());
    }

    private static IConfiguration BuildConfiguration(int limit)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Moderation:Pepper"] = ModerationPepper,
                ["AnonymousIdentity:NullifierPepper"] = "unit-test-anonymous-nullifier-pepper-32-bytes-minimum",
                ["AnonymousIdentity:NullifierScopeUseLimit"] = limit.ToString(System.Globalization.CultureInfo.InvariantCulture)
            })
            .Build();

    private static CommentCommandService CreateCommentService(
        SqlSugarClient db,
        IAnonymousCommentTicketService ticketService,
        ICommentAnonymousNullifierService nullifierService,
        ICacheInvalidationDispatcher invalidations,
        IMessageRealtimePublisher? realtime = null,
        IAntiSpamModerationService? antiSpam = null,
        ICommentModerationDispositionPolicy? dispositionPolicy = null,
        ICommentMutationOutbox? mutationOutbox = null)
    {
        AnonymousCommentPolicySnapshot policy = AnonymousCommentPolicySnapshot.Default with
        {
            AnonymousCommentsEnabled = true,
            ZkAnonymousEnabled = true
        };
        var policyService = Substitute.For<IAnonymousCommentPolicyService>();
        policyService.GetCurrentAsync(Arg.Any<CancellationToken>()).Returns(policy);
        var proofService = Substitute.For<IZkAnonymousProofService>();
        proofService.CurrentZkCommentPolicy.Returns(new ZkCommentPolicySnapshot(
            Enabled: true,
            NativeVerifierConfigured: true,
            TrustedSetupVerified: true,
            CredentialRequired: true,
            CredentialRootReady: true,
            UnavailableReason: string.Empty));

        var notifications = new CommentNotificationService(
            realtime ?? Substitute.For<IMessageRealtimePublisher>(),
            Substitute.For<IMessageCommandService>(),
            NullLogger<CommentNotificationService>.Instance);
        var moderation = new CommentModerationService(
            db,
            new RegionLegalModerationService(),
            invalidations,
            notifications,
            NullLogger<CommentModerationService>.Instance,
            antiSpam,
            dispositionPolicy,
            anonymousPolicy: policyService);
        IConfiguration configuration = BuildConfiguration(limit: 2);
        var attribution = new CommentAttributionPrivacyService(
            NullLogger<CommentAttributionPrivacyService>.Instance,
            policy: policyService,
            nullifiers: nullifierService,
            tickets: ticketService,
            displayNames: new CommentAnonymousDisplayNameGenerator(),
            configuration: configuration,
            zkProofs: proofService);
        return new CommentCommandService(
            db,
            NullLogger<CommentCommandService>.Instance,
            notifications,
            moderation,
            attribution,
            invalidations,
            mutationOutbox: mutationOutbox);
    }

    private static AntiSpamModerationResult CreateRiskModelResult()
        => new(
            Available: true,
            Provider: "issue-1040-provider",
            Model: "issue-1040-model",
            ContractVersion: AntiSpamModerationContract.DefaultVersion,
            Label: "risky",
            Confidence: 0.98d,
            Severity: "high",
            PrimaryReason: "high-risk",
            NeedsSecondRound: false,
            Categories: [],
            Evidence: [],
            RawReason: null,
            Latency: TimeSpan.FromMilliseconds(1),
            Status: AntiSpamModerationStatuses.Ok,
            ErrorCode: null,
            ThresholdProfile: null,
            Metadata: new Dictionary<string, string>());

    private static AnonymousCommentCreateRequestCoreModel CreateCommentRequest(byte[] ticket, string content)
        => new(
            42,
            content,
            ParentId: null,
            RootId: null,
            ReplyToCommentId: null,
            AnonymousScope: "comment:v1:article:42:top",
            DisplayLanguage: "en",
            Ticket: ticket);

    private static AnonymousCommentTicketPayload CreateTicketPayload()
        => new(
            ArticleId: 42,
            Scope: "comment:v1:article:42:top",
            ParentId: null,
            RootId: null,
            ReplyToCommentId: null,
            NullifierHash,
            RateClass: AnonymousPrivacyContract.CommonRateClass,
            RequiresModeration: false,
            ExpiresAtUnixMs: DateTimeOffset.UtcNow.AddMinutes(5).ToUnixTimeMilliseconds());

    private static RegionModerationDecision RegionDecision()
        => new(
            true,
            RegionCodes.Singapore,
            0.95d,
            "unit",
            "ip-hash",
            [],
            [],
            [],
            RegionLegalModerationService.CurrentPolicyVersion,
            "allowed",
            "allowed",
            RequiresManualReview: true,
            HideUntilReviewed: true);

    private static byte[] CreateTicket(int seed)
        => Enumerable.Range(0, 32).Select(index => (byte)(index + seed + 1)).ToArray();

    private static void CreateCommentTables(SqlSugarClient db)
        => PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(Article),
            typeof(ArticlePublicationRecord),
            typeof(Comment),
            typeof(CommentRevision),
            typeof(CommentBlockedRegion),
            typeof(CommentRegionCompliance),
            typeof(CommentMutationOutboxEvent),
            typeof(CommentModerationEvent),
            typeof(CommentAnonymousNullifier));

    private static void SeedArticle(SqlSugarClient db, int articleId)
        => db.Ado.ExecuteCommand(
            """
            INSERT INTO article
                (id, title, categoryid, views, createtime, metadata_updated_at, isdeleted, status, published_at, scheduled_publish_at)
            VALUES
                (@Id, 'concurrency article', 1, 0, @PublishedAt, @PublishedAt, false, @Status, @PublishedAt, NULL);
            """,
            new SugarParameter("@Id", articleId),
            new SugarParameter("@Status", (int)ArticleStatus.Published),
            new SugarParameter("@PublishedAt", DateTime.UtcNow.AddMinutes(-1)));

    private static Task<T> StartBarrierTaskAsync<T>(Barrier barrier, Func<Task<T>> action)
        => Task.Factory.StartNew(
            async () =>
            {
                Assert.True(
                    barrier.SignalAndWait(TimeSpan.FromSeconds(20)),
                    "Timed out waiting for the PostgreSQL nullifier race barrier.");
                return await action();
            },
            CancellationToken.None,
            TaskCreationOptions.LongRunning,
            TaskScheduler.Default).Unwrap();

    private sealed class FixedTicketService(AnonymousCommentTicketPayload payload) : IAnonymousCommentTicketService
    {
        private int _consumed;

        public Task<AnonymousCommentTicketIssueResult> IssueAsync(
            AnonymousCommentTicketRequestCoreModel request,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<CacheReadResult<AnonymousCommentTicketPayload>> ConsumeTicketAsync(
            byte[] ticket,
            CancellationToken cancellationToken = default)
        {
            bool found = Interlocked.Exchange(ref _consumed, 1) == 0;
            return Task.FromResult(new CacheReadResult<AnonymousCommentTicketPayload>(found, found ? payload : default));
        }
    }

    private sealed class ConsumeThenFailNullifierService(ICommentAnonymousNullifierService inner) : ICommentAnonymousNullifierService
    {
        public int ConsumeAttempts
        {
            get; private set;
        }

        public Task<NullifierReservationResult> PrecheckAsync(string nullifierHash, string scope, CancellationToken cancellationToken = default)
            => inner.PrecheckAsync(nullifierHash, scope, cancellationToken);

        public Task<NullifierReservationResult> CheckAndReserveAsync(string nullifierHash, string scope, CancellationToken cancellationToken = default)
            => inner.CheckAndReserveAsync(nullifierHash, scope, cancellationToken);

        public async Task<NullifierReservationResult> TryConsumeAsync(
            string nullifierHash,
            string scope,
            long commentId,
            CancellationToken cancellationToken = default)
        {
            ConsumeAttempts++;
            NullifierReservationResult result = await inner.TryConsumeAsync(nullifierHash, scope, commentId, cancellationToken);
            Assert.True(result.Allowed);
            throw new InvalidOperationException("synthetic failure after nullifier consume");
        }

        public Task<bool> IncrementUsageAsync(string nullifierHash, string scope, long commentId, CancellationToken cancellationToken = default)
            => inner.IncrementUsageAsync(nullifierHash, scope, commentId, cancellationToken);

        public Task<bool> BlockAsync(string nullifierHash, string scope, string reason, CancellationToken cancellationToken = default)
            => inner.BlockAsync(nullifierHash, scope, reason, cancellationToken);
    }

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
}
