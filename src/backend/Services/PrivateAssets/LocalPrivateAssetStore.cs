using System.Buffers;
using System.ComponentModel;
using System.Runtime.InteropServices;
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

    Task<bool> CompleteCommitAsync(
        AssetRecord expected,
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
            bool cleanupQueued = await db.Queryable<ContentAssetCleanupQueueItem>()
                .Where(item => item.AssetId == expected.Id.Value)
                .AnyAsync(cancellationToken);
            if (cleanupQueued || !HasSameCommitMetadata(current, expected))
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

    public async Task<bool> CompleteCommitAsync(
        AssetRecord expected,
        CancellationToken cancellationToken)
    {
        bool completed = false;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            await AcquireLockAsync(expected.Id).ConfigureAwait(false);
            ContentAsset? entity = await db.Queryable<ContentAsset>()
                .Where(item => item.AssetId == expected.Id.Value)
                .FirstAsync(cancellationToken);
            if (entity is null
                || entity.State != ContentAssetStates.PendingDelete
                || !HasSameCommitMetadata(ToRecord(entity), expected)
                || await db.Queryable<ContentAssetCleanupQueueItem>()
                    .Where(item => item.AssetId == expected.Id.Value)
                    .AnyAsync(cancellationToken))
            {
                return;
            }

            entity.State = ContentAssetStates.Active;
            entity.UpdatedAtUtc = DateTime.UtcNow;
            completed = await db.Updateable(entity)
                .UpdateColumns(item => new { item.State, item.UpdatedAtUtc })
                .ExecuteCommandAsync(cancellationToken) == 1;
        }).ConfigureAwait(false);
        if (!transaction.IsSuccess)
        {
            throw new InvalidOperationException("private_asset_complete_failed", transaction.ErrorException);
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
    private const int LinuxOpenCloseOnExec = 0x80000;
    private const int LinuxOpenNoFollow = 0x20000;
    private readonly IPrivateAssetRecordSource _records;
    private readonly IPrivateAssetWritePolicy _writePolicy;
    private readonly string _privateRoot;
    private readonly string _commitRoot;

    public LocalPrivateAssetStore(
        IPrivateAssetRecordSource records,
        IPrivateAssetWritePolicy writePolicy,
        ReleaseStoragePaths storagePaths)
    {
        _records = records;
        _writePolicy = writePolicy;
        _privateRoot = Path.GetFullPath(storagePaths.PrivateAssetRoot);
        _commitRoot = Path.GetFullPath(storagePaths.UploadCommitRoot);
        EnsureRestrictedDirectory(_privateRoot);
        EnsureRestrictedDirectory(_commitRoot);
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

        string lexicalFinalPath = Path.Combine(
            _privateRoot,
            record.StorageKey.Value.Replace('/', Path.DirectorySeparatorChar));
        var initialInfo = new FileInfo(lexicalFinalPath);
        bool finalHasSymlink = HasSymlinkComponent(record.StorageKey);
        bool finalExists = initialInfo.Exists && !finalHasSymlink;
        AssetRecord? prepared = null;
        if (record.State != ContentAssetState.Active || !finalExists || finalHasSymlink)
        {
            prepared = await _records.PrepareCommitAsync(record, cancellationToken);
            if (prepared is null)
            {
                throw new InvalidOperationException("private_asset_commit_state_conflict");
            }
        }

        if (finalHasSymlink)
        {
            throw new InvalidOperationException("private_asset_symlink_rejected");
        }

        ValidateMetadataPolicy(request.Purpose, record);

        string finalPath = ResolvePrivatePath(record.StorageKey);
        string finalDirectory = Path.GetDirectoryName(finalPath)!;
        EnsurePrivateDirectoryChain(finalDirectory);
        string tempDirectory = Path.Combine(_commitRoot, "private-assets");
        EnsureRestrictedDirectory(tempDirectory);
        string tempPath = Path.Combine(tempDirectory, $"{Guid.NewGuid():N}.tmp");

        string actualHash;
        long actualLength;
        try
        {
            (actualHash, actualLength) = await WriteTemporaryAsync(
                request.Content,
                tempPath,
                cancellationToken);
            if (actualLength != record.SizeBytes
                || !CryptographicOperations.FixedTimeEquals(
                    Convert.FromHexString(actualHash),
                    Convert.FromHexString(record.Sha256!)))
            {
                throw new InvalidOperationException("private_asset_content_metadata_mismatch");
            }

            if (File.Exists(finalPath)
                && new FileInfo(finalPath).Length == actualLength
                && await HasExpectedHashAsync(finalPath, actualHash, cancellationToken))
            {
                if (prepared is null)
                {
                    return record.StorageKey;
                }

                if (!await _records.CompleteCommitAsync(prepared, cancellationToken))
                {
                    throw new InvalidOperationException("private_asset_commit_state_conflict");
                }

                return prepared.StorageKey;
            }

            if (File.Exists(finalPath))
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

            File.Move(tempPath, finalPath, overwrite: false);
            try
            {
                EnsureRestrictedFile(finalPath);
            }
            catch
            {
                TryDeleteTemporary(finalPath);
                throw;
            }
            if (!await _records.CompleteCommitAsync(prepared, cancellationToken))
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
                        finalPath,
                        record.Sha256!,
                        cancellationToken);
                    throw new InvalidOperationException("private_asset_commit_cleanup_required");
                }

                throw new InvalidOperationException("private_asset_commit_repair_required");
            }

            return prepared.StorageKey;
        }
        catch (IOException) when (File.Exists(finalPath))
        {
            if (new FileInfo(finalPath).Length == record.SizeBytes
                && await HasExpectedHashAsync(finalPath, record.Sha256!, cancellationToken))
            {
                AssetRecord? racePrepared = prepared
                    ?? await _records.PrepareCommitAsync(record, cancellationToken);
                if (racePrepared is not null
                    && await _records.CompleteCommitAsync(racePrepared, cancellationToken))
                {
                    return racePrepared.StorageKey;
                }
            }

            throw new InvalidOperationException("private_asset_commit_conflict");
        }
        finally
        {
            TryDeleteTemporary(tempPath);
        }
    }

    public async Task<PrivateAssetReadHandle?> OpenReadAsync(
        AssetId assetId,
        CancellationToken cancellationToken = default)
    {
        PrivateAssetReadHandle? metadata = await ValidateAsync(assetId, cancellationToken);
        if (metadata is null)
        {
            return null;
        }

        string path;
        try
        {
            EnsureNoSymlinkComponents(metadata.StorageKey);
            path = ResolvePrivatePath(metadata.StorageKey);
            Stream content = OpenReadNoFollow(path);
            return metadata with
            {
                Content = content
            };
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return null;
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

        string path;
        try
        {
            EnsureNoSymlinkComponents(valid.StorageKey);
            path = ResolvePrivatePath(valid.StorageKey);
        }
        catch (Exception exception) when (exception is
            InvalidOperationException or
            IOException or
            UnauthorizedAccessException)
        {
            return null;
        }

        var info = new FileInfo(path);
        if (!info.Exists || info.LinkTarget is not null || info.Length != valid.SizeBytes)
        {
            return null;
        }

        return new PrivateAssetReadHandle(
            valid.Id,
            valid.StorageKey,
            valid.MimeType,
            valid.Extension,
            valid.SizeBytes,
            valid.Sha256!);
    }

    public async Task DeleteAsync(AssetId assetId, CancellationToken cancellationToken = default)
    {
        AssetRecord? record = await _records.FindAsync(assetId, cancellationToken);
        if (record is null || !string.Equals(record.StorageClass, "private", StringComparison.Ordinal))
        {
            return;
        }

        EnsureNoSymlinkComponents(record.StorageKey);
        string path = ResolvePrivatePath(record.StorageKey);
        try
        {
            File.Delete(path);
        }
        catch (FileNotFoundException)
        {
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

    private string ResolvePrivatePath(AssetStorageKey storageKey)
    {
        if (!CanonicalPathBoundary.TryResolveRelative(_privateRoot, storageKey.Value, out string path))
        {
            throw new InvalidOperationException("private_asset_storage_boundary_rejected");
        }

        return path;
    }

    private void EnsurePrivateDirectoryChain(string targetDirectory)
    {
        string relative = Path.GetRelativePath(_privateRoot, targetDirectory);
        string current = _privateRoot;
        foreach (string segment in relative.Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
        {
            current = Path.Combine(current, segment);
            if (new DirectoryInfo(current).LinkTarget is not null)
            {
                throw new InvalidOperationException("private_asset_symlink_rejected");
            }

            EnsureRestrictedDirectory(current);
        }
    }

    private void EnsureNoSymlinkComponents(AssetStorageKey storageKey)
    {
        if (HasSymlinkComponent(storageKey))
        {
            throw new InvalidOperationException("private_asset_symlink_rejected");
        }
    }

    private bool HasSymlinkComponent(AssetStorageKey storageKey)
    {
        try
        {
            if (new DirectoryInfo(_privateRoot).LinkTarget is not null)
            {
                return true;
            }

            string current = _privateRoot;
            string[] segments = storageKey.Value.Split('/');
            for (int index = 0; index < segments.Length; index++)
            {
                current = Path.Combine(current, segments[index]);
                FileSystemInfo entry = index == segments.Length - 1
                    ? new FileInfo(current)
                    : new DirectoryInfo(current);
                if (entry.LinkTarget is not null)
                {
                    return true;
                }
            }

            return false;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return true;
        }
    }

    private static async Task<(string Hash, long Length)> WriteTemporaryAsync(
        Stream source,
        string tempPath,
        CancellationToken cancellationToken)
    {
        await using var destination = new FileStream(tempPath, CreatePrivateWriteOptions());
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
            EnsureRestrictedFile(tempPath);
            return (Convert.ToHexStringLower(hasher.GetHashAndReset()), length);
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer, clearArray: true);
        }
    }

    private static async Task<bool> HasExpectedHashAsync(
        string path,
        string expectedHash,
        CancellationToken cancellationToken)
    {
        await using var content = OpenReadNoFollow(path);
        byte[] actual = await SHA256.HashDataAsync(content, cancellationToken);
        return CryptographicOperations.FixedTimeEquals(actual, Convert.FromHexString(expectedHash));
    }

    private async Task QuarantineUnownedFinalAsync(
        string finalPath,
        string expectedHash,
        CancellationToken cancellationToken)
    {
        if (!File.Exists(finalPath)
            || !await HasExpectedHashAsync(finalPath, expectedHash, cancellationToken))
        {
            return;
        }

        string cleanupRoot = Path.Combine(_commitRoot, "private-assets");
        EnsureRestrictedDirectory(cleanupRoot);
        string cleanupPath = Path.Combine(cleanupRoot, $"orphan-{Guid.NewGuid():N}.tmp");
        try
        {
            File.Move(finalPath, cleanupPath, overwrite: false);
            EnsureRestrictedFile(cleanupPath);
        }
        catch (IOException)
        {
        }
    }

    private static FileStreamOptions CreatePrivateWriteOptions()
    {
        var options = new FileStreamOptions
        {
            Mode = FileMode.CreateNew,
            Access = FileAccess.Write,
            Share = FileShare.None,
            BufferSize = BufferSize,
            Options = FileOptions.Asynchronous | FileOptions.SequentialScan
        };
        if (!OperatingSystem.IsWindows())
        {
            options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        }

        return options;
    }

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

    private static void EnsureRestrictedFile(string path)
    {
        if (!OperatingSystem.IsWindows())
        {
            const UnixFileMode Required = UnixFileMode.UserRead | UnixFileMode.UserWrite;
            File.SetUnixFileMode(path, Required);
            if (File.GetUnixFileMode(path) != Required)
            {
                throw new UnauthorizedAccessException("private_asset_file_mode_rejected");
            }
        }
    }

    private static FileStream OpenReadNoFollow(string path)
    {
        Microsoft.Win32.SafeHandles.SafeFileHandle handle;
        if (OperatingSystem.IsLinux())
        {
            int descriptor = OpenLinuxNoFollow(path, LinuxOpenCloseOnExec | LinuxOpenNoFollow);
            if (descriptor < 0)
            {
                throw new IOException(
                    "private_asset_nofollow_open_failed",
                    new Win32Exception(Marshal.GetLastPInvokeError()));
            }

            handle = new Microsoft.Win32.SafeHandles.SafeFileHandle(
                new IntPtr(descriptor),
                ownsHandle: true);
        }
        else
        {
            if (new FileInfo(path).LinkTarget is not null)
            {
                throw new IOException("private_asset_symlink_rejected");
            }

            handle = File.OpenHandle(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                FileOptions.Asynchronous | FileOptions.SequentialScan);
        }

        try
        {
            return new FileStream(handle, FileAccess.Read, BufferSize, isAsync: false);
        }
        catch
        {
            handle.Dispose();
            throw;
        }
    }

    [LibraryImport("libc", EntryPoint = "open", SetLastError = true, StringMarshalling = StringMarshalling.Utf8)]
    private static partial int OpenLinuxNoFollow(string path, int flags);

    private static void TryDeleteTemporary(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
        }
    }
}
