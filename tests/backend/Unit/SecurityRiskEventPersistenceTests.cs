using System.Net;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Diagnostics.Metrics;
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
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class SecurityRiskEventPersistenceTests(PostgresSchemaMigrationFixture fixture)
{
    private static readonly DateTimeOffset BaselineNow = DateTimeOffset.Parse("2026-06-18T12:00:00Z");
    private static readonly byte[] PseudonymKey = Enumerable.Range(1, 32).Select(static value => (byte)value).ToArray();
    private static readonly byte[] PreviousPseudonymKey = Enumerable.Range(33, 32).Select(static value => (byte)value).ToArray();

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
    public void Migration_AddsPseudonymEpochAndPurgesUnkeyedIdentityHistory()
    {
        var registry = new SchemaMigrationRegistry();

        ISchemaMigrationDescriptor descriptor = Assert.Single(
            registry.GetDescriptors(),
            static item => item.MigrationId == "20260715-post-security-risk-pseudonym-epoch");
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Equal(SchemaMigrationPhase.PostCodeFirst, descriptor.Phase);
        Assert.Contains("pseudonym_epoch", fingerprint, StringComparison.Ordinal);
        Assert.Contains("DELETE FROM security_risk_event", fingerprint, StringComparison.Ordinal);
        Assert.Contains("SET path = NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("idx_security_risk_event_epoch", fingerprint, StringComparison.Ordinal);
    }

    [Fact]
    public async Task RiskScoreEngine_AggregatesActiveEventsWithLinearTtlDecay()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateRiskTable(db);
        var clock = new MutableTimeProvider(BaselineNow.AddMinutes(5));
        var store = new SecurityRiskEventStore(db);
        var engine = new RiskScoreEngine(store, clock);
        string subjectHash = Pseudonymize(SecurityRiskIdentityDomain.AccountSubject, "subject-a").Hash;
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
        string subjectHash = Pseudonymize(SecurityRiskIdentityDomain.AccountSubject, "subject-query").Hash;

        await store.AppendAsync(CreateWrite(subjectHash, "auth:login", scoreDelta: 7, source: SecurityRiskSources.Auth, reason: SecurityRiskReason.AuthFailureBurst));
        await store.AppendAsync(CreateWrite(Pseudonymize(SecurityRiskIdentityDomain.AccountSubject, "other").Hash, "auth:login", scoreDelta: 7, source: SecurityRiskSources.Auth, reason: SecurityRiskReason.AuthFailureBurst));
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
    public async Task RiskEventStore_PersistsKeyedClientIpPseudonymInsteadOfRawSha256()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateRiskTable(db);
        var store = new SecurityRiskEventStore(db);
        const string rawIp = "198.51.100.77";
        SecurityRiskPseudonym client = Pseudonymize(SecurityRiskIdentityDomain.ClientIp, rawIp);
        string rawSha256 = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(rawIp)));

        await store.AppendAsync(CreateWrite(
            Pseudonymize(SecurityRiskIdentityDomain.AccountSubject, "account-77").Hash,
            "auth:login",
            scoreDelta: 7,
            clientIpHash: client.Hash));

        SecurityRiskEventRecord stored = Assert.Single(await store.QueryAsync(new SecurityRiskEventQuery(Limit: 10)));
        Assert.Equal(client.Hash, stored.ClientIpHash);
        Assert.Equal(client.Epoch, stored.PseudonymEpoch);
        Assert.NotEqual(rawSha256, stored.ClientIpHash);
        Assert.Null(stored.Path);
        Assert.Null(stored.UserAgent);
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
        var sink = new SecurityRiskEventSink(hotPath, cache, policy, CreatePseudonymizer(), queue, services.GetRequiredService<IServiceScopeFactory>(), logger, new MutableTimeProvider(BaselineNow));
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
            CreatePseudonymizer(),
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
    public async Task SecurityRiskEventWriter_PersistsBatchesRetriesByHalvesAndEmitsRuntimeMetrics()
    {
        var measurements = new List<(string Name, double Value)>();
        using var listener = new MeterListener();
        listener.InstrumentPublished = (instrument, meterListener) =>
        {
            if (instrument.Name.StartsWith("fsus.security.risk_event.", StringComparison.Ordinal))
            {
                meterListener.EnableMeasurementEvents(instrument);
            }
        };
        listener.SetMeasurementEventCallback<long>((instrument, value, _, _) => measurements.Add((instrument.Name, value)));
        listener.SetMeasurementEventCallback<double>((instrument, value, _, _) => measurements.Add((instrument.Name, value)));
        listener.Start();

        var store = new BatchFailingRiskEventStore();
        await using ServiceProvider provider = new ServiceCollection()
            .AddScoped<ISecurityRiskEventStore>(_ => store)
            .BuildServiceProvider(new ServiceProviderOptions { ValidateOnBuild = true, ValidateScopes = true });
        var queue = new SecurityRiskEventWriteQueue(
            Options.Create(new SecurityRiskEventWriterOptions { Capacity = 8, BatchSize = 3, FlushWindowMs = 10 }),
            new CapturingLogger<SecurityRiskEventWriteQueue>());
        var worker = new SecurityRiskEventWriterWorker(
            queue,
            provider.GetRequiredService<IServiceScopeFactory>(),
            Options.Create(new SecurityRiskEventWriterOptions { BatchSize = 3, FlushWindowMs = 10 }),
            new CapturingLogger<SecurityRiskEventWriterWorker>());
        Assert.True(queue.TryWrite(CreateWrite(Pseudonymize(SecurityRiskIdentityDomain.AccountSubject, "batch-1").Hash, "auth:login", 1)));
        Assert.True(queue.TryWrite(CreateWrite(Pseudonymize(SecurityRiskIdentityDomain.AccountSubject, "batch-2").Hash, "auth:login", 2)));
        Assert.True(queue.TryWrite(CreateWrite(Pseudonymize(SecurityRiskIdentityDomain.AccountSubject, "batch-3").Hash, "auth:login", 3)));

        int flushed = await worker.FlushOnceAsync(CancellationToken.None);

        Assert.Equal(3, flushed);
        Assert.Equal(3, store.SingleWrites.Count);
        Assert.True(store.BatchAppendCount > 1);
        Assert.NotNull(typeof(ISecurityRiskEventStore).GetMethod(nameof(ISecurityRiskEventStore.AppendBatchAsync)));
        Assert.Contains(measurements, static item => item is ("fsus.security.risk_event.batch_size", 3));
        Assert.Contains(measurements, static item => item.Name == "fsus.security.risk_event.flush_elapsed_ms" && item.Value >= 0);
        Assert.Contains(measurements, static item => item is ("fsus.security.risk_event.inserted_rows", 3));
        Assert.Contains(measurements, static item => item.Name == "fsus.security.risk_event.failed_batches" && item.Value >= 1);
        Assert.Contains(measurements, static item => item is ("fsus.security.risk_event.fallback_single_inserts", 3));
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

        Assert.True(queue.TryWrite(CreateWrite(Pseudonymize(SecurityRiskIdentityDomain.AccountSubject, "subject-1").Hash, "auth:login", 5)));
        Assert.True(queue.TryWrite(CreateWrite(Pseudonymize(SecurityRiskIdentityDomain.AccountSubject, "subject-2").Hash, "auth:login", 7)));

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
        string expected = Pseudonymize(
            SecurityRiskIdentityDomain.AccountSubject,
            string.Join('\0', AnonymousIdentityRuntime.AnonymousAccountKind, StableAccountSubjectHash)).Hash;
        Assert.All(store.Writes, write => Assert.Equal(expected, write.SubjectHash));
        Assert.All(store.Writes, write => Assert.Equal(1, write.PseudonymEpoch));
    }

    [Fact]
    public async Task SecurityRiskEventSink_MissingAccountSubjectHashDoesNotCrossIdentityDomains()
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
        Assert.Null(write.SubjectHash);
        Assert.Equal(Pseudonymize(SecurityRiskIdentityDomain.ClientIp, "198.51.100.32").Hash, write.ClientIpHash);
        Assert.Equal(1, write.PseudonymEpoch);
        Assert.Null(write.Path);
        Assert.Null(write.UserAgent);
    }

    [Fact]
    public async Task SecurityRiskEventSink_RedisMissFallsBackToPostgresAggregationAndWarmsCache()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateRiskTable(db);
        var clock = new MutableTimeProvider(BaselineNow.AddMinutes(5));
        var store = new SecurityRiskEventStore(db);
        var rotatingPseudonymizer = new SecurityRiskPseudonymizer(
            2,
            PseudonymKey,
            previousEpoch: 1,
            previousKey: PreviousPseudonymKey,
            previousAcceptUntilUtc: BaselineNow.AddDays(1),
            timeProvider: clock);
        string currentIpHash = rotatingPseudonymizer.PseudonymizeCurrent(
            SecurityRiskIdentityDomain.ClientIp,
            "198.51.100.21").Hash;
        string previousIpHash = new SecurityRiskPseudonymizer(1, PreviousPseudonymKey)
            .PseudonymizeCurrent(SecurityRiskIdentityDomain.ClientIp, "198.51.100.21").Hash;
        await store.AppendAsync(CreateWrite(
            subjectHash: currentIpHash,
            routeKey: "/api/binary/security/challenge",
            scoreDelta: 12,
            occurredAt: BaselineNow,
            ttl: TimeSpan.FromMinutes(10),
            clientIpHash: currentIpHash,
            pseudonymEpoch: 2));
        await store.AppendAsync(CreateWrite(
            subjectHash: previousIpHash,
            routeKey: "/api/binary/security/challenge",
            scoreDelta: 8,
            occurredAt: BaselineNow,
            ttl: TimeSpan.FromMinutes(10),
            clientIpHash: previousIpHash,
            pseudonymEpoch: 1));
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
            rotatingPseudonymizer,
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
        string? clientIpHash = null,
        int pseudonymEpoch = 1)
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
            "trace-test",
            pseudonymEpoch);
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
            CreatePseudonymizer(),
            queue,
            services.GetRequiredService<IServiceScopeFactory>(),
            new CapturingLogger<SecurityRiskEventSink>(),
            new MutableTimeProvider(BaselineNow));
    }

    private static SecurityRiskPseudonymizer CreatePseudonymizer()
        => new(1, PseudonymKey, timeProvider: new MutableTimeProvider(BaselineNow));

    private static SecurityRiskPseudonym Pseudonymize(SecurityRiskIdentityDomain domain, string value)
        => CreatePseudonymizer().PseudonymizeCurrent(domain, value);

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

    private sealed class BatchFailingRiskEventStore : ISecurityRiskEventStore
    {
        public List<SecurityRiskEventWrite> SingleWrites { get; } = [];
        public int BatchAppendCount { get; private set; }

        public Task AppendAsync(SecurityRiskEventWrite write, CancellationToken cancellationToken = default)
        {
            SingleWrites.Add(write);
            return Task.CompletedTask;
        }

        public Task AppendBatchAsync(IReadOnlyList<SecurityRiskEventWrite> writes, CancellationToken cancellationToken = default)
        {
            BatchAppendCount++;
            throw new InvalidOperationException("force recursive batch fallback");
        }

        public Task<IReadOnlyList<SecurityRiskEventRecord>> QueryAsync(SecurityRiskEventQuery query, CancellationToken cancellationToken = default)
            => Task.FromResult<IReadOnlyList<SecurityRiskEventRecord>>([]);

        public Task<IReadOnlyList<SecurityRiskEventRecord>> ListActiveForScoreAsync(
            SecurityRiskScoreQuery query,
            DateTimeOffset now,
            int limit,
            CancellationToken cancellationToken = default)
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

    private const string StableAccountSubjectHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
}
