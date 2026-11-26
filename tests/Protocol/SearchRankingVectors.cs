using System.Text.Json;

internal static class SearchRankingVectors
{
    private sealed record ExpectedConcept(string Kind, string[] Steps, string[]? ExactSteps, bool IsStrictIdentifier, string? ShortAsciiPrefix);
    private sealed record PlanCase(
        string Name,
        string Input,
        bool IsEmpty,
        bool IsOverlongExactIdentifier,
        bool HasStrictIdentifier,
        int QuotedPhraseCount,
        ExpectedConcept[] ContentConcepts);
    private sealed record PlanVectorFile(int ProfileVersion, int AnalyzerVersion, PlanCase[] Cases);

    internal static void Run(string fixtures)
    {
        VerifyQueryPlanVectors(fixtures);
        VerifyUnknownCjkNonAdmissionAndPositions();
        VerifyCrossFieldConceptsPhrasesIdentifiersAndRelaxation();
        VerifyPhraseAtCompactPositionCountBoundary();
        VerifyExhaustiveOracleDifferentialAndPagination();
        VerifyCompactVsWideDifferential();
    }

    private static void VerifyQueryPlanVectors(string fixtures)
    {
        var opts = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
        var doc = JsonSerializer.Deserialize<PlanVectorFile>(
            File.ReadAllText(Path.Combine(fixtures, "search-query-plan-vectors.json")), opts)
            ?? throw new InvalidDataException("Invalid search-query-plan-vectors.json");

        Require(doc.ProfileVersion == SearchScoringProfile.ProfileVersion, "Query plan vector profileVersion mismatch");
        Require(doc.AnalyzerVersion == SearchTextAnalyzer.Version, "Query plan vector analyzerVersion mismatch");

        foreach (var tc in doc.Cases)
        {
            var plan = SearchQueryPlan.Build(tc.Input, CancellationToken.None);
            Require(plan.IsEmpty == tc.IsEmpty, $"[{tc.Name}] IsEmpty mismatch");
            Require(plan.IsOverlongExactIdentifier == tc.IsOverlongExactIdentifier, $"[{tc.Name}] IsOverlongExactIdentifier mismatch");
            Require(plan.HasStrictIdentifier == tc.HasStrictIdentifier, $"[{tc.Name}] HasStrictIdentifier mismatch");
            Require(plan.QuotedPhrases.Length == tc.QuotedPhraseCount, $"[{tc.Name}] QuotedPhraseCount mismatch");
            Require(plan.ContentConcepts.Length == tc.ContentConcepts.Length,
                $"[{tc.Name}] ContentConcepts count={plan.ContentConcepts.Length}, expected {tc.ContentConcepts.Length}");

            for (var i = 0; i < tc.ContentConcepts.Length; i++)
            {
                var got = plan.ContentConcepts[i];
                var exp = tc.ContentConcepts[i];
                Require(KindName(got.Kind) == exp.Kind, $"[{tc.Name}][{i}] kind={KindName(got.Kind)}, expected {exp.Kind}");
                Require(got.IsStrictIdentifier == exp.IsStrictIdentifier, $"[{tc.Name}][{i}] IsStrictIdentifier mismatch");
                Require(got.ShortAsciiPrefix == exp.ShortAsciiPrefix, $"[{tc.Name}][{i}] ShortAsciiPrefix mismatch");
                Require(got.Steps.Select(static s => s.CanonicalTerm).SequenceEqual(exp.Steps),
                    $"[{tc.Name}][{i}] canonical steps mismatch");
                if (exp.ExactSteps is not null)
                    Require(got.Steps.Select(static s => s.ExactFormTerm).SequenceEqual(exp.ExactSteps),
                        $"[{tc.Name}][{i}] exact steps mismatch");
            }
        }
    }

