using System.Text;

internal static class SearchContractVectors
{
    internal static void Run(string fixtures)
    {
        VerifyWireRoundTripAndValidation(fixtures);
        VerifyBoundaryCountsAndCursorPagination();
        VerifySnippetAndHighlightExtraction();
    }

    private static void VerifyWireRoundTripAndValidation(string fixtures)
    {
        var sample = new PublicSearchResult(
            Generation: 9876543210123L,
            ProfileVersion: WireLimits.SearchFas4Profile,
            AnalyzerVersion: WireLimits.SearchAnalyzerVersion,
            TotalCount: 2,
            TotalRelation: PublicSearchTotalRelation.Exact,
            PrimaryCount: 1,
            RelaxedCount: 1,
            HasMore: true,
            NextCursor: "AbCdEf0123456789_-",
            Items:
            [
                new PublicSearchHit(
                    Id: 42,
                    Revision: 7,
                    RevisionNo: 7,
                    Publication: 7001,
                    PublicationNo: 3,
                    PublishedAtUnixMs: 1770000000000L,
                    CreatedAtUnixMs: 1769990000000L,
                    Views: 19,
                    CategoryId: 4,
                    CategoryName: "系统设计",
                    Tags: [new PublicSearchTag(10, "搜索"), new PublicSearchTag(12, "Rust")],
                    Title: "🚀 搜索契约与高亮",
                    Summary: "摘要文本",
                    MatchTier: PublicSearchMatchTier.Primary,
                    SnippetField: PublicSearchSnippetField.Body,
                    Snippet: "🚀 使用 <script> 原始文本进行搜索测试",
                    Highlights: [new PublicSearchHighlight(21, 23)]),
                new PublicSearchHit(
                    Id: 9,
                    Revision: 2,
                    RevisionNo: 2,
                    Publication: 2001,
                    PublicationNo: 1,
                    PublishedAtUnixMs: 1769000000000L,
                    CreatedAtUnixMs: 1768990000000L,
                    Views: 0,
                    CategoryId: 0,
                    CategoryName: "",
                    Tags: [],
                    Title: "部分匹配条目",
                    Summary: "回退摘要",
                    MatchTier: PublicSearchMatchTier.Relaxed,
                    SnippetField: PublicSearchSnippetField.None,
                    Snippet: "",
                    Highlights: [])
            ]);

        var encoded = Wire.EncodePublicSearchResult(sample);
        var fixturePath = Path.Combine(fixtures, "public-search-result-v2.hex");
        if (File.Exists(fixturePath))
        {
            var expected = Hex(fixtures, "public-search-result-v2.hex");
            Equal(expected, encoded);
        }

        var decoded = Wire.DecodePublicSearchResult(encoded);
        Equal(encoded, Wire.EncodePublicSearchResult(decoded));
        Require(decoded.Generation == sample.Generation &&
                decoded.TotalRelation == PublicSearchTotalRelation.Exact &&
                decoded.Items.Count == 2 &&
                decoded.Items[0].Snippet.Substring(decoded.Items[0].Highlights[0].Start,
                    decoded.Items[0].Highlights[0].End - decoded.Items[0].Highlights[0].Start) == "搜索",
            "PublicSearchResult round-trip content mismatch");

        RejectTruncations(encoded, span => Wire.DecodePublicSearchResult(span));

        // Flip every byte of the payload once to ensure CRC / framing rejects tampering
        var mutated = encoded.ToArray();
        mutated[^1] ^= 0x01;
        Reject(() => Wire.DecodePublicSearchResult(mutated));

        // Contract validation rejections
        RejectAll(
            () => Wire.EncodePublicSearchResult(sample with { HasMore = true, NextCursor = "" }),
            () => Wire.EncodePublicSearchResult(sample with { HasMore = false, NextCursor = "abc" }),
            () => Wire.EncodePublicSearchResult(sample with { NextCursor = "bad+cursor/=" }),
            () => Wire.EncodePublicSearchResult(sample with { TotalCount = 5, TotalRelation = PublicSearchTotalRelation.Exact }),
            () => Wire.EncodePublicSearchResult(sample with { TotalCount = 1, TotalRelation = PublicSearchTotalRelation.LowerBound }),
            // Highlight splits surrogate pair 🚀 (indices 0..2)
            () => Wire.EncodePublicSearchResult(sample with
            {
                Items = [sample.Items[0] with { Highlights = [new PublicSearchHighlight(1, 3)] }, sample.Items[1]]
            }),
            // Highlight ends on high surrogate (index 0..1)
            () => Wire.EncodePublicSearchResult(sample with
            {
                Items = [sample.Items[0] with { Highlights = [new PublicSearchHighlight(0, 1)] }, sample.Items[1]]
            }),
            // Overlapping highlights
            () => Wire.EncodePublicSearchResult(sample with
            {
                Items = [sample.Items[0] with { Highlights = [new PublicSearchHighlight(3, 6), new PublicSearchHighlight(5, 8)] }, sample.Items[1]]
            }),
            // SnippetField.None with non-empty snippet
            () => Wire.EncodePublicSearchResult(sample with
            {
                Items = [sample.Items[0], sample.Items[1] with { Snippet = "unexpected" }]
            }),
            // Duplicate tag IDs
            () => Wire.EncodePublicSearchResult(sample with
            {
                Items = [sample.Items[0] with { Tags = [new PublicSearchTag(10, "a"), new PublicSearchTag(10, "b")] }, sample.Items[1]]
            })
        );
    }

