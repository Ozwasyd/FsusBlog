using System.Buffers.Binary;
using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server;
using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.V2.Integration.Tests;

public sealed class LocalSearchCorpusStagingTests
{
    private const int MaximumPages = 512;
    private const int MaximumBytes = 256 * 1024 * 1024;
    private const int DocumentsPerPage = WireLimits.SearchIndexPageSize;
    private static readonly DateTimeOffset Published = DateTimeOffset.FromUnixTimeMilliseconds(1_700_000_002_345);
    private static readonly Article Sample = new(42, 9_007_199_254_740_993, 9_007_199_254_741_001, 4, 2,
        "Title", "ＮＥＥＤＬＥ 雪 needle", Published, Published, Published, "note", new(7, "Lab"), [new(11, "雪")]);

    [Fact]
    public void StagedBytesAndPublicEtagMatchIndependentFspkVector()
    {
        // SHA-256 of tests/Protocol/fixtures/search-fspk-v4.hex decoded to bytes.
        const string vectorEtag = "\"daa50289bca4130b4148236c0019bd62066846893a79606e2455a5cc867caa28\"";
        var stage = Assert.Single(Stage([Sample]));
        AssertMetadata(stage, 1, 1, 42, 42);
        Assert.Equal(402, stage.Bytes.Length);
        Assert.Equal(vectorEtag, $"\"{Convert.ToHexStringLower(SHA256.HashData(stage.Bytes))}\"");

        var snapshot = new PublicSnapshot(1, [Sample], new([], [], []), new WebPages(""),
            new PublicListCursor(TimeProvider.System), null, NullLogger.Instance, null, null, CancellationToken.None);
        Assert.Equal(stage.Bytes, Assert.IsType<byte[]>(snapshot.Corpus(1)));
        Assert.Equal(vectorEtag, snapshot.CorpusTag(1).ToString());
    }

    [Fact]
    public void EmptyCorpusStagesOneEmptyPage()
    {
        var stage = Assert.Single(Stage([]));
        AssertMetadata(stage, 1, 0, 0, 0);
        Assert.Equal(104, stage.Bytes.Length);
        Assert.Equal("ccf6ee94814388854f26af27a24707c62df13b9e19e25762c4206b549eaeb09f",
            Convert.ToHexStringLower(SHA256.HashData(stage.Bytes)));
    }

    [Fact]
    public void StagingUsesOrderedDocumentRangesAndMatchesEveryEagerPage()
    {
        var articles = DescendingArticles(2 * DocumentsPerPage + 3);
        var staged = Stage(articles);
        Assert.Collection(staged,
            page => AssertMetadata(page, 1, DocumentsPerPage, 2, 2 * DocumentsPerPage),
            page => AssertMetadata(page, 2, DocumentsPerPage, 2 * DocumentsPerPage + 2, 4 * DocumentsPerPage),
            page => AssertMetadata(page, 3, 3, 4 * DocumentsPerPage + 2, 4 * DocumentsPerPage + 6));
        var eager = Assert.IsAssignableFrom<IReadOnlyList<byte[]>>(LocalSearchCorpus.Build(articles));
        Assert.Equal(eager.Count, staged.Count);
        for (var i = 0; i < eager.Count; i++)
            Assert.Equal(eager[i], staged[i].Bytes);
    }

    [Fact]
    public void StagingCanCrossTheLegacyPageLimitWithoutRetainingPageBodies()
    {
        const int lastPage = WireLimits.SearchCorpusMaxPages + 1;
        const int count = WireLimits.SearchCorpusMaxPages * DocumentsPerPage + 1;
        var tiny = Sample with { Title = "A", Body = "", Summary = null, Category = null, Tags = null };
        var articles = Enumerable.Range(1, count).Select(id => tiny with { Id = id }).ToArray();
        var visited = 0;
        Assert.True(LocalSearchCorpus.TryStagePages(articles, lastPage, 8 * 1024 * 1024, page =>
        {
            var number = ++visited;
            var first = (number - 1) * DocumentsPerPage + 1;
            var last = Math.Min(count, number * DocumentsPerPage);
            AssertMetadata(page, number, last - first + 1, first, last);
            return true;
        }));
        Assert.Equal(lastPage, visited);
    }

