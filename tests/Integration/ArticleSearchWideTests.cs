namespace FsusBlog.V2.Integration.Tests;

public sealed class ArticleSearchWideTests
{
    private static readonly DateTimeOffset Published = new(2025, 6, 1, 0, 0, 0, TimeSpan.Zero);
    private const string QuietBody = "shared body";
    private const string LongBody = "plain notes from a distance under the open sky beside a river near a stone bridge " +
        "with a closed gate during the present day";

    [Fact]
    public void ExistingCorpusAdmitsExactDocumentCeilingAndEmptySnapshot()
    {
        var limit = checked(WireLimits.SearchCorpusMaxPages * WireLimits.SearchIndexPageSize);
        var articles = Enumerable.Range(1, limit + 1).Select(id => Row(id, "Quiet", QuietBody, Published)).ToArray();
        Assert.Single(Assert.IsAssignableFrom<IReadOnlyList<byte[]>>(LocalSearchCorpus.Build([])));
        var atLimit = Assert.IsAssignableFrom<IReadOnlyList<byte[]>>(LocalSearchCorpus.Build(articles[..limit]));
        Assert.Equal(WireLimits.SearchCorpusMaxPages, atLimit.Count);
        Assert.Null(LocalSearchCorpus.Build(articles));
    }

    [Fact]
    public void WideProjectionRejectsTermBudgetFailureAfterAnAdmissiblePrefix()
    {
        const int count = 40_001;
        const string symbols = "abcdefghijklmn";
        var articles = new Article[count];
        for (var i = 0; i < count; i++)
        {
            var id = i + 1;
            var title = i < 20_000 ? "Reusable prefix" : string.Join(" ", symbols.Select(symbol => $"{symbol}{id:x}"));
            articles[i] = Row(id, title, QuietBody, Published);
        }
        var prefix = Assert.IsType<ArticleSearchIndex>(ArticleSearchIndex.Build(articles[..20_000], CancellationToken.None));
        Assert.Equal(200, prefix.Search("reusable", CancellationToken.None).Length);
        Assert.Null(ArticleSearchIndex.Build(articles, CancellationToken.None));
    }

