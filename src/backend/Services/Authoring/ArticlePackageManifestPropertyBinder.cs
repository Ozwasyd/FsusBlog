using FsusBlog.Shared.Contracts.ArticlePackages;
using FsusBlog.Shared.Contracts.ArticleProperties;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>Rebinds decoded rows through the existing mapper; supplied snapshots never establish persisted read authority.</summary>
public static class ArticlePackageManifestPropertyBinder
{
    public static ArticlePackageManifestCandidateResult TryBindCandidate(
        ArticlePackageManifestPropertyCandidate? candidate,
        ArticlePropertyValueSnapshot? snapshot,
        ArticlePackagePropertyMappingBindings? bindings,
        out ArticlePackageManifestPropertyCandidate? rebound)
    {
        rebound = null;
        if (candidate is null)
        {
            return new(false, "article_package_manifest_property_binding_mismatch");
        }
        ArticlePackagePropertyMappingResult validation = ArticlePackagePropertyMapper.ValidateCandidate(snapshot, bindings, candidate.Mapping);
        if (!validation.IsValid)
        {
            return new(false, validation.ReasonCode);
        }
        ArticlePackageManifestCandidateResult result = ArticlePackageManifestCandidateCodec.TryCreatePropertyCandidate(candidate.Mapping, out var owned);
        if (!result.IsValid || owned!.ComponentDigest != candidate.ComponentDigest)
        {
            return new(false, "article_package_manifest_property_binding_mismatch");
        }
        rebound = owned;
        return new(true, null);
    }
}
