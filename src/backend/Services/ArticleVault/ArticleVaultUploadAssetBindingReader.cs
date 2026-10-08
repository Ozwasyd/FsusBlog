using System.Globalization;
using System.Security.Claims;

using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Services.ArticleVault;

/// <summary>References original objects; none of these caller values supplies a permission grant.</summary>
public sealed record ArticleVaultUploadAssetReference(
    string PlanReference,
    string PlanSha256,
    string GroupIdentity,
    string OperationIdentity,
    AssetId AssetId);

/// <summary>
/// A read-only observation of an owned committed upload already referenced by the selected current
/// revision. Explicit plan asset membership and resource-operation authorization remain separate.
/// This is not a pull/materialization, upload, reference mutation or Vault execution receipt.
/// </summary>
public sealed record ArticleVaultCurrentUploadAssetObservation(
    string Schema,
    int SchemaVersion,
    ArticleVaultUploadAssetReference Reference,
    string SiteIdentity,
    string VaultIdentity,
    string DeviceIdentity,
    string PortableArticleIdentity,
    string ServerArticleIdentity,
    int ArticleId,
    long SourceRevision,
    string SourceSha256,
    long AdminPrincipalId,
    string ArticlePermissionScope,
    string ArticlePermissionSha256,
    string VaultPermissionSha256,
    string RightsBoundarySha256,
    string PublicationBoundarySha256,
    AssetRecord Asset,
    string UploadId,
    string AssetVersionSha256,
    string ReferenceLedgerSha256,
    string RevisionReferenceSourceKey,
    string ContentSha256)
{
    public bool CanExecute => false;
    public bool CanMaterialize => false;
    public bool CanUpload => false;
    public bool CanCommitBase => false;
}

