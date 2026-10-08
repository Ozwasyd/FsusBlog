using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Algorithms.IO;
using FsusBlog.Core.Common;
using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.Extensions.DependencyInjection;

using SqlSugar;

namespace FsusBlog.Server.Services;

public sealed partial class FileService
{
    private const int ObservationReferenceLimit = 1024;

    public async Task<Result<UploadAssetObservation>> ObserveCommittedUploadAsync(
        UploadSessionAccess access,
        string sha256,
        CancellationToken cancellationToken = default)
        => (await ReadCommittedUploadObservationAsync(access, sha256, MaxUploadBytes, cancellationToken).ConfigureAwait(false))
            .Map(static preview => preview.Observation);

    public Task<Result<UploadAssetPreview>> ReadCommittedUploadPreviewAsync(
        UploadSessionAccess access,
        string sha256,
        CancellationToken cancellationToken = default)
        => ReadCommittedUploadObservationAsync(access, sha256, UploadAssetPreviewDto.MaxPreviewBytes, cancellationToken);

    private async Task<Result<UploadAssetPreview>> ReadCommittedUploadObservationAsync(
        UploadSessionAccess access,
        string sha256,
        long maxObservedBytes,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!TryNormalizeUploadId(access.UploadId, out string uploadId)
            || sha256 is null || sha256.Length != 64
            || sha256.Any(static character => !char.IsAsciiHexDigit(character)))
        {
            return Result<UploadAssetPreview>.Failure(ErrorCode.Validation, "upload_asset_observation_input_invalid");
        }
        await using SessionLockLease sessionLock = await AcquireSessionLockAsync(uploadId, cancellationToken);
        UploadSessionRecord? session = await LoadAuthorizedSessionAsync(access with
        {
            UploadId = uploadId
        }, cancellationToken);
        if (session is null || session.ExpiresAt <= DateTime.UtcNow)
        {
            return Result<UploadAssetPreview>.Failure(ErrorCode.NotFound, "UPLOAD_SESSION_NOT_FOUND");
        }
        if (session.Status != "completed")
        {
            return Result<UploadAssetPreview>.Failure(ErrorCode.Conflict, "upload_asset_not_completed");
        }
        if (_scopeFactory is null)
        {
            return Result<UploadAssetPreview>.Failure(ErrorCode.InfraFailure, "upload_asset_ledger_unavailable");
        }

        AssetId assetId = AssetId.FromGuid(Guid.ParseExact(uploadId, "N"));
        using IServiceScope scope = _scopeFactory.CreateScope();
        ISqlSugarClient db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            cancellationToken.ThrowIfCancellationRequested();
            await db.Ado.ExecuteCommandAsync(
                "SELECT pg_advisory_xact_lock(hashtextextended(CAST(@AssetId AS text), 1779));",
                new SugarParameter("@AssetId", assetId.Value)).ConfigureAwait(false);
            ContentAsset? row = await db.Queryable<ContentAsset>()
                .Where(asset => asset.AssetId == assetId.Value)
                .FirstAsync(cancellationToken);
            string extension = NormalizeExtension(session.TargetFormat);
            string storageKey = $"illustration/{uploadId}{extension}";
            if (row is null || row.State != ContentAssetStates.Active
                || row.StorageClass != "public" || row.StorageKey != storageKey
                || row.OwnerAdminPrincipalId != session.OwnerAdminPrincipalId
                || row.SizeBytes != session.TotalBytes || row.SizeBytes <= 0 || row.SizeBytes > MaxUploadBytes
                || row.Extension != extension || row.MimeType != MimeTypeForExtension(extension)
                || !string.Equals(row.Sha256, sha256, StringComparison.OrdinalIgnoreCase)
                || (!string.IsNullOrEmpty(session.Sha256)
                    && !string.Equals(session.Sha256, sha256, StringComparison.OrdinalIgnoreCase)))
            {
                return Result<UploadAssetPreview>.Failure(ErrorCode.Conflict, "upload_asset_ledger_mismatch");
            }

            // The transport is bounded separately from the original upload and ledger observer.
            // Refuse before opening or allocating the image; never return a truncated preview.
            if (row.SizeBytes > maxObservedBytes)
            {
                return Result<UploadAssetPreview>.Failure(ErrorCode.Validation, "upload_asset_preview_too_large");
            }

