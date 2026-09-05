using System.Buffers;
using System.Security.Cryptography;

using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Infrastructure.Storage;
using FsusBlog.Server.Interfaces;

using SqlSugar;

namespace FsusBlog.Server.Services.PrivateAssets;

internal interface IPrivateAssetRecordSource
{
    Task<AssetRecord?> FindAsync(AssetId assetId, CancellationToken cancellationToken);

    Task<AssetRecord?> PrepareCommitAsync(
        AssetRecord expected,
        CancellationToken cancellationToken);

    Task<bool> PublishAndCompleteCommitAsync(
        AssetRecord expected,
        Action publish,
        CancellationToken cancellationToken);
}

internal sealed class SqlPrivateAssetRecordSource(ISqlSugarClient db) : IPrivateAssetRecordSource
{
    public async Task<AssetRecord?> FindAsync(AssetId assetId, CancellationToken cancellationToken)
    {
        ContentAsset? entity = await db.Queryable<ContentAsset>()
            .Where(item => item.AssetId == assetId.Value)
            .FirstAsync(cancellationToken);
        return entity is null ? null : ToRecord(entity);
    }

    public async Task<AssetRecord?> PrepareCommitAsync(
        AssetRecord expected,
        CancellationToken cancellationToken)
    {
        AssetRecord? prepared = null;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            await AcquireLockAsync(expected.Id).ConfigureAwait(false);
            ContentAsset? entity = await db.Queryable<ContentAsset>()
                .Where(item => item.AssetId == expected.Id.Value)
                .FirstAsync(cancellationToken);
            if (entity is null)
            {
                return;
            }

            AssetRecord current = ToRecord(entity);
            ContentAssetCleanupQueueItem? cleanup = await db.Queryable<ContentAssetCleanupQueueItem>()
                .Where(item => item.AssetId == expected.Id.Value)
                .FirstAsync(cancellationToken);
            if ((cleanup is not null
                    && !string.Equals(
                        cleanup.LastError,
                        ContentAssetCleanupMarkers.PrivateCommitRepair,
                        StringComparison.Ordinal))
                || !HasSameCommitMetadata(current, expected))
            {
                return;
            }

            if (entity.State == ContentAssetStates.Active)
            {
                entity.State = ContentAssetStates.PendingDelete;
                entity.UpdatedAtUtc = DateTime.UtcNow;
                await db.Updateable(entity)
                    .UpdateColumns(item => new { item.State, item.UpdatedAtUtc })
                    .ExecuteCommandAsync(cancellationToken);
            }

            DateTime repairNotBeforeUtc = DateTime.UtcNow.AddHours(24);
            await db.Ado.ExecuteCommandAsync(
                """
                INSERT INTO content_asset_cleanup_queue
                    (asset_id, not_before_utc, attempt_count, last_error, updated_at_utc)
                VALUES
                    (@AssetId, @NotBeforeUtc, 0, @Marker, @UpdatedAtUtc)
                ON CONFLICT (asset_id) DO UPDATE
                SET not_before_utc = EXCLUDED.not_before_utc,
                    last_error = EXCLUDED.last_error,
                    updated_at_utc = EXCLUDED.updated_at_utc;
                """,
                new SugarParameter("@AssetId", expected.Id.Value),
                new SugarParameter("@NotBeforeUtc", repairNotBeforeUtc),
                new SugarParameter("@Marker", ContentAssetCleanupMarkers.PrivateCommitRepair),
                new SugarParameter("@UpdatedAtUtc", DateTime.UtcNow)).ConfigureAwait(false);

            prepared = current with
            {
                State = ContentAssetState.PendingDelete
            };
        }).ConfigureAwait(false);
        if (!transaction.IsSuccess)
        {
            throw new InvalidOperationException("private_asset_prepare_failed", transaction.ErrorException);
        }

        return prepared;
    }

    public async Task<bool> PublishAndCompleteCommitAsync(
        AssetRecord expected,
        Action publish,
        CancellationToken cancellationToken)
    {
        bool completed = false;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            await AcquireLockAsync(expected.Id).ConfigureAwait(false);
            ContentAsset? entity = await db.Queryable<ContentAsset>()
                .Where(item => item.AssetId == expected.Id.Value)
                .FirstAsync(cancellationToken);
            ContentAssetCleanupQueueItem? cleanup = entity is null
                ? null
                : await db.Queryable<ContentAssetCleanupQueueItem>()
                    .Where(item => item.AssetId == expected.Id.Value)
                    .FirstAsync(cancellationToken);
            if (entity is null
                || entity.State != ContentAssetStates.PendingDelete
                || !HasSameCommitMetadata(ToRecord(entity), expected)
                || cleanup is null
                || !string.Equals(cleanup.LastError, ContentAssetCleanupMarkers.PrivateCommitRepair, StringComparison.Ordinal))
            {
                return;
            }

            publish();
            int removed = await db.Deleteable<ContentAssetCleanupQueueItem>()
                .Where(item => item.AssetId == expected.Id.Value)
                .ExecuteCommandAsync(cancellationToken);
            entity.State = ContentAssetStates.Active;
            entity.UpdatedAtUtc = DateTime.UtcNow;
            int promoted = await db.Updateable(entity)
                .UpdateColumns(item => new { item.State, item.UpdatedAtUtc })
                .ExecuteCommandAsync(cancellationToken);
            if (removed != 1 || promoted != 1)
            {
                throw new InvalidOperationException("private_asset_complete_row_mismatch");
            }

            completed = true;
        }).ConfigureAwait(false);
        if (!transaction.IsSuccess)
        {
            if (transaction.ErrorException is PrivateAssetDurabilityException durabilityFailure)
            {
                throw new PrivateAssetDurabilityException(durabilityFailure.Message);
            }

            if (transaction.ErrorException is IOException or UnauthorizedAccessException)
            {
                throw new IOException("private_asset_commit_publish_failed");
            }

            throw new InvalidOperationException("private_asset_complete_failed");
        }

        return completed;
    }

    private Task<int> AcquireLockAsync(AssetId assetId)
        => db.Ado.ExecuteCommandAsync(
            "SELECT pg_advisory_xact_lock(hashtextextended(CAST(@AssetId AS text), 1779));",
            new SugarParameter("@AssetId", assetId.Value));

    private static bool HasSameCommitMetadata(AssetRecord left, AssetRecord right)
        => left.Id == right.Id
            && string.Equals(left.StorageClass, right.StorageClass, StringComparison.Ordinal)
            && left.StorageKey == right.StorageKey
            && string.Equals(left.MimeType, right.MimeType, StringComparison.Ordinal)
            && string.Equals(left.Extension, right.Extension, StringComparison.Ordinal)
            && left.SizeBytes == right.SizeBytes
            && string.Equals(left.Sha256, right.Sha256, StringComparison.OrdinalIgnoreCase);

    private static AssetRecord ToRecord(ContentAsset entity)
        => new(
            AssetId.FromGuid(entity.AssetId),
            entity.StorageClass,
            AssetStorageKey.Parse(entity.StorageKey),
            entity.MimeType,
            entity.Extension,
            entity.SizeBytes,
            entity.Sha256,
            entity.WidthPixels,
            entity.HeightPixels,
            entity.OwnerAdminPrincipalId,
            entity.State switch
            {
                ContentAssetStates.Active => ContentAssetState.Active,
                ContentAssetStates.PendingDelete => ContentAssetState.PendingDelete,
                _ => throw new InvalidOperationException("private_asset_record_invalid")
            },
            AsUtc(entity.CreatedAtUtc),
            AsUtc(entity.UpdatedAtUtc));

    private static DateTimeOffset AsUtc(DateTime value)
        => new(DateTime.SpecifyKind(value, DateTimeKind.Utc));
}

