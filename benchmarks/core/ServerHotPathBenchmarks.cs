using System.Buffers;
using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Data;
using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Globalization;
using System.IO.Pipelines;
using System.Net;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using BenchmarkDotNet.Attributes;
using BenchmarkDotNet.Columns;
using BenchmarkDotNet.Configs;
using BenchmarkDotNet.Reports;
using BenchmarkDotNet.Running;

using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers.Security;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Distribution;
using FsusBlog.Server.Services.Security;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;

using StackExchange.Redis;

[MemoryDiagnoser]
[WarmupCount(3)]
[IterationCount(128)]
[Config(typeof(SitemapProductionBenchmarkConfig))]
public class SitemapProductionBuildBenchmarks
{
    private const int TotalUrlCount = 45_001;
    private const int StaticUrlCount = 6;
    private const long AllocationBudgetBytes = 256L * 1024 * 1024;
    private const long ResidentBudgetBytes = 16L * 1024 * 1024;
    private static readonly TimeSpan s_buildBudget = TimeSpan.FromSeconds(2);
    private readonly DataSet _bootstrap = CreateBootstrap();
    private readonly DataTable _articles = CreateArticles(TotalUrlCount - StaticUrlCount);
    private readonly DataTable _taxonomy = CreateTaxonomy();
    private ISqlSugarClient _db = null!;
    private ISystemService _system = null!;
    private ICacheStringReader _redis = null!;
    private IConfiguration _configuration = null!;
    private long _lastResidentBytes;
    private long _lastAllocationBytes;
    private long _lastElapsedTicks;

