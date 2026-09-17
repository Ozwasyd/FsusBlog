using FsusBlog.Core.Integrity;
using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;

namespace FsusBlog.Server.Infrastructure.Integrity;

public static class PublicArtifactDigestEntries
{
    public static ArtifactDigestEntry FromPublicAotHtml(PublicAotCacheEntry entry)
    {
        ArgumentNullException.ThrowIfNull(entry);
        PublicAotHtmlArtifact document = entry.GetDocument();
        string key = PublicAotArtifactKey(entry);
        return document.Utf8Bytes.IsEmpty
            ? ArtifactDigestV1.Missing(ArtifactDigestKind.PublicAotHtml, key, "public-aot-html-missing")
            : ArtifactDigestV1.ComputeBytes(ArtifactDigestKind.PublicAotHtml, key, document.Utf8Bytes.Span);
    }

    public static ArtifactDigestEntry FromPublicAotShell(PublicAotCacheEntry entry)
    {
        ArgumentNullException.ThrowIfNull(entry);
        byte[] payload = PublicAotFileShellCache.SerializeEntryBytes(entry);
        string key = PublicAotArtifactKey(entry);
        return payload.Length == 0
            ? ArtifactDigestV1.Missing(ArtifactDigestKind.PublicAotShell, key, "public-aot-shell-missing")
            : ArtifactDigestV1.ComputeBytes(ArtifactDigestKind.PublicAotShell, key, payload);
    }

    public static ArtifactDigestEntry FromArticleDetailAeds(
        int articleId,
        ArticleDetailAedsArtifact artifact)
    {
        string key = ArticleDetailAedsKey(articleId);
        return artifact.Found
            ? ArtifactDigestV1.ComputeBytes(ArtifactDigestKind.ArticleDetailAeds, key, artifact.Frame.Span)
            : ArtifactDigestV1.Missing(ArtifactDigestKind.ArticleDetailAeds, key, "article-detail-aeds-missing");
    }

    public static ArtifactDigestEntry FromPublicHotReadBinary(
        string artifactKey,
        PublicBinaryArtifact artifact)
    {
        return artifact.Frame.IsEmpty
            ? ArtifactDigestV1.Missing(ArtifactDigestKind.PublicHotRead, artifactKey, "public-hot-read-binary-missing")
            : ArtifactDigestV1.ComputeBytes(ArtifactDigestKind.PublicHotRead, artifactKey, artifact.Frame.Span);
    }

    public static ArtifactDigestEntry FromPublicHotReadHtml(
        string artifactKey,
        PublicHtmlArtifact artifact)
    {
        return artifact.Bytes.IsEmpty
            ? ArtifactDigestV1.Missing(ArtifactDigestKind.PublicHotRead, artifactKey, "public-hot-read-html-missing")
            : ArtifactDigestV1.ComputeBytes(ArtifactDigestKind.PublicHotRead, artifactKey, artifact.Bytes.Span);
    }

    public static ArtifactDigestEntry FromDistributionOutput(
        ArtifactDigestKind kind,
        string output)
    {
        string key = DistributionArtifactKey(kind);
        return ArtifactDigestV1.ComputeUtf8(kind, key, output);
    }

    public static ArtifactDigestEntry FromContentAsset(ContentAsset asset)
    {
        ArgumentNullException.ThrowIfNull(asset);
        return ArtifactDigestV1.FromAssetLibrarySha256(
            PublicAssetUrlCodec.RoutePrefix + asset.StorageKey,
            asset.Sha256,
            asset.SizeBytes);
    }

    public static ArtifactDigestEntry ValidateContentAsset(
        ContentAsset asset,
        ReadOnlySpan<byte> actualBytes)
    {
        ArgumentNullException.ThrowIfNull(asset);
        return ArtifactDigestV1.ValidateAssetLibrarySha256(
            PublicAssetUrlCodec.RoutePrefix + asset.StorageKey,
            asset.Sha256,
            actualBytes);
    }

    public static ArtifactDigestEntry ComputeArticleAssetManifest(
        int articleId,
        IEnumerable<ContentAsset> assets)
    {
        if (articleId <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(articleId), articleId, "Article id must be positive.");
        }

        ArgumentNullException.ThrowIfNull(assets);
        ArtifactDigestEntry[] entries = [.. assets.Select(FromContentAsset)];
        return ArtifactDigestV1.ComputePublicAssetManifest($"article:{articleId}", entries);
    }

    public static string DistributionArtifactKey(ArtifactDigestKind kind)
        => kind switch
        {
            ArtifactDigestKind.RssFeed => "/feed/rss.xml",
            ArtifactDigestKind.AtomFeed => "/feed/atom.xml",
            ArtifactDigestKind.JsonFeed => "/feed/feed.json",
            ArtifactDigestKind.SitemapXml => "/sitemap.xml",
            ArtifactDigestKind.RobotsTxt => "/robots.txt",
            _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, "Kind is not a DistributionEndpoints artifact.")
        };

    private static string PublicAotArtifactKey(PublicAotCacheEntry entry)
    {
        if (!string.IsNullOrWhiteSpace(entry.RouteKey))
        {
            return $"public-aot:{entry.PageId}:{entry.RouteKey}";
        }

        return $"public-aot:{entry.PageId}:{entry.CacheKey}";
    }

    private static string ArticleDetailAedsKey(int articleId)
    {
        if (articleId <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(articleId), articleId, "Article id must be positive.");
        }

        return $"article-detail-aeds:{articleId}";
    }
}
