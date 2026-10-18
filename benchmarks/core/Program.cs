using System.Buffers;
using System.Diagnostics;
using System.IO.Compression;
using System.Net.Http.Headers;
using System.Reflection;
using System.Runtime;
using System.Runtime.InteropServices;
using System.Runtime.Intrinsics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using BenchmarkDotNet.Attributes;
using BenchmarkDotNet.Configs;
using BenchmarkDotNet.Jobs;
using BenchmarkDotNet.Loggers;
using BenchmarkDotNet.Running;
using BenchmarkDotNet.Toolchains.InProcess.NoEmit;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Shared.Contracts.Outputs;

if (args.Contains("--verify-contract", StringComparer.Ordinal))
{
    return ContractVerifier.Run();
}

if (args.Contains("--compare-http", StringComparer.Ordinal))
{
    return await HttpParityVerifier.RunAsync(args);
}

if (args.Contains("--aeds-frame-cost", StringComparer.Ordinal))
{
    return AedsFrameCostProfiler.Run(args);
}

if (args.Contains("--aeds-cache-miss-frame-cost", StringComparer.Ordinal))
{
    return AedsCacheMissFrameProfiler.Run(args);
}

if (args.Contains("--aeds-compression-profile", StringComparer.Ordinal))
{
    return AedsCompressionProfiler.Run(args);
}

if (args.Contains("--csp-nonce-profile", StringComparer.Ordinal))
{
    return CspNonceTemplateProfiler.Run(args);
}

if (args.Contains("--public-hot-read-residency-profile", StringComparer.Ordinal))
{
    return PublicHotReadResidencyProfiler.Run(args);
}

if (args.Contains("--cache-l1-contention-profile", StringComparer.Ordinal))
{
    return CacheL1ContentionProfiler.Run();
}

if (args.Contains("--pod-binary-codec-batch-profile", StringComparer.Ordinal))
{
    return PodBinaryCodecBatchProfiler.Run(args);
}

if (args.Contains("--perception-character-v3-pool-issue-profile", StringComparer.Ordinal))
{
    return PerceptionCharacterV3PoolIssueProfiler.Run(args);
}

var benchmarkJob = string.Equals(
    Environment.GetEnvironmentVariable("FSUSBLOG_BENCHMARK_IN_PROCESS_NO_EMIT"),
    "1",
    StringComparison.Ordinal)
    ? Job.ShortRun.WithToolchain(InProcessNoEmitToolchain.Instance)
    : Job.ShortRun;

var benchmarkConfig = ManualConfig.Create(DefaultConfig.Instance)
    .AddLogger(BenchmarkConsoleLogger.Instance)
    // SqlSugar's package metadata is reported as non-optimized even when this
    // benchmark project and every repository-owned project are built Release.
    // The measured reports and the repository budget checker remain mandatory.
    .WithOptions(ConfigOptions.DisableLogFile | ConfigOptions.DisableOptimizationsValidator);

BenchmarkSwitcher
    .FromTypes([
        typeof(PodMappingBenchmarks),
        typeof(ContentFilterHotPathBenchmarks),
        typeof(RequestAuditHotPathBenchmarks),
        typeof(BinaryTransportHotPathBenchmarks),
        typeof(NotificationStreamHotPathBenchmarks),
        typeof(ReadModelProjectionHotPathBenchmarks),
        typeof(RelatedReadingHotPathBenchmarks),
        typeof(StatsProjectionHotPathBenchmarks),
        typeof(CrawlerNormalizationHotPathBenchmarks),
        typeof(PublicHotReadEarlyDataPlaneBenchmarks),
        typeof(PublicArtifactRevocationHotPathBenchmarks),
        typeof(CacheAndFrameFixedCostHotPathBenchmarks),
        typeof(PolicyShardedCacheL1ResidencyBenchmarks),
        typeof(PolicyShardedCacheL1ContentionBenchmarks),
        typeof(UnifiedCacheL1TelemetryHotPathBenchmarks),
        typeof(UnifiedCacheL1TelemetryIncrementHotPathBenchmarks),
        typeof(CacheL1TelemetryListenerBenchmarks),
        typeof(CacheL1TelemetryExporterBenchmarks),
        typeof(CacheL1TelemetryContentionBenchmarks),
        typeof(SitemapProductionBuildBenchmarks),
        typeof(CspNonceHtmlHotPathBenchmarks),
        typeof(FsusBlog.Core.Benchmarks.AedsAccessProjectionBenchmarks),
        typeof(RateLimiterRejectionSamplerBenchmarks),
        typeof(CompositeAcBenchmarks),
        typeof(DoubleArrayAcBenchmarks),
        typeof(SearchDictionaryLookupBenchmarks)])
    .Run(args, benchmarkConfig.AddJob(benchmarkJob));
return 0;

internal sealed class BenchmarkConsoleLogger : ILogger
{
    private const string UnsupportedPriorityPrefix = "// ! Failed to set up priority High";
    private int _priorityNoteWritten;
    public static readonly ILogger Instance = new BenchmarkConsoleLogger();
    public string Id => nameof(ConsoleLogger);
    public int Priority => 2;
    public void Write(LogKind logKind, string text) => ConsoleLogger.Default.Write(logKind, text);
    public void WriteLine() => ConsoleLogger.Default.WriteLine();
    public void WriteLine(LogKind logKind, string text)
    {
        if (text.StartsWith(UnsupportedPriorityPrefix, StringComparison.Ordinal))
        {
            if (Interlocked.Exchange(ref _priorityNoteWritten, 1) == 0)
            {
                ConsoleLogger.Default.WriteLine(
                    LogKind.Info,
                    "// Benchmark scheduler note: privileged priority elevation is unavailable; configured CPU affinity remains active.");
            }
            return;
        }

        ConsoleLogger.Default.WriteLine(logKind, text);
    }
    public void Flush() => ConsoleLogger.Default.Flush();
}

[MemoryDiagnoser]
public class PodMappingBenchmarks
{
    private readonly string _title = "FsusBlog-Article-Title";
    private readonly string _summary = "High frequency mapping benchmark summary";
    private readonly string _snippet = "This snippet emulates a hot-path list projection.";
    private readonly string _content = new('x', 256);
    private readonly string _displayName = "Benchmark Author";
    private readonly string _authorMode = "anonymous";

    private readonly CorePageResult<ArticleListCoreModel> _pageResult;
    private readonly byte[] _encodedArticlePage;
    private readonly string[] _searchDocuments;
    private readonly Dictionary<string, Dictionary<int, int>> _searchIndex;
    private readonly IAedsEncoder _aedsEncoder;
    private readonly AedsDecoderValidator _aedsValidator;

