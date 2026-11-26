using System.Runtime.CompilerServices;

internal static class SearchPruningVectors
{
    internal static void Run(string fixtures)
    {
        VerifyRandomizedDifferentialAcrossAllProfiles();
        VerifyAdversarialTiesPhraseBoostAndBlockBoundaries();
        VerifyGlobalStatChangeAndSegmentMergeBounds();
        VerifyBroadCorpusPruningEffectivenessAndOracleParity();
        VerifyShortPrefixIndexMatchesOracleBitForBit();
        VerifyCancellationBudgetAndZeroRetainedGenerations();
    }

    private static void VerifyRandomizedDifferentialAcrossAllProfiles()
    {
        var baseTime = new DateTimeOffset(2026, 6, 1, 0, 0, 0, TimeSpan.Zero);
        var rng = new Random(48_2026);
        var vocab = new[]
        {
            "alpha", "beta", "gamma", "delta", "epsilon", "zeta",
            "C#", "C++", ".NET", "HTTP/2", "issue-2205", "batch-item", "batch", "item",
            "Go", "Golang", "go1", "filter", "ﬁlter", "ﬁx",
            "博客", "搜索", "数据库", "數據庫", "架构", "架構", "性能", "索引",
            "量子纠缠", "林徽因", "微核调度", "系统"
        };

        // 320 docs spans 5 full 64-doc blocks, exercising both SelectiveExact and Block-Max/BMW/Latest paths
        var articles = new Article[320];
        for (var i = 0; i < articles.Length; i++)
        {
            var id = i + 1;
            var titleWords = Enumerable.Range(0, 2 + rng.Next(4)).Select(_ => vocab[rng.Next(vocab.Length)]);
            var headWords = Enumerable.Range(0, 2 + rng.Next(3)).Select(_ => vocab[rng.Next(vocab.Length)]);
            var bodyWords = Enumerable.Range(0, 10 + rng.Next(30)).Select(_ => vocab[rng.Next(vocab.Length)]);
            // Inject common anchor into ~90% of docs to exercise multi-block skipping on broad terms
            var common = rng.Next(10) < 9 ? "sharedanchor " : "";
            var body = $"## {string.Join(' ', headWords)}\n\n{common}{string.Join(' ', bodyWords)}\n\n```csharp\n// {vocab[rng.Next(vocab.Length)]}\n```";
            // Deliberately create timestamp collisions (~20 distinct timestamps across 320 docs) to stress tie-breaking
            var pub = baseTime.AddHours(rng.Next(20));
            var created = baseTime.AddHours(rng.Next(15));
            articles[i] = new Article(
                id, 1, id, 1, 1,
                string.Join(' ', titleWords),
                body,
                created, created, pub,
                $"{vocab[rng.Next(vocab.Length)]} 摘要 {vocab[rng.Next(vocab.Length)]}",
                new TaxonomyName(100 + (i % 12), vocab[rng.Next(vocab.Length)]),
                [new TaxonomyName(500 + (i % 20), vocab[rng.Next(vocab.Length)])]);
        }

        var index = ArticleSearchIndex.Build(articles, CancellationToken.None)!;
        var oracle = ExhaustiveSearchOracle.Build(articles, CancellationToken.None);

        var queries = new[]
        {
            // Single common & rare terms
            "sharedanchor", "alpha", "量子纠缠", "林徽因", "batch-item", "C#", ".NET", "HTTP/2", "issue-2205",
            "go", "c", "fi", "数据库", "數據庫", "架构", "架構", "微核调度",
            // 2-concept conjunctions (non-relaxable, phrase/proximity eligible)
            "sharedanchor alpha", "alpha beta", "数据库 架构", "數據庫 架構", "C# .NET", "batch-item alpha",
            "go alpha", "量子纠缠 alpha", "sharedanchor batch-item",
            // 3-to-6 concept queries (triggering BOTH Primary >= 5 and Relaxed < 5 BMW!)
            "alpha beta gamma", "sharedanchor alpha beta", "alpha beta gamma delta",
            "alpha beta gamma delta epsilon zeta",
            "量子纠缠 林徽因 微核调度",
            "数据库 架构 性能 索引", "數據庫 架構 性能 索引",
            "batch-item go alpha", "go c alpha",
            "alpha beta absentxyz", "alpha beta gamma absentxyz",
            // Quoted phrases (alone, multi-concept, relaxable with quoted mandatory driver)
            "\"alpha beta\"", "\"博客 搜索\"", "\"alpha beta\" gamma delta epsilon",
            "\"量子纠缠\" alpha beta gamma",
            // Strict identifier with relaxable concepts
            "C# alpha beta gamma", "issue-2205 alpha beta gamma",
            // Empty / zero-match / punctuation / overlong
            "", "   ", "absenttermxyz", "\"never matches phrase\"",
            new string('a', 130) + "-123"
        };

        foreach (var sort in new[] { ArticleSearchSort.Relevance, ArticleSearchSort.Latest })
        {
            foreach (var q in queries)
            {
                var expectedAll = oracle.SearchDetailed(q, sort, 1, ArticleSearchIndex.MaxPaginatedResults, CancellationToken.None);

                // 1. Exact SearchDetailed parity (top 20 and full 200)
                var gotTop20 = index.SearchDetailed(q, sort, 1, 20, CancellationToken.None, out _);
                AssertDetailedPrefixEqual($"detailed20:{sort}:{q}", expectedAll, gotTop20, 20);

                var gotFull = index.SearchDetailed(q, sort, 1, 200, CancellationToken.None, out _);
                AssertDetailedPrefixEqual($"detailed200:{sort}:{q}", expectedAll, gotFull, 200);

                CheckSearchCursorWalk($"pruning:{sort}:{q}", index, expectedAll, q, sort, 7, 60, checkLowerBoundTierSum: true);
            }
        }
    }

