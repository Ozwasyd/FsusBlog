using System.Security.Claims;

using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;

using AttachmentCleanupObservation = FsusBlog.Server.Services.FileService.AttachmentCleanupObservation;
using AttachmentCleanupStatus = FsusBlog.Server.Services.FileService.AttachmentCleanupStatus;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>Current owned-upload business binding; the original FileService owns recording and durable reads.</summary>
public sealed class CurrentUploadAssetCleanupBindingReader(IFileService files)
{
    public Task<Result<AttachmentCleanupObservation>> ObserveCurrentAsync(
        UploadAssetObservation expected,
        ClaimsPrincipal principal,
        UploadSessionAccess session,
        string sha256,
        Action requireCurrent,
        AttachmentCleanupObservation? expectedCleanup = null,
        CancellationToken cancellationToken = default)
        => ReadCurrentAsync(expected, principal, session, sha256, requireCurrent, expectedCleanup, false, cancellationToken);

    public Task<Result<AttachmentCleanupObservation>> RecordCurrentAsync(
        UploadAssetObservation expected,
        ClaimsPrincipal principal,
        UploadSessionAccess session,
        string sha256,
        Action requireCurrent,
        AttachmentCleanupObservation? expectedCleanup = null,
        CancellationToken cancellationToken = default)
        => ReadCurrentAsync(expected, principal, session, sha256, requireCurrent, expectedCleanup, true, cancellationToken);

    private async Task<Result<AttachmentCleanupObservation>> ReadCurrentAsync(
        UploadAssetObservation expected,
        ClaimsPrincipal principal,
        UploadSessionAccess session,
        string sha256,
        Action requireCurrent,
        AttachmentCleanupObservation? expectedCleanup,
        bool record,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(expected);
        ArgumentNullException.ThrowIfNull(principal);
        ArgumentNullException.ThrowIfNull(requireCurrent);
        RequireCurrent();
        if (!Guid.TryParseExact(session.UploadId, "N", out Guid uploadId)
            || expected.Schema != "fsusblog.upload-asset-observation.v1"
            || expected.UploadId != uploadId.ToString("N") || expected.Asset.Id.Value != uploadId
            || expected.Asset.OwnerAdminPrincipalId != session.OwnerAdminPrincipalId
            || !string.Equals(expected.Asset.Sha256, sha256, StringComparison.OrdinalIgnoreCase)
            || (expectedCleanup is not null && (expectedCleanup.UploadId != expected.UploadId
                || expectedCleanup.AssetId != expected.Asset.Id
                || expectedCleanup.OwnerAdminPrincipalId != session.OwnerAdminPrincipalId)))
        {
            return Result<AttachmentCleanupObservation>.Failure(ErrorCode.Validation, "attachment_cleanup_business_binding_invalid");
        }

        string assetVersion = expectedCleanup?.AssetVersionSha256 ?? expected.AssetVersionSha256;
        string referenceVersion = expectedCleanup?.ReferenceObservationSha256 ?? expected.ReferenceLedgerSha256;
        Result<AttachmentCleanupObservation> result = record
            ? await files.RecordAttachmentCleanupAsync(session, sha256, assetVersion,
                referenceVersion, cancellationToken).ConfigureAwait(false)
            : await files.ObserveAttachmentCleanupAsync(session, sha256, assetVersion,
                referenceVersion, cancellationToken).ConfigureAwait(false);
        RequireCurrent();
        if (result.IsSuccess && (result.Value is not { } observed
            || observed.UploadId != expected.UploadId || observed.AssetId != expected.Asset.Id
                || observed.OwnerAdminPrincipalId != session.OwnerAdminPrincipalId
                || (observed.Status == AttachmentCleanupStatus.Recorded
                    && (observed.ReferenceSourceCount != 0 || observed.AssetState != "pending_delete"
                        || observed.NotBeforeUtc is null || observed.AttemptCount != 0
                        || observed.LastError is not null || observed.QueueUpdatedAtUtc is null
                        || !string.Equals(observed.ReferenceObservationSha256, referenceVersion,
                            StringComparison.OrdinalIgnoreCase)))))
        {
            return Result<AttachmentCleanupObservation>.Failure(ErrorCode.Conflict, "attachment_cleanup_business_observation_changed");
        }
        // Preserve SchedulingRequired/StateChanged/RetainedReferences and all actual queue fields.
        // The authorized recording can change the asset state/version; the original module
        // proves that change and the post-commit locked read. IsSuccess alone is never Recorded.
        return result;

        void RequireCurrent()
        {
            cancellationToken.ThrowIfCancellationRequested();
            requireCurrent();
            cancellationToken.ThrowIfCancellationRequested();
            if (principal.Identity?.IsAuthenticated != true || !principal.IsAdminPrincipal()
                || !principal.TryGetAdminPrincipalId(out long adminId) || adminId <= 0 || adminId != session.OwnerAdminPrincipalId)
            {
                throw new CurrentUploadAssetCleanupBindingRejectedException("attachment_cleanup_current_owner_changed");
            }
        }
    }
}

public sealed class CurrentUploadAssetCleanupBindingRejectedException(string reasonCode) : Exception(reasonCode)
{
    public string ReasonCode { get; } = reasonCode;
}