    [Fact]
    public void WideSearchRanksAllBlocksUsingOneDocumentFrequencyAndLengthModel()
    {
        const int count = 85_240;
        const int both = count - 1;
        const int middleCobalt = 20_001;
        const int tailCobalt = 40_001;
        const int newestTie = 10_045;
        const int nextTie = 30_045;
        const int firstLength = 12_000;
        const int middleLength = 32_000;
        const int tailLength = 40_200;
        const int largerWeight = 8_500;
        const int smallerWeight = 84_500;
        var heavy = string.Join(" ", Enumerable.Repeat("Weightprobe", 16));
        var light = string.Join(" ", Enumerable.Repeat("Weightprobe", 6));
        var tied = Enumerable.Range(10_001, 45).Concat(Enumerable.Range(30_001, 45))
            .Concat(Enumerable.Range(40_051, 45)).Concat(Enumerable.Range(60_051, 45))
            .Concat(Enumerable.Range(80_051, 45)).ToHashSet();
        var articles = new Article[count];
        for (var ordinal = 0; ordinal < articles.Length; ordinal++)
        {
            var id = ordinal + 1;
            var title = id switch
            {
                <= 300 => "Amber",
                <= 1_800 or middleCobalt or tailCobalt => "Cobalt",
                both => "Amber Cobalt",
                count => "Queue_JOB-23",
                firstLength or middleLength or tailLength => "Lengthmarker",
                largerWeight => heavy,
                smallerWeight => light,
                _ when tied.Contains(id) => "Roundtable",
                _ => "Quiet"
            };
            var body = id switch
            {
                firstLength => "three plain words",
                middleLength => "six plain words in one place",
                tailLength => LongBody,
                9_000 => "shared frontonly",
                29_000 => "shared middleonly",
                29_001 => "shared `queue_job-23`",
                45_001 => "shared queue job 23 queue_job-23x",
                45_000 => "shared thirdonly",
                64_000 => "shared fourthonly",
                count => "shared finalonly",
                > 20_000 and <= 40_000 when title == "Quiet" => LongBody,
                _ => QuietBody
            };
            var created = id == newestTie ? Published.AddDays(2) : id == nextTie ? Published.AddDays(1) : Published;
            articles[ordinal] = Row(id, title, body, created);
        }

        var index = Assert.IsType<ArticleSearchIndex>(ArticleSearchIndex.Build(articles, CancellationToken.None));
        Assert.True(index.UsesWideProfile);

        // Profile v3 (#46): 2-concept queries require full concept coverage (only `both` covers amber + cobalt),
        // while single-concept and global-IDF ranking remain corpus-wide across all 5 wide blocks.
        Assert.True(Idf(count, 301) > Idf(count, 1_503));
        Assert.True(Idf(20_000, 300) < Idf(20_000, 1));
        Assert.Equal([both], Ids("amber cobalt"));
        Assert.Equal([both], Ids("ＡＭＢＥＲ cobalt amber"));
        // Single-concept "amber" ranks 1-word title "Amber" (1..300) above 2-word title "Amber Cobalt" (85239) via BM25F title-length normalization.
        var expectedAmber = Enumerable.Range(101, 200).Reverse();
        Assert.Equal(expectedAmber, Ids("amber"));

        // The medium article is shorter than most of its block, while the shortest is longer than most of its block.
        // Title-only "lengthmarker" ties on Title length (1) under BM25F; verify visible Body length normalization on "shared".
        Assert.Equal([tailLength, middleLength, firstLength], Ids("lengthmarker"));
        // 5 completely disjoint concepts across 5 different articles (1/5 match each < minRelaxed=3): returns empty cleanly.
        Assert.Empty(Ids("frontonly middleonly thirdonly fourthonly finalonly"));
        Assert.Equal([count], Ids("finalonly"));
        Assert.Equal([largerWeight, smallerWeight], Ids("weightprobe"));
        Assert.Equal([count, 29_001], Ids("queue_job-23"));
        Assert.Empty(Ids("queue_job-24"));

        var expectedTies = new[] { newestTie, nextTie }.Concat(tied.Where(id => id != newestTie && id != nextTie)
            .OrderDescending().Take(198));
        Assert.Equal(expectedTies, Ids("roundtable"));
        Assert.Empty(Ids("neverpublishedtoken"));
        Assert.Equal(expectedAmber, Ids("am"));
        Assert.Empty(Ids("fr"));

        var compact = Assert.IsType<ArticleSearchIndex>(ArticleSearchIndex.Build(articles[..40_000], CancellationToken.None));
        Assert.False(compact.UsesWideProfile);
        Assert.Equal(29_000, Assert.Single(compact.Search("middleonly", CancellationToken.None)).Id);
        Assert.Equal(29_001, Assert.Single(compact.Search("queue_job-23", CancellationToken.None)).Id);
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        Assert.Throws<OperationCanceledException>(() => index.Search("roundtable", cancelled.Token));

        int[] Ids(string query) => index.Search(query, CancellationToken.None).Select(article => article.Id).ToArray();
    }

    [Fact]
    public void WideSearchSharesSourcePostingsWithoutLosingAliasesOrFieldWeights()
    {
        const int count = 40_001;
        const string expanded = "abcdefghijklmnop bcdefghijklmnopq cdefghijklmnopqr defghijklmnopqrs " +
            "efghijklmnopqrst fghijklmnopqrstu ghijklmnopqrstuv hijklmnopqrstuvw ijklmnopqrstuvwx " +
            "jklmnopqrstuvwxy klmnopqrstuvwxyz lmnopqrstuvwxyzab";
        var articles = Enumerable.Range(1, count).Select(id =>
            Row(id, id <= 20_000 ? expanded : "Quiet", QuietBody, Published)).ToArray();

        // Expanding the aliases would produce over two million postings in the first block alone.
        articles[0] = articles[0] with
        {
            Category = new TaxonomyName(1, "ProjectBridge"),
            Tags = [new TaxonomyName(2, "ProjectBridge")]
        };
        articles[20_000] = articles[20_000] with
        {
            Body = "quiet pro",
            Category = new TaxonomyName(3, "ProjectBrace"),
            Title = "frontdesk"
        };
        articles[^1] = articles[^1] with { Title = "pro ProjectBridge frontDesk" };

        var index = Assert.IsType<ArticleSearchIndex>(ArticleSearchIndex.Build(articles, CancellationToken.None));
        Assert.True(index.UsesWideProfile);

        // Profile v3 (#46): 3-concept query admits Primary full-coverage hit (40001) and Relaxed 2/3 hit (1: pro+projectbridge),
        // while rejecting 1/3 single-concept hit (20001) under bounded relaxation.
        Assert.Equal([count, 20_001, 1], Ids("pro"));
        Assert.Equal([count, 1], Ids("projectbridge"));
        Assert.Equal([count], Ids("desk"));
        Assert.Equal([count, 1], Ids("pro projectbridge desk"));
        var frequent = index.SearchPage("abcdef", ArticleSearchSort.Relevance, 1, 100, CancellationToken.None);
        Assert.Equal(20_000, frequent.Total);
        Assert.Equal(20_000, frequent.Articles[0].Id);

        int[] Ids(string query) => index.Search(query, CancellationToken.None).Select(article => article.Id).ToArray();
    }