    private static void VerifyAdversarialTiesPhraseBoostAndBlockBoundaries()
    {
        // Construct a 640-doc corpus (10 exact 64-doc blocks) with adversarial edge cases at block boundaries
        // (ordinals 63, 64, 65, 127, 128, 255, 256, 511, 512, 639):
        // 1. Exact score + timestamp ties broken solely by higher Id placed in the LAST block (ordinal 639)
        // 2. Late block competitive winner whose BM25F is slightly lower than early block hits,
        //    EXCEPT Title exact phrase bonus (+0.35 * totalQueryIdf) lifts it into Top-10!
        // 3. Latest-sort tie-breaking across block boundaries (identical PublishedAt, broken by Score/CreatedAt/Id)
        var fixedPub = new DateTimeOffset(2026, 7, 1, 12, 0, 0, TimeSpan.Zero);
        var fixedCreated = new DateTimeOffset(2026, 7, 1, 10, 0, 0, TimeSpan.Zero);
        var articles = new Article[640];

        for (var i = 0; i < articles.Length; i++)
        {
            var id = i + 1;
            var (title, body, created, published) = i switch
            {
                // Early hits and higher IDs at block boundaries tie on score and timestamps.
                < 15 or 63 or 64 or 65 or 127 or 128 or 255 or 256 or 511 or 512 or 638 =>
                    ("tiekey mid1 mid2 tiepair", "tiekey filler filler filler filler tiepair", fixedCreated, fixedPub),
                // The last document's title phrase bonus lifts its lower base score.
                639 => ("tiekey tiepair extra1 extra2 extra3",
                    "tiekey tiepair extra padding padding padding padding padding", fixedCreated, fixedPub),
                _ => ($"Neutral Entry {id}", "tiekey distant words a b c d e f g h i j k l m n o p q r s t tiepair",
                    fixedCreated.AddMinutes(-i), fixedPub.AddMinutes(-i))
            };
            articles[i] = new Article(id, 1, id, 1, 1, title, body, created, created, published);
        }

        var index = ArticleSearchIndex.Build(articles, CancellationToken.None)!;
        var oracle = ExhaustiveSearchOracle.Build(articles, CancellationToken.None);

        foreach (var sort in new[] { ArticleSearchSort.Relevance, ArticleSearchSort.Latest })
        {
            foreach (var q in new[] { "tiekey", "tiekey tiepair" })
            {
                var exp = oracle.SearchDetailed(q, sort, 1, 30, CancellationToken.None);
                var got = index.SearchWithCursor(q, sort, 10, null, 0, CancellationToken.None, out _);
                Require(got.Hits.Length == 10, $"Adversarial [{sort}:{q}] expected 10 hits");
                for (var i = 0; i < 10; i++)
                {
                    Require(got.Hits[i].Article.Id == exp.Hits[i].Article.Id &&
                            Math.Abs(got.Hits[i].Score - exp.Hits[i].Score) <= 1e-11,
                        $"Adversarial [{sort}:{q}] rank {i}: expected id={exp.Hits[i].Article.Id} score={exp.Hits[i].Score:R}, " +
                        $"got id={got.Hits[i].Article.Id} score={got.Hits[i].Score:R}");
                }
                // Verify late-block highest-ID tied winner (639) survives tie-breaking;
                // and for 2-term "tiekey tiepair", late phrase-boosted doc 640 ranks #1!
                Require(got.Hits.Any(static h => h.Article.Id == 639),
                    $"Adversarial [{sort}:{q}] pruned late-block tied winner 639!");
                if (q == "tiekey tiepair" && sort == ArticleSearchSort.Relevance)
                    Require(got.Hits[0].Article.Id == 640,
                        $"Adversarial [Relevance:tiekey tiepair] expected late phrase-boosted doc 640 at #1, got {got.Hits[0].Article.Id}");
            }
        }
    }

