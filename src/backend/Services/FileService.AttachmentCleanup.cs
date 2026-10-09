using Microsoft.Extensions.DependencyInjection;

using SqlSugar;

using FsusBlog.Core.Common;
using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.Dtos;

namespace FsusBlog.Server.Services;

public sealed partial class FileService
{
    /// <summary>
    /// Observes ordinary durable cleanup for an authorized completed public upload.
    /// Recorded requires caller-bound current asset and reference digests and an
    /// existing ordinary queue item. SchedulingRequired grants no cleanup receipt:
    /// the reference-store scheduling owner must first record the missing operation.
    /// This method does not delete bytes, remove references, or cancel an upload.
    /// </summary>
    public async Task<Result<AttachmentCleanupObservation>> ObserveAttachmentCleanupAsync(
        UploadSessionAccess access,
        string sha256,
        string? expectedAssetVersionSha256 = null,
        string? expectedReferenceObservationSha256 = null,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!TryNormalizeUploadId(access.UploadId, out string uploadId)
            || !IsAttachmentCleanupDigest(sha256)
            || (expectedAssetVersionSha256 is not null && !IsAttachmentCleanupDigest(expectedAssetVersionSha256))
            || (expectedReferenceObservationSha256 is not null && !IsAttachmentCleanupDigest(expectedReferenceObservationSha256)))
        {
            return Result<AttachmentCleanupObservation>.Failure(ErrorCode.Validation, "attachment_cleanup_input_invalid");
        }

        await using SessionLockLease sessionLock = await AcquireSessionLockAsync(uploadId, cancellationToken);
        UploadSessionRecord? session = await LoadAuthorizedSessionAsync(access with
        {
            UploadId = uploadId
        }, cancellationToken);
        if (session is null || session.ExpiresAt <= DateTime.UtcNow)
        {
            return Result<AttachmentCleanupObservation>.Failure(ErrorCode.NotFound, "UPLOAD_SESSION_NOT_FOUND");
        }
        if (session.Status != "completed")
        {
            return Result<AttachmentCleanupObservation>.Failure(ErrorCode.Conflict, "upload_asset_not_completed");
        }
        if (_scopeFactory is null)
        {
            return Result<AttachmentCleanupObservation>.Failure(ErrorCode.InfraFailure, "upload_asset_ledger_unavailable");
        }

        AssetId assetId = AssetId.FromGuid(Guid.ParseExact(uploadId, "N"));
        using IServiceScope scope = _scopeFactory.CreateScope();
        ISqlSugarClient? db = scope.ServiceProvider.GetService<ISqlSugarClient>();
        if (db is null)
        {
            return Result<AttachmentCleanupObservation>.Failure(ErrorCode.InfraFailure, "upload_asset_ledger_unavailable");
        }
        // SqlSugar keeps query cancellation on Ado; restore the caller's previous
        // client state so a cancelled observation cannot poison a later operation.
        CancellationToken? previousCancellation = db.Ado.CancellationToken;
        db.Ado.CancellationToken = cancellationToken;
        try
        {
            var transaction = await db.Ado.UseTranAsync(async () =>
            {
                cancellationToken.ThrowIfCancellationRequested();
                await db.Ado.ExecuteCommandAsync(
                    "SELECT pg_advisory_xact_lock(hashtextextended(CAST(@AssetId AS text), 1779));",
                    new SugarParameter("@AssetId", assetId.Value)).ConfigureAwait(false);

                Result<AttachmentCleanupObservation> before = await ReadAsync().ConfigureAwait(false);
                if (!before.IsSuccess)
                {
                    return before;
                }
                Result<AttachmentCleanupObservation> after = await ReadAsync().ConfigureAwait(false);
                cancellationToken.ThrowIfCancellationRequested();
                if (session.ExpiresAt <= DateTime.UtcNow)
                {
                    return Result<AttachmentCleanupObservation>.Failure(ErrorCode.NotFound, "UPLOAD_SESSION_NOT_FOUND");
                }
                if (!after.IsSuccess || before.Value != after.Value)
                {
                    return Result<AttachmentCleanupObservation>.Failure(ErrorCode.Conflict, "attachment_cleanup_observation_changed");
                }
                return after;
            }).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            return transaction.IsSuccess
                ? transaction.Data
                : Result<AttachmentCleanupObservation>.Failure(ErrorCode.InfraFailure, "attachment_cleanup_observation_failed");
        }
        finally
        {
            db.Ado.CancellationToken = previousCancellation;
        }