    private static void VerifyUnknownCjkNonAdmissionAndPositions()
    {
        var when = new DateTimeOffset(2026, 2, 1, 0, 0, 0, TimeSpan.Zero);
        var articles = new[]
        {
            // Target: contains contiguous "量子纠缠" and "林徽因"
            Art(1, "量子纠缠实验记录", "讨论量子纠缠与林徽因手稿保存。", when),
            // Distractor 1: contains every single character individually separated (NO contiguous bigrams!)
            Art(2, "量度与子集", "纠偏并缠绕，森林里出现徽章与因果。", when.AddDays(1)),
            // Distractor 2: contains the bigrams "量子", "子纠", "纠缠" in NON-CONSECUTIVE positions!
            Art(3, "量子力学笔记", "分子纠偏。纠缠态分布在不同段落。\n\n子纠只是片段。", when.AddDays(2)),
            // Distractor 3: contains "林徽" in Title and "徽因" in Body (different fields -> NOT contiguous!)
            Art(4, "林徽随笔", "徽因记录在正文里。", when.AddDays(3)),
            // Distractor 4: contains only one constituent char "量"
            Art(5, "测量基准", "只有单字量，没有其他字符。", when.AddDays(4))
        };

        var index = ArticleSearchIndex.Build(articles, CancellationToken.None)!;
        var oracle = ExhaustiveSearchOracle.Build(articles, CancellationToken.None);

        foreach (var q in new[] { "量子纠缠", "林徽因", "白垩纪协议栈" })
        {
            var got = index.SearchDetailed(q, ArticleSearchSort.Relevance, 1, 20, CancellationToken.None);
            var expected = oracle.SearchDetailed(q, ArticleSearchSort.Relevance, 1, 20, CancellationToken.None);
            AssertDetailedEqual(q, expected, got);
            if (q == "白垩纪协议栈")
                Require(got.Hits.Length == 0, "Unknown compound + dict term must not falsely admit docs");
            else
                Require(got.Hits.Select(static h => h.Article.Id).SequenceEqual([1]),
                    $"Unknown Chinese query '{q}' admitted distractor: [{string.Join(',', got.Hits.Select(h => h.Article.Id))}]");
        }
    }

