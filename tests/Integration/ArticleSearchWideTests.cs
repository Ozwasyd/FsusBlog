using System.Buffers.Binary;
using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server;
using Microsoft.Extensions.Logging.Abstractions;

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

        // Equal field weights put the rarer term first. Block-local IDF would put middleCobalt above Amber.
        Assert.True(Idf(count, 301) > Idf(count, 1_503));
        Assert.True(Idf(20_000, 300) < Idf(20_000, 1));
        var expected = new[] { both }.Concat(Enumerable.Range(102, 199).Reverse());
        Assert.Equal(expected, Ids("amber cobalt"));
        Assert.Equal(expected, Ids("ＡＭＢＥＲ cobalt amber"));

        // The medium article is shorter than most of its block, while the shortest is longer than most of its block.
        Assert.Equal([firstLength, middleLength, tailLength], Ids("lengthmarker"));
        Assert.Equal([count, 64_000, 45_000, 29_000, 9_000], Ids("frontonly middleonly thirdonly fourthonly finalonly"));
        Assert.Equal([count], Ids("finalonly"));
        Assert.Equal([largerWeight, smallerWeight], Ids("weightprobe"));
        Assert.Equal([count, 29_001], Ids("queue_job-23"));
        Assert.Empty(Ids("queue_job-24"));

        var expectedTies = new[] { newestTie, nextTie }.Concat(tied.Where(id => id != newestTie && id != nextTie)
            .OrderDescending().Take(198));
        Assert.Equal(expectedTies, Ids("roundtable"));
        Assert.Empty(Ids("neverpublishedtoken"));

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
        var current = new PublicSnapshot(7, articles, new([], [], []), pages, cursor, null, NullLogger.Instance,
            null, null, CancellationToken.None);
        Assert.Equal(ExpectedGeneration(current, articles, wide: true), current.Generation);
        Assert.NotEqual(ExpectedGeneration(current, articles, wide: false), current.Generation);
        var unchanged = new PublicSnapshot(8, articles, new([], [], []), pages, cursor, current, NullLogger.Instance,
            null, null, CancellationToken.None);
        Assert.Equal(current.GenerationHeader, unchanged.GenerationHeader);

        var hit = Aeds.Decode(current.Search("withdrawalneedle", CancellationToken.None)!, FrameType.ArticleSearch);
        Assert.True(hit[..4].SequenceEqual("FAS4"u8));
        Assert.Equal(4, BinaryPrimitives.ReadInt32LittleEndian(hit[4..]));
        Assert.Equal(1, BinaryPrimitives.ReadInt32LittleEndian(hit[8..]));
        Assert.Equal(last, BinaryPrimitives.ReadInt32LittleEndian(hit[12..]));
        Assert.Equal(12 + WireLayouts.ArticleSearchItemPodSize + 8 + WireLayouts.ArticlePublicationCoordinateBytes, hit.Length);
        var coordinate = hit[^WireLayouts.ArticlePublicationCoordinateBytes..];
        Assert.Equal(9L, BinaryPrimitives.ReadInt64LittleEndian(coordinate));
        Assert.Equal(9, BinaryPrimitives.ReadInt32LittleEndian(coordinate[8..]));
        Assert.Equal(publication, BinaryPrimitives.ReadInt64LittleEndian(coordinate[12..]));
        Assert.Equal(3, BinaryPrimitives.ReadInt32LittleEndian(coordinate[20..]));

        var survivors = articles[..^1];
        var withdrawn = new PublicSnapshot(9, survivors, new([], [], []), pages, cursor, unchanged, NullLogger.Instance,
            null, null, CancellationToken.None);
        Assert.True(current.HasArticle(last));
        Assert.False(withdrawn.HasArticle(last));
        Assert.NotEqual(current.GenerationHeader, withdrawn.GenerationHeader);
        Assert.Equal(ExpectedGeneration(withdrawn, survivors, wide: false), withdrawn.Generation);
        var empty = Aeds.Decode(withdrawn.Search("withdrawalneedle", CancellationToken.None)!, FrameType.ArticleSearch);
        Assert.Equal(12, empty.Length);
        Assert.Equal(0, BinaryPrimitives.ReadInt32LittleEndian(empty[8..]));
    }

    private static Article Row(int id, string title, string body, DateTimeOffset created) =>
        new(id, 1, id, 1, 1, title, body, created, created, created);

    private static double Idf(int count, int occurrences) =>
        Math.Log(1 + (count - occurrences + 0.5) / (occurrences + 0.5));

    private static long ExpectedGeneration(PublicSnapshot snapshot, Article[] articles, bool wide)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        hash.AppendData("public-generation-corpus-v1\0public-search-bm25-v2\0"u8);
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
