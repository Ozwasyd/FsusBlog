using System.Buffers;
using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Storage;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Background;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Services;

public sealed partial class FileService : IFileService
{
    private const int DefaultChunkSize = 512 * 1024;
    private const int MaxChunkSize = 2 * 1024 * 1024;
    private const int UploadStreamBufferSize = 81920;
    private const int ImageSignatureHeaderLength = 512;
    public const long MaxUploadBytes = 20 * 1024 * 1024;
    public const long UploadRequestBodyLimitBytes = MaxUploadBytes + 1024 * 1024;
    private const uint UploadSessionMagic = 0x53505546; // FUPS
    private const byte UploadSessionVersion = 3;
    private const int ManifestFlushPartInterval = 8;
    private const string WorkingUploadFileName = "upload.tmp";
    private const string UploadPartBitmapFileName = "parts.bitmap";
    private const string UploadCommitTempDirectoryName = ".incoming";
    private const string ExpirationIndexDirectoryName = "expires";
    private const string ExpirationBucketFormat = "yyyyMMddHH";
    private static readonly TimeSpan s_sessionTtl = TimeSpan.FromHours(6);
    private static readonly TimeSpan s_sessionLockTtl = TimeSpan.FromHours(6);
    private static readonly TimeSpan s_uploadCommitTempRetention = TimeSpan.FromHours(24);
    private static readonly TimeSpan s_uploadCommitTempCleanupLeaseTtl = TimeSpan.FromMinutes(2);

    private readonly IWebHostEnvironment _env;
    private readonly ILogger<FileService> _logger;
    private readonly string _subFolder;
    private readonly string _folderPath;
    private readonly string _cleanSubFolderWeb;
    private readonly string _sandboxAbsolutePath;
    private readonly string _sessionRootPath;
    private readonly string _sessionRootAbsolutePath;
    private readonly string _expirationIndexRootPath;
    private readonly UploadSessionCleanupQueue? _cleanupQueue;