    private static void VerifyCrossFieldConceptsPhrasesIdentifiersAndRelaxation()
    {
        var when = new DateTimeOffset(2026, 3, 1, 0, 0, 0, TimeSpan.Zero);
        var articles = new[]
        {
            // Cross-field coverage: "AEDS" in Title, "PostgreSQL" in Taxonomy, "Snapshot" in Heading, "C#" in Body
            Art(1, "AEDS 二进制框架", "# Snapshot 架构\n\n使用 C# 实现零分配编码，关联 issue-2205。", when,
                summary: "协议设计摘要", category: "PostgreSQL", tags: ["C#", "检索"]),
            // Phrase order test: exact phrase "博客 搜索 引擎" in Title vs out-of-order in Body
            Art(2, "博客 搜索 引擎 设计", "详解博客搜索引擎与 C# 实践。", when.AddDays(1), summary: "引擎", category: "引擎"),
            Art(3, "引擎 设计 笔记", "搜索引擎 博客 逆序分布，也使用 C#。", when.AddDays(2), summary: "逆序"),
            // Relaxation test (3 concepts: alpha beta gamma)
            Art(4, "Alpha Beta Gamma", "Primary full coverage of alpha beta gamma with C#.", when.AddDays(3)),
            Art(5, "Beta Gamma", "Relaxed two-of-three high-IDF coverage beta gamma with C#.", when.AddDays(4)),
            Art(6, "Alpha Only", "Single concept alpha only, must not be relaxed for 3-concept query.", when.AddDays(5)),
            // Traditional vs Simplified exact-form preference
            Art(7, "數據庫架構設計", "繁體數據庫架構詳解。", when.AddDays(6)),
            Art(8, "数据库架构设计", "简体数据库架构详解。", when.AddDays(7))
        };

        var index = ArticleSearchIndex.Build(articles, CancellationToken.None)!;
        var oracle = ExhaustiveSearchOracle.Build(articles, CancellationToken.None);

        // 1. Cross-field full concept coverage
        var cross = index.SearchDetailed("AEDS PostgreSQL Snapshot", ArticleSearchSort.Relevance, 1, 10, CancellationToken.None);
        AssertDetailedEqual("cross-field", oracle.SearchDetailed("AEDS PostgreSQL Snapshot", ArticleSearchSort.Relevance, 1, 10, CancellationToken.None), cross);
        Require(cross.Hits.Length == 1 && cross.Hits[0].Article.Id == 1 && cross.Hits[0].Tier == SearchMatchTier.Primary,
            "Cross-field concept coverage failed");

        // 2. Quoted phrase is strict and NEVER relaxed
        var quoted = index.SearchDetailed("\"博客 搜索 引擎\"", ArticleSearchSort.Relevance, 1, 10, CancellationToken.None);
        AssertDetailedEqual("quoted", oracle.SearchDetailed("\"博客 搜索 引擎\"", ArticleSearchSort.Relevance, 1, 10, CancellationToken.None), quoted);
        Require(quoted.Hits.Select(static h => h.Article.Id).SequenceEqual([2]), "Quoted phrase admitted out-of-order doc");

        var missingQuoted = index.SearchDetailed("\"从未出现的短语\" alpha beta gamma", ArticleSearchSort.Relevance, 1, 10, CancellationToken.None);
        Require(missingQuoted.Hits.Length == 0, "Quoted phrase must never be relaxed");

        // 3. Strict exact identifier is NEVER relaxed
        var missingStrict = index.SearchDetailed("alpha beta gamma issue-9999", ArticleSearchSort.Relevance, 1, 10, CancellationToken.None);
        Require(missingStrict.Hits.Length == 0, "Strict identifier must never be relaxed");

        // 4. Bounded relaxation keeps Primary strictly ahead of Relaxed, deduplicated, and rejects 1/3 weak matches
        var relaxed = index.SearchDetailed("alpha beta gamma", ArticleSearchSort.Relevance, 1, 10, CancellationToken.None);
        AssertDetailedEqual("relaxed", oracle.SearchDetailed("alpha beta gamma", ArticleSearchSort.Relevance, 1, 10, CancellationToken.None), relaxed);
        Require(relaxed.PrimaryTotal == 1 && relaxed.RelaxedTotal == 1 && relaxed.Total == 2,
            $"Unexpected tier counts P={relaxed.PrimaryTotal}, R={relaxed.RelaxedTotal}");
        Require(relaxed.Hits[0].Article.Id == 4 && relaxed.Hits[0].Tier == SearchMatchTier.Primary, "Primary must rank first");
        Require(relaxed.Hits[1].Article.Id == 5 && relaxed.Hits[1].Tier == SearchMatchTier.Relaxed, "Relaxed 2/3 must rank second");

        // Latest sort still keeps Primary strictly ahead of Relaxed (so doc 4 Primary stays ahead of newer doc 5 Relaxed)
        var relaxedLatest = index.SearchDetailed("alpha beta gamma", ArticleSearchSort.Latest, 1, 10, CancellationToken.None);
        AssertDetailedEqual("relaxed-latest", oracle.SearchDetailed("alpha beta gamma", ArticleSearchSort.Latest, 1, 10, CancellationToken.None), relaxedLatest);
        Require(relaxedLatest.Hits.Select(static h => h.Article.Id).SequenceEqual([4, 5]), "Latest sort must keep Primary ahead of Relaxed");

        // 5. Exact-form script preference (Traditional query ranks Traditional doc #1, Simplified query ranks Simplified doc #1)
        var tcHits = index.SearchDetailed("數據庫 架構", ArticleSearchSort.Relevance, 1, 10, CancellationToken.None);
        var scHits = index.SearchDetailed("数据库 架构", ArticleSearchSort.Relevance, 1, 10, CancellationToken.None);
        Require(tcHits.Hits.Select(static h => h.Article.Id).SequenceEqual([7, 8]), "TC query should prefer TC exact form");
        Require(scHits.Hits.Select(static h => h.Article.Id).SequenceEqual([8, 7]), "SC query should prefer SC exact form");

        // 6. Repeated query terms produce identical scores to single term
        var single = index.SearchDetailed("alpha", ArticleSearchSort.Relevance, 1, 10, CancellationToken.None);
        var repeated = index.SearchDetailed("alpha ALPHA alpha", ArticleSearchSort.Relevance, 1, 10, CancellationToken.None);
        AssertDetailedEqual("repeated-terms", single, repeated);
    }

