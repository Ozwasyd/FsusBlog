using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.Json;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Services;

public sealed partial class FileService : IFileService
{
    private const int DefaultChunkSize = 512 * 1024;
    private const int MaxChunkSize = 2 * 1024 * 1024;
    private const long MaxUploadBytes = 20 * 1024 * 1024;
    private static readonly TimeSpan SessionTtl = TimeSpan.FromHours(6);

    private readonly IWebHostEnvironment _env;
    private readonly ILogger<FileService> _logger;
    private readonly string _subFolder;
    private readonly string _folderPath;
    private readonly string _cleanSubFolderWeb;
    private readonly string _sandboxAbsolutePath;
    private readonly string _sessionRootPath;

    private static readonly JsonSerializerOptions SessionJsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = false
    };

    private static readonly string[] _allowedExtensions = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif"];
    private static readonly string[] _allowedFormats = ["jpg", "jpeg", "png", "gif", "webp", "avif"];
    private static readonly ConcurrentDictionary<string, SessionLockEntry> _sessionLocks = new(StringComparer.Ordinal);

    public FileService(IWebHostEnvironment env, ILogger<FileService> logger)
    {
        _env = env;
        _logger = logger;
        _subFolder = Path.Combine("uploads", "illustration");

        string webRoot = _env.WebRootPath ?? Path.Combine(Directory.GetCurrentDirectory(), "wwwroot");
        _folderPath = Path.Combine(webRoot, _subFolder);
        _sessionRootPath = Path.Combine(_env.ContentRootPath, ".upload-sessions");

        string absPath = Path.GetFullPath(_folderPath);
        _sandboxAbsolutePath = absPath.EndsWith(Path.DirectorySeparatorChar)
            ? absPath
            : absPath + Path.DirectorySeparatorChar;

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
        await CleanupExpiredSessionsAsync(cancellationToken);

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
        DateTime expiresAt = DateTime.UtcNow.Add(SessionTtl);

        var record = new UploadSessionRecord
        {
            UploadId = uploadId,
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
            ExpiresAt = record.ExpiresAt
        });
    }

    public async Task<Result<UploadStatusDto>> GetUploadStatusAsync(string uploadId, CancellationToken cancellationToken = default)
    {
        await CleanupExpiredSessionsAsync(cancellationToken);

        var record = await LoadSessionAsync(uploadId, cancellationToken);
        if (record is null)
        {
            return Result<UploadStatusDto>.Failure(ErrorCode.NotFound, "上传会话不存在或已过期");
        }

        long uploadedBytes = await ResolveUploadedBytesAsync(uploadId, record, cancellationToken);
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
            UploadedPartCount = record.UploadedParts.Count,
            NextPartHint = ResolveNextPartHint(record),
            ExpiresAt = record.ExpiresAt
        });
    }

    public async Task<Result<UploadPartMapDto>> GetUploadPartMapAsync(string uploadId, CancellationToken cancellationToken = default)
    {
        await CleanupExpiredSessionsAsync(cancellationToken);

        var record = await LoadSessionAsync(uploadId, cancellationToken);
        if (record is null)
        {
            return Result<UploadPartMapDto>.Failure(ErrorCode.NotFound, "上传会话不存在或已过期");
        }

        return Result<UploadPartMapDto>.Success(new UploadPartMapDto
        {
            UploadId = record.UploadId,
            UploadedRanges = BuildUploadedRanges(record.UploadedParts)
        });
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

        await using SessionLockLease sessionLock = await AcquireSessionLockAsync(uploadId, cancellationToken);
        try
        {
            var record = await LoadSessionAsync(uploadId, cancellationToken);
            if (record is null)
            {
                RetireSessionLock(uploadId);
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

            string partPath = GetPartPath(uploadId, partNumber);
            Result writeResult = await BoundaryExecutor.ExecuteResultAsync(
                async () =>
                {
                    Directory.CreateDirectory(GetPartsPath(uploadId));

                    await using var stream = new FileStream(partPath, new FileStreamOptions
                    {
                        Mode = FileMode.Create,
                        Access = FileAccess.Write,
                        Share = FileShare.None,
                        BufferSize = 81920,
                        Options = FileOptions.Asynchronous
                    });
                    await part.CopyToAsync(stream, cancellationToken);
                },
                _ => ErrorDetail.Create(ErrorCode.InfraFailure, "分片写入失败"),
                _logger,
                $"upload-part:{uploadId}:{partNumber}");
            if (!writeResult.IsSuccess)
            {
                return Result<UploadPartAckDto>.Failure(writeResult.Error);
            }

            if (!string.IsNullOrWhiteSpace(payloadHash))
            {
                string actual = await ComputeSha256Async(partPath, cancellationToken);
                if (!actual.Equals(payloadHash, StringComparison.OrdinalIgnoreCase))
                {
                    File.Delete(partPath);
                    return Result<UploadPartAckDto>.Failure(ErrorCode.Validation, "分片校验失败");
                }
            }

            bool isNewPart = !record.UploadedParts.Contains(partNumber);
            if (isNewPart)
            {
                record.UploadedParts.Add(partNumber);
                record.UploadedBytes += part.Length;
            }

            record.Status = record.UploadedParts.Count >= record.TotalParts ? "uploaded" : "uploading";
            record.ExpiresAt = DateTime.UtcNow.Add(SessionTtl);
            if (!isNewPart && record.UploadedBytes == 0 && record.UploadedParts.Count > 0)
            {
                record.UploadedBytes = await ResolveUploadedBytesAsync(uploadId, record, cancellationToken);
            }

            await SaveSessionAsync(record, cancellationToken);
            return Result<UploadPartAckDto>.Success(new UploadPartAckDto
            {
                UploadId = uploadId,
                PartNumber = partNumber,
                Offset = offset,
                Size = checked((int)part.Length),
                UploadedBytes = record.UploadedBytes,
                UploadedPartCount = record.UploadedParts.Count
            });
        }
        finally { }
    }

    public async Task<Result<UploadCompleteDto>> CompleteUploadAsync(string uploadId, string? sha256, CancellationToken cancellationToken = default)
    {
        await using SessionLockLease sessionLock = await AcquireSessionLockAsync(uploadId, cancellationToken);
        try
        {
            var record = await LoadSessionAsync(uploadId, cancellationToken);
            if (record is null)
            {
                RetireSessionLock(uploadId);
                return Result<UploadCompleteDto>.Failure(ErrorCode.NotFound, "上传会话不存在或已过期");
            }

            if (record.UploadedParts.Count != record.TotalParts)
            {
                return Result<UploadCompleteDto>.Failure(ErrorCode.Conflict, "上传尚未完成，无法合并成品");
            }

            int[] orderedParts = [.. record.UploadedParts.OrderBy(static value => value)];
            foreach (int partNumber in orderedParts)
            {
                string partPath = GetPartPath(uploadId, partNumber);
                if (!File.Exists(partPath))
                {
                    return Result<UploadCompleteDto>.Failure(ErrorCode.Validation, "上传分片不完整");
                }
            }

            string extension = "." + record.TargetFormat.TrimStart('.').ToLowerInvariant();
            string fileName = $"{Guid.NewGuid():N}{extension}";
            string finalPath = Path.Combine(_folderPath, fileName);
            string relativeUrl = $"{_cleanSubFolderWeb}/{fileName}";
            string tempPath = Path.Combine(GetSessionPath(uploadId), $"assembled{extension}");

            Result assembleResult = await BoundaryExecutor.ExecuteResultAsync(
                async () =>
                {
                    await using var output = new FileStream(tempPath, new FileStreamOptions
                    {
                        Mode = FileMode.Create,
                        Access = FileAccess.Write,
                        Share = FileShare.None,
                        BufferSize = 81920,
                        Options = FileOptions.Asynchronous
                    });

                    foreach (int partNumber in orderedParts)
                    {
                        string partPath = GetPartPath(uploadId, partNumber);
                        await using var input = new FileStream(partPath, new FileStreamOptions
                        {
                            Mode = FileMode.Open,
                            Access = FileAccess.Read,
                            Share = FileShare.Read,
                            BufferSize = 81920,
                            Options = FileOptions.Asynchronous
                        });
                        await input.CopyToAsync(output, cancellationToken);
                    }
                },
                _ => ErrorDetail.Create(ErrorCode.InfraFailure, "上传文件合并失败"),
                _logger,
                $"upload-complete:{uploadId}");
            if (!assembleResult.IsSuccess)
            {
                return Result<UploadCompleteDto>.Failure(assembleResult.Error);
            }

            string expectedHash = NormalizeHash(sha256);
            if (expectedHash.Length == 0)
            {
                expectedHash = NormalizeHash(record.Sha256);
            }
            if (expectedHash.Length > 0)
            {
                string finalHash = await ComputeSha256Async(tempPath, cancellationToken);
                if (!finalHash.Equals(expectedHash, StringComparison.OrdinalIgnoreCase))
                {
                    File.Delete(tempPath);
                    return Result<UploadCompleteDto>.Failure(ErrorCode.Validation, "上传文件校验失败");
                }
            }

            long actualLength = new FileInfo(tempPath).Length;
            if (actualLength != record.TotalBytes)
            {
                File.Delete(tempPath);
                return Result<UploadCompleteDto>.Failure(ErrorCode.Conflict, "合并文件大小异常");
            }

            if (!await ValidateImageSignatureAsync(tempPath, record.TargetFormat, cancellationToken))
            {
                File.Delete(tempPath);
                return Result<UploadCompleteDto>.Failure(ErrorCode.Validation, "文件签名与目标格式不一致");
            }

            File.Move(tempPath, finalPath, true);
            await DeleteSessionDirectoryAsync(uploadId);

            return Result<UploadCompleteDto>.Success(new UploadCompleteDto
            {
                UploadId = uploadId,
                Url = relativeUrl,
                RelativeUrl = relativeUrl,
                MimeType = record.MimeType,
                TotalBytes = new FileInfo(finalPath).Length
            });
        }
        finally { }
    }

    private static int ResolveNextPartHint(UploadSessionRecord record)
    {
        if (record.UploadedParts.Count == 0)
        {
            return 0;
        }

        HashSet<int> uploaded = [.. record.UploadedParts];
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
        await using SessionLockLease sessionLock = await AcquireSessionLockAsync(uploadId, cancellationToken);
        string sessionPath = GetSessionPath(uploadId);
        if (!Directory.Exists(sessionPath))
        {
            RetireSessionLock(uploadId);
            return Result<bool>.Failure(ErrorCode.NotFound, "上传会话不存在");
        }

        await DeleteSessionDirectoryAsync(uploadId);
        return Result<bool>.Success(true);
    }

    public Task<bool> DeleteImageAsync(string imageUrl)
    {
        if (string.IsNullOrEmpty(imageUrl))
        {
            return Task.FromResult(false);
        }

        var baseDir = Directory.GetCurrentDirectory();
        int startIndex = 0;
        while (startIndex < imageUrl.Length && imageUrl[startIndex] == '/')
        {
            startIndex++;
        }
        int length = imageUrl.Length - startIndex;

        string rawFilePath = string.Create(baseDir.Length + 1 + length, (baseDir, imageUrl, startIndex, length), (dst, state) =>
        {
            state.baseDir.AsSpan().CopyTo(dst);
            dst[state.baseDir.Length] = Path.DirectorySeparatorChar;

            var rel = state.imageUrl.AsSpan(state.startIndex, state.length);
            for (int i = 0; i < rel.Length; i++)
            {
                char c = rel[i];
                dst[state.baseDir.Length + 1 + i] = (c == '/' || c == '\\')
                    ? Path.DirectorySeparatorChar
                    : c;
            }
        });

        string filePath = Path.GetFullPath(rawFilePath);
        if (!filePath.StartsWith(_sandboxAbsolutePath, StringComparison.OrdinalIgnoreCase))
        {
            LogSecurityWarning(filePath);
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

    private string GetSessionPath(string uploadId) => Path.Combine(_sessionRootPath, uploadId);
    private string GetPartsPath(string uploadId) => Path.Combine(GetSessionPath(uploadId), "parts");
    private string GetManifestPath(string uploadId) => Path.Combine(GetSessionPath(uploadId), "manifest.json");
    private string GetPartPath(string uploadId, int partNumber) => Path.Combine(GetPartsPath(uploadId), $"{partNumber:D8}.part");

    private static string NormalizeHash(string? value)
        => string.IsNullOrWhiteSpace(value) ? string.Empty : value.Trim().ToLowerInvariant();

    private static string NormalizeExtension(string? ext)
    {
        if (string.IsNullOrWhiteSpace(ext))
        {
            return string.Empty;
        }

        string value = ext.Trim().ToLowerInvariant();
        return value.StartsWith('.') ? value : "." + value;
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
        if (record is null || record.ExpiresAt <= DateTime.UtcNow)
        {
            await DeleteSessionDirectoryAsync(uploadId);
            return null;
        }

        return record;
    }

    private async Task SaveSessionAsync(UploadSessionRecord record, CancellationToken cancellationToken)
    {
        string manifestPath = GetManifestPath(record.UploadId);
        string tempPath = manifestPath + ".tmp";
        byte[] payload = JsonSerializer.SerializeToUtf8Bytes(record, SessionJsonOptions);
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
        return JsonSerializer.Deserialize<UploadSessionRecord>(payload, SessionJsonOptions);
    }

    private async Task<long> ResolveUploadedBytesAsync(string uploadId, UploadSessionRecord record, CancellationToken cancellationToken)
    {
        if (record.UploadedBytes > 0 || record.UploadedParts.Count == 0)
        {
            return record.UploadedBytes;
        }

        return await GetUploadedBytesAsync(uploadId, record.UploadedParts, cancellationToken);
    }

    private async Task CleanupExpiredSessionsAsync(CancellationToken cancellationToken)
    {
        if (!Directory.Exists(_sessionRootPath))
        {
            return;
        }

        foreach (string sessionPath in Directory.EnumerateDirectories(_sessionRootPath))
        {
            cancellationToken.ThrowIfCancellationRequested();
            string manifestPath = Path.Combine(sessionPath, "manifest.json");
            if (!File.Exists(manifestPath))
            {
                Directory.Delete(sessionPath, true);
                RetireSessionLock(Path.GetFileName(sessionPath));
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
                RetireSessionLock(Path.GetFileName(sessionPath));
            }
        }
    }

    private async Task DeleteSessionDirectoryAsync(string uploadId)
    {
        string sessionPath = GetSessionPath(uploadId);
        if (Directory.Exists(sessionPath))
        {
            await Task.Run(() => Directory.Delete(sessionPath, true));
        }

        RetireSessionLock(uploadId);
    }

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

    internal sealed class SessionLockEntry : IDisposable
    {
        private int _referenceCount;
        private int _retired;
        private int _disposed;

        public SemaphoreSlim Semaphore { get; } = new(1, 1);

        public bool CanDispose => Volatile.Read(ref _retired) == 1 && Volatile.Read(ref _referenceCount) == 0;

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

                return true;
            }
        }

        public void ReleaseReference() => Interlocked.Decrement(ref _referenceCount);

        public void MarkRetired() => Volatile.Write(ref _retired, 1);

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
        if (read < 4)
        {
            return false;
        }

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