internal interface IPrivateAssetExistenceProbe
{
    Task<bool> ExistsAsync(AssetId assetId, CancellationToken cancellationToken = default);
}

internal interface IPrivateAssetWritePolicy
{
    bool Allows(PrivateAssetWritePurpose purpose, AssetRecord record);
}

internal sealed class PrivateAssetWritePolicy : IPrivateAssetWritePolicy
{
    internal const long MaximumBytesPerPurpose = 1024L * 1024L * 1024L;

    public bool Allows(PrivateAssetWritePurpose purpose, AssetRecord record)
        => record.SizeBytes is >= 0 and <= MaximumBytesPerPurpose
            && (purpose switch
            {
                PrivateAssetWritePurpose.BinaryAttachment => Matches(record, ".bin", "application/octet-stream"),
                PrivateAssetWritePurpose.PortableDocument => Matches(record, ".pdf", "application/pdf"),
                PrivateAssetWritePurpose.ArchiveExport => Matches(record, ".zip", "application/zip"),
                PrivateAssetWritePurpose.DataExport => Matches(record, ".json", "application/json")
                    || Matches(record, ".csv", "text/csv"),
                PrivateAssetWritePurpose.ImageOriginal => Matches(record, ".jpg", "image/jpeg")
                    || Matches(record, ".jpeg", "image/jpeg")
                    || Matches(record, ".png", "image/png")
                    || Matches(record, ".gif", "image/gif")
                    || Matches(record, ".webp", "image/webp"),
                _ => false
            });

