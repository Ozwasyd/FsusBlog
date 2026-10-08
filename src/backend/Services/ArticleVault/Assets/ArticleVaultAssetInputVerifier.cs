using System.Security.Claims;

using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Shared.Contracts.ArticleVault;
using FsusBlog.Shared.Contracts.ArticleVault.Dependencies;

namespace FsusBlog.Server.Services.ArticleVault.Assets;

/// <summary>
/// Binds supplied asset bytes and an original AssetRecord to one exact current plan item.
/// This is input consistency validation only: the original supplier must acquire the record,
/// bytes, source revision and current dependency rights through its genuine authorized APIs.
/// No private read, ticket, upload/reuse receipt, native grant or base admission is inferred.
/// </summary>
public static class ArticleVaultAssetInputVerifier
{
    /// <summary>
    /// The caller loads the bundle through IArticleVaultExecutionStore.LoadSealedAsync, passes
    /// its authenticated principal and supplies fresh canonical current inputs. No IO is performed.
    /// A valid result does not establish asset acquisition or authorize a later business write.
    /// </summary>
    public static ArticleVaultValidationResult VerifyCurrent(
        ArticleVaultOperationIdentity operation,
        ArticleVaultSealedExecutionBundle bundle,
        ArticleVaultDependencyPlan dependencies,
        ArticleVaultPlanRequest currentRequest,
        IReadOnlyList<VaultDependencyPlanInput> currentDependencies,
        ClaimsPrincipal principal,
        string trustedSiteIdentity,
        string itemOperationIdentity,
        Guid assetIdentity,
        AssetRecord? record,
        ReadOnlySpan<byte> assetBytes,
        TimeProvider time,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (operation is null || bundle is null || dependencies is null || currentRequest is null
            || currentDependencies is null || time is null || string.IsNullOrWhiteSpace(trustedSiteIdentity)
            || operation.SiteIdentity != trustedSiteIdentity || assetIdentity == Guid.Empty
            || string.IsNullOrWhiteSpace(itemOperationIdentity))
        {
            return Rejected("binding_invalid");
        }
        if (principal?.Identity?.IsAuthenticated != true || !principal.IsAdminPrincipal()
            || !principal.TryGetAdminPrincipalId(out long adminPrincipalId)
            || adminPrincipalId != bundle.AdminPrincipalId)
        {
            return Rejected("principal_mismatch");
        }
        ArticleVaultExecutionIntegrity.ValidateBundle(bundle);
        ArticleVaultValidationResult identity = ArticleVaultOperationVerifier.ValidateIdentity(operation, bundle.Plan);
        if (!identity.IsValid)
        {
            return identity;
        }
        if (bundle.PlanReference != operation.PlanReference || bundle.PlanSha256 != operation.PlanSha256
            || bundle.Plan.SiteIdentity != trustedSiteIdentity)
        {
            return Rejected("plan_mismatch");
        }
        long now = time.GetUtcNow().ToUnixTimeMilliseconds();
        if (now > operation.DeadlineUnixMs)
        {
            return Rejected("deadline_expired");
        }
        ArticleVaultValidationResult current = ArticleVaultDependencyPlanner.VerifyCurrent(dependencies,
            bundle.Plan, currentRequest, new(now, bundle.Plan.Direction, currentRequest.CancellationRequested),
            currentDependencies, dependencies.Budgets, time);
        cancellationToken.ThrowIfCancellationRequested();
        if (!current.IsValid)
        {
            return current;
        }
        VaultSyncPlanItem? planItem = bundle.Plan.Groups.SelectMany(static group => group.Items)
            .SingleOrDefault(item => item.OperationIdentity == itemOperationIdentity);
        VaultDependencyPlanItem? dependencyItem = dependencies.Items.SingleOrDefault(
            item => item.OperationIdentity == itemOperationIdentity);
        if (planItem is null || dependencyItem is null
            || planItem.Decision is not (VaultSyncDecision.PullCreate or VaultSyncDecision.PullUpdate
                or VaultSyncDecision.PushCreate or VaultSyncDecision.PushUpdate))
        {
            return Rejected("content_item_missing");
        }
        VaultAssetDependency? asset = dependencyItem.Manifest.Nodes.OfType<VaultAssetDependency>()
            .SingleOrDefault(node => node.AssetIdentity == assetIdentity);
        if (asset is null)
        {
            return Rejected("asset_not_planned");
        }
        ArticleVaultAssetValidationResult metadata = ArticleVaultAssetValidator.ValidateRecord(
            AssetId.FromGuid(assetIdentity), record);
        if (!metadata.IsValid)
        {
            return ArticleVaultValidationResult.Invalid(metadata.ReasonCode!);
        }
        if (!string.Equals(record!.Sha256, asset.ContentSha256, StringComparison.OrdinalIgnoreCase)
            || record.MimeType != asset.MimeType || record.Extension != asset.Extension
            || record.SizeBytes != asset.SizeBytes || record.WidthPixels != asset.WidthPixels
            || record.HeightPixels != asset.HeightPixels || record.OwnerAdminPrincipalId != asset.OwnerAdminPrincipalId)
        {
            return Rejected("asset_metadata_drift");
        }
        if (assetBytes.Length != asset.SizeBytes)
        {
            return ArticleVaultValidationResult.Invalid("article_vault_asset_size_mismatch");
        }
        ArticleVaultAssetValidationResult bytes = ArticleVaultAssetValidator.ValidateBytes(record.Id, record, assetBytes);
        cancellationToken.ThrowIfCancellationRequested();
        if (!bytes.IsValid)
        {
            return ArticleVaultValidationResult.Invalid(bytes.ReasonCode!);
        }
        now = time.GetUtcNow().ToUnixTimeMilliseconds();
        if (now > operation.DeadlineUnixMs)
        {
            return Rejected("deadline_expired");
        }
        current = ArticleVaultDependencyPlanner.VerifyCurrent(dependencies, bundle.Plan, currentRequest,
            new(now, bundle.Plan.Direction, currentRequest.CancellationRequested), currentDependencies,
            dependencies.Budgets, time);
        cancellationToken.ThrowIfCancellationRequested();
        return current;
    }

    private static ArticleVaultValidationResult Rejected(string reasonCode)
        => ArticleVaultValidationResult.Invalid("article_vault_asset_input_" + reasonCode);
}
