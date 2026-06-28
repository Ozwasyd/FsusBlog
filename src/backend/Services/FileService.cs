using System.Collections.Concurrent;
using System.Buffers;
using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Background;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Services;

public sealed partial class FileService : IFileService
{
    private const int DefaultChunkSize = 512 * 1024;
    private const int MaxChunkSize = 2 * 1024 * 1024;
    private const int UploadStreamBufferSize = 81920;
    private const int ImageSignatureHeaderLength = 512;
    private const long MaxUploadBytes = 20 * 1024 * 1024;
    private const uint UploadSessionMagic = 0x53505546; // FUPS
    private const byte UploadSessionVersion = 2;
    private static readonly TimeSpan SessionTtl = TimeSpan.FromHours(6);
    private static readonly TimeSpan SessionLockTtl = TimeSpan.FromHours(6);
    private static readonly TimeSpan ManifestlessSessionGracePeriod = TimeSpan.FromMinutes(1);

    private readonly IWebHostEnvironment _env;
    private readonly ILogger<FileService> _logger;
    private readonly string _subFolder;
    private readonly string _folderPath;
    private readonly string _cleanSubFolderWeb;
    private readonly string _sandboxAbsolutePath;
    private readonly string _sessionRootPath;
    private readonly string _sessionRootAbsolutePath;
    private readonly UploadSessionCleanupQueue? _cleanupQueue;

    private static readonly string[] _allowedExtensions = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif"];
    private static readonly string[] _allowedFormats = ["jpg", "jpeg", "png", "gif", "webp", "avif"];
    private static readonly ConcurrentDictionary<string, SessionLockEntry> _sessionLocks = new(StringComparer.Ordinal);

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

        string absPath = Path.GetFullPath(_folderPath);
        _sandboxAbsolutePath = absPath.EndsWith(Path.DirectorySeparatorChar.ToString(), StringComparison.Ordinal)
            ? absPath
            : absPath + Path.DirectorySeparatorChar;
        _sessionRootAbsolutePath = _sessionRootPath.EndsWith(Path.DirectorySeparatorChar.ToString(), StringComparison.Ordinal)
            ? _sessionRootPath
            : _sessionRootPath + Path.DirectorySeparatorChar;

        _cleanSubFolderWeb = "/" + _subFolder.Trim('/', '\\').Replace('\\', '/');

        Directory.CreateDirectory(_folderPath);
        Directory.CreateDirectory(_sessionRootPath);
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

