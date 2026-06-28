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
                "ArticleService / internal DTO readers",
                "admin JSON compatibility and non-binary service consumers",
                "ArticleService.GetPageListAsync and internal Core bridge callers",
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
                "ArticleService / Core bridge",
                "internal detail readers and private/admin detail paths",
                "ArticleService.GetByIdAsync and ArticleCoreQueryCache.GetOrLoadByIdAsync",
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
                "ArticleCoreQueryCache",
                "internal hot article Core consumers",
                "ArticleCoreQueryCache.GetOrLoadHotArticlesAsync",
                "HotArticles version identity and hot article invalidation",
                "Core cache for non-frame consumers"),
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
                "single search cache owner; Core bridge search is pass-through")
        }.ToFrozenDictionary();
}