    public PodMappingBenchmarks()
    {
        _aedsEncoder = new AedsEncoder();
        _aedsValidator = new AedsDecoderValidator(_aedsEncoder);

        var pod = PodProjector.ProjectArticleList(1, 99, DateTime.UtcNow, 2, "分类", _title, _summary, false, out _);
        _pageResult = new CorePageResult<ArticleListCoreModel>(
            [new ArticleListCoreModel(
                pod,
                1,
                _title,
                _summary,
                null,
                _snippet,
                99,
                DateTime.UtcNow,
                new ArticleCategoryCoreModel(2, "分类"),
                [new TagCoreModel(10, "tag-a")],
                false)],
            1);
        _encodedArticlePage = PodBinaryCodec.EncodeArticlePage(_pageResult);
        _searchDocuments = Enumerable.Range(0, 256)
            .Select(i => $"fsus blog search benchmark document {i} category {(i % 8)} tag {(i % 13)} content token {(i % 21)}")
            .ToArray();
        _searchIndex = BuildSyntheticSearchIndex(_searchDocuments);
    }

    [Benchmark(Baseline = true)]
    public int LegacyLike_StringOnly()
    {
        string t = _title;
        string s = _summary;
        string n = _snippet;
        return t.Length + s.Length + n.Length;
    }

    [Benchmark]
    public int ArticleList_PodProjection()
    {
        var pod = PodProjector.ProjectArticleList(1, 99, DateTime.UtcNow, 2, "分类", _title, _summary, false, out var payload);
        return payload.Length + pod.GetHashCode();
    }

    [Benchmark]
    public int CommentItem_PodProjection()
    {
        var pod = PodProjector.ProjectCommentItem(1001, DateTime.UtcNow, _authorMode, _displayName, _content, out var payload);
        return payload.Length + pod.GetHashCode();
    }

    [Benchmark]
    public int Stats_PodProjection()
    {
        var pod = PodProjector.ProjectSiteStats(100, 200, 10, 10000, 6000, 4000, 6000, 4000, 5, 5, 8);
        return pod.GetHashCode() + (Vector256.IsHardwareAccelerated ? 1 : 0);
    }

    [Benchmark]
    public int ArticlePage_PodBinary_RoundTrip()
    {
        byte[] bytes = PodBinaryCodec.EncodeArticlePage(_pageResult);
        bool ok = PodBinaryCodec.TryDecodeArticlePage(bytes, out var result);
        return ok ? result.Items.Count : 0;
    }

    [Benchmark]
    public int CacheHit_ArticlePageDecode()
    {
        bool ok = PodBinaryCodec.TryDecodeArticlePage(_encodedArticlePage, out var result);
        return ok ? result.Items.Count : 0;
    }

    [Benchmark]
    public int CacheHit_RawDefensiveCopy_L1()
    {
        byte[] callerOwned = _encodedArticlePage.ToArray();
        return callerOwned.Length;
    }

    [Benchmark]
    public int CacheHit_RawReadonly_L1()
    {
        ReadOnlyMemory<byte> readonlyPayload = _encodedArticlePage;
        return readonlyPayload.Length;
    }

    [Benchmark]
    public int Aeds_Encode_ArticleList()
    {
        byte[] payload = PodBinaryCodec.EncodeArticlePage(_pageResult);
        byte[] frame = _aedsEncoder.Encode(AedsFrameType.ArticleList, payload);
        return frame.Length;
    }

    [Benchmark]
    public int Aeds_Decode_ArticleList()
    {
        byte[] payload = PodBinaryCodec.EncodeArticlePage(_pageResult);
        byte[] frame = _aedsEncoder.Encode(AedsFrameType.ArticleList, payload);
        var decoded = _aedsEncoder.TryDecode(frame);
        return decoded.IsSuccess ? decoded.Value.Payload.Length : 0;
    }

    [Benchmark]
    public int Aeds_RoundTrip_Validate()
    {
        byte[] payload = PodBinaryCodec.EncodeArticlePage(_pageResult);
        var result = _aedsValidator.ValidateRoundTrip(AedsFrameType.ArticleList, payload);
        return result.IsSuccess ? payload.Length : 0;
    }

    [Benchmark]
    public int Aeds_Dynamic_TwoBuffer_WriteFrame()
    {
        using var payload = new PooledByteBufferWriter(1024);
        PodBinaryCodec.WriteArticlePage(_pageResult, payload);
        var frame = new ArrayBufferWriter<byte>(payload.WrittenCount + AedsFrameHeader.Size);
        _aedsEncoder.WriteFrame(AedsFrameType.ArticleList, payload.WrittenSpan, frame);
        return frame.WrittenCount;
    }

    [Benchmark]
    public int Aeds_Dynamic_SingleBuffer_FrameWriter()
    {
        using var frame = new AedsFrameBufferWriter(1024);
        PodBinaryCodec.WriteArticlePage(_pageResult, frame.PayloadWriter);
        frame.Seal(AedsFrameType.ArticleList);
        return frame.WrittenFrame.Length;
    }

    [Benchmark]
    public int SearchRebuild_SyntheticInvertedIndex()
    {
        Dictionary<string, Dictionary<int, int>> index = BuildSyntheticSearchIndex(_searchDocuments);
        return index.Count;
    }

    [Benchmark]
    public double SearchQuery_SyntheticBm25()
        => QuerySyntheticSearchIndex(_searchIndex, _searchDocuments, ["fsus", "benchmark", "token"]);

    private static Dictionary<string, Dictionary<int, int>> BuildSyntheticSearchIndex(IReadOnlyList<string> documents)
    {
        var index = new Dictionary<string, Dictionary<int, int>>(StringComparer.Ordinal);
        for (int docId = 0; docId < documents.Count; docId++)
        {
            foreach (string token in documents[docId].Split(' ', StringSplitOptions.RemoveEmptyEntries))
            {
                string normalized = token.ToLowerInvariant();
                if (!index.TryGetValue(normalized, out Dictionary<int, int>? postings))
                {
                    postings = [];
                    index[normalized] = postings;
                }

                postings.TryGetValue(docId, out int tf);
                postings[docId] = tf + 1;
            }
        }

        return index;
    }

    private static double QuerySyntheticSearchIndex(
        IReadOnlyDictionary<string, Dictionary<int, int>> index,
        IReadOnlyList<string> documents,
        IReadOnlyList<string> queryTokens)
    {
        double score = 0d;
        double averageLength = documents.Average(static document => document.Length);
        foreach (string token in queryTokens)
        {
            if (!index.TryGetValue(token, out Dictionary<int, int>? postings))
            {
                continue;
            }

            foreach ((int docId, int tf) in postings)
            {
                double idf = Math.Log(1d + ((documents.Count - postings.Count + 0.5d) / (postings.Count + 0.5d)));
                double norm = 1.2d * (1d - 0.75d + (0.75d * documents[docId].Length / Math.Max(averageLength, 1d)));
                score += idf * ((tf * 2.2d) / (tf + norm));
            }
        }

        return score;
    }
}

