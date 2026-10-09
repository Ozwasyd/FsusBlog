using System.Globalization;
using System.Text;

using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Shared.Contracts.ArticlePackages;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>Selected DTO coordinates and snapshot references, with an owned finite metadata candidate.</summary>
public sealed record ArticlePackageHistoricalMetadataProjection(
    long ArticleRevisionId,
    long RightsSnapshotId,
    long ResponsibilitySnapshotId,
    ArticlePackageManifestMetadataCandidate Metadata);

/// <summary>
/// Projects the original historical detail DTO through the sole metadata codec. The caller must
/// obtain the DTO through its original authorized reader; this mapper grants no source authority.
/// Lifecycle, route, canonical article bytes and permissions are not inferred from the DTO.
/// </summary>
public static class ArticlePackageHistoricalMetadataMapper
{
    public static ArticlePackageManifestCandidateResult TryMapCandidate(
        ArticleRevisionDetailResponse? revision,
        ArticlePackageManifestArticle? article,
        out ArticlePackageHistoricalMetadataProjection? projection)
    {
        projection = null;
        if (revision is null || article is null || article.Source is null
            || !TryId(revision.Id, out long revisionId)
            || revisionId != article.Source.ArticleRevisionId
            || revision.ArticleId != article.Source.ArticleId
            || revision.RevisionNo != article.Source.RevisionNo
            || !string.Equals(revision.Title, article.Title, StringComparison.Ordinal)
            || !string.Equals(revision.Summary, article.Summary, StringComparison.Ordinal)
            || !HasSameSourceBytes(revision.Content, article.SourceBytes))
        {
            return Invalid("article_package_historical_metadata_source_mismatch");
        }
        if (revision.Rights is null)
        {
            return Invalid("article_package_historical_rights_snapshot_missing");
        }
        if (revision.Responsibility is null)
        {
            return Invalid("article_package_historical_responsibility_snapshot_missing");
        }
        ArticleRevisionRightsSnapshotResponse rights = revision.Rights;
        ArticleRevisionResponsibilitySnapshotResponse responsibility = revision.Responsibility;
        if (!revision.PackageComplete || !TryId(rights.Id, out long rightsId)
            || !TryId(responsibility.Id, out long responsibilityId))
        {
            return Invalid("article_package_historical_metadata_snapshot_invalid");
        }
        var policy = new ArticleRightsRequestCoreModel(
            rights.Enabled, rights.LicenseType, rights.CopyrightHolder, rights.CopyrightYear,
            rights.RightsStatement, rights.AttributionTemplate, rights.CopyPolicy, rights.MaxExcerptChars,
            rights.AllowCodeCopy, rights.ShowPublicBadge, rights.ProofBindingEnabled);
        var canonical = new ArticleRightsCanonicalInput(
            revision.ArticleId, revisionId, revision.RevisionNo, rights.LicenseType,
            rights.CopyrightHolder, rights.CopyrightYear, rights.RightsStatement, rights.AttributionTemplate,
            rights.CopyPolicy, rights.MaxExcerptChars, rights.AllowCodeCopy, rights.ShowPublicBadge,
            rights.CanonicalUrl, rights.ContentCanonicalHash);
        var historicalResponsibility = new ArticlePackageManifestResponsibility(
            responsibility.ResponsibilityVersion, responsibility.InheritSiteAuthor,
            responsibility.Authors, responsibility.Reviewer, responsibility.Sources,
            responsibility.UpdateSummary, responsibility.UpdateReason, responsibility.EffectiveAt,
            responsibility.ConclusionImpact, responsibility.Methodology, responsibility.Applicability,
            responsibility.Limitations, responsibility.ResponsiblePersonConfirmed);
        ArticlePackageManifestCandidateResult result = ArticlePackageManifestCandidateCodec.TryCreateMetadataCandidate(
            new(article, policy, canonical, rights.PolicyHash, historicalResponsibility), out var metadata);
        if (result.IsValid)
        {
            projection = new(revisionId, rightsId, responsibilityId, metadata!);
        }
        return result;
    }

    private static bool TryId(string? text, out long value)
        => long.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out value)
            && value > 0 && string.Equals(text, value.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal);

    private static bool HasSameSourceBytes(string? content, ArticlePackageByteMetadata? metadata)
    {
        if (content is null || content.Length > ArticlePackageSourceBytes.MaximumByteLength)
        {
            return false;
        }
        try
        {
            var utf8 = new UTF8Encoding(false, true);
            return utf8.GetByteCount(content) <= ArticlePackageSourceBytes.MaximumByteLength
                && ArticlePackageSourceBytes.Validate(utf8.GetBytes(content), metadata).IsValid;
        }
        catch (EncoderFallbackException)
        {
            return false;
        }
    }

    private static ArticlePackageManifestCandidateResult Invalid(string reason) => new(false, reason);
}
