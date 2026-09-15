using FsusBlog.Core.Integrity;
using FsusBlog.Server.Entities;

namespace FsusBlog.Server.Services.Articles;

public static class ArticleRightsSnapshotBuilder
{
    public static (ArticleRightsSnapshot Snapshot, string ContentCanonicalHash, string PolicyHash) Build(
        int articleId,
        long revisionId,
        int revisionNo,
        long policyId,
        string title,
        string content,
        string? summary,
        string? coverImageUrl,
        int categoryId,
        IReadOnlyList<int> tagIds,
        ArticleStatus status,
        DateTime? publishedAt,
        DateTime? scheduledPublishAt,
        ArticleRightsNormalizedModel rights,
        DateTime createdAt)
    {
        ArgumentNullException.ThrowIfNull(rights);

        string contentCanonicalHash = "sha256:" + ArticleCanonicalHashV1.ComputeHashHex(new ArticleCanonicalInput(
            ArticleId: articleId,
            ArticleRevisionId: revisionId,
            RevisionNo: revisionNo,
            PublicRouteKey: $"article:{articleId}",
            Title: title,
            Summary: summary,
            CoverImageUrl: coverImageUrl,
            CategoryId: categoryId,
            TagIds: tagIds,
            Status: (int)status,
            PublishedAt: publishedAt,
            ScheduledPublishAt: scheduledPublishAt,
            MarkdownContent: content));

        string policyHash = ArticleRightsCanonicalHashV1.ComputeHashHex(new ArticleRightsCanonicalInput(
            ArticleId: articleId,
            ArticleRevisionId: revisionId,
            RevisionNo: revisionNo,
            LicenseType: rights.LicenseType,
            CopyrightHolder: rights.CopyrightHolder,
            CopyrightYear: rights.CopyrightYear,
            RightsStatement: rights.RightsStatement,
            AttributionTemplate: rights.AttributionTemplate,
            CopyPolicy: rights.CopyPolicy,
            MaxExcerptChars: rights.MaxExcerptChars,
            AllowCodeCopy: rights.AllowCodeCopy,
            ShowPublicBadge: rights.ShowPublicBadge,
            CanonicalUrl: null,
            ContentCanonicalHash: contentCanonicalHash));

        if (contentCanonicalHash.Contains("recompute", StringComparison.OrdinalIgnoreCase)
            || policyHash.Contains("recompute", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("rights_recompute_sentinel_forbidden");
        }

        var snapshot = new ArticleRightsSnapshot
        {
            ArticleId = articleId,
            ArticleRevisionId = revisionId,
            RevisionNo = revisionNo,
            ArticleRightsPolicyId = policyId,
            Enabled = rights.Enabled,
            LicenseType = rights.LicenseType,
            CopyrightHolder = rights.CopyrightHolder,
            CopyrightYear = rights.CopyrightYear,
            RightsStatement = rights.RightsStatement,
            AttributionTemplate = rights.AttributionTemplate,
            CopyPolicy = rights.CopyPolicy,
            MaxExcerptChars = rights.MaxExcerptChars,
            AllowCodeCopy = rights.AllowCodeCopy,
            ShowPublicBadge = rights.ShowPublicBadge,
            ProofBindingEnabled = rights.ProofBindingEnabled,
            CanonicalUrl = null,
            PolicyHash = policyHash,
            ContentCanonicalHash = contentCanonicalHash,
            CreatedAt = createdAt
        };

        return (snapshot, contentCanonicalHash, policyHash);
    }
}