    private static bool Matches(AssetRecord record, string extension, string mediaType)
        => string.Equals(NormalizeExtension(record.Extension), extension, StringComparison.Ordinal)
            && string.Equals(record.MimeType, mediaType, StringComparison.Ordinal);

    private static string NormalizeExtension(string extension)
        => extension.StartsWith(".", StringComparison.Ordinal)
            ? extension.ToLowerInvariant()
            : $".{extension.ToLowerInvariant()}";
}

internal sealed partial class LocalPrivateAssetStore : IPrivateAssetStore, IPrivateAssetExistenceProbe
{
    private const int BufferSize = 128 * 1024;
    private const long MaximumAssetBytes = 1024L * 1024L * 1024L;
    private readonly IPrivateAssetRecordSource _records;
    private readonly IPrivateAssetWritePolicy _writePolicy;
    private readonly string _privateRoot;
    private readonly string _commitRoot;
    private readonly PrivateAssetAnchoredFileSystem _fileSystem;

    public LocalPrivateAssetStore(
        IPrivateAssetRecordSource records,
        IPrivateAssetWritePolicy writePolicy,
        ReleaseStoragePaths storagePaths)
        : this(records, writePolicy, storagePaths, fileSystem: null)
    {
    }

    internal LocalPrivateAssetStore(
        IPrivateAssetRecordSource records,
        IPrivateAssetWritePolicy writePolicy,
        ReleaseStoragePaths storagePaths,
        PrivateAssetAnchoredFileSystem? fileSystem)
    {
        _records = records;
        _writePolicy = writePolicy;
        _privateRoot = Path.GetFullPath(storagePaths.PrivateAssetRoot);
        _commitRoot = Path.GetFullPath(storagePaths.UploadCommitRoot);
        try
        {
            EnsureRestrictedDirectory(_privateRoot);
            EnsureRestrictedDirectory(_commitRoot);
            _fileSystem = fileSystem ?? new PrivateAssetAnchoredFileSystem(_privateRoot, _commitRoot);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            throw new InvalidOperationException("private_asset_storage_initialization_failed");
        }
    }

