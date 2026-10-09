using System.Globalization;
using System.Security.Claims;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Shared.Contracts.ArticleVault;
using FsusBlog.Shared.Contracts.AuthoringCanvas;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>Expected persisted source coordinates; caller assertions are re-observed, never grants.</summary>
public sealed record CurrentArticleUploadAssetReference(
    int ArticleId, long SourceRevision, string SourceSha256, AssetId AssetId);

/// <summary>
/// Shared current ArticleRead and original upload/ledger facts. This contains no local document,
/// intent/node/transaction attestation, resource-operation grant or cleanup outcome.
/// </summary>
public sealed record CurrentArticleUploadAssetObservation(
    string Schema,
    CurrentArticleUploadAssetReference Reference,
    VaultSourceByteIdentity Source,
    long AdminPrincipalId,
    string ArticlePermissionScope,
    string ArticlePermissionSha256,
    string RevisionPackageSha256,
    AssetRecord Asset,
    string UploadId,
    string AssetVersionSha256,
    string ReferenceLedgerSha256,
    string RevisionReferenceSourceKey)
{
    public bool CanExecute => false;
    public bool CanMaterialize => false;
    public bool CanUpload => false;
    public bool CanCommitBase => false;
}

public sealed class CurrentArticleUploadAssetObservationRejectedException(string reasonCode) : Exception(reasonCode)
{
    public string ReasonCode { get; } = reasonCode;
}