internal static class AedsFrameCostProfiler
{
    public static int Run(string[] args)
    {
        string outFile = ProfilerSupport.OptionValue(args, "--out", ".tmp/perf/aeds-frame-cost/summary.json");
        int iterations = Math.Max(10, ProfilerSupport.IntOptionValue(args, "--iterations", 80));
        int warmupIterations = Math.Max(1, ProfilerSupport.IntOptionValue(args, "--warmup-iterations", 8));
        int roundCount = Math.Max(1, ProfilerSupport.IntOptionValue(args, "--rounds", 5));
        string commitSha = ProfilerSupport.OptionValue(args, "--commit-sha", string.Empty).Trim().ToLowerInvariant();
        string repoRoot = Path.GetFullPath(ProfilerSupport.OptionValue(args, "--repo-root", Directory.GetCurrentDirectory()));
        var authorityBlockedReasons = ProfilerSupport.OptionValues(args, "--authority-blocked-reason").ToList();
        string? cpuIdentity = ProfilerSupport.ReadCpuIdentity();
        string? affinity = ProfilerSupport.ReadProcessorAffinity();
        string assemblyPath = Assembly.GetExecutingAssembly().Location;
        string coreAssemblyPath = typeof(AedsEncoder).Assembly.Location;
        AedsArtifactIdentity[] artifacts =
        [
            ProfilerSupport.ArtifactIdentity("benchmark", repoRoot, assemblyPath),
            ProfilerSupport.ArtifactIdentity("core", repoRoot, coreAssemblyPath)
        ];
        string artifactSetCanonical = JsonSerializer.Serialize(artifacts
            .OrderBy(static artifact => artifact.Id, StringComparer.Ordinal)
            .Select(static artifact => new
            {
                id = artifact.Id,
                path = artifact.Path,
                bytes = artifact.Bytes,
                sha256 = artifact.Sha256
            }));
        string artifactSetDigest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(artifactSetCanonical))).ToLowerInvariant();
#if DEBUG
        const string BuildConfiguration = "Debug";
#else
        const string BuildConfiguration = "Release";
#endif

        if (!ProfilerSupport.IsCommitSha(commitSha))
        {
            authorityBlockedReasons.Add("missing-or-invalid-commit-sha");
        }
        if (string.IsNullOrWhiteSpace(cpuIdentity))
        {
            authorityBlockedReasons.Add("cpu-identity-unavailable");
        }
        if (string.IsNullOrWhiteSpace(affinity))
        {
            authorityBlockedReasons.Add("processor-affinity-unavailable");
        }
        if (!string.Equals(BuildConfiguration, "Release", StringComparison.Ordinal))
        {
            authorityBlockedReasons.Add("non-release-artifact");
        }

        var encoder = new AedsEncoder();
        var structuralResults = new List<object>();
        var measuredResults = new List<object>();

        foreach (var scenario in ProfilerSupport.BuildFrameScenarios(includeTinyFrames: true))
        {
            int MeasureTwoBuffer()
            {
                var payload = new ArrayBufferWriter<byte>(Math.Max(1, scenario.Payload.Length));
                payload.Write(scenario.Payload);
                var frame = new ArrayBufferWriter<byte>(payload.WrittenCount + AedsFrameHeader.Size);
                encoder.WriteFrame(scenario.FrameType, payload.WrittenSpan, frame);
                return frame.WrittenCount;
            }

            int MeasureSingleBuffer()
            {
                using var frame = new AedsFrameBufferWriter(Math.Max(256, scenario.Payload.Length + AedsFrameHeader.Size));
                frame.PayloadWriter.Write(scenario.Payload);
                frame.Seal(scenario.FrameType);
                return frame.WrittenFrame.Length;
            }

            var twoBufferRounds = new List<ProfileMeasurement>(roundCount);
            var singleBufferRounds = new List<ProfileMeasurement>(roundCount);
            var crcRounds = new List<ProfileMeasurement>(roundCount);
            for (int round = 0; round < roundCount; round++)
            {
                // Alternate the order to avoid consistently assigning process warm-up or scheduler
                // drift to one implementation.
                if (round % 2 == 0)
                {
                    twoBufferRounds.Add(ProfilerSupport.Measure(iterations, warmupIterations, MeasureTwoBuffer));
                    singleBufferRounds.Add(ProfilerSupport.Measure(iterations, warmupIterations, MeasureSingleBuffer));
                }
                else
                {
                    singleBufferRounds.Add(ProfilerSupport.Measure(iterations, warmupIterations, MeasureSingleBuffer));
                    twoBufferRounds.Add(ProfilerSupport.Measure(iterations, warmupIterations, MeasureTwoBuffer));
                }
                crcRounds.Add(ProfilerSupport.Measure(iterations, warmupIterations, () => AedsCrc16.Compute(scenario.Payload)));
            }

            ProfileAggregate twoBuffer = ProfilerSupport.Aggregate(twoBufferRounds);
            ProfileAggregate singleBuffer = ProfilerSupport.Aggregate(singleBufferRounds);
            ProfileAggregate crc = ProfilerSupport.Aggregate(crcRounds);

            structuralResults.Add(new
            {
                scenario = scenario.Name,
                frameType = scenario.FrameType.ToString(),
                pathGroup = scenario.PathGroup,
                itemCount = scenario.ItemCount,
                rawPayloadBytes = scenario.Payload.Length,
                copyCountBefore = scenario.Payload.Length == 0 ? 0 : 1,
                copyCountAfter = 0,
                copyBytesBefore = scenario.Payload.Length,
                copyBytesAfter = 0,
                derivation = scenario.Payload.Length == 0
                    ? "static/pre-encoded frame has no dynamic payload copy"
                    : "old path materializes payload then copies payload.Length bytes into the frame; the reserved-header writer seals in place",
                counterKind = "implementation-derived-payload-length",
                hardwareCounter = false
            });

            measuredResults.Add(new
            {
                scenario = scenario.Name,
                frameType = scenario.FrameType.ToString(),
                pathGroup = scenario.PathGroup,
                itemCount = scenario.ItemCount,
                rawPayloadBytes = scenario.Payload.Length,
                rawFrameBytes = singleBuffer.LastValue,
                before = ProfilerSupport.ToEvidence(twoBuffer, twoBufferRounds),
                after = ProfilerSupport.ToEvidence(singleBuffer, singleBufferRounds),
                crc = ProfilerSupport.ToEvidence(crc, crcRounds),
                variability = new
                {
                    beforeP95RangeMs = ProfilerSupport.RoundMetric(twoBuffer.P95MaxMs - twoBuffer.P95MinMs),
                    afterP95RangeMs = ProfilerSupport.RoundMetric(singleBuffer.P95MaxMs - singleBuffer.P95MinMs),
                    beforeCoefficientOfVariation = twoBuffer.CoefficientOfVariation,
                    afterCoefficientOfVariation = singleBuffer.CoefficientOfVariation
                }
            });
        }

        var summary = new
        {
            schema = "fsusblog.aeds-frame-cost.raw.v2",
            status = "raw",
            conclusionsFinalized = false,
            generatedAt = DateTimeOffset.UtcNow,
            measurementSource = "local-aeds-frame-cost-profiler",
            source = new
            {
                commitSha,
                buildConfiguration = BuildConfiguration,
                artifactSet = new
                {
                    schema = "fsusblog.aeds-frame-cost-artifact-set.v1",
                    digest = $"sha256:{artifactSetDigest}",
                    artifacts = artifacts.Select(static artifact => new
                    {
                        id = artifact.Id,
                        path = artifact.Path,
                        bytes = artifact.Bytes,
                        sha256 = artifact.Sha256
                    }).ToArray()
                }
            },
            implementation = new
            {
                dynamicWriter = nameof(AedsFrameBufferWriter),
                oldPath = "payload-buffer-then-AedsEncoder.WriteFrame",
                newPath = "reserved-header-single-pooled-frame-buffer"
            },
            structuralEvidence = new
            {
                evidenceKind = "executable-implementation-derivation",
                copyBytesCounterKind = "payload-length-derived-not-hardware-counter",
                results = structuralResults
            },
            measuredEvidence = new
            {
                evidenceKind = "same-process-release-artifact-multi-round",
                authority = new
                {
                    authoritative = authorityBlockedReasons.Count == 0,
                    blockedReasons = authorityBlockedReasons.Distinct(StringComparer.Ordinal).Order().ToArray()
                },
                environment = new
                {
                    machineName = Environment.MachineName,
                    cpu = cpuIdentity,
                    os = RuntimeInformation.OSDescription,
                    osArchitecture = RuntimeInformation.OSArchitecture.ToString(),
                    processArchitecture = RuntimeInformation.ProcessArchitecture.ToString(),
                    processorCount = Environment.ProcessorCount,
                    runtime = RuntimeInformation.FrameworkDescription,
                    runtimeVersion = Environment.Version.ToString(),
                    gc = new
                    {
                        server = GCSettings.IsServerGC,
                        latencyMode = GCSettings.LatencyMode.ToString()
                    },
                    affinity
                },
                method = new
                {
                    warmupIterations,
                    iterationsPerRound = iterations,
                    roundCount,
                    sampleCountPerVariant = iterations * roundCount,
                    ordering = "alternating-before-after-by-round",
                    authoritativeMeanAggregation = "median-of-round-means",
                    authoritativeP95Aggregation = "median-of-round-p95"
                },
                results = measuredResults
            }
        };

        ProfilerSupport.WriteJson(outFile, summary);
        Console.WriteLine($"[aeds-frame-cost] wrote {outFile}");
        return 0;
    }
}

