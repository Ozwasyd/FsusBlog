using System.Buffers;
using System.Security.Cryptography;

using FsusBlog.Core.Common;
using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Entities;

using Microsoft.Extensions.DependencyInjection;

using SqlSugar;

namespace FsusBlog.Server.Services;

public sealed partial class FileService
{
    private readonly record struct AcknowledgedPartComparison(bool ExactBytes, string Sha256);

    private static async Task<AcknowledgedPartComparison> CompareAcknowledgedPartAsync(
        IFormFile part, string path, long offset, long length, CancellationToken cancellationToken)
    {
        await using Stream incoming = part.OpenReadStream();
        await using var acknowledged = new FileStream(path, new FileStreamOptions
        {
            Mode = FileMode.Open,
            Access = FileAccess.Read,
            Share = FileShare.Read,
            BufferSize = UploadStreamBufferSize,
            Options = FileOptions.Asynchronous | FileOptions.RandomAccess
        });
        acknowledged.Seek(offset, SeekOrigin.Begin);
        using var hasher = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        byte[] inputBuffer = ArrayPool<byte>.Shared.Rent(UploadStreamBufferSize);
        byte[] fileBuffer = ArrayPool<byte>.Shared.Rent(UploadStreamBufferSize);
        try
        {
            long total = 0;
            bool identical = true;
            while (total < length)
            {
                int read = await incoming.ReadAsync(inputBuffer.AsMemory(0, (int)Math.Min(inputBuffer.Length, length - total)), cancellationToken);
                if (read == 0)
                    break;
                await acknowledged.ReadExactlyAsync(fileBuffer.AsMemory(0, read), cancellationToken);
                identical &= inputBuffer.AsSpan(0, read).SequenceEqual(fileBuffer.AsSpan(0, read));
                hasher.AppendData(inputBuffer.AsSpan(0, read));
                total += read;
            }
            bool exactLength = total == length && await incoming.ReadAsync(inputBuffer.AsMemory(0, 1), cancellationToken) == 0;
            return new AcknowledgedPartComparison(identical && exactLength, Convert.ToHexStringLower(hasher.GetHashAndReset()));
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(inputBuffer);
            ArrayPool<byte>.Shared.Return(fileBuffer);
        }
    }

    private async Task<Result<ContentAssetMediaMetadata>> ValidatePrivateCommitCopyAsync(
        string path, AssembledUploadFile assembled, string targetFormat, CancellationToken cancellationToken)
    {
        // The internal constructor retains filesystem-only test semantics; production always has the ledger scope.
        if (_scopeFactory is null)
            return Result<ContentAssetMediaMetadata>.Success(default);
        byte[] bytes = await ReadBoundedUploadBytesAsync(path, cancellationToken);
        if (bytes.Length != assembled.Length
            || Convert.ToHexStringLower(SHA256.HashData(bytes)) != assembled.Sha256)
            return Result<ContentAssetMediaMetadata>.Failure(ErrorCode.Conflict, "上传提交副本与已验证内容不一致");
        if (!ContentAssetMediaInspector.TryInspect(NormalizeExtension(targetFormat), bytes, out var media)
            || media.MediaType != MimeTypeForExtension(NormalizeExtension(targetFormat)))
            return Result<ContentAssetMediaMetadata>.Failure(ErrorCode.Validation, "上传成品图片尺寸无法可靠识别");
        return Result<ContentAssetMediaMetadata>.Success(media);
    }

    private async Task<Result> ValidateExistingCommittedLedgerAsync(
        AssetId id, string path, AssetStorageKey storageKey, long ownerAdminPrincipalId, CancellationToken cancellationToken)
    {
        if (_scopeFactory is null)
            return Result.Success();
        try
        {
            byte[] bytes = await ReadBoundedUploadBytesAsync(path, cancellationToken);
            string extension = NormalizeExtension(Path.GetExtension(path));
            if (!ContentAssetMediaInspector.TryInspect(extension, bytes, out var media))
                return Result.Failure(ErrorCode.Conflict, "已提交上传成品元数据无效");
            using IServiceScope scope = _scopeFactory.CreateScope();
            ISqlSugarClient db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
            ContentAsset? row = await db.Queryable<ContentAsset>().Where(asset => asset.AssetId == id.Value).FirstAsync(cancellationToken);
            bool exact = row is not null && row.StorageClass == "public" && row.StorageKey == storageKey.Value
                && row.OwnerAdminPrincipalId == ownerAdminPrincipalId && row.State == ContentAssetStates.Active
                && row.SizeBytes == bytes.Length && row.Extension == extension && row.MimeType == media.MediaType
                && row.WidthPixels == media.Width && row.HeightPixels == media.Height
                && string.Equals(row.Sha256, Convert.ToHexStringLower(SHA256.HashData(bytes)), StringComparison.OrdinalIgnoreCase);
            return exact ? Result.Success() : Result.Failure(ErrorCode.Conflict, "上传成品资产记录与已提交文件不一致");
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            _logger.LogError(exception, "Committed upload ledger validation failed for {AssetId}", id);
            return Result.Failure(ErrorCode.InfraFailure, "上传成品资产记录验证失败");
        }
    }

    private static async Task<byte[]> ReadBoundedUploadBytesAsync(string path, CancellationToken cancellationToken)
    {
        await using var stream = new FileStream(path, new FileStreamOptions
        {
            Mode = FileMode.Open,
            Access = FileAccess.Read,
            Share = FileShare.Read,
            BufferSize = UploadStreamBufferSize,
            Options = FileOptions.Asynchronous | FileOptions.SequentialScan
        });
        if (stream.Length <= 0 || stream.Length > MaxUploadBytes)
            throw new IOException("upload_commit_length_out_of_bounds");
        byte[] bytes = new byte[checked((int)stream.Length)];
        await stream.ReadExactlyAsync(bytes, cancellationToken);
        if (await stream.ReadAsync(new byte[1], cancellationToken) != 0)
            throw new IOException("upload_commit_length_changed");
        return bytes;
    }
}
