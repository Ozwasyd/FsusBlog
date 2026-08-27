using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Integrity;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicArtifactDigestEntriesTests
{
    [Fact]
    public void PublicAotEntry_ExposesHtmlAndShellDigestEntries()
    {
        PublicAotHtmlArtifact document = PublicAotHtmlArtifactFactory.FromHtml(
            "<!doctype html><html><body>PublicAOT</body></html>",
            "renderer",
            "assets");
        var entry = new PublicAotCacheEntry
        {
            CacheKey = "aot:article:910002",
            RouteKey = "article:910002",
            PageId = PublicPageId.ArticleDetail,
            RendererVersion = "renderer",
            FrontendAssetVersion = "assets",
            Document = document
        };

        ArtifactDigestEntry html = PublicArtifactDigestEntries.FromPublicAotHtml(entry);
        ArtifactDigestEntry shell = PublicArtifactDigestEntries.FromPublicAotShell(entry);

        Assert.Equal(ArtifactDigestKind.PublicAotHtml, html.Kind);
        Assert.Equal(ArtifactDigestKind.PublicAotShell, shell.Kind);
        Assert.Equal(ArtifactDigestState.Ready, html.State);
        Assert.Equal(ArtifactDigestState.Ready, shell.State);
        Assert.NotEqual(html.Sha256Hex, shell.Sha256Hex);
    }

    [Fact]
    public void ArticleDetailAndPublicHotReadEntries_ExposeExistingArtifactBytes()
    {
        var detail = new ArticleDetailAedsArtifact(new byte[] { 0x41, 0x45, 0x44, 0x53, 0x01 });
        var hotBinary = new PublicBinaryArtifact(
            new byte[] { 0x50, 0x48, 0x52, 0x01 },
            "\"etag\"",
            "public,max-age=60",
            Version: 7,
            AedsFrameType.ArticleList);
        PublicHtmlArtifact hotHtml = PublicHotReadHtmlArtifactFactory.FromHtml(
            "<!doctype html><html><body>hot</body></html>",
            "public,max-age=60");

        ArtifactDigestEntry detailDigest = PublicArtifactDigestEntries.FromArticleDetailAeds(910002, detail);
        ArtifactDigestEntry hotBinaryDigest = PublicArtifactDigestEntries.FromPublicHotReadBinary("public-hot-read:list", hotBinary);
        ArtifactDigestEntry hotHtmlDigest = PublicArtifactDigestEntries.FromPublicHotReadHtml("public-hot-read:html:/", hotHtml);

        Assert.Equal(ArtifactDigestKind.ArticleDetailAeds, detailDigest.Kind);
        Assert.Equal(ArtifactDigestKind.PublicHotRead, hotBinaryDigest.Kind);
        Assert.Equal(ArtifactDigestKind.PublicHotRead, hotHtmlDigest.Kind);
        Assert.Equal(detail.Frame.Length, detailDigest.Length);
        Assert.Equal(hotBinary.Frame.Length, hotBinaryDigest.Length);
        Assert.Equal(hotHtml.Bytes.Length, hotHtmlDigest.Length);
    }

    [Fact]
    public void DistributionEntries_MapCurrentEndpointOutputsToDigestKinds()
    {
        ArtifactDigestEntry rss = PublicArtifactDigestEntries.FromDistributionOutput(
            ArtifactDigestKind.RssFeed,
            "<rss><channel><title>Fsu</title></channel></rss>");
        ArtifactDigestEntry sitemap = PublicArtifactDigestEntries.FromDistributionOutput(
            ArtifactDigestKind.SitemapXml,
            "<urlset><url><loc>/article/910002</loc></url></urlset>");
        ArtifactDigestEntry robots = PublicArtifactDigestEntries.FromDistributionOutput(
            ArtifactDigestKind.RobotsTxt,
            "User-agent: *\nAllow: /\n");

        Assert.Equal("/feed/rss.xml", rss.ArtifactKey);
        Assert.Equal("/sitemap.xml", sitemap.ArtifactKey);
        Assert.Equal("/robots.txt", robots.ArtifactKey);
        Assert.All([rss, sitemap, robots], entry => Assert.Equal(ArtifactDigestState.Ready, entry.State));
    }

    [Fact]
    public void AssetLibraryEntries_ReuseStoredShaAndBuildArticleManifest()
    {
        var cover = new ContentAsset
        {
            AssetId = Guid.Parse("3f3b2e7a-1d2e-4f8a-9c5b-6a7b8c9d0e1f"),
            StorageKey = "illustration/cover.png",
            SizeBytes = 10,
            Sha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        };
        var legacy = new ContentAsset
        {
            AssetId = Guid.Parse("4f3b2e7a-1d2e-4f8a-9c5b-6a7b8c9d0e1f"),
            StorageKey = "illustration/legacy.png",
            SizeBytes = 10,
            Sha256 = null
        };

        ArtifactDigestEntry coverDigest = PublicArtifactDigestEntries.FromContentAsset(cover);
        ArtifactDigestEntry legacyDigest = PublicArtifactDigestEntries.FromContentAsset(legacy);
        ArtifactDigestEntry manifest = PublicArtifactDigestEntries.ComputeArticleAssetManifest(910002, [legacy, cover]);

        Assert.Equal(ArtifactDigestState.Ready, coverDigest.State);
        Assert.Equal(ArtifactDigestState.Unknown, legacyDigest.State);
        Assert.Equal(ArtifactDigestKind.PublicAssetManifest, manifest.Kind);
        Assert.Equal("article:910002", manifest.ArtifactKey);
        Assert.Equal(ArtifactDigestState.Ready, manifest.State);
    }
}
