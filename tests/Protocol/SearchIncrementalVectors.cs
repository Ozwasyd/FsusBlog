using System.Runtime.CompilerServices;

internal static class SearchIncrementalVectors
{
    internal static void Run(string fixtures)
    {
        VerifyInstrumentationProvesSkippedAnalysisAndCompaction();
        VerifyFieldOnlyCoordinatesVersionAndEmptyTransitions();
        VerifyRandomizedMutationSequencesMatchFullAndOracle();
        VerifyMultiBlockPruningExactAfterIncrementalAndCompaction();
        VerifyBoundedWorkBudgetCompaction();
        VerifyFreshStringsZeroRetainedMemoryAndCancellation();
    }

    private static void VerifyInstrumentationProvesSkippedAnalysisAndCompaction()
    {
        var baseTime = new DateTimeOffset(2026, 8, 1, 0, 0, 0, TimeSpan.Zero);
        var articles = Enumerable.Range(1, 300).Select(id => MakeArticle(id, baseTime)).ToList();

        var cold = ArticleSearchIndex.BuildIncremental(articles, previous: null, CancellationToken.None, out var coldStats)!;
        Require(coldStats.BuildMode == "full-cold", $"cold BuildMode={coldStats.BuildMode}");
        Require(coldStats.AnalyzedDocuments == 300 && coldStats.SkippedAnalysisDocuments == 0, "cold must analyze all 300 docs");
        Require(coldStats.TotalSegments == 1 && coldStats.DeadDocumentSlots == 0, "cold must be 1 clean segment");

        // 1. Single-document edit: MUST analyze strictly 1 doc and skip 299!
        var edited = articles.ToList();
        edited[149] = edited[149] with
        {
            Revision = 2, RevisionNo = 2, Publication = 200_150, PublicationNo = 2,
            Body = edited[149].Body + " incremental_edit_canary_150"
        };
        var afterEdit = ArticleSearchIndex.BuildIncremental(edited, cold, CancellationToken.None, out var editStats)!;
        Require(editStats.BuildMode == "incremental", $"edit BuildMode={editStats.BuildMode}");
        Require(editStats.AnalyzedDocuments == 1 && editStats.ReindexedDocuments == 1 && editStats.RemovedDocuments == 1,
            $"edit stats mismatch: {editStats}");
        Require(editStats.SkippedAnalysisDocuments == 299 && editStats.ReusedSegments == 1 && editStats.TotalSegments == 2,
            $"edit reuse mismatch: {editStats}");
        Require(editStats.DeadDocumentSlots == 1 && !editStats.Compacted, $"edit dead/compact mismatch: {editStats}");
        Require(editStats.BytesRewritten * 20 < coldStats.BytesRewritten,
            $"expected 1-doc edit to rewrite <5% bytes, got {editStats.BytesRewritten} vs {coldStats.BytesRewritten}");
        Require(afterEdit.Search("incremental_edit_canary_150", CancellationToken.None).Select(static a => a.Id).SequenceEqual([150]),
            "edited article must be searchable immediately");

        // 2. Single-document publish: analyzes 1, skips 300, 0 removed!
        var added = edited.ToList();
        added.Add(MakeArticle(301, baseTime) with { Title = "Brand new 301 incremental_add_canary" });
        var afterAdd = ArticleSearchIndex.BuildIncremental(added, afterEdit, CancellationToken.None, out var addStats)!;
        Require(addStats.AnalyzedDocuments == 1 && addStats.RemovedDocuments == 0 && addStats.SkippedAnalysisDocuments == 300,
            $"add stats mismatch: {addStats}");
        Require(addStats.ReusedSegments == 2 && addStats.TotalSegments == 3, $"add segments mismatch: {addStats}");

        // 3. Single-document withdraw: 0 analyzed, 1 removed, 0 bytes rewritten!
        var withdrawn = added.Where(static a => a.Id != 301).ToList();
        var afterWithdraw = ArticleSearchIndex.BuildIncremental(withdrawn, afterAdd, CancellationToken.None, out var withdrawStats)!;
        Require(withdrawStats.AnalyzedDocuments == 0 && withdrawStats.RemovedDocuments == 1 && withdrawStats.SkippedAnalysisDocuments == 300,
            $"withdraw stats mismatch: {withdrawStats}");
        Require(withdrawStats.BytesRewritten == 0 && withdrawStats.TotalSegments == 2,
            $"withdrawing sole doc in delta segment must drop dead segment with 0 bytes rewritten: {withdrawStats}");
        Require(afterWithdraw.Search("incremental_add_canary", CancellationToken.None).Length == 0,
            "withdrawn doc must never be returned");

        // 4. Unchanged reload with freshly allocated strings (DB simulation): 0 analyzed, 0 bytes rewritten!
        var cloned = withdrawn.Select(CloneStrings).ToList();
        var afterNoop = ArticleSearchIndex.BuildIncremental(cloned, afterWithdraw, CancellationToken.None, out var noopStats)!;
        Require(noopStats.BuildMode == "incremental-noop" && noopStats.AnalyzedDocuments == 0 &&
                noopStats.SkippedAnalysisDocuments == 300 && noopStats.BytesRewritten == 0,
            $"noop stats mismatch: {noopStats}");

        // 5. Trigger compaction via MaxSegmentsBeforeCompact: MUST merge with ZERO reanalysis of surviving docs!
        var cur = afterNoop;
        var list = cloned;
        var sawCompaction = false;
        for (var step = 1; step <= 10; step++)
        {
            list = list.ToList();
            list.Add(MakeArticle(400 + step, baseTime) with { Title = $"Compaction wave {step} compact_canary_{step}" });
            var prev = cur;
            cur = ArticleSearchIndex.BuildIncremental(list, prev, CancellationToken.None, out var st)!;
            Require(st.AnalyzedDocuments == 1, $"step {step} must only analyze the 1 new article (even during compaction!), got {st.AnalyzedDocuments}");
            if (st.Compacted)
            {
                sawCompaction = true;
                Require(st.TotalSegments == 1 && st.DeadDocumentSlots == 0 && st.CompactedSegments >= 8,
                    $"compaction should collapse cleanly: {st}");
                // Verify search parity immediately before vs after compaction against fresh rebuild
                var fresh = ArticleSearchIndex.Build(list, CancellationToken.None)!;
                AssertIndexesEquivalent($"post-compaction-step-{step}", fresh, cur,
                    ["incremental_edit_canary_150", "compact_canary_1", $"compact_canary_{step}", "性能 架构", "alpha beta gamma"]);
            }
        }
        Require(sawCompaction, "expected segment-threshold compaction within 10 incremental publications");
    }

