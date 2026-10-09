using Microsoft.Extensions.DependencyInjection;

using SqlSugar;

using FsusBlog.Core.Common;
using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Articles;

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
    public Task<Result<AttachmentCleanupObservation>> ObserveAttachmentCleanupAsync(
        UploadSessionAccess access,
        string sha256,
        string? expectedAssetVersionSha256 = null,
        string? expectedReferenceObservationSha256 = null,
        CancellationToken cancellationToken = default)
        => ReadAttachmentCleanupAsync(access, sha256, expectedAssetVersionSha256,
            expectedReferenceObservationSha256, recordIfMissing: false, cancellationToken);

    /// <summary>
    /// Records an unreferenced completed upload through the original reference store.
    /// Requires current caller-bound upload facts; newly scheduled cleanup is acknowledged
    /// only after commit and a fresh locked durable read. Existing schedules are not renewed.
    /// This grants no byte deletion, reference removal, or private asset access.
    /// </summary>
    public async Task<Result<AttachmentCleanupObservation>> RecordAttachmentCleanupAsync(
        UploadSessionAccess access,
        string sha256,
        string expectedAssetVersionSha256,
        string expectedReferenceObservationSha256,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!IsAttachmentCleanupDigest(expectedAssetVersionSha256)
            || !IsAttachmentCleanupDigest(expectedReferenceObservationSha256))
        {
            return Result<AttachmentCleanupObservation>.Failure(ErrorCode.Validation, "attachment_cleanup_input_invalid");
        }
        Result<AttachmentCleanupObservation> candidate = await ObserveAttachmentCleanupAsync(
            access, sha256, expectedAssetVersionSha256, expectedReferenceObservationSha256, cancellationToken)
            .ConfigureAwait(false);
        if (!candidate.IsSuccess || candidate.Value!.Status is not
            (AttachmentCleanupStatus.SchedulingRequired or AttachmentCleanupStatus.Recorded))
        {
            return candidate;
        }
        if (candidate.Value.Status == AttachmentCleanupStatus.SchedulingRequired)
        {
            // The original observer owns completed-upload byte/media validation.
            // Preserve borrowed client state across that existing validation boundary too.
            using IServiceScope validationScope = _scopeFactory!.CreateScope();
            ISqlSugarClient? validationDb = validationScope.ServiceProvider.GetService<ISqlSugarClient>();
            if (validationDb is null)
            {
                return Result<AttachmentCleanupObservation>.Failure(ErrorCode.InfraFailure, "upload_asset_ledger_unavailable");
            }
            CancellationToken? previousNativeCancellation = validationDb.Ado.CancellationToken;
            try
            {
                var upload = await ObserveCommittedUploadAsync(access, sha256, cancellationToken).ConfigureAwait(false);
                if (!upload.IsSuccess)
                {
                    return Result<AttachmentCleanupObservation>.Failure(upload.Error.Code, upload.Error.Message);
                }
                if (!string.Equals(upload.Value!.AssetVersionSha256, expectedAssetVersionSha256, StringComparison.OrdinalIgnoreCase)
                    || !string.Equals(upload.Value.ReferenceLedgerSha256, expectedReferenceObservationSha256, StringComparison.OrdinalIgnoreCase))
                {
                    return Result<AttachmentCleanupObservation>.Failure(ErrorCode.Conflict, "attachment_cleanup_upload_observation_changed");
                }
            }
            finally
            {
                validationDb.Ado.CancellationToken = previousNativeCancellation;
            }
        }
        return await ReadAttachmentCleanupAsync(access, sha256, expectedAssetVersionSha256,
            expectedReferenceObservationSha256, recordIfMissing: true, cancellationToken).ConfigureAwait(false);
    }

    private async Task<Result<AttachmentCleanupObservation>> ReadAttachmentCleanupAsync(
        UploadSessionAccess access,
        string sha256,
        string? expectedAssetVersionSha256,
        string? expectedReferenceObservationSha256,
        bool recordIfMissing,
        CancellationToken cancellationToken)
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
        AssetRecord? currentAsset = null;
        try
        {
            var transaction = await db.Ado.UseTranAsync(async () =>
            {
                cancellationToken.ThrowIfCancellationRequested();
                await db.Ado.ExecuteCommandAsync(
                    "SELECT pg_advisory_xact_lock(hashtextextended(CAST(@AssetId AS text), 1779));",
                    new SugarParameter("@AssetId", assetId.Value)).ConfigureAwait(false);

                Result<AttachmentCleanupObservation> before = await ReadAsync(db).ConfigureAwait(false);
                if (!before.IsSuccess)
                {
                    return before;
                }
                AssetRecord? beforeAsset = currentAsset;
                Result<AttachmentCleanupObservation> after = await ReadAsync(db).ConfigureAwait(false);
                cancellationToken.ThrowIfCancellationRequested();
                if (session.ExpiresAt <= DateTime.UtcNow)
                {
                    return Result<AttachmentCleanupObservation>.Failure(ErrorCode.NotFound, "UPLOAD_SESSION_NOT_FOUND");
                }
                if (!after.IsSuccess || before.Value != after.Value)
                {
                    return Result<AttachmentCleanupObservation>.Failure(ErrorCode.Conflict, "attachment_cleanup_observation_changed");
                }
                if (recordIfMissing && after.Value!.Status == AttachmentCleanupStatus.SchedulingRequired)
                {
                    await new ArticleAssetReferenceStore(db).ScheduleUnreferencedOwnedAssetsAsync(
                        session.OwnerAdminPrincipalId, [assetId], cancellationToken).ConfigureAwait(false);
                    cancellationToken.ThrowIfCancellationRequested();
                    Result<AttachmentCleanupObservation> scheduled = await ReadAsync(db, matchExpected: false).ConfigureAwait(false);
                    AssetRecord? scheduledAsset = currentAsset;
                    Result<AttachmentCleanupObservation> confirmed = await ReadAsync(db, matchExpected: false).ConfigureAwait(false);
                    if (!scheduled.IsSuccess || !confirmed.IsSuccess
                        || scheduled.Value != confirmed.Value
                        || scheduled.Value!.Status != AttachmentCleanupStatus.Recorded
                        || scheduled.Value.ReferenceObservationSha256 != before.Value!.ReferenceObservationSha256
                        || beforeAsset is null || scheduledAsset is null
                        || scheduledAsset with
                        {
                            State = beforeAsset.State,
                            UpdatedAtUtc = beforeAsset.UpdatedAtUtc
                        } != beforeAsset)
                    {
                        // Refusal must roll back the newly attempted schedule as well.
                        throw new InvalidOperationException("attachment_cleanup_recording_postcondition_failed");
                    }
                    return confirmed;
                }
                return after;
            }).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            if (!transaction.IsSuccess)
            {
                return Result<AttachmentCleanupObservation>.Failure(ErrorCode.InfraFailure,
                    recordIfMissing ? "attachment_cleanup_recording_failed" : "attachment_cleanup_observation_failed");
            }
            Result<AttachmentCleanupObservation> committed = transaction.Data;
            if (!recordIfMissing || !committed.IsSuccess || committed.Value!.Status != AttachmentCleanupStatus.Recorded)
            {
                return committed;
            }

            // Commit is not a receipt. Reopen the original ledger scope and transaction,
            // then require the actual durable row and both complete observations to agree.
            using IServiceScope verificationScope = _scopeFactory.CreateScope();
            ISqlSugarClient? verificationDb = verificationScope.ServiceProvider.GetService<ISqlSugarClient>();
            if (verificationDb is null)
            {
                return Result<AttachmentCleanupObservation>.Failure(ErrorCode.InfraFailure, "upload_asset_ledger_unavailable");
            }
            CancellationToken? previousVerificationCancellation = verificationDb.Ado.CancellationToken;
            verificationDb.Ado.CancellationToken = cancellationToken;
            try
            {
                var verification = await verificationDb.Ado.UseTranAsync(async () =>
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    await verificationDb.Ado.ExecuteCommandAsync(
                        "SELECT pg_advisory_xact_lock(hashtextextended(CAST(@AssetId AS text), 1779));",
                        new SugarParameter("@AssetId", assetId.Value)).ConfigureAwait(false);
                    Result<AttachmentCleanupObservation> before = await ReadAsync(verificationDb, matchExpected: false).ConfigureAwait(false);
                    Result<AttachmentCleanupObservation> after = await ReadAsync(verificationDb, matchExpected: false).ConfigureAwait(false);
                    cancellationToken.ThrowIfCancellationRequested();
                    if (session.ExpiresAt <= DateTime.UtcNow || !before.IsSuccess || !after.IsSuccess
                        || before.Value != after.Value || after.Value != committed.Value)
                    {
                        return Result<AttachmentCleanupObservation>.Failure(ErrorCode.Conflict, "attachment_cleanup_recording_changed");
                    }
                    return after;
                }).ConfigureAwait(false);
                cancellationToken.ThrowIfCancellationRequested();
                return verification.IsSuccess
                    ? verification.Data
                    : Result<AttachmentCleanupObservation>.Failure(ErrorCode.InfraFailure, "attachment_cleanup_recording_verification_failed");
            }
            finally
            {
                verificationDb.Ado.CancellationToken = previousVerificationCancellation;
            }
        }
        finally
        {
            db.Ado.CancellationToken = previousCancellation;
        }

        async Task<Result<AttachmentCleanupObservation>> ReadAsync(ISqlSugarClient readDb, bool matchExpected = true)
        {
            ContentAsset? row = await readDb.Queryable<ContentAsset>()
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

            currentAsset = new AssetRecord(assetId, row.StorageClass, AssetStorageKey.Parse(row.StorageKey),
                row.MimeType, row.Extension, row.SizeBytes, row.Sha256!.ToLowerInvariant(),
                row.WidthPixels, row.HeightPixels, row.OwnerAdminPrincipalId,
                row.State == ContentAssetStates.Active ? ContentAssetState.Active : ContentAssetState.PendingDelete,
                AsUtc(row.CreatedAtUtc), AsUtc(row.UpdatedAtUtc));
            List<ContentAssetReference> references = await readDb.Queryable<ContentAssetReference>()
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

            ContentAssetCleanupQueueItem? queue = await readDb.Queryable<ContentAssetCleanupQueueItem>()
                .Where(item => item.AssetId == assetId.Value)
                .FirstAsync(cancellationToken);
            AttachmentCleanupStatus status;
            if (references.Count != 0)
            {
                status = AttachmentCleanupStatus.RetainedReferences;
            }
            else if (matchExpected && ((expectedAssetVersionSha256 is not null
                    && !string.Equals(assetVersion, expectedAssetVersionSha256, StringComparison.OrdinalIgnoreCase))
                || (expectedReferenceObservationSha256 is not null
                    && !string.Equals(referenceObservation, expectedReferenceObservationSha256, StringComparison.OrdinalIgnoreCase))))
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
