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
        const int attempts = 12;
        const int limit = 3;
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using (SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString))
        {
            PostgresSqlSugarTestClient.InitTables(setupDb, typeof(CommentAnonymousNullifier));
        }
        using var barrier = new Barrier(attempts);

        NullifierReservationResult[] results = await Task.WhenAll(Enumerable.Range(0, attempts)
            .Select(index => StartBarrierTaskAsync(barrier, async () =>
            {
                using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
                var service = new CommentAnonymousNullifierService(db, BuildConfiguration(limit));
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

        Assert.Equal(limit, results.Count(static result => result.Allowed));
        Assert.Equal(attempts - limit, rejected.Length);
        Assert.All(rejected, result =>
        {
            Assert.Equal("scope_limit_exceeded", result.Status);
            Assert.Equal(limit, result.CurrentUseCount);
        });
        Assert.Equal(limit, row.UseCount);
        Assert.Contains(row.FirstCommentId!.Value, allowedCommentIds);
        Assert.Contains(row.LastCommentId!.Value, allowedCommentIds);
        Assert.False(row.Blocked);
    }

    [Fact]
    public async Task CreateStrongAnonymousCommentAsync_SameNullifierRaceCommitsOnlyAllowedComments()
    {
        const int attempts = 8;
        const int limit = 2;
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using (SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString))
        {
            CreateCommentTables(setupDb);
            SeedArticle(setupDb, 42);
        }
        var invalidations = new RecordingCacheInvalidationDispatcher();
        using var barrier = new Barrier(attempts);

        bool[] results = await Task.WhenAll(Enumerable.Range(0, attempts)
            .Select(index => StartBarrierTaskAsync(barrier, async () =>
            {
                using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
                byte[] ticket = CreateTicket(index);
                var ticketService = new FixedTicketService(CreateTicketPayload());
                var nullifierService = new CommentAnonymousNullifierService(db, BuildConfiguration(limit));
                CommentService service = CreateCommentService(db, ticketService, nullifierService, invalidations);
                return await service.CreateStrongAnonymousCommentAsync(
                    CreateCommentRequest(ticket, $"anonymous race {index}"),
                    RegionDecision(),
                    CancellationToken.None);
            }))).WaitAsync(TimeSpan.FromSeconds(30));

        using SqlSugarClient assertDb = PostgresSqlSugarTestClient.Create(connectionString);
        List<Comment> comments = assertDb.Queryable<Comment>().OrderBy(static comment => comment.Id).ToList();
        CommentAnonymousNullifier nullifier = Assert.Single(assertDb.Queryable<CommentAnonymousNullifier>().ToList());
        List<CommentRegionCompliance> compliance = assertDb.Queryable<CommentRegionCompliance>().ToList();

        Assert.Equal(limit, results.Count(static result => result));
        Assert.Equal(attempts - limit, results.Count(static result => !result));
        Assert.Equal(limit, comments.Count);
        Assert.Equal(limit, compliance.Count);
        Assert.All(comments, comment =>
        {
            Assert.Equal(NullifierHash, comment.AnonymousNullifierHash);
            Assert.Equal("article:42", comment.AnonymousScope);
            Assert.False(comment.IsDeleted);
        });
        Assert.Equal(limit, nullifier.UseCount);
        Assert.Contains(comments, comment => comment.Id == nullifier.FirstCommentId);
        Assert.Contains(comments, comment => comment.Id == nullifier.LastCommentId);
        Assert.Equal(limit, invalidations.Scopes.Count);
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
        CommentService service = CreateCommentService(
            db,
            new FixedTicketService(CreateTicketPayload()),
            consumeThenFail,
            invalidations);

        bool created = await service.CreateStrongAnonymousCommentAsync(
            CreateCommentRequest(CreateTicket(99), "rollback after consume"),
            RegionDecision(),
            CancellationToken.None);

        Assert.False(created);
        Assert.Equal(1, consumeThenFail.ConsumeAttempts);
        Assert.Equal(0, db.Queryable<Comment>().Count());
        Assert.Equal(0, db.Queryable<CommentRegionCompliance>().Count());
        Assert.Equal(0, db.Queryable<CommentAnonymousNullifier>().Count());
        Assert.Empty(invalidations.Scopes);
    }

    [Fact]
    public async Task CreateStrongAnonymousCommentAsync_AutoHiddenDispositionInvalidatesUsingFinalStatus()
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
        CommentService service = CreateCommentService(
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
        Assert.Equal("model_policy:high-risk", comment.ModerationReason);
        CommentCacheInvalidationScope[] scopes = invalidations.Scopes.ToArray();
        Assert.Equal(2, scopes.Length);
        Assert.True(scopes[0].PublicArticleChanged);
        Assert.False(scopes[1].PublicArticleChanged);
        Assert.All(scopes, scope =>
        {
            Assert.Equal(42, scope.ArticleId);
            Assert.Equal(comment.Id, scope.RootId);
        });
        await realtime.Received(1).PushCommentRemoveAsync(42, comment.Id, comment.Id, null);
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

    private static CommentService CreateCommentService(
        SqlSugarClient db,
        IAnonymousCommentTicketService ticketService,
        ICommentAnonymousNullifierService nullifierService,
        ICacheInvalidationDispatcher invalidations,
        IMessageRealtimePublisher? realtime = null,
        IAntiSpamModerationService? antiSpam = null,
        ICommentModerationDispositionPolicy? dispositionPolicy = null)
    {
        AnonymousCommentPolicySnapshot policy = AnonymousCommentPolicySnapshot.Default with
        {
            AnonymousCommentsEnabled = true,
            ZkAnonymousEnabled = true
        };
        var policyService = Substitute.For<IAnonymousCommentPolicyService>();
        policyService.GetCurrentAsync(Arg.Any<CancellationToken>()).Returns(policy);
        var proofService = Substitute.For<IZkAnonymousProofService>();
        proofService.CurrentZkProdPolicy.Returns(new ZkProdPolicySnapshot(
            Enabled: true,
            NativeVerifierConfigured: true,
            TrustedSetupVerified: true,
            CredentialRequired: true,
            CredentialRootReady: true,
            UnavailableReason: string.Empty));

        return new CommentService(
            db,
            NullLogger<CommentService>.Instance,
            realtime ?? Substitute.For<IMessageRealtimePublisher>(),
            Substitute.For<IMessageCommandService>(),
            invalidations,
            new RegionLegalModerationService(),
            antiSpamModerationService: antiSpam,
            anonymousCommentPolicyService: policyService,
            anonymousNullifierService: nullifierService,
            commentModerationDispositionPolicy: dispositionPolicy,
            anonymousCommentTicketService: ticketService,
            anonymousDisplayNameGenerator: new CommentAnonymousDisplayNameGenerator(),
            configuration: BuildConfiguration(limit: 2),
            zkAnonymousProofService: proofService);
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
            AnonymousScope: "article:42",
            DisplayLanguage: "en",
            Ticket: ticket);

    private static AnonymousCommentTicketPayload CreateTicketPayload()
        => new(
            ArticleId: 42,
            Scope: "article:42",
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
            typeof(Comment),
            typeof(CommentBlockedRegion),
            typeof(CommentRegionCompliance),
            typeof(CommentAnonymousNullifier));

    private static void SeedArticle(SqlSugarClient db, int articleId)
        => db.Ado.ExecuteCommand(
            """
            INSERT INTO article
                (id, title, categoryid, views, createtime, isdeleted, status, published_at, scheduled_publish_at)
            VALUES
                (@Id, 'concurrency article', 1, 0, @PublishedAt, false, @Status, @PublishedAt, NULL);
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
