using FsusBlog.Shared.Contracts.ArticlePackages;
using FsusBlog.Shared.Contracts.ArticleProperties;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>Supplied typed mapping inputs for one exact manifest article; never store observations.</summary>
public sealed record ArticlePackageImportResolutionPropertyInput(
    ArticlePackageIdentity PortableArticle,
    ArticlePropertyValueSnapshot Snapshot,
    ArticlePackagePropertyMappingBindings Bindings,
    ArticlePackagePropertyMappingCandidate Mapping);

/// <summary>
/// Unconnected preparation adapter. Reuses the canonical typed mapper, candidate planner and
/// review projection without definition commands, target readers, issuers, grants or execution.
/// </summary>
public static class ArticlePackageImportResolutionPreparation
{
    /// <summary>
    /// Validates every supplied article's existing typed mapping before freezing resolution intent.
    /// This verifies finite candidate consistency only; no current target/creation facts are observed.
    /// </summary>
    public static ArticlePackageManifestCandidateResult TryPrepare(
        ArticlePackageImportCandidatePlan? oldPlan,
        ArticlePackageImportCandidateRequest? originalRequest,
        ArticlePackageImportCandidateRequest? replacementRequest,
        ArticlePackageImportResolutionBinding? binding,
        IReadOnlyList<ArticlePackageImportResolutionItem>? items,
        IReadOnlyList<ArticlePackageImportResolutionChoice>? choices,
        IReadOnlyList<ArticlePackageImportResolutionPropertyInput>? propertyInputs,
        DateTime nowUtc,
        out ArticlePackageImportResolutionProposal? proposal,
        CancellationToken cancellationToken = default)
    {
        proposal = null;
        if (cancellationToken.IsCancellationRequested)
        {
            return Invalid("article_package_resolution_cancelled");
        }
        if (oldPlan is null || propertyInputs is null)
        {
            return Invalid("article_package_resolution_property_inputs_required");
        }
        try
        {
            IReadOnlyList<ArticlePackageManifestArticle> articles = oldPlan.Candidate.Manifest.Articles;
            int count = propertyInputs.Count;
            if (count != articles.Count || count is < 1 or > ArticlePackageImportCandidatePlanner.MaxArticles)
            {
                return Invalid("article_package_resolution_property_closure_mismatch");
            }
            var inputs = new Dictionary<ArticlePackageIdentity, ArticlePackageImportResolutionPropertyInput>();
            for (int index = 0; index < count; index++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                ArticlePackageImportResolutionPropertyInput? input = propertyInputs[index];
                if (input is null || !inputs.TryAdd(input.PortableArticle, input))
                {
                    return Invalid("article_package_resolution_property_closure_mismatch");
                }
            }
            foreach (ArticlePackageManifestArticle article in articles)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (!inputs.TryGetValue(article.PortableArticle, out ArticlePackageImportResolutionPropertyInput? input)
                    || input.Snapshot is null || input.Mapping is null
                    || input.Snapshot.ContentDigest != article.PropertySnapshotDigest
                    || input.Mapping.MappingDigest != article.PropertyMappingDigest
                    || input.Snapshot.Coordinates.ArticleId != article.Source.ArticleId
                    || input.Snapshot.Coordinates.ArticleRevisionId != article.Source.ArticleRevisionId
                    || input.Snapshot.Coordinates.PropertyRevision != article.Source.PropertyRevision
                    || input.Snapshot.Coordinates.SiteScope != article.Source.SiteScope
                    || input.Snapshot.Coordinates.DraftId != article.Source.DraftId
                    || input.Snapshot.Coordinates.DraftServerRevision != article.Source.DraftServerRevision
                    || input.Snapshot.Coordinates.PublicationId != article.Source.PublicationId)
                {
                    return Invalid("article_package_resolution_property_source_mismatch");
                }
                ArticlePackagePropertyMappingResult result = ArticlePackagePropertyMapper.ValidateCandidate(
                    input.Snapshot, input.Bindings, input.Mapping);
                if (!result.IsValid)
                {
                    return Invalid("article_package_resolution_property_mapping_invalid");
                }
            }
            return ArticlePackageImportResolutionPlanner.TryPrepare(oldPlan, originalRequest, replacementRequest,
                binding, items, choices, nowUtc, out proposal, cancellationToken);
        }
        catch (OperationCanceledException)
        {
            return Invalid("article_package_resolution_cancelled");
        }
        catch (Exception)
        {
            // Caller providers must not leak source values through their exceptions or partial output.
            return Invalid("article_package_resolution_property_inputs_invalid");
        }
    }

    /// <summary>The existing paginated read model retains its unconditional execution refusal.</summary>
    public static ArticlePackageManifestCandidateResult TryProjectCandidate(
        ArticlePackageImportResolutionProposal? proposal,
        int pageIndex,
        int pageSize,
        DateTime nowUtc,
        out ArticlePackageCandidateReview? review)
        => ArticlePackageImportCandidateReviewProjection.TryProject(
            proposal?.NewCandidate, pageIndex, pageSize, nowUtc, out review);

    private static ArticlePackageManifestCandidateResult Invalid(string reason) => new(false, reason);
}
