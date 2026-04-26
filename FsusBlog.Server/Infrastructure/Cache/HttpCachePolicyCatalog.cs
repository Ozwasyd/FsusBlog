using Microsoft.AspNetCore.OutputCaching;

namespace FsusBlog.Server.Infrastructure.Cache;

public static class HttpCachePolicyCatalog
{
    public static void ApplyArticleList(OutputCachePolicyBuilder builder)
    {
        builder
            .SetVaryByQuery("page", "size", "categoryId", "tagId", "isDeleted")
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

    public static void ApplyCategoryList(OutputCachePolicyBuilder builder)
    {
        builder
            .Expire(TimeSpan.FromMinutes(5))
            .Tag(CacheTag.Category.ToOutputCacheTag());
    }

    public static void ApplyTagList(OutputCachePolicyBuilder builder)
    {
        builder
            .Expire(TimeSpan.FromMinutes(5))
            .Tag(CacheTag.Tag.ToOutputCacheTag());
    }

    public static void ApplySystemSeo(OutputCachePolicyBuilder builder)
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
}
