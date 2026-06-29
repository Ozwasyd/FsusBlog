using System.Net;
using System.Security.Claims;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using NSubstitute;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollection))]
public sealed class SecurityRiskEventPersistenceTests(PostgresSchemaMigrationFixture fixture)
{
    private static readonly DateTimeOffset BaselineNow = DateTimeOffset.Parse("2026-06-18T12:00:00Z");

    [Fact]
    public void Migration_CreatesSecurityRiskEventTableWithQueryableDimensions()
    {
        var registry = new SchemaMigrationRegistry();

        ISchemaMigrationDescriptor descriptor = Assert.Single(
            registry.GetDescriptors(),
            static item => item.MigrationId == "20260618-post-security-risk-event-persistence");
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));
        string[] columns = typeof(SecurityRiskEvent)
            .GetProperties()
            .Select(static property => property.Name)
            .ToArray();

        Assert.Equal(SchemaMigrationPhase.PostCodeFirst, descriptor.Phase);
        Assert.Contains("CREATE TABLE IF NOT EXISTS security_risk_event", fingerprint, StringComparison.Ordinal);
        Assert.Contains("source varchar(64) NOT NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("reason varchar(64) NOT NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("action varchar(96) NOT NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("subject_hash varchar(64) NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("client_ip_hash varchar(64) NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("device_fp_hash varchar(64) NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("idx_security_risk_event_source_reason_action", fingerprint, StringComparison.Ordinal);
        Assert.Contains(columns, static column => column == nameof(SecurityRiskEvent.SubjectHash));
        Assert.Contains(columns, static column => column == nameof(SecurityRiskEvent.RouteKey));
        Assert.Contains(columns, static column => column == nameof(SecurityRiskEvent.ClientIpHash));
        Assert.Contains(columns, static column => column == nameof(SecurityRiskEvent.DeviceFpHash));
    }

    [Fact]
    public async Task RiskScoreEngine_AggregatesActiveEventsWithLinearTtlDecay()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateRiskTable(db);
        var clock = new MutableTimeProvider(BaselineNow.AddMinutes(5));
        var store = new SecurityRiskEventStore(db);
        var engine = new RiskScoreEngine(store, clock);
        string subjectHash = SecurityRiskIdentity.HashIdentity("subject-a");
        string routeKey = "auth:login";

        await store.AppendAsync(CreateWrite(subjectHash, routeKey, scoreDelta: 20, occurredAt: BaselineNow, ttl: TimeSpan.FromMinutes(10)));
        await store.AppendAsync(CreateWrite(subjectHash, routeKey, scoreDelta: 100, occurredAt: BaselineNow.AddMinutes(-20), ttl: TimeSpan.FromMinutes(5)));
        await store.AppendAsync(CreateWrite(subjectHash, "comment:42", scoreDelta: 50, occurredAt: BaselineNow, ttl: TimeSpan.FromMinutes(10)));

        SecurityRiskScoreResult result = await engine.ComputeScoreAsync(
            new SecurityRiskScoreQuery(subjectHash, RiskActionNames.AuthLogin, routeKey, null, null),
            CancellationToken.None);

        Assert.Equal(10, result.Score);
        Assert.Equal(BaselineNow.AddMinutes(10), result.ExpiresAtUtc);
    }

    [Fact]
    public async Task RiskEventStore_QueriesBySourceReasonActionAndSubjectHash()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateRiskTable(db);
        var store = new SecurityRiskEventStore(db);
        string subjectHash = SecurityRiskIdentity.HashIdentity("subject-query");

        await store.AppendAsync(CreateWrite(subjectHash, "auth:login", scoreDelta: 7, source: SecurityRiskSources.Auth, reason: SecurityRiskReason.AuthFailureBurst));
        await store.AppendAsync(CreateWrite(SecurityRiskIdentity.HashIdentity("other"), "auth:login", scoreDelta: 7, source: SecurityRiskSources.Auth, reason: SecurityRiskReason.AuthFailureBurst));
        await store.AppendAsync(CreateWrite(subjectHash, "comment:42", scoreDelta: 4, source: SecurityRiskSources.CommentGovernance, reason: SecurityRiskReason.CommentSpamPatternHit));

        IReadOnlyList<SecurityRiskEventRecord> events = await store.QueryAsync(
            new SecurityRiskEventQuery(SecurityRiskSources.Auth, nameof(SecurityRiskReason.AuthFailureBurst), RiskActionNames.AuthLogin, subjectHash, Limit: 10),
            CancellationToken.None);

        SecurityRiskEventRecord item = Assert.Single(events);
        Assert.Equal(SecurityRiskSources.Auth, item.Source);
        Assert.Equal(nameof(SecurityRiskReason.AuthFailureBurst), item.Reason);
        Assert.Equal(RiskActionNames.AuthLogin, item.Action);
        Assert.Equal(subjectHash, item.SubjectHash);
    }

    [Fact]
    public async Task SecurityRiskEventSink_PersistenceFailureDoesNotBreakHotPathAndWritesFallbackLog()
    {
        IUnifiedCache cache = Substitute.For<IUnifiedCache>();
        cache.IncrementClampedWithExpiryAsync(CachePolicyId.SecurityPowRisk, "198.51.100.20", 5, 200, Arg.Any<TimeSpan>(), Arg.Any<CancellationToken>())
            .Returns(8L);
        ISecurityAdminPolicyService policy = Substitute.For<ISecurityAdminPolicyService>();
        policy.Current.Returns(CreatePolicySnapshot());
        var zeroRiskCache = new MemoryCache(new MemoryCacheOptions());
        var hotPath = new CrawlerRiskService(cache, zeroRiskCache, policy, new CapturingLogger<CrawlerRiskService>());
        IServiceProvider services = new ServiceCollection()
            .AddScoped<ISecurityRiskEventStore, ThrowingRiskEventStore>()
            .BuildServiceProvider();
        var logger = new CapturingLogger<SecurityRiskEventSink>();
        var queue = new SecurityRiskEventWriteQueue(
            Options.Create(new SecurityRiskEventWriterOptions { Capacity = 4, BatchSize = 2, FlushWindowMs = 10 }),
            new CapturingLogger<SecurityRiskEventWriteQueue>());
        var sink = new SecurityRiskEventSink(hotPath, cache, policy, queue, services.GetRequiredService<IServiceScopeFactory>(), logger, new MutableTimeProvider(BaselineNow));
        var workerLogger = new CapturingLogger<SecurityRiskEventWriterWorker>();
        var worker = new SecurityRiskEventWriterWorker(
            queue,
            services.GetRequiredService<IServiceScopeFactory>(),
            Options.Create(new SecurityRiskEventWriterOptions { BatchSize = 2, FlushWindowMs = 10 }),
            workerLogger);
        DefaultHttpContext context = CreateContext("198.51.100.20");

        await sink.AddRiskAsync(
            new SecurityRiskSignal(
                context,
                SecurityRiskReason.CaptchaInvalid,
                5,
                TimeSpan.FromMinutes(5),
                SecurityRiskSources.Captcha,
                RiskActionNames.AuthLogin,
                "captcha_invalid"),
            CancellationToken.None);

        policy.Received(1).RecordRiskEvent(Arg.Is<AntiCrawlerRiskEventResponse>(item =>
            item.Source == SecurityRiskSources.Captcha &&
            item.Reason == nameof(SecurityRiskReason.CaptchaInvalid) &&
            item.ScoreDelta == 5 &&
            item.TotalScore == 8));
        Assert.Equal(1, queue.Snapshot().QueuedCount);

        int flushed = await worker.FlushOnceAsync(CancellationToken.None);

        Assert.Equal(1, flushed);
        Assert.Contains(workerLogger.Messages, static message =>
            message.Contains("security-risk-persist-failed", StringComparison.Ordinal) &&
            message.Contains(nameof(SecurityRiskReason.CaptchaInvalid), StringComparison.Ordinal));
    }

    [Fact]
    public async Task SecurityRiskEventSink_AddRiskAsync_EnqueuesPersistenceWithoutAwaitingStore()
    {
        IUnifiedCache cache = Substitute.For<IUnifiedCache>();
        cache.IncrementClampedWithExpiryAsync(CachePolicyId.SecurityPowRisk, "198.51.100.22", 5, 200, Arg.Any<TimeSpan>(), Arg.Any<CancellationToken>())
            .Returns(8L);
        ISecurityAdminPolicyService policy = Substitute.For<ISecurityAdminPolicyService>();
        policy.Current.Returns(CreatePolicySnapshot());
        var zeroRiskCache = new MemoryCache(new MemoryCacheOptions());
        var hotPath = new CrawlerRiskService(cache, zeroRiskCache, policy, new CapturingLogger<CrawlerRiskService>());
        IServiceProvider services = new ServiceCollection()
            .AddScoped<ISecurityRiskEventStore, NeverCompletingRiskEventStore>()
            .BuildServiceProvider();
        NeverCompletingRiskEventStore.AppendStarted = false;
        var queue = new SecurityRiskEventWriteQueue(
            Options.Create(new SecurityRiskEventWriterOptions { Capacity = 4, BatchSize = 2, FlushWindowMs = 10 }),
            new CapturingLogger<SecurityRiskEventWriteQueue>());
        var sink = new SecurityRiskEventSink(
            hotPath,
            cache,
            policy,
            queue,
            services.GetRequiredService<IServiceScopeFactory>(),
            new CapturingLogger<SecurityRiskEventSink>(),
            new MutableTimeProvider(BaselineNow));
        DefaultHttpContext context = CreateContext("198.51.100.22");

        await sink.AddRiskAsync(
            new SecurityRiskSignal(
                context,
                SecurityRiskReason.SecurityChallengeRejected,
                5,
                TimeSpan.FromMinutes(5),
                SecurityRiskSources.RiskControl,
                RiskActionNames.AuthLogin,
                "perception_text_answer_invalid"),
            CancellationToken.None);

        SecurityRiskEventWriteQueueSnapshot snapshot = queue.Snapshot();
        Assert.Equal(1, snapshot.QueuedCount);
        Assert.Equal(0, snapshot.DroppedCount);
        Assert.False(NeverCompletingRiskEventStore.AppendStarted);
    }

    [Fact]
    public void SecurityRiskEventWriter_SourcePersistsFlushWithBatchInsert()
    {
        string writer = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Infrastructure/Security/SecurityRiskEventWriter.cs"));
        string persistence = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Infrastructure/Security/SecurityRiskEventPersistence.cs"));
        string observability = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Infrastructure/Observability/FsusObservability.cs"));
        string persist = ExtractMethodBlock(writer, "internal async Task PersistSafelyAsync");

        Assert.Contains("Task AppendBatchAsync(IReadOnlyList<SecurityRiskEventWrite> writes", persistence, StringComparison.Ordinal);
        Assert.Contains("store.AppendBatchAsync(batch, cancellationToken)", persist, StringComparison.Ordinal);
        Assert.DoesNotContain("foreach (SecurityRiskEventWrite write in batch)", persist, StringComparison.Ordinal);
        Assert.Contains("RetryBatchByHalvesAsync", writer, StringComparison.Ordinal);
        Assert.Contains("RecordSecurityRiskEventBatch", writer, StringComparison.Ordinal);
        Assert.Contains("fsus.security.risk_event.batch_size", observability, StringComparison.Ordinal);
        Assert.Contains("fsus.security.risk_event.flush_elapsed_ms", observability, StringComparison.Ordinal);
        Assert.Contains("fsus.security.risk_event.inserted_rows", observability, StringComparison.Ordinal);
        Assert.Contains("fsus.security.risk_event.failed_batches", observability, StringComparison.Ordinal);
        Assert.Contains("fsus.security.risk_event.fallback_single_inserts", observability, StringComparison.Ordinal);
    }

    [Fact]
    public async Task SecurityRiskEventWriterWorker_FlushOnceAsync_PersistsQueuedRiskEvents()
    {
        var store = new RecordingRiskEventStore();
        await using ServiceProvider provider = new ServiceCollection()
            .AddScoped<ISecurityRiskEventStore>(_ => store)
            .BuildServiceProvider(new ServiceProviderOptions
            {
                ValidateOnBuild = true,
                ValidateScopes = true
            });
        var queue = new SecurityRiskEventWriteQueue(
            Options.Create(new SecurityRiskEventWriterOptions { Capacity = 4, BatchSize = 2, FlushWindowMs = 10 }),
            new CapturingLogger<SecurityRiskEventWriteQueue>());
        var worker = new SecurityRiskEventWriterWorker(
            queue,
            provider.GetRequiredService<IServiceScopeFactory>(),
            Options.Create(new SecurityRiskEventWriterOptions { BatchSize = 2, FlushWindowMs = 10 }),
            new CapturingLogger<SecurityRiskEventWriterWorker>());

        Assert.True(queue.TryWrite(CreateWrite(SecurityRiskIdentity.HashIdentity("subject-1"), "auth:login", 5)));
        Assert.True(queue.TryWrite(CreateWrite(SecurityRiskIdentity.HashIdentity("subject-2"), "auth:login", 7)));

        int flushed = await worker.FlushOnceAsync(CancellationToken.None);

        Assert.Equal(2, flushed);
        Assert.Equal(2, store.Writes.Count);
        Assert.Equal(1, store.BatchAppendCount);
        Assert.Equal(0, store.SingleAppendCount);
        Assert.Equal(0, queue.Snapshot().QueuedCount);
    }

    [Fact]
    public async Task SecurityRiskEventSink_UsesStableAccountSubjectHashInsteadOfUserId()
    {
        var store = new RecordingRiskEventStore();
        await using ServiceProvider provider = new ServiceCollection()
            .AddScoped<ISecurityRiskEventStore>(_ => store)
            .BuildServiceProvider(new ServiceProviderOptions
            {
                ValidateOnBuild = true,
                ValidateScopes = true
            });
        var queue = new SecurityRiskEventWriteQueue(
            Options.Create(new SecurityRiskEventWriterOptions { Capacity = 8, BatchSize = 4, FlushWindowMs = 10 }),
            new CapturingLogger<SecurityRiskEventWriteQueue>());
        var sink = CreateSink(provider, queue, "198.51.100.31");
        DefaultHttpContext first = CreateContext("198.51.100.31");
        first.User = CreatePrincipal(42, StableAccountSubjectHash);
        DefaultHttpContext second = CreateContext("198.51.100.31");
        second.User = CreatePrincipal(314, StableAccountSubjectHash);

        await sink.AddRiskAsync(CreateSignal(first), CancellationToken.None);
        await sink.AddRiskAsync(CreateSignal(second), CancellationToken.None);
        var worker = new SecurityRiskEventWriterWorker(
            queue,
            provider.GetRequiredService<IServiceScopeFactory>(),
            Options.Create(new SecurityRiskEventWriterOptions { BatchSize = 4, FlushWindowMs = 10 }),
            new CapturingLogger<SecurityRiskEventWriterWorker>());

        int flushed = await worker.FlushOnceAsync(CancellationToken.None);

        Assert.Equal(2, flushed);
        Assert.Equal(2, store.Writes.Count);
        string expected = SecurityRiskIdentity.HashIdentity(string.Join(
            ':',
            "account",
            AnonymousIdentityRuntime.AnonymousAccountKind,
            StableAccountSubjectHash));
        Assert.All(store.Writes, write => Assert.Equal(expected, write.SubjectHash));
        Assert.DoesNotContain(store.Writes, write => write.SubjectHash == SecurityRiskIdentity.HashIdentity("42"));
        Assert.DoesNotContain(store.Writes, write => write.SubjectHash == SecurityRiskIdentity.HashIdentity("314"));
    }

    [Fact]
    public async Task SecurityRiskEventSink_MissingAccountSubjectHashFallsBackToClientIpHash()
    {
        var store = new RecordingRiskEventStore();
        await using ServiceProvider provider = new ServiceCollection()
            .AddScoped<ISecurityRiskEventStore>(_ => store)
            .BuildServiceProvider(new ServiceProviderOptions
            {
                ValidateOnBuild = true,
                ValidateScopes = true
            });
        var queue = new SecurityRiskEventWriteQueue(
            Options.Create(new SecurityRiskEventWriterOptions { Capacity = 4, BatchSize = 2, FlushWindowMs = 10 }),
            new CapturingLogger<SecurityRiskEventWriteQueue>());
        var sink = CreateSink(provider, queue, "198.51.100.32");
        DefaultHttpContext context = CreateContext("198.51.100.32");
        context.User = new ClaimsPrincipal(new ClaimsIdentity(
            [
                new Claim(ClaimTypes.NameIdentifier, "42"),
                new Claim("identity_kind", AnonymousIdentityRuntime.AnonymousAccountKind)
            ],
            "test"));

        await sink.AddRiskAsync(CreateSignal(context), CancellationToken.None);
        var worker = new SecurityRiskEventWriterWorker(
            queue,
            provider.GetRequiredService<IServiceScopeFactory>(),
            Options.Create(new SecurityRiskEventWriterOptions { BatchSize = 2, FlushWindowMs = 10 }),
            new CapturingLogger<SecurityRiskEventWriterWorker>());

        int flushed = await worker.FlushOnceAsync(CancellationToken.None);

        Assert.Equal(1, flushed);
        SecurityRiskEventWrite write = Assert.Single(store.Writes);
        Assert.Equal(SecurityRiskIdentity.HashIdentity("198.51.100.32"), write.SubjectHash);
        Assert.Equal(SecurityRiskIdentity.HashIdentity("198.51.100.32"), write.ClientIpHash);
    }

    [Fact]
    public async Task SecurityRiskEventSink_RedisMissFallsBackToPostgresAggregationAndWarmsCache()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateRiskTable(db);
        var clock = new MutableTimeProvider(BaselineNow.AddMinutes(5));
        var store = new SecurityRiskEventStore(db);
        string ipHash = SecurityRiskIdentity.HashIdentity("198.51.100.21");
        await store.AppendAsync(CreateWrite(
            subjectHash: ipHash,
            routeKey: "/api/binary/security/challenge",
            scoreDelta: 20,
            occurredAt: BaselineNow,
            ttl: TimeSpan.FromMinutes(10),
            clientIpHash: ipHash));
        IUnifiedCache cache = Substitute.For<IUnifiedCache>();
        cache.GetStringAsync(CachePolicyId.SecurityPowRisk, "198.51.100.21", Arg.Any<CancellationToken>())
            .Returns((string?)null);
        ISecurityAdminPolicyService policy = Substitute.For<ISecurityAdminPolicyService>();
        policy.Current.Returns(CreatePolicySnapshot());
        using var zeroRiskCache = new MemoryCache(new MemoryCacheOptions());
        var hotPath = new CrawlerRiskService(cache, zeroRiskCache, policy, new CapturingLogger<CrawlerRiskService>());
        IServiceProvider services = new ServiceCollection()
            .AddScoped<ISecurityRiskEventStore>(_ => new SecurityRiskEventStore(db))
            .AddScoped<IRiskScoreEngine, RiskScoreEngine>()
            .AddSingleton<TimeProvider>(clock)
            .BuildServiceProvider();
        var sink = new SecurityRiskEventSink(
            hotPath,
            cache,
            policy,
            new SecurityRiskEventWriteQueue(
                Options.Create(new SecurityRiskEventWriterOptions { Capacity = 4, BatchSize = 2, FlushWindowMs = 10 }),
                new CapturingLogger<SecurityRiskEventWriteQueue>()),
            services.GetRequiredService<IServiceScopeFactory>(),
            new CapturingLogger<SecurityRiskEventSink>(),
            clock);
        DefaultHttpContext context = CreateContext("198.51.100.21");

        int score = await sink.GetRiskScoreAsync(context, CancellationToken.None);

        Assert.Equal(10, score);
        await cache.Received(1).SetStringAsync(
            CachePolicyId.SecurityPowRisk,
            "198.51.100.21",
            "10",
            Arg.Is<TimeSpan?>(ttl => ttl.HasValue && ttl.Value > TimeSpan.Zero),
            Arg.Any<CancellationToken>());
    }

    private static SecurityRiskEventWrite CreateWrite(
        string subjectHash,
        string routeKey,
        int scoreDelta,
        DateTimeOffset? occurredAt = null,
        TimeSpan? ttl = null,
        string source = SecurityRiskSources.RiskControl,
        SecurityRiskReason reason = SecurityRiskReason.SecurityChallengeRejected,
        string? clientIpHash = null)
    {
        DateTimeOffset now = occurredAt ?? BaselineNow;
        TimeSpan effectiveTtl = ttl ?? TimeSpan.FromMinutes(10);
        return new SecurityRiskEventWrite(
            Guid.NewGuid().ToString("N"),
            now,
            source,
            reason.ToString(),
            RiskActionNames.AuthLogin,
            scoreDelta,
            scoreDelta,
            (int)effectiveTtl.TotalSeconds,
            now.Add(effectiveTtl),
            subjectHash,
            routeKey,
            clientIpHash,
            null,
            "/api/binary/security/challenge",
            HttpMethods.Post,
            "unit-test",
            "detail",
            "trace-test");
    }

    private static DefaultHttpContext CreateContext(string ip)
    {
        var context = new DefaultHttpContext();
        context.Connection.RemoteIpAddress = IPAddress.Parse(ip);
        context.TraceIdentifier = "trace-risk";
        context.Request.Method = HttpMethods.Post;
        context.Request.Path = "/api/binary/security/challenge";
        context.Request.Headers.UserAgent = "Mozilla/5.0";
        return context;
    }

    private static SecurityRiskEventSink CreateSink(
        IServiceProvider services,
        SecurityRiskEventWriteQueue queue,
        string clientIp)
    {
        IUnifiedCache cache = Substitute.For<IUnifiedCache>();
        cache.IncrementClampedWithExpiryAsync(CachePolicyId.SecurityPowRisk, clientIp, 5, 200, Arg.Any<TimeSpan>(), Arg.Any<CancellationToken>())
            .Returns(5L);
        ISecurityAdminPolicyService policy = Substitute.For<ISecurityAdminPolicyService>();
        policy.Current.Returns(CreatePolicySnapshot());
        var zeroRiskCache = new MemoryCache(new MemoryCacheOptions());
        var hotPath = new CrawlerRiskService(cache, zeroRiskCache, policy, new CapturingLogger<CrawlerRiskService>());
        return new SecurityRiskEventSink(
            hotPath,
            cache,
            policy,
            queue,
            services.GetRequiredService<IServiceScopeFactory>(),
            new CapturingLogger<SecurityRiskEventSink>(),
            new MutableTimeProvider(BaselineNow));
    }

    private static SecurityRiskSignal CreateSignal(HttpContext context)
        => new(
            context,
            SecurityRiskReason.SecurityChallengeRejected,
            5,
            TimeSpan.FromMinutes(5),
            SecurityRiskSources.RiskControl,
            RiskActionNames.AuthLogin,
            "subject_hash_regression");

    private static ClaimsPrincipal CreatePrincipal(int userId, string accountSubjectHash)
        => new(new ClaimsIdentity(
            [
                new Claim(ClaimTypes.NameIdentifier, userId.ToString()),
                new Claim("identity_kind", AnonymousIdentityRuntime.AnonymousAccountKind),
                new Claim(AnonymousIdentityRuntime.AccountSubjectHashClaim, accountSubjectHash)
            ],
            "test"));

    private Task<SqlSugarClient> CreateDbAsync()
        => PostgresSqlSugarTestClient.CreateAsync(fixture);

    private static void CreateRiskTable(SqlSugarClient db)
        => PostgresSqlSugarTestClient.InitTables(db, typeof(SecurityRiskEvent));

    private static AntiCrawlerPolicySnapshot CreatePolicySnapshot()
        => new(
            "anti:test",
            DateTimeOffset.UnixEpoch,
            "test",
            "unit",
            new AntiCrawlerPolicyOptions(
                SecuritySystemModes.Enforce,
                PublicReadChallengeEnabled: true,
                SearchCrawlerVerificationEnabled: true,
                SocialPreviewGuardEnabled: true,
                RiskScoringEnabled: true,
                EventPersistenceEnabled: true,
                DashboardAggregationEnabled: true,
                CidrAutoUpdateEnabled: false,
                IllegalPathHardAbortEnabled: true,
                RequireChallengeScore: 50,
                BlockScore: 100,
                MaxRiskScore: 200,
                DefaultRiskTtlSeconds: 600,
                ZeroRiskCacheTtlSeconds: 3,
                FixedIpPermitLimit: 100,
                FixedIpQueueLimit: 2,
                VerifiedCrawlerFixedIpPermitLimit: 1000,
                PublicReadPermitLimit: 120,
                PublicReadQueueLimit: 2,
                VerifiedCrawlerPublicReadPermitLimit: 1000,
                SocialPreviewPublicReadPermitLimit: 30,
                ReadProofPermitLimit: 30,
                CidrUpdateIntervalMinutes: 1440,
                CidrInitialDelaySeconds: 0,
                CidrMinUpdateIntervalMinutes: 30,
                GoogleCrawlerRangesUrl: "https://example.invalid/googlebot.json",
                BingCrawlerRangesUrl: "https://example.invalid/bingbot.json",
                SnapshotPath: null,
                SocialPreviewAllowedPathPrefixes: ["/"],
                BlockedUserAgentKeywords: [],
                SecurityChallengeReference: "security.pow"));

    private sealed class ThrowingRiskEventStore : ISecurityRiskEventStore
    {
        public Task AppendAsync(SecurityRiskEventWrite write, CancellationToken cancellationToken = default)
            => throw new InvalidOperationException("store down");

        public Task AppendBatchAsync(IReadOnlyList<SecurityRiskEventWrite> writes, CancellationToken cancellationToken = default)
            => throw new InvalidOperationException("store down");

        public Task<IReadOnlyList<SecurityRiskEventRecord>> QueryAsync(SecurityRiskEventQuery query, CancellationToken cancellationToken = default)
            => Task.FromResult<IReadOnlyList<SecurityRiskEventRecord>>([]);

        public Task<IReadOnlyList<SecurityRiskEventRecord>> ListActiveForScoreAsync(SecurityRiskScoreQuery query, DateTimeOffset now, int limit, CancellationToken cancellationToken = default)
            => Task.FromResult<IReadOnlyList<SecurityRiskEventRecord>>([]);
    }

    private sealed class NeverCompletingRiskEventStore : ISecurityRiskEventStore
    {
        public static bool AppendStarted;

        public Task AppendAsync(SecurityRiskEventWrite write, CancellationToken cancellationToken = default)
        {
            AppendStarted = true;
            return Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
        }

        public Task AppendBatchAsync(IReadOnlyList<SecurityRiskEventWrite> writes, CancellationToken cancellationToken = default)
        {
            AppendStarted = true;
            return Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
        }

        public Task<IReadOnlyList<SecurityRiskEventRecord>> QueryAsync(SecurityRiskEventQuery query, CancellationToken cancellationToken = default)
            => Task.FromResult<IReadOnlyList<SecurityRiskEventRecord>>([]);

        public Task<IReadOnlyList<SecurityRiskEventRecord>> ListActiveForScoreAsync(SecurityRiskScoreQuery query, DateTimeOffset now, int limit, CancellationToken cancellationToken = default)
            => Task.FromResult<IReadOnlyList<SecurityRiskEventRecord>>([]);
    }

    private sealed class RecordingRiskEventStore : ISecurityRiskEventStore
    {
        public List<SecurityRiskEventWrite> Writes { get; } = [];
        public int BatchAppendCount { get; private set; }
        public int SingleAppendCount { get; private set; }

        public Task AppendAsync(SecurityRiskEventWrite write, CancellationToken cancellationToken = default)
        {
            SingleAppendCount++;
            Writes.Add(write);
            return Task.CompletedTask;
        }

        public Task AppendBatchAsync(IReadOnlyList<SecurityRiskEventWrite> writes, CancellationToken cancellationToken = default)
        {
            BatchAppendCount++;
            Writes.AddRange(writes);
            return Task.CompletedTask;
        }

        public Task<IReadOnlyList<SecurityRiskEventRecord>> QueryAsync(SecurityRiskEventQuery query, CancellationToken cancellationToken = default)
            => Task.FromResult<IReadOnlyList<SecurityRiskEventRecord>>([]);

        public Task<IReadOnlyList<SecurityRiskEventRecord>> ListActiveForScoreAsync(SecurityRiskScoreQuery query, DateTimeOffset now, int limit, CancellationToken cancellationToken = default)
            => Task.FromResult<IReadOnlyList<SecurityRiskEventRecord>>([]);
    }

    private sealed class MutableTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow()
            => utcNow;
    }

    private sealed class CapturingLogger<T> : ILogger<T>
    {
        public List<string> Messages { get; } = [];

        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull
            => NullScope.Instance;

        public bool IsEnabled(LogLevel logLevel)
            => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
            => Messages.Add(formatter(state, exception));
    }

    private sealed class NullScope : IDisposable
    {
        public static readonly NullScope Instance = new();

        public void Dispose()
        {
        }
    }

    private static string ExtractMethodBlock(string source, string signature)
    {
        int start = source.IndexOf(signature, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Missing method signature: {signature}");

        int braceStart = source.IndexOf('{', start);
        Assert.True(braceStart >= 0, $"Missing method body: {signature}");

        int depth = 0;
        for (int i = braceStart; i < source.Length; i++)
        {
            if (source[i] == '{')
            {
                depth++;
            }
            else if (source[i] == '}')
            {
                depth--;
                if (depth == 0)
                {
                    return source[start..(i + 1)];
                }
            }
        }

        throw new InvalidOperationException($"Unable to extract method body: {signature}");
    }

    private const string StableAccountSubjectHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
}
