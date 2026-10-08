using System.Collections.Immutable;

using FsusBlog.Core.Common;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Shared.Contracts.ArticleVault;
using FsusBlog.Shared.Contracts.ArticleVault.Dependencies;

namespace FsusBlog.Server.Services.ArticleVault.Assets;

/// <summary>
/// Combines the actual immutable execution store, canonical operation/current dependency verifiers
/// and original upload authority. It prepares a deterministic observation handoff without another
/// store, uploader, permission authority or materializer. Composition supplies trusted site and
/// current canonical observations; the handoff never authorizes a later business write.
/// </summary>
public sealed class ArticleVaultAssetStagingAdapter
{
    private readonly IArticleVaultExecutionStore _store;
    private readonly ArticleVaultCommittedUploadObserver _uploads;
    private readonly TimeProvider _time;
    private readonly string _trustedSiteIdentity;

    public ArticleVaultAssetStagingAdapter(
        IArticleVaultExecutionStore store,
        IFileService files,
        TimeProvider time,
        string trustedSiteIdentity)
    {
        ArgumentNullException.ThrowIfNull(store);
        ArgumentNullException.ThrowIfNull(files);
        ArgumentNullException.ThrowIfNull(time);
        ArgumentException.ThrowIfNullOrWhiteSpace(trustedSiteIdentity);
        _store = store;
        _uploads = new(files);
        _time = time;
        _trustedSiteIdentity = trustedSiteIdentity;
    }