    private static void VerifyFieldOnlyCoordinatesVersionAndEmptyTransitions()
    {
        var t0 = new DateTimeOffset(2026, 9, 1, 12, 0, 0, TimeSpan.Zero);
        var baseline = new List<Article>
        {
            new(1, 1, 100, 1, 1, "Alpha Title", "## HeadingOne\n\nBodyOne C# .NET", t0, t0, t0, "SummaryOne",
                new TaxonomyName(10, "CatOne"), [new TaxonomyName(20, "TagOne"), new TaxonomyName(21, "TagTwo")]),
            new(2, 1, 101, 1, 1, "Beta Title", "## HeadingTwo\n\nBodyTwo PostgreSQL", t0.AddHours(1), t0.AddHours(1), t0.AddHours(1), "SummaryTwo",
                new TaxonomyName(10, "CatOne"), [new TaxonomyName(20, "TagOne")])
        };

        var idx0 = ArticleSearchIndex.BuildIncremental(baseline, null, CancellationToken.None, out _)!;

        // Every search-relevant field-only mutation AND coordinate-only mutation (unchanged text!) must reindex ONLY doc 1.
        (string Name, Func<Article, Article> Mutate, string CheckQuery)[] mutations =
        [
            ("Title-only", a => a with { Title = "GammaRenamedTitle" }, "GammaRenamedTitle"),
            ("Summary-only", a => a with { Summary = "UniqueSummaryToken99" }, "UniqueSummaryToken99"),
            ("Body-only", a => a with { Body = "## HeadingOne\n\nBodyOne UniqueBodyToken99" }, "UniqueBodyToken99"),
            ("Category-name", a => a with { Category = new TaxonomyName(10, "CatRenamed99") }, "CatRenamed99"),
            ("Category-id-only", a => a with { Category = new TaxonomyName(11, "CatOne") }, "CatOne"),
            ("Category-removed", a => a with { Category = null }, "Alpha"),
            ("Tag-renamed", a => a with { Tags = [new TaxonomyName(20, "TagRenamed99"), a.Tags![1]] }, "TagRenamed99"),
            ("Tag-order-swapped", a => a with { Tags = [a.Tags![1], a.Tags![0]] }, "TagTwo"),
            ("PublishedAt-only", a => a with { PublishedAt = a.PublishedAt.AddDays(5) }, "Alpha"),
            ("CreatedAt-only", a => a with { CreatedAt = a.CreatedAt.AddDays(5) }, "Alpha"),
            ("Unchanged-text-Revision", a => a with { Revision = 99 }, "Alpha"),
            ("Unchanged-text-RevisionNo", a => a with { RevisionNo = 9 }, "Alpha"),
            ("Unchanged-text-Publication", a => a with { Publication = 9999 }, "Alpha"),
            ("Unchanged-text-PublicationNo", a => a with { PublicationNo = 9 }, "Alpha"),
        ];

        foreach (var (name, mutate, query) in mutations)
        {
            var mutated = new List<Article> { mutate(baseline[0]), baseline[1] };
            var next = ArticleSearchIndex.BuildIncremental(mutated, idx0, CancellationToken.None, out var stats)!;
            Require(stats.AnalyzedDocuments == 1 && stats.SkippedAnalysisDocuments == 1 && stats.RemovedDocuments == 1,
                $"[{name}] expected 1 analyzed / 1 skipped / 1 removed, got {stats}");
            var fresh = ArticleSearchIndex.Build(mutated, CancellationToken.None)!;
            AssertIndexesEquivalent($"field-mut:{name}", fresh, next, [query, "Alpha", "CatOne", "TagOne", "BodyOne", "C#"]);

            // Verify returned Article carries exact new coordinates/timestamps!
            var hit = next.Search(query, CancellationToken.None).FirstOrDefault(static a => a.Id == 1);
            if (hit is not null)
            {
                Require(hit.Revision == mutated[0].Revision && hit.Publication == mutated[0].Publication &&
                        hit.RevisionNo == mutated[0].RevisionNo && hit.PublicationNo == mutated[0].PublicationNo &&
                        hit.PublishedAt == mutated[0].PublishedAt && hit.CreatedAt == mutated[0].CreatedAt,
                    $"[{name}] returned hit coordinates mismatch");
            }
        }

        // AnalyzerVersion or ProfileVersion change MUST trigger full rebuild (0 reused segments, 0 skipped)
        var oldAnalyzer = idx0.WithVersionMetadataForTesting(idx0.AnalyzerVersion - 1, idx0.ProfileVersion);
        var rebuiltAnalyzer = ArticleSearchIndex.BuildIncremental(baseline, oldAnalyzer, CancellationToken.None, out var aStats)!;
        Require(aStats.BuildMode == "full-version-change" && aStats.ReusedSegments == 0 &&
                aStats.SkippedAnalysisDocuments == 0 && aStats.AnalyzedDocuments == 2,
            $"analyzer version change must force full rebuild: {aStats}");
        Require(rebuiltAnalyzer.AnalyzerVersion == SearchTextAnalyzer.Version, "rebuilt analyzer version mismatch");

        var oldProfile = idx0.WithVersionMetadataForTesting(idx0.AnalyzerVersion, idx0.ProfileVersion - 1);
        var rebuiltProfile = ArticleSearchIndex.BuildIncremental(baseline, oldProfile, CancellationToken.None, out var pStats)!;
        Require(pStats.BuildMode == "full-version-change" && pStats.ReusedSegments == 0 &&
                pStats.SkippedAnalysisDocuments == 0 && pStats.AnalyzedDocuments == 2,
            $"profile version change must force full rebuild: {pStats}");

        // Empty corpus transitions: non-empty -> empty -> empty -> non-empty
        var empty1 = ArticleSearchIndex.BuildIncremental([], idx0, CancellationToken.None, out var e1Stats)!;
        Require(e1Stats.BuildMode == "full-empty" && empty1.DocumentCount == 0 && empty1.SegmentCount == 0 &&
                e1Stats.RemovedDocuments == 2, $"non-empty->empty mismatch: {e1Stats}");
        Require(empty1.Search("Alpha", CancellationToken.None).Length == 0, "empty index must return 0 hits");

        var empty2 = ArticleSearchIndex.BuildIncremental([], empty1, CancellationToken.None, out var e2Stats)!;
        Require(e2Stats.BuildMode == "full-empty" && empty2.DocumentCount == 0, "empty->empty mismatch");

        var back = ArticleSearchIndex.BuildIncremental(baseline, empty2, CancellationToken.None, out var bStats)!;
        Require(bStats.BuildMode == "full-from-empty" && back.DocumentCount == 2 && bStats.AnalyzedDocuments == 2,
            $"empty->non-empty mismatch: {bStats}");
        AssertIndexesEquivalent("empty-roundtrip", idx0, back, ["Alpha", "Beta", "C#", "CatOne"]);
    }