    [Fact]
    public void WideSnapshotServesExactFas4CoordinatesAndDiscardsWithdrawnTail()
    {
        const int last = 40_001;
        const long publication = 9_007_199_254_740_993L;
        var articles = Enumerable.Range(1, last).Select(id => Row(id, "Quiet", QuietBody, Published)).ToArray();
        articles[^1] = articles[^1] with
        {
            Body = "shared withdrawalneedle",
            Revision = 9,
            RevisionNo = 9,
            Publication = publication,
            PublicationNo = 3
        };
        var pages = new WebPages("<html><body><!--fsus-public-content--></body></html>");
        var cursor = new PublicListCursor(TimeProvider.System);
        var current = Snapshot(7, articles);
        Assert.Equal(ExpectedGeneration(current, articles, wide: true), current.Generation);
        Assert.NotEqual(ExpectedGeneration(current, articles, wide: false), current.Generation);
        var unchanged = Snapshot(8, articles, current);
        Assert.Equal(current.GenerationHeader, unchanged.GenerationHeader);

        var hit = Aeds.Decode(current.Search("withdrawalneedle", CancellationToken.None)!, FrameType.ArticleSearch);
        Assert.True(hit[..4].SequenceEqual("FAS4"u8));
        Assert.Equal((4, 1, last), (BinaryPrimitives.ReadInt32LittleEndian(hit[4..]),
            BinaryPrimitives.ReadInt32LittleEndian(hit[8..]), BinaryPrimitives.ReadInt32LittleEndian(hit[12..])));
        Assert.Equal(12 + WireLayouts.ArticleSearchItemPodSize + 8 + WireLayouts.ArticlePublicationCoordinateBytes, hit.Length);
        var coordinate = hit[^WireLayouts.ArticlePublicationCoordinateBytes..];
        Assert.Equal((9L, 9, publication, 3), (BinaryPrimitives.ReadInt64LittleEndian(coordinate),
            BinaryPrimitives.ReadInt32LittleEndian(coordinate[8..]), BinaryPrimitives.ReadInt64LittleEndian(coordinate[12..]),
            BinaryPrimitives.ReadInt32LittleEndian(coordinate[20..])));

        var survivors = articles[..^1];
        var withdrawn = Snapshot(9, survivors, unchanged);
        Assert.True(current.HasArticle(last));
        Assert.False(withdrawn.HasArticle(last));
        Assert.NotEqual(current.GenerationHeader, withdrawn.GenerationHeader);
        Assert.Equal(ExpectedGeneration(withdrawn, survivors, wide: false), withdrawn.Generation);
        var empty = Aeds.Decode(withdrawn.Search("withdrawalneedle", CancellationToken.None)!, FrameType.ArticleSearch);
        Assert.Equal(12, empty.Length);
        Assert.Equal(0, BinaryPrimitives.ReadInt32LittleEndian(empty[8..]));

        PublicSnapshot Snapshot(long watermark, Article[] list, PublicSnapshot? previous = null) =>
            new(watermark, list, new([], [], []), pages, cursor, previous, NullLogger.Instance, null, null, CancellationToken.None);
    }