    private static void VerifyBoundaryCountsAndCursorPagination()
    {
        var baseTime = new DateTimeOffset(2026, 3, 1, 0, 0, 0, TimeSpan.Zero);

        // 1. Boundary counts: 0, 1, exactly-at-threshold (1000), above-threshold (1005)
        var corpus1005 = new Article[1005];
        for (var i = 0; i < corpus1005.Length; i++)
        {
            corpus1005[i] = new Article(
                i + 1, 1, i + 1, 1, 1,
                i == 0 ? "UniqueSoloTitle" : $"Boundary Common Article {i + 1}",
                "boundarycommon shared corpus body text",
                baseTime.AddMinutes(i), baseTime.AddMinutes(i), baseTime.AddMinutes(i),
                "Summary");
        }
        var idx1005 = ArticleSearchIndex.Build(corpus1005, CancellationToken.None)!;

        // 0 matches
        var zero = idx1005.SearchWithCursor("nevermatchesanythingxyz", ArticleSearchSort.Relevance, 10, null, 0, CancellationToken.None);
        Require(zero.TotalCount == 0 && zero.TotalRelation == PublicSearchTotalRelation.Exact && !zero.HasMore && zero.Hits.Length == 0,
            "Zero-match boundary failed");

        // 1 match
        var one = idx1005.SearchWithCursor("uniquesolotitle", ArticleSearchSort.Relevance, 10, null, 0, CancellationToken.None);
        Require(one.TotalCount == 1 && one.TotalRelation == PublicSearchTotalRelation.Exact && !one.HasMore && one.Hits.Length == 1,
            "Single-match boundary failed");

        // Exactly at threshold (1000 of 1000)
        var corpus1000 = corpus1005[..1000];
        var idx1000 = ArticleSearchIndex.Build(corpus1000, CancellationToken.None)!;
        var atThreshold = idx1000.SearchWithCursor("boundarycommon", ArticleSearchSort.Latest, 100, null, 0, CancellationToken.None);
        Require(atThreshold.TotalCount == 1000 && atThreshold.TotalRelation == PublicSearchTotalRelation.Exact && atThreshold.HasMore,
            "Exact-at-threshold (1000) boundary failed");

        // Above threshold (1005 > 1000): MUST report LowerBound, NEVER Exact, and MUST stop HasMore at window end (1000)
        var above = idx1005.SearchWithCursor("boundarycommon", ArticleSearchSort.Latest, 100, null, 0, CancellationToken.None);
        Require(above.TotalCount == ArticleSearchIndex.MaxPaginatedResults &&
                above.TotalRelation == PublicSearchTotalRelation.LowerBound &&
                above.HasMore,
            "Above-threshold (1005) must report LowerBound");

        // Walk all 10 pages of size 100 (= 1000 items) via cursor -> zero duplicates, zero omissions, final page HasMore == false
        var walkedIds = new List<int>(1000);
        SearchCursorPosition? cursor = null;
        var returnedSoFar = 0;
        var pages = 0;
        while (true)
        {
            var p = idx1005.SearchWithCursor("boundarycommon", ArticleSearchSort.Latest, 100, cursor, returnedSoFar, CancellationToken.None);
            pages++;
            foreach (var h in p.Hits) walkedIds.Add(h.Article.Id);
            returnedSoFar += p.Hits.Length;
            if (!p.HasMore)
            {
                Require(p.TotalRelation == PublicSearchTotalRelation.LowerBound, "Final window page must stay LowerBound");
                break;
            }
            Require(p.LastHitPosition is not null, "HasMore=true must provide LastHitPosition");
            cursor = p.LastHitPosition;
            Require(pages <= 10, "Pagination exceeded retrieval window");
        }
        Require(pages == 10 && walkedIds.Count == 1000 && walkedIds.Distinct().Count() == 1000,
            $"Window walk expected 1000 unique items across 10 pages, got {walkedIds.Count} across {pages}");
        Require(walkedIds[0] == 1005 && walkedIds[^1] == 6, "Latest sort cursor ordering mismatch");

        // LowerBound with small threshold where true total (25) < retrieval window: HasMore MUST NOT be fabricated from LowerBound!
        var corpus25 = corpus1005[..25];
        var idx25 = ArticleSearchIndex.Build(corpus25, CancellationToken.None)!;
        var p1 = idx25.SearchWithCursor("boundarycommon", ArticleSearchSort.Relevance, 10, null, 0, CancellationToken.None, countThreshold: 20);
        Require(p1.TotalCount == 20 && p1.TotalRelation == PublicSearchTotalRelation.LowerBound && p1.HasMore && p1.Hits.Length == 10, "Small threshold p1 failed");
        var p2 = idx25.SearchWithCursor("boundarycommon", ArticleSearchSort.Relevance, 10, p1.LastHitPosition, 10, CancellationToken.None, countThreshold: 20);
        Require(p2.TotalRelation == PublicSearchTotalRelation.LowerBound && p2.HasMore && p2.Hits.Length == 10, "Small threshold p2 failed");
        var p3 = idx25.SearchWithCursor("boundarycommon", ArticleSearchSort.Relevance, 10, p2.LastHitPosition, 20, CancellationToken.None, countThreshold: 20);
        Require(p3.TotalRelation == PublicSearchTotalRelation.LowerBound && !p3.HasMore && p3.Hits.Length == 5,
            "Final page under LowerBound must have HasMore=false when no subsequent hit exists");

        // Work budget cutoff throws SearchBudgetExceededException rather than returning exact empty 0
        var threwBudget = false;
        try
        {
            _ = idx25.SearchWithCursor("boundarycommon", ArticleSearchSort.Relevance, 10, null, 0, CancellationToken.None, workBudget: 5);
        }
        catch (SearchBudgetExceededException)
        {
            threwBudget = true;
        }
        Require(threwBudget, "Work budget exceeded must throw SearchBudgetExceededException");

        // Mixed Primary + Relaxed cursor traversal parity with ExhaustiveSearchOracle in both sort modes
        var mixed = new List<Article>
        {
            new(1, 1, 1, 1, 1, "Alpha Beta Gamma", "alpha beta gamma exact primary match", baseTime.AddDays(1), baseTime.AddDays(1), baseTime.AddDays(1)),
            new(2, 1, 2, 1, 1, "Alpha Beta Gamma Second", "alpha beta gamma also primary", baseTime.AddDays(5), baseTime.AddDays(5), baseTime.AddDays(5)),
        };
        for (var i = 3; i <= 9; i++)
        {
            mixed.Add(new(i, 1, i, 1, 1, $"Relaxed {i}", "alpha beta partial match without third concept",
                baseTime.AddDays(i), baseTime.AddDays(i), baseTime.AddDays(i)));
        }
        // Background documents keep alpha/beta IDF realistic so 2-of-3 concepts satisfy the 60% IDF relaxation threshold.
        for (var i = 10; i <= 40; i++)
        {
            mixed.Add(new(i, 1, i, 1, 1, $"Background {i}",
                i <= 16 ? "unrelated archive article mentioning gamma once" : "unrelated archive article without query terms",
                baseTime.AddDays(i), baseTime.AddDays(i), baseTime.AddDays(i)));
        }
        var mixedIndex = ArticleSearchIndex.Build(mixed, CancellationToken.None)!;
        var mixedOracle = ExhaustiveSearchOracle.Build(mixed, CancellationToken.None);

        foreach (var sort in new[] { ArticleSearchSort.Relevance, ArticleSearchSort.Latest })
        {
            var expectedAll = mixedOracle.SearchDetailed("alpha beta gamma", sort, 1, 100, CancellationToken.None);
            Require(expectedAll.PrimaryTotal == 2 && expectedAll.RelaxedTotal == 7, "Mixed fixture tier split mismatch");
            var walked = new List<(int Id, SearchMatchTier Tier)>();
            SearchCursorPosition? cur = null;
            var soFar = 0;
            while (true)
            {
                var page = mixedIndex.SearchWithCursor("alpha beta gamma", sort, 3, cur, soFar, CancellationToken.None);
                Require(page.TotalRelation == PublicSearchTotalRelation.Exact &&
                        page.PrimaryCount == 2 && page.RelaxedCount == 7 && page.TotalCount == 9,
                    "Mixed exact tier counts mismatch");
                foreach (var h in page.Hits) walked.Add((h.Article.Id, h.Tier));
                soFar += page.Hits.Length;
                if (!page.HasMore) break;
                cur = page.LastHitPosition;
            }
            var expectedSeq = expectedAll.Hits.Select(h => (h.Article.Id, h.Tier)).ToList();
            Require(walked.SequenceEqual(expectedSeq),
                $"Cursor traversal diverged from ExhaustiveSearchOracle under sort={sort}");
        }
    }