    private static void VerifyRandomizedMutationSequencesMatchFullAndOracle()
    {
        var baseTime = new DateTimeOffset(2026, 6, 1, 0, 0, 0, TimeSpan.Zero);
        var vocab = new[]
        {
            "alpha", "beta", "gamma", "delta", "epsilon", "zeta",
            "C#", "C++", ".NET", "HTTP/2", "issue-2205", "batch-item", "batch", "item",
            "Go", "Golang", "filter", "ﬁlter",
            "博客", "搜索", "数据库", "數據庫", "架构", "架構", "性能", "索引",
            "量子纠缠", "林徽因", "微核调度", "系统"
        };
        var probeQueries = new[]
        {
            "alpha", "sharedanchor", "C#", ".NET", "issue-2205", "batch-item", "go", "fi",
            "数据库", "數據庫", "量子纠缠", "林徽因",
            "alpha beta", "数据库 架构", "sharedanchor alpha", "go alpha", "batch-item alpha",
            "alpha beta gamma", "alpha beta gamma delta", "量子纠缠 林徽因 微核调度",
            "\"alpha beta\"", "\"博客 搜索\"", "\"alpha beta\" gamma delta",
            "C# alpha beta gamma", "absenttermxyz"
        };

        // Run 2 independent seeds x 110 steps = 220 randomized mutations covering both tight & default compaction policies!
        var configs = new (int Seed, SearchIndexCompactionPolicy Policy)[]
        {
            (51_001, new SearchIndexCompactionPolicy(MaxSegmentsBeforeCompact: 5, MaxDeletionRatioBeforeCompact: 0.20, MinDeadDocsToCompact: 8, MaxCompactionWorkDocs: 8_000)),
            (51_002, SearchIndexCompactionPolicy.Default),
        };

        foreach (var (seed, policy) in configs)
        {
            var rng = new Random(seed);
            var state = new Dictionary<int, Article>();
            var nextId = 1;
            var withdrawnCanaries = new List<string>();

            Article RandomArticle(int id, long rev, long pub, string? extraUnique = null)
            {
                var titleWords = Enumerable.Range(0, 2 + rng.Next(4)).Select(_ => vocab[rng.Next(vocab.Length)]);
                var headWords = Enumerable.Range(0, 2 + rng.Next(2)).Select(_ => vocab[rng.Next(vocab.Length)]);
                var bodyWords = Enumerable.Range(0, 8 + rng.Next(18)).Select(_ => vocab[rng.Next(vocab.Length)]);
                var common = rng.Next(10) < 7 ? "sharedanchor " : "";
                var body = $"## {string.Join(' ', headWords)}\n\n{common}{string.Join(' ', bodyWords)} {extraUnique ?? ""}";
                var pubAt = baseTime.AddHours(rng.Next(30));
                var crAt = baseTime.AddHours(rng.Next(20));
                var catIdx = rng.Next(6);
                var cat = catIdx == 0 ? null : new TaxonomyName(catIdx, vocab[rng.Next(vocab.Length)]);
                var tagCount = rng.Next(3);
                var tags = tagCount == 0 ? null : Enumerable.Range(0, tagCount)
                    .Select(t => new TaxonomyName(100 + t, vocab[rng.Next(vocab.Length)])).ToArray();
                return new Article(id, rev, pub, (int)rev, (int)rev,
                    string.Join(' ', titleWords), body, crAt, crAt, pubAt,
                    $"{vocab[rng.Next(vocab.Length)]} 摘要", cat, tags);
            }

            // Seed 65 initial articles
            for (var i = 0; i < 65; i++)
            {
                var id = nextId++;
                state[id] = RandomArticle(id, 1, id);
            }

            var current = ArticleSearchIndex.BuildIncremental(state.Values.ToArray(), null, CancellationToken.None, out _, policy)!;
            var compactionObserved = 0;

            for (var step = 1; step <= 110; step++)
            {
                var op = rng.Next(100);
                if (op < 25)
                {
                    // Publish 1..3 new articles
                    var count = 1 + rng.Next(3);
                    for (var j = 0; j < count; j++)
                    {
                        var id = nextId++;
                        state[id] = RandomArticle(id, 1, step * 100 + j);
                    }
                }
                else if (op < 55 && state.Count > 0)
                {
                    // Edit 1..3 existing articles (including coordinate-only or field-only edits)
                    var keys = state.Keys.ToArray();
                    var count = Math.Min(keys.Length, 1 + rng.Next(3));
                    for (var j = 0; j < count; j++)
                    {
                        var id = keys[rng.Next(keys.Length)];
                        var old = state[id];
                        state[id] = rng.Next(4) == 0
                            ? old with { Publication = old.Publication + 1000, PublicationNo = old.PublicationNo + 1, PublishedAt = old.PublishedAt.AddMinutes(5) }
                            : RandomArticle(id, old.Revision + 1, old.Publication + 1000);
                    }
                }
                else if (op < 75 && state.Count > 5)
                {
                    // Withdraw 1..4 articles (with unique canary to prove zero resurrection!)
                    var keys = state.Keys.ToArray();
                    var count = Math.Min(state.Count - 3, 1 + rng.Next(4));
                    for (var j = 0; j < count; j++)
                    {
                        var id = keys[rng.Next(keys.Length)];
                        if (!state.TryGetValue(id, out var target)) continue;
                        var canary = $"withdrawn_canary_{seed}_{step}_{id}";
                        // First publish canary, then immediately withdraw on next step? Even simpler: inject canary before removing
                        state[id] = target with { Revision = target.Revision + 1, Body = target.Body + " " + canary };
                        current = ArticleSearchIndex.BuildIncremental(state.Values.ToArray(), current, CancellationToken.None, out _, policy)!;
                        state.Remove(id);
                        withdrawnCanaries.Add(canary);
                    }
                }
                else if (op < 88 && state.Count > 0)
                {
                    // Taxonomy rename across all articles sharing category 1 or 2 (broad semantic impact)
                    var targetCatId = 1 + rng.Next(2);
                    var renamed = vocab[rng.Next(vocab.Length)];
                    foreach (var id in state.Keys.ToArray())
                    {
                        if (state[id].Category?.Id == targetCatId)
                            state[id] = state[id] with { Category = new TaxonomyName(targetCatId, renamed) };
                    }
                }
                else if (op < 96)
                {
                    // Republish a previously withdrawn ID with fresh content
                    var reusedId = 1 + rng.Next(Math.Max(1, nextId - 1));
                    state[reusedId] = RandomArticle(reusedId, 10 + step, 900_000 + step);
                }
                else
                {
                    // Full wipe to empty and recover on next step
                    var empty = ArticleSearchIndex.BuildIncremental([], current, CancellationToken.None, out _, policy)!;
                    Require(empty.DocumentCount == 0, "empty transition failed");
                    current = empty;
                    continue;
                }

                // Shuffle article input order every step to verify order-independence
                var snapshotArticles = state.Values.OrderBy(_ => rng.Next()).ToArray();
                current = ArticleSearchIndex.BuildIncremental(snapshotArticles, current, CancellationToken.None, out var stepStats, policy)!;
                if (stepStats.Compacted) compactionObserved++;

                // Every 15 steps AND on every compaction step, verify 100% parity vs fresh full Build + ExhaustiveSearchOracle!
                if (stepStats.Compacted || step % 15 == 0 || step == 110)
                {
                    var fresh = ArticleSearchIndex.Build(snapshotArticles, CancellationToken.None)!;
                    var oracle = ExhaustiveSearchOracle.Build(snapshotArticles, CancellationToken.None);

                    Require(current.DocumentCount == fresh.DocumentCount, $"seed {seed} step {step} DocumentCount mismatch");
                    for (var f = 0; f < SearchScoringProfile.FieldCount; f++)
                    {
                        var field = (SearchScoreField)f;
                        var diff = Math.Abs(current.GetAverageFieldLength(field) - fresh.GetAverageFieldLength(field));
                        Require(diff <= 1e-12, $"seed {seed} step {step} avgLen[{field}] drift={diff}");
                    }

                    // Verify exact global DF parity for all probe terms
                    foreach (var term in new[] { "alpha", "beta", "sharedanchor", "c#", ".net", "数据库", "博客" })
                    {
                        var key = SearchTermKey.From(term);
                        Require(current.GetGlobalLiveDf(key) == fresh.GetGlobalLiveDf(key),
                            $"seed {seed} step {step} globalDf[{term}] inc={current.GetGlobalLiveDf(key)} fresh={fresh.GetGlobalLiveDf(key)}");
                    }

                    // Verify zero withdrawn canary resurrection
                    foreach (var canary in withdrawnCanaries.TakeLast(10))
                    {
                        Require(current.Search(canary, CancellationToken.None).Length == 0,
                            $"seed {seed} step {step} WITHDRAWN CANARY RESURRECTED: {canary}");
                    }

                    // Full parity check (Relevance + Latest, SearchDetailed + full SearchWithCursor pagination walk)
                    AssertMatchesOracleFull($"seed={seed}:step={step}:segs={current.SegmentCount}:dead={current.DeadDocumentSlots}",
                        oracle, fresh, current, probeQueries);
                }
            }
            Require(compactionObserved >= 2, $"expected >= 2 compactions in seed {seed}, got {compactionObserved}");
        }
    }

