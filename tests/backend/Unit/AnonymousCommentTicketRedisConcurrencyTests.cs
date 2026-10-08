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
using FsusBlog.Shared.Contracts.Validation;

using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;

using StackExchange.Redis;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Concurrency")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class AnonymousCommentTicketRedisConcurrencyTests(
    PostgresSchemaMigrationFixture postgres,
    PublicHotDeliveryRedisFixture redis) : IClassFixture<PublicHotDeliveryRedisFixture>
{
    private const int Attempts = 16;
    private const string NullifierHash = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
    private const string ModerationPepper = "unit-test-moderation-pepper-with-at-least-thirty-two-chars";

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Concurrency, ConcurrencyHarness = "fsusblog.real-concurrency.v1")]
    public async Task ConsumeTicketAsync_RealRedisL2RaceReturnsExactlyOnePayloadAndConverges()
    {
        await using TicketCacheContext context = await TicketCacheContext.CreateAsync(redis, warmL1: false);
        AnonymousCommentTicketIssueResult issued = await IssueAsync(context);

        await AssertTicketStoredByHashOnlyAsync(context, issued);
        CacheL1Key l1Key = CacheL1Key.ForString(
            context.Scope.ScopeToken,
            CachePolicyId.AnonymousCommentTicket,
            AnonymousCommentTicketService.HashTicket(issued.Response.Ticket));
        Assert.False(context.LocalStore.TryGet(l1Key, out _));

        CacheReadResult<AnonymousCommentTicketPayload>[] results = await ConsumeConcurrentlyAsync(
            context.Service,
            issued.Response.Ticket);

        AssertExactlyOnePayload(results, issued.Response.TicketExpiresAtUnixMs);
        await AssertConsumedStateAsync(context, issued.Response.Ticket);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Concurrency, ConcurrencyHarness = "fsusblog.real-concurrency.v1")]
    public async Task ConsumeTicketAsync_WarmedL1RaceStillUsesRedisAuthorityExactlyOnce()
    {
        await using TicketCacheContext context = await TicketCacheContext.CreateAsync(redis, warmL1: true);
        AnonymousCommentTicketIssueResult issued = await IssueAsync(context);
        string ticketHash = AnonymousCommentTicketService.HashTicket(issued.Response.Ticket);
        CacheL1Key l1Key = CacheL1Key.ForString(
            context.Scope.ScopeToken,
            CachePolicyId.AnonymousCommentTicket,
            ticketHash);

        CacheReadResult<AnonymousCommentTicketPayload> warmed = await context.Service.ReadTicketAsync(
            issued.Response.Ticket,
            CancellationToken.None);
        Assert.True(warmed.Hit);
        Assert.True(context.LocalStore.TryGet(l1Key, out _));

        CacheReadResult<AnonymousCommentTicketPayload>[] results = await ConsumeConcurrentlyAsync(
            context.Service,
            issued.Response.Ticket);

        AssertExactlyOnePayload(results, issued.Response.TicketExpiresAtUnixMs);
        Assert.False(context.LocalStore.TryGet(l1Key, out _));
        await AssertConsumedStateAsync(context, issued.Response.Ticket);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Concurrency, ConcurrencyHarness = "fsusblog.real-concurrency.v1")]
    public async Task ConsumeTicketAsync_ExpiredRedisTtlReturnsOnlyMisses()
    {
        await using TicketCacheContext context = await TicketCacheContext.CreateAsync(redis, warmL1: false);
        AnonymousCommentTicketIssueResult issued = await IssueAsync(context);
        string key = context.ResolveTicketKey(issued.Response.Ticket);
        Assert.True(await context.Database.KeyExpireAsync(key, TimeSpan.FromMilliseconds(50)));
        await WaitUntilAsync(async () => !await context.Database.KeyExistsAsync(key));

        CacheReadResult<AnonymousCommentTicketPayload>[] results = await ConsumeConcurrentlyAsync(
            context.Service,
            issued.Response.Ticket);

        Assert.All(results, static result => Assert.False(result.Hit));
        await AssertConsumedStateAsync(context, issued.Response.Ticket);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-consume-ticket-async-malformed-or-tampered-payload-fails-closed-and-does-not-revive-key")]
    public async Task ConsumeTicketAsync_MalformedOrTamperedPayloadFailsClosedAndDoesNotReviveKey(bool tamperVersion)
    {
        await using TicketCacheContext context = await TicketCacheContext.CreateAsync(redis, warmL1: false);
        AnonymousCommentTicketIssueResult issued = await IssueAsync(context);
        string ticketHash = AnonymousCommentTicketService.HashTicket(issued.Response.Ticket);
        byte[] invalidPayload = tamperVersion
            ? await ReadAndTamperVersionAsync(context, issued.Response.Ticket)
            : [0x03, 0x01, 0x02];
        await context.Cache.SetRawAsync(
            CachePolicyId.AnonymousCommentTicket,
            ticketHash,
            invalidPayload,
            TimeSpan.FromMinutes(2),
            CancellationToken.None);

        CacheReadResult<AnonymousCommentTicketPayload> consumed = await context.Service.ConsumeTicketAsync(
            issued.Response.Ticket,
            CancellationToken.None);

        Assert.False(consumed.Hit);
        Assert.False((await context.Service.ConsumeTicketAsync(issued.Response.Ticket, CancellationToken.None)).Hit);
        await AssertConsumedStateAsync(context, issued.Response.Ticket);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-consume-ticket-async-cancellation-and-redis-failure-allow-at-most-one-later-success")]
    public async Task ConsumeTicketAsync_CancellationAndRedisFailureAllowAtMostOneLaterSuccess()
    {
        await using TicketCacheContext context = await TicketCacheContext.CreateAsync(redis, warmL1: false);
        AnonymousCommentTicketIssueResult canceledTicket = await IssueAsync(context);
        using (var cancellation = new CancellationTokenSource())
        {
            cancellation.Cancel();
            await Assert.ThrowsAsync<OperationCanceledException>(() => context.Service.ConsumeTicketAsync(
                canceledTicket.Response.Ticket,
                cancellation.Token));
        }

        Assert.True((await context.Service.ConsumeTicketAsync(canceledTicket.Response.Ticket, CancellationToken.None)).Hit);
        Assert.False((await context.Service.ConsumeTicketAsync(canceledTicket.Response.Ticket, CancellationToken.None)).Hit);

        AnonymousCommentTicketIssueResult failedTicket = await IssueAsync(context);
        IDatabase failingDatabase = Substitute.For<IDatabase>();
        int calls = 0;
        failingDatabase.StringGetDeleteAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>())
            .Returns(call =>
            {
                if (Interlocked.Increment(ref calls) == 1)
                {
                    throw new RedisConnectionException(ConnectionFailureType.UnableToConnect, "simulated Redis boundary failure");
                }

                return context.Database.StringGetDeleteAsync(
                    call.ArgAt<RedisKey>(0),
                    call.ArgAt<CommandFlags>(1));
            });
        IConnectionMultiplexer failingConnection = Substitute.For<IConnectionMultiplexer>();
        failingConnection.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(failingDatabase);
        using var failureMemory = new MemoryCache(new MemoryCacheOptions());
        using var failureCache = new UnifiedCache(
            failingConnection,
            context.Policies,
            context.Scope,
            NullLogger<UnifiedCache>.Instance);
        AnonymousCommentTicketService failureService = AnonymousCommentTicketServiceTests.CreateServiceForCache(
            failureCache,
            failureCache,
            failureCache,
            TimeProvider.System);

        RedisOperationUnavailableException failure =
            await Assert.ThrowsAsync<RedisOperationUnavailableException>(() => failureService.ConsumeTicketAsync(
                failedTicket.Response.Ticket,
                CancellationToken.None));
        Assert.Equal(RedisOperationFailureKind.RedisFailure, failure.FailureKind);
        _ = Assert.IsType<RedisConnectionException>(failure.InnerException);
        Assert.True((await failureService.ConsumeTicketAsync(failedTicket.Response.Ticket, CancellationToken.None)).Hit);
        Assert.False((await failureService.ConsumeTicketAsync(failedTicket.Response.Ticket, CancellationToken.None)).Hit);
        await AssertConsumedStateAsync(context, failedTicket.Response.Ticket);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Concurrency, ConcurrencyHarness = "fsusblog.real-concurrency.v1")]
    public async Task CreateStrongAnonymousCommentAsync_SameRealTicketRaceCommitsOneTransactionAndReplays()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(postgres);
        using (SqlSugarClient setup = PostgresSqlSugarTestClient.Create(connectionString))
        {
            CreateCommentTables(setup);
            SeedArticle(setup, 42);
        }

        await using TicketCacheContext context = await TicketCacheContext.CreateAsync(redis, warmL1: false);
        AnonymousCommentTicketIssueResult issued = await IssueAsync(context);
        var tickets = new RecordingTicketService(context.Service);
        var invalidations = new RecordingCacheInvalidationDispatcher();
        using var barrier = new Barrier(Attempts);
        AnonymousCommentCreateRequestCoreModel request = CreateCommentRequest(issued.Response.Ticket);

        CommentCreateResult[] results = await RealConcurrencyHarness.RunAsync(Enumerable.Range(0, Attempts), _ => StartBarrierTaskAsync(barrier, async () =>
            {
                using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
                CommentCommandService service = CreateCommentService(
                    db,
                    tickets,
                    new CommentAnonymousNullifierService(db, BuildCommentConfiguration()),
                    invalidations,
                    new CommentMutationOutboxWriter(db));
                return await service.CreateStrongAnonymousCommentResultAsync(
                    request,
                    RegionDecision(),
                    CancellationToken.None);
            })).WaitAsync(TimeSpan.FromSeconds(40));

        Assert.All(results, static result => Assert.True(result.Created));
        Assert.Single(results, static result => !result.IdempotencyReplay);
        Assert.Equal(Attempts - 1, results.Count(static result => result.IdempotencyReplay));
        Assert.Single(results.Select(static result => result.CommentId).Distinct());
        Assert.Equal(1, tickets.ConsumeHits);

        using SqlSugarClient assertion = PostgresSqlSugarTestClient.Create(connectionString);
        Comment comment = Assert.Single(assertion.Queryable<Comment>().ToList());
        CommentAnonymousNullifier nullifier = Assert.Single(assertion.Queryable<CommentAnonymousNullifier>().ToList());
        Assert.Single(assertion.Queryable<CommentRegionCompliance>().ToList());
        CommentMutationOutboxEvent[] outbox = [.. assertion.Queryable<CommentMutationOutboxEvent>().ToList()];
        Assert.Equal(2, outbox.Length);
        Assert.All(outbox, item => Assert.Equal(comment.Id, item.CommentId));
        Assert.Equal(1, nullifier.UseCount);
        Assert.Equal(comment.Id, nullifier.FirstCommentId);
        Assert.Equal(comment.Id, nullifier.LastCommentId);
        Assert.Empty(invalidations.Scopes);
        await AssertConsumedStateAsync(context, issued.Response.Ticket);
    }

    private static async Task<AnonymousCommentTicketIssueResult> IssueAsync(TicketCacheContext context)
    {
        AnonymousCommentTicketIssueResult issued = await context.Service.IssueAsync(
            AnonymousCommentTicketServiceTests.CreateValidRequest(),
            CancellationToken.None);
        Assert.True(issued.Issued);
        return issued;
    }

    private static async Task<CacheReadResult<AnonymousCommentTicketPayload>[]> ConsumeConcurrentlyAsync(
        AnonymousCommentTicketService service,
        byte[] ticket)
    {
        using var barrier = new Barrier(Attempts);
        return await RealConcurrencyHarness.RunAsync(Enumerable.Range(0, Attempts),
            _ => StartBarrierTaskAsync(barrier, () => service.ConsumeTicketAsync(
                ticket,
                CancellationToken.None))).WaitAsync(TimeSpan.FromSeconds(30));
    }

    private static void AssertExactlyOnePayload(
        CacheReadResult<AnonymousCommentTicketPayload>[] results,
        long expiresAtUnixMs)
    {
        CacheReadResult<AnonymousCommentTicketPayload> hit = Assert.Single(results, static result => result.Hit);
        Assert.NotNull(hit.Value);
        Assert.Equal(new AnonymousCommentTicketPayload(
            42,
            "comment:v1:article:42:top",
            null,
            null,
            null,
            Convert.ToHexStringLower(Enumerable.Repeat((byte)0xA1, 32).ToArray()),
            AnonymousPrivacyContract.CommonRateClass,
            false,
            expiresAtUnixMs), hit.Value);
        Assert.Equal(Attempts - 1, results.Count(static result => !result.Hit));
    }

    private static async Task AssertTicketStoredByHashOnlyAsync(
        TicketCacheContext context,
        AnonymousCommentTicketIssueResult issued)
    {
        string ticketHash = AnonymousCommentTicketService.HashTicket(issued.Response.Ticket);
        string hashedKey = context.ResolveTicketKey(issued.Response.Ticket);
        string rawTicketIdentity = Convert.ToHexStringLower(issued.Response.Ticket);
        string rawTicketKey = context.Scope.PrefixKey(context.Policy.BuildKey(rawTicketIdentity));
        RedisValue stored = await context.Database.StringGetAsync(hashedKey);

        Assert.True(stored.HasValue);
        Assert.False(await context.Database.KeyExistsAsync(rawTicketKey));
        Assert.False(ContainsSubsequence((byte[])stored!, issued.Response.Ticket));
        Assert.Equal(ticketHash, context.ResolveTicketIdentity(hashedKey));
        Assert.False(await context.Database.SetContainsAsync(context.RegistryKey, hashedKey));
    }

    private static async Task AssertConsumedStateAsync(TicketCacheContext context, byte[] ticket)
    {
        string hashedKey = context.ResolveTicketKey(ticket);
        string rawTicketKey = context.Scope.PrefixKey(context.Policy.BuildKey(Convert.ToHexStringLower(ticket)));
        CacheL1Key l1Key = CacheL1Key.ForString(
            context.Scope.ScopeToken,
            CachePolicyId.AnonymousCommentTicket,
            AnonymousCommentTicketService.HashTicket(ticket));

        Assert.False(await context.Database.KeyExistsAsync(hashedKey));
        Assert.False(await context.Database.KeyExistsAsync(rawTicketKey));
        Assert.False(await context.Database.SetContainsAsync(context.RegistryKey, hashedKey));
        Assert.False(context.LocalStore.TryGet(l1Key, out _));
        Assert.False((await context.Service.ConsumeTicketAsync(ticket, CancellationToken.None)).Hit);
    }

    private static async Task<byte[]> ReadAndTamperVersionAsync(TicketCacheContext context, byte[] ticket)
    {
        RedisValue value = await context.Database.StringGetAsync(context.ResolveTicketKey(ticket));
        Assert.True(value.HasValue);
        byte[] bytes = (byte[])value!;
        bytes[0] ^= 0x7F;
        return bytes;
    }

    private static async Task WaitUntilAsync(Func<Task<bool>> predicate)
    {
        DateTime deadline = DateTime.UtcNow.AddSeconds(5);
        while (DateTime.UtcNow < deadline)
        {
            if (await predicate())
            {
                return;
            }

            await Task.Delay(10);
        }

        Assert.Fail("Timed out waiting for Redis TTL expiry.");
    }

    private static Task<T> StartBarrierTaskAsync<T>(Barrier barrier, Func<Task<T>> action)
        => Task.Factory.StartNew(
            async () =>
            {
                Assert.True(
                    barrier.SignalAndWait(TimeSpan.FromSeconds(20)),
                    "Timed out waiting for the anonymous ticket race barrier.");
                return await action();
            },
            CancellationToken.None,
            TaskCreationOptions.LongRunning,
            TaskScheduler.Default).Unwrap();

    private static AnonymousCommentCreateRequestCoreModel CreateCommentRequest(byte[] ticket)
        => new(
            42,
            "same anonymous ticket concurrency",
            ParentId: null,
            RootId: null,
            ReplyToCommentId: null,
            AnonymousScope: "comment:v1:article:42:top",
            DisplayLanguage: "en",
            Ticket: ticket);

    private static IConfiguration BuildCommentConfiguration()
        => new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Moderation:Pepper"] = ModerationPepper,
                ["AnonymousIdentity:NullifierPepper"] = "unit-test-anonymous-nullifier-pepper-32-bytes-minimum",
                ["AnonymousIdentity:NullifierScopeUseLimit"] = "1"
            })
            .Build();

    private static CommentCommandService CreateCommentService(
        SqlSugarClient db,
        IAnonymousCommentTicketService tickets,
        ICommentAnonymousNullifierService nullifiers,
        ICacheInvalidationDispatcher invalidations,
        ICommentMutationOutbox mutationOutbox)
    {
        AnonymousCommentPolicySnapshot policy = AnonymousCommentPolicySnapshot.Default with
        {
            AnonymousCommentsEnabled = true,
            ZkAnonymousEnabled = true
        };
        IAnonymousCommentPolicyService policyService = Substitute.For<IAnonymousCommentPolicyService>();
        policyService.GetCurrentAsync(Arg.Any<CancellationToken>()).Returns(policy);
        IZkAnonymousProofService proofService = Substitute.For<IZkAnonymousProofService>();
        proofService.CurrentZkCommentPolicy.Returns(new ZkCommentPolicySnapshot(
            true,
            true,
            true,
            true,
            true,
            string.Empty));
        var notifications = new CommentNotificationService(
            Substitute.For<IMessageRealtimePublisher>(),
            Substitute.For<IMessageCommandService>(),
            NullLogger<CommentNotificationService>.Instance);
        var moderation = new CommentModerationService(
            db,
            new RegionLegalModerationService(),
            invalidations,
            notifications,
            NullLogger<CommentModerationService>.Instance,
            anonymousPolicy: policyService);
        var attribution = new CommentAttributionPrivacyService(
            NullLogger<CommentAttributionPrivacyService>.Instance,
            policy: policyService,
            nullifiers: nullifiers,
            tickets: tickets,
            displayNames: new CommentAnonymousDisplayNameGenerator(),
            configuration: BuildCommentConfiguration(),
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
                (@Id, 'anonymous ticket concurrency article', 1, 0, @PublishedAt, @PublishedAt, false, @Status, @PublishedAt, NULL);
            """,
            new SugarParameter("@Id", articleId),
            new SugarParameter("@Status", (int)ArticleStatus.Published),
            new SugarParameter("@PublishedAt", DateTime.UtcNow.AddMinutes(-1)));

    private static bool ContainsSubsequence(byte[] source, byte[] candidate)
    {
        if (candidate.Length == 0 || source.Length < candidate.Length)
        {
            return false;
        }

        for (int offset = 0; offset <= source.Length - candidate.Length; offset++)
        {
            if (source.AsSpan(offset, candidate.Length).SequenceEqual(candidate))
            {
                return true;
            }
        }

        return false;
    }

    private sealed class RecordingTicketService(AnonymousCommentTicketService inner) : IAnonymousCommentTicketService
    {
        private int _consumeHits;

        public int ConsumeHits => Volatile.Read(ref _consumeHits);

        public Task<AnonymousCommentTicketIssueResult> IssueAsync(
            AnonymousCommentTicketRequestCoreModel request,
            CancellationToken cancellationToken = default)
            => inner.IssueAsync(request, cancellationToken);

        public async Task<CacheReadResult<AnonymousCommentTicketPayload>> ConsumeTicketAsync(
            byte[] ticket,
            CancellationToken cancellationToken = default)
        {
            CacheReadResult<AnonymousCommentTicketPayload> result = await inner.ConsumeTicketAsync(ticket, cancellationToken);
            if (result.Hit)
            {
                Interlocked.Increment(ref _consumeHits);
            }

            return result;
        }

        public Task<CacheReadResult<AnonymousCommentTicketPayload>> ReadTicketAsync(
            byte[] ticket,
            CancellationToken cancellationToken = default)
            => inner.ReadTicketAsync(ticket, cancellationToken);
    }

    private sealed class RecordingCacheInvalidationDispatcher : ICacheInvalidationDispatcher
    {
        public ConcurrentQueue<CommentCacheInvalidationScope> Scopes { get; } = [];

        public Task InvalidateArticleMutationAsync(int? articleId = null, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateSeoAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateComplianceAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateSystemPageAsync(string slug, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateCategoryTagAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateCommentPolicyAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateStatsAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateArticleViewAsync(int articleId, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateHotArticlesAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;

        public Task InvalidateCommentMutationAsync(
            CommentCacheInvalidationScope? scope = null,
            CancellationToken cancellationToken = default)
        {
            if (scope is not null)
            {
                Scopes.Enqueue(scope);
            }

            return Task.CompletedTask;
        }
    }

    private sealed class TicketCacheContext(
        ConnectionMultiplexer connection,
        MemoryCache memory,
        PolicyShardedCacheL1Store localStore,
        UnifiedCache cache,
        AnonymousCommentTicketService service,
        PrefixRuntimeKeyScope scope,
        ICachePolicyRegistry policies,
        CachePolicy policy) : IAsyncDisposable
    {
        public ConnectionMultiplexer Connection { get; } = connection;
        public IDatabase Database { get; } = connection.GetDatabase();
        public MemoryCache Memory { get; } = memory;
        public PolicyShardedCacheL1Store LocalStore { get; } = localStore;
        public UnifiedCache Cache { get; } = cache;
        public AnonymousCommentTicketService Service { get; } = service;
        public PrefixRuntimeKeyScope Scope { get; } = scope;
        public ICachePolicyRegistry Policies { get; } = policies;
        public CachePolicy Policy { get; } = policy;
        public string RegistryKey => Scope.PrefixKey(UnifiedCache.BuildRegistryKeyForTests(CachePolicyId.AnonymousCommentTicket));

        public static async Task<TicketCacheContext> CreateAsync(
            PublicHotDeliveryRedisFixture fixture,
            bool warmL1)
        {
            ConnectionMultiplexer connection = await fixture.ConnectAsync();
            var memory = new MemoryCache(new MemoryCacheOptions());
            var scope = new PrefixRuntimeKeyScope($"fsus-ticket-{Guid.NewGuid():N}:");
            ICachePolicyRegistry policies = new AnonymousTicketPolicyRegistry(warmL1);
            Assert.True(policies.TryGet(CachePolicyId.AnonymousCommentTicket, out CachePolicy policy));
            var localStore = new PolicyShardedCacheL1Store(policies, TimeProvider.System);
            var keyResolver = new CacheKeyResolver(
                policies,
                scope,
                NullLogger<CacheKeyResolver>.Instance);
            var cache = new UnifiedCache(
                memory,
                localStore,
                connection,
                policies,
                scope,
                keyResolver,
                new CacheSingleFlightCoordinator(keyResolver),
                new CacheTelemetry(),
                NullLogger<UnifiedCache>.Instance);
            AnonymousCommentTicketService service = AnonymousCommentTicketServiceTests.CreateServiceForCache(
                cache,
                cache,
                cache,
                TimeProvider.System);
            return new TicketCacheContext(connection, memory, localStore, cache, service, scope, policies, policy);
        }

        public string ResolveTicketKey(byte[] ticket)
            => Scope.PrefixKey(Policy.BuildKey(AnonymousCommentTicketService.HashTicket(ticket)));

        public string ResolveTicketIdentity(string key)
            => key[(Scope.Prefix.Length + "fsus:sec:anonymous-comment-ticket:".Length)..];

        public ValueTask DisposeAsync()
        {
            Cache.Dispose();
            Memory.Dispose();
            return Connection.DisposeAsync();
        }
    }

    private sealed class PrefixRuntimeKeyScope(string prefix) : IRuntimeKeyScope
    {
        public string Prefix { get; } = prefix;
        public string ScopeToken => Prefix;
        public string PrefixKey(string key) => string.Concat(Prefix, key);
    }

    private sealed class AnonymousTicketPolicyRegistry(bool warmL1) : ICachePolicyRegistry
    {
        private readonly CachePolicyRegistry _inner = new();

        public bool TryGet(CachePolicyId id, out CachePolicy policy)
        {
            if (!_inner.TryGet(id, out policy))
            {
                return false;
            }

            if (id == CachePolicyId.AnonymousCommentTicket && warmL1)
            {
                policy = policy with
                {
                    L1Ttl = TimeSpan.FromMinutes(1)
                };
            }

            return true;
        }
    }
}