    private static void VerifyGlobalStatChangeAndSegmentMergeBounds()
    {
        // Build two independent segments of documents, compute primitive SearchPostingBlockMeta per segment,
        // merge them via SearchPostingBlockMeta.Merge, then mutate global avgFieldLengths (0.25x .. 4.0x)
        // and IDF across wide ranges -> verify UpperBoundBm25F stays STRICTLY >= true BM25F + exact bonus for EVERY doc!
        var rng = new Random(48_51);
        var baseTime = new DateTimeOffset(2026, 8, 1, 0, 0, 0, TimeSpan.Zero);

        var docs = new (byte[] Tfs, int[] Lens, bool Exact, long PubTicks)[128];
        for (var i = 0; i < docs.Length; i++)
        {
            var tfs = new byte[SearchScoringProfile.FieldCount];
            var lens = new int[SearchScoringProfile.FieldCount];
            for (var f = 0; f < SearchScoringProfile.FieldCount; f++)
            {
                tfs[f] = (byte)(rng.Next(3) == 0 ? 0 : 1 + rng.Next(40));
                lens[f] = f == 4 ? 1 + rng.Next(80_000) : 1 + rng.Next(500); // include > ushort.MaxValue body length!
            }
            docs[i] = (tfs, lens, rng.Next(4) == 0, baseTime.AddSeconds(rng.Next(100_000)).UtcTicks);
        }

        static SearchPostingBlockMeta BuildMeta((byte[] Tfs, int[] Lens, bool Exact, long PubTicks)[] slice, int start, int len)
        {
            byte m0 = 0, m1 = 0, m2 = 0, m3 = 0, m4 = 0, ex = 0;
            ushort l0 = ushort.MaxValue, l1 = ushort.MaxValue, l2 = ushort.MaxValue, l3 = ushort.MaxValue, l4 = ushort.MaxValue;
            var maxPub = long.MinValue;
            var minPub = long.MaxValue;
            for (var i = start; i < start + len; i++)
            {
                var d = slice[i];
                if (d.Tfs[0] > m0) m0 = d.Tfs[0];
                if (d.Tfs[1] > m1) m1 = d.Tfs[1];
                if (d.Tfs[2] > m2) m2 = d.Tfs[2];
                if (d.Tfs[3] > m3) m3 = d.Tfs[3];
                if (d.Tfs[4] > m4) m4 = d.Tfs[4];
                if (d.Exact) ex = 1;
                l0 = Math.Min(l0, (ushort)Math.Min(ushort.MaxValue, d.Lens[0]));
                l1 = Math.Min(l1, (ushort)Math.Min(ushort.MaxValue, d.Lens[1]));
                l2 = Math.Min(l2, (ushort)Math.Min(ushort.MaxValue, d.Lens[2]));
                l3 = Math.Min(l3, (ushort)Math.Min(ushort.MaxValue, d.Lens[3]));
                l4 = Math.Min(l4, (ushort)Math.Min(ushort.MaxValue, d.Lens[4]));
                if (d.PubTicks > maxPub) maxPub = d.PubTicks;
                if (d.PubTicks < minPub) minPub = d.PubTicks;
            }
            return new SearchPostingBlockMeta(start + len - 1, m0, m1, m2, m3, m4, ex, l0, l1, l2, l3, l4, maxPub, minPub);
        }

        var segA = BuildMeta(docs, 0, 64);
        var segB = BuildMeta(docs, 64, 64);
        var merged = SearchPostingBlockMeta.Merge(segA, segB);

        var avgScenarios = new[]
        {
            new[] { 1.0, 1.0, 1.0, 1.0, 1.0 },
            new[] { 8.0, 20.0, 30.0, 12.0, 400.0 },
            new[] { 2.0, 5.0, 6.0, 3.0, 80.0 },
            new[] { 50.0, 120.0, 200.0, 80.0, 10_000.0 },
            new[] { 500.0, 1.0, 1000.0, 2.0, 100_000.0 }
        };
        var idfs = new[] { 0.01, 0.5, 2.3, 6.8, 12.5 };

        Span<double> tfSpan = stackalloc double[SearchScoringProfile.FieldCount];
        foreach (var avgs in avgScenarios)
        {
            foreach (var idf in idfs)
            {
                var boundMerged = merged.UpperBoundBm25F(idf, merged.HasAnyExact != 0, avgs);
                for (var i = 0; i < docs.Length; i++)
                {
                    var d = docs[i];
                    for (var f = 0; f < SearchScoringProfile.FieldCount; f++) tfSpan[f] = d.Tfs[f] * 0.5;
                    var trueScore = SearchScoringProfile.ScoreConceptBm25F(idf, tfSpan, d.Lens, avgs) +
                                    (d.Exact ? SearchScoringProfile.ExactFormBonusFactor * idf : 0.0);
                    Require(boundMerged >= trueScore,
                        $"Merged block upper bound violated! bound={boundMerged:R} < true={trueScore:R} (doc={i}, idf={idf})");
                    Require(merged.MaxPublishedTicks >= d.PubTicks && merged.MinPublishedTicks <= d.PubTicks,
                        "Merged block timestamp range violated!");
                }
            }
        }
    }