internal static class AedsCompressionProfiler
{
    public static int Run(string[] args)
    {
        string outFile = ProfilerSupport.OptionValue(args, "--out", ".tmp/perf/aeds-compression-profile/summary.json");
        var encoder = new AedsEncoder();
        var results = new List<object>();

        foreach (var scenario in ProfilerSupport.BuildFrameScenarios(includeTinyFrames: false))
        {
            byte[] frame = encoder.Encode(scenario.FrameType, scenario.Payload);
            foreach ((string variant, string contentEncoding, byte[] encoded) in new[]
                     {
                         ("br", "br", ProfilerSupport.CompressBrotli(frame)),
                         ("gzip", "gzip", ProfilerSupport.CompressGzip(frame))
                     })
            {
                results.Add(new
                {
                    scenario = scenario.Name,
                    frameType = scenario.FrameType.ToString(),
                    itemCount = scenario.ItemCount,
                    variant,
                    contentEncoding,
                    rawFrameBytes = frame.Length,
                    encodedFrameBytes = encoded.Length,
                    ratio = Math.Round((double)encoded.Length / frame.Length, 4),
                    bytesSaved = frame.Length - encoded.Length,
                    etag = ProfilerSupport.StrongETag(encoded),
                    selectedByHotRead = encoded.Length < frame.Length,
                    status = encoded.Length < frame.Length ? "ok" : "blocked"
                });
            }
        }

        var summary = new
        {
            status = results.All(static result =>
                result.GetType().GetProperty("status")?.GetValue(result)?.Equals("ok") == true)
                ? "ok"
                : "blocked",
            generatedAt = DateTimeOffset.UtcNow,
            measurementSource = "local-aeds-compression-profiler",
            transportCompression = "artifact-level-precompression",
            results
        };

        ProfilerSupport.WriteJson(outFile, summary);
        Console.WriteLine($"[aeds-compression-profile] wrote {outFile}");
        return summary.status == "ok" ? 0 : 1;
    }
}

internal static class ProfilerSupport
{
    public static IReadOnlyList<AedsFrameScenario> BuildFrameScenarios(bool includeTinyFrames)
    {
        var scenarios = new List<AedsFrameScenario>();
        if (includeTinyFrames)
        {
            scenarios.Add(new("EmptySuccess", AedsFrameType.EmptySuccess, [], 0, "static-preencoded"));
            scenarios.Add(new("ApiError", AedsFrameType.ApiError, Payload("ApiError", 768, 1), 1, "tiny-dynamic"));
        }

        scenarios.Add(new("ArticleList10", AedsFrameType.ArticleList, ArticleListPayload(10), 10, "representative-dynamic"));
        scenarios.Add(new("ArticleList50", AedsFrameType.ArticleList, ArticleListPayload(50), 50, "representative-dynamic"));
        scenarios.Add(new("ArticleList100", AedsFrameType.ArticleList, ArticleListPayload(100), 100, "representative-dynamic"));
        scenarios.Add(new("ArticleDetailSmall", AedsFrameType.ArticleDetail, Payload("ArticleDetailSmall", 12 * 1024, 1), 1, "supplemental-dynamic"));
        scenarios.Add(new("ArticleDetailMedium", AedsFrameType.ArticleDetail, Payload("ArticleDetailMedium", 80 * 1024, 1), 1, "supplemental-dynamic"));
        scenarios.Add(new("ArticleDetailLarge", AedsFrameType.ArticleDetail, Payload("ArticleDetailLarge", 320 * 1024, 1), 1, "representative-dynamic"));
        scenarios.Add(new("CommentCursor", AedsFrameType.CommentArticleCursor, RepeatedRows("CommentCursor", 40, 256), 40, "representative-dynamic"));
        scenarios.Add(new("ConversationDetail", AedsFrameType.ConversationDetail, RepeatedRows("ConversationDetail", 64, 512), 64, "representative-dynamic"));
        scenarios.Add(new("UploadStatus", AedsFrameType.UploadStatus, Payload("UploadStatus", 2 * 1024, 1), 1, "supplemental-dynamic"));
        scenarios.Add(new("PublicAotBootstrap", AedsFrameType.PublicAotBootstrap, Payload("PublicAotBootstrap", 96 * 1024, 1), 1, "representative-dynamic"));
        return scenarios;
    }