    /// <summary>
    /// Selects only the named plan item and AssetId. Identical retries reread the same original
    /// session and produce identical bytes while its current facts are unchanged. Cancellation
    /// returns no handoff; the adapter never rolls back a committed upload or advances a base.
    /// </summary>
    public async Task<Result<ArticleVaultAssetUploadHandoff>> PrepareCommittedUploadAsync(
        ArticleVaultOperationIdentity operation,
        ArticleVaultDependencyPlan dependencies,
        ArticleVaultPlanRequest currentRequest,
        IReadOnlyList<VaultDependencyPlanInput> currentDependencies,
        string itemOperationIdentity,
        Guid assetIdentity,
        UploadSessionAccess access,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (operation is null || dependencies is null || currentRequest is null || currentDependencies is null
            || operation.SiteIdentity != _trustedSiteIdentity || assetIdentity == Guid.Empty
            || string.IsNullOrWhiteSpace(itemOperationIdentity))
        {
            return Rejected("article_vault_asset_stage_binding_invalid");
        }

        ArticleVaultSealedExecutionBundle? bundle = await _store.LoadSealedAsync(
            operation.PlanReference, operation.PlanSha256, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (bundle is null)
        {
            return Rejected("article_vault_asset_stage_plan_missing");
        }
        ArticleVaultExecutionIntegrity.ValidateBundle(bundle);
        ArticleVaultValidationResult binding = ArticleVaultOperationVerifier.ValidateIdentity(operation, bundle.Plan);
        if (!binding.IsValid)
        {
            return Rejected(binding.ReasonCode!);
        }
        if (bundle.PlanReference != operation.PlanReference || bundle.PlanSha256 != operation.PlanSha256
            || bundle.Plan.SiteIdentity != _trustedSiteIdentity || access.OwnerAdminPrincipalId != bundle.AdminPrincipalId)
        {
            return Rejected("article_vault_asset_stage_principal_or_plan_mismatch");
        }
        ArticleVaultValidationResult current = VerifyCurrent(operation, dependencies, bundle, currentRequest, currentDependencies);
        if (!current.IsValid)
        {
            return Rejected(current.ReasonCode!);
        }

        // Freeze the existing extension before an asynchronous authority read can yield.
        ArticleVaultDependencyPlan frozen = PortableDependencyCodec.DeserializePlan(PortableDependencyCodec.Serialize(dependencies));
        VaultDependencyPlanItem? dependencyItem = frozen.Items.SingleOrDefault(item => item.OperationIdentity == itemOperationIdentity);
        VaultSyncPlanItem? planItem = bundle.Plan.Groups.SelectMany(static group => group.Items)
            .SingleOrDefault(item => item.OperationIdentity == itemOperationIdentity);
        if (dependencyItem is null || planItem is null
            || planItem.Decision is not (VaultSyncDecision.PushCreate or VaultSyncDecision.PushUpdate))
        {
            return Rejected("article_vault_asset_stage_push_item_missing");
        }
        VaultAssetDependency? asset = dependencyItem.Manifest.Nodes.OfType<VaultAssetDependency>()
            .SingleOrDefault(node => node.AssetIdentity == assetIdentity);
        if (asset is null)
        {
            return Rejected("article_vault_asset_stage_asset_not_planned");
        }

        Result<UploadAssetObservation> observed = await _uploads.ObserveAsync(access, asset, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (observed.IsFailure)
        {
            return Result<ArticleVaultAssetUploadHandoff>.Failure(observed.Error);
        }
        current = VerifyCurrent(operation, dependencies, bundle, currentRequest, currentDependencies);
        if (!current.IsValid || dependencies.ContentSha256 != frozen.ContentSha256)
        {
            return Rejected(current.ReasonCode ?? "article_vault_asset_stage_dependency_drift");
        }
        UploadAssetObservation snapshot = observed.Value! with
        {
            References = observed.Value.References.ToImmutableArray()
        };
        ArticleVaultAssetUploadHandoff handoff = new(operation, frozen.ContentSha256,
            dependencyItem.GroupIdentity, dependencyItem.OperationIdentity, dependencyItem.PortableArticleIdentity,
            dependencyItem.Manifest.Source.Sha256, asset, snapshot, string.Empty, string.Empty);
        handoff = handoff with
        {
            PreparationIdentity = ArticleVaultAssetUploadHandoffCodec.ComputePreparationIdentity(handoff)
        };
        cancellationToken.ThrowIfCancellationRequested();
        return Result<ArticleVaultAssetUploadHandoff>.Success(handoff with
        {
            ContentSha256 = ArticleVaultAssetUploadHandoffCodec.ComputeContentSha256(handoff)
        });
    }

    /// <summary>
    /// Reacquires actual store/upload facts and rechecks supplied current dependency inputs; a sealed handoff alone
    /// cannot survive changed bytes, ownership, permission or ledger references. This remains
    /// pre-execution preparation revalidation. Acceptance can legitimately change the server
    /// coordinate and reference ledger; this method does not admit those post-acceptance changes
    /// or provide native materialization or synchronized-base admission.
    /// </summary>
    public async Task<Result<ArticleVaultAssetUploadHandoff>> RevalidateAsync(
        ArticleVaultAssetUploadHandoff handoff,
        ArticleVaultDependencyPlan dependencies,
        ArticleVaultPlanRequest currentRequest,
        IReadOnlyList<VaultDependencyPlanInput> currentDependencies,
        UploadSessionAccess access,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (handoff is null || handoff.Operation is null || handoff.Asset is null || handoff.Observation is null
            || handoff.PreparationIdentity != ArticleVaultAssetUploadHandoffCodec.ComputePreparationIdentity(handoff)
            || handoff.ContentSha256 != ArticleVaultAssetUploadHandoffCodec.ComputeContentSha256(handoff))
        {
            return Rejected("article_vault_asset_stage_handoff_tampered");
        }
        Result<ArticleVaultAssetUploadHandoff> current = await PrepareCommittedUploadAsync(handoff.Operation,
            dependencies, currentRequest, currentDependencies, handoff.ItemOperationIdentity, handoff.Asset.AssetIdentity,
            access, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        return current.IsFailure || current.Value!.ContentSha256 == handoff.ContentSha256
            ? current
            : Rejected("article_vault_asset_stage_observation_drift");
    }

    private ArticleVaultValidationResult VerifyCurrent(
        ArticleVaultOperationIdentity operation,
        ArticleVaultDependencyPlan dependencies,
        ArticleVaultSealedExecutionBundle bundle,
        ArticleVaultPlanRequest request,
        IReadOnlyList<VaultDependencyPlanInput> inputs)
    {
        long now = _time.GetUtcNow().ToUnixTimeMilliseconds();
        return now > operation.DeadlineUnixMs
            ? ArticleVaultValidationResult.Invalid("article_vault_asset_stage_deadline_expired")
            : ArticleVaultDependencyPlanner.VerifyCurrent(dependencies, bundle.Plan, request,
                new(now, bundle.Plan.Direction, request.CancellationRequested), inputs, dependencies.Budgets, _time);
    }

    private static Result<ArticleVaultAssetUploadHandoff> Rejected(string reasonCode)
        => Result<ArticleVaultAssetUploadHandoff>.Failure(ErrorCode.Conflict, reasonCode);
}