    public async Task<AssetStorageKey> CreateAsync(
        PrivateAssetWriteRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(request.Content);
        if (!request.Content.CanRead)
        {
            throw new ArgumentException("Private asset content must be readable.", nameof(request));
        }

        AssetRecord record = await RequirePrivateCommitRecordAsync(request.AssetId, cancellationToken);
        AssetStorageKey expectedKey = CreateStorageKey(record.Id, record.Extension);
        if (record.StorageKey != expectedKey)
        {
            throw new InvalidOperationException("private_asset_storage_key_not_canonical");
        }

        bool finalExists;
        try
        {
            await using FileStream? initial = _fileSystem.TryOpenRead(record.StorageKey.Value);
            finalExists = initial is not null;
        }
        catch (IOException)
        {
            AssetRecord? rejectedPrepared = await _records.PrepareCommitAsync(record, cancellationToken);
            if (rejectedPrepared is null)
            {
                throw new InvalidOperationException("private_asset_commit_state_conflict");
            }

            throw new InvalidOperationException("private_asset_symlink_rejected");
        }

        AssetRecord? prepared = null;
        if (record.State != ContentAssetState.Active || !finalExists)
        {
            prepared = await _records.PrepareCommitAsync(record, cancellationToken);
            if (prepared is null)
            {
                throw new InvalidOperationException("private_asset_commit_state_conflict");
            }
        }

        ValidateMetadataPolicy(request.Purpose, record);
        AnchoredTemporaryFile temporary = _fileSystem.CreateTemporary();

        string actualHash;
        long actualLength;
        try
        {
            (actualHash, actualLength) = await WriteTemporaryAsync(
                request.Content,
                temporary.Stream,
                cancellationToken);
            if (actualLength != record.SizeBytes
                || !CryptographicOperations.FixedTimeEquals(
                    Convert.FromHexString(actualHash),
                    Convert.FromHexString(record.Sha256!)))
            {
                throw new InvalidOperationException("private_asset_content_metadata_mismatch");
            }

            await using FileStream? existing = _fileSystem.TryOpenRead(record.StorageKey.Value);
            if (existing is not null
                && existing.Length == actualLength
                && await HasExpectedHashAsync(existing, actualHash, cancellationToken))
            {
                if (prepared is null)
                {
                    return record.StorageKey;
                }

                if (!await _records.PublishAndCompleteCommitAsync(
                        prepared,
                        () => _fileSystem.SyncExistingEntry(record.StorageKey.Value),
                        cancellationToken))
                {
                    throw new InvalidOperationException("private_asset_commit_state_conflict");
                }

                return prepared.StorageKey;
            }

            if (existing is not null)
            {
                prepared ??= await _records.PrepareCommitAsync(record, cancellationToken);
                throw new InvalidOperationException("private_asset_commit_conflict");
            }

            if (prepared is null)
            {
                prepared = await _records.PrepareCommitAsync(record, cancellationToken);
                if (prepared is null)
                {
                    throw new InvalidOperationException("private_asset_commit_state_conflict");
                }
            }

            await temporary.Stream.FlushAsync(cancellationToken);
            if (!await _records.PublishAndCompleteCommitAsync(
                    prepared,
                    () => _fileSystem.Commit(temporary, record.StorageKey.Value),
                    cancellationToken))
            {
                AssetRecord? current = await _records.FindAsync(record.Id, cancellationToken);
                if (current is not null
                    && HasSameCommitMetadata(current, record)
                    && current.State == ContentAssetState.Active)
                {
                    return current.StorageKey;
                }

                if (current is null || !HasSameCommitMetadata(current, record))
                {
                    await QuarantineUnownedFinalAsync(
                        record.StorageKey,
                        record.Sha256!,
                        cancellationToken);
                    throw new InvalidOperationException("private_asset_commit_cleanup_required");
                }

                throw new InvalidOperationException("private_asset_commit_repair_required");
            }

            return prepared.StorageKey;
        }
        catch (PrivateAssetDurabilityException)
        {
            throw new InvalidOperationException("private_asset_commit_durability_failed");
        }
        catch (IOException)
        {
            await using FileStream? winner = _fileSystem.TryOpenRead(record.StorageKey.Value);
            if (winner is not null
                && winner.Length == record.SizeBytes
                && await HasExpectedHashAsync(winner, record.Sha256!, cancellationToken))
            {
                AssetRecord? racePrepared = prepared
                    ?? await _records.PrepareCommitAsync(record, cancellationToken);
                if (racePrepared is not null
                    && await _records.PublishAndCompleteCommitAsync(
                        racePrepared,
                        () => _fileSystem.SyncExistingEntry(record.StorageKey.Value),
                        cancellationToken))
                {
                    return racePrepared.StorageKey;
                }
            }

            throw new InvalidOperationException("private_asset_commit_conflict");
        }
        finally
        {
            await temporary.DisposeAsync();
            _fileSystem.TryDeleteTemporary(temporary.Name, temporary.FallbackPath);
        }
    }