    private static void VerifyPhraseAtCompactPositionCountBoundary()
    {
        const string query = "\"qx ry\"";
        var when = DateTimeOffset.UnixEpoch;
        var articles = new[] { 65_535, 65_536 }.Select(count =>
            Art(count, "Position Boundary", string.Concat(Enumerable.Repeat("qx ", count - 1)) + "qx ry", when)).ToArray();
        var compact = ArticleSearchIndex.Build(articles, CancellationToken.None)!;
        var oracle = ExhaustiveSearchOracle.Build(articles, CancellationToken.None);
        foreach (var sort in new[] { ArticleSearchSort.Relevance, ArticleSearchSort.Latest })
        {
            var expected = oracle.SearchDetailed(query, sort, 1, 10, CancellationToken.None);
            Require(expected.Total == articles.Length, "Both tail phrases must match.");
            AssertDetailedEqual("compact position count", expected,
                compact.SearchDetailed(query, sort, 1, 10, CancellationToken.None));
        }
    }

    private static void VerifyExhaustiveOracleDifferentialAndPagination()
    {
        var when = new DateTimeOffset(2026, 4, 1, 0, 0, 0, TimeSpan.Zero);
        var rng = new Random(46_2026);
        var vocab = new[] { "alpha", "beta", "gamma", "delta", "C#", ".NET", "HTTP/2", "issue-2205", "博客", "搜索", "数据库", "架構", "量子纠缠", "林徽因", "batch-item", "Go", "Golang" };
        var articles = new Article[60];
        for (var i = 0; i < articles.Length; i++)
        {
            var id = i + 1;
            var title = $"{vocab[rng.Next(vocab.Length)]} {vocab[rng.Next(vocab.Length)]}";
            var heading = $"## {vocab[rng.Next(vocab.Length)]} {vocab[rng.Next(vocab.Length)]}";
            var bodyWords = Enumerable.Range(0, 8 + rng.Next(20)).Select(_ => vocab[rng.Next(vocab.Length)]);
            var body = $"{heading}\n\n{string.Join(' ', bodyWords)}\n\n```csharp\n// {vocab[rng.Next(vocab.Length)]}\n```";
            articles[i] = Art(id, title, body, when.AddHours(rng.Next(200)),
                summary: $"{vocab[rng.Next(vocab.Length)]} 摘要",
                category: vocab[rng.Next(vocab.Length)],
                tags: [vocab[rng.Next(vocab.Length)]]);
        }

        var index = ArticleSearchIndex.Build(articles, CancellationToken.None)!;
        var oracle = ExhaustiveSearchOracle.Build(articles, CancellationToken.None);

        var queries = new[]
        {
            "alpha", "alpha beta", "alpha beta gamma", "alpha beta gamma delta 博客",
            "\"alpha beta\"", "C# .NET", "issue-2205", "量子纠缠", "林徽因",
            "數據庫 架構", "数据库 架构", "batch-item", "go", "博客 搜索",
            "alpha alpha", "absentterm", "量子纠缠 absentterm"
        };

        foreach (var sort in new[] { ArticleSearchSort.Relevance, ArticleSearchSort.Latest })
        {
            foreach (var q in queries)
            {
                var fullOracle = oracle.SearchDetailed(q, sort, 1, 200, CancellationToken.None);
                var fullIndex = index.SearchDetailed(q, sort, 1, 200, CancellationToken.None);
                AssertDetailedEqual($"{sort}:{q}", fullOracle, fullIndex);

                // Deterministic pagination across pages without duplicates or omissions
                var collected = new List<int>();
                var pageSize = 3;
                for (var p = 1; p <= (fullIndex.Total + pageSize - 1) / pageSize + 1; p++)
                {
                    var slice = index.SearchDetailed(q, sort, p, pageSize, CancellationToken.None);
                    Require(slice.Total == fullIndex.Total, $"[{q}] page {p} total drift");
                    foreach (var h in slice.Hits) collected.Add(h.Article.Id);
                }
                Require(collected.Count == collected.Distinct().Count(), $"[{q}] duplicate documents across pages");
                Require(collected.SequenceEqual(fullIndex.Hits.Select(static h => h.Article.Id)),
                    $"[{q}] paginated concatenation diverged from full ranking");
            }
        }
    }