    private static void VerifyMultiBlockPruningExactAfterIncrementalAndCompaction()
    {
        // Build 320-doc multi-block corpus (5 blocks), apply deletions + insertions across multiple segments
        // WITHOUT compacting yet, verify #48 block pruning skips blocks AND matches ExhaustiveSearchOracle 100%,
        // then trigger compaction and verify again!
        var baseTime = new DateTimeOffset(2026, 7, 1, 0, 0, 0, TimeSpan.Zero);
        var articles = Enumerable.Range(1, 320).Select(id => new Article(
            id, 1, id, 1, 1,
            id <= 20 ? $"性能 架构 核心 {id}" : $"常规条目 {id}",
            id <= 20
                ? $"## 性能 架构\n\n性能 架构 优化 详解 {id}"
                : $"包含 性能 与 架构 以及 优化 的常规多块测试正文 {id}",
            baseTime.AddHours(id), baseTime.AddHours(id),
            id <= 20 ? baseTime.AddDays(500 - id) : baseTime.AddHours(id),
            $"摘要 {id}", new TaxonomyName(1, "Tech"), [new TaxonomyName(2, "Search")])).ToList();

        var noAutoCompact = new SearchIndexCompactionPolicy(MaxSegmentsBeforeCompact: 50, MaxDeletionRatioBeforeCompact: 0.90, MinDeadDocsToCompact: 500);
        var idx = ArticleSearchIndex.BuildIncremental(articles, null, CancellationToken.None, out _, noAutoCompact)!;

        // Apply 4 incremental mutations creating tombstones inside Block 0..4 (leaving >= 12 early winners
        // alive in Block 0 so Top-10 fills immediately for Block-Max pruning) and adding 4 delta segments!
        for (var wave = 1; wave <= 4; wave++)
        {
            // Withdraw 2 early winners (ids 1..8) & 2 mid-corpus docs per wave, and add 5 new winners in a delta segment
            articles.RemoveAll(a => a.Id == wave * 2 - 1 || a.Id == wave * 2);
            articles.RemoveAll(a => a.Id == 100 + wave || a.Id == 200 + wave);
            for (var j = 0; j < 5; j++)
            {
                var newId = 1000 + wave * 10 + j;
                articles.Add(new Article(
                    newId, 1, newId, 1, 1,
                    $"性能 架构 新增 {newId}",
                    $"## 性能 架构\n\n性能 架构 优化 高分新增文章 {newId}",
                    baseTime.AddDays(600 + wave), baseTime.AddDays(600 + wave), baseTime.AddDays(600 + wave),
                    "性能 摘要", new TaxonomyName(1, "Tech"), [new TaxonomyName(2, "Search")]));
            }
            idx = ArticleSearchIndex.BuildIncremental(articles, idx, CancellationToken.None, out _, noAutoCompact)!;
        }

        Require(idx.SegmentCount == 5 && idx.DeadDocumentSlots > 10,
            $"expected multi-segment masked state, got segs={idx.SegmentCount}, dead={idx.DeadDocumentSlots}");

        var oracle = ExhaustiveSearchOracle.Build(articles, CancellationToken.None);
        var fresh = ArticleSearchIndex.Build(articles, CancellationToken.None)!;

        // Verify block skipping still engages AND produces 100% exact Top-K + truthful counts on multi-segment masked index!
        var pageRel = idx.SearchWithCursor("性能", ArticleSearchSort.Relevance, 10, null, 0, CancellationToken.None, out var statsRel);
        var pageLat = idx.SearchWithCursor("性能", ArticleSearchSort.Latest, 10, null, 0, CancellationToken.None, out var statsLat);
        Require(statsRel.BlocksSkipped > 0, $"expected Block-Max pruning on multi-segment Relevance, got {statsRel.BlocksSkipped}");
        Require(statsLat.BlocksSkipped > 0, $"expected Latest block pruning on multi-segment Latest, got {statsLat.BlocksSkipped}");
        Require(pageRel.TotalCount == articles.Count && pageRel.TotalRelation == PublicSearchTotalRelation.Exact,
            $"multi-segment single term exact global DF failed: got {pageRel.TotalCount} ({pageRel.TotalRelation}), expected {articles.Count}");
        AssertMatchesOracleFull("multi-segment-pruned", oracle, fresh, idx, ["性能", "性能 架构", "性能 架构 优化 不存在词项"]);

        // Now force compaction via tight policy and verify 100% identical results + pruning!
        var tightPolicy = new SearchIndexCompactionPolicy(MaxSegmentsBeforeCompact: 2, MaxDeletionRatioBeforeCompact: 0.05, MinDeadDocsToCompact: 1);
        articles.Add(MakeArticle(2000, baseTime) with { Title = "性能 触发合并" });
        var compacted = ArticleSearchIndex.BuildIncremental(articles, idx, CancellationToken.None, out var cStats, tightPolicy)!;
        Require(cStats.Compacted && compacted.SegmentCount == 1 && compacted.DeadDocumentSlots == 0 && cStats.AnalyzedDocuments == 1,
            $"forced compaction failed: {cStats}");
        var oracleAfter = ExhaustiveSearchOracle.Build(articles, CancellationToken.None);
        var freshAfter = ArticleSearchIndex.Build(articles, CancellationToken.None)!;
        AssertMatchesOracleFull("post-forced-compaction", oracleAfter, freshAfter, compacted, ["性能", "性能 架构", "性能 架构 优化 不存在词项"]);
    }

