namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed record PublicAotSeoSnapshot(
    string SiteTitle,
    string SiteDescription,
    string? BaseUrl);

public sealed record PublicAotArticleCategorySnapshot(
    int Id,
    string Name);

public sealed record PublicAotArticleTagSnapshot(
    int Id,
    string Name);

public sealed record PublicAotArticleSummarySnapshot(
    int Id,
    string Title,
    string Summary,
    int Views,
    DateTime CreateTime,
    PublicAotArticleCategorySnapshot Category,
    IReadOnlyList<PublicAotArticleTagSnapshot> Tags);

public sealed record PublicAotRelatedReadingItemSnapshot(
    int Id,
    string Title,
    string? Summary,
    DateTime CreateTime,
    string Reason);

public sealed record PublicAotRelatedReadingSnapshot(
    IReadOnlyList<PublicAotRelatedReadingItemSnapshot> Related,
    PublicAotRelatedReadingItemSnapshot? Previous,
    PublicAotRelatedReadingItemSnapshot? Next);

public abstract record PublicPageSnapshot(
    PublicPageKind Kind,
    PublicAotSeoSnapshot Seo);

public sealed record PublicHomePageSnapshot(
    PublicAotSeoSnapshot Seo,
    int Page,
    int Size,
    int Total,
    IReadOnlyList<PublicAotArticleSummarySnapshot> Items)
    : PublicPageSnapshot(PublicPageKind.Home, Seo);

public sealed record PublicArticlePageSnapshot(
    PublicAotSeoSnapshot Seo,
    int ArticleId,
    string Title,
    string Content,
    string Summary,
    int Views,
    string AuthorName,
    DateTime CreateTime,
    PublicAotArticleCategorySnapshot Category,
    IReadOnlyList<PublicAotArticleTagSnapshot> Tags,
    PublicAotRelatedReadingSnapshot? RelatedReading)
    : PublicPageSnapshot(PublicPageKind.ArticleDetail, Seo);

public sealed record PublicFilterPageSnapshot(
    PublicAotSeoSnapshot Seo,
    string RouteKey,
    string FilterType,
    string FilterKey,
    int FilterId,
    string? FilterName,
    bool IsInvalidTarget,
    int PageIndex,
    int PageSize,
    int Total,
    IReadOnlyList<PublicAotArticleSummarySnapshot> Articles,
    string Title)
    : PublicPageSnapshot(PublicPageKind.Filter, Seo);

public sealed record PublicAboutPageSnapshot(
    PublicAotSeoSnapshot Seo,
    string Content,
    string Slug,
    string Title)
    : PublicPageSnapshot(PublicPageKind.About, Seo);

public sealed record PublicArchiveArticleSnapshot(
    int Id,
    string Title,
    DateTime CreateTime);

public sealed record PublicArchivePageSnapshot(
    PublicAotSeoSnapshot Seo,
    IReadOnlyList<PublicArchiveArticleSnapshot> Articles,
    string Title)
    : PublicPageSnapshot(PublicPageKind.Archive, Seo);

public sealed record PublicAotRenderRequest(
    PublicAotRouteMatch Match,
    PublicPageSnapshot Snapshot);
