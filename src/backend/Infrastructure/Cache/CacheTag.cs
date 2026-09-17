namespace FsusBlog.Server.Infrastructure.Cache;

public enum CacheTag
{
    None = 0,
    ArticleList = 1,
    HotArticles = 2,
    Category = 3,
    Tag = 4,
    SystemPage = 5,
    Seo = 6,
    Stats = 7,
    Aot = 8,
    Comment = 9,
    Theme = 10
}

public static class CacheTagExtensions
{
    public static string ToOutputCacheTag(this CacheTag tag) => tag switch
    {
        CacheTag.ArticleList => "ArticleList",
        CacheTag.HotArticles => "HotArticles",
        CacheTag.Category => "Category",
        CacheTag.Tag => "Tag",
        CacheTag.SystemPage => "SystemPage",
        CacheTag.Seo => "Seo",
        CacheTag.Stats => "Stats",
        CacheTag.Aot => "Aot",
        CacheTag.Comment => "Comment",
        CacheTag.Theme => "Theme",
        _ => "None"
    };
}