    [GlobalSetup]
    public void Setup()
    {
        IAdo ado = Substitute.For<IAdo>();
        ado.GetDataReaderAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>())
            .Returns(call => Task.FromResult<IDataReader>(CreateReader(call.Arg<string>())));
        _db = Substitute.For<ISqlSugarClient>();
        _db.Ado.Returns(ado);
        _system = Substitute.For<ISystemService>();
        _redis = Substitute.For<ICacheStringReader>();
        _configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Seo:BaseUrl"] = "https://benchmark.example"
            })
            .Build();
    }

    [Benchmark]
    public long ProductionColdBuild45_001Urls()
    {
        long allocatedBefore = GC.GetAllocatedBytesForCurrentThread();
        long startedAt = Stopwatch.GetTimestamp();
        using var memory = new MemoryCache(new MemoryCacheOptions());
        var artifacts = new SitemapArtifactCache(new PublicAotInvalidationTracker());
        var service = new BlogDistributionService(
            _db,
            _system,
            _redis,
            memory,
            _configuration,
            artifacts);
        _ = service.BuildSitemapAsync().GetAwaiter().GetResult();
        SitemapArtifactCacheSnapshot snapshot = artifacts.Snapshot();
        TimeSpan elapsed = Stopwatch.GetElapsedTime(startedAt);
        long allocationBytes = GC.GetAllocatedBytesForCurrentThread() - allocatedBefore;
        if (elapsed > s_buildBudget)
        {
            throw new InvalidOperationException($"sitemap production build exceeded {s_buildBudget.TotalMilliseconds:F0}ms: {elapsed.TotalMilliseconds:F2}ms");
        }
        if (allocationBytes > AllocationBudgetBytes)
        {
            throw new InvalidOperationException($"sitemap production allocation exceeded {AllocationBudgetBytes}: {allocationBytes}");
        }
        if (snapshot.ResidentBytes > ResidentBudgetBytes)
        {
            throw new InvalidOperationException($"sitemap resident bytes exceeded {ResidentBudgetBytes}: {snapshot.ResidentBytes}");
        }
        Volatile.Write(ref _lastResidentBytes, snapshot.ResidentBytes);
        Volatile.Write(ref _lastAllocationBytes, allocationBytes);
        Volatile.Write(ref _lastElapsedTicks, elapsed.Ticks);
        return snapshot.ResidentBytes;
    }

    [GlobalCleanup]
    public void ReportCapacity()
        => Console.WriteLine(
            $"[sitemap-production] urls={TotalUrlCount} measurementIterations=128 "
            + $"lastElapsedMs={TimeSpan.FromTicks(Volatile.Read(ref _lastElapsedTicks)).TotalMilliseconds:F2} "
            + $"lastAllocationBytes={Volatile.Read(ref _lastAllocationBytes)} "
            + $"residentBytes={Volatile.Read(ref _lastResidentBytes)} "
            + $"budgets=p99<={s_buildBudget.TotalMilliseconds:F0}ms,allocation<={AllocationBudgetBytes},resident<={ResidentBudgetBytes}");

    private IDataReader CreateReader(string sql)
    {
        if (sql.Contains("sys_systemconfig", StringComparison.Ordinal))
        {
            return _bootstrap.CreateDataReader();
        }
        if (sql.Contains("FROM article a", StringComparison.Ordinal))
        {
            return _articles.CreateDataReader();
        }
        return _taxonomy.CreateDataReader();
    }

    private static DataSet CreateBootstrap()
    {
        var dataSet = new DataSet();
        var origin = new DataTable();
        _ = origin.Columns.Add("BaseUrl", typeof(string));
        _ = origin.Rows.Add("https://benchmark.example");
        var pages = new DataTable();
        _ = pages.Columns.Add("Slug", typeof(string));
        _ = pages.Columns.Add("UpdatedAt", typeof(DateTime));
        DateTime updatedAt = new(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        foreach (string slug in new[] { "about", "privacy", "guidelines", "copyright" })
        {
            _ = pages.Rows.Add(slug, updatedAt);
        }
        dataSet.Tables.Add(origin);
        dataSet.Tables.Add(pages);
        return dataSet;
    }

    private static DataTable CreateArticles(int count)
    {
        var table = new DataTable();
        _ = table.Columns.Add("Id", typeof(int));
        _ = table.Columns.Add("ModifiedAt", typeof(DateTime));
        DateTime modifiedAt = new(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        for (int id = 1; id <= count; id++)
        {
            _ = table.Rows.Add(id, modifiedAt.AddSeconds(id));
        }
        return table;
    }

    private static DataTable CreateTaxonomy()
    {
        var table = new DataTable();
        _ = table.Columns.Add("Id", typeof(int));
        _ = table.Columns.Add("ModifiedAt", typeof(DateTime));
        return table;
    }
}

public sealed class SitemapProductionBenchmarkConfig : ManualConfig
{
    public SitemapProductionBenchmarkConfig()
    {
        AddColumn(StatisticColumn.P50, new SitemapP99MillisecondsColumn());
    }
}

internal sealed class SitemapP99MillisecondsColumn : IColumn
{
    public string Id => nameof(SitemapP99MillisecondsColumn);
    public string ColumnName => "P99 ms";
    public bool AlwaysShow => true;
    public ColumnCategory Category => ColumnCategory.Statistics;
    public int PriorityInCategory => 99;
    public bool IsNumeric => true;
    public UnitType UnitType => UnitType.Dimensionless;
    public string Legend => "99th percentile in milliseconds";

    public string GetValue(Summary summary, BenchmarkCase benchmarkCase)
        => GetValue(summary, benchmarkCase, summary.Style);

    public string GetValue(Summary summary, BenchmarkCase benchmarkCase, SummaryStyle style)
    {
        BenchmarkReport? report = summary[benchmarkCase];
        BenchmarkDotNet.Mathematics.Statistics? statistics = report?.ResultStatistics;
        return statistics is null
            ? "NA"
            : (statistics.Percentiles.Percentile(99) / 1_000_000d)
                .ToString("0.###", CultureInfo.InvariantCulture);
    }

    public bool IsDefault(Summary summary, BenchmarkCase benchmarkCase) => false;

    public bool IsAvailable(Summary summary) => true;
}

[MemoryDiagnoser]
public class PublicHotReadEarlyDataPlaneBenchmarks
{
    private readonly DefaultHttpContext _context = CreateContext();
    private readonly RequestDelegate _legacyPipeline;

    public PublicHotReadEarlyDataPlaneBenchmarks()
    {
        RequestDelegate terminal = static context =>
        {
            string path = context.Request.Path.Value!;
            _ = PublicHotReadFastPath.TryClassifyRouteForTests(path, out _);
            _ = PublicHotReadFastPath.TryClassifyRouteForTests(path, out _);
            return Task.CompletedTask;
        };

        for (int i = 0; i < 11; i++)
        {
            terminal = WrapGenericMiddleware(terminal);
        }

        _legacyPipeline = terminal;
    }

    [Benchmark(Baseline = true)]
    public Task Legacy_GenericPipelineAndDoubleClassification()
        => _legacyPipeline(_context);

    [Benchmark]
    public bool Current_EarlySingleClassificationFeature()
        => PublicHotReadFastPath.TryCreateRequestFeatureForTests(_context, out PublicHotReadRequestFeature? feature)
            && feature is { ClassificationCount: 1, RouteKind: PublicHotReadRouteKind.ArticleDetail };

    private static RequestDelegate WrapGenericMiddleware(RequestDelegate next)
        => context => InvokeGenericMiddlewareAsync(context, next);

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static async Task InvokeGenericMiddlewareAsync(HttpContext context, RequestDelegate next)
        => await next(context).ConfigureAwait(false);

    private static DefaultHttpContext CreateContext()
    {
        var context = new DefaultHttpContext();
        context.Request.Method = HttpMethods.Get;
        context.Request.Path = "/api/binary/article/42.aeds";
        return context;
    }
}

[Config(typeof(PublicArtifactRevocationBenchmarkConfig))]
[MemoryDiagnoser]
public class PublicArtifactRevocationHotPathBenchmarks
{
    private PublicArtifactRevocationRegistry _registry = null!;
    private DefaultHttpContext _context = null!;

    [Params(0, 1, 10_000, 100_000)]
    public int ActiveCount
    {
        get; set;
    }

    [GlobalSetup]
    public void Setup()
    {
        _registry = new PublicArtifactRevocationRegistry();
        for (int articleId = 1; articleId <= ActiveCount; articleId++)
        {
            _registry.Apply(new PublicArtifactTombstone(articleId, articleId + 1L, articleId));
        }

        _context = new DefaultHttpContext();
        _context.Request.Method = HttpMethods.Get;
        _context.Request.Path = "/api/binary/article/200001.aeds";
        _context.Request.Headers.Accept = "application/octet-stream";
    }

    [Benchmark]
    public long ClassificationAndLookup()
    {
        if (!PublicHotReadFastPath.TryCreateRequestFeatureForTests(
                _context,
                out PublicHotReadRequestFeature? feature))
        {
            return -1;
        }

        return _registry.TryResolve(feature!.Route, out PublicArtifactTombstone tombstone)
            ? tombstone.Generation
            : 0;
    }
}

public sealed class PublicArtifactRevocationBenchmarkConfig : ManualConfig
{
    public PublicArtifactRevocationBenchmarkConfig()
    {
        AddColumn(StatisticColumn.P50, new PublicArtifactRevocationP99Column());
    }
}

internal sealed class PublicArtifactRevocationP99Column : IColumn
{
    public string Id => nameof(PublicArtifactRevocationP99Column);
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

[MemoryDiagnoser]
public class CacheAndFrameFixedCostHotPathBenchmarks
{
    private const int Identity = 42;
    private const string PolicyName = "ArticleDetailFrame";
    private readonly CachePolicy _policy = new(
        CachePolicyId.ArticleDetailFrame,
        "blog",
        "article-detail-frame",
        TimeSpan.FromMinutes(5),
        TimeSpan.FromHours(1));
    private readonly byte[] _payload = Encoding.UTF8.GetBytes(new string('f', 512));
    private readonly byte[] _preencodedFrame;
    private readonly MemoryCache _legacyL1 = new(new MemoryCacheOptions());
    private readonly PolicyShardedCacheL1Store _structuredL1 = new(new CachePolicyRegistry());
    private readonly ConcurrentDictionary<string, long> _legacyCounters = new(StringComparer.Ordinal);
    private long _legacyAtomicCounter;

    public CacheAndFrameFixedCostHotPathBenchmarks()
    {
        _preencodedFrame = new AedsEncoder().Encode(AedsFrameType.ArticleDetail, _payload);
        _legacyL1.Set(_policy.BuildKey(Identity.ToString(System.Globalization.CultureInfo.InvariantCulture)), _preencodedFrame);
        _structuredL1.TrySetOwned(
            _policy,
            CacheL1Key.ForInteger("runtime", CachePolicyId.ArticleDetailFrame, Identity),
            _policy.BuildKey(Identity),
            _preencodedFrame);
        FsusObservability.RecordCacheOperation("get_raw_readonly", PolicyName, "l1", "hit", TimeSpan.Zero);
    }

    [Benchmark(Baseline = true)]
    public int Legacy_L1FinalRedisStringKey()
    {
        string key = _policy.BuildKey(Identity.ToString(System.Globalization.CultureInfo.InvariantCulture));
        return _legacyL1.TryGetValue(key, out byte[]? frame) ? frame?.Length ?? 0 : 0;
    }

    [Benchmark]
    public int Current_L1IntegerStructuredKey()
    {
        CacheL1Key key = CacheL1Key.ForInteger("runtime", CachePolicyId.ArticleDetailFrame, Identity);
        if (!_structuredL1.TryAcquire(key, out PolicyShardedCacheL1Store.CacheL1ReadLease lease))
        {
            return 0;
        }

        using (lease)
        {
            return lease.Memory.Length;
        }
    }

    [Benchmark]
    public int Legacy_RawCallerCopy()
        => _preencodedFrame.ToArray().Length;

    [Benchmark]
    public int Current_RawReadonlyBorrow()
        => UnifiedCache.BorrowRawBytesReadonlyForTests(_preencodedFrame).Length;

    [Benchmark]
    public int Current_DynamicFrame()
    {
        using var writer = new AedsFrameBufferWriter(_payload.Length + AedsFrameHeader.Size);
        writer.Write(_payload);
        writer.Seal(AedsFrameType.ArticleDetail);
        return writer.WrittenFrame.Length;
    }

    [Benchmark]
    public int Current_PreencodedFrame()
        => ReadPreencodedFrameMetadata(_preencodedFrame);

    [Benchmark]
    public long Legacy_GlobalAtomicAndStringCounterKey()
    {
        Interlocked.Increment(ref _legacyAtomicCounter);
        return _legacyCounters.AddOrUpdate(
            string.Concat("get_raw_readonly", '|', PolicyName, '|', "l1", '|', "hit"),
            1,
            static (_, current) => current + 1);
    }

    [Benchmark]
    public int Current_PreboundSampledTelemetry()
    {
        CacheL1HitObservation observation = FsusObservability.BeginCacheL1Hit(
            CachePolicyId.ArticleDetailFrame,
            CacheL1Operation.Readonly);
        FsusObservability.RecordCacheL1Hit(
            CachePolicyId.ArticleDetailFrame,
            CacheL1Operation.Readonly,
            negative: false,
            observation);
        return 1;
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static int ReadPreencodedFrameMetadata(ReadOnlySpan<byte> frame)
        => frame.Length + BinaryPrimitives.ReadUInt16LittleEndian(frame[8..10]);

    [GlobalCleanup]
    public void Cleanup()
    {
        _structuredL1.Dispose();
        _legacyL1.Dispose();
    }
}

[MemoryDiagnoser]
public class PolicyShardedCacheL1ResidencyBenchmarks
{
    private const string Scope = "benchmark";
    private readonly LegacyCacheLocalStoreBenchmarkBaseline _legacy = new();
    private PolicyShardedCacheL1Store _current = null!;
    private CachePolicy _policy = null!;
    private byte[] _first = null!;
    private byte[] _second = null!;
    private CacheL1Key _firstKey;
    private CacheL1Key _secondKey;

    [Params(1024, 64 * 1024, 84_999, 85_000, 85_001)]
    public int PayloadLength
    {
        get; set;
    }

    [GlobalSetup]
    public void Setup()
    {
        long budget = checked(PayloadLength * 4L);
        _policy = new CachePolicy(
            CachePolicyId.ArticleDetail,
            "benchmark",
            "article-detail",
            TimeSpan.FromMinutes(5),
            TimeSpan.FromMinutes(30),
            L1MaxEntries: 1,
            L1MaxLogicalBytes: budget,
            L1MaxCapacityBytes: budget);
        _current = new PolicyShardedCacheL1Store(new SinglePolicyRegistry(_policy));
        _first = new byte[PayloadLength];
        _second = new byte[PayloadLength];
        _firstKey = CacheL1Key.ForString(Scope, _policy.Id, "first");
        _secondKey = CacheL1Key.ForString(Scope, _policy.Id, "second");
        _legacy.Set(_policy, _firstKey, _policy.BuildKey("first"), _first);
        _current.TrySetOwned(_policy, _firstKey, _policy.BuildKey("first"), _first);
    }

    [Benchmark(Baseline = true)]
    public int Legacy_MemoryCacheHit()
        => _legacy.TryGet(_firstKey, out byte[]? value)
            ? value!.Length
            : 0;

    [Benchmark]
    public int Current_PolicyShardHit()
    {
        if (!_current.TryAcquire(_firstKey, out PolicyShardedCacheL1Store.CacheL1ReadLease lease))
        {
            return 0;
        }

        using (lease)
        {
            return lease.Memory.Length;
        }
    }

    [Benchmark]
    public bool Current_OwnershipTransferReplace()
        => _current.TrySetOwned(_policy, _firstKey, _policy.BuildKey("first"), _second);

    [Benchmark]
    public bool Current_BoundedEvictAndSet()
    {
        _current.TrySetOwned(_policy, _secondKey, _policy.BuildKey("second"), _second);
        return _current.TrySetOwned(_policy, _firstKey, _policy.BuildKey("first"), _first);
    }

    [GlobalCleanup]
    public void Cleanup()
    {
        _current.Dispose();
        _legacy.Dispose();
    }

    private sealed class SinglePolicyRegistry(CachePolicy policy) : ICachePolicyRegistry
    {
        public bool TryGet(CachePolicyId id, out CachePolicy value)
        {
            value = policy;
            return id == policy.Id;
        }
    }
}

[MemoryDiagnoser]
public class PolicyShardedCacheL1ContentionBenchmarks
{
    private const int WritesPerWorker = 64;
    private readonly LegacyCacheLocalStoreBenchmarkBaseline _legacy = new();
    private PolicyShardedCacheL1Store _current = null!;
    private CachePolicy[] _policies = null!;
    private BenchmarkWrite[][] _writes = null!;

    [Params(2, 8, 32)]
    public int WorkerCount
    {
        get; set;
    }

    [GlobalSetup]
    public void Setup()
    {
        int entriesPerPolicy = checked(WorkerCount * WritesPerWorker);
        long bytesPerPolicy = checked(entriesPerPolicy * 32L);
        _policies =
        [
            Policy(CachePolicyId.ArticleDetail, entriesPerPolicy, bytesPerPolicy),
            Policy(CachePolicyId.SystemSeo, entriesPerPolicy, bytesPerPolicy)
        ];
        _current = new PolicyShardedCacheL1Store(new MultiPolicyRegistry(_policies));
        _writes = Enumerable.Range(0, WorkerCount)
            .Select(worker => Enumerable.Range(0, WritesPerWorker)
                .Select(index => CreateWrite(worker, index))
                .ToArray())
            .ToArray();
    }

    [Benchmark(Baseline = true)]
    public int Legacy_GlobalGateWrites()
    {
        Parallel.For(0, WorkerCount, worker =>
        {
            foreach (BenchmarkWrite write in _writes[worker])
            {
                _legacy.Set(write.Policy, write.Key, write.RedisKey, write.Payload);
            }
        });
        return _legacy.Count;
    }

    [Benchmark]
    public long Current_PolicyShardedWrites()
    {
        Parallel.For(0, WorkerCount, worker =>
        {
            foreach (BenchmarkWrite write in _writes[worker])
            {
                _current.TrySetOwned(write.Policy, write.Key, write.RedisKey, write.Payload);
            }
        });
        return checked(WorkerCount * WritesPerWorker);
    }

    [GlobalCleanup]
    public void Cleanup()
    {
        _current.Dispose();
        _legacy.Dispose();
    }

    private BenchmarkWrite CreateWrite(int worker, int index)
    {
        CachePolicy policy = _policies[worker & 1];
        string identity = $"{worker}:{index}";
        return new BenchmarkWrite(
            policy,
            CacheL1Key.ForString("benchmark", policy.Id, identity),
            policy.BuildKey(identity),
            new byte[32]);
    }

    private static CachePolicy Policy(CachePolicyId id, int maxEntries, long maxBytes)
        => new(
            id,
            "benchmark",
            id.ToString(),
            TimeSpan.FromMinutes(5),
            TimeSpan.FromMinutes(30),
            L1MaxEntries: maxEntries,
            L1MaxLogicalBytes: maxBytes,
            L1MaxCapacityBytes: checked(maxBytes + (maxEntries * 512L)));

    private readonly record struct BenchmarkWrite(
        CachePolicy Policy,
        CacheL1Key Key,
        string RedisKey,
        byte[] Payload);

    private sealed class MultiPolicyRegistry(params CachePolicy[] policies) : ICachePolicyRegistry
    {
        private readonly IReadOnlyDictionary<CachePolicyId, CachePolicy> _policies =
            policies.ToDictionary(static policy => policy.Id);

        public bool TryGet(CachePolicyId id, out CachePolicy policy)
            => _policies.TryGetValue(id, out policy!);
    }
}

/// <summary>
/// Executable benchmark-only copy of the removed origin/master CacheLocalStore
/// physical design: two concurrent indexes, one global mutation gate, one full
/// payload copy, and IMemoryCache placeholder ownership. It is intentionally not
/// registered with runtime DI and exists only as the real pre-cutover baseline.
/// </summary>
internal sealed class LegacyCacheLocalStoreBenchmarkBaseline : IDisposable
{
    private readonly MemoryCache _memory = new(new MemoryCacheOptions());
    private readonly ConcurrentDictionary<CacheL1Key, Entry> _entries = new();
    private readonly ConcurrentDictionary<string, Entry> _entriesByRedisKey = new(StringComparer.Ordinal);
    private readonly object _mutationLock = new();

    internal int Count => _entries.Count;

    internal bool TryGet(CacheL1Key key, out byte[]? bytes)
    {
        if (_entries.TryGetValue(key, out Entry? entry)
            && TimeProvider.System.GetTimestamp() < entry.ExpiresAtTimestamp)
        {
            bytes = entry.Bytes;
            return true;
        }

        bytes = null;
        return false;
    }

    internal void Set(CachePolicy policy, CacheL1Key key, string redisKey, byte[] bytes)
    {
        long ttl = Math.Max(
            1L,
            (long)Math.Ceiling(policy.L1Ttl.TotalSeconds * TimeProvider.System.TimestampFrequency));
        var entry = new Entry(key, redisKey, bytes.ToArray(), TimeProvider.System.GetTimestamp() + ttl);
        var options = new MemoryCacheEntryOptions { AbsoluteExpirationRelativeToNow = policy.L1Ttl };
        options.RegisterPostEvictionCallback(
            static (_, _, _, state) =>
            {
                var eviction = (EvictionState)state!;
                eviction.Owner._entries.TryRemove(
                    new KeyValuePair<CacheL1Key, Entry>(eviction.Entry.Key, eviction.Entry));
                eviction.Owner._entriesByRedisKey.TryRemove(
                    new KeyValuePair<string, Entry>(eviction.Entry.RedisKey, eviction.Entry));
            },
            new EvictionState(this, entry));

        lock (_mutationLock)
        {
            _entries.TryGetValue(key, out Entry? previousKey);
            _entriesByRedisKey.TryGetValue(redisKey, out Entry? previousRedis);
            _entries[key] = entry;
            _entriesByRedisKey[redisKey] = entry;
            _memory.Set(entry, true, options);
            RemoveSuperseded(previousKey, entry);
            RemoveSuperseded(previousRedis, entry);
        }
    }

    public void Dispose() => _memory.Dispose();

    private void RemoveSuperseded(Entry? previous, Entry current)
    {
        if (previous is null || ReferenceEquals(previous, current))
        {
            return;
        }

        _entries.TryRemove(new KeyValuePair<CacheL1Key, Entry>(previous.Key, previous));
        _entriesByRedisKey.TryRemove(new KeyValuePair<string, Entry>(previous.RedisKey, previous));
        _memory.Remove(previous);
    }

    private sealed record Entry(CacheL1Key Key, string RedisKey, byte[] Bytes, long ExpiresAtTimestamp);
    private sealed record EvictionState(LegacyCacheLocalStoreBenchmarkBaseline Owner, Entry Entry);
}

internal static class CacheL1ContentionProfiler
{
    private const int OperationsPerWorker = 5_000;

    internal static int Run()
    {
        ContentionReceipt[] receipts = new[] { 2, 8, 32 }
            .Select(Profile)
            .ToArray();
        Console.WriteLine(JsonSerializer.Serialize(
            new
            {
                schema = "fsus.cache-l1-contention-profile.v1",
                operationsPerWorker = OperationsPerWorker,
                receipts
            },
            new JsonSerializerOptions { WriteIndented = true }));
        return 0;
    }

    private static ContentionReceipt Profile(int workerCount)
    {
        CachePolicy[] policies =
        [
            Policy(CachePolicyId.ArticleDetail, workerCount),
            Policy(CachePolicyId.SystemSeo, workerCount)
        ];
        using var current = new PolicyShardedCacheL1Store(new MultiPolicyRegistry(policies));
        using var legacy = new LegacyCacheLocalStoreBenchmarkBaseline();
        Operation[][] operations = Enumerable.Range(0, workerCount)
            .Select(worker =>
            {
                CachePolicy policy = policies[worker & 1];
                string identity = worker.ToString(System.Globalization.CultureInfo.InvariantCulture);
                return Enumerable.Repeat(
                        new Operation(
                            policy,
                            CacheL1Key.ForString("profile", policy.Id, identity),
                            policy.BuildKey(identity),
                            new byte[32]),
                        OperationsPerWorker)
                    .ToArray();
            })
            .ToArray();
        long[] legacyLatencies = new long[checked(workerCount * OperationsPerWorker)];
        long[] currentLatencies = new long[legacyLatencies.Length];

        Parallel.For(0, workerCount, worker =>
        {
            int offset = worker * OperationsPerWorker;
            for (int index = 0; index < OperationsPerWorker; index++)
            {
                Operation operation = operations[worker][index];
                long startedAt = Stopwatch.GetTimestamp();
                legacy.Set(operation.Policy, operation.Key, operation.RedisKey, operation.Payload);
                legacyLatencies[offset + index] = Stopwatch.GetTimestamp() - startedAt;
            }
        });

        Parallel.For(0, workerCount, worker =>
        {
            int offset = worker * OperationsPerWorker;
            for (int index = 0; index < OperationsPerWorker; index++)
            {
                Operation operation = operations[worker][index];
                long startedAt = Stopwatch.GetTimestamp();
                current.TrySetOwned(operation.Policy, operation.Key, operation.RedisKey, operation.Payload);
                currentLatencies[offset + index] = Stopwatch.GetTimestamp() - startedAt;
            }
        });

        CacheL1PolicyResidencySnapshot[] snapshots = current.SnapshotPolicyResidency().ToArray();
        return new ContentionReceipt(
            workerCount,
            ToMicroseconds(Percentile(legacyLatencies, 0.99)),
            ToMicroseconds(Percentile(currentLatencies, 0.99)),
            snapshots.Sum(static snapshot => snapshot.ContendedLockWaitTicks),
            snapshots.Sum(static snapshot => snapshot.Entries),
            snapshots.Sum(static snapshot => snapshot.LogicalBytes),
            snapshots.Sum(static snapshot => snapshot.CapacityBytes));
    }

    private static long Percentile(long[] values, double percentile)
    {
        Array.Sort(values);
        int index = Math.Clamp((int)Math.Ceiling(values.Length * percentile) - 1, 0, values.Length - 1);
        return values[index];
    }

    private static double ToMicroseconds(long ticks)
        => ticks * 1_000_000d / Stopwatch.Frequency;

    private static CachePolicy Policy(CachePolicyId id, int workerCount)
        => new(
            id,
            "profile",
            id.ToString(),
            TimeSpan.FromMinutes(5),
            TimeSpan.FromMinutes(30),
            L1MaxEntries: workerCount,
            L1MaxLogicalBytes: workerCount * 32L,
            L1MaxCapacityBytes: checked(workerCount * (32L + 512L)));

    private readonly record struct Operation(
        CachePolicy Policy,
        CacheL1Key Key,
        string RedisKey,
        byte[] Payload);

    private sealed class MultiPolicyRegistry(params CachePolicy[] policies) : ICachePolicyRegistry
    {
        private readonly IReadOnlyDictionary<CachePolicyId, CachePolicy> _policies =
            policies.ToDictionary(static policy => policy.Id);

        public bool TryGet(CachePolicyId id, out CachePolicy policy)
            => _policies.TryGetValue(id, out policy!);
    }

    private sealed record ContentionReceipt(
        int WorkerCount,
        double LegacyP99Microseconds,
        double CurrentP99Microseconds,
        long CurrentContendedLockWaitTicks,
        long CurrentEntries,
        long CurrentLogicalBytes,
        long CurrentCapacityBytes);
}

[Config(typeof(CacheL1TelemetryPercentileConfig))]
[MemoryDiagnoser]
public class UnifiedCacheL1TelemetryHotPathBenchmarks
{
    private const int Identity = 42;
    private readonly CachePolicyRegistry _policies = new();
    private readonly DefaultRuntimeKeyScope _scope = new();
    private readonly MemoryCache _memory = new(new MemoryCacheOptions());
    private UnifiedCache _cache = null!;
    private ParameterizedCacheTelemetry _telemetry = null!;

    [Params(16, 64, 256)]
    public int DurationSampleRate
    {
        get; set;
    }

    [GlobalSetup]
    public void Setup()
    {
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
            _policies,
            _scope,
            NullLogger<CacheKeyResolver>.Instance);
        _telemetry = new ParameterizedCacheTelemetry(DurationSampleRate);
        _cache = new UnifiedCache(
            _memory,
            new PolicyShardedCacheL1Store(_policies),
            redis,
            _policies,
            _scope,
            keyResolver,
            new CacheSingleFlightCoordinator(keyResolver),
            _telemetry,
            NullLogger<UnifiedCache>.Instance);
        _cache.SetRawAsync(CachePolicyId.ArticleDetail, Identity, [1, 2, 3, 4]).GetAwaiter().GetResult();
        _cache.SetRawAsync(CachePolicyId.ArticleHot, Identity, [5, 6, 7, 8]).GetAwaiter().GetResult();
        _cache.SetRawAsync(CachePolicyId.SystemSeo, Identity, [9, 10, 11, 12]).GetAwaiter().GetResult();

        using var writer = new AedsFrameBufferWriter(256);
        writer.Write([13, 14, 15, 16]);
        writer.Seal(AedsFrameType.ArticleDetail);
        _cache.SetOwnedFrameAsync(
                CachePolicyId.ArticleDetailFrame,
                Identity,
                writer.DetachOwnedFrame())
            .GetAwaiter()
            .GetResult();
    }

    [Benchmark]
    public Task<CacheReadResult<int>> TypedHit()
        => _cache.TryGetAsync(
            CachePolicyId.ArticleDetail,
            Identity,
            static bytes => (true, bytes.Length));

    [Benchmark]
    public Task<CacheReadResult<byte[]>> RawHit()
        => _cache.TryGetRawAsync(CachePolicyId.ArticleHot, Identity);

    [Benchmark]
    public Task<CacheReadResult<ReadOnlyMemory<byte>>> ReadonlyHit()
        => _cache.TryGetRawReadonlyAsync(CachePolicyId.SystemSeo, Identity);

    [Benchmark]
    public async Task<int> OwnedFrameHit()
    {
        OwnedFrameCacheReadResult read = await _cache.TryGetOwnedFrameAsync(
            CachePolicyId.ArticleDetailFrame,
            Identity,
            AedsFrameType.ArticleDetail);
        using OwnedAedsFrameReadLease lease = read.Lease!;
        return lease.Length;
    }

    [GlobalCleanup]
    public void Cleanup()
    {
        _cache.Dispose();
        _memory.Dispose();
    }

    private sealed class ParameterizedCacheTelemetry(int sampleRate) : ICacheTelemetry
    {
        private readonly int _sampleRate = sampleRate;
        private long _sequence;
        private long _count;

        public void RecordOperation(string operation, string policy, string layer, string outcome, TimeSpan elapsed)
        {
        }

        public CacheL1HitObservation BeginL1Hit(CachePolicyId policyId, CacheL1Operation operation)
        {
            bool sampled = CacheL1SamplingGate.ShouldSample(ref _sequence, _sampleRate);
            return sampled ? new CacheL1HitObservation(true, Stopwatch.GetTimestamp()) : default;
        }

        public void RecordL1Hit(
            CachePolicyId policyId,
            CacheL1Operation operation,
            bool negative,
            CacheL1HitObservation observation)
        {
            Interlocked.Increment(ref _count);
            if (observation.Sampled)
            {
                _ = Stopwatch.GetElapsedTime(observation.StartedAt);
            }
        }
    }
}

public enum CacheTelemetryListenerMode : byte
{
    Disconnected = 0,
    Connected = 1,
    Backpressured = 2
}

[MemoryDiagnoser]
public class CacheL1TelemetryListenerBenchmarks
{
    private MeterListener? _listener;

    [ParamsAllValues]
    public CacheTelemetryListenerMode ListenerMode
    {
        get; set;
    }

    [GlobalSetup]
    public void Setup()
    {
        if (ListenerMode == CacheTelemetryListenerMode.Disconnected)
        {
            return;
        }

        _listener = new MeterListener
        {
            InstrumentPublished = static (instrument, listener) =>
            {
                if (instrument.Meter.Name == FsusObservability.MeterName
                    && instrument.Name.StartsWith("fsus.cache.l1.", StringComparison.Ordinal))
                {
                    listener.EnableMeasurementEvents(instrument);
                }
            }
        };
        _listener.SetMeasurementEventCallback<double>((_, _, _, _) =>
        {
            if (ListenerMode == CacheTelemetryListenerMode.Backpressured)
            {
                Thread.SpinWait(256);
            }
        });
        _listener.Start();
    }

    [Benchmark]
    public int PreboundSampledHit()
    {
        CacheL1HitObservation observation = FsusObservability.BeginCacheL1Hit(
            CachePolicyId.ArticleDetail,
            CacheL1Operation.Typed);
        FsusObservability.RecordCacheL1Hit(
            CachePolicyId.ArticleDetail,
            CacheL1Operation.Typed,
            negative: false,
            observation);
        return observation.Sampled ? 1 : 0;
    }

    [GlobalCleanup]
    public void Cleanup() => _listener?.Dispose();
}

[MemoryDiagnoser]
public class CspNonceHtmlHotPathBenchmarks
{
    private const string LegacyPlaceholder = "%%FSUSBLOG_CSP_NONCE%%";
    private const string Nonce = "benchmark_nonce_0123456789";
    private readonly byte[] _legacyTemplateBytes;
    private readonly byte[] _nonceBytes = Encoding.UTF8.GetBytes(Nonce);
    private readonly CspNonceUtf8Template _template;
    private readonly ReusableBufferWriter _writer;

    public CspNonceHtmlHotPathBenchmarks()
    {
        string html = CreateRepresentativeHtml();
        _template = CspNonceUtf8Template.Compile(html, "benchmark:renderer:frontend:digest")
            ?? throw new InvalidOperationException("benchmark HTML did not produce a nonce template");
        string legacyTemplate = html
            .Replace("<head>", $"<head><meta property=\"csp-nonce\" nonce=\"{LegacyPlaceholder}\" />", StringComparison.Ordinal)
            .Replace("<script", $"<script nonce=\"{LegacyPlaceholder}\"", StringComparison.Ordinal)
            .Replace("<style", $"<style nonce=\"{LegacyPlaceholder}\"", StringComparison.Ordinal);
        _legacyTemplateBytes = Encoding.UTF8.GetBytes(legacyTemplate);
        _writer = new ReusableBufferWriter(_template.GetRenderedLength(_nonceBytes.Length));
    }

    [Benchmark(Baseline = true)]
    public int Legacy_DecodeReplaceEncodeWholeDocument()
    {
        string decoded = Encoding.UTF8.GetString(_legacyTemplateBytes);
        string rendered = decoded.Replace(LegacyPlaceholder, Nonce, StringComparison.Ordinal);
        return Encoding.UTF8.GetBytes(rendered).Length;
    }

    [Benchmark]
    public int Current_PrecompiledSegmentWriter()
    {
        _writer.Reset();
        _template.Write(_writer, _nonceBytes);
        return _writer.WrittenCount;
    }

    internal static string CreateRepresentativeHtml()
    {
        var builder = new StringBuilder(160 * 1024);
        builder.Append("<!doctype html><html><head><title>FsusBlog 性能🙂</title><style>.article{line-height:1.7}</style></head><body>");
        for (int index = 0; index < 1800; index++)
        {
            builder.Append("<p data-index=\"");
            builder.Append(index);
            builder.Append("\">public article content 中文🙂 cache hydration benchmark segment</p>");
        }

        builder.Append("<script>globalThis.__FSUSBLOG_BOOTSTRAP__={ready:true}</script></body></html>");
        return builder.ToString();
    }

    private sealed class ReusableBufferWriter(int capacity) : IBufferWriter<byte>
    {
        private readonly byte[] _buffer = new byte[capacity];
        private int _written;

        public int WrittenCount => _written;

        public void Reset() => _written = 0;

        public void Advance(int count)
        {
            if (count < 0 || _written > _buffer.Length - count)
            {
                throw new InvalidOperationException("benchmark writer capacity exceeded");
            }

            _written += count;
        }

        public Memory<byte> GetMemory(int sizeHint = 0)
        {
            EnsureCapacity(sizeHint);
            return _buffer.AsMemory(_written);
        }

        public Span<byte> GetSpan(int sizeHint = 0)
        {
            EnsureCapacity(sizeHint);
            return _buffer.AsSpan(_written);
        }

        private void EnsureCapacity(int sizeHint)
        {
            if (sizeHint < 0 || _written > _buffer.Length - sizeHint)
            {
                throw new InvalidOperationException("benchmark writer capacity exceeded");
            }
        }
    }
}

[MemoryDiagnoser]
public class RequestAuditHotPathBenchmarks
{
    private const string UserAgent = "Mozilla/5.0 FsusBlog benchmark client";
    private readonly DefaultHttpContext _context = CreateContext();

    [Benchmark(Baseline = true)]
    public int Legacy_DictionaryAndStringHash()
    {
        var properties = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["TraceId"] = _context.TraceIdentifier,
            ["RequestPath"] = _context.Request.Path.Value,
            ["RequestMethod"] = _context.Request.Method,
            ["IpHash"] = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(_context.Connection.RemoteIpAddress!.ToString()))),
            ["UserAgentHash"] = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(UserAgent)))
        };
        return properties.Count;
    }

    [Benchmark]
    public int Current_ContextSnapshot()
    {
        RequestAuditContextSnapshot snapshot = RequestAuditContextSnapshot.FromHttpContext(_context);
        return snapshot.ActorType.Length + (snapshot.IpHash?.Length ?? 0) + (snapshot.UserAgentHash?.Length ?? 0);
    }

    private static DefaultHttpContext CreateContext()
    {
        var context = new DefaultHttpContext();
        context.TraceIdentifier = "benchmark-trace";
        context.Request.Method = HttpMethods.Post;
        context.Request.Path = "/api/binary/comment";
        context.Request.Headers.UserAgent = UserAgent;
        context.Connection.RemoteIpAddress = IPAddress.Parse("203.0.113.9");
        return context;
    }
}

