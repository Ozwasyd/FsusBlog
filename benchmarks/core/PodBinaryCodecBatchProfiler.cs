using System.Buffers;
using System.Runtime.CompilerServices;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Outputs;
using FsusBlog.Shared.Contracts.Primitives;

internal static partial class PodBinaryCodecBatchProfiler
{
    private const string RebuildFrequencyMetric = "fsus.cache.owned_frame.build.count";

    public static int Run(string[] args)
    {
        string outFile = ProfilerSupport.OptionValue(
            args,
            "--out",
            ".tmp/perf/pod-binary-codec-batch/summary.json");
        int iterations = Math.Max(2, ProfilerSupport.IntOptionValue(args, "--iterations", 3));
        int warmupIterations = Math.Max(1, ProfilerSupport.IntOptionValue(args, "--warmup-iterations", 1));
        int roundCount = Math.Max(3, ProfilerSupport.IntOptionValue(args, "--rounds", 3));

        IReadOnlyList<ArticlePageScenario> pageScenarios = BuildArticlePageScenarios();
        var pageResults = new List<object>(pageScenarios.Count);
        int representativeCount = 0;
        int representativeAllocationWins = 0;
        int smallCount = 0;
        int smallP95WithinPolicy = 0;
        int wireParityCount = 0;

        foreach (ArticlePageScenario scenario in pageScenarios)
        {
            byte[] legacyWire = EncodeArticlePageList(
                scenario.Page,
                exactCapacities: false,
                out CollectionShape legacyShape);
            byte[] exactListWire = EncodeArticlePageList(
                scenario.Page,
                exactCapacities: true,
                out CollectionShape exactListShape);
            byte[] directWire = EncodeArticlePageDirect(scenario.Page);
            byte[] pooledWire = EncodeArticlePagePooled(scenario.Page);
            byte[] adaptiveWire = EncodeArticlePageAdaptive(scenario.Page);
            bool wireParity = legacyWire.AsSpan().SequenceEqual(exactListWire)
                && legacyWire.AsSpan().SequenceEqual(directWire)
                && legacyWire.AsSpan().SequenceEqual(pooledWire)
                && legacyWire.AsSpan().SequenceEqual(adaptiveWire);
            if (!wireParity)
            {
                throw new InvalidOperationException($"Article page candidate wire parity failed: {scenario.Name}");
            }

            wireParityCount++;
            Dictionary<string, List<ProfileMeasurement>> rounds = MeasureArticlePageVariants(
                scenario,
                iterations,
                warmupIterations,
                roundCount);
            ProfileAggregate legacy = ProfilerSupport.Aggregate(rounds["legacy-list"]);
            ProfileAggregate exactList = ProfilerSupport.Aggregate(rounds["exact-capacity-list"]);
            ProfileAggregate direct = ProfilerSupport.Aggregate(rounds["two-pass-direct"]);
            ProfileAggregate pooled = ProfilerSupport.Aggregate(rounds["array-pool-records"]);
            ProfileAggregate adaptive = ProfilerSupport.Aggregate(rounds["adaptive-stack-pool"]);

            if (scenario.ItemCount >= 50)
            {
                representativeCount++;
                if (adaptive.AllocatedBytesPerIteration <= legacy.AllocatedBytesPerIteration * 0.75d)
                {
                    representativeAllocationWins++;
                }
            }

            if (scenario.ItemCount <= 1)
            {
                smallCount++;
                if (WithinSmallLatencyPolicy(adaptive.P95Ms, legacy.P95Ms))
                {
                    smallP95WithinPolicy++;
                }
            }

            int requestedScratchBytes = checked(
                scenario.ItemCount * Unsafe.SizeOf<PodBinaryCodec.ArticlePageItemSlicePlan>()
                + scenario.TagRecordCount * Unsafe.SizeOf<Utf8SliceRef>());
            bool adaptiveUsesStack = requestedScratchBytes <= PodBinaryCodec.ArticlePageStackScratchByteBudget;
            PoolShape poolShape = MeasurePoolShape(scenario.ItemCount, scenario.TagRecordCount);
            pageResults.Add(new
            {
                scenario = scenario.Name,
                itemCount = scenario.ItemCount,
                tagsPerItem = scenario.TagsPerItem,
                tagRecordCount = scenario.TagRecordCount,
                textLength = scenario.TextLength,
                textEncoding = scenario.TextEncoding,
                outputBytes = legacyWire.Length,
                blobBytes = scenario.BlobBytes,
                wireParity,
                encodeFrequency = FrequencyEvidence(),
                variants = new object[]
                {
                    VariantEvidence(
                        "legacy-list",
                        legacy,
                        rounds["legacy-list"],
                        scenario.ItemCount,
                        legacyShape,
                        copyBytes: scenario.BlobBytes,
                        storage: "List<byte> + tag tuple List + item tuple List"),
                    VariantEvidence(
                        "exact-capacity-list",
                        exactList,
                        rounds["exact-capacity-list"],
                        scenario.ItemCount,
                        exactListShape,
                        copyBytes: scenario.BlobBytes,
                        storage: "exact-capacity List<byte> + record Lists"),
                    VariantEvidence(
                        "two-pass-direct",
                        direct,
                        rounds["two-pass-direct"],
                        scenario.ItemCount,
                        CollectionShape.None,
                        copyBytes: 0,
                        storage: "direct destination; offsets recomputed"),
                    VariantEvidence(
                        "array-pool-records",
                        pooled,
                        rounds["array-pool-records"],
                        scenario.ItemCount,
                        scenario.ItemCount == 0
                            ? CollectionShape.None
                            : new CollectionShape(0, 2, poolShape.CapacityWasteBytes, 0, 0, 0),
                        copyBytes: 0,
                        storage: "two pooled packed metadata buffers"),
                    VariantEvidence(
                        "adaptive-stack-pool",
                        adaptive,
                        rounds["adaptive-stack-pool"],
                        scenario.ItemCount,
                        adaptiveUsesStack
                            ? CollectionShape.None
                            : new CollectionShape(0, 2, poolShape.CapacityWasteBytes, 0, 0, 0),
                        copyBytes: 0,
                        storage: adaptiveUsesStack ? "stack scratch" : "array-pool scratch")
                }
            });
        }

        IReadOnlyList<ArticleDetailScenario> detailScenarios = BuildArticleDetailScenarios();
        var detailResults = new List<object>(detailScenarios.Count);
        int detailRepresentativeCount = 0;
        int detailAllocationWins = 0;
        int detailP95WithinPolicy = 0;
        foreach (ArticleDetailScenario scenario in detailScenarios)
        {
            byte[] legacyWire = EncodeArticleDetailLegacy(scenario.Detail);
            byte[] directWire = EncodeArticleDetailAdaptive(scenario.Detail);
            bool wireParity = legacyWire.AsSpan().SequenceEqual(directWire);
            if (!wireParity)
            {
                throw new InvalidOperationException($"Article detail wire parity failed: {scenario.Name}");
            }

            var legacyRounds = new List<ProfileMeasurement>(roundCount);
            var directRounds = new List<ProfileMeasurement>(roundCount);
            for (int round = 0; round < roundCount; round++)
            {
                if ((round & 1) == 0)
                {
                    legacyRounds.Add(ProfilerSupport.Measure(iterations, warmupIterations, () => Consume(EncodeArticleDetailLegacy(scenario.Detail))));
                    directRounds.Add(ProfilerSupport.Measure(iterations, warmupIterations, () => Consume(EncodeArticleDetailAdaptive(scenario.Detail))));
                }
                else
                {
                    directRounds.Add(ProfilerSupport.Measure(iterations, warmupIterations, () => Consume(EncodeArticleDetailAdaptive(scenario.Detail))));
                    legacyRounds.Add(ProfilerSupport.Measure(iterations, warmupIterations, () => Consume(EncodeArticleDetailLegacy(scenario.Detail))));
                }
            }

            ProfileAggregate legacy = ProfilerSupport.Aggregate(legacyRounds);
            ProfileAggregate direct = ProfilerSupport.Aggregate(directRounds);
            bool candidateUsesDirect = scenario.Detail.Content.Length >= PodBinaryCodec.ArticleDetailDirectCharThreshold;
            if (scenario.ContentBytes >= 8 * 1024)
            {
                detailRepresentativeCount++;
                if (direct.AllocatedBytesPerIteration <= legacy.AllocatedBytesPerIteration * 0.80d)
                {
                    detailAllocationWins++;
                }
            }
            if (WithinSmallLatencyPolicy(direct.P95Ms, legacy.P95Ms))
            {
                detailP95WithinPolicy++;
            }

            detailResults.Add(new
            {
                scenario = scenario.Name,
                itemCount = 1,
                tagCount = scenario.TagCount,
                contentBytes = scenario.ContentBytes,
                outputBytes = legacyWire.Length,
                wireParity,
                encodeFrequency = FrequencyEvidence(),
                variants = new object[]
                {
                    VariantEvidence(
                        "legacy-list",
                        legacy,
                        legacyRounds,
                        1,
                        new CollectionShape(2, 0, 0, scenario.ContentBytes, scenario.TagCount, 1),
                        copyBytes: scenario.ContentBytes,
                        storage: "List<byte> + tag record List"),
                    VariantEvidence(
                        "adaptive-detail",
                        direct,
                        directRounds,
                        1,
                        candidateUsesDirect
                            ? CollectionShape.None
                            : new CollectionShape(2, 0, 0, scenario.ContentBytes, scenario.TagCount, 1),
                        copyBytes: candidateUsesDirect ? 0 : scenario.ContentBytes,
                        storage: candidateUsesDirect
                            ? "preplanned slices + direct destination"
                            : "small-payload legacy Lists")
                }
            });
        }

        List<object> auditResults = MeasureAuditScope(iterations, warmupIterations, roundCount)
            .OrderByDescending(static result => result.AllocatedBytesPerFrame)
            .ThenByDescending(static result => result.P95Ms)
            .Select(static result => result.Evidence)
            .ToList();

        bool pageAllocationPolicyMet = representativeCount > 0
            && representativeAllocationWins >= Math.Ceiling(representativeCount * 0.80d);
        bool pageSmallLatencyPolicyMet = smallCount > 0
            && smallP95WithinPolicy >= Math.Ceiling(smallCount * 0.70d);
        bool detailAllocationPolicyMet = detailRepresentativeCount > 0
            && detailAllocationWins == detailRepresentativeCount;
        bool detailLatencyPolicyMet = detailP95WithinPolicy == detailScenarios.Count;
        bool pageSelected = wireParityCount == pageScenarios.Count
            && pageAllocationPolicyMet
            && pageSmallLatencyPolicyMet;
        bool detailSelected = detailAllocationPolicyMet && detailLatencyPolicyMet;

        var summary = new
        {
            schema = "fsusblog.pod-binary-codec-batch.v1",
            status = "ok",
            generatedAt = DateTimeOffset.UtcNow,
            measurementSource = "local-real-codec-profiler",
            method = new
            {
                warmupIterations,
                iterationsPerRound = iterations,
                roundCount,
                ordering = "rotating-candidate-order",
                allocationCounter = "GC.GetAllocatedBytesForCurrentThread",
                latency = "Stopwatch per full payload encode",
                scenarioCount = pageScenarios.Count,
                articleListMatrix = "5 item counts x 3 tag counts x 3 lengths x 3 UTF-8 classes"
            },
            policy = new
            {
                articlePageRepresentativeAllocation = "at least 80% of 50/100-item scenarios reduce allocation by at least 25%",
                articlePageSmallLatency = "at least 70% of 0/1-item scenarios keep p95 within 10% or a 0.002 ms absolute tiny-operation band",
                articleDetailAllocation = "all medium/large detail scenarios reduce allocation by at least 20%",
                articleDetailLatency = "all detail scenarios keep p95 within 10% or a 0.002 ms absolute tiny-operation band",
                wireParityRequired = true
            },
            recommendation = new
            {
                articlePage = new
                {
                    selected = pageSelected ? "adaptive-stack-pool" : "legacy-list",
                    pageAllocationPolicyMet,
                    pageSmallLatencyPolicyMet,
                    representativeAllocationWins,
                    representativeCount,
                    smallP95WithinPolicy,
                    smallCount
                },
                articleDetail = new
                {
                    selected = detailSelected ? "adaptive-detail" : "legacy-list",
                    detailAllocationPolicyMet,
                    detailLatencyPolicyMet,
                    detailAllocationWins,
                    detailRepresentativeCount,
                    detailP95WithinPolicy,
                    scenarioCount = detailScenarios.Count
                },
                unchangedAfterAudit = new[]
                {
                    "CommentCursor",
                    "UserCommentCursor",
                    "CommentReplyCursor",
                    "CommentThreadCursor",
                    "ConversationDetail",
                    "ConversationList",
                    "SiteStats",
                    "CategoryList",
                    "TagWithCountList"
                },
                unchangedReason = "baseline-only audit; lower-priority paths were not mechanically rewritten without candidate-specific threshold evidence"
            },
            runtimeClaim = new
            {
                affectedPath = "cache miss and background rebuild encoding",
                cacheHitQpsClaimed = false,
                productionFrequencyMetric = RebuildFrequencyMetric
            },
            articlePageResults = pageResults,
            articleDetailResults = detailResults,
            auditResults
        };

        ProfilerSupport.WriteJson(outFile, summary);
        Console.WriteLine($"[pod-binary-codec-batch] wrote {outFile}");
        Console.WriteLine($"[pod-binary-codec-batch] article-page={summary.recommendation.articlePage.selected} article-detail={summary.recommendation.articleDetail.selected}");
        return 0;
    }