    public async Task<PrivateAssetReadHandle?> OpenReadAsync(
        AssetId assetId,
        CancellationToken cancellationToken = default)
    {
        AssetRecord? record = await _records.FindAsync(assetId, cancellationToken);
        if (!TryValidateActivePrivateRecord(record, out AssetRecord valid)
            || valid.StorageKey != CreateStorageKey(valid.Id, valid.Extension))
        {
            return null;
        }

        FileStream? content = null;
        try
        {
            content = _fileSystem.TryOpenRead(valid.StorageKey.Value);
            if (content is null
                || content.Length != valid.SizeBytes
                || !await HasExpectedHashAsync(content, valid.Sha256!, cancellationToken))
            {
                return null;
            }

            content.Position = 0;
            PrivateAssetReadHandle handle = ToReadHandle(valid, content);
            content = null;
            return handle;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or CryptographicException)
        {
            return null;
        }
        finally
        {
            if (content is not null)
            {
                await content.DisposeAsync();
            }
        }
    }

    public async Task<PrivateAssetReadHandle?> ValidateAsync(
        AssetId assetId,
        CancellationToken cancellationToken = default)
    {
        AssetRecord? record = await _records.FindAsync(assetId, cancellationToken);
        if (!TryValidateActivePrivateRecord(record, out AssetRecord valid))
        {
            return null;
        }

        AssetStorageKey expectedKey = CreateStorageKey(valid.Id, valid.Extension);
        if (valid.StorageKey != expectedKey)
        {
            return null;
        }

        try
        {
            await using FileStream? content = _fileSystem.TryOpenRead(valid.StorageKey.Value);
            if (content is null
                || content.Length != valid.SizeBytes
                || !await HasExpectedHashAsync(content, valid.Sha256!, cancellationToken))
            {
                return null;
            }
        }
        catch (Exception exception) when (exception is
            InvalidOperationException or
            IOException or
            UnauthorizedAccessException)
        {
            return null;
        }

        return ToReadHandle(valid);
    }

    public async Task DeleteAsync(AssetId assetId, CancellationToken cancellationToken = default)
    {
        AssetRecord? record = await _records.FindAsync(assetId, cancellationToken);
        if (record is null || !string.Equals(record.StorageClass, "private", StringComparison.Ordinal))
        {
            return;
        }

        try
        {
            _fileSystem.Delete(record.StorageKey.Value);
        }
        catch (IOException exception) when (PrivateAssetAnchoredFileSystem.IsUnsafeTraversal(exception))
        {
            throw new InvalidOperationException("private_asset_symlink_rejected");
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            throw new IOException("private_asset_delete_failed");
        }
    }

    async Task<bool> IPrivateAssetExistenceProbe.ExistsAsync(
        AssetId assetId,
        CancellationToken cancellationToken)
        => await ValidateAsync(assetId, cancellationToken) is not null;

    internal static AssetStorageKey CreateStorageKey(AssetId assetId, string extension)
    {
        string normalizedExtension = NormalizeExtension(extension);
        string id = assetId.Value.ToString("N");
        return AssetStorageKey.Parse($"{id[..2]}/{id}{normalizedExtension}");
    }

    private async Task<AssetRecord> RequirePrivateCommitRecordAsync(
        AssetId assetId,
        CancellationToken cancellationToken)
    {
        AssetRecord? record = await _records.FindAsync(assetId, cancellationToken);
        if (!TryValidatePrivateCommitRecord(record, out AssetRecord valid))
        {
            throw new InvalidOperationException("private_asset_record_unavailable");
        }

        return valid;
    }

    private static bool TryValidateActivePrivateRecord(
        AssetRecord? record,
        out AssetRecord valid)
    {
        valid = null!;
        if (record is null
            || !string.Equals(record.StorageClass, "private", StringComparison.Ordinal)
            || record.State != ContentAssetState.Active
            || record.SizeBytes < 0
            || record.SizeBytes > MaximumAssetBytes
            || record.Sha256 is null
            || record.Sha256.Length != 64)
        {
            return false;
        }

        try
        {
            ContentAssetSchemaValidator.Validate(record);
            _ = Convert.FromHexString(record.Sha256);
            valid = record;
            return true;
        }
        catch (Exception exception) when (exception is ArgumentException or FormatException)
        {
            return false;
        }
    }

    private static bool TryValidatePrivateCommitRecord(
        AssetRecord? record,
        out AssetRecord valid)
    {
        if (record is not null && record.State is ContentAssetState.Active or ContentAssetState.PendingDelete)
        {
            AssetRecord activeProjection = record with
            {
                State = ContentAssetState.Active
            };
            if (TryValidateActivePrivateRecord(activeProjection, out _))
            {
                valid = record;
                return true;
            }
        }

        valid = null!;
        return false;
    }

