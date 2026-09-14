using System.Globalization;

namespace FsusBlog.Server.Infrastructure.Cache;

internal static class ArticleHotFrameIdentity
{
    private const string SchemaVersion = "aeds-v2";
    private const string RankingVersion = "ranking-v1";

    internal static string BuildHot(IHotArticlesCacheVersionProvider versions, int count)
        => BuildHot(versions.CurrentHotArticlesVersion, count);

    internal static string BuildHot(long generation, int count)
        => $"v{generation.ToString(CultureInfo.InvariantCulture)}:frame:article-hot:{SchemaVersion}:{RankingVersion}:count:{count.ToString(CultureInfo.InvariantCulture)}";

    internal static string BuildFeatured(IHotArticlesCacheVersionProvider versions, int count)
        => BuildFeatured(versions.CurrentHotArticlesVersion, count);

    internal static string BuildFeatured(long generation, int count)
        => $"v{generation.ToString(CultureInfo.InvariantCulture)}:frame:article-featured:{SchemaVersion}:{RankingVersion}:count:{count.ToString(CultureInfo.InvariantCulture)}";
}