        async Task<Result<AttachmentCleanupObservation>> ReadAsync()
        {
            ContentAsset? row = await db.Queryable<ContentAsset>()
                .Where(asset => asset.AssetId == assetId.Value)
                .FirstAsync(cancellationToken);
            string extension = NormalizeExtension(session.TargetFormat);
            if (row is null || !ContentAssetStates.IsValid(row.State)
                || row.StorageClass != "public" || row.StorageKey != $"illustration/{uploadId}{extension}"
                || row.OwnerAdminPrincipalId != session.OwnerAdminPrincipalId
                || row.SizeBytes != session.TotalBytes || row.SizeBytes <= 0 || row.SizeBytes > MaxUploadBytes
                || row.Extension != extension || row.MimeType != MimeTypeForExtension(extension)
                || !string.Equals(row.Sha256, sha256, StringComparison.OrdinalIgnoreCase)
                || (!string.IsNullOrEmpty(session.Sha256)
                    && !string.Equals(session.Sha256, sha256, StringComparison.OrdinalIgnoreCase)))
            {
                return Result<AttachmentCleanupObservation>.Failure(ErrorCode.Conflict, "upload_asset_ledger_mismatch");
            }

            List<ContentAssetReference> references = await db.Queryable<ContentAssetReference>()
                .Where(reference => reference.AssetId == assetId.Value)
                .OrderBy(reference => reference.SourceKind)
                .OrderBy(reference => reference.SourceKey)
                .Take(ObservationReferenceLimit + 1)
                .ToListAsync(cancellationToken);
            if (references.Count > ObservationReferenceLimit
                || references.Any(static reference => !ContentAssetSourceKinds.IsValid(reference.SourceKind)
                    || string.IsNullOrWhiteSpace(reference.SourceKey) || reference.ReferenceCount <= 0))
            {
                return Result<AttachmentCleanupObservation>.Failure(ErrorCode.Conflict, "upload_asset_reference_observation_unavailable");
            }

            // Keep the original observer's complete version encoding, including state and UTC ticks.
            string assetVersion = HashObservation(writer =>
            {
                writer.Write("fsusblog.asset-version.v1");
                writer.Write(assetId.ToString());
                writer.Write(row.StorageClass);
                writer.Write(row.StorageKey);
                writer.Write(row.MimeType);
                writer.Write(row.Extension);
                writer.Write(row.SizeBytes);
                writer.Write(row.Sha256!.ToLowerInvariant());
                writer.Write(row.WidthPixels ?? -1);
                writer.Write(row.HeightPixels ?? -1);
                writer.Write(row.OwnerAdminPrincipalId ?? -1);
                writer.Write((int)(row.State == ContentAssetStates.Active ? ContentAssetState.Active : ContentAssetState.PendingDelete));
                writer.Write(AsUtc(row.CreatedAtUtc).UtcTicks);
                writer.Write(AsUtc(row.UpdatedAtUtc).UtcTicks);
            });
            string referenceObservation = HashObservation(writer =>
            {
                writer.Write("fsusblog.asset-reference-observation.v1");
                writer.Write(assetId.ToString());
                writer.Write(references.Count);
                foreach (ContentAssetReference reference in references)
                {
                    writer.Write(reference.SourceKind);
                    writer.Write(reference.SourceKey);
                    writer.Write(reference.ArticleId ?? -1);
                    writer.Write(reference.ReferenceCount);
                    writer.Write(reference.AltText is not null);
                    if (reference.AltText is not null)
                    {
                        writer.Write(reference.AltText);
                    }
                    writer.Write(AsUtc(reference.UpdatedAtUtc).UtcTicks);
                }
            });

            ContentAssetCleanupQueueItem? queue = await db.Queryable<ContentAssetCleanupQueueItem>()
                .Where(item => item.AssetId == assetId.Value)
                .FirstAsync(cancellationToken);
            AttachmentCleanupStatus status;
            if (references.Count != 0)
            {
                status = AttachmentCleanupStatus.RetainedReferences;
            }
            else if ((expectedAssetVersionSha256 is not null
                    && !string.Equals(assetVersion, expectedAssetVersionSha256, StringComparison.OrdinalIgnoreCase))
                || (expectedReferenceObservationSha256 is not null
                    && !string.Equals(referenceObservation, expectedReferenceObservationSha256, StringComparison.OrdinalIgnoreCase)))
            {
                status = AttachmentCleanupStatus.StateChanged;
            }
            else if (queue is null && row.State == ContentAssetStates.Active)
            {
                status = AttachmentCleanupStatus.SchedulingRequired;
            }
            else if (queue is null || row.State != ContentAssetStates.PendingDelete
                || queue.LastError is not null || queue.AttemptCount != 0
                || queue.NotBeforeUtc < row.CreatedAtUtc || queue.UpdatedAtUtc < row.CreatedAtUtc)
            {
                status = AttachmentCleanupStatus.StateChanged;
            }
            else
            {
                status = expectedAssetVersionSha256 is not null && expectedReferenceObservationSha256 is not null
                    ? AttachmentCleanupStatus.Recorded
                    : AttachmentCleanupStatus.ObservationRequired;
            }

            return Result<AttachmentCleanupObservation>.Success(new AttachmentCleanupObservation(
                uploadId, assetId, session.OwnerAdminPrincipalId, assetVersion, referenceObservation,
                references.Count, row.State, status, queue is null ? null : AsUtc(queue.NotBeforeUtc),
                queue?.AttemptCount, queue?.LastError, queue is null ? null : AsUtc(queue.UpdatedAtUtc)));
        }
    }

    private static bool IsAttachmentCleanupDigest(string? value)
        => value is { Length: 64 } && value.All(static character => char.IsAsciiHexDigit(character));

    /// <summary>Current durable cleanup disposition; only Recorded acknowledges an existing ordinary operation.</summary>
    public enum AttachmentCleanupStatus
    {
        ObservationRequired,
        SchedulingRequired,
        RetainedReferences,
        StateChanged,
        Recorded
    }

    /// <summary>
    /// Server-side transaction observation, not proof of physical deletion or production qualification.
    /// Queue fields are the actual durable row; digests use the original upload observation encoding.
    /// </summary>
    public sealed record AttachmentCleanupObservation(
        string UploadId,
        AssetId AssetId,
        long OwnerAdminPrincipalId,
        string AssetVersionSha256,
        string ReferenceObservationSha256,
        int ReferenceSourceCount,
        string AssetState,
        AttachmentCleanupStatus Status,
        DateTimeOffset? NotBeforeUtc,
        int? AttemptCount,
        string? LastError,
        DateTimeOffset? QueueUpdatedAtUtc);
}
