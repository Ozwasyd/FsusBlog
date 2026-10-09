using System.Collections.Immutable;
using System.Security.Claims;

using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Shared.Contracts.ArticleVault;
using FsusBlog.Shared.Contracts.ArticleVault.Dependencies;

namespace FsusBlog.Server.Services.ArticleVault.Assets;

/// <summary>
/// Retains an original current upload observation and copied bytes after the canonical input
/// consistency check. Resource execution, reuse, accepted references and base commit remain separate.
/// </summary>
public sealed class ArticleVaultCurrentUploadAssetInput
{
    internal ArticleVaultCurrentUploadAssetInput(
        ArticleVaultCurrentUploadAssetObservation observation, ImmutableArray<byte> bytes)
    {
        Observation = observation;
        Bytes = bytes;
    }

    public ArticleVaultCurrentUploadAssetObservation Observation
    {
        get;
    }

    public ImmutableArray<byte> Bytes
    {
        get;
    }

    public bool CanExecute => false;
    public bool CanMaterialize => false;
    public bool CanUpload => false;
    public bool CanCommitBase => false;
}

/// <summary>
/// Connects the original current upload supplier to the sole asset input verifier. Current
/// dependency authorities are explicit inputs, never derived from bytes, article rights or a ledger.
/// No upload, storage read, writer, resource-rights policy or execution admission is added here.
/// </summary>
public sealed class ArticleVaultCurrentUploadAssetInputReader(
    IArticleVaultExecutionStore plans,
    ArticleVaultUploadAssetBindingReader uploads,
    TimeProvider timeProvider,
    string trustedVaultSiteIdentity)
{
    public async Task<ArticleVaultCurrentUploadAssetInput> ReadAsync(
        ArticleVaultOperationIdentity operation,
        ArticleVaultDependencyPlan dependencies,
        ArticleVaultPlanRequest currentRequest,
        IReadOnlyList<VaultDependencyPlanInput> currentDependencies,
        ArticleVaultUploadAssetReference reference,
        ClaimsPrincipal principal,
        UploadSessionAccess session,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(operation);
        ArgumentNullException.ThrowIfNull(dependencies);
        ArgumentNullException.ThrowIfNull(currentRequest);
        ArgumentNullException.ThrowIfNull(currentDependencies);
        ArgumentNullException.ThrowIfNull(reference);
        ArgumentNullException.ThrowIfNull(principal);
        cancellationToken.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(trustedVaultSiteIdentity)
            || operation.SiteIdentity != trustedVaultSiteIdentity
            || operation.PlanReference != reference.PlanReference || operation.PlanSha256 != reference.PlanSha256)
        {
            throw Rejected("plan_context_mismatch");
        }

        ArticleVaultSealedExecutionBundle bundle = await plans.LoadSealedAsync(
            operation.PlanReference, operation.PlanSha256, cancellationToken).ConfigureAwait(false)
            ?? throw Rejected("plan_missing");
        cancellationToken.ThrowIfCancellationRequested();
        ArticleVaultExecutionIntegrity.ValidateBundle(bundle);
        Require(ArticleVaultOperationVerifier.ValidateIdentity(operation, bundle.Plan));
        if (bundle.PlanReference != operation.PlanReference || bundle.PlanSha256 != operation.PlanSha256
            || principal.Identity?.IsAuthenticated != true || !principal.IsAdminPrincipal()
            || !principal.TryGetAdminPrincipalId(out long adminId) || adminId != bundle.AdminPrincipalId
            || session.OwnerAdminPrincipalId != adminId)
        {
            throw Rejected("principal_or_plan_mismatch");
        }
        RequireCurrent();
        VaultSyncPlanGroup group = bundle.Plan.Groups.SingleOrDefault(value => value.GroupIdentity == reference.GroupIdentity)
            ?? throw Rejected("group_missing");
        VaultSyncPlanItem item = group.Items.SingleOrDefault(value => value.OperationIdentity == reference.OperationIdentity)
            ?? throw Rejected("item_missing");
        VaultDependencyPlanItem dependency = dependencies.Items.Single(value => value.OperationIdentity == item.OperationIdentity);
        if (item.Decision is not (VaultSyncDecision.PullCreate or VaultSyncDecision.PullUpdate)
            || dependency.Manifest.SourceSide != VaultDependencySourceSide.Server)
        {
            throw Rejected("current_server_source_required");
        }
        VaultAssetDependency asset = dependency.Manifest.Nodes.OfType<VaultAssetDependency>()
            .SingleOrDefault(value => value.AssetIdentity == reference.AssetId.Value)
            ?? throw Rejected("asset_not_planned");

        (ArticleVaultCurrentUploadAssetObservation observation, ReadOnlyMemory<byte> suppliedBytes) =
            await uploads.ReadCurrentRevisionUploadInputAsync(reference, principal, session,
                asset.ContentSha256, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (suppliedBytes.Length != asset.SizeBytes)
        {
            throw new ArticleVaultExecutionRejectedException("article_vault_asset_size_mismatch");
        }
        ImmutableArray<byte> bytes = ImmutableArray.CreateRange(suppliedBytes.ToArray());
        Require(ArticleVaultAssetInputVerifier.VerifyCurrent(operation, bundle, dependencies, currentRequest,
            currentDependencies, principal, trustedVaultSiteIdentity, item.OperationIdentity, reference.AssetId.Value,
            observation.Asset, bytes.AsSpan(), timeProvider, cancellationToken));
        RequireCurrent();
        return new(observation, bytes);

        void RequireCurrent()
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (principal.Identity?.IsAuthenticated != true || !principal.IsAdminPrincipal()
                || !principal.TryGetAdminPrincipalId(out long currentAdminId) || currentAdminId != adminId)
            {
                throw Rejected("principal_or_plan_mismatch");
            }
            long now = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
            if (now > operation.DeadlineUnixMs)
            {
                throw Rejected("deadline_expired");
            }
            Require(ArticleVaultDependencyPlanner.VerifyCurrent(dependencies, bundle.Plan, currentRequest,
                new(now, bundle.Plan.Direction, currentRequest.CancellationRequested), currentDependencies,
                dependencies.Budgets, timeProvider));
        }
    }

    private static void Require(ArticleVaultValidationResult result)
    {
        if (!result.IsValid)
        {
            throw new ArticleVaultExecutionRejectedException(result.ReasonCode!);
        }
    }

    private static ArticleVaultExecutionRejectedException Rejected(string reason)
        => new("article_vault_current_upload_input_" + reason);
}
