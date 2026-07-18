using System.Collections;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Reflection;
using System.Runtime.CompilerServices;

using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Server.Tests.Unit;

using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Options;
namespace FsusBlog.Server.Tests;

public sealed class ObservabilityTests
{
    [Fact]
    public void StartActivity_IsLazyAndHonorsListenerSampling()
    {
        MethodInfo start = typeof(FsusObservability).GetMethod(nameof(FsusObservability.StartActivity))!;
        Assert.Contains(ReadCalledMethods(start), static method => method.Name == nameof(ActivitySource.HasListeners));

        using (var dropListener = new ActivityListener
        {
            ShouldListenTo = static source => source.Name == FsusObservability.ActivitySourceName,
            Sample = static (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.None
        })
        {
            ActivitySource.AddActivityListener(dropListener);
            Assert.Null(FsusObservability.StartActivity("cache.get", "cache", ActivityKind.Client));
        }

        using var sampledListener = new ActivityListener
        {
            ShouldListenTo = static source => source.Name == FsusObservability.ActivitySourceName,
            Sample = static (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllData
        };
        ActivitySource.AddActivityListener(sampledListener);
        using Activity? activity = FsusObservability.StartActivity("cache.get", "cache", ActivityKind.Client);
        Assert.NotNull(activity);
        Assert.Equal("cache", activity.GetTagItem("fsus.component"));
        Assert.Equal("cache.get", activity.GetTagItem("fsus.operation"));
    }

    [Fact]
    public void CacheMetrics_PrecacheTagsAndStripeL1HitsWhileKeepingMissesExact()
    {
        const string Policy = "ArticleHotFrame";
        long hitBefore = FsusObservability.GetCacheOperationCounters()
            .Where(counter => counter.Operation == "get_raw_readonly" && counter.Policy == Policy && counter.Layer == "l1" && counter.Result == "hit")
            .Sum(static counter => counter.Count);
        long missBefore = FsusObservability.GetCacheOperationCounters()
            .Where(counter => counter.Operation == "get_raw_readonly" && counter.Policy == Policy && counter.Layer == "l2" && counter.Result == "miss")
            .Sum(static counter => counter.Count);

        Parallel.For(0, 1024, _ => FsusObservability.RecordCacheOperation("get_raw_readonly", Policy, "l1", "hit", TimeSpan.Zero));
        FsusObservability.RecordCacheOperation("get_raw_readonly", Policy, "l2", "miss", TimeSpan.Zero);

        IReadOnlyList<CacheOperationRuntimeCounter> counters = FsusObservability.GetCacheOperationCounters();
        Assert.Equal(hitBefore + 1024, counters.Single(counter => counter.Operation == "get_raw_readonly" && counter.Policy == Policy && counter.Layer == "l1" && counter.Result == "hit").Count);
        Assert.Equal(missBefore + 1, counters.Single(counter => counter.Operation == "get_raw_readonly" && counter.Policy == Policy && counter.Layer == "l2" && counter.Result == "miss").Count);
        Assert.Equal("striped", FsusObservability.CacheL1CounterMode);
    }

    [Theory]
    [InlineData("/api/binary/article/list/home/1/10.aeds", "binary")]
    [InlineData("/api/notifications/stream", "notification-stream")]
    [InlineData("/api/author/analytics", "api")]
    [InlineData("/health/ready", "health")]
    [InlineData("/search/index.bin", "static")]
    [InlineData("/article/42", "public")]
    public void ClassifyRoute_MapsRuntimeSurfacesWithoutRawPathTags(string path, string expected)
    {
        Assert.Equal(expected, FsusObservability.ClassifyRoute(path));
    }

    [Fact]
    public void ResolveRouteKind_UsesEndpointMetadataBeforePathClassification()
    {
        var context = new DefaultHttpContext();
        context.Request.Path = "/api/binary/article/list/home/1/10.aeds";
        context.SetEndpoint(new Endpoint(
            _ => Task.CompletedTask,
            new EndpointMetadataCollection(new FsusRouteKindMetadata("public")),
            "metadata-route"));

        Assert.Equal("public", FsusObservability.ResolveRouteKind(context));
    }

    [Fact]
    public void CustomAttributes_DoNotExposePiiOrRequestBodies()
    {
        string[] forbiddenFragments =
        [
            "authorization",
            "body",
            "clientip",
            "cookie",
            "email",
            "password",
            "token",
            "user.id",
            "username"
        ];

        foreach (string attribute in FsusObservability.CustomAttributeNames)
        {
            string normalized = attribute.Replace("_", ".", StringComparison.Ordinal).ToLowerInvariant();
            Assert.DoesNotContain(forbiddenFragments, fragment => normalized.Contains(fragment, StringComparison.Ordinal));
        }
    }

    [Fact]
    public void RiskControlMetrics_EmitNamedMeasurements()
    {
        var measurements = new System.Collections.Concurrent.ConcurrentBag<string>();
        using var listener = new MeterListener();
        listener.InstrumentPublished = (instrument, meterListener) =>
        {
            if (string.Equals(instrument.Meter.Name, FsusObservability.MeterName, StringComparison.Ordinal)
                && instrument.Name.StartsWith("fsus.security.", StringComparison.Ordinal))
            {
                meterListener.EnableMeasurementEvents(instrument);
            }
        };
        listener.SetMeasurementEventCallback<long>((instrument, _, _, _) => measurements.Add(instrument.Name));
        listener.SetMeasurementEventCallback<double>((instrument, _, _, _) => measurements.Add(instrument.Name));
        listener.Start();

        FsusObservability.RecordSecurityRiskEvent("risk-control", "RateLimited", "public.read", "received");
        FsusObservability.RecordSecurityChallengeIssued("sha256PowV1", "public.read", "risk-policy-v2");
        FsusObservability.RecordSecurityChallengeVerified("sha256PowV1", "public.read", "risk-policy-v2", TimeSpan.FromSeconds(2));
        FsusObservability.RecordSecurityChallengeFailed("sha256PowV1", "public.read", "proof_invalid", "risk-policy-v2");
        FsusObservability.RecordSecurityChallengeReplayed("sha256PowV1", "public.read", "proof_replayed", "risk-policy-v2");
        FsusObservability.RecordSecurityDecision(new RiskDecision(
            RiskDecisionKind.Block,
            "public.read",
            "/article/42",
            100,
            100,
            0,
            [],
            "risk-policy-v2",
            ["blocked"]));
        listener.RecordObservableInstruments();

        Assert.Contains("fsus.security.risk.event.count", measurements);
        Assert.Contains("fsus.security.challenge.issued.count", measurements);
        Assert.Contains("fsus.security.challenge.verified.count", measurements);
        Assert.Contains("fsus.security.challenge.failed.count", measurements);
        Assert.Contains("fsus.security.challenge.replayed.count", measurements);
        Assert.Contains("fsus.security.challenge.solve.duration", measurements);
        Assert.Contains("fsus.security.decision.count", measurements);
        Assert.Contains("fsus.security.policy.version.active", measurements);
    }

    [Fact]
    public void RiskControlMetrics_DoNotPropagateListenerFailures()
    {
        using var listener = new MeterListener();
        listener.InstrumentPublished = (instrument, meterListener) =>
        {
            if (string.Equals(instrument.Meter.Name, FsusObservability.MeterName, StringComparison.Ordinal)
                && string.Equals(instrument.Name, "fsus.security.challenge.issued.count", StringComparison.Ordinal))
            {
                meterListener.EnableMeasurementEvents(instrument);
            }
        };
        listener.SetMeasurementEventCallback<long>((_, _, _, _) => throw new InvalidOperationException("collector failed"));
        listener.Start();

        Exception? exception = Record.Exception(() =>
            FsusObservability.RecordSecurityChallengeIssued("sha256PowV1", "public.read", "risk-policy-v2"));

        Assert.Null(exception);
    }

    [Fact]
    public void SecurityEventMetrics_UseHotTagCacheAndEnumOverload()
    {
        Type observability = typeof(FsusObservability);
        FieldInfo limit = observability.GetField("SecurityEventTagCacheLimit", BindingFlags.NonPublic | BindingFlags.Static)!;
        FieldInfo cacheField = observability.GetField("s_securityEventTagCache", BindingFlags.NonPublic | BindingFlags.Static)!;
        object cache = cacheField.GetValue(null)!;
        PropertyInfo countProperty = cache.GetType().GetProperty(nameof(ICollection.Count))!;
        int initialCount = (int)countProperty.GetValue(cache)!;

        Assert.Equal(256, limit.GetRawConstantValue());
        Assert.True(initialCount > 0);
        Assert.Equal(typeof(ConcurrentDictionary<,>), cache.GetType().GetGenericTypeDefinition());
        Assert.NotNull(observability.GetField("s_securityRiskReasonNames", BindingFlags.NonPublic | BindingFlags.Static));
        MethodInfo enumOverload = observability.GetMethod(
            nameof(FsusObservability.RecordSecurityEvent),
            [typeof(string), typeof(SecurityRiskReason), typeof(string)])!;
        Assert.NotNull(enumOverload);

        FsusObservability.RecordSecurityEvent("security_risk", SecurityRiskReason.UnknownBot, "rejected");
        int afterFirst = (int)countProperty.GetValue(cache)!;
        FsusObservability.RecordSecurityEvent("security_risk", SecurityRiskReason.UnknownBot, "rejected");
        int afterSecond = (int)countProperty.GetValue(cache)!;
        Assert.Equal(afterFirst, afterSecond);
        Assert.InRange(afterSecond, 1, 256);

        MethodInfo keyFactory = observability.GetMethod("CreateSecurityEventTagCacheKey", BindingFlags.NonPublic | BindingFlags.Static)!;
        Assert.Contains(ReadCalledMethods(keyFactory), static method => method.Name == "InternSecurityEventValue");
        MethodInfo internValue = observability.GetMethod("InternSecurityEventValue", BindingFlags.NonPublic | BindingFlags.Static)!;
        Assert.Contains(ReadCalledMethods(internValue), static method =>
            method.DeclaringType == typeof(string) && method.Name == nameof(string.Intern));
        string signalHandler = RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
            typeof(CrawlerRiskService),
            nameof(FsusObservability.RecordSecurityEvent),
            nameof(SecurityRiskReason));
        Assert.Contains(nameof(FsusObservability.RecordSecurityEvent), signalHandler, StringComparison.Ordinal);
    }

    [Fact]
    public void SecurityEventMetrics_EmitTagCacheMeasurements()
    {
        var measurements = new System.Collections.Concurrent.ConcurrentBag<string>();
        using var listener = new MeterListener();
        listener.InstrumentPublished = (instrument, meterListener) =>
        {
            if (string.Equals(instrument.Meter.Name, FsusObservability.MeterName, StringComparison.Ordinal)
                && instrument.Name.StartsWith("fsus.observability.", StringComparison.Ordinal))
            {
                meterListener.EnableMeasurementEvents(instrument);
            }
        };
        listener.SetMeasurementEventCallback<long>((instrument, _, _, _) => measurements.Add(instrument.Name));
        listener.SetMeasurementEventCallback<double>((instrument, _, _, _) => measurements.Add(instrument.Name));
        listener.Start();

        FsusObservability.RecordSecurityEvent("shield_reject", "unknown_bot", "rejected");
        FsusObservability.RecordSecurityEvent("shield_reject", SecurityRiskReason.UnknownBot, "rejected");
        listener.RecordObservableInstruments();

        Assert.Contains("fsus.observability.tag_cache.hit_ratio", measurements);
        Assert.Contains("fsus.observability.tag_cache.miss_count", measurements);
        Assert.Contains("fsus.observability.record_security_event.elapsed", measurements);
    }

    [Fact]
    public void ObservabilityHotPaths_UseRouteCacheRingBuffersAndInlinedTryRecord()
    {
        Type observability = typeof(FsusObservability);
        FieldInfo routeCacheField = observability.GetField("s_routeKindCache", BindingFlags.NonPublic | BindingFlags.Static)!;
        var routeCache = Assert.IsType<ConcurrentDictionary<string, string>>(routeCacheField.GetValue(null));
        const string Route = "/runtime-cache-probe/42";
        routeCache.TryRemove(Route, out _);

        string first = FsusObservability.ClassifyRoute(Route);
        int countAfterFirst = routeCache.Count;
        string second = FsusObservability.ClassifyRoute(Route);

        Assert.Equal("public", first);
        Assert.Same(first, second);
        Assert.Equal(countAfterFirst, routeCache.Count);
        Assert.Equal("public", routeCache[Route]);
        MethodInfo classify = observability.GetMethod(nameof(FsusObservability.ClassifyRoute), [typeof(PathString)])!;
        Assert.Contains(ReadCalledMethods(classify), static method => method.Name == "GetOrAdd");
        MethodInfo classifyCore = observability.GetMethod("ClassifyRouteCore", BindingFlags.NonPublic | BindingFlags.Static)!;
        Assert.Contains(ReadCalledMethods(classifyCore), static method =>
            method.DeclaringType == typeof(string) && method.Name == nameof(string.StartsWith));

        FieldInfo issueSamples = observability.GetField("s_securityChallengeV2IssueSamples", BindingFlags.NonPublic | BindingFlags.Static)!;
        FieldInfo payloadSamples = observability.GetField("s_securityChallengeV2PayloadSamples", BindingFlags.NonPublic | BindingFlags.Static)!;
        Assert.Contains("SlidingWindow", issueSamples.FieldType.Name, StringComparison.Ordinal);
        Assert.Contains("SlidingWindow", payloadSamples.FieldType.Name, StringComparison.Ordinal);
        Type slidingWindow = issueSamples.FieldType.GetGenericTypeDefinition();
        Assert.Equal(typeof(double[]), issueSamples.FieldType.GetField("_buffer", BindingFlags.NonPublic | BindingFlags.Instance)!.FieldType);
        Assert.Equal(typeof(int), slidingWindow.GetField("_writeIndex", BindingFlags.NonPublic | BindingFlags.Instance)!.FieldType);
        Assert.DoesNotContain(observability.GetFields(BindingFlags.NonPublic | BindingFlags.Static), static field =>
            field.FieldType.IsGenericType && field.FieldType.GetGenericTypeDefinition() == typeof(ConcurrentQueue<>));

        MethodInfo addSample = observability.GetMethods(BindingFlags.NonPublic | BindingFlags.Static)
            .Single(static method => method.Name == "AddBoundedSample"
                && method.GetParameters()[0].ParameterType.GenericTypeArguments[0] == typeof(double));
        Assert.Contains(ReadCalledMethods(addSample), static method => method.Name == "Add");
        MethodInfo tryRecord = observability.GetMethod("TryRecord", BindingFlags.NonPublic | BindingFlags.Static)!;
        Assert.True(tryRecord.GetMethodImplementationFlags().HasFlag(MethodImplAttributes.AggressiveInlining));
    }

    [Fact]
    public void PerceptionChallengeV2Metrics_EmitNamedMeasurementsAndBudgetWarnings()
    {
        FsusObservability.ResetSecurityChallengeV2RuntimeMetricsForTests();
        var measurements = new List<string>();
        using var listener = new MeterListener();
        listener.InstrumentPublished = (instrument, meterListener) =>
        {
            if (string.Equals(instrument.Meter.Name, FsusObservability.MeterName, StringComparison.Ordinal)
                && instrument.Name.StartsWith("fsus.security.challenge.v2.", StringComparison.Ordinal))
            {
                meterListener.EnableMeasurementEvents(instrument);
            }
        };
        listener.SetMeasurementEventCallback<long>((instrument, _, _, _) => measurements.Add(instrument.Name));
        listener.SetMeasurementEventCallback<double>((instrument, _, _, _) => measurements.Add(instrument.Name));
        listener.Start();

        FsusObservability.RecordSecurityChallengeV2Issued(
            "perceptionTextTaskV2",
            "comment.create",
            "risk-policy-v2",
            "character",
            payloadBytes: 9_200,
            issueDuration: TimeSpan.FromMilliseconds(140));
        FsusObservability.RecordSecurityChallengeV2Verified(
            "perceptionTextTaskV2",
            "comment.create",
            "risk-policy-v2",
            "character",
            payloadBytes: 9_200,
            verifyDuration: TimeSpan.FromMilliseconds(80),
            solveDuration: TimeSpan.FromMilliseconds(2_400));
        FsusObservability.RecordSecurityChallengeV2Failed(
            "perceptionTextTaskV2",
            "comment.create",
            "perception_payload_invalid",
            "risk-policy-v2",
            "character",
            payloadBytes: 9_200,
            verifyDuration: TimeSpan.FromMilliseconds(85),
            solveDuration: TimeSpan.FromMilliseconds(2_400));
        FsusObservability.RecordSecurityChallengeV2Replayed(
            "perceptionTextTaskV2",
            "comment.create",
            "perception_replayed",
            "risk-policy-v2",
            "character",
            payloadBytes: 9_200,
            verifyDuration: TimeSpan.FromMilliseconds(90),
            solveDuration: TimeSpan.FromMilliseconds(2_400));
        FsusObservability.RecordSecurityChallengeV2ClientRender("character", TimeSpan.FromMilliseconds(75));

        SecurityChallengeV2PerformanceBudgetSnapshot snapshot =
            FsusObservability.CreateSecurityChallengeV2PerformanceBudgetSnapshot();

        Assert.Contains("fsus.security.challenge.v2.issued.count", measurements);
        Assert.Contains("fsus.security.challenge.v2.verified.count", measurements);
        Assert.Contains("fsus.security.challenge.v2.failed.count", measurements);
        Assert.Contains("fsus.security.challenge.v2.replayed.count", measurements);
        Assert.Contains("fsus.security.challenge.v2.solve.duration", measurements);
        Assert.Contains("fsus.security.challenge.v2.payload.bytes", measurements);
        Assert.Contains("fsus.security.challenge.v2.verify.duration", measurements);
        Assert.Contains("fsus.security.challenge.v2.task.kind.count", measurements);
        Assert.Contains("issue_p99_budget_exceeded", snapshot.Warnings);
        Assert.Contains("verify_p99_budget_exceeded", snapshot.Warnings);
        Assert.Contains("payload_p95_budget_exceeded", snapshot.Warnings);
        Assert.Contains("client_render_p95_budget_exceeded", snapshot.Warnings);
    }

    [Fact]
    public void PerceptionChallengeV2Metrics_DoNotPropagateListenerFailures()
    {
        using var listener = new MeterListener();
        listener.InstrumentPublished = (instrument, meterListener) =>
        {
            if (string.Equals(instrument.Meter.Name, FsusObservability.MeterName, StringComparison.Ordinal)
                && string.Equals(instrument.Name, "fsus.security.challenge.v2.verified.count", StringComparison.Ordinal))
            {
                meterListener.EnableMeasurementEvents(instrument);
            }
        };
        listener.SetMeasurementEventCallback<long>((_, _, _, _) => throw new InvalidOperationException("collector failed"));
        listener.Start();

        Exception? exception = Record.Exception(() =>
            FsusObservability.RecordSecurityChallengeV2Verified(
                "perceptionTextTaskV2",
                "comment.create",
                "risk-policy-v2",
                "character",
                payloadBytes: 1024,
                verifyDuration: TimeSpan.FromMilliseconds(12),
                solveDuration: TimeSpan.FromMilliseconds(2_400)));

        Assert.Null(exception);
    }

    [Fact]
    public void AddFsusObservability_RegistersCollectorSwitchAndRuntimeState()
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Observability:Enabled"] = "true",
                ["Observability:ExporterEnabled"] = "true",
                ["Observability:OtlpEndpoint"] = "http://127.0.0.1:4317",
                ["Observability:HttpMetricsSampleRate"] = "16",
                ["Observability:SlowRequestThresholdMilliseconds"] = "250"
            })
            .Build();
        var services = new ServiceCollection();

        services.AddFsusObservability(configuration, new FakeEnvironment());
        using ServiceProvider provider = services.BuildServiceProvider();

        ObservabilityRuntimeState state = provider.GetRequiredService<ObservabilityRuntimeState>();
        Assert.True(state.Enabled);
        Assert.True(state.ExporterEnabled);
        Assert.Equal("http://127.0.0.1:4317", state.OtlpEndpoint);
        FsusObservabilityOptions options = provider.GetRequiredService<IOptions<FsusObservabilityOptions>>().Value;
        Assert.Equal(16, options.HttpMetricsSampleRate);
        Assert.Equal(250, options.SlowRequestThresholdMilliseconds);
    }

    [Fact]
    public async Task CorrelationMiddleware_DoesNotMaterializeTraceIdWhenActivityIsNotRecording()
    {
        using var activity = new Activity("unit-http-hot-path");
        activity.Start();
        activity.IsAllDataRequested = false;
        Activity.Current = activity;
        try
        {
            var context = new DefaultHttpContext();
            context.TraceIdentifier = "request-local";
            var middleware = new ObservabilityCorrelationMiddleware(
                _ => Task.CompletedTask,
                Options.Create(new FsusObservabilityOptions
                {
                    HttpMetricsSampleRate = 4096,
                    SlowRequestThresholdMilliseconds = 60_000
                }));

            await middleware.InvokeAsync(context);

            Assert.Equal("request-local", context.TraceIdentifier);
        }
        finally
        {
            activity.Stop();
            Activity.Current = null;
        }
    }

    private sealed class FakeEnvironment : IWebHostEnvironment
    {
        public string EnvironmentName { get; set; } = "UnitTest";
        public string ApplicationName { get; set; } = "FsusBlog.Tests";
        public string WebRootPath { get; set; } = string.Empty;
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string ContentRootPath { get; set; } = string.Empty;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }

    private static MethodInfo AsyncMoveNext(MethodInfo method)
    {
        AsyncStateMachineAttribute stateMachine = method.GetCustomAttribute<AsyncStateMachineAttribute>()
            ?? throw new InvalidOperationException($"Async state machine missing: {method.Name}");
        return stateMachine.StateMachineType.GetMethod("MoveNext", BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Instance)!;
    }

    private static IEnumerable<MethodBase> ReadCalledMethods(MethodInfo method)
    {
        byte[] il = method.GetMethodBody()?.GetILAsByteArray() ?? [];
        for (int offset = 0; offset <= il.Length - 5; offset++)
        {
            if (il[offset] is not (0x28 or 0x6F))
            {
                continue;
            }

            MethodBase? called = null;
            try
            {
                called = method.Module.ResolveMethod(BitConverter.ToInt32(il, offset + 1));
            }
            catch (ArgumentException)
            {
            }

            if (called is not null)
            {
                yield return called;
            }
        }
    }
}
