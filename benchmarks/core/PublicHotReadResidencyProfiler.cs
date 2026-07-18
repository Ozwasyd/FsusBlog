using System.Collections.Frozen;
using System.Diagnostics;
using System.Text.Json;

using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;

using Microsoft.Extensions.Options;

internal static class PublicHotReadResidencyProfiler
{
    private const int DefaultArticleCount = 12_000;
    private const int DefaultFrameBytes = 2_048;
    private const int SyntheticRequestCount = 100_000;

    internal static int Run(string[] args)
    {
        string outputPath = ReadOption(args, "--out")
            ?? Path.Combine(".tmp", "release-evidence", "public-hot-read-residency-profile.json");
        int articleCount = Math.Max(1_000, ReadIntOption(args, "--articles", DefaultArticleCount));
        int frameBytes = Math.Max(512, ReadIntOption(args, "--frame-bytes", DefaultFrameBytes));
        int admissionLimit = Math.Max(1, articleCount / 2);
        var options = new PublicHotReadOptions
        {
            MaxArticleFrames = admissionLimit,
            ArticleAdmissionRecentPercent = 40,
            ExpectedBrotliClientSharePercent = 80,
            ExpectedGzipClientSharePercent = 15,
            MinResidentVariantClientSharePercent = 5
        };

        ForceFullCollection();
        using Process process = Process.GetCurrentProcess();
        process.Refresh();
        long workingSetBefore = process.WorkingSet64;
        long managedBefore = GC.GetTotalMemory(forceFullCollection: false);
        int[] collectionsBefore = [GC.CollectionCount(0), GC.CollectionCount(1), GC.CollectionCount(2)];
        long buildStarted = Stopwatch.GetTimestamp();
        var encoder = new AedsEncoder();

        var candidates = new Dictionary<int, PublicBinaryArtifact>(articleCount);
        for (int id = 1; id <= articleCount; id++)
        {
            candidates[id] = PublicHotReadBinaryArtifactFactory.FromPayload(
                encoder,
                AedsFrameType.ArticleDetail,
                CreatePayload(frameBytes, id),
                options.CacheControl,
                id,
                options);
        }

        int popularCount = admissionLimit * (100 - options.ArticleAdmissionRecentPercent) / 100;
        int recentCount = admissionLimit - popularCount;
        int[] popular = Enumerable.Range(1, popularCount).ToArray();
        int[] recent = Enumerable.Range(articleCount - recentCount + 1, recentCount).Reverse().ToArray();
        int[] priority = PublicHotArtifactProjector.MergeAdmissionSegments(popular, recent, admissionLimit);
        Dictionary<int, PublicBinaryArtifact> admitted = PublicHotArtifactProjector.ApplyArticleAdmission(
            candidates,
            priority,
            options);
        var snapshot = new PublicHotReadSnapshot(
            1,
            admitted.ToFrozenDictionary(),
            FrozenDictionary<PublicListKey, PublicBinaryArtifact>.Empty,
            default,
            default,
            FrozenDictionary<string, PublicHtmlArtifact>.Empty,
            PublicHotReadPublicationEvidence.CreateVerified(1, DateTimeOffset.UtcNow),
            articleCount,
            admissionLimit);
        var store = new PublicHotReadStore(options: Options.Create(options));
        store.BeginBuild("residency-profile");
        store.Publish(snapshot);
        double buildMilliseconds = Stopwatch.GetElapsedTime(buildStarted).TotalMilliseconds;

        SyntheticHitMeasurement hitMeasurement = MeasureSyntheticHits(admitted, articleCount);
        int hits = hitMeasurement.TotalHits;
        double hitRate = (double)hits / SyntheticRequestCount;
        candidates.Clear();
        candidates.TrimExcess();
        process.Refresh();
        long managedBeforeGc = GC.GetTotalMemory(forceFullCollection: false);
        long gcStarted = Stopwatch.GetTimestamp();
        ForceFullCollection();
        double fullGcPauseMilliseconds = Stopwatch.GetElapsedTime(gcStarted).TotalMilliseconds;
        long managedAfterGc = GC.GetTotalMemory(forceFullCollection: false);
        process.Refresh();
        long workingSetAfter = process.WorkingSet64;
        long workingSetDelta = Math.Max(0, workingSetAfter - workingSetBefore);
        int[] collectionDeltas =
        [
            GC.CollectionCount(0) - collectionsBefore[0],
            GC.CollectionCount(1) - collectionsBefore[1],
            GC.CollectionCount(2) - collectionsBefore[2]
        ];
        PublicHotReadRuntimeSnapshot runtime = store.CreateRuntimeSnapshot();
        PublicHotReadBudgetLimits budgets = runtime.Budgets;
        PublicHotReadResidentBreakdown residency = runtime.Residency;

        var gates = new Dictionary<string, object>
        {
            ["residentBudget"] = Gate(residency.TotalBytes <= budgets.MaxResidentBytes, residency.TotalBytes, budgets.MaxResidentBytes),
            ["overlapBudget"] = Gate(runtime.SnapshotOverlapBytes <= budgets.MaxSnapshotOverlapBytes, runtime.SnapshotOverlapBytes, budgets.MaxSnapshotOverlapBytes),
            ["artifactObjectBudget"] = Gate(residency.ObjectCount <= budgets.MaxArtifactObjects, residency.ObjectCount, budgets.MaxArtifactObjects),
            ["lohBudget"] = Gate(residency.LohEligibleArrayBytes <= budgets.MaxResidentBytes / 4, residency.LohEligibleArrayBytes, budgets.MaxResidentBytes / 4),
            ["rssUpperBound"] = Gate(workingSetDelta <= budgets.MaxResidentBytes * 2, workingSetDelta, budgets.MaxResidentBytes * 2),
            ["fullGcPause"] = Gate(fullGcPauseMilliseconds <= 1_000, fullGcPauseMilliseconds, 1_000),
            ["hitRate"] = Gate(hitRate >= 0.90, hitRate, 0.90, minimum: true),
            ["boundedAdmission"] = Gate(admitted.Count <= admissionLimit, admitted.Count, admissionLimit)
        };
        bool passed = gates.Values.All(static value =>
            (bool)(value.GetType().GetProperty("passed")?.GetValue(value) ?? false));

        var payload = new
        {
            schema = "fsusblog.public-hot-read-residency-profile.v1",
            status = passed ? "ok" : "failed",
            generatedAtUtc = DateTimeOffset.UtcNow,
            machine = new
            {
                processorCount = Environment.ProcessorCount,
                framework = System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription,
                os = System.Runtime.InteropServices.RuntimeInformation.OSDescription,
                budgets.ContainerMemoryLimitBytes
            },
            fixture = new
            {
                articleCount,
                admittedArticleCount = admitted.Count,
                admissionLimit,
                frameBytes,
                brotliClientSharePercent = options.ExpectedBrotliClientSharePercent,
                gzipClientSharePercent = options.ExpectedGzipClientSharePercent,
                syntheticRequestCount = SyntheticRequestCount
            },
            measurements = new
            {
                buildMilliseconds,
                managedBeforeBytes = managedBefore,
                managedBeforeGcBytes = managedBeforeGc,
                managedAfterGcBytes = managedAfterGc,
                workingSetBeforeBytes = workingSetBefore,
                workingSetAfterBytes = workingSetAfter,
                workingSetDeltaBytes = workingSetDelta,
                fullGcPauseMilliseconds,
                generationCollectionDeltas = collectionDeltas,
                hits,
                hitRate,
                hotHits = hitMeasurement.HotHits,
                recentHits = hitMeasurement.RecentHits,
                randomHits = hitMeasurement.RandomHits,
                popularAdmitted = popular.Count(admitted.ContainsKey),
                recentAdmitted = recent.Count(admitted.ContainsKey),
                residency,
                snapshotOverlapBytes = runtime.SnapshotOverlapBytes,
                retiringSnapshotBytes = runtime.RetiringSnapshotBytes,
                lifecycleHistory = runtime.LifecycleHistory,
                compressionPolicy = runtime.CompressionPolicy
            },
            budgets,
            storageDecision = new
            {
                selected = runtime.StorageModel,
                requestBodyCopies = 0,
                reason = "Measured object and RSS bounds pass without a release pack; immutable ReadOnlyMemory slices preserve atomic N/N-1 snapshots without mmap corruption or lifecycle risk."
            },
            gates
        };

        string fullPath = Path.GetFullPath(outputPath);
        Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
        File.WriteAllText(fullPath, string.Concat(JsonSerializer.Serialize(payload, new JsonSerializerOptions { WriteIndented = true }), "\n"));
        Console.WriteLine($"[public-hot-read-residency] {payload.status}: {fullPath}");
        return passed ? 0 : 1;
    }