    [Fact]
    public void SearchPageSupportsLatestSortAndBoundedPaginationAcrossCompactAndWideProfiles()
    {
        const int count = 41_050;
        var articles = new Article[count];
        for (var i = 0; i < count; i++)
        {
            var id = i + 1;
            var title = id switch
            {
                1 => "Sortprobe Sortprobe Sortprobe",
                2 => "Quiet",
                40_500 => "Quiet",
                40_900 => "Job_ITEM-9",
                <= 1_200 => "Pageprobe",
                _ => "Quiet"
            };
            var body = id switch
            {
                2 => "sortprobe",
                40_500 => "sortprobe",
                40_800 => "shared `job_item-9`",
                _ => QuietBody
            };
            var published = id switch
            {
                1 => Published,
                2 => Published.AddDays(5),
                40_500 => Published.AddDays(10),
                40_800 => Published.AddDays(8),
                40_900 => Published.AddDays(2),
                _ => Published.AddMinutes(id)
            };
            articles[i] = Row(id, title, body, published);
        }

        var wide = Assert.IsType<ArticleSearchIndex>(ArticleSearchIndex.Build(articles, CancellationToken.None));
        Assert.True(wide.UsesWideProfile);

        ExpectPage(wide, "sortprobe", ArticleSearchSort.Relevance, 1, 10, 3, [1, 40_500, 2]);
        ExpectPage(wide, "sortprobe", ArticleSearchSort.Latest, 1, 2, 3, [40_500, 2]);
        ExpectPage(wide, "sortprobe", ArticleSearchSort.Latest, 2, 2, 3, [1]);
        ExpectPage(wide, "sortprobe", ArticleSearchSort.Latest, 3, 2, 3, []);

        // Compound identifier honors Latest sort and pagination.
        ExpectPage(wide, "job_item-9", ArticleSearchSort.Relevance, 1, 10, 2, [40_900, 40_800]);
        ExpectPage(wide, "job_item-9", ArticleSearchSort.Latest, 1, 10, 2, [40_800, 40_900]);

        // Pagination caps at MaxPaginatedResults (1,000) while reporting exact total (1,198 Pageprobe articles).
        var page100 = wide.SearchPage("pageprobe", ArticleSearchSort.Latest, 100, 10, CancellationToken.None);
        Assert.Equal((1_198, 10), (page100.Total, page100.Articles.Length));
        ExpectPage(wide, "pageprobe", ArticleSearchSort.Latest, 101, 10, 1_198, []);

        // Compact profile matches the same latest-sort contract.
        var compact = Assert.IsType<ArticleSearchIndex>(ArticleSearchIndex.Build(articles[..1_200], CancellationToken.None));
        Assert.False(compact.UsesWideProfile);
        ExpectPage(compact, "sortprobe", ArticleSearchSort.Latest, 1, 10, 2, [2, 1]);

        static void ExpectPage(ArticleSearchIndex index, string query, ArticleSearchSort sort, int page, int size, int total, int[] ids)
        {
            var result = index.SearchPage(query, sort, page, size, CancellationToken.None);
            Assert.Equal(total, result.Total);
            Assert.Equal(ids, result.Articles.Select(article => article.Id));
        }
    }

    private static Article Row(int id, string title, string body, DateTimeOffset created) =>
        new(id, 1, id, 1, 1, title, body, created, created, created);

    private static double Idf(int count, int occurrences) =>
        Math.Log(1 + (count - occurrences + 0.5) / (occurrences + 0.5));

    private static long ExpectedGeneration(PublicSnapshot snapshot, Article[] articles, bool wide)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        hash.AppendData("public-generation-corpus-v1\0"u8);
        hash.AppendData(Encoding.ASCII.GetBytes($"public-search-bm25-v{WireLimits.SearchFas4Profile}\0"));
        hash.AppendData(Encoding.ASCII.GetBytes($"public-search-analyzer-v{WireLimits.SearchAnalyzerVersion}\0"));
        if (wide) hash.AppendData("public-search-bm25-wide-v1\0"u8);
        Span<byte> coordinate = stackalloc byte[sizeof(int) + 2 * sizeof(long)];
        BinaryPrimitives.WriteInt32LittleEndian(coordinate, snapshot.CorpusPageCount == 0 ? -1 : snapshot.CorpusPageCount);
        hash.AppendData(coordinate[..sizeof(int)]);
        for (var number = 1; number <= snapshot.CorpusPageCount; number++)
        {
            var bytes = snapshot.Corpus(number)!;
            BinaryPrimitives.WriteInt32LittleEndian(coordinate, bytes.Length);
            hash.AppendData(coordinate[..sizeof(int)]);
            hash.AppendData(bytes);
        }
        BinaryPrimitives.WriteInt32LittleEndian(coordinate, articles.Length);
        hash.AppendData(coordinate[..sizeof(int)]);
        foreach (var article in articles)
        {
            BinaryPrimitives.WriteInt32LittleEndian(coordinate, article.Id);
            BinaryPrimitives.WriteInt64LittleEndian(coordinate[4..], article.Revision);
            BinaryPrimitives.WriteInt64LittleEndian(coordinate[12..], article.Publication);
            hash.AppendData(coordinate);
        }
        return BinaryPrimitives.ReadInt64LittleEndian(hash.GetHashAndReset()) & long.MaxValue;
    }
}