/// <summary>
/// The shared read implementation for current revision upload suppliers. Original authorities own
/// permission, source, session, bytes and ledger validation. No store, transport or grant is added.
/// </summary>
public sealed class CurrentArticleUploadAssetBindingReader(
    IAuthoringArticleCurrentSourceReader sources,
    IFileService files)
{
    public async Task<CurrentArticleUploadAssetObservation> ObserveCurrentRevisionAsync(
        CurrentArticleUploadAssetReference reference,
        ClaimsPrincipal principal,
        UploadSessionAccess session,
        string sha256,
        CancellationToken cancellationToken = default,
        Action? requireCurrent = null)
        => (await ReadCurrentRevisionAsync(reference, principal, session, sha256, false,
            cancellationToken, requireCurrent).ConfigureAwait(false)).Observation;

    /// <summary>
    /// Supplies original session-authorized bytes with current source/ledger facts. Bytes are
    /// for the original consumer's consistency check; no resource-operation or reuse grant follows.
    /// </summary>
    public Task<(CurrentArticleUploadAssetObservation Observation, ReadOnlyMemory<byte> Bytes)> ReadCurrentRevisionInputAsync(
        CurrentArticleUploadAssetReference reference,
        ClaimsPrincipal principal,
        UploadSessionAccess session,
        string sha256,
        CancellationToken cancellationToken = default,
        Action? requireCurrent = null)
        => ReadCurrentRevisionAsync(reference, principal, session, sha256, true, cancellationToken, requireCurrent);

    private async Task<(CurrentArticleUploadAssetObservation Observation, ReadOnlyMemory<byte> Bytes)> ReadCurrentRevisionAsync(
        CurrentArticleUploadAssetReference reference,
        ClaimsPrincipal principal,
        UploadSessionAccess session,
        string sha256,
        bool includeBytes,
        CancellationToken cancellationToken,
        Action? requireCurrent)
    {
        ArgumentNullException.ThrowIfNull(reference);
        ArgumentNullException.ThrowIfNull(principal);
        RequireCurrent();
        if (principal.Identity?.IsAuthenticated != true || !principal.IsAdminPrincipal()
            || !principal.TryGetAdminPrincipalId(out long adminId) || adminId != session.OwnerAdminPrincipalId
            || reference.ArticleId <= 0 || reference.SourceRevision <= 0 || !Digest(reference.SourceSha256)
            || reference.AssetId.Value == Guid.Empty || !Digest(sha256))
        {
            throw Rejected("input_invalid");
        }
        var owner = new AuthoringCanvasOwner(adminId, "primary-site");
        Guid requestId = Guid.CreateVersion7();
        AuthoringArticleCurrentSource sourceBefore = await ReadSourceAsync().ConfigureAwait(false);
        ReadOnlyMemory<byte> bytes = default;
        UploadAssetObservation uploadBefore;
        if (includeBytes)
        {
            RequireCurrent();
            var input = await files.ReadCommittedUploadInputAsync(session, sha256, cancellationToken).ConfigureAwait(false);
            RequireCurrent();
            if (!input.IsSuccess || input.Value is not { } value)
            {
                throw Rejected("upload_or_revision_reference_unavailable");
            }
            uploadBefore = ValidateUpload(value.Observation);
            bytes = value.Bytes;
        }
        else
        {
            uploadBefore = await ReadUploadAsync().ConfigureAwait(false);
        }
        UploadAssetObservation uploadAfter = await ReadUploadAsync().ConfigureAwait(false);
        AuthoringArticleCurrentSource sourceAfter = await ReadSourceAsync().ConfigureAwait(false);
        RequireCurrent();
        if (sourceBefore.Authority != sourceAfter.Authority || sourceBefore.Package.PackageDigest != sourceAfter.Package.PackageDigest
            || uploadBefore.AssetVersionSha256 != uploadAfter.AssetVersionSha256
            || uploadBefore.ReferenceLedgerSha256 != uploadAfter.ReferenceLedgerSha256
            || uploadBefore.Asset != uploadAfter.Asset || !uploadBefore.References.SequenceEqual(uploadAfter.References)
            || principal.Identity?.IsAuthenticated != true || !principal.IsAdminPrincipal()
            || !principal.TryGetAdminPrincipalId(out long currentAdminId) || currentAdminId != adminId)
        {
            throw Rejected("current_facts_changed");
        }
        return (new("fsusblog.current-article-upload-asset-observation.v1", reference, ArticleVaultManifestCodec.CaptureSourceBytes(sourceAfter.Package.RawMarkdown.AsSpan()), adminId, owner.SiteScope,
            sourceAfter.Authority.PermissionFingerprint, sourceAfter.Package.PackageDigest,
            uploadAfter.Asset, uploadAfter.UploadId, uploadAfter.AssetVersionSha256, uploadAfter.ReferenceLedgerSha256,
            reference.SourceRevision.ToString(CultureInfo.InvariantCulture)), bytes);

        async Task<AuthoringArticleCurrentSource> ReadSourceAsync()
        {
            RequireCurrent();
            AuthoringArticleCurrentSourceReadResult read = await sources.ReadCurrentAuthorizedAsync(
                owner, reference.ArticleId, requestId, cancellationToken).ConfigureAwait(false);
            RequireCurrent();
            if (read.Status != RevisionComparePackageReadStatus.Available || read.Source is not { } source
                || source.Owner != owner || source.RequestId != requestId || !source.Authority.Authorized
                || !Digest(source.Authority.PermissionFingerprint) || source.Article.ArticleId != reference.ArticleId
                || source.Article.CurrentRevision != reference.SourceRevision
                || source.Package.ArticleId != reference.ArticleId || source.Package.RevisionId != reference.SourceRevision
                || source.Package.SourceKind != RevisionCompareSourceKind.CurrentRevision
                || !RevisionComparePackageSeal.Verify(source.Package) || source.Package.SourceDigest != reference.SourceSha256)
            {
                throw Rejected("source_unavailable_or_changed");
            }
            return source;
        }

        async Task<UploadAssetObservation> ReadUploadAsync()
        {
            RequireCurrent();
            var read = await files.ObserveCommittedUploadAsync(session, sha256, cancellationToken).ConfigureAwait(false);
            RequireCurrent();
            if (!read.IsSuccess || read.Value is not { } upload)
            {
                throw Rejected("upload_or_revision_reference_unavailable");
            }
            return ValidateUpload(upload);
        }

        UploadAssetObservation ValidateUpload(UploadAssetObservation upload)
        {
            if (CurrentUploadAssetReferenceBinding.FindReference(upload, session, reference.AssetId, sha256,
                ContentAssetSourceKinds.Revision, reference.SourceRevision.ToString(CultureInfo.InvariantCulture), reference.ArticleId) is null)
            {
                throw Rejected("upload_or_revision_reference_unavailable");
            }
            return CurrentUploadAssetReferenceBinding.Freeze(upload);
        }

        void RequireCurrent()
        {
            cancellationToken.ThrowIfCancellationRequested();
            requireCurrent?.Invoke();
        }
    }

    private static bool Digest(string? value) => value is { Length: 64 }
        && value.All(static character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static CurrentArticleUploadAssetObservationRejectedException Rejected(string reason)
        => new(reason);
}
