using System.Collections;
using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server.Content;

namespace FsusBlog.V2.Integration.Tests;

public sealed class WideSearchCorpusStageTests
{
    private const int PageLimit = 512;
    private const int ByteLimit = 256 * 1024 * 1024;
    private const int DocumentsPerPage = WireLimits.SearchIndexPageSize;
    private static readonly TimeSpan CloseDeadline = TimeSpan.FromSeconds(5);
    private static readonly DateTimeOffset Published = DateTimeOffset.FromUnixTimeMilliseconds(1_700_000_002_345);
    private static readonly Article Sample = new(42, 9_007_199_254_740_993, 9_007_199_254_741_001, 4, 2,
        "Title", "ＮＥＥＤＬＥ 雪 needle", Published, Published, Published, "note", new(7, "Lab"), [new(11, "雪")]);
    private static bool Supported => OperatingSystem.IsMacOS() || OperatingSystem.IsLinux();

    [Fact]
    public async Task IndependentSpoolsHaveTheSameManifestAndReadOnlyTheRequestedPage()
    {
        if (!Supported) return;
        const int documents = DocumentsPerPage + 3;
        var articles = ArticleRows(documents);
        var eager = Assert.IsAssignableFrom<IReadOnlyList<byte[]>>(LocalSearchCorpus.Build(articles));
        long expectedBytes = eager.Sum(page => (long)page.Length);
        using var first = Build(articles);
        using var second = Build(articles.Reverse().ToArray());
        Assert.Equal(documents, first.Manifest.DocumentCount);
        Assert.Equal(expectedBytes, first.Manifest.ByteCount);
        Assert.Equal(eager.Count, first.Manifest.Pages.Count);
        Assert.Equal(documents, second.Manifest.DocumentCount);
        Assert.Equal(expectedBytes, second.Manifest.ByteCount);
        Assert.Equal(eager.Count, second.Manifest.Pages.Count);
        AssertReadOnly(first.Manifest.Pages);

        using var canonical = new MemoryStream();
        using var writer = new BinaryWriter(canonical);
        writer.Write("public-search-fspk-manifest-v1\0"u8);
        writer.Write(documents);
        writer.Write(eager.Count);
        writer.Write(expectedBytes);
        long offset = 0;
        for (var i = 0; i < eager.Count; i++)
        {
            var firstId = i * DocumentsPerPage + 1;
            var lastId = Math.Min(documents, (i + 1) * DocumentsPerPage);
            var count = lastId - firstId + 1;
            var raw = eager[i];
            var sha = SHA256.HashData(raw);
            var descriptor = first.Manifest.Pages[i];
            Assert.Equal((i + 1, count, firstId, lastId, offset, raw.Length, Convert.ToHexStringLower(sha)),
                (descriptor.Number, descriptor.DocumentCount, descriptor.FirstArticleId, descriptor.LastArticleId,
                    descriptor.Offset, descriptor.Length, descriptor.Sha256));
            Assert.Equal(descriptor, second.Manifest.Pages[i]);

            writer.Write(i + 1);
            writer.Write(count);
            writer.Write(firstId);
            writer.Write(lastId);
            writer.Write(offset);
            writer.Write(raw.Length);
            writer.Write(sha);
            offset += raw.Length;
        }
        writer.Flush();
        var digest = Sha256(canonical.ToArray());
        Assert.Equal(digest, first.Manifest.ContentDigest);
        Assert.Equal(digest, second.Manifest.ContentDigest);

        // Read the last page first, then the first, so a shared stream position cannot pass.
        Assert.Equal(eager[^1], await Read(first, eager.Count, eager[^1].Length));
        Assert.Equal(eager[0], await Read(first, 1, eager[0].Length));
        Assert.Null(first.Borrow(0));
        Assert.Null(first.Borrow(eager.Count + 1));
        first.Dispose();
        await first.Closed.WaitAsync(CloseDeadline);
        Assert.Equal(eager[^1], await Read(second, eager.Count, eager[^1].Length));
        second.Dispose();
        await second.Closed.WaitAsync(CloseDeadline);
    }

    [Fact]
    public async Task EmptySpoolHasOnePageWithAnEmptyArticleRange()
    {
        if (!Supported) return;
        using var stage = Build([]);
        var descriptor = Assert.Single(stage.Manifest.Pages);
        Assert.Equal(0, stage.Manifest.DocumentCount);
        Assert.Equal((1, 0, 0, 0, 0L, 104), (descriptor.Number, descriptor.DocumentCount, descriptor.FirstArticleId,
            descriptor.LastArticleId, descriptor.Offset, descriptor.Length));
        Assert.Equal(104L, stage.Manifest.ByteCount);
        const string emptySha = "ccf6ee94814388854f26af27a24707c62df13b9e19e25762c4206b549eaeb09f";
        Assert.Equal(emptySha, descriptor.Sha256);
        Assert.Equal(emptySha, Sha256(await Read(stage, 1, descriptor.Length)));
    }