    private static void VerifyBoundedWorkBudgetCompaction()
    {
        var baseTime = new DateTimeOffset(2026, 8, 1, 0, 0, 0, TimeSpan.Zero);
        var articles = Enumerable.Range(1, 120).Select(id => MakeArticle(id, baseTime)).ToList();
        var policy = new SearchIndexCompactionPolicy(
            MaxSegmentsBeforeCompact: 5,
            MaxDeletionRatioBeforeCompact: 0.50,
            MinDeadDocsToCompact: 50,
            MaxCompactionWorkDocs: 20);

        var idx = ArticleSearchIndex.BuildIncremental(articles, null, CancellationToken.None, out _, policy)!;
        // Add 4 single-article delta segments -> hits MaxSegmentsBeforeCompact = 5,
        // work budget 20 MUST compact only the 4 small delta segments (4 docs) and REUSE the 120-doc base segment!
        SearchIndexBuildStats lastStats = default;
        for (var i = 1; i <= 4; i++)
        {
            articles.Add(MakeArticle(500 + i, baseTime) with { Title = $"BoundedWork {i}" });
            idx = ArticleSearchIndex.BuildIncremental(articles, idx, CancellationToken.None, out lastStats, policy)!;
        }
        Require(lastStats.Compacted, "expected bounded-work compaction on 5th segment");
        Require(lastStats.TotalSegments == 2 && lastStats.ReusedSegments == 1 && lastStats.CompactedSegments == 4,
            $"expected 120-doc base segment reused while 4 tiny deltas compacted: {lastStats}");
        var fresh = ArticleSearchIndex.Build(articles, CancellationToken.None)!;
        AssertIndexesEquivalent("bounded-work-compaction", fresh, idx, ["BoundedWork", "性能", "alpha"]);
    }

