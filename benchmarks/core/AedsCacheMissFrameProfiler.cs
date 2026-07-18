using System.Buffers;
using System.Text.Json;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Outputs;

internal static class AedsCacheMissFrameProfiler
{
    private static readonly AedsEncoder Encoder = new();

    public static int Run(string[] args)
    {
        string outFile = ProfilerSupport.OptionValue(
            args,
            "--out",
            ".tmp/perf/aeds-cache-miss-frame-cost/summary.json");
        int iterations = Math.Max(10, ProfilerSupport.IntOptionValue(args, "--iterations", 50));
        int warmupIterations = Math.Max(1, ProfilerSupport.IntOptionValue(args, "--warmup-iterations", 5));
        int roundCount = Math.Max(3, ProfilerSupport.IntOptionValue(args, "--rounds", 5));
        int runtimeLohThresholdBytes = DetectRuntimeLohThresholdBytes();
        IReadOnlyList<CacheMissFrameScenario> scenarios = BuildScenarios();
        var results = new List<object>(scenarios.Count);
        int ownedAllocationWins = 0;
        int ownedP95WithinTenPercent = 0;

        foreach (CacheMissFrameScenario scenario in scenarios)
        {
            byte[] currentWire = MaterializeCurrentWire(scenario);
            byte[] exactWire = MaterializeOwnedWire(scenario, pooled: false);
            byte[] ownedWire = MaterializeOwnedWire(scenario, pooled: true);
            bool tieredUsesPool = currentWire.Length >= runtimeLohThresholdBytes;
            byte[] tieredWire = MaterializeOwnedWire(scenario, pooled: tieredUsesPool);
            bool wireParity = currentWire.AsSpan().SequenceEqual(exactWire)
                && currentWire.AsSpan().SequenceEqual(ownedWire)
                && currentWire.AsSpan().SequenceEqual(tieredWire);
            if (!wireParity)
            {
                throw new InvalidOperationException($"AEDS cache-miss frame parity failed: {scenario.Name}");
            }

            int payloadBytes = MeasurePayloadLength(scenario);
            int currentAppCopyBytes = checked(payloadBytes + (currentWire.Length * 2));
            Dictionary<string, List<ProfileMeasurement>> rounds = new(StringComparer.Ordinal)
            {
                ["current"] = new(roundCount),
                ["exact"] = new(roundCount),
                ["owned"] = new(roundCount),
                ["tiered"] = new(roundCount)
            };
            string[] variants = ["current", "exact", "owned", "tiered"];
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
                            "current" => () => MeasureCurrent(scenario),
                            "exact" => () => MeasureOwned(scenario, pooled: false),
                            "owned" => () => MeasureOwned(scenario, pooled: true),
                            "tiered" => () => MeasureOwned(scenario, pooled: tieredUsesPool),
                            _ => throw new InvalidOperationException($"Unknown cache frame variant: {variant}")
                        }));
                }
            }

            ProfileAggregate current = ProfilerSupport.Aggregate(rounds["current"]);
            ProfileAggregate exact = ProfilerSupport.Aggregate(rounds["exact"]);
            ProfileAggregate owned = ProfilerSupport.Aggregate(rounds["owned"]);
            ProfileAggregate tiered = ProfilerSupport.Aggregate(rounds["tiered"]);
            if (owned.AllocatedBytesPerIteration <= exact.AllocatedBytesPerIteration)
            {
                ownedAllocationWins++;
            }
            if (owned.P95Ms <= exact.P95Ms * 1.10d)
            {
                ownedP95WithinTenPercent++;
            }

            (int exactLogical, int exactCapacity) = MeasureOwnerSizes(scenario, pooled: false);
            (int ownedLogical, int ownedCapacity) = MeasureOwnerSizes(scenario, pooled: true);
            results.Add(new
            {
                scenario = scenario.Name,
                frameType = scenario.FrameType.ToString(),
                itemCount = scenario.ItemCount,
                cachePath = scenario.CachePath,
                frameClass = AedsFrameSensitivity.RequiresClear(scenario.FrameType)
                    ? "sensitive"
                    : "public-immutable",
                missFrequency = new
                {
                    source = "synthetic-one-rebuild-per-sample",
                    rebuildsPerVariant = iterations * roundCount,
                    productionFrequencyMetric = "fsus.cache.owned_frame.build.count"
                },
                payloadBytes,
                frameBytes = currentWire.Length,
                wireParity,
                variants = new object[]
                {
                    VariantEvidence(
                        "current",
                        current,
                        rounds["current"],
                        logicalBytes: currentWire.Length,
                        capacityBytes: currentWire.Length,
                        applicationCopyBytes: currentAppCopyBytes,
                        serializationPasses: 1,
                        storage: "three-exact-arrays"),
                    VariantEvidence(
                        "exact",
                        exact,
                        rounds["exact"],
                        exactLogical,
                        exactCapacity,
                        applicationCopyBytes: 0,
                        serializationPasses: 2,
                        storage: "exact-owned-frame"),
                    VariantEvidence(
                        "owned",
                        owned,
                        rounds["owned"],
                        ownedLogical,
                        ownedCapacity,
                        applicationCopyBytes: 0,
                        serializationPasses: 1,
                        storage: "pooled-owned-frame"),
                    VariantEvidence(
                        "tiered",
                        tiered,
                        rounds["tiered"],
                        tieredUsesPool ? ownedLogical : exactLogical,
                        tieredUsesPool ? ownedCapacity : exactCapacity,
                        applicationCopyBytes: 0,
                        serializationPasses: tieredUsesPool ? 1 : 2,
                        storage: tieredUsesPool ? "runtime-loh-pooled" : "runtime-loh-exact")
                }
            });
        }

        bool selectOwnedForCache = ownedAllocationWins >= (scenarios.Count + 1) / 2
            && ownedP95WithinTenPercent >= (scenarios.Count + 1) / 2;
        var summary = new
        {
            schema = "fsusblog.aeds-cache-miss-frame-cost.v1",
            status = "ok",
            generatedAt = DateTimeOffset.UtcNow,
            measurementSource = "local-real-pod-writer-profiler",
            method = new
            {
                warmupIterations,
                iterationsPerRound = iterations,
                roundCount,
                ordering = "rotating-four-variant-order",
                allocationCounter = "GC.GetAllocatedBytesForCurrentThread",
                latency = "Stopwatch per rebuild",
                redisFileBoundary = "awaited lifetime is contract-tested; profiler sink reads immutable lease without claiming downstream zero-copy",
                runtimeLohThresholdBytes,
                runtimeLohDetection = "smallest byte-array allocation reported directly in generation 2 by the active runtime"
            },
            structuralModel = new
            {
                current = "payload exact array -> frame exact array -> Redis-bound defensive exact array -> L1 defensive exact array",
                exact = "counting serialization pass -> exact final owned frame; no application-level array copy",
                owned = "single payload serialization into reserved-header pooled owner; no application-level array copy",
                tiered = "runtime-detected LOH threshold selects exact below and pooled at/above",
                downstreamZeroCopyClaimed = false,
                residencyAccounting = "logical length and full backing capacity are reported separately"
            },
            recommendation = new
            {
                cacheOwnedFrame = selectOwnedForCache ? "owned" : "exact",
                publicSnapshotAndFileArtifact = "exact",
                selectionRule = "cache selection requires owned allocation wins and p95 within 10 percent in a majority of real scenarios; public artifacts remain exact because their GC/weak-snapshot lifetime is not lease-owned",
                ownedAllocationWins,
                ownedP95WithinTenPercent,
                scenarioCount = scenarios.Count
            },
            results
        };

        ProfilerSupport.WriteJson(outFile, summary);
        Console.WriteLine($"[aeds-cache-miss-frame-cost] wrote {outFile}");
        Console.WriteLine($"[aeds-cache-miss-frame-cost] cache={summary.recommendation.cacheOwnedFrame} public-artifact=exact");
        return 0;
    }

    private static object VariantEvidence(
        string name,
        ProfileAggregate aggregate,
        IReadOnlyList<ProfileMeasurement> rounds,
        int logicalBytes,
        int capacityBytes,
        int applicationCopyBytes,
        int serializationPasses,
        string storage)
        => new
        {
            name,
            storage,
            logicalBytes,
            capacityBytes,
            backingOverheadBytes = capacityBytes - logicalBytes,
            applicationCopyBytes,
            serializationPasses,
            measured = ProfilerSupport.ToEvidence(aggregate, rounds)
        };

    private static int MeasureCurrent(CacheMissFrameScenario scenario)
    {
        var payloadWriter = new ArrayBufferWriter<byte>();
        scenario.WritePayload(payloadWriter);
        byte[] payload = payloadWriter.WrittenSpan.ToArray();
        byte[] frame = Encoder.Encode(scenario.FrameType, payload);
        byte[] redisBoundCopy = frame.ToArray();
        byte[] l1Copy = redisBoundCopy.ToArray();
        return Consume(l1Copy);
    }

    private static int MeasureOwned(CacheMissFrameScenario scenario, bool pooled)
    {
        using OwnedAedsFrame owner = pooled
            ? AedsOwnedFrameBuilder.BuildOwned(scenario.FrameType, scenario.WritePayload)
            : AedsOwnedFrameBuilder.BuildExact(scenario.FrameType, scenario.WritePayload);
        using OwnedAedsFrameReadLease redisAndResponseLease = owner.AcquireReadLease();
        return Consume(redisAndResponseLease.Memory);
    }

    private static int Consume(ReadOnlyMemory<byte> frame)
    {
        ReadOnlySpan<byte> payload = frame.Span[AedsFrameHeader.Size..];
        return frame.Length ^ AedsCrc16.Compute(payload);
    }

    private static int MeasurePayloadLength(CacheMissFrameScenario scenario)
    {
        var writer = new ArrayBufferWriter<byte>();
        scenario.WritePayload(writer);
        return writer.WrittenCount;
    }

    private static byte[] MaterializeCurrentWire(CacheMissFrameScenario scenario)
    {
        var payload = new ArrayBufferWriter<byte>();
        scenario.WritePayload(payload);
        return Encoder.Encode(scenario.FrameType, payload.WrittenSpan);
    }

    private static byte[] MaterializeOwnedWire(CacheMissFrameScenario scenario, bool pooled)
    {
        using OwnedAedsFrame owner = pooled
            ? AedsOwnedFrameBuilder.BuildOwned(scenario.FrameType, scenario.WritePayload)
            : AedsOwnedFrameBuilder.BuildExact(scenario.FrameType, scenario.WritePayload);
        using OwnedAedsFrameReadLease lease = owner.AcquireReadLease();
        return lease.Memory.ToArray();
    }

    private static (int Logical, int Capacity) MeasureOwnerSizes(CacheMissFrameScenario scenario, bool pooled)
    {
        using OwnedAedsFrame owner = pooled
            ? AedsOwnedFrameBuilder.BuildOwned(scenario.FrameType, scenario.WritePayload)
            : AedsOwnedFrameBuilder.BuildExact(scenario.FrameType, scenario.WritePayload);
        return (owner.LogicalLength, owner.Capacity);
    }

    private static int DetectRuntimeLohThresholdBytes()
    {
        int low = 1;
        int high = 1024;
        while (high < 16 * 1024 * 1024 && !IsLohAllocation(high))
        {
            low = high + 1;
            high *= 2;
        }

        if (!IsLohAllocation(high))
        {
            throw new InvalidOperationException("Unable to detect the active runtime LOH threshold below 16 MiB.");
        }

        while (low < high)
        {
            int midpoint = low + ((high - low) / 2);
            if (IsLohAllocation(midpoint))
            {
                high = midpoint;
            }
            else
            {
                low = midpoint + 1;
            }
        }

        return low;
    }

    private static bool IsLohAllocation(int length)
    {
        byte[] probe = GC.AllocateUninitializedArray<byte>(length);
        return GC.GetGeneration(probe) >= 2;
    }

    private static IReadOnlyList<CacheMissFrameScenario> BuildScenarios()
    {
        CorePageResult<ArticleListCoreModel> list10 = ArticlePage(10);
        CorePageResult<ArticleListCoreModel> list50 = ArticlePage(50);
        CorePageResult<ArticleListCoreModel> list100 = ArticlePage(100);
        IReadOnlyList<PopularArticleCoreModel> hot = Enumerable.Range(1, 20)
            .Select(index => new PopularArticleCoreModel(
                PodProjector.ProjectPopularArticle(index, $"hot-{index}", index * 17),
                index,
                $"hot-{index}",
                index * 17))
            .ToArray();
        ArticleDetailCoreModel detail = ArticleDetail(contentBytes: 96 * 1024);
        CoreCursorResult<CommentQueryCoreModel> comments = CommentCursor(40);
        CoreCursorResult<UserCommentCoreModel> userComments = UserCommentCursor(40);
        IReadOnlyList<CategoryListItemResponse> categories = Enumerable.Range(1, 64)
            .Select(index => new CategoryListItemResponse
            {
                Id = index,
                Name = $"category-{index}",
                ArticleCount = index * 3
            })
            .ToArray();
        var seo = new SeoConfigPublicDto
        {
            Title = "FsusBlog profiler",
            Description = new string('s', 512),
            Keywords = "aeds,cache,owned-frame",
            Author = "FsusBlog"
        };
        ConversationDetailResponse conversation = ConversationDetail(32);
        SiteStatsCoreModel stats = SiteStats();

        return
        [
            new("ArticleList10", AedsFrameType.ArticleList, 10, "L1/L2 frame miss", writer => PodBinaryCodec.WriteArticlePage(list10, writer)),
            new("ArticleList50", AedsFrameType.ArticleList, 50, "L1/L2 frame miss", writer => PodBinaryCodec.WriteArticlePage(list50, writer)),
            new("ArticleList100", AedsFrameType.ArticleList, 100, "L1/L2 frame miss", writer => PodBinaryCodec.WriteArticlePage(list100, writer)),
            new("ArticleHot", AedsFrameType.ArticleHot, hot.Count, "L1/L2 frame miss", writer => PodBinaryCodec.WritePopularArticles(hot, writer)),
            new("ArticleDetailBackfill", AedsFrameType.ArticleDetail, 1, "file/projection rebuild", writer => PodBinaryCodec.WriteArticleDetail(detail, writer)),
            new("CommentCursor", AedsFrameType.CommentArticleCursor, comments.Data.Count, "L1/L2 frame miss", writer => PodBinaryCodec.WriteCommentCursor(comments, writer)),
            new("UserComment", AedsFrameType.CommentUserCursor, userComments.Data.Count, "L1/L2 frame miss", writer => PodBinaryCodec.WriteUserCommentCursor(userComments, writer)),
            new("TaxonomyCategory", AedsFrameType.CategoryList, categories.Count, "taxonomy frame rebuild", writer => PodBinaryCodec.WriteCategoryList(categories, writer)),
            new("SystemSeo", AedsFrameType.SeoConfig, 1, "system representative", writer => PodBinaryCodec.WriteSeoConfig(seo, writer)),
            new("MessageConversation", AedsFrameType.ConversationDetail, conversation.Messages.Count, "message representative", writer => PodBinaryCodec.WriteConversationDetail(conversation, writer)),
            new("AdminStats", AedsFrameType.AdminStats, 1, "sensitive L1/L2 frame miss", writer => PodBinaryCodec.WriteSiteStats(stats, writer))
        ];
    }

    private static CorePageResult<ArticleListCoreModel> ArticlePage(int count)
        => new(
            Enumerable.Range(1, count).Select(ArticleListItem).ToArray(),
            count,
            NextCursor: null,
            HasMore: false);

    private static ArticleListCoreModel ArticleListItem(int id)
    {
        DateTime created = DateTime.UnixEpoch.AddMinutes(id);
        string title = $"article-{id}-{new string('t', 48)}";
        string summary = new string('s', 192);
        ArticleListItemPod pod = PodProjector.ProjectArticleList(
            id,
            id * 11,
            created,
            7,
            "performance",
            title,
            summary,
            false,
            out _);
        return new ArticleListCoreModel(
            pod,
            id,
            title,
            summary,
            $"/covers/{id}.webp",
            new string('n', 128),
            id * 11,
            created,
            new ArticleCategoryCoreModel(7, "performance"),
            [new TagCoreModel(1, "aeds"), new TagCoreModel(2, "cache")],
            false);
    }

    private static ArticleDetailCoreModel ArticleDetail(int contentBytes)
    {
        string content = new('d', contentBytes);
        DateTime created = DateTime.UnixEpoch.AddDays(2);
        ArticleDetailPod pod = PodProjector.ProjectArticleDetail(
            42,
            9001,
            created,
            7,
            "performance",
            "owned frame detail",
            content,
            "detail summary",
            out _);
        return new ArticleDetailCoreModel(
            pod,
            42,
            "owned frame detail",
            content,
            "detail summary",
            "/covers/42.webp",
            9001,
            contentBytes,
            12,
            true,
            created,
            new ArticleCategoryCoreModel(7, "performance"),
            [new TagCoreModel(1, "aeds")],
            7,
            false);
    }

    private static CoreCursorResult<CommentQueryCoreModel> CommentCursor(int count)
    {
        var author = new CommentAuthorViewDto("public", "Profiler", "zh-CN", null, null);
        CommentQueryCoreModel[] items = Enumerable.Range(1, count)
            .Select(index =>
            {
                DateTime created = DateTime.UnixEpoch.AddSeconds(index);
                string content = $"comment-{index}-{new string('c', 240)}";
                var pod = PodProjector.ProjectCommentItem(index, created, author.Mode, author.DisplayName, content, out _);
                return new CommentQueryCoreModel(pod, index, content, created, author);
            })
            .ToArray();
        return new CoreCursorResult<CommentQueryCoreModel>(items, count, true);
    }

    private static CoreCursorResult<UserCommentCoreModel> UserCommentCursor(int count)
    {
        var author = new CommentAuthorViewDto("public", "Profiler", "zh-CN", null, null);
        UserCommentCoreModel[] items = Enumerable.Range(1, count)
            .Select(index =>
            {
                DateTime created = DateTime.UnixEpoch.AddSeconds(index);
                string content = $"user-comment-{index}-{new string('u', 224)}";
                var pod = PodProjector.ProjectUserComment(
                    index,
                    42,
                    created,
                    content,
                    "owned frame article",
                    null,
                    1,
                    "public",
                    "public",
                    "approved_public",
                    true,
                    out _);
                return new UserCommentCoreModel(
                    pod,
                    index,
                    content,
                    created,
                    42,
                    "owned frame article",
                    null,
                    author,
                    null,
                    1,
                    "public",
                    "public",
                    "approved_public",
                    true);
            })
            .ToArray();
        return new CoreCursorResult<UserCommentCoreModel>(items, count, true);
    }

    private static ConversationDetailResponse ConversationDetail(int count)
    {
        List<ConversationMessageResponse> messages = Enumerable.Range(1, count)
            .Select(index => new ConversationMessageResponse
            {
                MessageId = $"message-{index}",
                ConversationId = "conversation-1",
                SenderType = index % 2 == 0 ? ConversationSenderValue.Admin : ConversationSenderValue.Account,
                SenderName = $"sender-{index}",
                Body = new string('m', 384),
                CreatedAt = DateTime.UnixEpoch.AddMinutes(index)
            })
            .ToList();
        return new ConversationDetailResponse
        {
            ConversationId = "conversation-1",
            Subject = "owned frame lifecycle",
            Status = ConversationStatusValue.Open,
            CanReply = true,
            LastMessageAt = messages[^1].CreatedAt,
            Messages = messages
        };
    }

    private static SiteStatsCoreModel SiteStats()
    {
        SiteStatsPod pod = PodProjector.ProjectSiteStats(3, 4, 1, 100, 60, 40, 60, 40, 1, 1, 1);
        var popular = new PopularArticleCoreModel(
            PodProjector.ProjectPopularArticle(3, "hot", 77),
            3,
            "hot",
            77);
        var recent = new RecentCommentCoreModel(
            PodProjector.ProjectRecentComment(
                DateTime.UnixEpoch.AddDays(1),
                "Profiler",
                "public",
                null,
                null,
                "recent comment",
                out _),
            "Profiler",
            "public",
            null,
            null,
            "recent comment",
            DateTime.UnixEpoch.AddDays(1));
        var region = new RegionDistributionCoreModel(
            PodProjector.ProjectRegionDistribution("CN-SH", 9),
            "CN-SH",
            9);
        return new SiteStatsCoreModel(pod, 3, 4, 1, 100, 60, 40, 60, 40, [popular], [recent], [region]);
    }

    private sealed record CacheMissFrameScenario(
        string Name,
        AedsFrameType FrameType,
        int ItemCount,
        string CachePath,
        Action<IBufferWriter<byte>> WritePayload);
}