    private static readonly string[] s_allowedExtensions = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".ico"];
    private static readonly string[] s_allowedFormats = ["jpg", "jpeg", "png", "gif", "webp", "ico"];
    private static readonly ConcurrentDictionary<string, SessionLockEntry> s_sessionLocks = new(StringComparer.Ordinal);

    public FileService(
        IWebHostEnvironment env,
        ILogger<FileService> logger,
        UploadSessionCleanupQueue? cleanupQueue = null)
    {
        _env = env;
        _logger = logger;
        _cleanupQueue = cleanupQueue;
        _subFolder = Path.Combine("uploads", "illustration");

        string webRoot = _env.WebRootPath ?? Path.Combine(Directory.GetCurrentDirectory(), "wwwroot");
        _folderPath = Path.Combine(webRoot, _subFolder);
        _sessionRootPath = Path.GetFullPath(Path.Combine(_env.ContentRootPath, ".upload-sessions"));
        _expirationIndexRootPath = Path.Combine(_sessionRootPath, ExpirationIndexDirectoryName);

        string absPath = Path.GetFullPath(_folderPath);
        _sandboxAbsolutePath = absPath.EndsWith(Path.DirectorySeparatorChar.ToString(), StringComparison.Ordinal)
            ? absPath
            : absPath + Path.DirectorySeparatorChar;
        _sessionRootAbsolutePath = _sessionRootPath.EndsWith(Path.DirectorySeparatorChar.ToString(), StringComparison.Ordinal)
            ? _sessionRootPath
            : _sessionRootPath + Path.DirectorySeparatorChar;

        _cleanSubFolderWeb = "/" + _subFolder.Trim('/', '\\').Replace('\\', '/');

        Directory.CreateDirectory(_folderPath);
        EnsureRestrictedDirectory(_sessionRootPath);
        EnsureRestrictedDirectory(_expirationIndexRootPath);
    }

    public async Task<FileUploadResult> UploadImageAsync(IFormFile file)
    {
        if (file == null || file.Length == 0)
        {
            return new FileUploadResult { Success = false, Message = "文件为空" };
        }

        string extension = NormalizeExtension(Path.GetExtension(file.FileName));
        if (!IsAllowedExtension(extension))
        {
            return new FileUploadResult { Success = false, Message = "格式不支持" };
        }

        if (!await ValidateImageSignatureAsync(file, extension))
        {
            return new FileUploadResult { Success = false, Message = "图片签名不匹配" };
        }

        string fileName = $"{Guid.NewGuid():N}{extension}";
        string filePath = Path.Combine(_folderPath, fileName);
        string relativeUrl = $"{_cleanSubFolderWeb}/{fileName}";
        string commitTempRoot = GetUploadCommitTempRoot();
        string tempPath = Path.Combine(commitTempRoot, $"{fileName}.{Path.GetRandomFileName()}.tmp");

        return await BoundaryExecutor.ExecuteValueAsync(
            async () =>
            {
                EnsureRestrictedDirectory(commitTempRoot);
                try
                {
                    await using (var stream = new FileStream(tempPath, CreatePrivateWriteOptions(FileMode.CreateNew)))
                    {
                        await file.CopyToAsync(stream);
                        await stream.FlushAsync();
                        stream.Flush(flushToDisk: true);
                    }

                    File.Move(tempPath, filePath, overwrite: false);

                    return new FileUploadResult
                    {
                        Success = true,
                        Url = relativeUrl,
                        RelativeUrl = relativeUrl,
                        PhysicalPath = filePath
                    };
                }
                finally
                {
                    TryDeleteFile(tempPath);
                }
            },
            _ => new FileUploadResult { Success = false, Message = "写入失败" },
            _logger,
            $"file-upload:{filePath}",
            LogLevel.Error);
    }

    public async Task<Result<UploadInitDto>> InitUploadSessionAsync(UploadInitRequestDto dto, CancellationToken cancellationToken = default)
    {
        RequestUploadSessionCleanup();

        if (string.IsNullOrWhiteSpace(dto.FileName))
        {
            return Result<UploadInitDto>.Failure(ErrorCode.Validation, "文件名不能为空");
        }

        if (dto.TotalBytes <= 0 || dto.TotalBytes > MaxUploadBytes)
        {
            return Result<UploadInitDto>.Failure(ErrorCode.Validation, "图片大小超出限制");
        }

        if (!IsSupportedImageMime(dto.MimeType))
        {
            return Result<UploadInitDto>.Failure(ErrorCode.Validation, "图片类型不支持");
        }

        string targetFormat = NormalizeFormat(dto.TargetFormat, dto.FileName, dto.MimeType);
        if (targetFormat.Length == 0)
        {
            return Result<UploadInitDto>.Failure(ErrorCode.Validation, "目标格式不支持");
        }

        if (!IsMimeCompatibleWithFormat(dto.MimeType, targetFormat))
        {
            return Result<UploadInitDto>.Failure(ErrorCode.Validation, "目标格式与 mimeType 不一致");
        }

        int chunkSize = Math.Clamp(dto.ChunkSize <= 0 ? DefaultChunkSize : dto.ChunkSize, 64 * 1024, MaxChunkSize);
        int totalParts = checked((int)Math.Ceiling(dto.TotalBytes / (double)chunkSize));
        string uploadId = Guid.NewGuid().ToString("N");
        string uploadToken = CreateUploadSessionToken();
        DateTime expiresAt = DateTime.UtcNow.Add(s_sessionTtl);

        var record = new UploadSessionRecord
        {
            UploadId = uploadId,
            UploadToken = uploadToken,
            FileName = Path.GetFileName(dto.FileName),
            MimeType = string.IsNullOrWhiteSpace(dto.MimeType) ? $"image/{targetFormat}" : dto.MimeType.Trim(),
            TargetFormat = targetFormat,
            TotalBytes = dto.TotalBytes,
            ChunkSize = chunkSize,
            TotalParts = totalParts,
            Sha256 = NormalizeHash(dto.Sha256),
            Status = "pending",
            CreatedAt = DateTime.UtcNow,
            ExpiresAt = expiresAt,
            WorkingFileName = WorkingUploadFileName,
            UploadedPartBitmapBase64 = CreatePartBitmapBase64(totalParts)
        };

        Result initResult = await BoundaryExecutor.ExecuteResultAsync(
            async () =>
            {
                EnsureRestrictedDirectory(GetSessionPath(uploadId));
                EnsureRestrictedDirectory(GetPartsPath(uploadId));
                await CreatePreallocatedWorkingFileAsync(
                    GetWorkingFilePath(uploadId, record),
                    dto.TotalBytes,
                    cancellationToken);
                await File.WriteAllBytesAsync(
                    GetPartBitmapPath(uploadId),
                    CreatePartBitmapBytes(totalParts),
                    cancellationToken);
                RestrictFile(GetPartBitmapPath(uploadId));
                await SaveSessionAsync(record, cancellationToken);
            },
            _ => ErrorDetail.Create(ErrorCode.InfraFailure, "上传会话初始化失败"),
            _logger,
            $"upload-init:{uploadId}");
        if (!initResult.IsSuccess)
        {
            return Result<UploadInitDto>.Failure(initResult.Error);
        }

        return Result<UploadInitDto>.Success(new UploadInitDto
        {
            UploadId = uploadId,
            FileName = record.FileName,
            MimeType = record.MimeType,
            TargetFormat = record.TargetFormat,
            TotalBytes = record.TotalBytes,
            ChunkSize = record.ChunkSize,
            TotalParts = record.TotalParts,
            ExpiresAt = record.ExpiresAt,
            UploadToken = record.UploadToken
        });
    }

    public async Task<Result<UploadStatusDto>> GetUploadStatusAsync(string uploadId, CancellationToken cancellationToken = default)
    {
        RequestUploadSessionCleanup();

        if (!TryNormalizeUploadId(uploadId, out string normalizedUploadId))
        {
            return Result<UploadStatusDto>.Failure(ErrorCode.Validation, "上传会话标识非法");
        }

        var record = await LoadSessionAsync(normalizedUploadId, cancellationToken);
        if (record is null)
        {
            return Result<UploadStatusDto>.Failure(ErrorCode.NotFound, "上传会话不存在或已过期");
        }

        long uploadedBytes = await ResolveUploadedBytesAsync(normalizedUploadId, record, cancellationToken);
        if (record.UploadedBytes != uploadedBytes)
        {
            record.UploadedBytes = uploadedBytes;
            await SaveSessionAsync(record, cancellationToken);
        }

        return Result<UploadStatusDto>.Success(new UploadStatusDto
        {
            UploadId = record.UploadId,
            Status = record.Status,
            TotalBytes = record.TotalBytes,
            UploadedBytes = uploadedBytes,
            ChunkSize = record.ChunkSize,
            TotalParts = record.TotalParts,
            UploadedPartCount = UploadedParts(record).Count,
            NextPartHint = ResolveNextPartHint(record),
            ExpiresAt = record.ExpiresAt
        });
    }

    public async Task<Result<UploadPartMapDto>> GetUploadPartMapAsync(string uploadId, CancellationToken cancellationToken = default)
    {
        RequestUploadSessionCleanup();

        if (!TryNormalizeUploadId(uploadId, out string normalizedUploadId))
        {
            return Result<UploadPartMapDto>.Failure(ErrorCode.Validation, "上传会话标识非法");
        }

        var record = await LoadSessionAsync(normalizedUploadId, cancellationToken);
        if (record is null)
        {
            return Result<UploadPartMapDto>.Failure(ErrorCode.NotFound, "上传会话不存在或已过期");
        }

        return Result<UploadPartMapDto>.Success(new UploadPartMapDto
        {
            UploadId = record.UploadId,
            UploadedRanges = BuildUploadedRanges(UploadedParts(record))
        });
    }

    public async Task<bool> ValidateUploadSessionTokenAsync(string uploadId, string? uploadToken, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(uploadToken) ||
            !TryNormalizeUploadId(uploadId, out string normalizedUploadId))
        {
            return false;
        }

        var record = await LoadSessionAsync(normalizedUploadId, cancellationToken);
        if (record is null || string.IsNullOrWhiteSpace(record.UploadToken))
        {
            return false;
        }

        byte[] expected = Encoding.UTF8.GetBytes(record.UploadToken);
        byte[] provided = Encoding.UTF8.GetBytes(uploadToken.Trim());
        return expected.Length == provided.Length && CryptographicOperations.FixedTimeEquals(expected, provided);
    }

    public async Task<Result<UploadPartAckDto>> UploadPartAsync(
        string uploadId,
        int partNumber,
        long offset,
        IFormFile part,
        string? payloadHash,
        CancellationToken cancellationToken = default)
    {
        if (part == null || part.Length == 0)
        {
            return Result<UploadPartAckDto>.Failure(ErrorCode.Validation, "上传分片为空");
        }

        if (!TryNormalizeUploadId(uploadId, out string normalizedUploadId))
        {
            return Result<UploadPartAckDto>.Failure(ErrorCode.Validation, "上传会话标识非法");
        }

        await using SessionLockLease sessionLock = await AcquireSessionLockAsync(normalizedUploadId, cancellationToken);
        try
        {
            var record = await LoadSessionAsync(normalizedUploadId, cancellationToken);
            if (record is null)
            {
                RetireSessionLock(normalizedUploadId);
                return Result<UploadPartAckDto>.Failure(ErrorCode.NotFound, "上传会话不存在或已过期");
            }

            if (partNumber < 0 || partNumber >= record.TotalParts)
            {
                return Result<UploadPartAckDto>.Failure(ErrorCode.Validation, "分片索引非法");
            }

            long expectedOffset = (long)partNumber * record.ChunkSize;
            if (offset != expectedOffset)
            {
                return Result<UploadPartAckDto>.Failure(ErrorCode.Conflict, "分片偏移与会话配置不一致");
            }

            long expectedPartBytes = GetExpectedPartSize(record, partNumber);
            if (part.Length != expectedPartBytes)
            {
                return Result<UploadPartAckDto>.Failure(ErrorCode.Conflict, "分片大小与会话配置不一致");
            }

            if (!string.IsNullOrWhiteSpace(payloadHash) && !IsValidSha256(payloadHash))
            {
                return Result<UploadPartAckDto>.Failure(ErrorCode.Validation, "分片哈希格式不正确");
            }

            string expectedPayloadHash = NormalizeHash(payloadHash);
            bool usesWorkingFile = UsesRandomAccessWorkingFile(record);
            string partPath = GetPartPath(normalizedUploadId, partNumber);
            Result<string> writeResult = await BoundaryExecutor.ExecuteResultAsync(
                async () => usesWorkingFile
                    ? await WritePartToWorkingFileAndComputeHashAsync(
                        part,
                        GetWorkingFilePath(normalizedUploadId, record),
                        expectedOffset,
                        record.TotalBytes,
                        computeHash: expectedPayloadHash.Length > 0,
                        cancellationToken)
                    : await WritePartAndComputeHashAsync(
                        part,
                        partPath,
                        computeHash: expectedPayloadHash.Length > 0,
                        cancellationToken),
                _ => ErrorDetail.Create(ErrorCode.InfraFailure, "分片写入失败"),
                _logger,
                $"upload-part:{normalizedUploadId}:{partNumber}");
            if (!writeResult.IsSuccess)
            {
                return Result<UploadPartAckDto>.Failure(writeResult.Error);
            }

            if (expectedPayloadHash.Length > 0
                && !writeResult.Value!.Equals(expectedPayloadHash, StringComparison.OrdinalIgnoreCase))
            {
                if (!usesWorkingFile)
                {
                    File.Delete(partPath);
                }

                return Result<UploadPartAckDto>.Failure(ErrorCode.Validation, "分片校验失败");
            }

            List<int> uploadedParts = EnsureUploadedParts(record);
            string previousStatus = record.Status;
            bool isNewPart = !uploadedParts.Contains(partNumber);
            if (isNewPart)
            {
                uploadedParts.Add(partNumber);
                record.UploadedBytes += part.Length;
                if (usesWorkingFile)
                {
                    await PersistUploadedPartBitAsync(normalizedUploadId, record, partNumber, cancellationToken);
                }
            }

            record.Status = uploadedParts.Count >= record.TotalParts ? "uploaded" : "uploading";
            record.ExpiresAt = DateTime.UtcNow.Add(s_sessionTtl);
            if (!isNewPart && record.UploadedBytes == 0 && uploadedParts.Count > 0)
            {
                record.UploadedBytes = await ResolveUploadedBytesAsync(normalizedUploadId, record, cancellationToken);
            }

            if (!usesWorkingFile || ShouldCheckpointManifest(record, isNewPart, previousStatus))
            {
                UpdateManifestCheckpoint(record);
                await SaveSessionAsync(record, cancellationToken);
            }

            return Result<UploadPartAckDto>.Success(new UploadPartAckDto
            {
                UploadId = normalizedUploadId,
                PartNumber = partNumber,
                Offset = offset,
                Size = checked((int)part.Length),
                UploadedBytes = record.UploadedBytes,
                UploadedPartCount = uploadedParts.Count
            });
        }
        finally
        {
        }
    }

    public async Task<Result<UploadCompleteDto>> CompleteUploadAsync(string uploadId, string? sha256, CancellationToken cancellationToken = default)
    {
        if (!TryNormalizeUploadId(uploadId, out string normalizedUploadId))
        {
            return Result<UploadCompleteDto>.Failure(ErrorCode.Validation, "上传会话标识非法");
        }

        await using SessionLockLease sessionLock = await AcquireSessionLockAsync(normalizedUploadId, cancellationToken);
        try
        {
            var record = await LoadSessionAsync(normalizedUploadId, cancellationToken);
            if (record is null)
            {
                CommittedUploadResolution committed = await TryResolveCommittedUploadAsync(
                    normalizedUploadId,
                    NormalizeHash(sha256),
                    cancellationToken);
                RetireSessionLock(normalizedUploadId);
                if (committed.Found)
                {
                    return committed.Result;
                }

                return Result<UploadCompleteDto>.Failure(ErrorCode.NotFound, "上传会话不存在或已过期");
            }

            IReadOnlyList<int> uploadedParts = UploadedParts(record);
            if (uploadedParts.Count != record.TotalParts)
            {
                return Result<UploadCompleteDto>.Failure(ErrorCode.Conflict, "上传尚未完成，无法合并成品");
            }

            bool usesWorkingFile = UsesRandomAccessWorkingFile(record);
            int[] orderedParts = [.. uploadedParts.OrderBy(static value => value)];
            if (!usesWorkingFile)
            {
                foreach (int partNumber in orderedParts)
                {
                    string partPath = GetPartPath(normalizedUploadId, partNumber);
                    if (!File.Exists(partPath))
                    {
                        return Result<UploadCompleteDto>.Failure(ErrorCode.Validation, "上传分片不完整");
                    }
                }
            }

            string extension = "." + record.TargetFormat.TrimStart('.').ToLowerInvariant();
            string fileName = $"{normalizedUploadId}{extension}";
            string finalPath = Path.Combine(_folderPath, fileName);
            string relativeUrl = $"{_cleanSubFolderWeb}/{fileName}";
            string tempPath = Path.Combine(GetSessionPath(normalizedUploadId), $"assembled{extension}");
            string expectedHash = NormalizeHash(sha256);
            if (expectedHash.Length == 0)
            {
                expectedHash = NormalizeHash(record.Sha256);
            }

            string sourcePath = usesWorkingFile ? GetWorkingFilePath(normalizedUploadId, record) : tempPath;
            Result<AssembledUploadFile> assembleResult = await BoundaryExecutor.ExecuteResultAsync(
                async () => usesWorkingFile
                    ? await AnalyzeWorkingUploadAsync(
                        sourcePath,
                        computeHash: true,
                        cancellationToken)
                    : await AssembleUploadAsync(
                        normalizedUploadId,
                        orderedParts,
                        tempPath,
                        computeHash: true,
                        cancellationToken),
                _ => ErrorDetail.Create(ErrorCode.InfraFailure, "上传文件合并失败"),
                _logger,
                $"upload-complete:{normalizedUploadId}");
            if (!assembleResult.IsSuccess)
            {
                return Result<UploadCompleteDto>.Failure(assembleResult.Error);
            }

            AssembledUploadFile assembled = assembleResult.Value!;
            if (expectedHash.Length > 0
                && !assembled.Sha256.Equals(expectedHash, StringComparison.OrdinalIgnoreCase))
            {
                DeleteLegacyAssembledTempIfNeeded(usesWorkingFile, tempPath);
                return Result<UploadCompleteDto>.Failure(ErrorCode.Validation, "上传文件校验失败");
            }

            if (assembled.Length != record.TotalBytes)
            {
                DeleteLegacyAssembledTempIfNeeded(usesWorkingFile, tempPath);
                return Result<UploadCompleteDto>.Failure(ErrorCode.Conflict, "合并文件大小异常");
            }

            if (!ValidateImageSignature(assembled.Header.AsSpan(0, assembled.HeaderLength), record.TargetFormat))
            {
                DeleteLegacyAssembledTempIfNeeded(usesWorkingFile, tempPath);
                return Result<UploadCompleteDto>.Failure(ErrorCode.Validation, "文件签名与目标格式不一致");
            }

            Result<UploadCompleteDto> commit = await CommitVerifiedUploadAsync(
                normalizedUploadId,
                sourcePath,
                finalPath,
                relativeUrl,
                record.MimeType,
                assembled,
                record.TargetFormat,
                cancellationToken);
            if (!commit.IsSuccess)
            {
                return commit;
            }

            await DeleteSessionDirectoryAsync(normalizedUploadId);
            return commit;
        }
        finally
        {
        }
    }

    private async Task<Result<UploadCompleteDto>> CommitVerifiedUploadAsync(
        string uploadId,
        string sourcePath,
        string finalPath,
        string relativeUrl,
        string mimeType,
        AssembledUploadFile assembled,
        string targetFormat,
        CancellationToken cancellationToken)
    {
        string commitTempRoot = GetUploadCommitTempRoot();
        string commitTempPath = Path.Combine(
            commitTempRoot,
            $"{uploadId}.{targetFormat}.{Path.GetRandomFileName()}.tmp");
        EnsureRestrictedDirectory(commitTempRoot);
        try
        {
            await CopyFileDurablyAsync(sourcePath, commitTempPath, cancellationToken);
            try
            {
                File.Move(commitTempPath, finalPath, overwrite: false);
            }
            catch (IOException) when (File.Exists(finalPath))
            {
                CommittedUploadResolution concurrentCommit = await TryResolveCommittedUploadAsync(
                    uploadId,
                    assembled.Sha256,
                    cancellationToken);
                if (!concurrentCommit.Found)
                {
                    return Result<UploadCompleteDto>.Failure(ErrorCode.Conflict, "上传成品路径已被不同内容占用");
                }

                return concurrentCommit.Result;
            }

            return Result<UploadCompleteDto>.Success(new UploadCompleteDto
            {
                UploadId = uploadId,
                Url = relativeUrl,
                RelativeUrl = relativeUrl,
                MimeType = mimeType,
                TotalBytes = assembled.Length
            });
        }
        catch (IOException exception)
        {
            _logger.LogError(exception, "Atomic upload commit failed for {UploadId}", uploadId);
            return Result<UploadCompleteDto>.Failure(ErrorCode.InfraFailure, "上传成品原子提交失败");
        }
        catch (UnauthorizedAccessException exception)
        {
            _logger.LogError(exception, "Atomic upload commit was denied for {UploadId}", uploadId);
            return Result<UploadCompleteDto>.Failure(ErrorCode.InfraFailure, "上传成品原子提交失败");
        }
        finally
        {
            TryDeleteFile(commitTempPath);
        }
    }

    private async Task<CommittedUploadResolution> TryResolveCommittedUploadAsync(
        string uploadId,
        string expectedSha256,
        CancellationToken cancellationToken)
    {
        string[] candidates = s_allowedExtensions
            .Select(extension => Path.Combine(_folderPath, uploadId + extension))
            .Where(File.Exists)
            .ToArray();
        if (candidates.Length == 0)
        {
            return CommittedUploadResolution.NotFound;
        }

        if (candidates.Length != 1)
        {
            return new CommittedUploadResolution(
                true,
                Result<UploadCompleteDto>.Failure(ErrorCode.Conflict, "上传成品存在多个冲突版本"));
        }

        string finalPath = candidates[0];
        string extension = NormalizeExtension(Path.GetExtension(finalPath));
        string format = extension.TrimStart('.');
        if (!await ValidateImageSignatureAsync(finalPath, format, cancellationToken))
        {
            return new CommittedUploadResolution(
                true,
                Result<UploadCompleteDto>.Failure(ErrorCode.Conflict, "已提交上传成品签名无效"));
        }

        if (expectedSha256.Length > 0)
        {
            if (expectedSha256.Length != 64
                || expectedSha256.Any(static character => !char.IsAsciiHexDigit(character)))
            {
                return new CommittedUploadResolution(
                    true,
                    Result<UploadCompleteDto>.Failure(ErrorCode.Validation, "上传文件校验值格式非法"));
            }

            string actualSha256 = await ComputeSha256Async(finalPath, cancellationToken);
            if (!string.Equals(actualSha256, expectedSha256, StringComparison.OrdinalIgnoreCase))
            {
                return new CommittedUploadResolution(
                    true,
                    Result<UploadCompleteDto>.Failure(ErrorCode.Conflict, "上传成品路径已被不同内容占用"));
            }
        }

        string relativeUrl = $"{_cleanSubFolderWeb}/{Path.GetFileName(finalPath)}";
        return new CommittedUploadResolution(
            true,
            Result<UploadCompleteDto>.Success(new UploadCompleteDto
            {
                UploadId = uploadId,
                Url = relativeUrl,
                RelativeUrl = relativeUrl,
                MimeType = MimeTypeForExtension(extension),
                TotalBytes = new FileInfo(finalPath).Length
            }));
    }

    private string GetUploadCommitTempRoot()
    {
        string slot = NormalizeStorageIdentity(Environment.GetEnvironmentVariable("FSUSBLOG_RELEASE_SLOT"), "local");
        string release = NormalizeStorageIdentity(Environment.GetEnvironmentVariable("FSUSBLOG_RELEASE_ID"), "development");
        string generation = NormalizeStorageIdentity(
            Environment.GetEnvironmentVariable("FSUSBLOG_DEPLOYMENT_GENERATION"),
            Environment.ProcessId.ToString(CultureInfo.InvariantCulture));
        return Path.Combine(_folderPath, UploadCommitTempDirectoryName, $"{slot}-{release}-{generation}-{Environment.ProcessId}");
    }

    private static string NormalizeStorageIdentity(string? value, string fallback)
    {
        string candidate = string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
        return candidate.Length <= 128
            && candidate.All(static character => char.IsAsciiLetterOrDigit(character)
                || character is '.' or '_' or '-')
            ? candidate
            : fallback;
    }

    private static string MimeTypeForExtension(string extension)
        => extension.ToLowerInvariant() switch
        {
            ".jpg" or ".jpeg" => "image/jpeg",
            ".png" => "image/png",
            ".gif" => "image/gif",
            ".webp" => "image/webp",
            ".ico" => "image/x-icon",
            _ => "application/octet-stream"
        };

    private static async Task CopyFileDurablyAsync(
        string sourcePath,
        string destinationPath,
        CancellationToken cancellationToken)
    {
        await using var source = new FileStream(sourcePath, new FileStreamOptions
        {
            Mode = FileMode.Open,
            Access = FileAccess.Read,
            Share = FileShare.Read,
            BufferSize = UploadStreamBufferSize,
            Options = FileOptions.Asynchronous | FileOptions.SequentialScan
        });
        await using var destination = new FileStream(destinationPath, CreatePrivateWriteOptions(FileMode.CreateNew));
        await source.CopyToAsync(destination, UploadStreamBufferSize, cancellationToken);
        await destination.FlushAsync(cancellationToken);
        destination.Flush(flushToDisk: true);
    }

    private static void TryDeleteFile(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // A later instance-scoped cleanup lease removes crash leftovers.
        }
    }

    private readonly record struct CommittedUploadResolution(
        bool Found,
        Result<UploadCompleteDto> Result)
    {
        public static CommittedUploadResolution NotFound
        {
            get;
        }
            = new(false, default);
    }

    private static IReadOnlyList<int> UploadedParts(UploadSessionRecord record)
        => record.UploadedParts is null ? Array.Empty<int>() : record.UploadedParts;

    private static List<int> EnsureUploadedParts(UploadSessionRecord record)
        => record.UploadedParts ??= [];

    private static int ResolveNextPartHint(UploadSessionRecord record)
    {
        IReadOnlyList<int> uploadedParts = UploadedParts(record);
        if (uploadedParts.Count == 0)
        {
            return 0;
        }

        HashSet<int> uploaded = [.. uploadedParts];
        for (int partNumber = 0; partNumber < record.TotalParts; partNumber++)
        {
            if (!uploaded.Contains(partNumber))
            {
                return partNumber;
            }
        }

        return record.TotalParts;
    }

    private static List<UploadPartRangeDto> BuildUploadedRanges(IReadOnlyCollection<int> uploadedParts)
    {
        if (uploadedParts.Count == 0)
        {
            return [];
        }

        int[] ordered = [.. uploadedParts.OrderBy(static value => value)];
        var ranges = new List<UploadPartRangeDto>();
        int start = ordered[0];
        int end = ordered[0];

        for (int i = 1; i < ordered.Length; i++)
        {
            int current = ordered[i];
            if (current == end + 1)
            {
                end = current;
                continue;
            }

            ranges.Add(new UploadPartRangeDto(start, end));
            start = current;
            end = current;
        }

        ranges.Add(new UploadPartRangeDto(start, end));
        return ranges;
    }

    public async Task<Result<bool>> AbortUploadAsync(string uploadId, CancellationToken cancellationToken = default)
    {
        if (!TryNormalizeUploadId(uploadId, out string normalizedUploadId))
        {
            return Result<bool>.Failure(ErrorCode.Validation, "上传会话标识非法");
        }

        await using SessionLockLease sessionLock = await AcquireSessionLockAsync(normalizedUploadId, cancellationToken);
        string sessionPath = GetSessionPath(normalizedUploadId);
        if (!Directory.Exists(sessionPath))
        {
            RetireSessionLock(normalizedUploadId);
            return Result<bool>.Failure(ErrorCode.NotFound, "上传会话不存在");
        }

        await DeleteSessionDirectoryAsync(normalizedUploadId);
        return Result<bool>.Success(true);
    }

    public Task<bool> DeleteImageAsync(string imageUrl)
    {
        if (string.IsNullOrEmpty(imageUrl))
        {
            return Task.FromResult(false);
        }

        if (!ArticleAssetUrlNormalizer.TryNormalize(imageUrl, out string normalizedUrl))
        {
            LogSecurityWarning(SanitizeLogPath(imageUrl));
            return Task.FromResult(false);
        }

        string expectedPrefix = _cleanSubFolderWeb + "/";
        if (!normalizedUrl.StartsWith(expectedPrefix, StringComparison.OrdinalIgnoreCase))
        {
            LogSecurityWarning(SanitizeLogPath(normalizedUrl));
            return Task.FromResult(false);
        }

        string relativePath = normalizedUrl[expectedPrefix.Length..];
        if (string.IsNullOrWhiteSpace(relativePath) || relativePath.Contains('\0', StringComparison.Ordinal))
        {
            return Task.FromResult(false);
        }

        string filePath = Path.GetFullPath(Path.Combine(_folderPath, relativePath.Replace('/', Path.DirectorySeparatorChar)));
        if (!IsPathWithinDirectory(_sandboxAbsolutePath, filePath))
        {
            LogSecurityWarning(SanitizeLogPath(filePath));
            return Task.FromResult(false);
        }

        return BoundaryExecutor.ExecuteValueAsync(
            () =>
            {
                if (File.Exists(filePath))
                {
                    File.Delete(filePath);
                    LogDeleteSuccess(filePath);
                    return Task.FromResult(true);
                }

                LogFileNotFound(filePath);
                return Task.FromResult(false);
            },
            _ => false,
            _logger,
            $"file-delete:{filePath}",
            LogLevel.Error);
    }

    private static async Task<SessionLockLease> AcquireSessionLockAsync(string uploadId, CancellationToken cancellationToken)
    {
        long started = Stopwatch.GetTimestamp();
        if (!TryNormalizeUploadId(uploadId, out string normalizedUploadId)
            || !string.Equals(uploadId, normalizedUploadId, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Upload session id is invalid.");
        }

        while (true)
        {
            SessionLockEntry entry = s_sessionLocks.GetOrAdd(uploadId, static _ => new SessionLockEntry());
            if (!entry.TryAddReference())
            {
                continue;
            }

            try
            {
                await entry.Semaphore.WaitAsync(cancellationToken);
                FsusObservability.RecordUploadSessionLockAcquire(s_sessionLocks.Count, Stopwatch.GetElapsedTime(started));
                return new SessionLockLease(uploadId, entry);
            }
            catch
            {
                ReleaseSessionLock(uploadId, entry, releaseSemaphore: false);
                throw;
            }
        }
    }

    private string GetSessionPath(string uploadId)
    {
        if (!TryNormalizeUploadId(uploadId, out string normalizedUploadId)
            || !string.Equals(uploadId, normalizedUploadId, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Upload session id is invalid.");
        }

        string sessionPath = Path.GetFullPath(Path.Combine(_sessionRootPath, normalizedUploadId));
        if (!IsPathUnderSessionRoot(sessionPath))
        {
            throw new InvalidOperationException("upload session path escaped sandbox.");
        }

        return sessionPath;
    }

    private string GetExpirationBucketPath(DateTime expiresAtUtc)
    {
        string bucket = expiresAtUtc.ToUniversalTime().ToString(ExpirationBucketFormat, CultureInfo.InvariantCulture);
        string bucketPath = Path.GetFullPath(Path.Combine(_expirationIndexRootPath, bucket));
        if (!IsPathUnderSessionRoot(bucketPath))
        {
            throw new InvalidOperationException("upload expiration index path escaped sandbox.");
        }

        return bucketPath;
    }

    private string GetExpirationIndexPath(string uploadId, DateTime expiresAtUtc)
    {
        if (!TryNormalizeUploadId(uploadId, out string normalizedUploadId)
            || !string.Equals(uploadId, normalizedUploadId, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Upload session id is invalid.");
        }

        string indexPath = Path.GetFullPath(Path.Combine(GetExpirationBucketPath(expiresAtUtc), normalizedUploadId));
        if (!IsPathUnderSessionRoot(indexPath))
        {
            throw new InvalidOperationException("upload expiration index path escaped sandbox.");
        }

        return indexPath;
    }

    private async Task WriteExpirationIndexAsync(UploadSessionRecord record, CancellationToken cancellationToken)
    {
        string indexPath = GetExpirationIndexPath(record.UploadId, record.ExpiresAt);
        EnsureRestrictedDirectory(Path.GetDirectoryName(indexPath)!);
        await File.WriteAllBytesAsync(indexPath, Array.Empty<byte>(), cancellationToken);
        RestrictFile(indexPath);
    }

    private void DeleteExpirationIndexes(string uploadId)
    {
        if (!Directory.Exists(_expirationIndexRootPath)
            || !TryNormalizeUploadId(uploadId, out string normalizedUploadId))
        {
            return;
        }

        foreach (string bucketPath in Directory.EnumerateDirectories(_expirationIndexRootPath))
        {
            string fullBucketPath = Path.GetFullPath(bucketPath);
            if (!IsPathUnderSessionRoot(fullBucketPath))
            {
                continue;
            }

            string indexPath = Path.Combine(fullBucketPath, normalizedUploadId);
            if (File.Exists(indexPath))
            {
                File.Delete(indexPath);
            }

            DeleteDirectoryIfEmpty(fullBucketPath);
        }
    }

    private string GetPartsPath(string uploadId) => GetSessionChildPath(uploadId, "parts");
    private string GetManifestPath(string uploadId) => GetSessionChildPath(uploadId, "manifest.aeds");
    private string GetPartBitmapPath(string uploadId) => GetSessionChildPath(uploadId, UploadPartBitmapFileName);
    private string GetPartPath(string uploadId, int partNumber)
        => GetSessionChildPath(uploadId, Path.Combine("parts", $"{partNumber:D8}.part"));
    private string GetWorkingFilePath(string uploadId, UploadSessionRecord record)
        => GetSessionChildPath(uploadId, string.IsNullOrWhiteSpace(record.WorkingFileName)
            ? WorkingUploadFileName
            : record.WorkingFileName);

    private string GetSessionChildPath(string uploadId, string relativePath)
    {
        string childPath = Path.GetFullPath(Path.Combine(GetSessionPath(uploadId), relativePath));
        if (!IsPathUnderSessionRoot(childPath))
        {
            throw new InvalidOperationException("upload session child path escaped sandbox.");
        }

        return childPath;
    }

    private static void EnsureRestrictedDirectory(string path)
    {
        Directory.CreateDirectory(path);
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(
                path,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
    }

    private static FileStreamOptions CreatePrivateWriteOptions(FileMode mode)
    {
        var options = new FileStreamOptions
        {
            Mode = mode,
            Access = FileAccess.Write,
            Share = FileShare.None,
            BufferSize = UploadStreamBufferSize,
            Options = FileOptions.Asynchronous
        };
        if (!OperatingSystem.IsWindows())
        {
            options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        }

        return options;
    }

    private static void RestrictFile(string path)
    {
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
    }

    private bool IsPathUnderSessionRoot(string path)
        => path.StartsWith(_sessionRootAbsolutePath, StringComparison.OrdinalIgnoreCase);

    private static bool TryNormalizeUploadId(string? uploadId, out string normalizedUploadId)
    {
        normalizedUploadId = string.Empty;
        if (string.IsNullOrWhiteSpace(uploadId))
        {
            return false;
        }

        string candidate = uploadId.Trim();
        if (candidate.Length > 64 || candidate.Contains('\0', StringComparison.Ordinal))
        {
            return false;
        }

        if (!Guid.TryParseExact(candidate, "N", out Guid parsed) || parsed == Guid.Empty)
        {
            return false;
        }

        normalizedUploadId = parsed.ToString("N");
        return true;
    }

    private static string CreateUploadSessionToken()
        => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));

    private static string NormalizeHash(string? value)
        => TextHelpers.LowerTrimmed(value) ?? string.Empty;

    private static string NormalizeExtension(string? ext)
    {
        if (string.IsNullOrWhiteSpace(ext))
        {
            return string.Empty;
        }

        string value = TextHelpers.LowerTrimmed(ext) ?? string.Empty;
        return value.StartsWith(".", StringComparison.Ordinal) ? value : "." + value;
    }

    private static bool IsAllowedExtension(string extension)
        => s_allowedExtensions.Contains(extension, StringComparer.OrdinalIgnoreCase);

    private static bool IsSupportedImageMime(string? mimeType)
    {
        if (string.IsNullOrWhiteSpace(mimeType))
        {
            return false;
        }

        return (TextHelpers.LowerTrimmed(mimeType) ?? string.Empty) switch
        {
            "image/jpeg" => true,
            "image/png" => true,
            "image/gif" => true,
            "image/webp" => true,
            "image/x-icon" => true,
            "image/vnd.microsoft.icon" => true,
            _ => false
        };
    }

    private static bool IsMimeCompatibleWithFormat(string? mimeType, string format)
    {
        if (string.IsNullOrWhiteSpace(mimeType))
        {
            return true;
        }

        string normalizedMime = TextHelpers.LowerTrimmed(mimeType) ?? string.Empty;
        string expected = format.ToLowerInvariant() switch
        {
            "jpg" or "jpeg" => "image/jpeg",
            "png" => "image/png",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "ico" => normalizedMime is "image/x-icon" or "image/vnd.microsoft.icon"
                ? normalizedMime
                : "image/x-icon",
            _ => string.Empty
        };

        return expected.Length > 0 && string.Equals(normalizedMime, expected, StringComparison.OrdinalIgnoreCase);
    }

    private static long GetExpectedPartSize(UploadSessionRecord record, int partNumber)
    {
        long offset = (long)partNumber * record.ChunkSize;
        long remaining = record.TotalBytes - offset;
        return Math.Clamp(remaining, 0, record.ChunkSize);
    }

    private static bool IsValidSha256(string value)
    {
        string hash = value.Trim();
        if (hash.Length != 64)
        {
            return false;
        }

        foreach (char c in hash)
        {
            bool isHex = (c >= '0' && c <= '9')
                || (c >= 'a' && c <= 'f')
                || (c >= 'A' && c <= 'F');
            if (!isHex)
            {
                return false;
            }
        }

        return true;
    }

    private static string NormalizeFormat(string? targetFormat, string fileName, string mimeType)
    {
        string candidate = string.IsNullOrWhiteSpace(targetFormat)
            ? Path.GetExtension(fileName).TrimStart('.')
            : targetFormat.Trim().TrimStart('.');

        if (candidate.Length == 0 && mimeType.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
        {
            candidate = mimeType["image/".Length..];
        }

        candidate = candidate.ToLowerInvariant();
        return s_allowedFormats.Contains(candidate, StringComparer.OrdinalIgnoreCase) ? candidate : string.Empty;
    }

    private async Task<UploadSessionRecord?> LoadSessionAsync(string uploadId, CancellationToken cancellationToken)
    {
        string manifestPath = GetManifestPath(uploadId);
        if (!File.Exists(manifestPath))
        {
            RetireSessionLock(uploadId);
            return null;
        }

        UploadSessionRecord? record = await ReadSessionAsync(manifestPath, cancellationToken);
        if (record is null
            || !TryNormalizeUploadId(record.UploadId, out string recordUploadId)
            || !string.Equals(recordUploadId, uploadId, StringComparison.Ordinal)
            || record.ExpiresAt <= DateTime.UtcNow)
        {
            await DeleteSessionDirectoryAsync(uploadId);
            return null;
        }

        if (UsesRandomAccessWorkingFile(record))
        {
            await RefreshUploadedPartsFromBitmapSidecarAsync(uploadId, record, cancellationToken);
        }

        return record;
    }

    private async Task SaveSessionAsync(UploadSessionRecord record, CancellationToken cancellationToken)
    {
        if (!TryNormalizeUploadId(record.UploadId, out string normalizedUploadId))
        {
            throw new InvalidOperationException("Upload session id is invalid.");
        }

        string manifestPath = GetManifestPath(normalizedUploadId);
        string manifestDirectory = Path.GetDirectoryName(manifestPath)!;
        string tempPath = Path.Combine(
            manifestDirectory,
            $"{Path.GetFileName(manifestPath)}.{Path.GetRandomFileName()}.tmp");
        UploadSessionRecord normalizedRecord = record with
        {
            UploadId = normalizedUploadId
        };
        byte[] payload = EncodeSession(normalizedRecord);
        try
        {
            await using (var stream = new FileStream(tempPath, CreatePrivateWriteOptions(FileMode.CreateNew)))
            {
                await stream.WriteAsync(payload, cancellationToken);
            }

            if (File.Exists(manifestPath))
            {
                File.Replace(tempPath, manifestPath, null);
            }
            else
            {
                File.Move(tempPath, manifestPath);
            }

            RestrictFile(manifestPath);
            await WriteExpirationIndexAsync(normalizedRecord, cancellationToken);
        }
        finally
        {
            if (File.Exists(tempPath))
            {
                File.Delete(tempPath);
            }
        }
    }

    private async Task<long> GetUploadedBytesAsync(string uploadId, IEnumerable<int> parts, CancellationToken cancellationToken)
    {
        long total = 0;
        foreach (int part in parts)
        {
            cancellationToken.ThrowIfCancellationRequested();
            string path = GetPartPath(uploadId, part);
            if (File.Exists(path))
            {
                total += new FileInfo(path).Length;
            }
        }

        return total;
    }

    private async Task<UploadSessionRecord?> ReadSessionAsync(string manifestPath, CancellationToken cancellationToken)
    {
        byte[] payload = await File.ReadAllBytesAsync(manifestPath, cancellationToken);
        return DecodeSession(payload);
    }

    private static byte[] EncodeSession(UploadSessionRecord record)
    {
        IReadOnlyList<int> uploadedParts = UsesRandomAccessWorkingFile(record)
            ? Array.Empty<int>()
            : UploadedParts(record);
        byte[] uploadId = Encoding.UTF8.GetBytes(record.UploadId);
        byte[] fileName = Encoding.UTF8.GetBytes(record.FileName);
        byte[] mimeType = Encoding.UTF8.GetBytes(record.MimeType);
        byte[] targetFormat = Encoding.UTF8.GetBytes(record.TargetFormat);
        byte[] sha256 = Encoding.UTF8.GetBytes(record.Sha256 ?? string.Empty);
        byte[] status = Encoding.UTF8.GetBytes(record.Status);
        byte[] uploadToken = Encoding.UTF8.GetBytes(record.UploadToken);
        byte[] workingFileName = Encoding.UTF8.GetBytes(record.WorkingFileName);
        byte[] uploadedPartBitmap = Encoding.UTF8.GetBytes(record.UploadedPartBitmapBase64);
        int length = 4 + 1 + 8 + 4 + 4 + 8 + 8 + 8 + 4
            + uploadedParts.Count * sizeof(int)
            + sizeof(int)
            + (2 + uploadId.Length)
            + (2 + fileName.Length)
            + (2 + mimeType.Length)
            + (2 + targetFormat.Length)
            + (2 + sha256.Length)
            + (2 + status.Length)
            + (2 + uploadToken.Length)
            + (2 + workingFileName.Length)
            + (2 + uploadedPartBitmap.Length);
        byte[] bytes = new byte[length];
        Span<byte> span = bytes;
        BinaryPrimitives.WriteUInt32LittleEndian(span[..4], UploadSessionMagic);
        span[4] = UploadSessionVersion;
        BinaryPrimitives.WriteInt64LittleEndian(span[5..13], record.TotalBytes);
        BinaryPrimitives.WriteInt32LittleEndian(span[13..17], record.ChunkSize);
        BinaryPrimitives.WriteInt32LittleEndian(span[17..21], record.TotalParts);
        BinaryPrimitives.WriteInt64LittleEndian(span[21..29], record.CreatedAt.ToUniversalTime().Ticks);
        BinaryPrimitives.WriteInt64LittleEndian(span[29..37], record.ExpiresAt.ToUniversalTime().Ticks);
        BinaryPrimitives.WriteInt64LittleEndian(span[37..45], record.UploadedBytes);
        BinaryPrimitives.WriteInt32LittleEndian(span[45..49], uploadedParts.Count);
        int offset = 49;
        foreach (int part in uploadedParts)
        {
            BinaryPrimitives.WriteInt32LittleEndian(span[offset..(offset + sizeof(int))], part);
            offset += sizeof(int);
        }

        WriteSessionString(bytes, ref offset, uploadId);
        WriteSessionString(bytes, ref offset, fileName);
        WriteSessionString(bytes, ref offset, mimeType);
        WriteSessionString(bytes, ref offset, targetFormat);
        WriteSessionString(bytes, ref offset, sha256);
        WriteSessionString(bytes, ref offset, status);
        WriteSessionString(bytes, ref offset, uploadToken);
        BinaryPrimitives.WriteInt32LittleEndian(span[offset..(offset + sizeof(int))], record.ManifestCheckpointPartCount);
        offset += sizeof(int);
        WriteSessionString(bytes, ref offset, workingFileName);
        WriteSessionString(bytes, ref offset, uploadedPartBitmap);
        return bytes;
    }

    private static UploadSessionRecord? DecodeSession(byte[] bytes)
    {
        if (bytes.Length < 49 ||
            BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(0, 4)) != UploadSessionMagic ||
            (bytes[4] < 1 || bytes[4] > UploadSessionVersion))
        {
            return null;
        }

        int partCount = BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(45, 4));
        if (partCount < 0 || bytes.Length < 49 + partCount * sizeof(int))
        {
            return null;
        }

        int offset = 49;
        List<int>? parts = partCount == 0 ? null : new List<int>(partCount);
        for (int i = 0; i < partCount; i++)
        {
            parts!.Add(BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(offset, sizeof(int))));
            offset += sizeof(int);
        }

        try
        {
            string uploadId = ReadSessionString(bytes, ref offset);
            string fileName = ReadSessionString(bytes, ref offset);
            string mimeType = ReadSessionString(bytes, ref offset);
            string targetFormat = ReadSessionString(bytes, ref offset);
            string sha256 = ReadSessionString(bytes, ref offset);
            string status = ReadSessionString(bytes, ref offset);
            string uploadToken = bytes[4] >= 2 ? ReadSessionString(bytes, ref offset) : string.Empty;
            int manifestCheckpointPartCount = 0;
            string workingFileName = string.Empty;
            string uploadedPartBitmap = string.Empty;
            if (bytes[4] >= 3)
            {
                if (offset + sizeof(int) > bytes.Length)
                {
                    return null;
                }

                manifestCheckpointPartCount = BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(offset, sizeof(int)));
                offset += sizeof(int);
                workingFileName = ReadSessionString(bytes, ref offset);
                uploadedPartBitmap = ReadSessionString(bytes, ref offset);
            }

            if (offset != bytes.Length || string.IsNullOrWhiteSpace(uploadId))
            {
                return null;
            }

            return new UploadSessionRecord
            {
                UploadId = uploadId,
                FileName = fileName,
                MimeType = mimeType,
                TargetFormat = targetFormat,
                TotalBytes = BinaryPrimitives.ReadInt64LittleEndian(bytes.AsSpan(5, 8)),
                ChunkSize = BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(13, 4)),
                TotalParts = BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(17, 4)),
                CreatedAt = new DateTime(BinaryPrimitives.ReadInt64LittleEndian(bytes.AsSpan(21, 8)), DateTimeKind.Utc),
                ExpiresAt = new DateTime(BinaryPrimitives.ReadInt64LittleEndian(bytes.AsSpan(29, 8)), DateTimeKind.Utc),
                UploadedBytes = BinaryPrimitives.ReadInt64LittleEndian(bytes.AsSpan(37, 8)),
                UploadedParts = parts,
                UploadToken = uploadToken,
                Sha256 = string.IsNullOrWhiteSpace(sha256) ? null : sha256,
                Status = string.IsNullOrWhiteSpace(status) ? "pending" : status,
                WorkingFileName = workingFileName,
                UploadedPartBitmapBase64 = uploadedPartBitmap,
                ManifestCheckpointPartCount = manifestCheckpointPartCount
            };
        }
        catch (ArgumentException)
        {
            return null;
        }
    }

    private static void WriteSessionString(byte[] target, ref int offset, byte[] value)
    {
        if (value.Length > ushort.MaxValue)
        {
            throw new InvalidOperationException("Upload session field too large.");
        }

        BinaryPrimitives.WriteUInt16LittleEndian(target.AsSpan(offset, 2), (ushort)value.Length);
        offset += 2;
        value.CopyTo(target.AsSpan(offset));
        offset += value.Length;
    }

    private static string ReadSessionString(byte[] source, ref int offset)
    {
        if (offset + 2 > source.Length)
        {
            throw new ArgumentException("Upload session truncated.");
        }

        int length = BinaryPrimitives.ReadUInt16LittleEndian(source.AsSpan(offset, 2));
        offset += 2;
        if (offset + length > source.Length)
        {
            throw new ArgumentException("Upload session string truncated.");
        }

        string value = Encoding.UTF8.GetString(source.AsSpan(offset, length));
        offset += length;
        return value;
    }

    private async Task<long> ResolveUploadedBytesAsync(string uploadId, UploadSessionRecord record, CancellationToken cancellationToken)
    {
        IReadOnlyList<int> uploadedParts = UploadedParts(record);
        if (UsesRandomAccessWorkingFile(record))
        {
            long uploadedBytes = 0;
            foreach (int partNumber in uploadedParts)
            {
                cancellationToken.ThrowIfCancellationRequested();
                uploadedBytes += GetExpectedPartSize(record, partNumber);
            }

            return uploadedBytes;
        }

        if (record.UploadedBytes > 0 || uploadedParts.Count == 0)
        {
            return record.UploadedBytes;
        }

        return await GetUploadedBytesAsync(uploadId, uploadedParts, cancellationToken);
    }

    private static bool UsesRandomAccessWorkingFile(UploadSessionRecord record)
        => !string.IsNullOrWhiteSpace(record.WorkingFileName);

    private static byte[] CreatePartBitmapBytes(int totalParts)
        => new byte[(Math.Max(totalParts, 0) + 7) / 8];

    private static string CreatePartBitmapBase64(int totalParts)
        => Convert.ToBase64String(CreatePartBitmapBytes(totalParts));

    private static bool IsPartBitSet(ReadOnlySpan<byte> bitmap, int partNumber)
    {
        int byteIndex = partNumber / 8;
        int bitIndex = partNumber % 8;
        return byteIndex < bitmap.Length && (bitmap[byteIndex] & (1 << bitIndex)) != 0;
    }

    private static void SetPartBit(Span<byte> bitmap, int partNumber)
    {
        int byteIndex = partNumber / 8;
        int bitIndex = partNumber % 8;
        bitmap[byteIndex] = (byte)(bitmap[byteIndex] | (1 << bitIndex));
    }

    private static byte[] DecodePartBitmap(UploadSessionRecord record)
    {
        int bitmapLength = CreatePartBitmapBytes(record.TotalParts).Length;
        byte[] bitmap = CreatePartBitmapBytes(record.TotalParts);
        if (!string.IsNullOrWhiteSpace(record.UploadedPartBitmapBase64))
        {
            try
            {
                byte[] decoded = Convert.FromBase64String(record.UploadedPartBitmapBase64);
                decoded.AsSpan(0, Math.Min(decoded.Length, bitmapLength)).CopyTo(bitmap);
            }
            catch (FormatException)
            {
                // Corrupt v3 bitmap snapshots fall back to the legacy uploaded-parts list below.
            }
        }

        foreach (int partNumber in UploadedParts(record))
        {
            if (partNumber >= 0 && partNumber < record.TotalParts)
            {
                SetPartBit(bitmap, partNumber);
            }
        }

        return bitmap;
    }

    private static List<int> PartsFromBitmap(ReadOnlySpan<byte> bitmap, int totalParts)
    {
        var parts = new List<int>();
        for (int partNumber = 0; partNumber < totalParts; partNumber++)
        {
            if (IsPartBitSet(bitmap, partNumber))
            {
                parts.Add(partNumber);
            }
        }

        return parts;
    }

    private async Task RefreshUploadedPartsFromBitmapSidecarAsync(
        string uploadId,
        UploadSessionRecord record,
        CancellationToken cancellationToken)
    {
        byte[] bitmap = DecodePartBitmap(record);
        string bitmapPath = GetPartBitmapPath(uploadId);
        if (File.Exists(bitmapPath))
        {
            byte[] sidecar = await File.ReadAllBytesAsync(bitmapPath, cancellationToken);
            sidecar.AsSpan(0, Math.Min(sidecar.Length, bitmap.Length)).CopyTo(bitmap);
        }

        record.UploadedParts = PartsFromBitmap(bitmap, record.TotalParts);
        record.UploadedPartBitmapBase64 = Convert.ToBase64String(bitmap);
        if (record.UploadedParts.Count >= record.TotalParts && record.TotalParts > 0)
        {
            record.Status = "uploaded";
        }
        else if (record.UploadedParts.Count > 0 && string.Equals(record.Status, "pending", StringComparison.Ordinal))
        {
            record.Status = "uploading";
        }
    }

    private async Task PersistUploadedPartBitAsync(
        string uploadId,
        UploadSessionRecord record,
        int partNumber,
        CancellationToken cancellationToken)
    {
        byte[] bitmap = DecodePartBitmap(record);
        SetPartBit(bitmap, partNumber);
        record.UploadedPartBitmapBase64 = Convert.ToBase64String(bitmap);
        string bitmapPath = GetPartBitmapPath(uploadId);
        await using var stream = new FileStream(bitmapPath, CreatePrivateReadWriteOptions(FileMode.OpenOrCreate));
        if (stream.Length < bitmap.Length)
        {
            stream.SetLength(bitmap.Length);
        }

        int byteIndex = partNumber / 8;
        stream.Seek(byteIndex, SeekOrigin.Begin);
        await stream.WriteAsync(bitmap.AsMemory(byteIndex, 1), cancellationToken);
        await stream.FlushAsync(cancellationToken);
        RestrictFile(bitmapPath);
    }

    private static bool ShouldCheckpointManifest(
        UploadSessionRecord record,
        bool isNewPart,
        string previousStatus)
        => isNewPart && (
            record.UploadedParts?.Count >= record.TotalParts ||
            (record.UploadedParts?.Count ?? 0) - record.ManifestCheckpointPartCount >= ManifestFlushPartInterval ||
            !string.Equals(previousStatus, record.Status, StringComparison.Ordinal));

    private static void UpdateManifestCheckpoint(UploadSessionRecord record)
    {
        if (!UsesRandomAccessWorkingFile(record))
        {
            return;
        }

        byte[] bitmap = DecodePartBitmap(record);
        record.UploadedPartBitmapBase64 = Convert.ToBase64String(bitmap);
        record.ManifestCheckpointPartCount = UploadedParts(record).Count;
    }

    private static void DeleteLegacyAssembledTempIfNeeded(bool usesWorkingFile, string tempPath)
    {
        if (!usesWorkingFile)
        {
            File.Delete(tempPath);
        }
    }

    internal async Task CleanupExpiredSessionsAsync(
        CancellationToken cancellationToken,
        Func<CancellationToken, Task>? beforeCommit = null)
    {
        long started = Stopwatch.GetTimestamp();
        long scannedSessions = 0;
        long deletedSessions = 0;
        var deletedUploadIds = new List<string>();
        if (!Directory.Exists(_sessionRootPath))
        {
            await CleanupUploadCommitTempsAsync(beforeCommit, cancellationToken).ConfigureAwait(false);
            FsusObservability.RecordUploadSessionCleanup(scannedSessions, deletedSessions, Stopwatch.GetElapsedTime(started));
            return;
        }

        DateTime nowUtc = DateTime.UtcNow;
        foreach (string bucketPath in EnumerateExpiredExpirationBuckets(nowUtc))
        {
            cancellationToken.ThrowIfCancellationRequested();
            foreach (string indexPath in Directory.EnumerateFiles(bucketPath))
            {
                cancellationToken.ThrowIfCancellationRequested();
                string uploadId = Path.GetFileName(indexPath);
                if (!TryNormalizeUploadId(uploadId, out string normalizedUploadId))
                {
                    await EnsureCleanupCommitBoundaryAsync(beforeCommit, cancellationToken).ConfigureAwait(false);
                    File.Delete(indexPath);
                    continue;
                }

                scannedSessions++;
                string sessionPath = GetSessionPath(normalizedUploadId);
                string manifestPath = GetManifestPath(normalizedUploadId);
                if (!File.Exists(manifestPath))
                {
                    await EnsureCleanupCommitBoundaryAsync(beforeCommit, cancellationToken).ConfigureAwait(false);
                    File.Delete(indexPath);
                    continue;
                }

                bool shouldDelete = await BoundaryExecutor.ExecuteValueAsync(
                    async () =>
                    {
                        UploadSessionRecord? record = await ReadSessionAsync(manifestPath, cancellationToken);
                        return record is null || record.ExpiresAt <= nowUtc;
                    },
                    _ => true,
                    _logger,
                    $"cleanup-upload-session:{sessionPath}");
                if (shouldDelete)
                {
                    await DeleteSessionDirectoryAsync(
                        normalizedUploadId,
                        deleteIndexes: false,
                        beforeCommit: beforeCommit,
                        cancellationToken: cancellationToken);
                    if (File.Exists(indexPath))
                    {
                        await EnsureCleanupCommitBoundaryAsync(beforeCommit, cancellationToken).ConfigureAwait(false);
                        File.Delete(indexPath);
                    }

                    deletedUploadIds.Add(normalizedUploadId);
                    deletedSessions++;
                    continue;
                }

                UploadSessionRecord? freshRecord = await ReadSessionAsync(manifestPath, cancellationToken);
                if (freshRecord is not null)
                {
                    await EnsureCleanupCommitBoundaryAsync(beforeCommit, cancellationToken).ConfigureAwait(false);
                    await WriteExpirationIndexAsync(freshRecord, cancellationToken);
                }

                await EnsureCleanupCommitBoundaryAsync(beforeCommit, cancellationToken).ConfigureAwait(false);
                File.Delete(indexPath);
            }

            await EnsureCleanupCommitBoundaryAsync(beforeCommit, cancellationToken).ConfigureAwait(false);
            DeleteDirectoryIfEmpty(bucketPath);
        }

        foreach (string uploadId in deletedUploadIds)
        {
            await EnsureCleanupCommitBoundaryAsync(beforeCommit, cancellationToken).ConfigureAwait(false);
            DeleteExpirationIndexes(uploadId);
        }

        FsusObservability.RecordUploadSessionCleanup(scannedSessions, deletedSessions, Stopwatch.GetElapsedTime(started));

        long lockStarted = Stopwatch.GetTimestamp();
        await EnsureCleanupCommitBoundaryAsync(beforeCommit, cancellationToken).ConfigureAwait(false);
        int disposedLocks = CleanupStaleSessionLocks(DateTimeOffset.UtcNow, out int scannedLocks);
        FsusObservability.RecordUploadSessionLockCleanup(
            s_sessionLocks.Count,
            scannedLocks,
            disposedLocks,
            Stopwatch.GetElapsedTime(lockStarted));

        await CleanupUploadCommitTempsAsync(beforeCommit, cancellationToken).ConfigureAwait(false);
    }

    private async Task CleanupUploadCommitTempsAsync(
        Func<CancellationToken, Task>? beforeCommit,
        CancellationToken cancellationToken)
    {
        string incomingRoot = Path.Combine(_folderPath, UploadCommitTempDirectoryName);
        string currentInstanceDirectoryName = Path.GetFileName(GetUploadCommitTempRoot());
        await using UploadCommitTempCleanupLease? lease = await UploadCommitTempCleanupLease.TryAcquireAsync(
            incomingRoot,
            currentInstanceDirectoryName,
            s_uploadCommitTempCleanupLeaseTtl,
            cancellationToken).ConfigureAwait(false);
        if (lease is null)
        {
            return;
        }

        await lease.ExecuteAsync(
            currentInstanceDirectoryName,
            DateTimeOffset.UtcNow.Subtract(s_uploadCommitTempRetention),
            dryRun: false,
            beforeDelete: async (_, commitToken) =>
            {
                await EnsureCleanupCommitBoundaryAsync(beforeCommit, commitToken).ConfigureAwait(false);
            },
            cancellationToken).ConfigureAwait(false);
    }

    private IEnumerable<string> EnumerateExpiredExpirationBuckets(DateTime nowUtc)
    {
        if (!Directory.Exists(_expirationIndexRootPath))
        {
            yield break;
        }

        foreach (string bucketPath in Directory.EnumerateDirectories(_expirationIndexRootPath))
        {
            string fullBucketPath = Path.GetFullPath(bucketPath);
            if (!IsPathUnderSessionRoot(fullBucketPath))
            {
                continue;
            }

            string bucket = Path.GetFileName(fullBucketPath);
            if (!DateTime.TryParseExact(
                    bucket,
                    ExpirationBucketFormat,
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                    out DateTime bucketUtc))
            {
                continue;
            }

            if (bucketUtc <= TruncateToHour(nowUtc))
            {
                yield return fullBucketPath;
            }
        }
    }

    private static DateTime TruncateToHour(DateTime value)
        => new(value.Year, value.Month, value.Day, value.Hour, 0, 0, DateTimeKind.Utc);

    private static void DeleteDirectoryIfEmpty(string path)
    {
        if (!Directory.Exists(path) || Directory.EnumerateFileSystemEntries(path).Any())
        {
            return;
        }

        Directory.Delete(path);
    }

    private async Task DeleteSessionDirectoryAsync(
        string uploadId,
        bool deleteIndexes = true,
        Func<CancellationToken, Task>? beforeCommit = null,
        CancellationToken cancellationToken = default)
    {
        if (!TryNormalizeUploadId(uploadId, out string normalizedUploadId))
        {
            return;
        }

        uploadId = normalizedUploadId;
        string sessionPath = GetSessionPath(uploadId);
        if (deleteIndexes)
        {
            await EnsureCleanupCommitBoundaryAsync(beforeCommit, cancellationToken).ConfigureAwait(false);
            DeleteExpirationIndexes(uploadId);
        }

        if (Directory.Exists(sessionPath))
        {
            await BoundaryExecutor.ExecuteAsync(
                async () =>
                {
                    await EnsureCleanupCommitBoundaryAsync(beforeCommit, cancellationToken).ConfigureAwait(false);
                    Directory.Delete(sessionPath, true);
                },
                _logger,
                $"upload-session-delete:{sessionPath}");
        }

        RetireSessionLock(uploadId);
    }

    private static Task EnsureCleanupCommitBoundaryAsync(
        Func<CancellationToken, Task>? beforeCommit,
        CancellationToken cancellationToken)
        => beforeCommit is null ? Task.CompletedTask : beforeCommit(cancellationToken);

    private void RequestUploadSessionCleanup()
        => _cleanupQueue?.TryRequestScan();

    private static void RetireSessionLock(string uploadId)
    {
        if (s_sessionLocks.TryGetValue(uploadId, out SessionLockEntry? entry))
        {
            entry.MarkRetired();
            TryDisposeSessionLock(uploadId, entry);
        }
    }

    private static void ReleaseSessionLock(string uploadId, SessionLockEntry entry, bool releaseSemaphore)
    {
        if (releaseSemaphore)
        {
            entry.Semaphore.Release();
        }

        entry.ReleaseReference();
        TryDisposeSessionLock(uploadId, entry);
    }

    private static void TryDisposeSessionLock(string uploadId, SessionLockEntry entry)
    {
        if (!entry.CanDispose)
        {
            return;
        }

        if (s_sessionLocks.TryRemove(new KeyValuePair<string, SessionLockEntry>(uploadId, entry)))
        {
            entry.Dispose();
        }
    }

    internal static int CleanupStaleSessionLocks(DateTimeOffset now)
        => CleanupStaleSessionLocks(now, out _);

    private static int CleanupStaleSessionLocks(DateTimeOffset now, out int scanned)
    {
        DateTimeOffset cutoff = now - s_sessionLockTtl;
        scanned = 0;
        int removed = 0;
        foreach (KeyValuePair<string, SessionLockEntry> pair in s_sessionLocks)
        {
            scanned++;
            if (!pair.Value.IsIdleSince(cutoff))
            {
                continue;
            }

            pair.Value.MarkRetired();
            int before = s_sessionLocks.Count;
            TryDisposeSessionLock(pair.Key, pair.Value);
            if (s_sessionLocks.Count < before)
            {
                removed++;
            }
        }

        return removed;
    }

    internal sealed class SessionLockEntry : IDisposable
    {
        private int _referenceCount;
        private int _retired;
        private int _disposed;
        private long _lastTouchedUtcTicks = DateTimeOffset.UtcNow.UtcTicks;

        public SemaphoreSlim Semaphore { get; } = new(1, 1);

        public bool CanDispose => Volatile.Read(ref _referenceCount) == 0;

        public bool TryAddReference()
        {
            while (true)
            {
                if (Volatile.Read(ref _retired) == 1 || Volatile.Read(ref _disposed) == 1)
                {
                    return false;
                }

                int current = Volatile.Read(ref _referenceCount);
                if (Interlocked.CompareExchange(ref _referenceCount, current + 1, current) != current)
                {
                    continue;
                }

                if (Volatile.Read(ref _retired) == 1 || Volatile.Read(ref _disposed) == 1)
                {
                    ReleaseReference();
                    return false;
                }

                Touch();
                return true;
            }
        }

        public void ReleaseReference()
        {
            Interlocked.Decrement(ref _referenceCount);
            Touch();
        }

        public void MarkRetired()
        {
            Volatile.Write(ref _retired, 1);
            Touch();
        }

        public bool IsIdleSince(DateTimeOffset cutoff)
            => Volatile.Read(ref _referenceCount) == 0 &&
                new DateTimeOffset(Volatile.Read(ref _lastTouchedUtcTicks), TimeSpan.Zero) <= cutoff;

        internal void SetLastTouchedUtcForTests(DateTimeOffset timestamp)
            => Volatile.Write(ref _lastTouchedUtcTicks, timestamp.UtcTicks);

        private void Touch()
            => Volatile.Write(ref _lastTouchedUtcTicks, DateTimeOffset.UtcNow.UtcTicks);

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0)
            {
                Semaphore.Dispose();
            }
        }
    }

    private readonly struct SessionLockLease(string uploadId, SessionLockEntry entry) : IAsyncDisposable
    {
        public ValueTask DisposeAsync()
        {
            ReleaseSessionLock(uploadId, entry, releaseSemaphore: true);
            return ValueTask.CompletedTask;
        }
    }

    private static async Task<string> ComputeSha256Async(string filePath, CancellationToken cancellationToken)
    {
        await using var stream = new FileStream(filePath, new FileStreamOptions
        {
            Mode = FileMode.Open,
            Access = FileAccess.Read,
            Share = FileShare.Read,
            BufferSize = 81920,
            Options = FileOptions.Asynchronous
        });
        byte[] hash = await SHA256.HashDataAsync(stream, cancellationToken);
        return Convert.ToHexStringLower(hash);
    }

    private static async Task CreatePreallocatedWorkingFileAsync(
        string workingFilePath,
        long totalBytes,
        CancellationToken cancellationToken)
    {
        await using var stream = new FileStream(workingFilePath, CreatePrivateReadWriteOptions(FileMode.Create));
        stream.SetLength(totalBytes);
        await stream.FlushAsync(cancellationToken);
        RestrictFile(workingFilePath);
    }

    private static FileStreamOptions CreatePrivateReadWriteOptions(FileMode mode)
    {
        var options = new FileStreamOptions
        {
            Mode = mode,
            Access = FileAccess.ReadWrite,
            Share = FileShare.None,
            BufferSize = UploadStreamBufferSize,
            Options = FileOptions.Asynchronous | FileOptions.RandomAccess
        };
        if (!OperatingSystem.IsWindows())
        {
            options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        }

        return options;
    }

    private static async Task<string> WritePartAndComputeHashAsync(
        IFormFile part,
        string partPath,
        bool computeHash,
        CancellationToken cancellationToken)
    {
        EnsureRestrictedDirectory(Path.GetDirectoryName(partPath)!);
        await using Stream input = part.OpenReadStream();
        await using var output = new FileStream(partPath, CreatePrivateWriteOptions(FileMode.Create));
        using IncrementalHash? hasher = computeHash
            ? IncrementalHash.CreateHash(HashAlgorithmName.SHA256)
            : null;
        byte[] buffer = ArrayPool<byte>.Shared.Rent(UploadStreamBufferSize);
        try
        {
            int read;
            while ((read = await input.ReadAsync(buffer.AsMemory(0, buffer.Length), cancellationToken)) > 0)
            {
                hasher?.AppendData(buffer.AsSpan(0, read));
                await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
            }

            return hasher is null
                ? string.Empty
                : Convert.ToHexStringLower(hasher.GetHashAndReset());
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }

    private static async Task<string> WritePartToWorkingFileAndComputeHashAsync(
        IFormFile part,
        string workingFilePath,
        long offset,
        long totalBytes,
        bool computeHash,
        CancellationToken cancellationToken)
    {
        await using Stream input = part.OpenReadStream();
        await using var output = new FileStream(workingFilePath, CreatePrivateReadWriteOptions(FileMode.OpenOrCreate));
        if (output.Length < totalBytes)
        {
            output.SetLength(totalBytes);
        }

        output.Seek(offset, SeekOrigin.Begin);
        using IncrementalHash? hasher = computeHash
            ? IncrementalHash.CreateHash(HashAlgorithmName.SHA256)
            : null;
        byte[] buffer = ArrayPool<byte>.Shared.Rent(UploadStreamBufferSize);
        try
        {
            int read;
            while ((read = await input.ReadAsync(buffer.AsMemory(0, buffer.Length), cancellationToken)) > 0)
            {
                hasher?.AppendData(buffer.AsSpan(0, read));
                await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
            }

            await output.FlushAsync(cancellationToken);
            return hasher is null
                ? string.Empty
                : Convert.ToHexStringLower(hasher.GetHashAndReset());
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }

    private static async Task<AssembledUploadFile> AnalyzeWorkingUploadAsync(
        string workingFilePath,
        bool computeHash,
        CancellationToken cancellationToken)
    {
        await using var input = new FileStream(workingFilePath, new FileStreamOptions
        {
            Mode = FileMode.Open,
            Access = FileAccess.Read,
            Share = FileShare.Read,
            BufferSize = UploadStreamBufferSize,
            Options = FileOptions.Asynchronous | FileOptions.SequentialScan
        });

        using IncrementalHash? hasher = computeHash
            ? IncrementalHash.CreateHash(HashAlgorithmName.SHA256)
            : null;
        byte[] buffer = ArrayPool<byte>.Shared.Rent(UploadStreamBufferSize);
        byte[] header = new byte[ImageSignatureHeaderLength];
        long totalRead = 0;
        int headerLength = 0;
        try
        {
            int read;
            while ((read = await input.ReadAsync(buffer.AsMemory(0, buffer.Length), cancellationToken)) > 0)
            {
                hasher?.AppendData(buffer.AsSpan(0, read));
                if (headerLength < header.Length)
                {
                    int copyLength = Math.Min(read, header.Length - headerLength);
                    buffer.AsSpan(0, copyLength).CopyTo(header.AsSpan(headerLength));
                    headerLength += copyLength;
                }

                totalRead += read;
            }

            string sha256 = hasher is null
                ? string.Empty
                : Convert.ToHexStringLower(hasher.GetHashAndReset());
            return new AssembledUploadFile(totalRead, sha256, header, headerLength);
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }

    private async Task<AssembledUploadFile> AssembleUploadAsync(
        string uploadId,
        IReadOnlyList<int> orderedParts,
        string tempPath,
        bool computeHash,
        CancellationToken cancellationToken)
    {
        await using var output = new FileStream(tempPath, CreatePrivateWriteOptions(FileMode.Create));
        using IncrementalHash? hasher = computeHash
            ? IncrementalHash.CreateHash(HashAlgorithmName.SHA256)
            : null;
        byte[] buffer = ArrayPool<byte>.Shared.Rent(UploadStreamBufferSize);
        byte[] header = new byte[ImageSignatureHeaderLength];
        long totalWritten = 0;
        int headerLength = 0;
        try
        {
            foreach (int partNumber in orderedParts)
            {
                string partPath = GetPartPath(uploadId, partNumber);
                await using var input = new FileStream(partPath, new FileStreamOptions
                {
                    Mode = FileMode.Open,
                    Access = FileAccess.Read,
                    Share = FileShare.Read,
                    BufferSize = UploadStreamBufferSize,
                    Options = FileOptions.Asynchronous
                });

                int read;
                while ((read = await input.ReadAsync(buffer.AsMemory(0, buffer.Length), cancellationToken)) > 0)
                {
                    hasher?.AppendData(buffer.AsSpan(0, read));
                    if (headerLength < header.Length)
                    {
                        int copyLength = Math.Min(read, header.Length - headerLength);
                        buffer.AsSpan(0, copyLength).CopyTo(header.AsSpan(headerLength));
                        headerLength += copyLength;
                    }

                    await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
                    totalWritten += read;
                }
            }

            string sha256 = hasher is null
                ? string.Empty
                : Convert.ToHexStringLower(hasher.GetHashAndReset());
            return new AssembledUploadFile(totalWritten, sha256, header, headerLength);
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }

    private static async Task<bool> ValidateImageSignatureAsync(string filePath, string targetFormat, CancellationToken cancellationToken)
    {
        byte[] header = new byte[16];
        await using var stream = new FileStream(filePath, new FileStreamOptions
        {
            Mode = FileMode.Open,
            Access = FileAccess.Read,
            Share = FileShare.Read,
            BufferSize = 16,
            Options = FileOptions.Asynchronous
        });

        int read = await stream.ReadAsync(header.AsMemory(0, header.Length), cancellationToken);
        return ValidateImageSignature(header.AsSpan(0, read), targetFormat);
    }

    private static async Task<bool> ValidateImageSignatureAsync(IFormFile file, string targetFormat)
    {
        byte[] header = new byte[16];
        await using Stream stream = file.OpenReadStream();
        int read = await stream.ReadAsync(header.AsMemory(0, header.Length));
        return ValidateImageSignature(header.AsSpan(0, read), targetFormat);
    }

    private static bool ValidateImageSignature(ReadOnlySpan<byte> header, string targetFormat)
    {
        if (header.Length < 4)
        {
            return false;
        }

        if (ContainsHtmlPolyglotMarker(header))
        {
            return false;
        }

        int read = header.Length;
        string format = targetFormat.TrimStart('.').ToLowerInvariant();
        return format switch
        {
            "jpg" or "jpeg" => header[0] == 0xFF && header[1] == 0xD8 && header[2] == 0xFF,
            "png" => header[0] == 0x89 && header[1] == 0x50 && header[2] == 0x4E && header[3] == 0x47,
            "gif" => header[0] == 0x47 && header[1] == 0x49 && header[2] == 0x46 && header[3] == 0x38,
            "webp" => read >= 12
                && header[0] == 0x52 && header[1] == 0x49 && header[2] == 0x46 && header[3] == 0x46
                && header[8] == 0x57 && header[9] == 0x45 && header[10] == 0x42 && header[11] == 0x50,
            "ico" => read >= 6
                && header[0] == 0x00 && header[1] == 0x00
                && header[2] == 0x01 && header[3] == 0x00
                && (header[4] != 0x00 || header[5] != 0x00),
            "avif" => read >= 12
                && header[4] == 0x66 && header[5] == 0x74 && header[6] == 0x79 && header[7] == 0x70
                && header[8] == 0x61 && header[9] == 0x76 && header[10] == 0x69 && header[11] == 0x66,
            _ => false
        };
    }

    private static bool ContainsHtmlPolyglotMarker(ReadOnlySpan<byte> header)
        => ContainsAsciiIgnoreCase(header, "<script"u8)
            || ContainsAsciiIgnoreCase(header, "<html"u8)
            || ContainsAsciiIgnoreCase(header, "<!doctype"u8);

    private static bool ContainsAsciiIgnoreCase(ReadOnlySpan<byte> value, ReadOnlySpan<byte> marker)
    {
        if (marker.Length == 0 || value.Length < marker.Length)
        {
            return false;
        }

        for (int i = 0; i <= value.Length - marker.Length; i++)
        {
            bool matched = true;
            for (int j = 0; j < marker.Length; j++)
            {
                byte current = value[i + j];
                if (current is >= (byte)'A' and <= (byte)'Z')
                {
                    current = (byte)(current + 32);
                }

                if (current != marker[j])
                {
                    matched = false;
                    break;
                }
            }

            if (matched)
            {
                return true;
            }
        }

        return false;
    }

    private static string SanitizeLogPath(string value)
    {
        StringBuilder? builder = null;
        for (int i = 0; i < value.Length; i++)
        {
            string? replacement = value[i] switch
            {
                '\r' => "\\r",
                '\n' => "\\n",
                '\t' => "\\t",
                var ch when char.IsControl(ch) => $"\\u{(int)ch:X4}",
                _ => null
            };

            if (replacement is null)
            {
                builder?.Append(value[i]);
                continue;
            }

            builder ??= new StringBuilder(value.Length + 8).Append(value, 0, i);
            builder.Append(replacement);
        }

        return builder?.ToString() ?? value;
    }

    private static bool IsPathWithinDirectory(string directory, string candidatePath)
    {
        string root = Path.GetFullPath(directory);
        string candidate = Path.GetFullPath(candidatePath);
        string relative = Path.GetRelativePath(root, candidate);
        return relative.Length == 0 ||
            (!relative.StartsWith("..", StringComparison.Ordinal) &&
             !Path.IsPathRooted(relative));
    }

    private sealed record AssembledUploadFile(
        long Length,
        string Sha256,
        byte[] Header,
        int HeaderLength);

    [LoggerMessage(EventId = 1, Level = LogLevel.Error, Message = "插图磁盘写入异常。目标路径: {FilePath}")]
    private partial void LogWriteError(Exception ex, string filePath);

    [LoggerMessage(EventId = 2, Level = LogLevel.Information, Message = "[Storage] 物理文件删除成功 | 路径: {FullPath}")]
    private partial void LogDeleteSuccess(string fullPath);

    [LoggerMessage(EventId = 3, Level = LogLevel.Warning, Message = "[Storage] 文件不存在，跳过删除 | 尝试路径: {FullPath}")]
    private partial void LogFileNotFound(string fullPath);

    [LoggerMessage(EventId = 4, Level = LogLevel.Error, Message = "[Storage] 物理文件删除异常 | 目标路径: {FullPath}")]
    private partial void LogDeleteError(Exception ex, string fullPath);

    [LoggerMessage(EventId = 5, Level = LogLevel.Critical, Message = "🚨 [安全拦截] 探测到恶意的目录逃逸(Path Traversal)文件删除尝试 | 最终解析路径: {FullPath}")]
    private partial void LogSecurityWarning(string fullPath);
}