    private static bool HasSameCommitMetadata(AssetRecord left, AssetRecord right)
        => left.Id == right.Id
            && string.Equals(left.StorageClass, right.StorageClass, StringComparison.Ordinal)
            && left.StorageKey == right.StorageKey
            && string.Equals(left.MimeType, right.MimeType, StringComparison.Ordinal)
            && string.Equals(left.Extension, right.Extension, StringComparison.Ordinal)
            && left.SizeBytes == right.SizeBytes
            && string.Equals(left.Sha256, right.Sha256, StringComparison.OrdinalIgnoreCase);

    private void ValidateMetadataPolicy(PrivateAssetWritePurpose purpose, AssetRecord record)
    {
        if (!_writePolicy.Allows(purpose, record))
        {
            throw new ArgumentException(
                "Private asset media type, extension and purpose are not an allowed combination.",
                nameof(record));
        }
    }

    private static string NormalizeExtension(string extension)
    {
        if (string.IsNullOrWhiteSpace(extension))
        {
            throw new ArgumentException("Private asset extension is required.", nameof(extension));
        }

        string normalized = extension.StartsWith(".", StringComparison.Ordinal)
            ? extension.ToLowerInvariant()
            : $".{extension.ToLowerInvariant()}";
        if (normalized.Length > 16 || normalized.Any(character =>
            character != '.' && !char.IsAsciiLetterOrDigit(character)))
        {
            throw new ArgumentException("Private asset extension is invalid.", nameof(extension));
        }

        return normalized;
    }

    private static async Task<(string Hash, long Length)> WriteTemporaryAsync(
        Stream source,
        FileStream destination,
        CancellationToken cancellationToken)
    {
        using var hasher = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        byte[] buffer = ArrayPool<byte>.Shared.Rent(BufferSize);
        long length = 0;
        try
        {
            int read;
            while ((read = await source.ReadAsync(buffer.AsMemory(0, buffer.Length), cancellationToken)) > 0)
            {
                length = checked(length + read);
                if (length > MaximumAssetBytes)
                {
                    throw new InvalidOperationException("private_asset_size_limit_exceeded");
                }

                hasher.AppendData(buffer.AsSpan(0, read));
                await destination.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
            }

            await destination.FlushAsync(cancellationToken);
            destination.Flush(flushToDisk: true);
            return (Convert.ToHexStringLower(hasher.GetHashAndReset()), length);
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer, clearArray: true);
        }
    }

    private static async Task<bool> HasExpectedHashAsync(
        Stream content,
        string expectedHash,
        CancellationToken cancellationToken)
    {
        content.Position = 0;
        byte[] actual = await SHA256.HashDataAsync(content, cancellationToken);
        return CryptographicOperations.FixedTimeEquals(actual, Convert.FromHexString(expectedHash));
    }

    private async Task QuarantineUnownedFinalAsync(
        AssetStorageKey storageKey,
        string expectedHash,
        CancellationToken cancellationToken)
    {
        await using FileStream? content = _fileSystem.TryOpenRead(storageKey.Value);
        if (content is null
            || !await HasExpectedHashAsync(content, expectedHash, cancellationToken))
        {
            return;
        }

        try
        {
            _fileSystem.MoveToCleanup(
                storageKey.Value,
                $"orphan-{Guid.NewGuid():N}.tmp");
        }
        catch (IOException)
        {
        }
    }

    private static PrivateAssetReadHandle ToReadHandle(AssetRecord record, Stream? content = null)
        => new(
            record.Id,
            record.StorageKey,
            record.MimeType,
            record.Extension,
            record.SizeBytes,
            record.Sha256!,
            content);

    private static void EnsureRestrictedDirectory(string path)
    {
        Directory.CreateDirectory(path);
        if (!OperatingSystem.IsWindows())
        {
            const UnixFileMode Required =
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;
            File.SetUnixFileMode(
                path,
                Required);
            if (File.GetUnixFileMode(path) != Required)
            {
                throw new UnauthorizedAccessException("private_asset_directory_mode_rejected");
            }
        }
    }

}