    [Fact]
    public void BudgetRejectsOversizeBeforePassingTheOutOfBudgetPageToTheSink()
    {
        var articles = DescendingArticles(DocumentsPerPage + 1);
        var pages = Stage(articles);
        var exact = pages.Sum(page => page.Bytes.Length);
        var accepted = new List<int>();
        Assert.False(LocalSearchCorpus.TryStagePages([], 1, 1, Accept));
        Assert.False(LocalSearchCorpus.TryStagePages(articles, 1, MaximumBytes, Accept));
        Assert.Empty(accepted);
        Assert.True(LocalSearchCorpus.TryStagePages(articles, 2, exact, Accept));
        Assert.Equal([1, 2], accepted);
        accepted.Clear();
        Assert.False(LocalSearchCorpus.TryStagePages(articles, 2, exact - 1, Accept));
        Assert.Equal(1, Assert.Single(accepted));

        bool Accept(LocalSearchCorpusPage page)
        {
            accepted.Add(page.Number);
            return true;
        }
    }

    [Theory]
    [InlineData(0, MaximumBytes)]
    [InlineData(MaximumPages + 1, MaximumBytes)]
    [InlineData(MaximumPages, 0)]
    [InlineData(MaximumPages, MaximumBytes + 1)]
    public void OutOfRangeBudgetsNeverInvokeTheSink(int pageBudget, int byteBudget)
    {
        var invoked = false;
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            LocalSearchCorpus.TryStagePages([], pageBudget, byteBudget, _ => invoked = true));
        Assert.False(invoked);
    }

    [Fact]
    public void ADeclinedPageStopsBeforeCheckingLaterArticles()
    {
        var articles = DescendingArticles(DocumentsPerPage + 2);
        articles[0] = articles[0] with { Title = "" };
        var declined = new List<int>();
        Assert.False(LocalSearchCorpus.TryStagePages(articles, MaximumPages, MaximumBytes, page =>
        {
            declined.Add(page.Number);
            return false;
        }));
        Assert.Equal(1, Assert.Single(declined));
    }

    [Theory]
    [InlineData(1)]
    [InlineData(DocumentsPerPage + 1)]
    public void CancellationFromTheSinkStopsAndThrowsEvenAtTheFinalPage(int count)
    {
        using var cancellation = new CancellationTokenSource();
        var visited = new List<int>();
        var failure = Assert.Throws<OperationCanceledException>(() =>
            LocalSearchCorpus.TryStagePages(DescendingArticles(count), MaximumPages, MaximumBytes, page =>
            {
                visited.Add(page.Number);
                cancellation.Cancel();
                return true;
            }, cancellation.Token));
        Assert.Equal(cancellation.Token, failure.CancellationToken);
        Assert.Equal(1, Assert.Single(visited));
        Assert.Throws<OperationCanceledException>(() =>
            LocalSearchCorpus.TryStagePages([], MaximumPages, MaximumBytes, _ => throw new InvalidOperationException(),
                cancellation.Token));
    }

    private static List<LocalSearchCorpusPage> Stage(IReadOnlyList<Article> articles)
    {
        var staged = new List<LocalSearchCorpusPage>();
        Assert.True(LocalSearchCorpus.TryStagePages(articles, MaximumPages, MaximumBytes, page =>
        {
            staged.Add(page);
            return true;
        }));
        return staged;
    }

    private static Article[] DescendingArticles(int count) => Enumerable.Range(1, count).Reverse()
        .Select(index => Sample with { Id = index * 2 }).ToArray();

    private static void AssertMetadata(LocalSearchCorpusPage page, int number, int count, int first, int last)
    {
        Assert.Equal((number, count, first, last), (page.Number, page.DocumentCount, page.FirstArticleId, page.LastArticleId));
        Assert.InRange(page.Bytes.Length, 1, WireLimits.SearchCorpusPageBytes);
        Assert.True(page.Bytes.AsSpan(0, 4).SequenceEqual("FSPK"u8));
        var shard = page.Bytes.AsSpan(WireLayouts.SearchPackagePayloadOffset);
        Assert.Equal(count, BinaryPrimitives.ReadInt32LittleEndian(shard[20..]));
        if (count == 0) return;

        var documents = BinaryPrimitives.ReadInt32LittleEndian(shard[40..]);
        Assert.Equal(first, BinaryPrimitives.ReadInt32LittleEndian(shard[documents..]));
        Assert.Equal(last, BinaryPrimitives.ReadInt32LittleEndian(shard[(documents + (count - 1) * WireLayouts.SearchDocumentRecordSize)..]));
    }
}