    private static Dictionary<string, List<ProfileMeasurement>> MeasureArticlePageVariants(
        ArticlePageScenario scenario,
        int iterations,
        int warmupIterations,
        int roundCount)
    {
        string[] variants =
        [
            "legacy-list",
            "exact-capacity-list",
            "two-pass-direct",
            "array-pool-records",
            "adaptive-stack-pool"
        ];
        var rounds = variants.ToDictionary(
            static name => name,
            _ => new List<ProfileMeasurement>(roundCount),
            StringComparer.Ordinal);
        for (int round = 0; round < roundCount; round++)
        {
            for (int offset = 0; offset < variants.Length; offset++)
            {
                string variant = variants[(round + offset) % variants.Length];
                rounds[variant].Add(ProfilerSupport.Measure(
                    iterations,
                    warmupIterations,
                    variant switch
                    {
                        "legacy-list" => () => Consume(EncodeArticlePageList(scenario.Page, false, out _)),
                        "exact-capacity-list" => () => Consume(EncodeArticlePageList(scenario.Page, true, out _)),
                        "two-pass-direct" => () => Consume(EncodeArticlePageDirect(scenario.Page)),
                        "array-pool-records" => () => Consume(EncodeArticlePagePooled(scenario.Page)),
                        "adaptive-stack-pool" => () => Consume(EncodeArticlePageAdaptive(scenario.Page)),
                        _ => throw new InvalidOperationException($"Unknown ArticlePage variant: {variant}")
                    }));
            }
        }

        return rounds;
    }