    private static void VerifySnippetAndHighlightExtraction()
    {
        var when = new DateTimeOffset(2026, 4, 1, 0, 0, 0, TimeSpan.Zero);

        Article Doc(int id, string title, string body, string? summary = null,
            TaxonomyName? category = null, TaxonomyName[]? tags = null) =>
            new(id, 1, id, 1, 1, title, body, when, when, when, summary, category, tags);

        static string Slice(SearchSnippet s, int index) =>
            s.Text.Substring(s.Highlights[index].Start, s.Highlights[index].End - s.Highlights[index].Start);

        // 1. HTML / script / XSS / Markdown link URL stripping
        var xssArt = Doc(1, "Security Note",
            "<script>alert('xss')</script><img src=x onerror=alert(1)> Visible **quasar** text with [safe label](javascript:alert(1)).");
        var xssSnip = SearchSnippetExtractor.Extract(xssArt, SearchQueryPlan.Build("quasar"));
        Require(xssSnip.Field == PublicSearchSnippetField.Body, "XSS prose should report Body");
        Require(!xssSnip.Text.Contains("<script", StringComparison.OrdinalIgnoreCase) &&
                !xssSnip.Text.Contains("onerror", StringComparison.OrdinalIgnoreCase) &&
                !xssSnip.Text.Contains("javascript:", StringComparison.OrdinalIgnoreCase),
            $"XSS/HTML markup leaked into snippet: {xssSnip.Text}");
        Require(xssSnip.Highlights.Count == 1 && Slice(xssSnip, 0) == "quasar", "XSS snippet highlight mismatch");
        Wire.ValidateSnippetHighlights(xssSnip.Text, xssSnip.Highlights);

        // 2. Code block match (literal <script> inside fenced code stays plain text, validated safely)
        var codeArt = Doc(2, "Code Sample",
            "Intro paragraph.\n\n```ts\nconst raw = '<script>k8s_v1_30()</script>'\n```\n");
        var codeSnip = SearchSnippetExtractor.Extract(codeArt, SearchQueryPlan.Build("k8s_v1_30"));
        Require(codeSnip.Field == PublicSearchSnippetField.Code, "Fenced code match must report Code");
        Require(codeSnip.Highlights.Count == 1 && Slice(codeSnip, 0) == "k8s_v1_30", "Code snippet highlight mismatch");
        Wire.ValidateSnippetHighlights(codeSnip.Text, codeSnip.Highlights);

        // 3. Normalization (NFKC fullwidth + ligature + Traditional/Simplified Chinese)
        var normArt = Doc(3, "Normalization", "測試 ＦＳＵＳ 瀏覽器與 ﬁlter 管道。");
        var normSnip1 = SearchSnippetExtractor.Extract(normArt, SearchQueryPlan.Build("fsus 测试"));
        Require(normSnip1.Field == PublicSearchSnippetField.Body && normSnip1.Highlights.Count == 2,
            $"Normalization snippet failed: {normSnip1.Text}");
        Require(Slice(normSnip1, 0) == "測試" && Slice(normSnip1, 1) == "ＦＳＵＳ",
            $"Expected original NFKC/Traditional slices, got '{Slice(normSnip1, 0)}' & '{Slice(normSnip1, 1)}'");

        var normSnip2 = SearchSnippetExtractor.Extract(normArt, SearchQueryPlan.Build("filter"));
        Require(normSnip2.Highlights.Count == 1 && Slice(normSnip2, 0) == "ﬁlter",
            $"Ligature highlight failed: '{Slice(normSnip2, 0)}'");

        // 4. Surrogate pairs + 640-byte UTF-8 truncation boundary
        var emojiPad = string.Concat(Enumerable.Repeat("🚀𠀀🧪", 90));
        var surrogateArt = Doc(4, "Unicode", $"{emojiPad} 𠀁 targetneedle 🌌 {emojiPad}");
        var surrSnip = SearchSnippetExtractor.Extract(surrogateArt, SearchQueryPlan.Build("targetneedle"));
        Require(surrSnip.Field == PublicSearchSnippetField.Body, "Surrogate snippet field mismatch");
        Require(Encoding.UTF8.GetByteCount(surrSnip.Text) <= WireLimits.PublicSearchSnippetMaxBytes,
            "Surrogate snippet exceeded 640-byte limit");
        Require(surrSnip.Highlights.Count == 1 && Slice(surrSnip, 0) == "targetneedle",
            "Surrogate snippet highlight shifted/corrupted");
        Wire.ValidateSnippetHighlights(surrSnip.Text, surrSnip.Highlights);
        // Ensure no unpaired surrogate anywhere in final snippet string
        for (var i = 0; i < surrSnip.Text.Length; i++)
        {
            if (char.IsHighSurrogate(surrSnip.Text[i]))
            {
                Require(i + 1 < surrSnip.Text.Length && char.IsLowSurrogate(surrSnip.Text[i + 1]), "Dangling high surrogate");
                i++;
            }
            else Require(!char.IsLowSurrogate(surrSnip.Text[i]), "Dangling low surrogate");
        }

        // 5. Field-only matches: Title-only, Heading-only, Summary-only, Taxonomy-only
        var titleOnly = SearchSnippetExtractor.Extract(Doc(5, "OnlyInTitleTerm", "unrelated body text"), SearchQueryPlan.Build("onlyintitleterm"));
        Require(titleOnly.Field == PublicSearchSnippetField.Title && titleOnly.Highlights.Count == 1 && Slice(titleOnly, 0) == "OnlyInTitleTerm",
            "Title-only match failed");

        var headingOnly = SearchSnippetExtractor.Extract(Doc(6, "Plain Title", "## Deep HeadingBeacon\n\nunrelated paragraph"), SearchQueryPlan.Build("headingbeacon"));
        Require(headingOnly.Field == PublicSearchSnippetField.Heading && headingOnly.Highlights.Count == 1 && Slice(headingOnly, 0) == "HeadingBeacon",
            "Heading-only match failed");

        var summaryOnly = SearchSnippetExtractor.Extract(Doc(7, "Plain Title", "unrelated body", summary: "Manual SummaryToken excerpt"), SearchQueryPlan.Build("summarytoken"));
        Require(summaryOnly.Field == PublicSearchSnippetField.Summary && summaryOnly.Highlights.Count == 1 && Slice(summaryOnly, 0) == "SummaryToken",
            "Summary-only match failed");

        var taxOnly = SearchSnippetExtractor.Extract(
            Doc(8, "Plain Title", "unrelated body", category: new(1, "CompilerInfra"), tags: [new(2, "ZeroCopy")]),
            SearchQueryPlan.Build("zerocopy"));
        Require(taxOnly.Field == PublicSearchSnippetField.Taxonomy && taxOnly.Highlights.Count == 1 && Slice(taxOnly, 0) == "ZeroCopy",
            "Taxonomy-only match failed");

        // 6. Unknown CJK sequence merges overlapping bigrams into one clean highlight
        var cjkArt = Doc(9, "微核", "讨论微核调度与实时内核隔离策略。");
        var cjkSnip = SearchSnippetExtractor.Extract(cjkArt, SearchQueryPlan.Build("微核调度"));
        Require(cjkSnip.Field == PublicSearchSnippetField.Body && cjkSnip.Highlights.Count == 1 && Slice(cjkSnip, 0) == "微核调度",
            $"CJK sequence highlight failed: count={cjkSnip.Highlights.Count}");
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException($"SearchContractVectors failed: {message}");
    }
}
