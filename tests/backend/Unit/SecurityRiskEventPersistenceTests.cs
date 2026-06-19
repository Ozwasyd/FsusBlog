using System.Net;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Security;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using NSubstitute;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class SecurityRiskEventPersistenceTests
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
        using SqlSugarClient db = CreateDb();
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
        using SqlSugarClient db = CreateDb();
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
        cache.GetStringAsync(CachePolicyId.SecurityPowRisk, "198.51.100.20", Arg.Any<CancellationToken>())
            .Returns("3");
        ISecurityAdminPolicyService policy = Substitute.For<ISecurityAdminPolicyService>();
        policy.Current.Returns(CreatePolicySnapshot());
        using var zeroRiskCache = new MemoryCache(new MemoryCacheOptions());
        var hotPath = new CrawlerRiskService(cache, zeroRiskCache, policy, new CapturingLogger<CrawlerRiskService>());
        IServiceProvider services = new ServiceCollection()
            .AddScoped<ISecurityRiskEventStore, ThrowingRiskEventStore>()
            .BuildServiceProvider();
        var logger = new CapturingLogger<SecurityRiskEventSink>();
        var sink = new SecurityRiskEventSink(hotPath, cache, policy, services.GetRequiredService<IServiceScopeFactory>(), logger, new MutableTimeProvider(BaselineNow));
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
        Assert.Contains(logger.Messages, static message =>
            message.Contains("security-risk-persist-failed", StringComparison.Ordinal) &&
            message.Contains(nameof(SecurityRiskReason.CaptchaInvalid), StringComparison.Ordinal));
    }

    [Fact]
    public async Task SecurityRiskEventSink_RedisMissFallsBackToPostgresAggregationAndWarmsCache()
    {
        using SqlSugarClient db = CreateDb();
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

    private static SqlSugarClient CreateDb()
        => new(new ConnectionConfig
        {
            DbType = DbType.Sqlite,
            ConnectionString = $"Data Source={Path.Combine(Path.GetTempPath(), $"fsus-security-risk-event-{Guid.NewGuid():N}.db")}",
            InitKeyType = InitKeyType.Attribute,
            IsAutoCloseConnection = true
        });

    private static void CreateRiskTable(SqlSugarClient db)
        => db.Ado.ExecuteCommand("""
            CREATE TABLE IF NOT EXISTS security_risk_event (
                id TEXT PRIMARY KEY,
                occurred_at_utc TEXT NOT NULL,
                source TEXT NOT NULL,
                reason TEXT NOT NULL,
                action TEXT NOT NULL,
                score_delta INTEGER NOT NULL,
                total_score INTEGER NOT NULL,
                ttl_seconds INTEGER NOT NULL,
                expires_at_utc TEXT NOT NULL,
                subject_hash TEXT NULL,
                route_key TEXT NULL,
                client_ip_hash TEXT NULL,
                device_fp_hash TEXT NULL,
                path TEXT NULL,
                method TEXT NULL,
                user_agent TEXT NULL,
                detail TEXT NULL,
                trace_id TEXT NULL
            );
            """);

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
}