    private static object VariantEvidence(
        string name,
        ProfileAggregate aggregate,
        IReadOnlyList<ProfileMeasurement> rounds,
        int itemCount,
        CollectionShape collections,
        int copyBytes,
        string storage)
        => new
        {
            name,
            storage,
            managedTemporaryCollectionCount = collections.ManagedCollectionCount,
            pooledBufferCount = collections.PooledBufferCount,
            capacityWasteBytes = collections.CapacityWasteBytes,
            blobCapacity = collections.BlobCapacity,
            tagRecordCapacity = collections.TagRecordCapacity,
            itemRecordCapacity = collections.ItemRecordCapacity,
            copyBytes,
            measured = ProfilerSupport.ToEvidence(aggregate, rounds),
            allocatedBytesPerFrame = aggregate.AllocatedBytesPerIteration,
            allocatedBytesPerItem = itemCount == 0
                ? aggregate.AllocatedBytesPerIteration
                : aggregate.AllocatedBytesPerIteration / itemCount
        };

    private static object FrequencyEvidence()
        => new
        {
            source = "synthetic-one-rebuild-per-sample",
            productionFrequencyMetric = RebuildFrequencyMetric,
            cacheHitPathMeasured = false
        };

    private static int Consume(byte[] bytes)
        => bytes.Length == 0 ? 0 : bytes.Length ^ bytes[0] ^ bytes[^1];

