using System.Collections.Concurrent;
using System.Diagnostics.Metrics;
using System.Net;

using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Security;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>
/// Issue #2040 retains the #3397 client/zero-SQL gates while replacing shed with
/// protected local durable admission. Historical entrypoint names remain covered.
/// </summary>
public sealed class PublicHotReadRiskQueueShedTests
{
    [Fact]
    public async Task SaturatedQueue_PublicReadAndShieldSignals_ShedWithoutSyncSql()
    {
        using RiskQueueHarness harness = CreateHarness(capacity: 1);
        Assert.True(harness.Queue.TryEnqueueOrShed(CreateWrite("queued")));

        await harness.Sink.AddRiskAsync(CreateSignal(harness.Context, SecurityRiskSources.PublicRead, SecurityRiskReason.PublicReadBlocked), CancellationToken.None);
        await harness.Sink.AddRiskAsync(CreateSignal(harness.Context, SecurityRiskSources.AntiCrawler, SecurityRiskReason.BlockedUserAgent), CancellationToken.None);
        await harness.Sink.AddRiskAsync(CreateSignal(harness.Context, "shield", SecurityRiskReason.PublicReadBlocked), CancellationToken.None);

        SecurityRiskEventWriteQueueSnapshot snapshot = harness.Queue.Snapshot();
        Assert.Equal(1, snapshot.QueuedCount);
        Assert.Equal(0, snapshot.ShedCount);
        Assert.Equal(3, snapshot.DurablePendingCount);
        Assert.Equal(4, snapshot.OutstandingCount);
        Assert.Equal(4, Directory.GetFiles(Path.Combine(harness.Root, "security-risk-fallback"), "security-risk-*.json").Length);
        Assert.Equal(0, snapshot.SyncFallbackCount);
        Assert.Equal(SecurityRiskHotPathAdmission.ShedDisposition, snapshot.LastDisposition);
        Assert.Equal(0, harness.Store.AppendCount);
        Assert.Equal("unchanged-hot-path-decision", SecurityRiskHotPathAdmission.ClientOutcome);
        Assert.Equal("durable-pending", SecurityRiskHotPathAdmission.ShedTelemetryResult);
        Assert.Equal("queue-depth,shed-count,sync-fallback-count", SecurityRiskHotPathAdmission.TelemetrySample);
    }

    [Fact]
    public async Task SaturatedQueueStorm_DoesNotOpenSyncSqlOnPublicHotRead()
    {
        using RiskQueueHarness harness = CreateHarness(capacity: 1);
        Assert.True(harness.Queue.TryEnqueueOrShed(CreateWrite("queued")));

        Task[] storm = Enumerable.Range(0, 64)
            .Select(_ => harness.Sink.AddRiskAsync(
                CreateSignal(harness.Context, SecurityRiskSources.PublicRead, SecurityRiskReason.PublicReadBlocked),
                CancellationToken.None).AsTask())
            .ToArray();
        await Task.WhenAll(storm);

        SecurityRiskEventWriteQueueSnapshot snapshot = harness.Queue.Snapshot();
        Assert.Equal(1, snapshot.QueuedCount);
        Assert.Equal(0, snapshot.ShedCount);
        Assert.Equal(64, snapshot.DurablePendingCount);
        Assert.Equal(65, snapshot.OutstandingCount);
        Assert.Equal(65, Directory.GetFiles(Path.Combine(harness.Root, "security-risk-fallback"), "security-risk-*.json").Length);
        Assert.Equal(0, snapshot.SyncFallbackCount);
        Assert.Equal(0, harness.Store.AppendCount);
    }