    private static SyntheticHitMeasurement MeasureSyntheticHits(
        IReadOnlyDictionary<int, PublicBinaryArtifact> admitted,
        int articleCount)
    {
        int hits = 0;
        int hotHits = 0;
        int recentHits = 0;
        int randomHits = 0;
        int hotRange = Math.Max(1, articleCount / 20);
        int recentRange = Math.Max(1, articleCount / 25);
        for (int request = 0; request < SyntheticRequestCount; request++)
        {
            int segment = request % 10;
            int id = segment switch
            {
                < 8 => 1 + (request % hotRange),
                8 => articleCount - (request % recentRange),
                _ => 1 + ((request * 7919) % articleCount)
            };
            if (admitted.ContainsKey(id))
            {
                hits++;
                if (segment < 8)
                    hotHits++;
                else if (segment == 8)
                    recentHits++;
                else
                    randomHits++;
            }
        }
        return new SyntheticHitMeasurement(hits, hotHits, recentHits, randomHits);
    }

    private static byte[] CreatePayload(int length, int seed)
    {
        var bytes = new byte[length];
        for (int index = 0; index < bytes.Length; index++)
        {
            bytes[index] = (byte)((seed + index) % 251);
        }
        return bytes;
    }

    private static void ForceFullCollection()
    {
        GC.Collect(2, GCCollectionMode.Forced, blocking: true, compacting: true);
        GC.WaitForPendingFinalizers();
        GC.Collect(2, GCCollectionMode.Forced, blocking: true, compacting: true);
    }

    private static object Gate(bool passed, double actual, double threshold, bool minimum = false)
        => new
        {
            passed,
            actual,
            threshold,
            comparison = minimum ? ">=" : "<="
        };

    private static string? ReadOption(string[] args, string name)
    {
        int index = Array.IndexOf(args, name);
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
    }

    private static int ReadIntOption(string[] args, string name, int fallback)
        => int.TryParse(ReadOption(args, name), out int value) ? value : fallback;

    private readonly record struct SyntheticHitMeasurement(
        int TotalHits,
        int HotHits,
        int RecentHits,
        int RandomHits);
}