    private static void VerifyBroadCorpusPruningEffectivenessAndOracleParity()
    {
        // 2,048 documents = 32 full 64-doc blocks
        var baseTime = new DateTimeOffset(2026, 9, 1, 0, 0, 0, TimeSpan.Zero);
        var articles = new Article[2048];
        for (var i = 0; i < articles.Length; i++)
        {
            var id = i + 1;
            // Newest timestamps concentrated in Block 0 (docs 0..20) + one late spike at doc 1900 to test exactness
            var pub = i < 20 ? baseTime.AddDays(1000 - i)
                    : i == 1900 ? baseTime.AddDays(2000)
                    : baseTime.AddMinutes(i);

            (string Title, string Body, string? Summary) content = i switch
            {
                // Strong early matches establish the heap threshold.
                < 16 => ("broadterm commonpair rarehit",
                    "## broadterm commonpair\n\nbroadterm commonpair strong introduction.", "broadterm commonpair summary"),
                // The competitive document in Block 29 must survive pruning.
                1900 => ("broadterm commonpair broadterm",
                    "## broadterm commonpair\n\nbroadterm commonpair late spike winner.", "broadterm commonpair"),
                // Two primary matches leave room for relaxed Block-Max WAND.
                200 or 900 => ("broadterm commonpair ultraomega", "broadterm commonpair ultraomega full primary.", null),
                _ => ($"Archive Log Entry Number {id}",
                    "Long routine operational log paragraph with filler words one two three four five six seven eight nine ten " +
                    "eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty broadterm distant words " +
                    "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu commonpair end.", null)
            };
            articles[i] = new Article(id, 1, id, 1, 1, content.Title, content.Body, pub, pub, pub, content.Summary);
        }

        var index = ArticleSearchIndex.Build(articles, CancellationToken.None)!;
        var oracle = ExhaustiveSearchOracle.Build(articles, CancellationToken.None);

        // 1. Common single-term Relevance: skips majority of blocks while reporting exact O(1) DF and exact Top-10
        var singleRel = index.SearchWithCursor("broadterm", ArticleSearchSort.Relevance, 10, null, 0, CancellationToken.None, out var singleRelStats);
        var singleRelOracle = oracle.SearchDetailed("broadterm", ArticleSearchSort.Relevance, 1, 10, CancellationToken.None);
        Require(singleRelStats.Path == SearchExecutionPath.BlockMaxConjunction, $"Expected BlockMaxConjunction, got {singleRelStats.Path}");
        Require(singleRelStats.BlocksSkipped >= 25, $"Expected >= 25 blocks skipped on 2048-doc single term, got {singleRelStats.BlocksSkipped}");
        Require(singleRelStats.PostingsDecoded < 500, $"Expected < 500 postings decoded out of 2048, got {singleRelStats.PostingsDecoded}");
        Require(singleRel.TotalRelation == PublicSearchTotalRelation.LowerBound && singleRel.TotalCount == ArticleSearchIndex.MaxPaginatedResults,
            "2048-doc single term should report LowerBound at 1000");
        AssertCursorTopKMatchesOracle("broad-single-rel", singleRelOracle, singleRel);

        // 2. Common single-term Latest: skips old blocks cleanly and still finds late-block newest doc #1901!
        var singleLat = index.SearchWithCursor("broadterm", ArticleSearchSort.Latest, 10, null, 0, CancellationToken.None, out var singleLatStats);
        var singleLatOracle = oracle.SearchDetailed("broadterm", ArticleSearchSort.Latest, 1, 10, CancellationToken.None);
        Require(singleLatStats.Path == SearchExecutionPath.LatestBlockScan, $"Expected LatestBlockScan, got {singleLatStats.Path}");
        Require(singleLatStats.BlocksSkipped >= 25, $"Expected >= 25 blocks skipped in Latest, got {singleLatStats.BlocksSkipped}");
        Require(singleLat.Hits[0].Article.Id == 1901, $"Latest missed newest doc 1901 in block 29, got {singleLat.Hits[0].Article.Id}");
        AssertCursorTopKMatchesOracle("broad-single-latest", singleLatOracle, singleLat);

        // 3. Broad 2-term conjunction: skips blocks AND skips positions lazily!
        var conjRel = index.SearchWithCursor("broadterm commonpair", ArticleSearchSort.Relevance, 10, null, 0, CancellationToken.None, out var conjStats);
        var conjOracle = oracle.SearchDetailed("broadterm commonpair", ArticleSearchSort.Relevance, 1, 10, CancellationToken.None);
        Require(conjStats.BlocksSkipped >= 20, $"Expected >= 20 blocks skipped in broad conjunction, got {conjStats.BlocksSkipped}");
        Require(conjRel.TotalRelation == PublicSearchTotalRelation.LowerBound && conjRel.TotalCount <= conjOracle.Total,
            "Pruned broad conjunction must report truthful LowerBound <= true total");
        AssertCursorTopKMatchesOracle("broad-conj-rel", conjOracle, conjRel);

        // Verify lazy position skip on exact-count SearchDetailed of broad 2-term conjunction (counts all 2048, skips positions!)
        var conjExact = index.SearchDetailed("broadterm commonpair", ArticleSearchSort.Relevance, 1, 10, CancellationToken.None, out var conjExactStats);
        Require(conjExactStats.PositionSkipsByBound >= 1900,
            $"Expected >= 1900 lazy position skips on 2048-doc exact conjunction, got {conjExactStats.PositionSkipsByBound}");
        Require(conjExact.Total == conjOracle.Total, "Exact conjunction total mismatch");
        AssertDetailedPrefixEqual("broad-conj-exact", conjOracle, conjExact, 10);

        // 4. Broad 3-term Relaxed Block-Max WAND (< 5 Primary matches -> Relaxed BMW over 2,000+ docs!)
        var bmwRel = index.SearchWithCursor("broadterm commonpair ultraomega", ArticleSearchSort.Relevance, 10, null, 0, CancellationToken.None, out var bmwStats);
        var bmwOracle = oracle.SearchDetailed("broadterm commonpair ultraomega", ArticleSearchSort.Relevance, 1, 10, CancellationToken.None);
        Require(bmwStats.Path == SearchExecutionPath.BlockMaxWand, $"Expected BlockMaxWand, got {bmwStats.Path}");
        Require(bmwStats.BlocksSkipped >= 15, $"Expected >= 15 blocks skipped in Relaxed BMW, got {bmwStats.BlocksSkipped}");
        AssertCursorTopKMatchesOracle("broad-bmw-rel", bmwOracle, bmwRel);

        // 5. Selective rare query uses SelectiveExact (no pruning overhead)
        var rare = index.SearchWithCursor("rarehit", ArticleSearchSort.Relevance, 10, null, 0, CancellationToken.None, out var rareStats);
        var rareOracle = oracle.SearchDetailed("rarehit", ArticleSearchSort.Relevance, 1, 10, CancellationToken.None);
        Require(rareStats.Path == SearchExecutionPath.SelectiveExact, $"Expected SelectiveExact for rare query, got {rareStats.Path}");
        Require(rare.TotalRelation == PublicSearchTotalRelation.Exact && rare.TotalCount == 16, "Rare query exact count mismatch");
        AssertCursorTopKMatchesOracle("broad-rare", rareOracle, rare);
    }