    private static bool WithinSmallLatencyPolicy(double candidateP95Ms, double baselineP95Ms)
        => candidateP95Ms <= baselineP95Ms * 1.10d
            || candidateP95Ms - baselineP95Ms <= 0.002d;

    private static IReadOnlyList<ArticlePageScenario> BuildArticlePageScenarios()
    {
        var scenarios = new List<ArticlePageScenario>(135);
        foreach (int itemCount in new[] { 0, 1, 10, 50, 100 })
        {
            foreach (int tagsPerItem in new[] { 0, 2, 8 })
            {
                foreach (TextProfile profile in TextProfiles())
                {
                    CorePageResult<ArticleListCoreModel> page = BuildArticlePage(itemCount, tagsPerItem, profile);
                    int blobBytes = page.Items.Sum(static item =>
                        Utf8Bytes(item.Category.Name)
                        + Utf8Bytes(item.Title)
                        + Utf8Bytes(item.Summary)
                        + item.Tags.Sum(static tag => Utf8Bytes(tag.Name)));
                    scenarios.Add(new ArticlePageScenario(
                        $"article-list-{itemCount}-tags-{tagsPerItem}-{profile.Encoding}-{profile.Length}",
                        itemCount,
                        tagsPerItem,
                        checked(itemCount * tagsPerItem),
                        profile.Length,
                        profile.Encoding,
                        blobBytes,
                        page));
                }
            }
        }

        return scenarios;
    }

