using System.Reflection;
using System.Security.Cryptography;
using FsusBlog.Core.Common;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Tests;

public sealed class FileServiceTests
{
    [Fact]
    public async Task CompleteUploadAsync_ReleasesSessionLockAfterCompletion()
    {
        ResetSessionLocks();
        string root = CreateTempDirectory();
        try
        {
            var service = CreateService(root);
            byte[] payload = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4];
            string sha256 = Convert.ToHexStringLower(SHA256.HashData(payload));

            Result<UploadInitDto> init = await service.InitUploadSessionAsync(new UploadInitRequestDto
            {
                FileName = "sample.png",
                MimeType = "image/png",
                TargetFormat = "png",
                TotalBytes = payload.Length,
                ChunkSize = payload.Length,
                Sha256 = sha256
            });

            Assert.True(init.IsSuccess);
            Result<UploadPartAckDto> upload = await service.UploadPartAsync(init.Value!.UploadId, 0, 0, CreateFormFile(payload, "chunk"), sha256);
            Assert.True(upload.IsSuccess, upload.Error.Message);

            Result<UploadCompleteDto> complete = await service.CompleteUploadAsync(init.Value.UploadId, sha256);

            Assert.True(complete.IsSuccess);
            Assert.Equal(0, GetSessionLockCount());
        }
        finally
        {
            ResetSessionLocks();
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task AbortUploadAsync_ReleasesSessionLockAfterAbort()
    {
        ResetSessionLocks();
        string root = CreateTempDirectory();
        try
        {
            var service = CreateService(root);

            Result<UploadInitDto> init = await service.InitUploadSessionAsync(new UploadInitRequestDto
            {
                FileName = "sample.png",
                MimeType = "image/png",
                TargetFormat = "png",
                TotalBytes = 8,
                ChunkSize = 8
            });

            Assert.True(init.IsSuccess);

            Result<bool> abort = await service.AbortUploadAsync(init.Value!.UploadId);

            Assert.True(abort.IsSuccess);
            Assert.Equal(0, GetSessionLockCount());
        }
        finally
        {
            ResetSessionLocks();
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task UploadPartAsync_PersistsUploadedBytesInManifest()
    {
        ResetSessionLocks();
        string root = CreateTempDirectory();
        try
        {
            var service = CreateService(root);
            byte[] payload = [0x89, 0x50, 0x4E, 0x47, 1, 2, 3, 4];
            string sha256 = Convert.ToHexStringLower(SHA256.HashData(payload));

            Result<UploadInitDto> init = await service.InitUploadSessionAsync(new UploadInitRequestDto
            {
                FileName = "sample.png",
                MimeType = "image/png",
                TargetFormat = "png",
                TotalBytes = payload.Length,
                ChunkSize = payload.Length,
                Sha256 = sha256
            });

            Assert.True(init.IsSuccess);
            Result<UploadPartAckDto> upload = await service.UploadPartAsync(init.Value!.UploadId, 0, 0, CreateFormFile(payload, "chunk"), sha256);

            Assert.True(upload.IsSuccess, upload.Error.Message);

            UploadSessionRecord record = await ReadManifestAsync(root, init.Value.UploadId);
            Assert.Equal(payload.Length, record.UploadedBytes);
        }
        finally
        {
            ResetSessionLocks();
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task GetUploadStatusAsync_RecomputesUploadedBytesForPersistedManifest()
    {
        ResetSessionLocks();
        string root = CreateTempDirectory();
        try
        {
            var service = CreateService(root);
            byte[] payload = [0x89, 0x50, 0x4E, 0x47, 9, 8, 7, 6];
            string sha256 = Convert.ToHexStringLower(SHA256.HashData(payload));

            Result<UploadInitDto> init = await service.InitUploadSessionAsync(new UploadInitRequestDto
            {
                FileName = "sample.png",
                MimeType = "image/png",
                TargetFormat = "png",
                TotalBytes = payload.Length,
                ChunkSize = payload.Length,
                Sha256 = sha256
            });

            Assert.True(init.IsSuccess);
            Result<UploadPartAckDto> upload = await service.UploadPartAsync(init.Value!.UploadId, 0, 0, CreateFormFile(payload, "chunk"), sha256);
            Assert.True(upload.IsSuccess);

            string manifestPath = GetManifestPath(root, init.Value.UploadId);
            UploadSessionRecord persistedWithStaleBytes = (await ReadManifestAsync(root, init.Value.UploadId)) with { UploadedBytes = 0 };
            await WriteManifestAsync(manifestPath, persistedWithStaleBytes);

            Result<UploadStatusDto> status = await service.GetUploadStatusAsync(init.Value.UploadId);

            Assert.True(status.IsSuccess);
            Assert.Equal(payload.Length, status.Value!.UploadedBytes);

            UploadSessionRecord persisted = await ReadManifestAsync(root, init.Value.UploadId);
            Assert.Equal(payload.Length, persisted.UploadedBytes);
        }
        finally
        {
            ResetSessionLocks();
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task GetUploadStatusAsync_TriggersExpiredSessionCleanup()
    {
        ResetSessionLocks();
        string root = CreateTempDirectory();
        try
        {
            var service = CreateService(root);

            Result<UploadInitDto> init = await service.InitUploadSessionAsync(new UploadInitRequestDto
            {
                FileName = "sample.png",
                MimeType = "image/png",
                TargetFormat = "png",
                TotalBytes = 8,
                ChunkSize = 8
            });

            Assert.True(init.IsSuccess);

            string uploadId = init.Value!.UploadId;
            string sessionPath = GetSessionPath(root, uploadId);
            UploadSessionRecord expired = (await ReadManifestAsync(root, uploadId)) with
            {
                ExpiresAt = DateTime.UtcNow.AddMinutes(-5)
            };
            await WriteManifestAsync(GetManifestPath(root, uploadId), expired);

            Result<UploadStatusDto> status = await service.GetUploadStatusAsync(uploadId);

            Assert.False(status.IsSuccess);
            Assert.False(Directory.Exists(sessionPath));
        }
        finally
        {
            ResetSessionLocks();
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task CleanupExpiredSessionsAsync_PreservesFreshManifestlessSessionDirectory()
    {
        ResetSessionLocks();
        string root = CreateTempDirectory();
        try
        {
            var service = CreateService(root);
            string uploadId = Guid.NewGuid().ToString("N");
            string sessionPath = GetSessionPath(root, uploadId);
            Directory.CreateDirectory(Path.Combine(sessionPath, "parts"));

            await service.CleanupExpiredSessionsAsync(CancellationToken.None);

            Assert.True(Directory.Exists(sessionPath));
        }
        finally
        {
            ResetSessionLocks();
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task CleanupExpiredSessionsAsync_RemovesStaleManifestlessSessionDirectory()
    {
        ResetSessionLocks();
        string root = CreateTempDirectory();
        try
        {
            var service = CreateService(root);
            string uploadId = Guid.NewGuid().ToString("N");
            string sessionPath = GetSessionPath(root, uploadId);
            Directory.CreateDirectory(Path.Combine(sessionPath, "parts"));
            DateTime staleUtc = DateTime.UtcNow.AddMinutes(-5);
            Directory.SetCreationTimeUtc(sessionPath, staleUtc);
            Directory.SetLastWriteTimeUtc(sessionPath, staleUtc);

            await service.CleanupExpiredSessionsAsync(CancellationToken.None);

            Assert.False(Directory.Exists(sessionPath));
        }
        finally
        {
            ResetSessionLocks();
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task SessionLockEntry_RetireAfterReference_DoesNotDisposeSemaphoreUntilReleased()
    {
        ResetSessionLocks();
        var entry = new FileService.SessionLockEntry();
        const string uploadId = "session-lock-test";
        RegisterSessionLock(uploadId, entry);

        Assert.True(entry.TryAddReference());
        entry.MarkRetired();
        TryDisposeSessionLock(uploadId, entry);

        await entry.Semaphore.WaitAsync();
        entry.Semaphore.Release();

        entry.ReleaseReference();
        TryDisposeSessionLock(uploadId, entry);

        await Assert.ThrowsAsync<ObjectDisposedException>(async () => await entry.Semaphore.WaitAsync());
    }

    [Fact]
    public void SessionLockEntry_RetiredEntryRejectsNewReferences()
    {
        var entry = new FileService.SessionLockEntry();

        entry.MarkRetired();

        Assert.False(entry.TryAddReference());
    }

    private static FileService CreateService(string root)
        => new(new TestWebHostEnvironment(root), NullLogger<FileService>.Instance);

    // ── InitUploadSessionAsync – validation guards ─────────────────────────────

    [Fact]
    public async Task InitUploadAsync_EmptyFileName_ReturnsFail()
    {
        string root = CreateTempDirectory();
        try
        {
            var svc = CreateService(root);
            var result = await svc.InitUploadSessionAsync(new UploadInitRequestDto
            {
                FileName = "   ", MimeType = "image/png", TargetFormat = "png",
                TotalBytes = 100, ChunkSize = 100
            });
            Assert.False(result.IsSuccess);
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact]
    public async Task InitUploadAsync_ZeroTotalBytes_ReturnsFail()
    {
        string root = CreateTempDirectory();
        try
        {
            var svc = CreateService(root);
            var result = await svc.InitUploadSessionAsync(new UploadInitRequestDto
            {
                FileName = "test.png", MimeType = "image/png", TargetFormat = "png",
                TotalBytes = 0, ChunkSize = 100
            });
            Assert.False(result.IsSuccess);
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact]
    public async Task InitUploadAsync_UnsupportedMimeType_ReturnsFail()
    {
        string root = CreateTempDirectory();
        try
        {
            var svc = CreateService(root);
            var result = await svc.InitUploadSessionAsync(new UploadInitRequestDto
            {
                FileName = "test.exe", MimeType = "application/octet-stream", TargetFormat = "exe",
                TotalBytes = 100, ChunkSize = 100
            });
            Assert.False(result.IsSuccess);
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact]
    public async Task InitUploadAsync_MismatchedMimeAndFormat_ReturnsFail()
    {
        string root = CreateTempDirectory();
        try
        {
            var svc = CreateService(root);
            var result = await svc.InitUploadSessionAsync(new UploadInitRequestDto
            {
                FileName = "test.png", MimeType = "image/jpeg", TargetFormat = "png",
                TotalBytes = 100, ChunkSize = 100
            });
            Assert.False(result.IsSuccess);
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact]
    public async Task InitUploadAsync_ValidWebpRequest_ReturnsSuccess()
    {
        string root = CreateTempDirectory();
        try
        {
            var svc = CreateService(root);
            var result = await svc.InitUploadSessionAsync(new UploadInitRequestDto
            {
                FileName = "photo.webp", MimeType = "image/webp", TargetFormat = "webp",
                TotalBytes = 200, ChunkSize = 200
            });
            Assert.True(result.IsSuccess);
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact]
    public async Task InitUploadAsync_ValidJpegRequest_ReturnsSuccess()
    {
        string root = CreateTempDirectory();
        try
        {
            var svc = CreateService(root);
            var result = await svc.InitUploadSessionAsync(new UploadInitRequestDto
            {
                FileName = "photo.jpg", MimeType = "image/jpeg", TargetFormat = "jpg",
                TotalBytes = 200, ChunkSize = 200
            });
            Assert.True(result.IsSuccess);
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact]
    public async Task GetUploadStatusAsync_UnknownId_ReturnsFail()
    {
        string root = CreateTempDirectory();
        try
        {
            var svc = CreateService(root);
            var result = await svc.GetUploadStatusAsync("nonexistent-id-12345");
            Assert.False(result.IsSuccess);
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact]
    public async Task GetUploadPartMapAsync_UnknownId_ReturnsFail()
    {
        string root = CreateTempDirectory();
        try
        {
            var svc = CreateService(root);
            var result = await svc.GetUploadPartMapAsync("nonexistent-id-12345");
            Assert.False(result.IsSuccess);
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact]
    public async Task AbortUploadAsync_UnknownId_ReturnsFail()
    {
        string root = CreateTempDirectory();
        try
        {
            var svc = CreateService(root);
            var result = await svc.AbortUploadAsync("nonexistent-id-12345");
            Assert.False(result.IsSuccess);
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact]
    public async Task UploadImageAsync_NullFile_ReturnsFail()
    {
        string root = CreateTempDirectory();
        try
        {
            var svc = CreateService(root);
            var result = await svc.UploadImageAsync(null!);
            Assert.False(result.Success);
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact]
    public async Task UploadImageAsync_EmptyFile_ReturnsFail()
    {
        string root = CreateTempDirectory();
        try
        {
            var svc = CreateService(root);
            var emptyFile = CreateFormFile([], "empty");
            var result = await svc.UploadImageAsync(emptyFile);
            Assert.False(result.Success);
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact]
    public async Task UploadImageAsync_DisallowedExtension_ReturnsFail()
    {
        string root = CreateTempDirectory();
        try
        {
            var svc = CreateService(root);
            var stream = new MemoryStream([0x01, 0x02, 0x03]);
            var file = new FormFile(stream, 0, stream.Length, "file", "malware.exe");
            var result = await svc.UploadImageAsync(file);
            Assert.False(result.Success);
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact]
    public async Task CompleteUploadAsync_InvalidSha256_ReturnsFail()
    {
        ResetSessionLocks();
        string root = CreateTempDirectory();
        try
        {
            var svc = CreateService(root);
            byte[] payload = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
            var init = await svc.InitUploadSessionAsync(new UploadInitRequestDto
            {
                FileName = "test.png", MimeType = "image/png", TargetFormat = "png",
                TotalBytes = payload.Length, ChunkSize = payload.Length
            });
            Assert.True(init.IsSuccess);
            string correctSha256 = Convert.ToHexStringLower(SHA256.HashData(payload));
            await svc.UploadPartAsync(init.Value!.UploadId, 0, 0, CreateFormFile(payload, "chunk"), correctSha256);
            // Pass wrong sha256
            var complete = await svc.CompleteUploadAsync(init.Value.UploadId, "not-a-valid-sha256");
            Assert.False(complete.IsSuccess);
        }
        finally
        {
            ResetSessionLocks();
            Directory.Delete(root, recursive: true);
        }
    }

    private static FormFile CreateFormFile(byte[] payload, string name)
    {
        var stream = new MemoryStream(payload, writable: false);
        return new FormFile(stream, 0, payload.Length, name, $"{name}.bin");
    }

    private static int GetSessionLockCount()
    {
        FieldInfo field = typeof(FileService).GetField("_sessionLocks", BindingFlags.Static | BindingFlags.NonPublic)!;
        object dictionary = field.GetValue(null)!;
        return (int)dictionary.GetType().GetProperty("Count")!.GetValue(dictionary)!;
    }

    private static void ResetSessionLocks()
    {
        FieldInfo field = typeof(FileService).GetField("_sessionLocks", BindingFlags.Static | BindingFlags.NonPublic)!;
        object dictionary = field.GetValue(null)!;
        dictionary.GetType().GetMethod("Clear")!.Invoke(dictionary, null);
    }

    private static void RegisterSessionLock(string uploadId, FileService.SessionLockEntry entry)
    {
        FieldInfo field = typeof(FileService).GetField("_sessionLocks", BindingFlags.Static | BindingFlags.NonPublic)!;
        object dictionary = field.GetValue(null)!;
        dictionary.GetType().GetMethod("TryAdd")!.Invoke(dictionary, [uploadId, entry]);
    }

    private static void TryDisposeSessionLock(string uploadId, FileService.SessionLockEntry entry)
    {
        MethodInfo method = typeof(FileService).GetMethod("TryDisposeSessionLock", BindingFlags.Static | BindingFlags.NonPublic)!;
        method.Invoke(null, [uploadId, entry]);
    }

    private static string GetSessionPath(string root, string uploadId)
        => Path.Combine(root, ".upload-sessions", uploadId);

    private static string GetManifestPath(string root, string uploadId)
        => Path.Combine(GetSessionPath(root, uploadId), "manifest.aeds");

    private static async Task<UploadSessionRecord> ReadManifestAsync(string root, string uploadId)
    {
        byte[] payload = await File.ReadAllBytesAsync(GetManifestPath(root, uploadId));
        MethodInfo method = typeof(FileService).GetMethod("DecodeSession", BindingFlags.Static | BindingFlags.NonPublic)!;
        return (UploadSessionRecord)method.Invoke(null, [payload])!;
    }

    private static async Task WriteManifestAsync(string manifestPath, UploadSessionRecord record)
    {
        MethodInfo method = typeof(FileService).GetMethod("EncodeSession", BindingFlags.Static | BindingFlags.NonPublic)!;
        byte[] payload = (byte[])method.Invoke(null, [record])!;
        await File.WriteAllBytesAsync(manifestPath, payload);
    }

    private static string CreateTempDirectory()
    {
        string path = Path.Combine(Path.GetTempPath(), "fsus-file-service-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }

    private sealed class TestWebHostEnvironment(string root) : IWebHostEnvironment
    {
        public string ApplicationName { get; set; } = nameof(FileServiceTests);
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string WebRootPath { get; set; } = Path.Combine(root, "wwwroot");
        public string EnvironmentName { get; set; } = "Development";
        public string ContentRootPath { get; set; } = root;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }

    // ── Private static helpers via reflection ──────────────────────────────────

    private static T InvokePrivateStatic<T>(string methodName, object?[] args)
    {
        var method = typeof(FileService).GetMethod(methodName, BindingFlags.NonPublic | BindingFlags.Static)!;
        return (T)method.Invoke(null, args)!;
    }

    [Theory]
    [InlineData(null, "")]
    [InlineData("  ", "")]
    [InlineData("  ABC123  ", "abc123")]
    public void NormalizeHash_ReturnsExpected(string? input, string expected)
    {
        var result = InvokePrivateStatic<string>("NormalizeHash", [input]);
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData(null, "")]
    [InlineData("", "")]
    [InlineData(".jpg", ".jpg")]
    [InlineData("jpg", ".jpg")]
    [InlineData("JPG", ".jpg")]
    [InlineData(".WEBP", ".webp")]
    public void NormalizeExtension_ReturnsExpected(string? input, string expected)
    {
        var result = InvokePrivateStatic<string>("NormalizeExtension", [input]);
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData(".jpg", true)]
    [InlineData(".jpeg", true)]
    [InlineData(".png", true)]
    [InlineData(".gif", true)]
    [InlineData(".webp", true)]
    [InlineData(".avif", true)]
    [InlineData(".bmp", false)]
    [InlineData(".exe", false)]
    public void IsAllowedExtension_ReturnsExpected(string ext, bool expected)
    {
        var result = InvokePrivateStatic<bool>("IsAllowedExtension", [ext]);
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData("image/jpeg", true)]
    [InlineData("image/png", true)]
    [InlineData("image/gif", true)]
    [InlineData("image/webp", true)]
    [InlineData("image/avif", true)]
    [InlineData("image/bmp", false)]
    [InlineData(null, false)]
    [InlineData("", false)]
    public void IsSupportedImageMime_ReturnsExpected(string? mimeType, bool expected)
    {
        var result = InvokePrivateStatic<bool>("IsSupportedImageMime", [mimeType]);
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData("image/jpeg", "jpg", true)]
    [InlineData("image/jpeg", "jpeg", true)]
    [InlineData("image/png", "png", true)]
    [InlineData("image/webp", "webp", true)]
    [InlineData("image/jpeg", "png", false)]
    [InlineData(null, "jpg", true)]   // null mime means compatible
    [InlineData("", "jpg", true)]     // empty mime means compatible
    public void IsMimeCompatibleWithFormat_ReturnsExpected(string? mimeType, string format, bool expected)
    {
        var result = InvokePrivateStatic<bool>("IsMimeCompatibleWithFormat", [mimeType, format]);
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", true)]  // 64 hex chars
    [InlineData("ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD", true)]   // 64 hex uppercase
    [InlineData("short", false)]
    [InlineData("gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg", false)]  // invalid hex chars
    public void IsValidSha256_ReturnsExpected(string value, bool expected)
    {
        var result = InvokePrivateStatic<bool>("IsValidSha256", [value]);
        Assert.Equal(expected, result);
    }
}