    private static void VerifyShortPrefixIndexMatchesOracleBitForBit()
    {
        var when = new DateTimeOffset(2026, 10, 1, 0, 0, 0, TimeSpan.Zero);
        var tagPrefix = string.Concat(Enumerable.Repeat("za ", 33));
        var tags = Enumerable.Range(1, WireLimits.TaxonomyTagCount)
            .Select(id => new TaxonomyName(id + 2, tagPrefix + $"tag{id}")).ToArray();
        var articles = new[]
        {
            new Article(1, 1, 1, 1, 1, "Go Runtime", "body without prefix", when, when, when, "Golang summary", new(1, "GoLang"), [new(2, "goTool")]),
            new Article(2, 1, 2, 1, 1, "ﬁx", "ligature 2-char title edge case", when.AddMinutes(1), when, when),
            new Article(3, 1, 3, 1, 1, "ﬁlter pipeline", "ligature 6-char title", when.AddMinutes(2), when, when),
            new Article(4, 1, 4, 1, 1, "CamelCaseFooBarBaz", "subword prefix matches", when.AddMinutes(3), when, when, "alphaBetaGamma"),
            new Article(5, 1, 5, 1, 1, "C", "exact single letter C", when.AddMinutes(4), when, when),
            new Article(6, 1, 6, 1, 1, "Compiler Design", "prefix c in title", when.AddMinutes(5), when, when),
            new Article(7, 1, 7, 1, 1, "At the taxonomy hit limit", "body", when.AddMinutes(6), when, when, null, null, tags[..^1]),
            new Article(8, 1, 8, 1, 1, "Above the taxonomy hit limit", "body", when.AddMinutes(7), when, when, null, null, tags)
        };
        var index = ArticleSearchIndex.Build(articles, CancellationToken.None)!;
        var oracle = ExhaustiveSearchOracle.Build(articles, CancellationToken.None);

        foreach (var q in new[] { "g", "go", "fi", "f", "c", "ba", "b", "be", "go c", "z" })
        {
            foreach (var sort in new[] { ArticleSearchSort.Relevance, ArticleSearchSort.Latest })
            {
                var exp = oracle.SearchDetailed(q, sort, 1, 20, CancellationToken.None);
                var got = index.SearchDetailed(q, sort, 1, 20, CancellationToken.None, out _);
                if (q == "z") Require(got.Hits.Length == 2, "Both short-prefix saturation fixtures must match.");
                AssertDetailedPrefixEqual($"short-prefix:{sort}:{q}", exp, got, 20);
            }
        }
    }