    private static TextProfile[] TextProfiles()
        =>
        [
            new("short", "ascii", "title", "summary", "category"),
            new("short", "cjk", "标题", "摘要", "分类"),
            new("short", "mixed", "Title标题", "Summary摘要", "Category分类"),
            new("medium", "ascii", new string('t', 64), new string('s', 192), new string('c', 24)),
            new("medium", "cjk", new string('题', 48), new string('摘', 192), new string('类', 20)),
            new("medium", "mixed", Repeat("Ab标题", 20), Repeat("Cd摘要", 72), Repeat("Cat分类", 3)),
            new("long", "ascii", new string('t', 192), new string('s', 1024), new string('c', 48)),
            new("long", "cjk", new string('题', 64), new string('摘', 1024), new string('类', 32)),
            new("long", "mixed", Repeat("Long标题🙂", 16), Repeat("Body摘要界", 256), Repeat("Cat分类", 8))
        ];

    private static CorePageResult<ArticleListCoreModel> BuildArticlePage(
        int itemCount,
        int tagsPerItem,
        TextProfile profile)
    {
        ArticleListCoreModel[] items = Enumerable.Range(1, itemCount)
            .Select(index =>
            {
                DateTime created = DateTime.UnixEpoch.AddMinutes(index);
                string title = $"{profile.Title}-{index}";
                string summary = $"{profile.Summary}-{index}";
                string category = $"{profile.Category}-{index % 7}";
                TagCoreModel[] tags = Enumerable.Range(1, tagsPerItem)
                    .Select(tag => new TagCoreModel(tag, $"{profile.Category}-tag-{tag}-{index}"))
                    .ToArray();
                ArticleListItemPod pod = PodProjector.ProjectArticleList(
                    index,
                    index * 11,
                    created,
                    index % 7 + 1,
                    category,
                    title,
                    summary,
                    false,
                    out _);
                return new ArticleListCoreModel(
                    pod,
                    index,
                    title,
                    summary,
                    null,
                    null,
                    index * 11,
                    created,
                    new ArticleCategoryCoreModel(index % 7 + 1, category),
                    tags,
                    index % 3 == 0 ? null : false,
                    index % 4,
                    index % 5 == 0 ? created.AddHours(1) : null,
                    index % 2 == 0 ? created.AddHours(2) : null);
            })
            .ToArray();
        return new CorePageResult<ArticleListCoreModel>(
            items,
            itemCount + 10,
            itemCount == 0 ? null : $"{PodTimeCodec.ToUnixMs(items[^1].CreateTime)}:{items[^1].Id}",
            itemCount > 0);
    }