            if (!OperatingSystem.IsLinux()
                || RuntimeInformation.ProcessArchitecture is not (Architecture.X64 or Architecture.Arm64))
            {
                return Result<UploadAssetPreview>.Failure(ErrorCode.InfraFailure, "upload_asset_native_observer_unavailable");
            }
            byte[] bytes = new byte[checked((int)row.SizeBytes)];
            try
            {
                string path = Path.Combine(_storagePaths.PublicAssetRoot, storageKey.Replace('/', Path.DirectorySeparatorChar));
                using var handle = NativeRegularFileGuard.OpenOriginalRegularFile(path, cancellationToken);
                var identity = NativeRegularFileGuard.CaptureOriginalRegularFileIdentity(path, handle, cancellationToken);
                await using var stream = new FileStream(handle, FileAccess.Read, 1, isAsync: false);
                await stream.ReadExactlyAsync(bytes, cancellationToken).ConfigureAwait(false);
                byte[] tail = new byte[1];
                if (await stream.ReadAsync(tail, cancellationToken).ConfigureAwait(false) != 0
                    || !string.Equals(Convert.ToHexStringLower(SHA256.HashData(bytes)), sha256, StringComparison.OrdinalIgnoreCase)
                    || !ContentAssetMediaInspector.TryInspect(extension, bytes, out ContentAssetMediaMetadata media)
                    || media.MediaType != row.MimeType || media.Width != row.WidthPixels || media.Height != row.HeightPixels)
                {
                    return Result<UploadAssetPreview>.Failure(ErrorCode.Conflict, "upload_asset_bytes_mismatch");
                }
                NativeRegularFileGuard.ValidateOriginalRegularFileUnchanged(path, handle, identity, cancellationToken);
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or InvalidOperationException)
            {
                return Result<UploadAssetPreview>.Failure(ErrorCode.Conflict, "upload_asset_bytes_unavailable");
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
                return Result<UploadAssetPreview>.Failure(ErrorCode.Conflict, "upload_asset_reference_observation_unavailable");
            }
            AssetRecord asset = new(
                assetId, row.StorageClass, AssetStorageKey.Parse(row.StorageKey), row.MimeType,
                row.Extension, row.SizeBytes, row.Sha256!.ToLowerInvariant(), row.WidthPixels, row.HeightPixels,
                row.OwnerAdminPrincipalId, ContentAssetState.Active, AsUtc(row.CreatedAtUtc), AsUtc(row.UpdatedAtUtc));
            IReadOnlyList<AssetReference> observedReferences = Array.AsReadOnly(references.Select(reference => new AssetReference(
                assetId, reference.SourceKind, reference.SourceKey, reference.ArticleId,
                reference.ReferenceCount, reference.AltText, AsUtc(reference.UpdatedAtUtc))).ToArray());
            return Result<UploadAssetPreview>.Success(new UploadAssetPreview(new UploadAssetObservation(
                "fsusblog.upload-asset-observation.v1", uploadId, asset,
                _publicAssetUrlCodec.ToPublicPath(asset.StorageKey), observedReferences,
                HashObservation(writer =>
                {
                    writer.Write("fsusblog.asset-version.v1");
                    writer.Write(asset.Id.ToString());
                    writer.Write(asset.StorageClass);
                    writer.Write(asset.StorageKey.Value);
                    writer.Write(asset.MimeType);
                    writer.Write(asset.Extension);
                    writer.Write(asset.SizeBytes);
                    writer.Write(asset.Sha256!);
                    writer.Write(asset.WidthPixels ?? -1);
                    writer.Write(asset.HeightPixels ?? -1);
                    writer.Write(asset.OwnerAdminPrincipalId ?? -1);
                    writer.Write((int)asset.State);
                    writer.Write(asset.CreatedAtUtc.UtcTicks);
                    writer.Write(asset.UpdatedAtUtc.UtcTicks);
                }),
                HashObservation(writer =>
                {
                    writer.Write("fsusblog.asset-reference-observation.v1");
                    writer.Write(asset.Id.ToString());
                    writer.Write(observedReferences.Count);
                    foreach (AssetReference reference in observedReferences)
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
                        writer.Write(reference.UpdatedAtUtc.UtcTicks);
                    }
                })), bytes));
        }).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (!transaction.IsSuccess)
        {
            return Result<UploadAssetPreview>.Failure(ErrorCode.InfraFailure, "upload_asset_observation_failed");
        }
        return transaction.Data;
    }

    private static DateTimeOffset AsUtc(DateTime value)
        => new(DateTime.SpecifyKind(value, DateTimeKind.Utc));

    private static string HashObservation(Action<BinaryWriter> write)
    {
        using var buffer = new MemoryStream();
        using (var writer = new BinaryWriter(buffer, Encoding.UTF8, leaveOpen: true))
        {
            write(writer);
        }
        return Convert.ToHexStringLower(SHA256.HashData(buffer.GetBuffer().AsSpan(0, checked((int)buffer.Length))));
    }
}