    private static void VerifyCancellationBudgetAndZeroRetainedGenerations()
    {
        var (weakIndex, weakArticle) = RunQueriesAndDropGeneration();

        for (var i = 0; i < 4; i++)
        {
            GC.Collect(GC.MaxGeneration, GCCollectionMode.Forced, blocking: true, compacting: true);
            GC.WaitForPendingFinalizers();
        }
        Require(!weakIndex.IsAlive && !weakArticle.IsAlive,
            $"Pooled search buffers retained obsolete generation references! indexAlive={weakIndex.IsAlive}, articleAlive={weakArticle.IsAlive}");
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static (WeakReference IndexRef, WeakReference ArticleRef) RunQueriesAndDropGeneration()
    {
        var when = new DateTimeOffset(2026, 11, 1, 0, 0, 0, TimeSpan.Zero);
        var articles = new Article[400];
        for (var i = 0; i < articles.Length; i++)
        {
            articles[i] = new Article(i + 1, 1, i + 1, 1, 1,
                $"Retention Test {i} alpha beta",
                "alpha beta gamma shared retention payload text",
                when.AddMinutes(i), when.AddMinutes(i), when.AddMinutes(i));
        }

        var index = ArticleSearchIndex.Build(articles, CancellationToken.None)!;
        var weakIndex = new WeakReference(index);
        var weakArticle = new WeakReference(articles[0]);

        // 1. Normal queries across all execution paths
        _ = index.SearchWithCursor("alpha", ArticleSearchSort.Relevance, 10, null, 0, CancellationToken.None, out _);
        _ = index.SearchWithCursor("alpha beta", ArticleSearchSort.Latest, 10, null, 0, CancellationToken.None, out _);
        _ = index.SearchWithCursor("alpha beta gamma absentxyz", ArticleSearchSort.Relevance, 10, null, 0, CancellationToken.None, out _);

        // 2. Pre-cancelled token throws OperationCanceledException cleanly
        using var cts = new CancellationTokenSource();
        cts.Cancel();
        var cancelled = false;
        try { _ = index.SearchWithCursor("alpha beta", ArticleSearchSort.Relevance, 10, null, 0, cts.Token, out _); }
        catch (OperationCanceledException) { cancelled = true; }
        Require(cancelled, "Pre-cancelled token must throw OperationCanceledException");

        // 3. Tight workBudget throws SearchBudgetExceededException cleanly and returns pooled heap in finally
        var budgeted = false;
        try { _ = index.SearchWithCursor("alpha beta", ArticleSearchSort.Relevance, 10, null, 0, CancellationToken.None, out _, workBudget: 3); }
        catch (SearchBudgetExceededException) { budgeted = true; }
        Require(budgeted, "Exceeded workBudget must throw SearchBudgetExceededException");

        return (weakIndex, weakArticle);
    }

    private static void AssertDetailedPrefixEqual(string label, ArticleSearchDetailedPage expected, ArticleSearchDetailedPage actual, int limit)
    {
        CheckSearchTotals(label, expected, actual);
        CheckSearchHits(label, expected.Hits.AsSpan(0, Math.Min(expected.Hits.Length, limit)), actual.Hits, 1e-11);
    }

    private static void AssertCursorTopKMatchesOracle(string label, ArticleSearchDetailedPage expected, ArticleSearchCursorPage actual) =>
        CheckSearchHits(label, expected.Hits, actual.Hits, 1e-11);

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException($"SearchPruningVectors failed: {message}");
    }
}