/// <summary>
/// Reuses original sealed-plan, complete-group, current article-read and upload/ledger authorities.
/// It creates no store, ticket purpose, byte converter, permission policy or resource plan.
/// </summary>
public sealed class ArticleVaultUploadAssetBindingReader(
    IArticleVaultExecutionStore plans,
    IArticleVaultCurrentObservationAuthority observations,
    IAuthoringArticleCurrentSourceReader sources,
    IFileService files,
    TimeProvider timeProvider,
    string trustedVaultSiteIdentity)
{
    private readonly CurrentArticleUploadAssetBindingReader _assets = new(sources, files);

    public async Task<ArticleVaultCurrentUploadAssetObservation> ObserveCurrentRevisionUploadAsync(
        ArticleVaultUploadAssetReference reference,
        ClaimsPrincipal principal,
        UploadSessionAccess session,
        string sha256,
        CancellationToken cancellationToken = default)
        => (await ReadCurrentRevisionUploadAsync(reference, principal, session, sha256, false,
            cancellationToken).ConfigureAwait(false)).Observation;

    /// <summary>
    /// Returns the original owned upload bytes for the canonical asset input verifier. Selected
    /// dependency membership and current resource rights remain the original root's admission.
    /// </summary>
    public Task<(ArticleVaultCurrentUploadAssetObservation Observation, ReadOnlyMemory<byte> Bytes)> ReadCurrentRevisionUploadInputAsync(
        ArticleVaultUploadAssetReference reference,
        ClaimsPrincipal principal,
        UploadSessionAccess session,
        string sha256,
        CancellationToken cancellationToken = default)
        => ReadCurrentRevisionUploadAsync(reference, principal, session, sha256, true, cancellationToken);

    private async Task<(ArticleVaultCurrentUploadAssetObservation Observation, ReadOnlyMemory<byte> Bytes)> ReadCurrentRevisionUploadAsync(
        ArticleVaultUploadAssetReference reference,
        ClaimsPrincipal principal,
        UploadSessionAccess session,
        string sha256,
        bool includeBytes,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(reference);
        ArgumentNullException.ThrowIfNull(principal);
        cancellationToken.ThrowIfCancellationRequested();
        if (principal.Identity?.IsAuthenticated != true || !principal.IsAdminPrincipal()
            || !principal.TryGetAdminPrincipalId(out long adminId) || adminId != session.OwnerAdminPrincipalId
            || !Opaque(reference.PlanReference) || !Digest(reference.PlanSha256)
            || !Opaque(reference.GroupIdentity) || !Opaque(reference.OperationIdentity)
            || reference.AssetId.Value == Guid.Empty || !Digest(sha256)
            || string.IsNullOrWhiteSpace(trustedVaultSiteIdentity))
        {
            throw Rejected("input_invalid");
        }

        ArticleVaultSealedExecutionBundle bundle = await plans.LoadSealedAsync(
            reference.PlanReference, reference.PlanSha256, cancellationToken).ConfigureAwait(false)
            ?? throw Rejected("plan_missing");
        ArticleVaultExecutionIntegrity.ValidateBundle(bundle);
        if (bundle.PlanReference != reference.PlanReference || bundle.PlanSha256 != reference.PlanSha256
            || bundle.AdminPrincipalId != adminId || bundle.Plan.SiteIdentity != trustedVaultSiteIdentity)
        {
            throw Rejected("plan_context_mismatch");
        }
        RequireLifetime(bundle, cancellationToken);
        VaultSyncPlanGroup group = bundle.Plan.Groups.SingleOrDefault(value => value.GroupIdentity == reference.GroupIdentity)
            ?? throw Rejected("group_missing");
        VaultSyncPlanItem item = group.Items.SingleOrDefault(value => value.OperationIdentity == reference.OperationIdentity)
            ?? throw Rejected("operation_missing");
        if (!int.TryParse(item.ServerArticleIdentity, NumberStyles.None, CultureInfo.InvariantCulture, out int articleId)
            || articleId <= 0 || !item.Server.Present || item.Server.Deleted
            || item.Server.ServerRevision is not > 0 || item.Server.Source is null)
        {
            throw Rejected("current_revision_missing");
        }

        ArticleVaultCurrentArticleObservation[] before = (await observations.ObserveGroupAsync(
            bundle, group, cancellationToken).ConfigureAwait(false)).ToArray();
        ArticleVaultSyncPlanExecutor.ValidateCurrentObservations(group, before);
        CurrentArticleUploadAssetObservation asset;
        ReadOnlyMemory<byte> bytes = default;
        try
        {
            var source = new CurrentArticleUploadAssetReference(articleId, item.Server.ServerRevision.Value,
                item.Server.Source.Sha256, reference.AssetId);
            if (includeBytes)
            {
                (asset, bytes) = await _assets.ReadCurrentRevisionInputAsync(source, principal, session, sha256,
                    cancellationToken, () => RequireLifetime(bundle, cancellationToken)).ConfigureAwait(false);
            }
            else
            {
                asset = await _assets.ObserveCurrentRevisionAsync(source, principal, session, sha256,
                    cancellationToken, () => RequireLifetime(bundle, cancellationToken)).ConfigureAwait(false);
            }
        }
        catch (CurrentArticleUploadAssetObservationRejectedException exception)
        {
            throw Rejected(exception.ReasonCode);
        }
        if (asset.Source != item.Server.Source)
        {
            throw Rejected("source_unavailable_or_changed");
        }
        ArticleVaultCurrentArticleObservation[] after = (await observations.ObserveGroupAsync(
            bundle, group, cancellationToken).ConfigureAwait(false)).ToArray();
        ArticleVaultSyncPlanExecutor.ValidateCurrentObservations(group, after);
        RequireLifetime(bundle, cancellationToken);
        ArticleVaultExecutionIntegrity.ValidateBundle(bundle);
        if (!before.SequenceEqual(after) || principal.Identity?.IsAuthenticated != true || !principal.IsAdminPrincipal()
            || !principal.TryGetAdminPrincipalId(out long currentAdminId) || currentAdminId != adminId)
        {
            throw Rejected("current_facts_changed");
        }
        ArticleVaultCurrentArticleObservation current = after[Array.IndexOf(group.Items.ToArray(), item)];
        var unsigned = new ArticleVaultCurrentUploadAssetObservation(
            "fsusblog.article-vault.current-upload-asset-observation.v1", 1, reference,
            bundle.Plan.SiteIdentity, bundle.Plan.VaultIdentity, bundle.Plan.DeviceIdentity,
            item.PortableArticleIdentity, item.ServerArticleIdentity!, articleId, item.Server.ServerRevision.Value, item.Server.Source.Sha256,
            adminId, asset.ArticlePermissionScope, asset.ArticlePermissionSha256, current.PermissionSha256!,
            current.RightsBoundarySha256, current.PublicationBoundarySha256, asset.Asset,
            asset.UploadId, asset.AssetVersionSha256, asset.ReferenceLedgerSha256,
            item.Server.ServerRevision.Value.ToString(CultureInfo.InvariantCulture), string.Empty);
        return (unsigned with
        {
            ContentSha256 = ArticleVaultExecutionIntegrity.Digest(unsigned)
        }, bytes);

    }

    private void RequireLifetime(ArticleVaultSealedExecutionBundle bundle, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (bundle.Plan.CancellationRequested || bundle.Plan.Status == VaultSyncPlanStatus.Cancelled
            || timeProvider.GetUtcNow().ToUnixTimeMilliseconds() > bundle.Plan.ExpiresAtUnixMs)
        {
            throw Rejected("plan_expired_or_cancelled");
        }
    }

    private static bool Digest(string? value) => value is { Length: 64 }
        && value.All(static character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static bool Opaque(string? value) => !string.IsNullOrWhiteSpace(value) && value.Length <= 256
        && !value.Any(char.IsControl);

    private static ArticleVaultExecutionRejectedException Rejected(string reason)
        => new("article_vault_upload_asset_" + reason);
}
