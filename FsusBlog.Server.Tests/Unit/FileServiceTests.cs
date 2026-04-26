using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
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
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

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
            Assert.True(upload.IsSuccess);

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

            Assert.True(upload.IsSuccess);

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
    public async Task GetUploadStatusAsync_RecomputesUploadedBytesForLegacyManifest()
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
            UploadSessionRecord legacy = (await ReadManifestAsync(root, init.Value.UploadId)) with { UploadedBytes = 0 };
            await File.WriteAllBytesAsync(manifestPath, JsonSerializer.SerializeToUtf8Bytes(legacy, JsonOptions));

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
            await File.WriteAllBytesAsync(GetManifestPath(root, uploadId), JsonSerializer.SerializeToUtf8Bytes(expired, JsonOptions));

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
        => Path.Combine(GetSessionPath(root, uploadId), "manifest.json");

    private static async Task<UploadSessionRecord> ReadManifestAsync(string root, string uploadId)
    {
        byte[] payload = await File.ReadAllBytesAsync(GetManifestPath(root, uploadId));
        return JsonSerializer.Deserialize<UploadSessionRecord>(payload, JsonOptions)!;
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
}