[MemoryDiagnoser]
public class BinaryTransportHotPathBenchmarks
{
    private readonly IAedsEncoder _encoder = new AedsEncoder();
    private readonly BinaryRequestBinder _binder = new();
    private readonly byte[] _payload = Encoding.UTF8.GetBytes(new string('x', 512));
    private readonly byte[] _frame;

    public BinaryTransportHotPathBenchmarks()
    {
        _frame = _encoder.Encode(AedsFrameType.SiteSubscriptionRequest, _payload);
    }

    [Benchmark(Baseline = true)]
    public int Legacy_EncodeWithIntermediateCopies()
    {
        byte[] payloadCopy = _payload.ToArray();
        byte[] frame = _encoder.Encode(AedsFrameType.SiteSubscriptionRequest, payloadCopy);
        return frame.ToArray().Length;
    }

    [Benchmark]
    public int Current_EncodeFrame()
        => _encoder.Encode(AedsFrameType.SiteSubscriptionRequest, _payload).Length;

    [Benchmark]
    public async Task<int> Current_BindPipeReaderFrame()
    {
        var context = new DefaultHttpContext();
        context.Request.ContentType = "application/octet-stream";
        context.Request.ContentLength = _frame.Length;
        context.Request.Body = new MemoryStream(_frame, writable: false);
        BinaryRequestPayload result = await _binder.ReadFrameAsync(
            context,
            _encoder,
            AedsFrameType.SiteSubscriptionRequest,
            CancellationToken.None);
        await context.Response.CompleteAsync();
        return result.IsSuccess ? result.Payload.Length : -1;
    }
}

