namespace FsusBlog.Core.Algorithms;

/// <summary>
/// Defines the deliberately small set of immutable public response frames whose pooled
/// backing buffer may be returned without clearing. Unknown and all auth/admin/private
/// frames remain sensitive by default.
/// </summary>
public static class AedsFrameSensitivity
{
    /// <summary>
    /// Determines whether a frame contains only immutable public response data.
    /// </summary>
    public static bool IsPublicImmutable(AedsFrameType frameType)
        => frameType is AedsFrameType.ArticleList
            or AedsFrameType.ArticleDetail
            or AedsFrameType.ArticleHot
            or AedsFrameType.ArticleSearch
            or AedsFrameType.CategoryList
            or AedsFrameType.TagList
            or AedsFrameType.TaxonomyExactMetadata
            or AedsFrameType.SeoConfig
            or AedsFrameType.PageContent
            or AedsFrameType.ArticleFeatured
            or AedsFrameType.SiteComplianceConfig
            or AedsFrameType.ArticleRelatedReading
            or AedsFrameType.PublicAotBootstrap
            or AedsFrameType.EmptySuccess;

    /// <summary>
    /// Determines whether pooled storage must be cleared before it is returned.
    /// </summary>
    public static bool RequiresClear(AedsFrameType frameType)
        => !IsPublicImmutable(frameType);
}