    private static void VerifyCompactVsWideDifferential()
    {
        // Build a 40,001-doc corpus (wide) and verify differential parity against ExhaustiveSearchOracle on
        // a targeted subset / representative queries (oracle on small corpus vs compact, plus wide vs oracle on 40,001 would be slow so
        // test exact scoring on an explicit 40,001 corpus for diverse queries!).
        // Better: verify exact match of WideIndex on 40,001 docs with distinct rare/common/CJK/phrase/identifier docs!
        var when = new DateTimeOffset(2026, 5, 1, 0, 0, 0, TimeSpan.Zero);
        const int count = 40_001;
        var articles = new Article[count];
        for (var i = 0; i < count; i++)
        {
            var id = i + 1;
            articles[i] = id switch
            {
                1 => Art(id, "量子纠缠 C# 架构", "# 标题段\n\n详解量子纠缠与 C# issue-4601 架构。", when.AddDays(1), summary: "摘要说明", category: "架构"),
                20_005 => Art(id, "量度与子集", "纠缠与 C# 分散在不同句子，不含完整词。", when.AddDays(2)),
                40_001 => Art(id, "數據庫與架構", "包含 C# 與量子纠缠的尾块文档，以及 issue-4601。", when.AddDays(3), category: "数据库"),
                _ => Art(id, "Quiet Entry", "shared body baseline text", when)
            };
        }
        var wide = ArticleSearchIndex.Build(articles, CancellationToken.None)!;
        Require(wide.UsesWideProfile, "Expected wide profile for 40,001 articles");

        // Unknown CJK sequence + strict identifier across block 0 and block 2
        var q1 = wide.SearchDetailed("量子纠缠 C# issue-4601", ArticleSearchSort.Relevance, 1, 10, CancellationToken.None);
        Require(q1.Hits.Select(static h => h.Article.Id).SequenceEqual([1, 40_001]),
            $"Wide CJK+strict query returned [{string.Join(',', q1.Hits.Select(h => h.Article.Id))}]");

        // Quoted phrase on wide index
        var q2 = wide.SearchDetailed("\"量子纠缠 C#\"", ArticleSearchSort.Relevance, 1, 10, CancellationToken.None);
        Require(q2.Hits.Select(static h => h.Article.Id).SequenceEqual([1]), "Wide quoted phrase mismatch");

        // SC/TC across wide blocks
        var q3 = wide.SearchDetailed("数据库 架构", ArticleSearchSort.Relevance, 1, 10, CancellationToken.None);
        Require(q3.Hits.Select(static h => h.Article.Id).SequenceEqual([40_001]), "Wide SC/TC concept query mismatch");
    }

    private static void AssertDetailedEqual(string label, ArticleSearchDetailedPage expected, ArticleSearchDetailedPage actual)
    {
        CheckSearchTotals(label, expected, actual);
        CheckSearchHits(label, expected.Hits, actual.Hits, 1e-12);
    }

    private static Article Art(int id, string title, string body, DateTimeOffset when,
        string? summary = null, string? category = null, string[]? tags = null) =>
        new(id, 1, id, 1, 1, title, body, when, when, when, summary,
            category is null ? null : new TaxonomyName(100 + id, category),
            tags?.Select((name, idx) => new TaxonomyName(1000 + id * 10 + idx, name)).ToArray());

    private static string KindName(SearchConceptKind kind) => kind switch
    {
        SearchConceptKind.Term => "term",
        SearchConceptKind.CjkSequence => "cjkSequence",
        SearchConceptKind.CompoundHyphen => "compoundHyphen",
        _ => throw new ArgumentOutOfRangeException(nameof(kind))
    };
}
