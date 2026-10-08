using System.Globalization;
using System.Security.Claims;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleVault;
using FsusBlog.Shared.Contracts.AuthoringCanvas;

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
    public async Task<ArticleVaultCurrentUploadAssetObservation> ObserveCurrentRevisionUploadAsync(
        ArticleVaultUploadAssetReference reference,
        ClaimsPrincipal principal,
        UploadSessionAccess session,
        string sha256,
        CancellationToken cancellationToken = default)
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
        var owner = new AuthoringCanvasOwner(adminId, "primary-site");
        Guid requestId = Guid.CreateVersion7();
        AuthoringArticleCurrentSource sourceBefore = await ReadSourceAsync().ConfigureAwait(false);
        UploadAssetObservation uploadBefore = await ReadUploadAsync().ConfigureAwait(false);
        // Re-observe through the original byte/session/ledger validator, not through a cached URL.
        UploadAssetObservation uploadAfter = await ReadUploadAsync().ConfigureAwait(false);
        AuthoringArticleCurrentSource sourceAfter = await ReadSourceAsync().ConfigureAwait(false);
        ArticleVaultCurrentArticleObservation[] after = (await observations.ObserveGroupAsync(
            bundle, group, cancellationToken).ConfigureAwait(false)).ToArray();
        ArticleVaultSyncPlanExecutor.ValidateCurrentObservations(group, after);
        RequireLifetime(bundle, cancellationToken);
        ArticleVaultExecutionIntegrity.ValidateBundle(bundle);
        if (!before.SequenceEqual(after) || sourceBefore.Authority != sourceAfter.Authority
            || sourceBefore.Package.PackageDigest != sourceAfter.Package.PackageDigest
            || uploadBefore.AssetVersionSha256 != uploadAfter.AssetVersionSha256
            || uploadBefore.ReferenceLedgerSha256 != uploadAfter.ReferenceLedgerSha256
            || uploadBefore.Asset != uploadAfter.Asset || !uploadBefore.References.SequenceEqual(uploadAfter.References)
            || principal.Identity?.IsAuthenticated != true || !principal.IsAdminPrincipal()
            || !principal.TryGetAdminPrincipalId(out long currentAdminId) || currentAdminId != adminId)
        {
            throw Rejected("current_facts_changed");
        }
        ArticleVaultCurrentArticleObservation current = after[Array.IndexOf(group.Items.ToArray(), item)];
        var unsigned = new ArticleVaultCurrentUploadAssetObservation(
            "fsusblog.article-vault.current-upload-asset-observation.v1", 1, reference,
            bundle.Plan.SiteIdentity, bundle.Plan.VaultIdentity, bundle.Plan.DeviceIdentity,
            item.PortableArticleIdentity, item.ServerArticleIdentity!, articleId, item.Server.ServerRevision.Value, item.Server.Source.Sha256,
            adminId, owner.SiteScope, sourceAfter.Authority.PermissionFingerprint, current.PermissionSha256!,
            current.RightsBoundarySha256, current.PublicationBoundarySha256, uploadAfter.Asset,
            uploadAfter.UploadId, uploadAfter.AssetVersionSha256, uploadAfter.ReferenceLedgerSha256,
            item.Server.ServerRevision.Value.ToString(CultureInfo.InvariantCulture), string.Empty);
        return unsigned with
        {
            ContentSha256 = ArticleVaultExecutionIntegrity.Digest(unsigned)
        };

        async Task<AuthoringArticleCurrentSource> ReadSourceAsync()
        {
            AuthoringArticleCurrentSourceReadResult read = await sources.ReadCurrentAuthorizedAsync(
                owner, articleId, requestId, cancellationToken).ConfigureAwait(false);
            RequireLifetime(bundle, cancellationToken);
            if (read.Status != RevisionComparePackageReadStatus.Available || read.Source is not { } source
                || source.Owner != owner || source.RequestId != requestId || !source.Authority.Authorized
                || !Digest(source.Authority.PermissionFingerprint) || source.Article.ArticleId != articleId
                || source.Article.CurrentRevision != item.Server.ServerRevision
                || source.Package.ArticleId != articleId || source.Package.RevisionId != item.Server.ServerRevision
                || source.Package.SourceKind != RevisionCompareSourceKind.CurrentRevision
                || !RevisionComparePackageSeal.Verify(source.Package)
                || !ArticleVaultManifestValidator.ValidateSourceBytes(item.Server.Source, source.Package.RawMarkdown.AsSpan()).IsValid)
            {
                throw Rejected("source_unavailable_or_changed");
            }
            return source;
        }

        async Task<UploadAssetObservation> ReadUploadAsync()
        {
            var read = await files.ObserveCommittedUploadAsync(session, sha256, cancellationToken).ConfigureAwait(false);
            RequireLifetime(bundle, cancellationToken);
            if (!read.IsSuccess || read.Value is not { } upload || upload.Schema != "fsusblog.upload-asset-observation.v1"
                || upload.UploadId != session.UploadId || upload.Asset.Id != reference.AssetId
                || upload.Asset.OwnerAdminPrincipalId != adminId || upload.Asset.State != ContentAssetState.Active
                || upload.Asset.Sha256 != sha256 || !Digest(upload.AssetVersionSha256) || !Digest(upload.ReferenceLedgerSha256)
                || !upload.References.Any(value => value.AssetId == reference.AssetId
                    && value.SourceKind == ContentAssetSourceKinds.Revision && value.ArticleId == articleId
                    && value.SourceKey == item.Server.ServerRevision.Value.ToString(CultureInfo.InvariantCulture)
                    && value.ReferenceCount > 0))
            {
                throw Rejected("upload_or_revision_reference_unavailable");
            }
            return upload;
        }
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
