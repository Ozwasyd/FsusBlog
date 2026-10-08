using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;
using FsusBlog.Shared.Contracts.ArticleVault;
using FsusBlog.Shared.Contracts.ArticleVault.Dependencies;

namespace FsusBlog.Server.Services.ArticleVault;

/// <summary>
/// Zero-write dependency admission for the existing executor's sealed bundle.
/// This gate does not execute stages, reparse source, create a writer or mark a base synced.
/// Runtime integration must remain in the canonical executor once stage authorities exist.
/// </summary>
public static class ArticleVaultDependencyExecutionPreflight
{
    public static ArticleVaultValidationResult Verify(
        ArticleVaultSealedExecutionBundle? bundle,
        ArticleVaultDependencyPlan? dependencies,
        ArticleVaultPlanRequest request,
        ArticleVaultPlanVerificationContext context,
        IReadOnlyList<VaultDependencyPlanInput> currentInputs,
        ArticleEmbedResolutionBudgetLimits budgets,
        TimeProvider? timeProvider = null)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(currentInputs);
        try
        {
            ArticleVaultExecutionIntegrity.ValidateBundle(bundle);
        }
        catch (ArticleVaultExecutionRejectedException exception)
        {
            return ArticleVaultValidationResult.Invalid(exception.ReasonCode);
        }

        if (bundle!.RootManifest.ContentSha256 != request.RootManifest.ContentSha256
            || bundle.ArticleManifests.Count != request.ArticleManifests.Count
            || bundle.PlannedObservations.Count != request.ServerObservations.Count
            || !bundle.ArticleManifests.Select(static article => article.ContentSha256)
                .Order(StringComparer.Ordinal).SequenceEqual(request.ArticleManifests
                    .Select(static article => article.ContentSha256).Order(StringComparer.Ordinal), StringComparer.Ordinal)
            || !bundle.PlannedObservations.Select(static observation => observation.ContentSha256)
                .Order(StringComparer.Ordinal).SequenceEqual(request.ServerObservations
                    .Select(static observation => observation.ContentSha256).Order(StringComparer.Ordinal), StringComparer.Ordinal))
        {
            return ArticleVaultValidationResult.Invalid("article_vault_dependency_bundle_binding_mismatch");
        }

        ArticleVaultValidationResult bundleInputs = ArticleVaultSyncPlanVerifier.VerifyCurrent(
            bundle.Plan, bundle.RootManifest, bundle.ArticleManifests, bundle.PlannedObservations, context);
        if (!bundleInputs.IsValid)
        {
            return bundleInputs;
        }

        return ArticleVaultDependencyPlanner.VerifyCurrent(dependencies, bundle.Plan, request,
            context, currentInputs, budgets, timeProvider);
    }
}