[MemoryDiagnoser]
public class NotificationStreamHotPathBenchmarks
{
    private const string Group = "benchmark-hot-path";
    private readonly NotificationStreamConnectionManager _manager;
    private readonly NotificationStreamConnection[] _connections;
    private readonly byte[] _payload = Encoding.UTF8.GetBytes(new string('n', 256));

    public NotificationStreamHotPathBenchmarks()
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["NotificationStream:QueueCapacity"] = "64",
                ["NotificationStream:MaxConnectionsGlobal"] = "64",
                ["NotificationStream:MaxConnectionsPerIp"] = "64",
                ["NotificationStream:MaxConnectionsPerAccount"] = "2"
            })
            .Build();
        _manager = new NotificationStreamConnectionManager(
            configuration,
            NullLogger<NotificationStreamConnectionManager>.Instance);
        _connections = Enumerable.Range(0, 32)
            .Select(index => _manager.RegisterConnection(
                $"benchmark-{index}",
                $"account-{index}",
                [Group],
                clientIp: "203.0.113.8"))
            .ToArray();
    }

    [Benchmark(Baseline = true)]
    public int Legacy_CopyPerSubscriber()
    {
        int deliveredBytes = 0;
        for (int i = 0; i < _connections.Length; i++)
        {
            deliveredBytes += _payload.ToArray().Length;
        }
        return deliveredBytes;
    }

    [Benchmark]
    public int Current_SharedFrameFanout()
    {
        SharedNotificationStreamFrame frame = SharedNotificationStreamFrame.FromArray(_payload);
        int delivered = _manager.Publish(frame, new NotificationStreamGroupTarget(Group));
        foreach (NotificationStreamConnection connection in _connections)
        {
            if (connection.Reader.TryRead(out SharedNotificationStreamFrame? queued))
            {
                connection.AcknowledgeDequeuedFrame();
                queued.Release();
            }
        }
        frame.Release();
        return delivered;
    }

    [Benchmark]
    public int Current_FramePump()
    {
        var connection = new NotificationStreamConnection("pump", null, [], 32);
        SharedNotificationStreamFrame frame = SharedNotificationStreamFrame.FromArray(_payload);
        frame.Retain();
        connection.TryEnqueue(frame);
        connection.Reader.TryRead(out SharedNotificationStreamFrame? queued);
        PipeWriter writer = PipeWriter.Create(Stream.Null, new StreamPipeWriterOptions(leaveOpen: true));
        int written = NotificationStreamFramePump.WriteDequeuedFrame(writer, connection, queued!);
        frame.Release();
        return written;
    }
}