    [Fact]
    public void RejectionAndCancellationDoNotAdmitAPartialSpool()
    {
        if (!Supported) return;
        var articles = ArticleRows(DocumentsPerPage + 2);
        var eager = Assert.IsAssignableFrom<IReadOnlyList<byte[]>>(LocalSearchCorpus.Build(articles));
        var exactBytes = eager.Sum(page => page.Length);
        using var accepted = Assert.IsType<WideSearchCorpusStage>(WideSearchCorpusStage.Build(articles, 2, exactBytes));
        using var exceedsPages = WideSearchCorpusStage.Build(articles, 1, ByteLimit);
        Assert.Null(exceedsPages);
        using var exceedsBytes = WideSearchCorpusStage.Build(articles, 2, exactBytes - 1);
        Assert.Null(exceedsBytes);
        Assert.Throws<ArgumentOutOfRangeException>(() => WideSearchCorpusStage.Build(articles, PageLimit + 1, ByteLimit));
        Assert.Throws<ArgumentOutOfRangeException>(() => WideSearchCorpusStage.Build(articles, PageLimit, 0));
        Assert.Throws<ProtocolException>(() => WideSearchCorpusStage.Build([Sample with { Revision = 0 }], PageLimit, ByteLimit));

        using var cancellation = new CancellationTokenSource();
        // The highest ID is indexed after the first complete page has been staged.
        articles[0] = articles[0] with { Tags = new CancelOnTags(cancellation) };
        Assert.ThrowsAny<OperationCanceledException>(() =>
            WideSearchCorpusStage.Build(articles, 2, ByteLimit, cancellation.Token));
        Assert.True(cancellation.IsCancellationRequested);
        Assert.ThrowsAny<OperationCanceledException>(() =>
            WideSearchCorpusStage.Build([], PageLimit, ByteLimit, cancellation.Token));
    }

    [Fact]
    public async Task RetirementClosesOnlyAfterPreviouslyBorrowedPagesAreConsumedOrReleased()
    {
        if (!Supported) return;
        using var stage = Build(ArticleRows(DocumentsPerPage + 1));
        var length = stage.Manifest.Pages[1].Length;
        var expectedSha = stage.Manifest.Pages[1].Sha256;
        using var held = RequireBorrow(stage, 1);
        using var pending = RequireBorrow(stage, 2);
        stage.Dispose();
        Assert.False(stage.Closed.IsCompleted);
        Assert.Null(stage.Borrow(1));

        await Assert.ThrowsAsync<ArgumentException>(async () => await pending.ReadAsync(new byte[length - 1]));
        Assert.False(stage.Closed.IsCompleted);
        var bytes = new byte[length];
        await pending.ReadAsync(bytes);
        Assert.Equal(expectedSha, Sha256(bytes));
        await Assert.ThrowsAsync<ObjectDisposedException>(async () => await pending.ReadAsync(bytes));
        Assert.False(stage.Closed.IsCompleted);

        held.Dispose();
        await stage.Closed.WaitAsync(CloseDeadline);
        stage.Dispose();
        Assert.Null(stage.Borrow(2));
    }

    [Fact]
    public async Task CancellationOfAValidBorrowedReadReleasesItsRetiredFile()
    {
        if (!Supported) return;
        using var stage = Build([Sample]);
        using var reader = RequireBorrow(stage, 1);
        var destination = Enumerable.Repeat((byte)0xff, stage.Manifest.Pages[0].Length).ToArray();
        stage.Dispose();
        Assert.False(stage.Closed.IsCompleted);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
            await reader.ReadAsync(destination, cancellation.Token));
        Assert.All(destination, value => Assert.Equal((byte)0xff, value));
        await stage.Closed.WaitAsync(CloseDeadline);
        Assert.Null(stage.Borrow(1));
    }

    private static WideSearchCorpusStage Build(IReadOnlyList<Article> articles) =>
        Assert.IsType<WideSearchCorpusStage>(WideSearchCorpusStage.Build(articles, PageLimit, ByteLimit));

    private static WideSearchCorpusStage.PageRead RequireBorrow(WideSearchCorpusStage stage, int number) =>
        Assert.IsType<WideSearchCorpusStage.PageRead>(stage.Borrow(number));

    private static async Task<byte[]> Read(WideSearchCorpusStage stage, int number, int length)
    {
        using var reader = RequireBorrow(stage, number);
        var bytes = new byte[length];
        await reader.ReadAsync(bytes);
        return bytes;
    }

    private static Article[] ArticleRows(int count) => Enumerable.Range(1, count).Reverse()
        .Select(id => Sample with { Id = id }).ToArray();

    private static string Sha256(ReadOnlySpan<byte> bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));

    private static void AssertReadOnly<T>(IReadOnlyList<T> values)
    {
        if (values is IList<T> list)
            Assert.Throws<NotSupportedException>(() => { list[0] = values[1]; });
    }

    private sealed class CancelOnTags(CancellationTokenSource cancellation) : IReadOnlyList<TaxonomyName>
    {
        public int Count => 1;
        public TaxonomyName this[int index] => index == 0 ? new(11, "雪") : throw new ArgumentOutOfRangeException(nameof(index));

        public IEnumerator<TaxonomyName> GetEnumerator()
        {
            cancellation.Cancel();
            yield return this[0];
        }

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }
}