    public static ProfileMeasurement Measure(int iterations, int warmupIterations, Func<int> action)
    {
        for (int i = 0; i < warmupIterations; i++)
        {
            _ = action();
        }

        var samples = new double[iterations];
        long allocatedBefore = GC.GetAllocatedBytesForCurrentThread();
        int lastValue = 0;
        for (int i = 0; i < iterations; i++)
        {
            long start = Stopwatch.GetTimestamp();
            lastValue = action();
            samples[i] = Math.Max(Stopwatch.GetElapsedTime(start).TotalMilliseconds, 0.0001d);
        }

        long allocatedAfter = GC.GetAllocatedBytesForCurrentThread();
        double[] orderedSamples = samples.Order().ToArray();
        long allocatedBytesTotal = Math.Max(0, allocatedAfter - allocatedBefore);
        return new ProfileMeasurement(
            AverageMs: RoundMetric(ArithmeticMean(samples)),
            P50Ms: Percentile(orderedSamples, 0.50d),
            P95Ms: Percentile(orderedSamples, 0.95d),
            StandardDeviationMs: StandardDeviation(samples),
            AllocatedBytesTotal: allocatedBytesTotal,
            AllocatedBytesPerIteration: allocatedBytesTotal / Math.Max(1, iterations),
            LastValue: lastValue,
            Samples: samples);
    }

    public static ProfileAggregate Aggregate(IReadOnlyList<ProfileMeasurement> rounds)
    {
        double[] samples = rounds.SelectMany(static round => round.Samples).ToArray();
        double[] orderedSamples = samples.Order().ToArray();
        double[] roundMeans = rounds.Select(static round => round.AverageMs).Order().ToArray();
        double[] roundP95s = rounds.Select(static round => round.P95Ms).Order().ToArray();
        long[] allocations = rounds.Select(static round => round.AllocatedBytesPerIteration).Order().ToArray();
        double arithmeticMean = ArithmeticMean(samples);
        double standardDeviation = StandardDeviationRaw(samples);
        return new ProfileAggregate(
            AverageMs: roundMeans[roundMeans.Length / 2],
            ArithmeticMeanMs: RoundMetric(arithmeticMean),
            P50Ms: Percentile(orderedSamples, 0.50d),
            P95Ms: roundP95s[roundP95s.Length / 2],
            PooledP95Ms: Percentile(orderedSamples, 0.95d),
            StandardDeviationMs: RoundMetric(standardDeviation),
            CoefficientOfVariation: arithmeticMean > 0 ? RoundMetric(standardDeviation / arithmeticMean) : 0,
            AllocatedBytesPerIteration: allocations[allocations.Length / 2],
            AllocationMinBytes: allocations[0],
            AllocationMaxBytes: allocations[^1],
            P95MinMs: rounds.Min(static round => round.P95Ms),
            P95MaxMs: rounds.Max(static round => round.P95Ms),
            LastValue: rounds[^1].LastValue,
            SampleCount: samples.Length);
    }

    public static object ToEvidence(ProfileAggregate aggregate, IReadOnlyList<ProfileMeasurement> rounds)
        => new
        {
            meanMs = aggregate.AverageMs,
            arithmeticMeanMs = aggregate.ArithmeticMeanMs,
            meanAggregation = "median-of-round-means",
            p50Ms = aggregate.P50Ms,
            p95Ms = aggregate.P95Ms,
            pooledP95Ms = aggregate.PooledP95Ms,
            p95Aggregation = "median-of-round-p95",
            standardDeviationMs = aggregate.StandardDeviationMs,
            allocationBytesPerRequest = aggregate.AllocatedBytesPerIteration,
            sampleCount = aggregate.SampleCount,
            rounds = rounds.Select((round, index) => new
            {
                round = index + 1,
                meanMs = round.AverageMs,
                p50Ms = round.P50Ms,
                p95Ms = round.P95Ms,
                standardDeviationMs = round.StandardDeviationMs,
                sampleCount = round.Samples.Length,
                samplesMs = round.Samples,
                allocatedBytesTotal = round.AllocatedBytesTotal,
                allocationBytesPerRequest = round.AllocatedBytesPerIteration
            }).ToArray(),
            allocationRangeBytes = new
            {
                min = aggregate.AllocationMinBytes,
                max = aggregate.AllocationMaxBytes
            }
        };

    public static IReadOnlyList<string> OptionValues(string[] args, string name)
    {
        var values = new List<string>();
        for (int index = 0; index + 1 < args.Length; index++)
        {
            if (string.Equals(args[index], name, StringComparison.Ordinal))
            {
                values.Add(args[index + 1]);
                index++;
            }
        }
        return values;
    }

    public static bool IsCommitSha(string value)
        => value.Length == 40 && value.All(static character => char.IsAsciiHexDigit(character));

    public static AedsArtifactIdentity ArtifactIdentity(string id, string repoRoot, string artifactPath)
    {
        string fullRoot = Path.GetFullPath(repoRoot);
        string fullPath = Path.GetFullPath(artifactPath);
        string relativePath = Path.GetRelativePath(fullRoot, fullPath).Replace(Path.DirectorySeparatorChar, '/');
        if (relativePath == ".." || relativePath.StartsWith("../", StringComparison.Ordinal))
        {
            throw new InvalidOperationException($"AEDS frame-cost artifact {fullPath} is outside repo root {fullRoot}");
        }
        byte[] bytes = File.ReadAllBytes(fullPath);
        return new AedsArtifactIdentity(
            id,
            relativePath,
            bytes.LongLength,
            $"sha256:{Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant()}");
    }

    public static string? ReadCpuIdentity()
    {
        if (OperatingSystem.IsLinux() && File.Exists("/proc/cpuinfo"))
        {
            string? model = File.ReadLines("/proc/cpuinfo")
                .FirstOrDefault(static line => line.StartsWith("model name", StringComparison.OrdinalIgnoreCase));
            if (model is not null)
            {
                int separator = model.IndexOf(':', StringComparison.Ordinal);
                if (separator >= 0)
                {
                    return model[(separator + 1)..].Trim();
                }
            }
        }
        return Environment.GetEnvironmentVariable("PROCESSOR_IDENTIFIER");
    }

