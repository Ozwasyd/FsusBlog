using System.Globalization;

using BenchmarkDotNet.Attributes;
using BenchmarkDotNet.Columns;
using BenchmarkDotNet.Configs;
using BenchmarkDotNet.Reports;
using BenchmarkDotNet.Running;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Observability;

using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using OpenTelemetry;
using OpenTelemetry.Metrics;

using StackExchange.Redis;

public enum CacheL1TelemetryExporterMode : byte
{
    Online = 0,
    Offline = 1,
    Backpressured = 2
}

[MemoryDiagnoser]
[Config(typeof(CacheL1TelemetryPercentileConfig))]
public class CacheL1TelemetryExporterBenchmarks
{
    private UnifiedCacheBenchmarkFixture _fixture = null!;
    private MeterProvider _provider = null!;

    [ParamsAllValues]
    public CacheL1TelemetryExporterMode ExporterMode
    {
        get; set;
    }

    [GlobalSetup]
    public void Setup()
    {
        var exporter = new BenchmarkMetricExporter(ExporterMode);
        _provider = Sdk.CreateMeterProviderBuilder()
            .AddMeter(FsusObservability.MeterName)
            .AddReader(new PeriodicExportingMetricReader(
                exporter,
                exportIntervalMilliseconds: 10,
                exportTimeoutMilliseconds: 1_000))
            .Build();
        _fixture = UnifiedCacheBenchmarkFixture.Create(new CacheTelemetry());
    }

    [Benchmark]
    public async Task<int> FullUnifiedCacheTypedHit()
    {
        CacheReadResult<int> result = await _fixture.Cache.TryGetAsync(
            CachePolicyId.ArticleDetail,
            UnifiedCacheBenchmarkFixture.Identity,
            static bytes => (true, bytes.Length));
        return result.Hit ? 1 : 0;
    }

    [GlobalCleanup]
    public void Cleanup()
    {
        _fixture.Dispose();
        _provider.Dispose();
    }

    private sealed class BenchmarkMetricExporter(CacheL1TelemetryExporterMode mode) : BaseExporter<OpenTelemetry.Metrics.Metric>
    {
        public override ExportResult Export(in Batch<OpenTelemetry.Metrics.Metric> batch)
        {
            _ = batch;
            if (mode == CacheL1TelemetryExporterMode.Backpressured)
            {
                Thread.SpinWait(100_000);
            }

            return mode == CacheL1TelemetryExporterMode.Offline
                ? ExportResult.Failure
                : ExportResult.Success;
        }
    }
}

[MemoryDiagnoser]
[Config(typeof(CacheL1TelemetryPercentileConfig))]
public class CacheL1TelemetryContentionBenchmarks
{
    private const int HitsPerWorker = 64;
    private UnifiedCacheBenchmarkFixture _fixture = null!;

    [Params(64, 256, 1024)]
    public int WorkerCount
    {
        get; set;
    }

    [GlobalSetup]
    public void Setup()
        => _fixture = UnifiedCacheBenchmarkFixture.Create(new CacheTelemetry());

    [Benchmark]
    public long FullUnifiedCacheTypedHitsUnderContention()
    {
        long before = FsusObservability.GetCacheL1TelemetrySnapshot().ExactHitCount;
        Parallel.For(
            0,
            WorkerCount,
            new ParallelOptions { MaxDegreeOfParallelism = WorkerCount },
            _ =>
            {
                for (int hit = 0; hit < HitsPerWorker; hit++)
                {
                    CacheReadResult<int> result = _fixture.Cache.TryGetAsync(
                            CachePolicyId.ArticleDetail,
                            UnifiedCacheBenchmarkFixture.Identity,
                            static bytes => (true, bytes.Length))
                        .GetAwaiter()
                        .GetResult();
                    if (!result.Hit)
                    {
                        throw new InvalidOperationException("cache_l1_contention_benchmark_missed_seed");
                    }
                }
            });

        long recorded = FsusObservability.GetCacheL1TelemetrySnapshot().ExactHitCount - before;
        long expected = checked((long)WorkerCount * HitsPerWorker);
        return recorded == expected
            ? recorded
            : throw new InvalidOperationException($"cache_l1_exact_count_mismatch:{recorded}:{expected}");
    }

    [GlobalCleanup]
    public void Cleanup() => _fixture.Dispose();
}

public sealed class CacheL1TelemetryPercentileConfig : ManualConfig
{
    public CacheL1TelemetryPercentileConfig()
    {
        AddColumn(StatisticColumn.P95, new CacheL1TelemetryP99Column());
    }
}

internal sealed class CacheL1TelemetryP99Column : IColumn
{
    public string Id => nameof(CacheL1TelemetryP99Column);
    public string ColumnName => "P99";
    public bool AlwaysShow => true;
    public ColumnCategory Category => ColumnCategory.Statistics;
    public int PriorityInCategory => 99;
    public bool IsNumeric => true;
    public UnitType UnitType => UnitType.Time;
    public string Legend => "99th percentile of all measurements";

    public string GetValue(Summary summary, BenchmarkCase benchmarkCase)
        => GetValue(summary, benchmarkCase, summary.Style);

    public string GetValue(Summary summary, BenchmarkCase benchmarkCase, SummaryStyle style)
    {
        BenchmarkReport? report = summary[benchmarkCase];
        BenchmarkDotNet.Mathematics.Statistics? statistics = report?.ResultStatistics;
        return statistics is null
            ? "NA"
            : statistics.Percentiles.Percentile(99).ToString("0.###", CultureInfo.InvariantCulture);
    }

    public bool IsDefault(Summary summary, BenchmarkCase benchmarkCase) => false;

    public bool IsAvailable(Summary summary) => true;
}

internal sealed class UnifiedCacheBenchmarkFixture : IDisposable
{
    public const int Identity = 42;

    private readonly MemoryCache _memory;

    private UnifiedCacheBenchmarkFixture(MemoryCache memory, UnifiedCache cache)
    {
        _memory = memory;
        Cache = cache;
    }

    public UnifiedCache Cache
    {
        get;
    }

    public static UnifiedCacheBenchmarkFixture Create(ICacheTelemetry telemetry)
    {
        var policies = new CachePolicyRegistry();
        var scope = new DefaultRuntimeKeyScope();
        var memory = new MemoryCache(new MemoryCacheOptions());
        IDatabase database = Substitute.For<IDatabase>();
        database.StringSetAsync(
                Arg.Any<RedisKey>(),
                Arg.Any<RedisValue>(),
                Arg.Any<TimeSpan?>(),
                Arg.Any<When>(),
                Arg.Any<CommandFlags>())
            .Returns(Task.FromResult(true));
        IConnectionMultiplexer redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(database);
        var keyResolver = new CacheKeyResolver(
            policies,
            scope,
            NullLogger<CacheKeyResolver>.Instance);
        var cache = new UnifiedCache(
            memory,
            new PolicyShardedCacheL1Store(policies),
            redis,
            policies,
            scope,
            keyResolver,
            new CacheSingleFlightCoordinator(keyResolver),
            telemetry,
            NullLogger<UnifiedCache>.Instance);
        cache.SetRawAsync(CachePolicyId.ArticleDetail, Identity, [1, 2, 3, 4])
            .GetAwaiter()
            .GetResult();
        return new UnifiedCacheBenchmarkFixture(memory, cache);
    }

    public void Dispose()
    {
        Cache.Dispose();
        _memory.Dispose();
    }
}