    private static IReadOnlyList<ArticleDetailScenario> BuildArticleDetailScenarios()
        =>
        [
            BuildArticleDetailScenario("detail-short", "short body", 0),
            BuildArticleDetailScenario("detail-medium-cjk", new string('文', 9_000), 8),
            BuildArticleDetailScenario("detail-large-ascii", new string('x', 128 * 1024), 32)
        ];

    private static ArticleDetailScenario BuildArticleDetailScenario(string name, string content, int tagCount)
    {
        DateTime created = DateTime.UnixEpoch.AddDays(7);
        string title = $"{name}-标题";
        ArticleDetailPod pod = PodProjector.ProjectArticleDetail(
            42,
            99,
            created,
            7,
            "性能分类",
            title,
            content,
            "摘要 summary",
            out _);
        var rights = new ArticleRightsCoreModel(
            901,
            801,
            7,
            true,
            "CC-BY-4.0",
            "Fésus",
            2026,
            "Line one\n第二行",
            "{title} — {holder}",
            "append-attribution",
            300,
            true,
            false,
            true,
            "https://example.test/article/42",
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "https://example.test/proofs/rights/901",
            "ready");
        var detail = new ArticleDetailCoreModel(
            pod,
            42,
            title,
            content,
            "摘要 summary",
            "/covers/42.webp",
            99,
            content.Length,
            Math.Max(1, content.Length / 300),
            true,
            created,
            new ArticleCategoryCoreModel(7, "性能分类"),
            Enumerable.Range(1, tagCount).Select(index => new TagCoreModel(index, $"标签-{index}")).ToArray(),
            7,
            false,
            2,
            null,
            created.AddHours(1),
            created.AddHours(2),
            rights);
        return new ArticleDetailScenario(name, tagCount, Utf8Bytes(content), detail);
    }

    private static string Repeat(string value, int count)
        => string.Concat(Enumerable.Repeat(value, count));

    private static int Utf8Bytes(string? value)
        => PodUtf8Codec.GetSliceByteCount(value);

    private readonly record struct TextProfile(
        string Length,
        string Encoding,
        string Title,
        string Summary,
        string Category);

    private sealed record ArticlePageScenario(
        string Name,
        int ItemCount,
        int TagsPerItem,
        int TagRecordCount,
        string TextLength,
        string TextEncoding,
        int BlobBytes,
        CorePageResult<ArticleListCoreModel> Page);

    private sealed record ArticleDetailScenario(
        string Name,
        int TagCount,
        int ContentBytes,
        ArticleDetailCoreModel Detail);

    private readonly record struct CollectionShape(
        int ManagedCollectionCount,
        int PooledBufferCount,
        int CapacityWasteBytes,
        int BlobCapacity,
        int TagRecordCapacity,
        int ItemRecordCapacity)
    {
        public static CollectionShape None => new(0, 0, 0, 0, 0, 0);
    }

    private readonly record struct PoolShape(int CapacityWasteBytes);

    private sealed record AuditMeasurement(long AllocatedBytesPerFrame, double P95Ms, object Evidence);
}