    public static string? ReadProcessorAffinity()
    {
        if (OperatingSystem.IsLinux() && File.Exists("/proc/self/status"))
        {
            string? value = File.ReadLines("/proc/self/status")
                .FirstOrDefault(static line => line.StartsWith("Cpus_allowed_list:", StringComparison.Ordinal));
            return value?.Split(':', 2)[1].Trim();
        }

        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsWindows())
        {
            return null;
        }

        try
        {
            using Process process = Process.GetCurrentProcess();
            return $"0x{process.ProcessorAffinity.ToInt64():x}";
        }
        catch (Exception exception) when (exception is PlatformNotSupportedException or InvalidOperationException)
        {
            return null;
        }
    }

    private const double MetricScale = 1_000_000d;

    public static double RoundMetric(double value)
        => Math.Floor(value * MetricScale + 0.5d) / MetricScale;

    private static double Percentile(IReadOnlyList<double> sortedSamples, double percentile)
        => RoundMetric(sortedSamples[Math.Min(sortedSamples.Count - 1, (int)Math.Ceiling(sortedSamples.Count * percentile) - 1)]);

    private static double StandardDeviation(IReadOnlyList<double> samples)
        => RoundMetric(StandardDeviationRaw(samples));

    private static double ArithmeticMean(IReadOnlyList<double> samples)
    {
        double total = 0;
        for (int index = 0; index < samples.Count; index++)
        {
            total += samples[index];
        }
        return total / samples.Count;
    }

    private static double StandardDeviationRaw(IReadOnlyList<double> samples)
    {
        double average = ArithmeticMean(samples);
        double squaredDifferenceTotal = 0;
        for (int index = 0; index < samples.Count; index++)
        {
            double difference = samples[index] - average;
            squaredDifferenceTotal += difference * difference;
        }
        return Math.Sqrt(squaredDifferenceTotal / samples.Count);
    }

    public static byte[] CompressBrotli(byte[] bytes)
    {
        using var output = new MemoryStream();
        using (var stream = new BrotliStream(output, CompressionLevel.SmallestSize, leaveOpen: true))
        {
            stream.Write(bytes);
        }

        return output.ToArray();
    }

    public static byte[] CompressGzip(byte[] bytes)
    {
        using var output = new MemoryStream();
        using (var stream = new GZipStream(output, CompressionLevel.SmallestSize, leaveOpen: true))
        {
            stream.Write(bytes);
        }

        return output.ToArray();
    }

    public static string StrongETag(byte[] bytes)
        => $"\"sha256-{Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant()}\"";

    public static string OptionValue(string[] args, string name, string fallback)
    {
        int index = Array.IndexOf(args, name);
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : fallback;
    }

    public static int IntOptionValue(string[] args, string name, int fallback)
        => int.TryParse(OptionValue(args, name, string.Empty), out int value) ? value : fallback;

    public static void WriteJson(string outFile, object value)
    {
        string fullPath = Path.GetFullPath(outFile);
        Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
        File.WriteAllText(fullPath, $"{JsonSerializer.Serialize(value, new JsonSerializerOptions { WriteIndented = true })}\n");
    }

    private static byte[] ArticleListPayload(int count)
        => RepeatedRows("ArticleList", count, 384);

    private static byte[] RepeatedRows(string label, int rowCount, int rowBytes)
    {
        var builder = new StringBuilder(rowCount * rowBytes);
        for (int i = 0; i < rowCount; i++)
        {
            builder.Append(label)
                .Append("|category=engineering|tags=aeds,binary,fsus|title=")
                .Append(i)
                .Append('|')
                .Append("This row intentionally repeats category and tag strings so dictionary and transport compression evidence has stable signal. ");
            while (Encoding.UTF8.GetByteCount(builder.ToString()) < (i + 1) * rowBytes)
            {
                builder.Append("payload text repeat ");
            }
            builder.Append('\n');
        }

        return Encoding.UTF8.GetBytes(builder.ToString());
    }

    private static byte[] Payload(string label, int targetBytes, int itemCount)
    {
        var builder = new StringBuilder(targetBytes);
        while (Encoding.UTF8.GetByteCount(builder.ToString()) < targetBytes)
        {
            builder.Append(label)
                .Append("|item-count=")
                .Append(itemCount)
                .Append("|markdown=AEDS frame payload repeated text for stable compression and CRC benchmarking.\n");
        }

        return Encoding.UTF8.GetBytes(builder.ToString())[..targetBytes];
    }
}

internal readonly record struct AedsFrameScenario(string Name, AedsFrameType FrameType, byte[] Payload, int ItemCount, string PathGroup);

internal readonly record struct ProfileMeasurement(
    double AverageMs,
    double P50Ms,
    double P95Ms,
    double StandardDeviationMs,
    long AllocatedBytesTotal,
    long AllocatedBytesPerIteration,
    int LastValue,
    double[] Samples);

internal readonly record struct ProfileAggregate(
    double AverageMs,
    double ArithmeticMeanMs,
    double P50Ms,
    double P95Ms,
    double PooledP95Ms,
    double StandardDeviationMs,
    double CoefficientOfVariation,
    long AllocatedBytesPerIteration,
    long AllocationMinBytes,
    long AllocationMaxBytes,
    double P95MinMs,
    double P95MaxMs,
    int LastValue,
    int SampleCount);

internal readonly record struct AedsArtifactIdentity(string Id, string Path, long Bytes, string Sha256);

internal static class ContractVerifier
{
    public static int Run()
    {
        bool articleOk = VerifyArticle();
        bool commentOk = VerifyComment();
        bool statsOk = VerifyStats();
        bool semanticOk = VerifySemanticParity();
        Console.WriteLine($"contract_verify article={articleOk} comment={commentOk} stats={statsOk} semantic={semanticOk}");
        return articleOk && commentOk && statsOk && semanticOk ? 0 : 1;
    }

    private static bool VerifyArticle()
    {
        var pod = PodProjector.ProjectArticleList(11, 23, DateTime.UnixEpoch.AddDays(3), 7, "cat", "title", "summary", false, out _);
        var page = new CorePageResult<ArticleListCoreModel>(
            [new ArticleListCoreModel(
                pod,
                11,
                "title",
                "summary",
                null,
                "snippet",
                23,
                DateTime.UnixEpoch.AddDays(3),
                new ArticleCategoryCoreModel(7, "cat"),
                [new TagCoreModel(2, "tag-a")],
                false)],
            1);

        byte[] bytes = PodBinaryCodec.EncodeArticlePage(page);
        bool ok = PodBinaryCodec.TryDecodeArticlePage(bytes, out var decoded);
        return ok && decoded.Total == 1 && decoded.Items.Count == 1 && decoded.Items[0].Id == 11 && decoded.Items[0].Tags.Count == 1;
    }