    private static void VerifyFreshStringsZeroRetainedMemoryAndCancellation()
    {
        // 1. Reused immutable segments must NEVER retain obsolete Article/Body strings from previous snapshots!
        var (nextIndex, oldBodyRef) = BuildWithFreshDbStrings();
        for (var i = 0; i < 4 && oldBodyRef.IsAlive; i++)
        {
            GC.Collect(GC.MaxGeneration, GCCollectionMode.Aggressive, blocking: true, compacting: true);
            GC.WaitForPendingFinalizers();
        }
        Require(!oldBodyRef.IsAlive, "Reused segments must not pin obsolete Body strings from retired snapshots.");
        GC.KeepAlive(nextIndex);

        // 2. Cancellation before/during incremental build & compaction leaves previous index completely intact!
        var baseTime = new DateTimeOffset(2026, 8, 1, 0, 0, 0, TimeSpan.Zero);
        var docs = Enumerable.Range(1, 50).Select(id => MakeArticle(id, baseTime)).ToList();
        var prev = ArticleSearchIndex.BuildIncremental(docs, null, CancellationToken.None, out _)!;
        docs.Add(MakeArticle(999, baseTime) with { Title = "CancelledAdd" });
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        var threw = false;
        try { _ = ArticleSearchIndex.BuildIncremental(docs, prev, cancelled.Token, out _); }
        catch (OperationCanceledException) { threw = true; }
        Require(threw, "BuildIncremental must honor CancellationToken");
        Require(prev.DocumentCount == 50 && prev.Search("CancelledAdd", CancellationToken.None).Length == 0,
            "previous index must remain uncorrupted after cancelled incremental build");

        [MethodImpl(MethodImplOptions.NoInlining)]
        static (ArticleSearchIndex Next, WeakReference OldBody) BuildWithFreshDbStrings()
        {
            var baseTime = new DateTimeOffset(2026, 8, 1, 0, 0, 0, TimeSpan.Zero);
            var initial = Enumerable.Range(1, 40)
                .Select(id => MakeArticle(id, baseTime) with { Body = $"Article {id} " + new string('z', 8_192) })
                .ToArray();
            var prev = ArticleSearchIndex.BuildIncremental(initial, null, CancellationToken.None, out _)!;
            var weak = new WeakReference(initial[0].Body);

            var reloaded = initial.Select(CloneStrings).ToArray();
            reloaded[^1] = reloaded[^1] with { Revision = 2, Body = reloaded[^1].Body + " fresh_edit" };
            var next = ArticleSearchIndex.BuildIncremental(reloaded, prev, CancellationToken.None, out var stats)!;
            Require(stats.ReusedSegments == 1 && stats.SkippedAnalysisDocuments == 39, "expected segment reuse");
            return (next, weak);
        }
    }