[MemoryDiagnoser]
public class ReadModelProjectionHotPathBenchmarks
{
    private readonly ArticleListPageReadModel _page = new()
    {
        Total = 64,
        HasMore = true,
        NextCursor = "benchmark-cursor",
        Items = Enumerable.Range(1, 64).Select(static id => new ArticleListItemReadModel
        {
            Id = id,
            Title = $"Article {id}",
            Summary = "summary",
            Snippet = "snippet",
            Views = id * 10,
            CreateTime = DateTime.UnixEpoch.AddDays(id),
            CategoryId = id % 5,
            CategoryName = $"Category {id % 5}",
            Tags = [new TagReadModel { Id = id, Name = "benchmark" }],
            Status = ArticleStatus.Published
        }).ToList()
    };

    [Benchmark(Baseline = true)]
    public int Legacy_LinqProjection()
        => _page.Items.Select(ArticleProjection.ToResponse).ToList().Count;

    [Benchmark]
    public int Current_PreSizedProjection()
        => ArticleProjection.ToResponsePage(_page).Items.Count;
}

[MemoryDiagnoser]
public class RelatedReadingHotPathBenchmarks
{
    private const string Title = "PostgreSQL cache concurrency and binary transport";
    private const string Summary = "Notification fanout and related reading scoring";
    private readonly string[] _keywords = RelatedReadingService.ExtractKeywords(Title, Summary);