    private static bool VerifyComment()
    {
        var author = new CommentAuthorViewDto("anonymous", "Benchmark Author", "zh-CN", null, null);
        var pod = PodProjector.ProjectCommentItem(101, DateTime.UnixEpoch.AddMinutes(9), author.Mode, author.DisplayName, "hello", out _);
        var source = new CoreCursorResult<CommentQueryCoreModel>(
            [new CommentQueryCoreModel(pod, 101, "hello", DateTime.UnixEpoch.AddMinutes(9), author)],
            999,
            true);

        byte[] bytes = PodBinaryCodec.EncodeCommentCursor(source);
        bool ok = PodBinaryCodec.TryDecodeCommentCursor(bytes, out var decoded);
        return ok && decoded.HasMore && decoded.NextCursor == 999 && decoded.Data.Count == 1 && decoded.Data[0].Id == 101;
    }

    private static bool VerifyStats()
    {
        var sitePod = PodProjector.ProjectSiteStats(3, 4, 1, 100, 60, 40, 60, 40, 1, 1, 1);
        var popular = new PopularArticleCoreModel(PodProjector.ProjectPopularArticle(3, "hot", 77), 3, "hot", 77);
        var recent = new RecentCommentCoreModel(
            PodProjector.ProjectRecentComment(DateTime.UnixEpoch.AddDays(1), "Benchmark Author", "anonymous", null, null, "c4", out _),
            "Benchmark Author",
            "anonymous",
            null,
            null,
            "c4",
            DateTime.UnixEpoch.AddDays(1));
        var region = new RegionDistributionCoreModel(PodProjector.ProjectRegionDistribution("CN-SH", 9), "CN-SH", 9);
        var source = new SiteStatsCoreModel(sitePod, 3, 4, 1, 100, 60, 40, 60, 40, [popular], [recent], [region]);

        byte[] bytes = PodBinaryCodec.EncodeSiteStats(source);
        bool ok = PodBinaryCodec.TryDecodeSiteStats(bytes, out var decoded);
        return ok && decoded.TotalArticles == 3 && decoded.PopularArticles.Count == 1 && decoded.RecentComments.Count == 1 && decoded.RegionDistributions.Count == 1;
    }

    private static bool VerifySemanticParity()
    {
        var raw = new ArticleListItemReadModel
        {
            Id = 21,
            Title = "title-x",
            Summary = "summary-x",
            Snippet = "snippet-x",
            Views = 88,
            CreateTime = DateTime.UnixEpoch.AddHours(2),
            CategoryId = 5,
            CategoryName = "cat-x",
            Tags = [new() { Id = 1, Name = "tag-1" }, new() { Id = 2, Name = "tag-2" }],
            IsDeleted = false
        };
        ArticleListCoreModel projected = ArticleProjection.ToCoreListModel(raw);
        if (projected.Summary != raw.Snippet || ArticleProjection.ToResponse(raw).Summary != raw.Snippet)
        {
            return false;
        }
        // Encode the actual producer's output, including its auxiliary fields.
        // The expected v2 wire model has only the selected display Summary;
        // Cover/Snippet remain absent. Do not normalize the decoded result.
        var source = new CorePageResult<ArticleListCoreModel>(
            [projected with { CoverImageUrl = null, Snippet = null }], 1);

        byte[] bytes = PodBinaryCodec.EncodeArticlePage(new CorePageResult<ArticleListCoreModel>([projected], 1));
        bool ok = PodBinaryCodec.TryDecodeArticlePage(bytes, out var decoded);
        if (!ok || decoded.Items.Count != source.Items.Count)
        {
            return false;
        }

        ArticleListCoreModel a = source.Items[0];
        ArticleListCoreModel b = decoded.Items[0];
        return a.Id == b.Id
            && a.Title == b.Title
            && a.Summary == b.Summary
            && a.Snippet == b.Snippet
            && a.Views == b.Views
            && a.Category.Id == b.Category.Id
            && a.Category.Name == b.Category.Name
            && a.Tags.Count == b.Tags.Count
            && a.Tags[0].Name == b.Tags[0].Name
            && a.Tags[1].Name == b.Tags[1].Name;
    }
}

