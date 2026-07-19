using System.Collections.Frozen;

namespace FsusBlog.Server.Infrastructure.Cache;

public sealed record ArticleCacheOwnership(
    CachePolicyId PolicyId,
    string Owner,
    string Consumers,
    string Writes,
    string Invalidation,
    string Retention);

public static class ArticleCacheOwnershipCatalog
{
    public static readonly FrozenDictionary<CachePolicyId, ArticleCacheOwnership> Policies =
        new Dictionary<CachePolicyId, ArticleCacheOwnership>
        {
            [CachePolicyId.ArticleList] = new(
                CachePolicyId.ArticleList,
                "ArticleService infrastructure port",
                "IArticleCoreService query handlers",
                "ArticleService.GetPageListAsync when ArticlePageQuery.UseSourceCache is true",
                "ArticleListVersion increment; ArticleList tag output invalidation",
                "short-lived DTO/Core cache; public binary frame path bypasses it on cold miss"),
            [CachePolicyId.ArticleListFrame] = new(
                CachePolicyId.ArticleListFrame,
                "ArticleEndpointService",
                "binary article list endpoints",
                "ArticleEndpointService.GetPageListAsync",
                "ArticleListVersion identity and ArticleList tag output invalidation",
                "primary public binary cache for encoded list responses"),
            [CachePolicyId.ArticleDetail] = new(
                CachePolicyId.ArticleDetail,
                "ArticleService infrastructure port",
                "internal detail readers and private/admin detail paths",
                "ArticleService.GetByIdAsync",
                "CacheInvalidationDispatcher article detail key removal",
                "DTO/Core cache only; public detail prefers AEDS artifact/frame"),
            [CachePolicyId.ArticleDetailFrame] = new(
                CachePolicyId.ArticleDetailFrame,
                "ArticleDetailAedsArtifactStore / invalidation dispatcher",
                "public binary detail artifact readers",
                "article detail artifact projection",
                "CacheInvalidationDispatcher article detail frame key removal",
                "primary public detail binary artifact cache"),
            [CachePolicyId.ArticleHot] = new(
                CachePolicyId.ArticleHot,
                "retired",
                "none; hot source ownership is TopArticles and binary ownership is ArticleHotFrame",
                "no writer after Core bridge cache removal",
                "HotArticles version identity and hot article invalidation",
                "reserved policy id; no DTO cache ownership"),
            [CachePolicyId.ArticleHotFrame] = new(
                CachePolicyId.ArticleHotFrame,
                "ArticleEndpointService",
                "binary hot article endpoints",
                "ArticleEndpointService.GetHotArticlesAsync",
                "HotArticles version identity and hot article invalidation",
                "primary encoded hot response cache"),
            [CachePolicyId.ArticleSearch] = new(
                CachePolicyId.ArticleSearch,
                "ArticleService",
                "search readers after keyword governance",
                "ArticleService.SearchArticlesAsync",
                "ArticleSearchVersion identity and search index version increment",
                "single search cache owner; Core handler is pass-through")
        }.ToFrozenDictionary();
}