    [Fact]
    public async Task PublicHotReadSecurityGate_SaturatedQueue_KeepsClientDecisionAndSkipsSql()
    {
        using RiskQueueHarness harness = CreateHarness(capacity: 1);
        Assert.True(harness.Queue.TryEnqueueOrShed(CreateWrite("queued")));
        PublicReadSecurityGate gate = CreateGate(harness.Sink, RiskDecisionKind.Block);
        DefaultHttpContext context = CreateHotContext("198.51.100.77");
        AttachCandidateFeature(context);
        bool nextCalled = false;

        await new PublicHotReadSecurityGateMiddleware(_ =>
        {
            nextCalled = true;
            return Task.CompletedTask;
        }).InvokeAsync(context, gate);

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status429TooManyRequests, context.Response.StatusCode);
        SecurityRiskEventWriteQueueSnapshot snapshot = harness.Queue.Snapshot();
        Assert.Equal(0, snapshot.ShedCount);
        Assert.Equal(1, snapshot.DurablePendingCount);
        Assert.Equal(2, Directory.GetFiles(Path.Combine(harness.Root, "security-risk-fallback"), "security-risk-*.json").Length);
        Assert.Equal(0, snapshot.SyncFallbackCount);
        Assert.Equal(0, harness.Store.AppendCount);
        Assert.Equal("unchanged-hot-path-decision", SecurityRiskHotPathAdmission.ClientOutcome);
    }

    [Fact]
    public void QueueAdmission_EmitsDepthShedAndSyncFallbackMetrics()
    {
        var measurements = new ConcurrentBag<(string Name, double Value)>();
        using var listener = new MeterListener();
        listener.InstrumentPublished = (instrument, meterListener) =>
        {
            if (string.Equals(instrument.Meter.Name, FsusObservability.MeterName, StringComparison.Ordinal)
                && (instrument.Name is "fsus.security.risk_event.queue_depth"
                    or "fsus.security.risk_event.shed.count"
                    or "fsus.security.risk_event.sync_fallback.count"))
            {
                meterListener.EnableMeasurementEvents(instrument);
            }
        };
        listener.SetMeasurementEventCallback<long>((instrument, value, _, _) => measurements.Add((instrument.Name, value)));
        listener.SetMeasurementEventCallback<double>((instrument, value, _, _) => measurements.Add((instrument.Name, value)));
        listener.Start();

        using RiskQueueHarness harness = CreateHarness(capacity: 1);
        SecurityRiskEventWriteQueue queue = harness.Queue;
        Assert.True(queue.TryEnqueueOrShed(CreateWrite("queued")));
        Assert.True(queue.TryEnqueueOrShed(CreateWrite("durable-pending")));

        Assert.Contains(measurements, static item => item.Name == "fsus.security.risk_event.queue_depth" && item.Value >= 1);
        Assert.DoesNotContain(measurements, static item => item.Name == "fsus.security.risk_event.shed.count" && item.Value != 0);
        Assert.DoesNotContain(measurements, static item => item.Name == "fsus.security.risk_event.sync_fallback.count");
        Assert.Equal(0, queue.Snapshot().SyncFallbackCount);
        Assert.Equal(0, harness.Store.AppendCount);
        Assert.Equal(1, queue.Snapshot().DurablePendingCount);
        Assert.Equal(2, Directory.GetFiles(Path.Combine(harness.Root, "security-risk-fallback"), "security-risk-*.json").Length);
    }

    private static RiskQueueHarness CreateHarness(int capacity)
    {
        var store = new CountingRiskStore();
        string root = Path.Combine(OperatingSystem.IsMacOS() ? "/private/tmp" : Path.GetTempPath(),
            "fsusblog-public-risk-issue2040-" + Guid.NewGuid().ToString("N"));
        IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["FSUSBLOG_DATA_ROOT"] = root
        }).Build();
        ServiceProvider provider = new ServiceCollection()
            .AddSingleton(configuration)
            .AddSingleton<IAuditRetentionEpochKeyStore>(new LocalAuditRetentionEpochKeyStore(configuration))
            .AddSingleton<ISecurityRiskEventStore>(store)
            .BuildServiceProvider();
        var queue = new SecurityRiskEventWriteQueue(
            Options.Create(new SecurityRiskEventWriterOptions { Capacity = capacity, BatchSize = 1, FlushWindowMs = 10 }),
            NullLogger<SecurityRiskEventWriteQueue>.Instance,
            provider.GetRequiredService<IServiceScopeFactory>());
        IUnifiedCache cache = Substitute.For<IUnifiedCache>();
        cache.IncrementClampedWithExpiryAsync(
                CachePolicyId.SecurityPowRisk,
                Arg.Any<string>(),
                Arg.Any<long>(),
                Arg.Any<long>(),
                Arg.Any<TimeSpan>(),
                Arg.Any<CancellationToken>())
            .Returns(8L);
        ISecurityAdminPolicyService policy = Substitute.For<ISecurityAdminPolicyService>();
        policy.Current.Returns(CreatePolicySnapshot());
        var hotPath = new CrawlerRiskService(cache, cache, cache, cache, policy, NullLogger<CrawlerRiskService>.Instance);
        var sink = new SecurityRiskEventSink(
            hotPath,
            cache,
            cache,
            policy,
            new SecurityRiskPseudonymizer(1, new byte[32]),
            queue,
            provider.GetRequiredService<IServiceScopeFactory>(),
            NullLogger<SecurityRiskEventSink>.Instance,
            TimeProvider.System);
        return new RiskQueueHarness(queue, sink, store, CreateContext("198.51.100.70"), provider, root);
    }

    private static PublicReadSecurityGate CreateGate(ISecurityRiskSignalSink sink, RiskDecisionKind kind)
    {
        var projection = new PublicHotReadRiskProjection(
            Options.Create(new PublicHotReadRiskProjectionOptions()),
            new SecurityRiskPseudonymizer(1, new byte[32]),
            TimeProvider.System);
        Assert.True(projection.ApplyIdentity(
            "198.51.100.77",
            50,
            DateTimeOffset.UtcNow,
            DateTimeOffset.UtcNow.AddMinutes(10),
            Guid.NewGuid().ToString("N")));
        var reader = Substitute.For<ISecurityRiskScoreReader>();
        reader.GetRiskScoreAsync(Arg.Any<HttpContext>(), Arg.Any<CancellationToken>()).Returns(50);
        ISecurityRiskPolicyProvider policyProvider = Substitute.For<ISecurityRiskPolicyProvider>();
        policyProvider.CurrentRiskPolicy.Returns(CreateRiskPolicy());
        var decision = Substitute.For<IRiskDecisionService>();
        decision.Decide(Arg.Any<RiskControlContext>(), Arg.Any<SecurityRiskPolicy>(), Arg.Any<int>())
            .Returns(new RiskDecision(
                kind,
                RiskActionNames.PublicRead,
                "public.hot-read.html",
                50,
                50,
                1,
                ["security.pow"],
                SecurityRiskPolicyFactory.DefaultPolicyVersion,
                ["unit"]));
        return new PublicReadSecurityGate(
            projection,
            reader,
            sink,
            policyProvider,
            new RiskControlContextFactory(),
            decision,
            NullLogger<PublicReadSecurityGate>.Instance,
            Substitute.For<IPowService>(),
            new AdaptivePowGovernor(Substitute.For<IUnifiedCache>()));
    }

    private static void AttachCandidateFeature(DefaultHttpContext context)
    {
        Assert.True(PublicHotReadFastPath.TryCreateRequestFeatureForTests(context, out PublicHotReadRequestFeature? feature));
        context.Features.Set(Assert.IsType<PublicHotReadRequestFeature>(feature));
    }

    private static DefaultHttpContext CreateHotContext(string ip)
    {
        var context = new DefaultHttpContext
        {
            RequestServices = new ServiceCollection().AddLogging().BuildServiceProvider()
        };
        context.Request.Method = HttpMethods.Get;
        context.Request.Path = "/api/binary/article/42.aeds";
        context.Connection.RemoteIpAddress = IPAddress.Parse(ip);
        context.Response.Body = new MemoryStream();
        return context;
    }

    private static DefaultHttpContext CreateContext(string ip)
    {
        var context = new DefaultHttpContext();
        context.Connection.RemoteIpAddress = IPAddress.Parse(ip);
        context.TraceIdentifier = "trace-hot-read-3397";
        context.Request.Method = HttpMethods.Get;
        context.Request.Path = "/api/binary/article/42.aeds";
        context.Request.Headers.UserAgent = "Mozilla/5.0";
        return context;
    }

    private static SecurityRiskSignal CreateSignal(HttpContext context, string source, SecurityRiskReason reason)
        => new(
            context,
            reason,
            5,
            TimeSpan.FromMinutes(10),
            source,
            RiskActionNames.PublicRead,
            "public_hot_read_shed");

    private static SecurityRiskEventWrite CreateWrite(string id)
        => new(
            id,
            DateTimeOffset.UtcNow,
            SecurityRiskSources.PublicRead,
            nameof(SecurityRiskReason.PublicReadBlocked),
            RiskActionNames.PublicRead,
            5,
            5,
            60,
            DateTimeOffset.UtcNow.AddMinutes(1),
            null,
            "public.hot-read.html",
            null,
            null,
            "/api/binary/article/42.aeds",
            "GET",
            "unit-test",
            "detail",
            "trace-hot-read-3397");

    private static SecurityRiskPolicy CreateRiskPolicy()
    {
        var action = new SecurityRiskActionPolicy(
            RiskActionNames.PublicRead,
            new SecurityRiskActionThresholds(10, 20, 30, 40, 50),
            "security.pow",
            1,
            null,
            AnonymousWriteAllowed: true);
        return new SecurityRiskPolicy(
            "runtime",
            SecurityRiskPolicyFactory.DefaultPolicyVersion,
            DateTimeOffset.UtcNow,
            SecuritySystemModes.Enforce,
            200,
            125,
            null,
            action,
            new Dictionary<string, SecurityRiskActionPolicy>(StringComparer.Ordinal),
            new Dictionary<string, string>(StringComparer.Ordinal));
    }

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

    private sealed record RiskQueueHarness(
        SecurityRiskEventWriteQueue Queue,
        SecurityRiskEventSink Sink,
        CountingRiskStore Store,
        DefaultHttpContext Context,
        ServiceProvider Provider,
        string Root) : IDisposable
    {
        public void Dispose()
        {
            Queue.Dispose();
            Provider.Dispose();
            Directory.Delete(Root, recursive: true);
        }
    }

    private sealed class CountingRiskStore : ISecurityRiskEventStore
    {
        private int _appendCount;

        public int AppendCount => Volatile.Read(ref _appendCount);

        public Task AppendAsync(SecurityRiskEventWrite write, CancellationToken cancellationToken = default)
        {
            Interlocked.Increment(ref _appendCount);
            return Task.CompletedTask;
        }

        public Task AppendBatchAsync(IReadOnlyList<SecurityRiskEventWrite> writes, CancellationToken cancellationToken = default)
        {
            Interlocked.Add(ref _appendCount, writes.Count);
            return Task.CompletedTask;
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
}
