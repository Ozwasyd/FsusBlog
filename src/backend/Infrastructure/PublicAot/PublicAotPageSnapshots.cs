namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed record PublicAotSiteComplianceSnapshot(
    bool Enabled,
    string RegionMode,
    string CopyrightOwner,
    int? CopyrightStartYear,
    string CopyrightText,
    string ContentLicenseName,
    string ContentLicenseUrl,
    string IcpRecordNumber,
    string IcpRecordUrl,
    string PoliceRecordNumber,
    string PoliceRecordUrl,
    string PoliceBadgeIconUrl,
    string OperatorName,
    string ContactEmail);

public sealed record PublicAotSeoSnapshot(
    string SiteTitle,
    string SiteDescription,
    string? BaseUrl,
    PublicAotSiteComplianceSnapshot? Compliance = null,
    string? SiteAuthor = null,
    string? SiteLogoUrl = null,
    string? SiteLogoDarkUrl = null,
    string? SiteWordmarkUrl = null,
    string? LoginLogoUrl = null,
    string? LoginIconUrl = null);

public sealed record PublicAotArticleCategorySnapshot(
    int Id,
    string Name);

public sealed record PublicAotArticleTagSnapshot(
    int Id,
    string Name);

public sealed record PublicAotArticleRightsSnapshot(
    long SnapshotId,
    long RevisionId,
    int RevisionNo,
    bool Enabled,
    string LicenseType,
    string? CopyrightHolder,
    int? CopyrightYear,
    string? RightsStatement,
    string? AttributionTemplate,
    string CopyPolicy,
    int MaxExcerptChars,
    bool AllowCodeCopy,
    bool ShowPublicBadge,
    bool ProofBindingEnabled,
    string? CanonicalUrl,
    string PolicyHash,
    string ContentCanonicalHash,
    string? ProofUrl,
    string? ProofStatus);

public sealed record PublicAotArticleSummarySnapshot(
    int Id,
    string Title,
    string Summary,
    int Views,
    DateTime CreateTime,
    PublicAotArticleCategorySnapshot Category,
    IReadOnlyList<PublicAotArticleTagSnapshot> Tags);

public sealed record PublicAotFeaturedArticleSnapshot(
    int Id,
    string Title,
    string CoverImageUrl,
    int Views,
    DateTime CreateTime,
    PublicAotArticleCategorySnapshot Category);

public sealed record PublicAotHotArticleSnapshot(
    int Id,
    string Title,
    int Views);

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
    IReadOnlyList<PublicAotArticleSummarySnapshot> Items,
    IReadOnlyList<PublicAotFeaturedArticleSnapshot> FeaturedArticles,
    IReadOnlyList<PublicAotHotArticleSnapshot> HotArticles)
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
    PublicAotArticleRightsSnapshot Rights,
    PublicAotRelatedReadingSnapshot? RelatedReading)
    : PublicPageSnapshot(PublicPageKind.ArticleDetail, Seo)
{
    public string CoverImageUrl { get; init; } = string.Empty;

    public DateTime? PublishedAt { get; init; }

    public DateTime? UpdatedAt { get; init; }
}

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

public sealed record PublicStaticPageSnapshot(
    PublicPageKind StaticKind,
    PublicAotSeoSnapshot Seo,
    string Content,
    string Slug,
    string Title)
    : PublicPageSnapshot(StaticKind, Seo);

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
