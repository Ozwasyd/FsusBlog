using System.Security.Cryptography;
using System.Text;

using FsusBlog.Core.Integrity;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArtifactDigestV1Tests
{
    [Fact]
    public void ComputeUtf8_PublicAotHtmlDigestChangesWithBytesAndRepeatsStably()
    {
        const string Html = "<!doctype html><html><body><article>PublicAOT</article></body></html>";

        ArtifactDigestEntry first = ArtifactDigestV1.ComputeUtf8(
            ArtifactDigestKind.PublicAotHtml,
            "aot:/article/910002",
            Html);
        ArtifactDigestEntry repeat = ArtifactDigestV1.ComputeUtf8(
            ArtifactDigestKind.PublicAotHtml,
            "aot:/article/910002",
            Html);
        ArtifactDigestEntry changed = ArtifactDigestV1.ComputeUtf8(
            ArtifactDigestKind.PublicAotHtml,
            "aot:/article/910002",
            Html.Replace("PublicAOT", "PublicAOT updated", StringComparison.Ordinal));

        Assert.Equal(1, ArtifactDigestV1.HashVersion);
        Assert.Equal("fsusblog.integrity.artifact-digest.v1", ArtifactDigestV1.DomainSeparator);
        Assert.Equal("sha256", ArtifactDigestV1.HashAlgorithm);
        Assert.Equal(ArtifactDigestState.Ready, first.State);
        Assert.Equal(64, first.Sha256Hex?.Length);
        Assert.Equal(Encoding.UTF8.GetByteCount(Html), first.Length);
        Assert.Equal(first.Sha256Hex, repeat.Sha256Hex);
        Assert.NotEqual(first.Sha256Hex, changed.Sha256Hex);
    }

    [Fact]
    public void ComputeBytes_ArticleDetailAedsAndPublicHotReadDigestsChangeWithPayloadBytes()
    {
        byte[] articleDetail = [0x41, 0x45, 0x44, 0x53, 0x01, 0x10, 0x2A, 0x00];
        byte[] articleDetailChanged = [0x41, 0x45, 0x44, 0x53, 0x01, 0x10, 0x2B, 0x00];
        byte[] hotRead = [0x50, 0x48, 0x52, 0x01, 0x00, 0x00, 0x00, 0x01];
        byte[] hotReadChanged = [0x50, 0x48, 0x52, 0x01, 0x00, 0x00, 0x00, 0x02];

        ArtifactDigestEntry detailDigest = ArtifactDigestV1.ComputeBytes(
            ArtifactDigestKind.ArticleDetailAeds,
            "article-detail-aeds:910002",
            articleDetail);
        ArtifactDigestEntry detailChangedDigest = ArtifactDigestV1.ComputeBytes(
            ArtifactDigestKind.ArticleDetailAeds,
            "article-detail-aeds:910002",
            articleDetailChanged);
        ArtifactDigestEntry hotReadDigest = ArtifactDigestV1.ComputeBytes(
            ArtifactDigestKind.PublicHotRead,
            "public-hot-read:home",
            hotRead);
        ArtifactDigestEntry hotReadChangedDigest = ArtifactDigestV1.ComputeBytes(
            ArtifactDigestKind.PublicHotRead,
            "public-hot-read:home",
            hotReadChanged);

        Assert.NotEqual(detailDigest.Sha256Hex, detailChangedDigest.Sha256Hex);
        Assert.NotEqual(hotReadDigest.Sha256Hex, hotReadChangedDigest.Sha256Hex);
        Assert.Equal(articleDetail.Length, detailDigest.Length);
        Assert.Equal(hotRead.Length, hotReadDigest.Length);
    }

    [Theory]
    [InlineData(ArtifactDigestKind.RssFeed, "feed:rss", "<rss><title>Fsu</title></rss>", "<rss><title>Fsu updated</title></rss>")]
    [InlineData(ArtifactDigestKind.AtomFeed, "feed:atom", "<feed><title>Fsu</title></feed>", "<feed><title>Fsu updated</title></feed>")]
    [InlineData(ArtifactDigestKind.JsonFeed, "feed:json", "{\"title\":\"Fsu\"}", "{\"title\":\"Fsu updated\"}")]
    [InlineData(ArtifactDigestKind.SitemapXml, "sitemap.xml", "<urlset><url><loc>/a</loc></url></urlset>", "<urlset><url><loc>/b</loc></url></urlset>")]
    [InlineData(ArtifactDigestKind.RobotsTxt, "robots.txt", "User-agent: *\nAllow: /\n", "User-agent: *\nDisallow: /\n")]
    public void ComputeUtf8_DistributionArtifactDigestChangesWithOutput(
        ArtifactDigestKind kind,
        string key,
        string content,
        string changedContent)
    {
        ArtifactDigestEntry first = ArtifactDigestV1.ComputeUtf8(kind, key, content);
        ArtifactDigestEntry repeat = ArtifactDigestV1.ComputeUtf8(kind, key, content);
        ArtifactDigestEntry changed = ArtifactDigestV1.ComputeUtf8(kind, key, changedContent);

        Assert.Equal(first.Sha256Hex, repeat.Sha256Hex);
        Assert.NotEqual(first.Sha256Hex, changed.Sha256Hex);
    }

    [Fact]
    public async Task TryComputeFileAsync_ExposesMissingEmptyAndUnavailableStates()
    {
        string root = Directory.CreateTempSubdirectory("fsus-artifact-digest-").FullName;
        try
        {
            string missingPath = Path.Combine(root, "missing.html");
            ArtifactDigestEntry missing = await ArtifactDigestV1.TryComputeFileAsync(
                ArtifactDigestKind.PublicAotShell,
                "aot-shell:missing",
                missingPath);
            Assert.Equal(ArtifactDigestState.Missing, missing.State);
            Assert.Null(missing.Sha256Hex);

            string emptyPath = Path.Combine(root, "empty.html");
            await File.WriteAllBytesAsync(emptyPath, []);
            ArtifactDigestEntry empty = await ArtifactDigestV1.TryComputeFileAsync(
                ArtifactDigestKind.PublicAotShell,
                "aot-shell:empty",
                emptyPath);
            Assert.Equal(ArtifactDigestState.Ready, empty.State);
            Assert.Equal(0, empty.Length);
            Assert.Equal("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", empty.Sha256Hex);

            await using var throwing = new ThrowingReadStream();
            ArtifactDigestEntry unavailable = await ArtifactDigestV1.TryComputeStreamAsync(
                ArtifactDigestKind.PublicAotShell,
                "aot-shell:unreadable",
                throwing);
            Assert.Equal(ArtifactDigestState.Unavailable, unavailable.State);
            Assert.Contains("read-failed", unavailable.Reason, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void StateFactories_ExposePendingStaleNotPublicAndUnknown()
    {
        Assert.Equal(
            ArtifactDigestState.Pending,
            ArtifactDigestV1.Pending(ArtifactDigestKind.PublicHotRead, "public-hot-read:home", "concurrent-refresh").State);
        Assert.Equal(
            ArtifactDigestState.Stale,
            ArtifactDigestV1.Stale(ArtifactDigestKind.PublicAotHtml, "aot:/", "outbox-not-replayed").State);
        Assert.Equal(
            ArtifactDigestState.NotPublic,
            ArtifactDigestV1.NotPublic(ArtifactDigestKind.ArticleDetailAeds, "article-detail-aeds:1", "article-not-published").State);
        Assert.Equal(
            ArtifactDigestState.Unknown,
            ArtifactDigestV1.FromAssetLibrarySha256("asset:/uploads/legacy.png", null, length: null).State);
    }

    [Fact]
    public async Task TryComputeStreamAsync_UsesStreamingHashForLargePayloads()
    {
        byte[] payload = new byte[5 * 1024 * 1024 + 17];
        Random.Shared.NextBytes(payload);
        await using var stream = new MemoryStream(payload, writable: false);

        ArtifactDigestEntry digest = await ArtifactDigestV1.TryComputeStreamAsync(
            ArtifactDigestKind.PublicAotHtml,
            "aot:/large",
            stream);

        Assert.Equal(Convert.ToHexString(SHA256.HashData(payload)).ToLowerInvariant(), digest.Sha256Hex);
        Assert.Equal(payload.Length, digest.Length);

        string runtimeShape = RuntimeMetadataInspection.DescribeMethods(
            typeof(ArtifactDigestV1),
            nameof(ArtifactDigestV1.TryComputeStreamAsync));
        Assert.Contains("ArrayPool", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("Rent", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("Return", runtimeShape, StringComparison.Ordinal);
    }

    [Fact]
    public void AssetDigest_AlignsWithAssetLibrarySha256AndMakesMismatchVisible()
    {
        byte[] assetBytes = Encoding.UTF8.GetBytes("public image bytes");
        string actual = Convert.ToHexString(SHA256.HashData(assetBytes)).ToLowerInvariant();

        ArtifactDigestEntry matched = ArtifactDigestV1.ValidateAssetLibrarySha256(
            "asset:/uploads/public.png",
            actual.ToUpperInvariant(),
            assetBytes);
        ArtifactDigestEntry mismatch = ArtifactDigestV1.ValidateAssetLibrarySha256(
            "asset:/uploads/public.png",
            new string('0', 64),
            assetBytes);

        Assert.Equal(ArtifactDigestState.Ready, matched.State);
        Assert.Equal(actual, matched.Sha256Hex);
        Assert.Equal(ArtifactDigestState.HashMismatch, mismatch.State);
        Assert.Equal(actual, mismatch.Sha256Hex);
        Assert.Equal(new string('0', 64), mismatch.ExpectedSha256Hex);
        Assert.Contains("AssetLibraryItem.Sha256", mismatch.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void ComputePublicAssetManifest_SortsEntriesAndChangesWhenAssetDigestChanges()
    {
        ArtifactDigestEntry cover = ArtifactDigestV1.ComputeBytes(
            ArtifactDigestKind.PublicAsset,
            "asset:/uploads/cover.png",
            [1, 2, 3]);
        ArtifactDigestEntry inline = ArtifactDigestV1.ComputeBytes(
            ArtifactDigestKind.PublicAsset,
            "asset:/uploads/inline.png",
            [4, 5, 6]);
        ArtifactDigestEntry changedInline = ArtifactDigestV1.ComputeBytes(
            ArtifactDigestKind.PublicAsset,
            "asset:/uploads/inline.png",
            [4, 5, 7]);

        ArtifactDigestEntry manifest = ArtifactDigestV1.ComputePublicAssetManifest(
            "article:910002",
            [inline, cover]);
        ArtifactDigestEntry sortedManifest = ArtifactDigestV1.ComputePublicAssetManifest(
            "article:910002",
            [cover, inline]);
        ArtifactDigestEntry changedManifest = ArtifactDigestV1.ComputePublicAssetManifest(
            "article:910002",
            [cover, changedInline]);

        Assert.Equal(ArtifactDigestKind.PublicAssetManifest, manifest.Kind);
        Assert.Equal(manifest.Sha256Hex, sortedManifest.Sha256Hex);
        Assert.NotEqual(manifest.Sha256Hex, changedManifest.Sha256Hex);
    }

    [Fact]
    public void RuntimeType_IsCoreOnlyAndDoesNotReferenceExternalStorageOrChainAnchors()
    {
        Assert.Equal("FsusBlog.Core", typeof(ArtifactDigestV1).Assembly.GetName().Name);
        string runtimeShape = RuntimeMetadataInspection.DescribeType(typeof(ArtifactDigestV1));
        Assert.DoesNotContain("FsusBlog.Server", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("SqlSugar", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("HttpContext", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("IPFS", runtimeShape, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Arweave", runtimeShape, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Nethereum", runtimeShape, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("HttpClient", runtimeShape, StringComparison.Ordinal);
    }

    private sealed class ThrowingReadStream : Stream
    {
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position
        {
            get => 0;
            set => throw new NotSupportedException();
        }

        public override void Flush()
        {
        }

        public override int Read(byte[] buffer, int offset, int count)
            => throw new IOException("read-failed");

        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
            => throw new IOException("read-failed");

        public override long Seek(long offset, SeekOrigin origin)
            => throw new NotSupportedException();

        public override void SetLength(long value)
            => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count)
            => throw new NotSupportedException();
    }
}