    private static void AssertIndexesEquivalent(string label, ArticleSearchIndex expected, ArticleSearchIndex actual, string[] queries)
    {
        foreach (var sort in new[] { ArticleSearchSort.Relevance, ArticleSearchSort.Latest })
        {
            foreach (var q in queries)
            {
                var exp = expected.SearchDetailed(q, sort, 1, 50, CancellationToken.None);
                var got = actual.SearchDetailed(q, sort, 1, 50, CancellationToken.None);
                var context = $"{label}:{sort}:{q}";
                CheckSearchTotals(context, exp, got);
                CheckSearchHits(context, exp.Hits, got.Hits, 1e-11);
            }
        }
    }

    private static void AssertMatchesOracleFull(string label, ExhaustiveSearchOracle oracle, ArticleSearchIndex fresh, ArticleSearchIndex inc, string[] queries)
    {
        foreach (var sort in new[] { ArticleSearchSort.Relevance, ArticleSearchSort.Latest })
        {
            foreach (var q in queries)
            {
                var expectedAll = oracle.SearchDetailed(q, sort, 1, ArticleSearchIndex.MaxPaginatedResults, CancellationToken.None);
                var freshPage = fresh.SearchDetailed(q, sort, 1, 200, CancellationToken.None);
                var incPage = inc.SearchDetailed(q, sort, 1, 200, CancellationToken.None);

                var context = $"{label}:{sort}:{q}";
                CheckSearchTotals(context, expectedAll, incPage);
                Require(incPage.Hits.Length == freshPage.Hits.Length,
                    $"[{context}] hit count mismatch inc={incPage.Hits.Length} fresh={freshPage.Hits.Length}");
                CheckSearchHits(context, expectedAll.Hits.AsSpan(0, freshPage.Hits.Length), incPage.Hits, 1e-11);

                CheckSearchCursorWalk(context, inc, expectedAll, q, sort, 9, 50, checkLowerBoundTierSum: false);
            }
        }
    }

    private static Article MakeArticle(int id, DateTimeOffset baseTime) => new(
        id, 1, 1000 + id, 1, 1,
        $"Article {id} 性能 alpha",
        $"## 架构 {id}\n\n博客搜索 性能 架构 alpha beta gamma C# .NET article_{id}",
        baseTime.AddMinutes(id), baseTime.AddMinutes(id), baseTime.AddMinutes(id),
        $"Summary {id} 性能",
        new TaxonomyName(1 + (id % 4), id % 2 == 0 ? "Backend" : "Systems"),
        [new TaxonomyName(10 + (id % 5), "Search")]);

    private static Article CloneStrings(Article article) => article with
    {
        Title = new string(article.Title.AsSpan()),
        Body = new string(article.Body.AsSpan()),
        Summary = article.Summary is null ? null : new string(article.Summary.AsSpan()),
        Category = article.Category is null ? null : new TaxonomyName(article.Category.Id, new string(article.Category.Name.AsSpan())),
        Tags = article.Tags?.Select(t => new TaxonomyName(t.Id, new string(t.Name.AsSpan()))).ToArray()
    };

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException("SearchIncrementalVectors failed: " + message);
    }
}