        return await BoundaryExecutor.ExecuteValueAsync(
            async () =>
            {
                await using var stream = new FileStream(filePath, new FileStreamOptions
                {
                    Mode = FileMode.Create,
                    Access = FileAccess.Write,
                    Share = FileShare.None,
                    BufferSize = 81920,
                    Options = FileOptions.Asynchronous
                });
                await file.CopyToAsync(stream);

                return new FileUploadResult
                {
                    Success = true,
                    Url = relativeUrl,
                    RelativeUrl = relativeUrl,
                    PhysicalPath = filePath
                };
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
        DateTime expiresAt = DateTime.UtcNow.Add(SessionTtl);

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
            ExpiresAt = expiresAt
        };

        Result initResult = await BoundaryExecutor.ExecuteResultAsync(
            async () =>
            {
                Directory.CreateDirectory(GetSessionPath(uploadId));
                Directory.CreateDirectory(GetPartsPath(uploadId));
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
            string partPath = GetPartPath(normalizedUploadId, partNumber);
            Result<string> writeResult = await BoundaryExecutor.ExecuteResultAsync(
                async () => await WritePartAndComputeHashAsync(
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
                File.Delete(partPath);
                return Result<UploadPartAckDto>.Failure(ErrorCode.Validation, "分片校验失败");
            }

            List<int> uploadedParts = EnsureUploadedParts(record);
            bool isNewPart = !uploadedParts.Contains(partNumber);
            if (isNewPart)
            {
                uploadedParts.Add(partNumber);
                record.UploadedBytes += part.Length;
            }

            record.Status = uploadedParts.Count >= record.TotalParts ? "uploaded" : "uploading";
            record.ExpiresAt = DateTime.UtcNow.Add(SessionTtl);
            if (!isNewPart && record.UploadedBytes == 0 && uploadedParts.Count > 0)
            {
                record.UploadedBytes = await ResolveUploadedBytesAsync(normalizedUploadId, record, cancellationToken);
            }

            await SaveSessionAsync(record, cancellationToken);
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
        finally { }
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
                RetireSessionLock(normalizedUploadId);
                return Result<UploadCompleteDto>.Failure(ErrorCode.NotFound, "上传会话不存在或已过期");
            }

            IReadOnlyList<int> uploadedParts = UploadedParts(record);
            if (uploadedParts.Count != record.TotalParts)
            {
                return Result<UploadCompleteDto>.Failure(ErrorCode.Conflict, "上传尚未完成，无法合并成品");
            }

            int[] orderedParts = [.. uploadedParts.OrderBy(static value => value)];
            foreach (int partNumber in orderedParts)
            {
                string partPath = GetPartPath(normalizedUploadId, partNumber);
                if (!File.Exists(partPath))
                {
                    return Result<UploadCompleteDto>.Failure(ErrorCode.Validation, "上传分片不完整");
                }
            }

            string extension = "." + record.TargetFormat.TrimStart('.').ToLowerInvariant();
            string fileName = $"{Guid.NewGuid():N}{extension}";
            string finalPath = Path.Combine(_folderPath, fileName);
            string relativeUrl = $"{_cleanSubFolderWeb}/{fileName}";
            string tempPath = Path.Combine(GetSessionPath(normalizedUploadId), $"assembled{extension}");
            string expectedHash = NormalizeHash(sha256);
            if (expectedHash.Length == 0)
            {
                expectedHash = NormalizeHash(record.Sha256);
            }

            Result<AssembledUploadFile> assembleResult = await BoundaryExecutor.ExecuteResultAsync(
                async () => await AssembleUploadAsync(
                    normalizedUploadId,
                    orderedParts,
                    tempPath,
                    computeHash: expectedHash.Length > 0,
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
                File.Delete(tempPath);
                return Result<UploadCompleteDto>.Failure(ErrorCode.Validation, "上传文件校验失败");
            }

            if (assembled.Length != record.TotalBytes)
            {
                File.Delete(tempPath);
                return Result<UploadCompleteDto>.Failure(ErrorCode.Conflict, "合并文件大小异常");
            }

            if (!ValidateImageSignature(assembled.Header.AsSpan(0, assembled.HeaderLength), record.TargetFormat))
            {
                File.Delete(tempPath);
                return Result<UploadCompleteDto>.Failure(ErrorCode.Validation, "文件签名与目标格式不一致");
            }

            File.Move(tempPath, finalPath, true);
            await DeleteSessionDirectoryAsync(normalizedUploadId);

            return Result<UploadCompleteDto>.Success(new UploadCompleteDto
            {
                UploadId = normalizedUploadId,
                Url = relativeUrl,
                RelativeUrl = relativeUrl,
                MimeType = record.MimeType,
                TotalBytes = new FileInfo(finalPath).Length
            });
        }
        finally { }
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

        string normalizedUrl = imageUrl.Trim().Replace('\\', '/');
        int suffixStart = normalizedUrl.IndexOfAny(['?', '#']);
        if (suffixStart >= 0)
        {
            normalizedUrl = normalizedUrl[..suffixStart];
        }

        normalizedUrl = "/" + normalizedUrl.TrimStart('/');
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
        if (!filePath.StartsWith(_sandboxAbsolutePath, StringComparison.OrdinalIgnoreCase))
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
        if (!TryNormalizeUploadId(uploadId, out string normalizedUploadId)
            || !string.Equals(uploadId, normalizedUploadId, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Upload session id is invalid.");
        }

        CleanupStaleSessionLocks(DateTimeOffset.UtcNow);
        while (true)
        {
            SessionLockEntry entry = _sessionLocks.GetOrAdd(uploadId, static _ => new SessionLockEntry());
            if (!entry.TryAddReference())
            {
                continue;
            }

            try
            {
                await entry.Semaphore.WaitAsync(cancellationToken);
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

    private string GetPartsPath(string uploadId) => GetSessionChildPath(uploadId, "parts");
    private string GetManifestPath(string uploadId) => GetSessionChildPath(uploadId, "manifest.aeds");
    private string GetPartPath(string uploadId, int partNumber)
        => GetSessionChildPath(uploadId, Path.Combine("parts", $"{partNumber:D8}.part"));

    private string GetSessionChildPath(string uploadId, string relativePath)
    {
        string childPath = Path.GetFullPath(Path.Combine(GetSessionPath(uploadId), relativePath));
        if (!IsPathUnderSessionRoot(childPath))
        {
            throw new InvalidOperationException("upload session child path escaped sandbox.");
        }

        return childPath;
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
        => string.IsNullOrWhiteSpace(value) ? string.Empty : value.Trim().ToLowerInvariant();

    private static string NormalizeExtension(string? ext)
    {
        if (string.IsNullOrWhiteSpace(ext))
        {
            return string.Empty;
        }

        string value = ext.Trim().ToLowerInvariant();
        return value.StartsWith(".", StringComparison.Ordinal) ? value : "." + value;
    }

    private static bool IsAllowedExtension(string extension)
        => _allowedExtensions.Contains(extension, StringComparer.OrdinalIgnoreCase);

    private static bool IsSupportedImageMime(string? mimeType)
    {
        if (string.IsNullOrWhiteSpace(mimeType))
        {
            return false;
        }

        return mimeType.Trim().ToLowerInvariant() switch
        {
            "image/jpeg" => true,
            "image/png" => true,
            "image/gif" => true,
            "image/webp" => true,
            "image/avif" => true,
            _ => false
        };
    }

    private static bool IsMimeCompatibleWithFormat(string? mimeType, string format)
    {
        if (string.IsNullOrWhiteSpace(mimeType))
        {
            return true;
        }

        string normalizedMime = mimeType.Trim().ToLowerInvariant();
        string expected = format.ToLowerInvariant() switch
        {
            "jpg" or "jpeg" => "image/jpeg",
            "png" => "image/png",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "avif" => "image/avif",
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
        return _allowedFormats.Contains(candidate, StringComparer.OrdinalIgnoreCase) ? candidate : string.Empty;
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

        return record;
    }

    private async Task SaveSessionAsync(UploadSessionRecord record, CancellationToken cancellationToken)
    {
        if (!TryNormalizeUploadId(record.UploadId, out string normalizedUploadId))
        {
            throw new InvalidOperationException("Upload session id is invalid.");
        }

        string manifestPath = GetManifestPath(normalizedUploadId);
        string tempPath = manifestPath + ".tmp";
        byte[] payload = EncodeSession(record with { UploadId = normalizedUploadId });
        await File.WriteAllBytesAsync(tempPath, payload, cancellationToken);

        File.Move(tempPath, manifestPath, true);
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
        IReadOnlyList<int> uploadedParts = UploadedParts(record);
        byte[] uploadId = Encoding.UTF8.GetBytes(record.UploadId);
        byte[] fileName = Encoding.UTF8.GetBytes(record.FileName);
        byte[] mimeType = Encoding.UTF8.GetBytes(record.MimeType);
        byte[] targetFormat = Encoding.UTF8.GetBytes(record.TargetFormat);
        byte[] sha256 = Encoding.UTF8.GetBytes(record.Sha256 ?? string.Empty);
        byte[] status = Encoding.UTF8.GetBytes(record.Status);
        byte[] uploadToken = Encoding.UTF8.GetBytes(record.UploadToken);
        int length = 4 + 1 + 8 + 4 + 4 + 8 + 8 + 8 + 4
            + uploadedParts.Count * sizeof(int)
            + (2 + uploadId.Length)
            + (2 + fileName.Length)
            + (2 + mimeType.Length)
            + (2 + targetFormat.Length)
            + (2 + sha256.Length)
            + (2 + status.Length)
            + (2 + uploadToken.Length);
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
                Status = string.IsNullOrWhiteSpace(status) ? "pending" : status
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
        if (record.UploadedBytes > 0 || uploadedParts.Count == 0)
        {
            return record.UploadedBytes;
        }

        return await GetUploadedBytesAsync(uploadId, uploadedParts, cancellationToken);
    }

    internal async Task CleanupExpiredSessionsAsync(CancellationToken cancellationToken)
    {
        if (!Directory.Exists(_sessionRootPath))
        {
            return;
        }

        foreach (string sessionPath in Directory.EnumerateDirectories(_sessionRootPath))
        {
            cancellationToken.ThrowIfCancellationRequested();
            string fullSessionPath = Path.GetFullPath(sessionPath);
            string uploadId = Path.GetFileName(fullSessionPath);
            if (!IsPathUnderSessionRoot(fullSessionPath) || !TryNormalizeUploadId(uploadId, out string normalizedUploadId))
            {
                continue;
            }

            string manifestPath = Path.Combine(sessionPath, "manifest.aeds");
            if (!File.Exists(manifestPath))
            {
                if (!IsStaleManifestlessSession(sessionPath))
                {
                    continue;
                }

                Directory.Delete(sessionPath, true);
                RetireSessionLock(normalizedUploadId);
                continue;
            }

            bool shouldDelete = await BoundaryExecutor.ExecuteValueAsync(
                async () =>
                {
                    UploadSessionRecord? record = await ReadSessionAsync(manifestPath, cancellationToken);
                    return record is null || record.ExpiresAt <= DateTime.UtcNow;
                },
                _ => true,
                _logger,
                $"cleanup-upload-session:{sessionPath}");
            if (shouldDelete)
            {
                Directory.Delete(sessionPath, true);
                RetireSessionLock(normalizedUploadId);
            }
        }
    }

    private static bool IsStaleManifestlessSession(string sessionPath)
    {
        DateTime lastActivityUtc = Directory.GetLastWriteTimeUtc(sessionPath);
        DateTime createdAtUtc = Directory.GetCreationTimeUtc(sessionPath);
        if (createdAtUtc > lastActivityUtc)
        {
            lastActivityUtc = createdAtUtc;
        }

        return lastActivityUtc <= DateTime.UtcNow.Subtract(ManifestlessSessionGracePeriod);
    }

    private async Task DeleteSessionDirectoryAsync(string uploadId)
    {
        if (!TryNormalizeUploadId(uploadId, out string normalizedUploadId))
        {
            return;
        }

        uploadId = normalizedUploadId;
        string sessionPath = GetSessionPath(uploadId);
        if (Directory.Exists(sessionPath))
        {
            await BoundaryExecutor.ExecuteAsync(
                () =>
                {
                    Directory.Delete(sessionPath, true);
                    return Task.CompletedTask;
                },
                _logger,
                $"upload-session-delete:{sessionPath}");
        }

        RetireSessionLock(uploadId);
    }

    private void RequestUploadSessionCleanup()
        => _cleanupQueue?.TryRequestScan();

    private static void RetireSessionLock(string uploadId)
    {
        if (_sessionLocks.TryGetValue(uploadId, out SessionLockEntry? entry))
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

        if (_sessionLocks.TryRemove(new KeyValuePair<string, SessionLockEntry>(uploadId, entry)))
        {
            entry.Dispose();
        }
    }

    internal static int CleanupStaleSessionLocks(DateTimeOffset now)
    {
        DateTimeOffset cutoff = now - SessionLockTtl;
        int removed = 0;
        foreach (KeyValuePair<string, SessionLockEntry> pair in _sessionLocks)
        {
            if (!pair.Value.IsIdleSince(cutoff))
            {
                continue;
            }

            pair.Value.MarkRetired();
            int before = _sessionLocks.Count;
            TryDisposeSessionLock(pair.Key, pair.Value);
            if (_sessionLocks.Count < before)
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

    private static async Task<string> WritePartAndComputeHashAsync(
        IFormFile part,
        string partPath,
        bool computeHash,
        CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(partPath)!);
        await using Stream input = part.OpenReadStream();
        await using var output = new FileStream(partPath, new FileStreamOptions
        {
            Mode = FileMode.Create,
            Access = FileAccess.Write,
            Share = FileShare.None,
            BufferSize = UploadStreamBufferSize,
            Options = FileOptions.Asynchronous
        });
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

    private async Task<AssembledUploadFile> AssembleUploadAsync(
        string uploadId,
        IReadOnlyList<int> orderedParts,
        string tempPath,
        bool computeHash,
        CancellationToken cancellationToken)
    {
        await using var output = new FileStream(tempPath, new FileStreamOptions
        {
            Mode = FileMode.Create,
            Access = FileAccess.Write,
            Share = FileShare.None,
            BufferSize = UploadStreamBufferSize,
            Options = FileOptions.Asynchronous
        });
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