internal static class HttpParityVerifier
{
    public static async Task<int> RunAsync(string[] args)
    {
        string baseUrl = GetArg(args, "--base-url") ?? "http://localhost:5032";
        string? cookie = GetArg(args, "--cookie");

        try
        {
            using var client = new HttpClient { BaseAddress = new Uri(baseUrl, UriKind.Absolute) };
            if (!string.IsNullOrWhiteSpace(cookie))
            {
                client.DefaultRequestHeaders.Add("Cookie", cookie);
            }

            var aeds = new AedsEncoder();
            bool articleListOk = await CompareArticleListAsync(client, aeds);
            bool articleHotOk = await CompareArticleHotAsync(client, aeds);
            bool articleDetailOk = await CompareArticleDetailAsync(client, aeds);
            bool commentCursorOk = await CompareCommentCursorAsync(client, aeds);
            bool statsOk = await CompareStatsAsync(client, aeds);

            Console.WriteLine($"http_parity article_list={articleListOk} article_hot={articleHotOk} article_detail={articleDetailOk} comment_cursor={commentCursorOk} stats={statsOk}");
            return articleListOk && articleHotOk && articleDetailOk && commentCursorOk && statsOk ? 0 : 1;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"http_parity_failed reason={ex.GetType().Name} message={ex.Message}");
            return 2;
        }
    }

    private static async Task<bool> CompareArticleListAsync(HttpClient client, IAedsEncoder aeds)
    {
        string jsonPath = "/api/Article?page=1&size=5&isDeleted=false";
        string binPath = "/api/binary/article?page=1&size=5&isDeleted=false";

        JsonElement? jsonData = await FetchApiDataAsync(client, jsonPath);
        if (jsonData is null || !jsonData.Value.TryGetProperty("items", out JsonElement jsonItems))
        {
            return false;
        }

        var binary = await FetchBinaryPayloadAsync(client, binPath, aeds, AedsFrameType.ArticleList);
        if (!binary.ok)
        {
            return false;
        }

        bool ok = PodBinaryCodec.TryDecodeArticlePage(binary.payload, out var page);
        if (!ok)
        {
            return false;
        }

        int jsonCount = jsonItems.GetArrayLength();
        int podCount = page.Items.Count;
        if (jsonCount != podCount)
        {
            return false;
        }

        if (jsonCount == 0)
        {
            return true;
        }

        JsonElement first = jsonItems[0];
        ArticleListCoreModel pod = page.Items[0];
        return first.GetProperty("id").GetInt32() == pod.Id
            && first.GetProperty("title").GetString() == pod.Title
            && first.GetProperty("views").GetInt32() == pod.Views;
    }

    private static async Task<bool> CompareArticleHotAsync(HttpClient client, IAedsEncoder aeds)
    {
        string jsonPath = "/api/Article/hot?size=5";
        string binPath = "/api/binary/article/hot?size=5";

        JsonElement? jsonData = await FetchApiDataAsync(client, jsonPath);
        if (jsonData is null || jsonData.Value.ValueKind != JsonValueKind.Array)
        {
            return false;
        }

        var binary = await FetchBinaryPayloadAsync(client, binPath, aeds, AedsFrameType.ArticleHot);
        if (!binary.ok)
        {
            return false;
        }

        bool ok = PodBinaryCodec.TryDecodePopularArticles(binary.payload, out var list);
        if (!ok)
        {
            return false;
        }

        if (jsonData.Value.GetArrayLength() != list.Count)
        {
            return false;
        }

        if (list.Count == 0)
        {
            return true;
        }

        JsonElement first = jsonData.Value[0];
        PopularArticleCoreModel pod = list[0];
        return first.GetProperty("id").GetInt32() == pod.Id
            && first.GetProperty("title").GetString() == pod.Title
            && first.GetProperty("views").GetInt32() == pod.Views;
    }

    private static async Task<bool> CompareArticleDetailAsync(HttpClient client, IAedsEncoder aeds)
    {
        JsonElement? listData = await FetchApiDataAsync(client, "/api/Article?page=1&size=5&isDeleted=false");
        if (listData is null || !listData.Value.TryGetProperty("items", out JsonElement items) || items.GetArrayLength() == 0)
        {
            return false;
        }

        int articleId = items[0].GetProperty("id").GetInt32();
        string jsonPath = $"/api/Article/{articleId}";
        string binPath = $"/api/binary/article/{articleId}";

        JsonElement? jsonData = await FetchApiDataAsync(client, jsonPath);
        if (jsonData is null)
        {
            return false;
        }

        var binary = await FetchBinaryPayloadAsync(client, binPath, aeds, AedsFrameType.ArticleDetail);
        if (!binary.ok)
        {
            return false;
        }

        bool ok = PodBinaryCodec.TryDecodeArticleDetail(binary.payload, out var detail);
        if (!ok)
        {
            return false;
        }

        return jsonData.Value.GetProperty("id").GetInt32() == detail.Id
            && jsonData.Value.GetProperty("title").GetString() == detail.Title
            && jsonData.Value.GetProperty("views").GetInt32() == detail.Views;
    }

    private static async Task<bool> CompareCommentCursorAsync(HttpClient client, IAedsEncoder aeds)
    {
        JsonElement? listData = await FetchApiDataAsync(client, "/api/Article?page=1&size=5&isDeleted=false");
        if (listData is null || !listData.Value.TryGetProperty("items", out JsonElement items) || items.GetArrayLength() == 0)
        {
            return false;
        }

        int articleId = items[0].GetProperty("id").GetInt32();
        string jsonPath = $"/api/Comment/{articleId}?limit=5";
        string binPath = $"/api/binary/comment/{articleId}?limit=5";

        JsonElement? jsonData = await FetchApiDataAsync(client, jsonPath);
        if (jsonData is null || !jsonData.Value.TryGetProperty("data", out JsonElement jsonItems))
        {
            return false;
        }

        var binary = await FetchBinaryPayloadAsync(client, binPath, aeds, AedsFrameType.CommentArticleCursor);
        if (!binary.ok)
        {
            return false;
        }

        bool ok = PodBinaryCodec.TryDecodeCommentCursor(binary.payload, out var cursor);
        if (!ok)
        {
            return false;
        }

        int jsonCount = jsonItems.GetArrayLength();
        if (jsonCount != cursor.Data.Count)
        {
            return false;
        }

        if (jsonCount == 0)
        {
            return true;
        }

        JsonElement first = jsonItems[0];
        var pod = cursor.Data[0];
        string jsonId = first.GetProperty("id").GetString() ?? "0";
        bool parsed = long.TryParse(jsonId, out long id);
        return parsed && id == pod.Id
            && first.GetProperty("content").GetString() == pod.Content
            && !string.IsNullOrWhiteSpace(first.GetProperty("author").GetProperty("displayName").GetString());
    }

    private static async Task<bool> CompareStatsAsync(HttpClient client, IAedsEncoder aeds)
    {
        JsonElement? jsonData = await FetchApiDataAsync(client, "/api/Stats");
        if (jsonData is null)
        {
            return false;
        }

        var binary = await FetchBinaryPayloadAsync(client, "/api/binary/stats", aeds, AedsFrameType.AdminStats);
        if (!binary.ok)
        {
            return false;
        }

        bool ok = PodBinaryCodec.TryDecodeSiteStats(binary.payload, out var stats);
        if (!ok)
        {
            return false;
        }

        return jsonData.Value.GetProperty("totalArticles").GetInt32() == stats.TotalArticles
            && jsonData.Value.GetProperty("totalComments").GetInt32() == stats.TotalComments
            && jsonData.Value.GetProperty("trashCount").GetInt32() == stats.TrashCount;
    }

    private static async Task<JsonElement?> FetchApiDataAsync(HttpClient client, string path)
    {
        using var response = await client.GetAsync(path);
        if (!response.IsSuccessStatusCode)
        {
            return null;
        }

        using var stream = await response.Content.ReadAsStreamAsync();
        using JsonDocument doc = await JsonDocument.ParseAsync(stream);

        JsonElement root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("data", out JsonElement data))
        {
            return null;
        }

        return data.Clone();
    }

    private static async Task<(bool ok, byte[] payload)> FetchBinaryPayloadAsync(
        HttpClient client,
        string path,
        IAedsEncoder aeds,
        AedsFrameType expectedFrameType)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, path);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/octet-stream"));
        using var response = await client.SendAsync(request);
        if (!response.IsSuccessStatusCode)
        {
            return (false, []);
        }

        byte[] frame = await response.Content.ReadAsByteArrayAsync();
        var decode = aeds.TryDecode(frame);
        if (!decode.IsSuccess || decode.Value.FrameType != expectedFrameType)
        {
            return (false, []);
        }

        return (true, decode.Value.Payload.ToArray());
    }

    private static string? GetArg(string[] args, string name)
    {
        int idx = Array.IndexOf(args, name);
        if (idx < 0 || idx + 1 >= args.Length)
        {
            return null;
        }

        return args[idx + 1];
    }
}
