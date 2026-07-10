using Microsoft.AspNetCore.OutputCaching;

namespace FsusBlog.Server.Infrastructure.Cache;

public static class HttpCachePolicyCatalog
{
    public static void ApplyArticleList(OutputCachePolicyBuilder builder)
    {
        builder
            .SetVaryByQuery("page", "size", "keyword", "categoryId", "tagId", "isDeleted", "status")
            .Expire(TimeSpan.FromMinutes(1))
            .Tag(CacheTag.ArticleList.ToOutputCacheTag());
    }

    public static void ApplyHotArticles(OutputCachePolicyBuilder builder)
    {
        builder
            .SetVaryByQuery("size")
            .Expire(TimeSpan.FromMinutes(2))
            .Tag(CacheTag.HotArticles.ToOutputCacheTag());
    }

    public static void ApplyFeaturedArticles(OutputCachePolicyBuilder builder)
    {
        builder
            .SetVaryByQuery("size")
            .Expire(TimeSpan.FromMinutes(2))
            .Tag(CacheTag.ArticleList.ToOutputCacheTag());
    }

    public static void ApplySystemSeo(OutputCachePolicyBuilder builder)
    {
        builder
            .Expire(TimeSpan.FromMinutes(10))
            .Tag(CacheTag.Seo.ToOutputCacheTag());
    }

    public static void ApplySystemCompliance(OutputCachePolicyBuilder builder)
    {
        builder
            .Expire(TimeSpan.FromMinutes(10))
            .Tag(CacheTag.Seo.ToOutputCacheTag());
    }

    public static void ApplySystemPage(OutputCachePolicyBuilder builder)
    {
        builder
            .SetVaryByRouteValue("slug")
            .Expire(TimeSpan.FromMinutes(30))
            .Tag(CacheTag.SystemPage.ToOutputCacheTag());
    }

    public static void ApplyCommentThreads(OutputCachePolicyBuilder builder)
    {
        builder
            .SetVaryByRouteValue("articleId")
            .SetVaryByQuery("cursor", "limit")
            .Expire(TimeSpan.FromSeconds(30))
            .Tag(CacheTag.Comment.ToOutputCacheTag());
    }

    public static void ApplyCommentThreadReplies(OutputCachePolicyBuilder builder)
    {
        builder
            .SetVaryByRouteValue("articleId", "rootId")
            .SetVaryByQuery("cursor", "limit")
            .Expire(TimeSpan.FromSeconds(30))
            .Tag(CacheTag.Comment.ToOutputCacheTag());
    }
}
