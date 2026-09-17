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
                "administrative article-list query handlers",
                "ArticleService.GetPageListAsync for non-public ArticlePageQuery when UseSourceCache is true",
                "ArticleListVersion increment; ArticleList tag output invalidation",
                "short-lived administrative DTO/Core cache; all public cursor queries bypass it"),
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
                "generation-scoped whole-frame build from seed read through one metadata projection and atomic frame publication",
                "HotArticles version identity and hot article invalidation",
                "primary encoded hot response cache; no prefix registry"),
            [CachePolicyId.TopArticles] = new(
                CachePolicyId.TopArticles,
                "article view projection",
                "hot and featured whole-frame builders as an optional ranking seed",
                "view projection only; frame misses never refill this seed",
                "HotArticles generation advancement",
                "ranking seed only; no seed-only singleflight or prefix registry"),
            [CachePolicyId.TopArticlesFrame] = new(
                CachePolicyId.TopArticlesFrame,
                "ArticleEndpointService",
                "binary featured article endpoints",
                "generation-scoped whole-frame build from seed read through one metadata projection and atomic frame publication",
                "HotArticles version identity and hot article invalidation",
                "primary encoded featured response cache; no prefix registry"),
            [CachePolicyId.ArticleSearch] = new(
                CachePolicyId.ArticleSearch,
                "ArticleService",
                "search readers after keyword governance",
                "ArticleService.SearchArticlesAsync",
                "ArticleSearchVersion identity and search index version increment",
                "single search cache owner; Core handler is pass-through"),
            [CachePolicyId.RelatedReading] = new(
                CachePolicyId.RelatedReading,
                "RelatedReadingService",
                "public related-reading binary endpoint",
                "singleflight projection publishes one immutable ArticleRelatedReading AEDS frame or policy negative marker",
                "publication generation identity plus ArticleList/Category/Tag invalidation",
                "one positive frame representation; missing articles use the same policy key as a negative marker")
        }.ToFrozenDictionary();
}
