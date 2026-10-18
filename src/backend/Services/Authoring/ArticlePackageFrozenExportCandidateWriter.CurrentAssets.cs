using System.Security.Claims;

using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Shared.Contracts.ArticlePackages;

namespace FsusBlog.Server.Services.Authoring;

public static partial class ArticlePackageFrozenExportCandidateWriter
{
    /// <summary>
    /// Re-observes the original authorized current source and native upload bytes, binds every
    /// private asset record field to the backend's retained expected plan, and writes the finite
    /// archive through the original writer. Re-observes again before releasing the owned candidate.
    /// Neither the observation nor ZIP grants export/download/rights/retention or an atomic fence.
    /// No source, session, asset record, file reader or permission is manufactured here.
    /// </summary>
    public static async Task<(ArticlePackageManifestCandidateResult Result, ArticlePackageFrozenExportCandidate? Candidate)>
        ReadCurrentAssetsAndWriteCandidateAsync(
            ArticlePackageManifestCandidatePlan expected,
            IReadOnlyList<ArticlePackageManifestCandidateInput> articles,
            IReadOnlyList<ArticlePackageCurrentAssetRequest> requests,
            ClaimsPrincipal principal,
            IReadOnlyList<ArticlePackageInventoryEntry> inventory,
            IAuthoringArticleCurrentSourceReader sources,
            ArticlePackageCurrentAssetReader assets,
            IReadOnlyList<ArticlePackageFrozenExportCandidateInput> frozenInputs,
            CancellationToken cancellationToken = default,
            Action? requireCurrent = null)
    {
        try
        {
            RequireCurrent();
            if (expected is null || principal is null || !principal.TryGetAdminPrincipalId(out long adminId))
            {
                return (Invalid("article_package_export_current_asset_input_invalid"), null);
            }
            ArticlePackageManifestCandidateResult budget = CheckSnapshotBudget(expected, cancellationToken);
            if (!budget.IsValid)
            {
                return (budget, null);
            }
            ArticlePackageCurrentAssetPlanResult before = await ArticlePackageManifestCandidatePlanner.ReadCurrentAssetsAndBindCandidatePlanAsync(
                expected, articles, requests, principal, inventory, sources, assets, cancellationToken, requireCurrent).ConfigureAwait(false);
            if (!before.IsValid)
            {
                return (Invalid(before.ReasonCode!), null);
            }
            RequireCurrent();
            ArticlePackageManifestCandidateResult written = TryWriteCandidateToSnapshot(
                expected, before.Plan, articles, frozenInputs, out var candidate, cancellationToken);
            if (!written.IsValid)
            {
                return (written, null);
            }
            if (candidate!.SourceBindings.Any(binding => binding.UserId != adminId))
            {
                return (Invalid("article_package_export_source_binding_mismatch"), null);
            }
            // The archive remains private while the same original producer checks source,
            // permission, session, full ledger records and held native bytes after writing.
            RequireCurrent();
            ArticlePackageCurrentAssetPlanResult after = await ArticlePackageManifestCandidatePlanner.ReadCurrentAssetsAndBindCandidatePlanAsync(
                expected, articles, requests, principal, inventory, sources, assets, cancellationToken, requireCurrent).ConfigureAwait(false);
            if (!after.IsValid)
            {
                return (Invalid(after.ReasonCode!), null);
            }
            if (before.Observations is null || after.Observations is null
                || !before.Observations.SequenceEqual(after.Observations)
                || after.Plan!.Manifest.SemanticDigest != candidate.Candidate.Manifest.SemanticDigest)
            {
                return (Invalid("article_package_export_current_asset_observation_changed"), null);
            }
            cancellationToken.ThrowIfCancellationRequested();
            return (new(true, null), candidate);
        }
        catch (OperationCanceledException)
        {
            return (Invalid("article_package_export_cancelled"), null);
        }
        catch (Exception exception) when (exception is ArticlePackageCurrentAssetRejectedException
            or CurrentArticleUploadAssetObservationRejectedException)
        {
            // Exception diagnostics and upload credentials never enter candidate results.
            return (Invalid("article_package_export_current_asset_observation_rejected"), null);
        }
        catch (Exception)
        {
            return (Invalid("article_package_export_current_asset_input_invalid"), null);
        }

        void RequireCurrent()
        {
            cancellationToken.ThrowIfCancellationRequested();
            requireCurrent?.Invoke();
            cancellationToken.ThrowIfCancellationRequested();
        }
    }
}
