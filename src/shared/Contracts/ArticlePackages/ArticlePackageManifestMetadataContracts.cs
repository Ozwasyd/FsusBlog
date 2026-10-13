using FsusBlog.Contracts.Articles;

namespace FsusBlog.Shared.Contracts.ArticlePackages;

/// <summary>Explicit historical responsibility values, without person resolution or confirmation authority.</summary>
public sealed record ArticlePackageManifestResponsibility(
    int ResponsibilityVersion,
    bool InheritSiteAuthor,
    IReadOnlyList<ArticleResponsiblePerson> Authors,
    ArticleResponsiblePerson? Reviewer,
    IReadOnlyList<ArticleEvidenceSource> Sources,
    string? UpdateSummary,
    string? UpdateReason,
    DateTime? EffectiveAt,
    string? ConclusionImpact,
    string? Methodology,
    string? Applicability,
    string? Limitations,
    bool ResponsiblePersonConfirmed);

/// <summary>Closed supplied policy fields and canonical bindings; no persisted snapshot or privacy grant.</summary>
public sealed record ArticlePackageManifestMetadataInput(
    ArticlePackageManifestArticle Article,
    ArticleRightsRequestCoreModel Rights,
    ArticleRightsCanonicalInput CanonicalRights,
    string RightsPolicyHash,
    ArticlePackageManifestResponsibility Responsibility);

/// <summary>
/// Owned metadata component of the sole manifest codec. This is not a second package envelope,
/// complete V1 manifest, export permission, persisted observation or executable import plan.
/// </summary>
public sealed class ArticlePackageManifestMetadataCandidate
{
    internal ArticlePackageManifestMetadataCandidate(ArticlePackageManifestMetadataInput input, string componentDigest)
    {
        Input = input;
        ComponentDigest = componentDigest;
    }

    public ArticlePackageManifestMetadataInput Input
    {
        get;
    }
    public string ComponentDigest
    {
        get;
    }

    public ArticlePackageManifestCandidateResult RequireMetadataAuthority()
        => new(false, "article_package_manifest_metadata_source_authority_unavailable");
}