    [Benchmark(Baseline = true)]
    public int Legacy_SplitAndContainsScoring()
    {
        string[] words = string.Concat(Title, " ", Summary)
            .ToLowerInvariant()
            .Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return words.Count(word => Summary.Contains(word, StringComparison.OrdinalIgnoreCase));
    }

    [Benchmark]
    public int Current_BoundedScoring()
    {
        RelatedReadingBenchmarkResult result = RelatedReadingService.ScoreCandidateForBenchmark(
            2,
            DateTime.UnixEpoch.AddDays(100),
            [1, 2, 3],
            2,
            DateTime.UnixEpoch.AddDays(96),
            [2, 3, 4],
            Title,
            Summary,
            _keywords);
        return result.Score;
    }
}

[MemoryDiagnoser]
public class StatsProjectionHotPathBenchmarks
{
    private static readonly DateTime s_createdAt = DateTime.UnixEpoch.AddDays(20_000);

    [Benchmark(Baseline = true)]
    public int Legacy_DictionaryProjection()
    {
        var item = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["author"] = "Benchmark User",
            ["mode"] = "anonymous",
            ["badge"] = "访客",
            ["content"] = "benchmark comment",
            ["createdAt"] = s_createdAt
        };
        return item.Count;
    }

    [Benchmark]
    public int Current_ValueProjection()
    {
        var item = StatsService.CreateRecentCommentStatItem(
            "anonymous",
            null,
            "Benchmark User",
            "site",
            "benchmark comment",
            s_createdAt);
        return item.Content.Length + item.AuthorDisplayName.Length;
    }
}

[MemoryDiagnoser]
public class CrawlerNormalizationHotPathBenchmarks
{
    private const string UserAgent = "Mozilla/5.0 \u200BGoogleBot/2.1 (+https://www.google.com/bot.html)";

    [Benchmark(Baseline = true)]
    public int Legacy_ReplaceAndLowercase()
        => UserAgent.Replace("\u200B", string.Empty, StringComparison.Ordinal).ToLowerInvariant().Length;

    [Benchmark]
    public int Current_BoundedNormalization()
        => CrawlerDetectorService.NormalizeCrawlerUserAgent(UserAgent).Length;
}
