using Microsoft.AspNetCore.OutputCaching;

namespace FsusBlog.Server.Infrastructure.Cache;

public static class HttpCachePolicyCatalog
{
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
}
