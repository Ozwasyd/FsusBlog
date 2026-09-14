using System.Collections.Concurrent;
using System.Diagnostics.Metrics;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class UnifiedCacheL1TelemetryAllocationTests
{
    private const int WarmupIterations = 32_768;
    private const int MeasurementIterations = 262_144;

    [Fact]
    public void SampledL1HitTelemetry_IncrementalAllocationOverDisabledControl_IsZeroAndMatchesPolicy()
    {
        int sampleRate = FsusObservability.CacheL1DurationSampleRate;
        Assert.True(sampleRate > 0 && (sampleRate & (sampleRate - 1)) == 0,
            $"L1 duration sample rate must remain a positive power of two; actual={sampleRate}");
        Assert.Equal(0, MeasurementIterations % sampleRate);
        AssertMachineReadablePolicy(sampleRate);

        var disabled = new DisabledCacheTelemetry();
        var sampled = new CacheTelemetry();
        WarmUp(disabled);
        WarmUp(sampled);

        AllocationMeasurement disabledMeasurement = Measure(disabled);
        AllocationMeasurement sampledMeasurement = Measure(sampled);

        Assert.Equal(0, disabledMeasurement.SampleCount);
        Assert.Equal(0, disabledMeasurement.AllocatedBytes);
        Assert.Equal(
            0,
            sampledMeasurement.AllocatedBytes - disabledMeasurement.AllocatedBytes);
        Assert.True(sampledMeasurement.SampleCount > 0,
            "the sampled telemetry path did not select any duration observations");
        Assert.InRange(
            sampledMeasurement.SampleCount,
            MeasurementIterations / sampleRate - 1,
            MeasurementIterations / sampleRate + 1);
    }

    [Theory]
    [InlineData(16)]
    [InlineData(64)]
    [InlineData(256)]
    public void SamplingGate_RequiredRatesHaveExactWeightedCountAndBoundedDurationError(int sampleRate)
    {
        const int Iterations = 262_144;
        long sequence = 0;
        ulong random = 0x9e3779b97f4a7c15UL;
        double populationTotal = 0;
        double sampleTotal = 0;
        int sampleCount = 0;

        for (int index = 0; index < Iterations; index++)
        {
            random ^= random << 13;
            random ^= random >> 7;
            random ^= random << 17;
            double duration = 0.05d + ((random & 0xffffUL) / 65_535d);
            populationTotal += duration;
            if (CacheL1SamplingGate.ShouldSample(ref sequence, sampleRate))
            {
                sampleTotal += duration;
                sampleCount++;
            }
        }

        Assert.Equal(Iterations / sampleRate, sampleCount);
        Assert.Equal(Iterations, sampleCount * sampleRate);
        double populationMean = populationTotal / Iterations;
        double sampleMean = sampleTotal / sampleCount;
        double relativeError = Math.Abs(sampleMean - populationMean) / populationMean;
        Assert.InRange(relativeError, 0d, 0.05d);
    }

    [Theory]
    [InlineData(64)]
    [InlineData(256)]
    [InlineData(1024)]
    public void PreboundCounters_RemainExactAtRequiredContentionLevels(int workerCount)
    {
        const int HitsPerWorker = 128;
        CachePolicyHitMissRuntimeCounter before = FsusObservability.GetCachePolicyHitMissCounter(
            CachePolicyId.PublicAotBackfillLease);

        Parallel.For(
            0,
            workerCount,
            new ParallelOptions { MaxDegreeOfParallelism = workerCount },
            _ =>
            {
                for (int hit = 0; hit < HitsPerWorker; hit++)
                {
                    CacheL1HitObservation observation = FsusObservability.BeginCacheL1Hit(
                        CachePolicyId.PublicAotBackfillLease,
                        CacheL1Operation.Typed);
                    FsusObservability.RecordCacheL1Hit(
                        CachePolicyId.PublicAotBackfillLease,
                        CacheL1Operation.Typed,
                        negative: false,
                        observation);
                }
            });

        CachePolicyHitMissRuntimeCounter after = FsusObservability.GetCachePolicyHitMissCounter(
            CachePolicyId.PublicAotBackfillLease);
        Assert.Equal((long)workerCount * HitsPerWorker, after.Hits - before.Hits);
        Assert.Equal(before.Misses, after.Misses);
    }

    [Fact]
    public void MissErrorAndSecuritySignals_AreCapturedExactlyWithBoundedTags()
    {
        string[] cacheResults =
        [
            "miss",
            "decode_failed",
            "redis_error",
            "db_fallback",
            "admission_reject",
            "eviction",
            "capacity_violation"
        ];
        var measurements = new ConcurrentBag<CapturedMeasurement>();
        using var listener = new MeterListener
        {
            InstrumentPublished = static (instrument, meterListener) =>
            {
                if (instrument.Meter.Name == FsusObservability.MeterName
                    && instrument.Name is "fsus.cache.operation.count" or "fsus.security.event.count")
                {
                    meterListener.EnableMeasurementEvents(instrument);
                }
            }
        };
        listener.SetMeasurementEventCallback<long>((instrument, value, tags, _) =>
        {
            string? result = null;
            bool hasIdentity = false;
            foreach (KeyValuePair<string, object?> tag in tags)
            {
                if (tag.Key == "fsus.result")
                {
                    result = tag.Value?.ToString();
                }
                hasIdentity |= tag.Key.Contains("identity", StringComparison.OrdinalIgnoreCase);
            }

            measurements.Add(new CapturedMeasurement(instrument.Name, value, result, hasIdentity));
        });
        listener.Start();

        foreach (string result in cacheResults)
        {
            FsusObservability.RecordCacheOperation(
                "issue1850_capture",
                "ArticleDetail",
                "l2",
                result,
                TimeSpan.Zero);
        }
        FsusObservability.RecordSecurityEvent("issue1850_capture", "unknown_bot", "rejected");

        CapturedMeasurement[] captured = measurements.ToArray();
        foreach (string result in cacheResults)
        {
            CapturedMeasurement measurement = Assert.Single(captured, item =>
                item.Instrument == "fsus.cache.operation.count" && item.Result == result);
            Assert.Equal(1, measurement.Value);
            Assert.False(measurement.HasIdentityTag);
        }

        CapturedMeasurement security = Assert.Single(captured, item =>
            item.Instrument == "fsus.security.event.count" && item.Result == "rejected");
        Assert.Equal(1, security.Value);
        Assert.False(security.HasIdentityTag);
    }

    private static void WarmUp(ICacheTelemetry telemetry)
    {
        _ = RecordL1Hits(telemetry, WarmupIterations);
        _ = RecordL1Hits(telemetry, WarmupIterations);
    }

    private static AllocationMeasurement Measure(ICacheTelemetry telemetry)
    {
        long before = GC.GetAllocatedBytesForCurrentThread();
        int sampleCount = RecordL1Hits(telemetry, MeasurementIterations);
        long allocatedBytes = GC.GetAllocatedBytesForCurrentThread() - before;
        return new AllocationMeasurement(allocatedBytes, sampleCount);
    }

    private static int RecordL1Hits(ICacheTelemetry telemetry, int iterations)
    {
        int sampleCount = 0;
        for (int index = 0; index < iterations; index++)
        {
            CacheL1HitObservation observation = telemetry.BeginL1Hit(
                CachePolicyId.ArticleDetail,
                CacheL1Operation.Typed);
            telemetry.RecordL1Hit(
                CachePolicyId.ArticleDetail,
                CacheL1Operation.Typed,
                negative: false,
                observation);
            sampleCount += observation.Sampled ? 1 : 0;
        }

        return sampleCount;
    }

    private static void AssertMachineReadablePolicy(int sampleRate)
    {
        string path = BackendTestPaths.FromRoot("tests", "performance", "cache-l1-telemetry-policy.json");
        using JsonDocument document = JsonDocument.Parse(File.ReadAllBytes(path));
        JsonElement policy = document.RootElement;
        Assert.Equal("fsus.cache-l1-telemetry-policy.v1", policy.GetProperty("schema").GetString());
        Assert.Equal(sampleRate, policy.GetProperty("defaultDurationSampleRate").GetInt32());
        Assert.Equal(
            ["online", "offline", "backpressured"],
            policy.GetProperty("exporterBenchmarkModes").EnumerateArray().Select(static value => value.GetString()!).ToArray());
        Assert.Equal(
            [64, 256, 1024],
            policy.GetProperty("contentionWorkerCounts").EnumerateArray().Select(static value => value.GetInt32()).ToArray());
        Assert.Equal(0d, policy.GetProperty("countRelativeErrorBudget").GetDouble());
    }

    private readonly record struct AllocationMeasurement(long AllocatedBytes, int SampleCount);

    private readonly record struct CapturedMeasurement(
        string Instrument,
        long Value,
        string? Result,
        bool HasIdentityTag);

    private sealed class DisabledCacheTelemetry : ICacheTelemetry
    {
        public void RecordOperation(string operation, string policy, string layer, string outcome, TimeSpan elapsed)
        {
        }

        public CacheL1HitObservation BeginL1Hit(CachePolicyId policyId, CacheL1Operation operation) => default;

        public void RecordL1Hit(
            CachePolicyId policyId,
            CacheL1Operation operation,
            bool negative,
            CacheL1HitObservation observation)
        {
        }
    }
}
