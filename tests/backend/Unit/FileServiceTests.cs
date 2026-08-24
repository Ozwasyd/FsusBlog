using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Storage;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services;
using FsusBlog.Server.Tests.Unit;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
namespace FsusBlog.Server.Tests;

[Collection(FileServiceTestCollection.Name)]
public sealed class FileServiceTests
{
    public static IEnumerable<object[]> InvalidUploadIds()
    {
        yield return [""];
        yield return ["   "];
        yield return ["../victim"];
        yield return ["..%2fvictim"];
        yield return ["x/y"];
        yield return [@"x\y"];
        yield return ["."];
        yield return [".."];
        yield return [new string('a', 65)];
        yield return ["00000000-0000-4000-8000-000000000001"];
        yield return ["{00000000-0000-4000-8000-000000000002}"];
    }

    [Fact]
    public void InvalidUploadIds_AreStableAcrossDiscoveryAndExecution()
    {
        string[] discovery = InvalidUploadIds().Select(static values => Assert.IsType<string>(values[0])).ToArray();
        string[] execution = InvalidUploadIds().Select(static values => Assert.IsType<string>(values[0])).ToArray();

        Assert.Equal(discovery, execution);
    }

    [Fact]
    public async Task UploadSessionAccess_RequiresMatchingOwnerAndCapabilityForEveryOperation()
    {
        string root = CreateTempDirectory();
        try
        {
            var service = CreateService(root);
            Result<UploadInitDto> init = await service.InitUploadSessionAsync(41, CreatePngUploadRequest(8));
            Assert.True(init.IsSuccess);
            UploadInitDto session = init.Value!;
            var valid = new UploadSessionAccess(session.UploadId, 41, session.UploadToken);
            var wrongOwner = valid with
            {
                OwnerAdminPrincipalId = 42
            };
            var wrongToken = valid with
            {
                UploadToken = "wrong-token"
            };
            var missingToken = valid with
            {
                UploadToken = null
            };
            var unknown = valid with
            {
                UploadId = Guid.NewGuid().ToString("N")
            };
            var part = CreateFormFile([0x89, 0x50, 0x4E, 0x47, 1, 2, 3, 4], "part");

            Assert.True((await service.GetUploadStatusAsync(valid)).IsSuccess);
            Assert.True((await service.GetUploadPartMapAsync(valid)).IsSuccess);
            Assert.False((await service.CompleteUploadAsync(valid, null)).IsSuccess);

            foreach (UploadSessionAccess denied in new[] { wrongOwner, wrongToken, missingToken, unknown })
            {
                Assert.Equal(ErrorCode.NotFound, (await service.GetUploadStatusAsync(denied)).Error.Code);
                Assert.Equal(ErrorCode.NotFound, (await service.GetUploadPartMapAsync(denied)).Error.Code);
                Assert.Equal(ErrorCode.NotFound, (await service.UploadPartAsync(denied, 0, 0, part, null)).Error.Code);
                Assert.Equal(ErrorCode.NotFound, (await service.CompleteUploadAsync(denied, null)).Error.Code);
                Assert.Equal(ErrorCode.NotFound, (await service.AbortUploadAsync(denied)).Error.Code);
            }

            Assert.True((await service.AbortUploadAsync(valid)).IsSuccess);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task UploadSessionAccess_ExpiresAndDeletesSessionWithoutDistinguishingFailure()
    {
        string root = CreateTempDirectory();
        try
        {
            var service = CreateService(root);
            Result<UploadInitDto> init = await service.InitUploadSessionAsync(41, CreatePngUploadRequest(8));
            UploadInitDto session = Assert.IsType<UploadInitDto>(init.Value);
            await WriteManifestAsync(GetManifestPath(root, session.UploadId), (await ReadManifestAsync(root, session.UploadId)) with
            {
                ExpiresAt = DateTime.UtcNow.AddMinutes(-1)
            });

            Result<UploadStatusDto> result = await service.GetUploadStatusAsync(new UploadSessionAccess(session.UploadId, 41, session.UploadToken));

            Assert.Equal(ErrorCode.NotFound, result.Error.Code);
            Assert.Equal("UPLOAD_SESSION_NOT_FOUND", result.Error.Message);
            Assert.False(Directory.Exists(GetSessionPath(root, session.UploadId)));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task UploadSessionManifest_V4RoundTripsAndNeverPersistsRawToken()
    {
        string root = CreateTempDirectory();
        try
        {
            var service = CreateService(root);
            Result<UploadInitDto> init = await service.InitUploadSessionAsync(41, CreatePngUploadRequest(8));
            UploadInitDto session = Assert.IsType<UploadInitDto>(init.Value);
            byte[] manifest = await File.ReadAllBytesAsync(GetManifestPath(root, session.UploadId));
            UploadSessionRecord record = await ReadManifestAsync(root, session.UploadId);

            Assert.Equal(4, manifest[4]);
            Assert.Equal(41, record.OwnerAdminPrincipalId);
            Assert.Equal(SHA256.HashSizeInBytes, record.UploadTokenSha256.Length);
            Assert.Equal(-1, manifest.AsSpan().IndexOf(Encoding.UTF8.GetBytes(session.UploadToken)));
            Assert.Equal(SHA256.HashData(Encoding.UTF8.GetBytes(session.UploadToken)), record.UploadTokenSha256);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Theory]
    [InlineData((byte)1)]
    [InlineData((byte)2)]
    [InlineData((byte)3)]
    [InlineData((byte)5)]
    public async Task UploadSessionManifest_NonV4IsRejectedAndDeleted(byte version)
    {
        string root = CreateTempDirectory();
        try
        {
            var service = CreateService(root);
            Result<UploadInitDto> init = await service.InitUploadSessionAsync(41, CreatePngUploadRequest(8));
            UploadInitDto session = Assert.IsType<UploadInitDto>(init.Value);
            string manifestPath = GetManifestPath(root, session.UploadId);
            byte[] manifest = await File.ReadAllBytesAsync(manifestPath);
            manifest[4] = version;
            await File.WriteAllBytesAsync(manifestPath, manifest);

            Result<UploadStatusDto> result = await service.GetUploadStatusAsync(new UploadSessionAccess(session.UploadId, 41, session.UploadToken));

            Assert.Equal(ErrorCode.NotFound, result.Error.Code);
            Assert.False(Directory.Exists(GetSessionPath(root, session.UploadId)));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task UploadSessionManifest_CorruptBitmapFailsClosedAndDeletesSession()
    {
        string root = CreateTempDirectory();
        try
        {
            var service = CreateService(root);
            Result<UploadInitDto> init = await service.InitUploadSessionAsync(41, CreatePngUploadRequest(8));
            UploadInitDto session = Assert.IsType<UploadInitDto>(init.Value);
            await WriteManifestAsync(GetManifestPath(root, session.UploadId), (await ReadManifestAsync(root, session.UploadId)) with
            {
                UploadedPartBitmapBase64 = "not-base64"
            });

            Result<UploadPartMapDto> result = await service.GetUploadPartMapAsync(new UploadSessionAccess(session.UploadId, 41, session.UploadToken));

            Assert.Equal(ErrorCode.NotFound, result.Error.Code);
            Assert.False(Directory.Exists(GetSessionPath(root, session.UploadId)));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task UploadSessionAccess_DenialDoesNotLogRawToken()
    {
        string root = CreateTempDirectory();
        try
        {
            var logger = new CapturingLogger<FileService>();
            var service = CreateService(root, logger);
            Result<UploadInitDto> init = await service.InitUploadSessionAsync(41, CreatePngUploadRequest(8));
            UploadInitDto session = Assert.IsType<UploadInitDto>(init.Value);
            string token = session.UploadToken;

            Result<UploadStatusDto> result = await service.GetUploadStatusAsync(new UploadSessionAccess(session.UploadId, 42, token));

            Assert.Equal(ErrorCode.NotFound, result.Error.Code);
            Assert.DoesNotContain(logger.Messages, message => message.Contains(token, StringComparison.Ordinal));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task UploadSessionAccess_ConcurrentOtherAdminCannotQueryOrTerminateOwnersSession()
    {
        string root = CreateTempDirectory();
        try
        {
            var service = CreateService(root);
            Result<UploadInitDto> init = await service.InitUploadSessionAsync(41, CreatePngUploadRequest(8));
            UploadInitDto session = Assert.IsType<UploadInitDto>(init.Value);
            var owner = new UploadSessionAccess(session.UploadId, 41, session.UploadToken);
            var otherAdmin = owner with
            {
                OwnerAdminPrincipalId = 42
            };

            Task<Result<UploadStatusDto>> query = service.GetUploadStatusAsync(otherAdmin);
            Task<Result<bool>> abort = service.AbortUploadAsync(otherAdmin);
            await Task.WhenAll(query, abort);
            Result<UploadStatusDto> queryResult = await query;
            Result<bool> abortResult = await abort;

            Assert.Equal(ErrorCode.NotFound, queryResult.Error.Code);
            Assert.Equal(ErrorCode.NotFound, abortResult.Error.Code);
            Assert.True((await service.GetUploadStatusAsync(owner)).IsSuccess);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task UploadSessionAccess_CompletedUploadRetriesOnlyForMatchingOwnerAndToken()
    {
        string root = CreateTempDirectory();
        try
        {
            var service = CreateService(root);
            byte[] payload = [0x89, 0x50, 0x4E, 0x47, 1, 2, 3, 4];
            string sha256 = Convert.ToHexStringLower(SHA256.HashData(payload));
            Result<UploadInitDto> init = await service.InitUploadSessionAsync(41, CreatePngUploadRequest(payload.Length));
            UploadInitDto session = Assert.IsType<UploadInitDto>(init.Value);
            var owner = new UploadSessionAccess(session.UploadId, 41, session.UploadToken);
            var otherAdmin = owner with
            {
                OwnerAdminPrincipalId = 42
            };

            Assert.True((await service.UploadPartAsync(owner, 0, 0, CreateFormFile(payload, "part"), sha256)).IsSuccess);
            Result<UploadCompleteDto> first = await service.CompleteUploadAsync(owner, sha256);
            Result<UploadCompleteDto> deniedRetry = await service.CompleteUploadAsync(otherAdmin, sha256);
            Result<UploadCompleteDto> ownerRetry = await CreateService(root).CompleteUploadAsync(owner, sha256);

            Assert.True(first.IsSuccess);
            Assert.Equal(ErrorCode.NotFound, deniedRetry.Error.Code);
            Assert.True(ownerRetry.IsSuccess);
            Assert.Equal(first.Value!.RelativeUrl, ownerRetry.Value!.RelativeUrl);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    [Trait("Category", "Concurrency")]
    public async Task CompleteUploadAsync_ConcurrentSameOwnerRetriesFinalizeSingleStableResult()
    {
        ResetSessionLocks();
        string root = CreateTempDirectory();
        try
        {
            byte[] payload = CreatePngPart(2 * 1024 * 1024, 0x41, includeHeader: true);
            string sha256 = Convert.ToHexStringLower(SHA256.HashData(payload));
            FileService setupService = CreateService(root);
            Result<UploadInitDto> init =
                await setupService.InitUploadSessionAsync(41, CreatePngUploadRequest(payload.Length));
            UploadInitDto session = Assert.IsType<UploadInitDto>(init.Value);
            var owner = new UploadSessionAccess(session.UploadId, 41, session.UploadToken);
            Result<UploadPartAckDto> upload = await setupService.UploadPartAsync(
                owner,
                0,
                0,
                CreateFormFile(payload, "complete-race"),
                sha256);
            Assert.True(upload.IsSuccess, upload.Error.Message);

            string commitRoot = Path.Combine(CreateStoragePaths(root).UploadCommitRoot, "current");
            Directory.CreateDirectory(commitRoot);
            int commitCandidateCreations = 0;
            using var watcher = new FileSystemWatcher(commitRoot)
            {
                NotifyFilter = NotifyFilters.FileName,
                EnableRaisingEvents = true
            };
            watcher.Created += (_, args) =>
            {
                if (args.Name?.EndsWith(".tmp", StringComparison.Ordinal) == true)
                {
                    Interlocked.Increment(ref commitCandidateCreations);
                }
            };

            using (var firstWave = new Barrier(4))
            {
                Result<UploadCompleteDto>[] concurrent = await Task.WhenAll(
                    Enumerable.Range(0, 4)
                        .Select(_ => StartTogetherAsync(
                            firstWave,
                            () => CreateService(root).CompleteUploadAsync(owner, sha256))));
                Assert.All(concurrent, result => Assert.True(result.IsSuccess, result.Error.Message));

                using var retryWave = new Barrier(6);
                Result<UploadCompleteDto>[] retries = await Task.WhenAll(
                    Enumerable.Range(0, 6)
                        .Select(_ => StartTogetherAsync(
                            retryWave,
                            () => CreateService(root).CompleteUploadAsync(owner, sha256))));
                Assert.All(retries, result => Assert.True(result.IsSuccess, result.Error.Message));

                UploadCompleteDto expected = concurrent[0].Value!;
                Assert.All(
                    concurrent.Concat(retries),
                    result => Assert.Equal(
                        (expected.UploadId, expected.Url, expected.RelativeUrl, expected.MimeType, expected.TotalBytes),
                        (result.Value!.UploadId, result.Value.Url, result.Value.RelativeUrl, result.Value.MimeType, result.Value.TotalBytes)));
            }

            await FlushFileSystemWatcherAsync(watcher, commitRoot);
            Assert.Equal(1, Volatile.Read(ref commitCandidateCreations));
            string finalPath = Assert.Single(Directory.GetFiles(GetIllustrationFolder(root)));
            Assert.Equal($"{session.UploadId}.png", Path.GetFileName(finalPath));
            Assert.Equal(payload, await File.ReadAllBytesAsync(finalPath));
            Assert.Equal(sha256, Convert.ToHexStringLower(SHA256.HashData(await File.ReadAllBytesAsync(finalPath))));
            Assert.Empty(Directory.GetFiles(commitRoot, "*.tmp"));

            UploadSessionRecord completed = await ReadManifestAsync(root, session.UploadId);
            Assert.Equal("completed", completed.Status);
            Assert.Equal(payload.Length, completed.UploadedBytes);
            Assert.True(Directory.Exists(GetSessionPath(root, session.UploadId)));
            Assert.Single(GetExpirationIndexFiles(root, session.UploadId));
            Result<UploadStatusDto> status = await CreateService(root).GetUploadStatusAsync(owner);
            Assert.True(status.IsSuccess, status.Error.Message);
            Assert.Equal("completed", status.Value!.Status);
            Assert.Equal(payload.Length, status.Value.UploadedBytes);
            Assert.Equal(1, status.Value.UploadedPartCount);
        }
        finally
        {
            ResetSessionLocks();
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    [Trait("Category", "Concurrency")]
    public async Task CompleteUploadAsync_ConcurrentUnauthorizedAttemptsCannotInheritOrDisruptCompletion()
    {
        ResetSessionLocks();
        string root = CreateTempDirectory();
        try
        {
            byte[] payload = CreatePngPart(512 * 1024, 0x52, includeHeader: true);
            string sha256 = Convert.ToHexStringLower(SHA256.HashData(payload));
            FileService setupService = CreateService(root);
            Result<UploadInitDto> init =
                await setupService.InitUploadSessionAsync(41, CreatePngUploadRequest(payload.Length));
            UploadInitDto session = Assert.IsType<UploadInitDto>(init.Value);
            var owner = new UploadSessionAccess(session.UploadId, 41, session.UploadToken);
            Assert.True((await setupService.UploadPartAsync(
                owner,
                0,
                0,
                CreateFormFile(payload, "authorized-race"),
                sha256)).IsSuccess);

            using var start = new Barrier(3);
            Task<Result<UploadCompleteDto>> authorized = StartTogetherAsync(
                start,
                () => CreateService(root).CompleteUploadAsync(owner, sha256));
            Task<Result<UploadCompleteDto>> wrongOwner = StartTogetherAsync(
                start,
                () => CreateService(root).CompleteUploadAsync(
                    owner with
                    {
                        OwnerAdminPrincipalId = 42
                    },
                    sha256));
            Task<Result<UploadCompleteDto>> wrongToken = StartTogetherAsync(
                start,
                () => CreateService(root).CompleteUploadAsync(
                    owner with
                    {
                        UploadToken = "wrong-token"
                    },
                    sha256));

            Result<UploadCompleteDto>[] results = await Task.WhenAll(authorized, wrongOwner, wrongToken);
            Result<UploadCompleteDto> authorizedResult = results[0];
            Result<UploadCompleteDto> wrongOwnerResult = results[1];
            Result<UploadCompleteDto> wrongTokenResult = results[2];

            Assert.True(authorizedResult.IsSuccess, authorizedResult.Error.Message);
            Assert.Equal(ErrorCode.NotFound, wrongOwnerResult.Error.Code);
            Assert.Equal("UPLOAD_SESSION_NOT_FOUND", wrongOwnerResult.Error.Message);
            Assert.Equal(ErrorCode.NotFound, wrongTokenResult.Error.Code);
            Assert.Equal("UPLOAD_SESSION_NOT_FOUND", wrongTokenResult.Error.Message);
            string finalPath = Assert.Single(Directory.GetFiles(GetIllustrationFolder(root)));
            Assert.Equal(payload, await File.ReadAllBytesAsync(finalPath));
            Assert.Equal("completed", (await ReadManifestAsync(root, session.UploadId)).Status);
            Assert.True(Directory.Exists(GetSessionPath(root, session.UploadId)));
            Assert.Single(GetExpirationIndexFiles(root, session.UploadId));
        }
        finally
        {
            ResetSessionLocks();
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    [Trait("Category", "Concurrency")]
    public async Task CompleteUploadAsync_FinalizationFailureLeavesRetryableSessionWithoutPartialArtifact()
    {
        ResetSessionLocks();
        string root = CreateTempDirectory();
        try
        {
            byte[] payload = CreatePngPart(512 * 1024, 0x63, includeHeader: true);
            string sha256 = Convert.ToHexStringLower(SHA256.HashData(payload));
            FileService service = CreateService(root);
            Result<UploadInitDto> init =
                await service.InitUploadSessionAsync(41, CreatePngUploadRequest(payload.Length));
            UploadInitDto session = Assert.IsType<UploadInitDto>(init.Value);
            var owner = new UploadSessionAccess(session.UploadId, 41, session.UploadToken);
            Assert.True((await service.UploadPartAsync(
                owner,
                0,
                0,
                CreateFormFile(payload, "failed-finalization"),
                sha256)).IsSuccess);

            string finalPath = Path.Combine(GetIllustrationFolder(root), $"{session.UploadId}.png");
            Directory.CreateDirectory(finalPath);

            Result<UploadCompleteDto> failed = await service.CompleteUploadAsync(owner, sha256);

            Assert.False(failed.IsSuccess);
            Assert.Equal(ErrorCode.InfraFailure, failed.Error.Code);
            Assert.True(Directory.Exists(finalPath));
            Assert.Empty(Directory.EnumerateFiles(finalPath));
            string commitRoot = Path.Combine(CreateStoragePaths(root).UploadCommitRoot, "current");
            Assert.Empty(Directory.GetFiles(commitRoot, "*.tmp"));
            UploadSessionRecord retryable = await ReadManifestAsync(root, session.UploadId);
            Assert.Equal("uploaded", retryable.Status);
            Assert.True(Directory.Exists(GetSessionPath(root, session.UploadId)));
            Assert.Single(GetExpirationIndexFiles(root, session.UploadId));

            Directory.Delete(finalPath);
            Result<UploadCompleteDto> retry = await CreateService(root).CompleteUploadAsync(owner, sha256);
            Result<UploadCompleteDto> stableRetry = await CreateService(root).CompleteUploadAsync(owner, sha256);

            Assert.True(retry.IsSuccess, retry.Error.Message);
            Assert.True(stableRetry.IsSuccess, stableRetry.Error.Message);
            Assert.Equal(retry.Value!.RelativeUrl, stableRetry.Value!.RelativeUrl);
            Assert.Equal(payload, await File.ReadAllBytesAsync(finalPath));
            Assert.Single(Directory.GetFiles(GetIllustrationFolder(root)));
            Assert.Equal("completed", (await ReadManifestAsync(root, session.UploadId)).Status);
            Assert.Single(GetExpirationIndexFiles(root, session.UploadId));
        }
        finally
        {
            ResetSessionLocks();
            Directory.Delete(root, recursive: true);
        }
    }

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
    public async Task UploadPartAsync_HashMismatchDeletesPartAndDoesNotPersistProgress()
    {
        ResetSessionLocks();
        string root = CreateTempDirectory();
        try
        {
            var service = CreateService(root);
            byte[] payload = [0x89, 0x50, 0x4E, 0x47, 1, 2, 3, 4];
            string wrongSha256 = new('0', 64);

            Result<UploadInitDto> init = await service.InitUploadSessionAsync(new UploadInitRequestDto
            {
                FileName = "sample.png",
                MimeType = "image/png",
                TargetFormat = "png",
                TotalBytes = payload.Length,
                ChunkSize = payload.Length
            });

            Assert.True(init.IsSuccess);
            Result<UploadPartAckDto> upload = await service.UploadPartAsync(
                init.Value!.UploadId,
                0,
                0,
                CreateFormFile(payload, "chunk"),
                wrongSha256);

            Assert.False(upload.IsSuccess);
            Assert.False(File.Exists(GetPartPath(root, init.Value.UploadId, 0)));
            UploadSessionRecord record = await ReadManifestAsync(root, init.Value.UploadId);
            Assert.Empty(record.UploadedParts is null ? Array.Empty<int>() : record.UploadedParts);
            Assert.Equal(0, record.UploadedBytes);
        }
        finally
        {
            ResetSessionLocks();
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task UploadPartAsync_ConcurrentDistinctPartsCompleteSuccessfully()
    {
        ResetSessionLocks();
        string root = CreateTempDirectory();
        try
        {
            var service = CreateService(root);
            byte[] part0 = new byte[64 * 1024];
            byte[] part1 = new byte[64 * 1024];
            byte[] pngHeader = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
            pngHeader.CopyTo(part0, 0);
            Array.Fill<byte>(part0, 0x11, pngHeader.Length, part0.Length - pngHeader.Length);
            Array.Fill<byte>(part1, 0x22);
            byte[] payload = [.. part0, .. part1];
            string finalSha256 = Convert.ToHexStringLower(SHA256.HashData(payload));

            Result<UploadInitDto> init = await service.InitUploadSessionAsync(new UploadInitRequestDto
            {
                FileName = "sample.png",
                MimeType = "image/png",
                TargetFormat = "png",
                TotalBytes = payload.Length,
                ChunkSize = part0.Length,
                Sha256 = finalSha256
            });

            Assert.True(init.IsSuccess);
            Task<Result<UploadPartAckDto>> first = service.UploadPartAsync(
                init.Value!.UploadId,
                0,
                0,
                CreateFormFile(part0, "chunk0"),
                Convert.ToHexStringLower(SHA256.HashData(part0)));
            Task<Result<UploadPartAckDto>> second = service.UploadPartAsync(
                init.Value.UploadId,
                1,
                part0.Length,
                CreateFormFile(part1, "chunk1"),
                Convert.ToHexStringLower(SHA256.HashData(part1)));

            Result<UploadPartAckDto>[] uploads = await Task.WhenAll(first, second);

            Assert.All(uploads, upload => Assert.True(upload.IsSuccess, upload.Error.Message));
            Result<UploadCompleteDto> complete = await service.CompleteUploadAsync(init.Value.UploadId, finalSha256);
            Assert.True(complete.IsSuccess, complete.Error.Message);
            Assert.Equal(payload.Length, complete.Value!.TotalBytes);
        }
        finally
        {
            ResetSessionLocks();
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task CompleteUploadAsync_NewSessionCompletesFromRandomAccessWorkingFileWithoutPartFiles()
    {
        ResetSessionLocks();
        string root = CreateTempDirectory();
        try
        {
            var service = CreateService(root);
            byte[] part0 = new byte[64 * 1024];
            byte[] part1 = new byte[64 * 1024];
            byte[] pngHeader = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
            pngHeader.CopyTo(part0, 0);
            Array.Fill<byte>(part0, 0x11, pngHeader.Length, part0.Length - pngHeader.Length);
            Array.Fill<byte>(part1, 0x22);
            byte[] payload = [.. part0, .. part1];
            string finalSha256 = Convert.ToHexStringLower(SHA256.HashData(payload));

            Result<UploadInitDto> init = await service.InitUploadSessionAsync(new UploadInitRequestDto
            {
                FileName = "sample.png",
                MimeType = "image/png",
                TargetFormat = "png",
                TotalBytes = payload.Length,
                ChunkSize = part0.Length,
                Sha256 = finalSha256
            });

            Assert.True(init.IsSuccess);
            Result<UploadPartAckDto> second = await service.UploadPartAsync(
                init.Value!.UploadId,
                1,
                part0.Length,
                CreateFormFile(part1, "chunk1"),
                Convert.ToHexStringLower(SHA256.HashData(part1)));
            Result<UploadPartAckDto> first = await service.UploadPartAsync(
                init.Value.UploadId,
                0,
                0,
                CreateFormFile(part0, "chunk0"),
                Convert.ToHexStringLower(SHA256.HashData(part0)));

            Assert.True(second.IsSuccess, second.Error.Message);
            Assert.True(first.IsSuccess, first.Error.Message);
            Assert.True(File.Exists(GetWorkingFilePath(root, init.Value.UploadId)));
            Directory.Delete(Path.Combine(GetSessionPath(root, init.Value.UploadId), "parts"), recursive: true);

            Result<UploadCompleteDto> complete = await service.CompleteUploadAsync(init.Value.UploadId, finalSha256);

            Assert.True(complete.IsSuccess, complete.Error.Message);
            Assert.Equal(payload.Length, complete.Value!.TotalBytes);
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
            UploadSessionRecord persistedWithStaleBytes = (await ReadManifestAsync(root, init.Value.UploadId)) with
            {
                UploadedBytes = 0
            };
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
    public async Task GetUploadStatusAsync_RecognizesBitmapSidecarBeyondManifestCheckpoint()
    {
        ResetSessionLocks();
        string root = CreateTempDirectory();
        try
        {
            var service = CreateService(root);
            byte[][] parts =
            [
                CreatePngPart(64 * 1024, 0x11, includeHeader: true),
                CreatePngPart(64 * 1024, 0x22),
                CreatePngPart(64 * 1024, 0x33),
                CreatePngPart(64 * 1024, 0x44)
            ];
            int totalParts = 10;
            Result<UploadInitDto> init = await service.InitUploadSessionAsync(new UploadInitRequestDto
            {
                FileName = "sample.png",
                MimeType = "image/png",
                TargetFormat = "png",
                TotalBytes = totalParts * parts[0].Length,
                ChunkSize = parts[0].Length,
            });

            Assert.True(init.IsSuccess);
            for (int i = 0; i < parts.Length; i++)
            {
                Result<UploadPartAckDto> upload = await service.UploadPartAsync(
                    init.Value!.UploadId,
                    i,
                    (long)i * parts[i].Length,
                    CreateFormFile(parts[i], $"chunk{i}"),
                    Convert.ToHexStringLower(SHA256.HashData(parts[i])));
                Assert.True(upload.IsSuccess, upload.Error.Message);
            }

            UploadSessionRecord checkpoint = await ReadManifestAsync(root, init.Value!.UploadId);
            Assert.True(checkpoint.ManifestCheckpointPartCount < parts.Length);

            var resumedService = CreateService(root);
            Result<UploadStatusDto> status = await resumedService.GetUploadStatusAsync(init.Value.UploadId);
            Result<UploadPartMapDto> partMap = await resumedService.GetUploadPartMapAsync(init.Value.UploadId);

            Assert.True(status.IsSuccess, status.Error.Message);
            Assert.Equal(parts.Length, status.Value!.UploadedPartCount);
            Assert.Equal(parts.Sum(static part => part.Length), status.Value.UploadedBytes);
            Assert.True(partMap.IsSuccess, partMap.Error.Message);
            UploadPartRangeDto range = Assert.Single(partMap.Value!.UploadedRanges);
            Assert.Equal(0, range.Start);
            Assert.Equal(parts.Length - 1, range.End);
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
    public async Task CleanupExpiredSessionsAsync_RemovesManifestlessPartsResidue()
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

            Assert.False(Directory.Exists(sessionPath));
        }
        finally
        {
            ResetSessionLocks();
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task CleanupExpiredSessionsAsync_RemovesLegacyManifestlessRootDirectory()
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
    public async Task CleanupExpiredSessionsAsync_RemovesInvalidManifestsAndOrphanResidue()
    {
        string root = CreateTempDirectory();
        try
        {
            var service = CreateService(root);
            string sessionRoot = CreateStoragePaths(root).UploadSessionRoot;
            string oldSessionId = Guid.NewGuid().ToString("N");
            string corruptSessionId = Guid.NewGuid().ToString("N");
            Directory.CreateDirectory(Path.Combine(sessionRoot, oldSessionId, "parts"));
            Directory.CreateDirectory(Path.Combine(sessionRoot, corruptSessionId, "parts"));
            await File.WriteAllBytesAsync(Path.Combine(sessionRoot, oldSessionId, "manifest.aeds"), [0x46, 0x55, 0x50, 0x53, 3]);
            await File.WriteAllBytesAsync(Path.Combine(sessionRoot, corruptSessionId, "manifest.aeds"), [0x00, 0x01]);
            string incoming = Path.Combine(sessionRoot, ".incoming");
            Directory.CreateDirectory(incoming);
            await File.WriteAllTextAsync(Path.Combine(incoming, "partial"), "residue");

            await service.CleanupExpiredSessionsAsync(CancellationToken.None);

            Assert.False(Directory.Exists(Path.Combine(sessionRoot, oldSessionId)));
            Assert.False(Directory.Exists(Path.Combine(sessionRoot, corruptSessionId)));
            Assert.False(Directory.Exists(incoming));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task SessionLockEntry_RetireAfterReference_DoesNotDisposeSemaphoreUntilReleased()
    {
        ResetSessionLocks();
        var entry = new FileService.SessionLockEntry();
        const string UploadId = "session-lock-test";
        RegisterSessionLock(UploadId, entry);

        Assert.True(entry.TryAddReference());
        entry.MarkRetired();
        TryDisposeSessionLock(UploadId, entry);

        await entry.Semaphore.WaitAsync();
        entry.Semaphore.Release();

        entry.ReleaseReference();
        TryDisposeSessionLock(UploadId, entry);

        await Assert.ThrowsAsync<ObjectDisposedException>(async () => await entry.Semaphore.WaitAsync());
    }

    [Fact]
    public async Task AcquireSessionLockAsync_CanceledWaitRemovesEntry()
    {
        ResetSessionLocks();
        string uploadId = Guid.NewGuid().ToString("N");
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            async () => await AcquireSessionLockForTestsAsync(uploadId, cts.Token));

        Assert.Equal(0, GetSessionLockCount());
    }

    [Fact]
    public async Task CleanupStaleSessionLocks_RemovesIdleExpiredEntry()
    {
        ResetSessionLocks();
        var entry = new FileService.SessionLockEntry();
        string uploadId = Guid.NewGuid().ToString("N");
        RegisterSessionLock(uploadId, entry);
        entry.SetLastTouchedUtcForTests(DateTimeOffset.UtcNow - TimeSpan.FromHours(7));

        int removed = FileService.CleanupStaleSessionLocks(DateTimeOffset.UtcNow);

        Assert.Equal(1, removed);
        Assert.Equal(0, GetSessionLockCount());
        await Assert.ThrowsAsync<ObjectDisposedException>(async () => await entry.Semaphore.WaitAsync());
    }

    [Fact]
    public async Task CleanupExpiredSessionsAsync_RemovesStaleSessionLocks()
    {
        ResetSessionLocks();
        string root = CreateTempDirectory();
        try
        {
            var service = CreateService(root);
            var entry = new FileService.SessionLockEntry();
            string uploadId = Guid.NewGuid().ToString("N");
            RegisterSessionLock(uploadId, entry);
            entry.SetLastTouchedUtcForTests(DateTimeOffset.UtcNow - TimeSpan.FromHours(7));

            await service.CleanupExpiredSessionsAsync(CancellationToken.None);

            Assert.Equal(0, GetSessionLockCount());
            await Assert.ThrowsAsync<ObjectDisposedException>(async () => await entry.Semaphore.WaitAsync());
        }
        finally
        {
            ResetSessionLocks();
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task CleanupExpiredSessionsAsync_LeasesCommitTempCleanupAndPreservesRetentionWindow()
    {
        ResetSessionLocks();
        string root = CreateTempDirectory();
        try
        {
            var service = CreateService(root);
            string incomingRoot = CreateStoragePaths(root).UploadCommitRoot;
            string staleDirectory = Path.Combine(incomingRoot, "retired-release-instance");
            string freshDirectory = Path.Combine(incomingRoot, "other-live-instance");
            Directory.CreateDirectory(staleDirectory);
            Directory.CreateDirectory(freshDirectory);
            string staleFile = Path.Combine(staleDirectory, "stale.tmp");
            string freshFile = Path.Combine(freshDirectory, "fresh.tmp");
            await File.WriteAllTextAsync(staleFile, "stale");
            await File.WriteAllTextAsync(freshFile, "fresh");
            File.SetLastWriteTimeUtc(staleFile, DateTime.UtcNow.AddDays(-2));
            int commitChecks = 0;

            await service.CleanupExpiredSessionsAsync(
                CancellationToken.None,
                _ =>
                {
                    Interlocked.Increment(ref commitChecks);
                    return Task.CompletedTask;
                });

            Assert.False(File.Exists(staleFile));
            Assert.True(File.Exists(freshFile));
            Assert.True(commitChecks >= 1);
        }
        finally
        {
            ResetSessionLocks();
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void SessionLockEntry_RetiredEntryRejectsNewReferences()
    {
        var entry = new FileService.SessionLockEntry();

        entry.MarkRetired();

        Assert.False(entry.TryAddReference());
    }

    private static FileService CreateService(string root)
        => new(CreateStoragePaths(root), NullLogger<FileService>.Instance);

    private static FileService CreateService(string root, ILogger<FileService> logger)
        => new(CreateStoragePaths(root), logger);

    private static UploadInitRequestDto CreatePngUploadRequest(int totalBytes)
        => new()
        {
            FileName = "sample.png",
            MimeType = "image/png",
            TargetFormat = "png",
            TotalBytes = totalBytes,
            ChunkSize = totalBytes
        };

    private static ReleaseStoragePaths CreateStoragePaths(string root)
        => ReleaseStorageTestPaths.Create(root);

    // ── InitUploadSessionAsync – validation guards ─────────────────────────────

    public static TheoryData<string, string, string, string, long, int, ErrorCode, string>
        InvalidUploadInitRequestCases
    {
        get
        {
            var cases = new TheoryData<string, string, string, string, long, int, ErrorCode, string>
            {
                {
                    "blank-file-name",
                    "   ",
                    "image/png",
                    "png",
                    100,
                    100,
                    ErrorCode.Validation,
                    "文件名不能为空"
                },
                {
                    "zero-total-bytes",
                    "test.png",
                    "image/png",
                    "png",
                    0,
                    100,
                    ErrorCode.Validation,
                    "图片大小超出限制"
                },
                {
                    "unsupported-mime-format",
                    "test.exe",
                    "application/octet-stream",
                    "exe",
                    100,
                    100,
                    ErrorCode.Validation,
                    "图片类型不支持"
                },
                {
                    "avif-request",
                    "photo.avif",
                    "image/avif",
                    "avif",
                    100,
                    100,
                    ErrorCode.Validation,
                    "图片类型不支持"
                },
                {
                    "mismatched-mime-and-format",
                    "test.png",
                    "image/jpeg",
                    "png",
                    100,
                    100,
                    ErrorCode.Validation,
                    "目标格式与 mimeType 不一致"
                }
            };
            if (cases.Count != 5)
            {
                throw new InvalidOperationException(
                    "The invalid upload initialization inventory must contain exactly five cases.");
            }

            return cases;
        }
    }

    [Theory]
    [MemberData(nameof(InvalidUploadInitRequestCases))]
    public async Task InitUploadAsync_InvalidRequest_ReturnsExpectedFailure(
        string caseName,
        string fileName,
        string mimeType,
        string targetFormat,
        long totalBytes,
        int chunkSize,
        ErrorCode expectedErrorCode,
        string expectedReason)
    {
        string root = CreateTempDirectory();
        try
        {
            ReleaseStoragePaths storagePaths = CreateStoragePaths(root);
            var svc = new FileService(storagePaths, NullLogger<FileService>.Instance);
            Result<UploadInitDto> result = await svc.InitUploadSessionAsync(1, new UploadInitRequestDto
            {
                FileName = fileName,
                MimeType = mimeType,
                TargetFormat = targetFormat,
                TotalBytes = totalBytes,
                ChunkSize = chunkSize
            });

            Assert.False(result.IsSuccess, $"Invalid upload case '{caseName}' unexpectedly succeeded.");
            Assert.True(
                result.Error.Code == expectedErrorCode,
                $"Invalid upload case '{caseName}' returned {result.Error.Code}, expected {expectedErrorCode}.");
            Assert.True(
                string.Equals(result.Error.Message, expectedReason, StringComparison.Ordinal),
                $"Invalid upload case '{caseName}' returned reason '{result.Error.Message}', expected '{expectedReason}'.");

            string expirationRoot = Path.Combine(storagePaths.UploadSessionRoot, "expires");
            Assert.True(
                Directory.Exists(expirationRoot),
                $"Invalid upload case '{caseName}' removed the fixed expiration-index root.");
            string[] sessionDirectories = Directory.GetDirectories(storagePaths.UploadSessionRoot)
                .Where(path => !string.Equals(path, expirationRoot, StringComparison.Ordinal))
                .ToArray();
            Assert.True(
                sessionDirectories.Length == 0,
                $"Invalid upload case '{caseName}' created a session directory.");
            Assert.True(
                Directory.GetDirectories(expirationRoot).Length == 0,
                $"Invalid upload case '{caseName}' created an expiration-index bucket.");
            Assert.True(
                Directory.GetFiles(root, "*", SearchOption.AllDirectories).Length == 0,
                $"Invalid upload case '{caseName}' created a manifest, expiration index, or temporary file.");
            Assert.False(
                Directory.Exists(storagePaths.UploadCommitRoot),
                $"Invalid upload case '{caseName}' created the upload commit root.");
            Assert.False(
                Directory.Exists(storagePaths.TempRoot),
                $"Invalid upload case '{caseName}' created the temporary root.");
        }
        finally
        {
            if (Directory.Exists(root))
            {
                Directory.Delete(root, recursive: true);
            }

            Assert.False(Directory.Exists(root), $"Invalid upload case '{caseName}' leaked its temporary root.");
        }
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
                FileName = "photo.webp",
                MimeType = "image/webp",
                TargetFormat = "webp",
                TotalBytes = 200,
                ChunkSize = 200
            });
            Assert.True(result.IsSuccess);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
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
                FileName = "photo.jpg",
                MimeType = "image/jpeg",
                TargetFormat = "jpg",
                TotalBytes = 200,
                ChunkSize = 200
            });
            Assert.True(result.IsSuccess);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task InitUploadAsync_ValidIcoRequest_ReturnsSuccess()
    {
        string root = CreateTempDirectory();
        try
        {
            var svc = CreateService(root);
            var result = await svc.InitUploadSessionAsync(new UploadInitRequestDto
            {
                FileName = "favicon.ico",
                MimeType = "image/x-icon",
                TargetFormat = "ico",
                TotalBytes = 200,
                ChunkSize = 200
            });
            Assert.True(result.IsSuccess);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task GetUploadStatusAsync_UnknownId_ReturnsFail()
    {
        string root = CreateTempDirectory();
        try
        {
            var svc = CreateService(root);
            var result = await svc.GetUploadStatusAsync(Guid.NewGuid().ToString("N"));
            Assert.False(result.IsSuccess);
            Assert.Equal(ErrorCode.NotFound, result.Error.Code);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task GetUploadPartMapAsync_UnknownId_ReturnsFail()
    {
        string root = CreateTempDirectory();
        try
        {
            var svc = CreateService(root);
            var result = await svc.GetUploadPartMapAsync(Guid.NewGuid().ToString("N"));
            Assert.False(result.IsSuccess);
            Assert.Equal(ErrorCode.NotFound, result.Error.Code);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task AbortUploadAsync_UnknownId_ReturnsFail()
    {
        string root = CreateTempDirectory();
        try
        {
            var svc = CreateService(root);
            var result = await svc.AbortUploadAsync(Guid.NewGuid().ToString("N"));
            Assert.False(result.IsSuccess);
            Assert.Equal(ErrorCode.NotFound, result.Error.Code);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Theory]
    [MemberData(nameof(InvalidUploadIds))]
    public async Task AbortUploadAsync_InvalidUploadId_DoesNotDeleteSessionRootOrOutsideDirectory(string uploadId)
    {
        ResetSessionLocks();
        string root = CreateTempDirectory();
        try
        {
            var svc = CreateService(root);
            string sessionRoot = CreateStoragePaths(root).UploadSessionRoot;
            string victim = Path.Combine(root, "victim");
            Directory.CreateDirectory(victim);
            await File.WriteAllTextAsync(Path.Combine(victim, "sentinel.txt"), "keep");

            Result<bool> result = await svc.AbortUploadAsync(uploadId);

            Assert.False(result.IsSuccess);
            Assert.Equal(ErrorCode.Validation, result.Error.Code);
            Assert.True(Directory.Exists(sessionRoot));
            Assert.True(Directory.Exists(victim));
            Assert.True(File.Exists(Path.Combine(victim, "sentinel.txt")));
            Assert.Equal(0, GetSessionLockCount());
        }
        finally
        {
            ResetSessionLocks();
            Directory.Delete(root, recursive: true);
        }
    }

    [Theory]
    [MemberData(nameof(InvalidUploadIds))]
    public async Task UploadSessionReadAndWriteOperations_RejectInvalidUploadIdWithoutRetainingLock(string uploadId)
    {
        ResetSessionLocks();
        string root = CreateTempDirectory();
        try
        {
            var svc = CreateService(root);
            byte[] payload = [0x89, 0x50, 0x4E, 0x47];

            Result<UploadStatusDto> status = await svc.GetUploadStatusAsync(uploadId);
            Result<UploadPartMapDto> partMap = await svc.GetUploadPartMapAsync(uploadId);
            Result<UploadPartAckDto> upload = await svc.UploadPartAsync(uploadId, 0, 0, CreateFormFile(payload, "chunk"), null);
            Result<UploadCompleteDto> complete = await svc.CompleteUploadAsync(uploadId, null);

            Assert.False(status.IsSuccess);
            Assert.False(partMap.IsSuccess);
            Assert.False(upload.IsSuccess);
            Assert.False(complete.IsSuccess);
            Assert.Equal(ErrorCode.Validation, status.Error.Code);
            Assert.Equal(ErrorCode.Validation, partMap.Error.Code);
            Assert.Equal(ErrorCode.Validation, upload.Error.Code);
            Assert.Equal(ErrorCode.Validation, complete.Error.Code);
            Assert.Equal(0, GetSessionLockCount());
        }
        finally
        {
            ResetSessionLocks();
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task CompleteUploadAsync_RejectsGifPolyglotPayload()
    {
        ResetSessionLocks();
        string root = CreateTempDirectory();
        try
        {
            var svc = CreateService(root);
            byte[] payload = Encoding.ASCII.GetBytes("GIF89a<script>alert(1)</script>");
            string sha256 = Convert.ToHexStringLower(SHA256.HashData(payload));
            Result<UploadInitDto> init = await svc.InitUploadSessionAsync(new UploadInitRequestDto
            {
                FileName = "polyglot.gif",
                MimeType = "image/gif",
                TargetFormat = "gif",
                TotalBytes = payload.Length,
                ChunkSize = payload.Length
            });

            Assert.True(init.IsSuccess);
            Result<UploadPartAckDto> upload = await svc.UploadPartAsync(init.Value!.UploadId, 0, 0, CreateFormFile(payload, "chunk"), sha256);
            Assert.True(upload.IsSuccess, upload.Error.Message);

            Result<UploadCompleteDto> complete = await svc.CompleteUploadAsync(init.Value.UploadId, sha256);

            Assert.False(complete.IsSuccess);
            Assert.Equal(ErrorCode.Validation, complete.Error.Code);
        }
        finally
        {
            ResetSessionLocks();
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task DeleteImageAsync_DeletesFromWebRootUploadFolderWhenContentRootDiffers()
    {
        string root = CreateTempDirectory();
        try
        {
            var svc = CreateService(root);
            string filePath = Path.Combine(GetIllustrationFolder(root), "sample.png");
            await File.WriteAllBytesAsync(filePath, [0x89, 0x50, 0x4E, 0x47]);

            bool deleted = await svc.DeleteImageAsync("/uploads/illustration/sample.png");

            Assert.True(deleted);
            Assert.False(File.Exists(filePath));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task DeleteImageAsync_SanitizesSecurityWarningPathBeforeLogging()
    {
        string root = CreateTempDirectory();
        try
        {
            var logger = new CapturingLogger<FileService>();
            var svc = CreateService(root, logger);

            bool deleted = await svc.DeleteImageAsync("/outside\r\nINJECT\u001b[31m");

            Assert.False(deleted);
            string message = Assert.Single(logger.Messages);
            Assert.DoesNotContain('\r', message);
            Assert.DoesNotContain('\n', message);
            Assert.DoesNotContain('\u001b', message);
            Assert.Contains("\\r\\n", message, StringComparison.Ordinal);
            Assert.Contains("\\u001B", message, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
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
                FileName = "test.png",
                MimeType = "image/png",
                TargetFormat = "png",
                TotalBytes = payload.Length,
                ChunkSize = payload.Length
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

    [Fact]
    public async Task CompleteUploadAsync_FinalHashMismatchDeletesAssembledTemp()
    {
        ResetSessionLocks();
        string root = CreateTempDirectory();
        try
        {
            var svc = CreateService(root);
            byte[] payload = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4];
            string partSha256 = Convert.ToHexStringLower(SHA256.HashData(payload));
            string wrongSha256 = new('f', 64);
            var init = await svc.InitUploadSessionAsync(new UploadInitRequestDto
            {
                FileName = "test.png",
                MimeType = "image/png",
                TargetFormat = "png",
                TotalBytes = payload.Length,
                ChunkSize = payload.Length
            });

            Assert.True(init.IsSuccess);
            Result<UploadPartAckDto> upload = await svc.UploadPartAsync(init.Value!.UploadId, 0, 0, CreateFormFile(payload, "chunk"), partSha256);
            Assert.True(upload.IsSuccess);

            Result<UploadCompleteDto> complete = await svc.CompleteUploadAsync(init.Value.UploadId, wrongSha256);

            Assert.False(complete.IsSuccess);
            Assert.False(File.Exists(Path.Combine(GetSessionPath(root, init.Value.UploadId), "assembled.png")));
            Assert.True(Directory.Exists(GetSessionPath(root, init.Value.UploadId)));
        }
        finally
        {
            ResetSessionLocks();
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task CompleteUploadAsync_SignatureMismatchDeletesAssembledTemp()
    {
        ResetSessionLocks();
        string root = CreateTempDirectory();
        try
        {
            var svc = CreateService(root);
            byte[] payload = [0x42, 0x41, 0x44, 0x21, 0x0D, 0x0A, 0x1A, 0x0A];
            string sha256 = Convert.ToHexStringLower(SHA256.HashData(payload));
            var init = await svc.InitUploadSessionAsync(new UploadInitRequestDto
            {
                FileName = "test.png",
                MimeType = "image/png",
                TargetFormat = "png",
                TotalBytes = payload.Length,
                ChunkSize = payload.Length,
                Sha256 = sha256
            });

            Assert.True(init.IsSuccess);
            Result<UploadPartAckDto> upload = await svc.UploadPartAsync(init.Value!.UploadId, 0, 0, CreateFormFile(payload, "chunk"), sha256);
            Assert.True(upload.IsSuccess);

            Result<UploadCompleteDto> complete = await svc.CompleteUploadAsync(init.Value.UploadId, sha256);

            Assert.False(complete.IsSuccess);
            Assert.False(File.Exists(Path.Combine(GetSessionPath(root, init.Value.UploadId), "assembled.png")));
            Assert.Empty(Directory.EnumerateFiles(GetIllustrationFolder(root)));
        }
        finally
        {
            ResetSessionLocks();
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void UploadHotPathSource_DoesNotReopenWrittenFilesForHashOrSignature()
    {
        IReadOnlyList<string> streamingWriteCallers = RuntimeMetadataInspection.FindMethodsCallingMember(
            typeof(FileService),
            static member => member.DeclaringType == typeof(FileService)
                && member.Name == "WritePartToWorkingFileAndComputeHashAsync");
        Assert.Contains(streamingWriteCallers, static caller => caller.Contains("<UploadPartAsync>", StringComparison.Ordinal));

        foreach (string requiredMethod in new[] { "AnalyzeWorkingUploadAsync", "AssembleUploadAsync", "ValidateImageSignature" })
        {
            IReadOnlyList<string> callers = RuntimeMetadataInspection.FindMethodsCallingMember(
                typeof(FileService),
                member => member.DeclaringType == typeof(FileService) && member.Name == requiredMethod);
            Assert.Contains(callers, static caller => caller.Contains("<CompleteUploadAsync>", StringComparison.Ordinal));
        }
        foreach (string forbiddenMethod in new[] { "ComputeSha256Async", "ValidateImageSignatureAsync" })
        {
            IReadOnlyList<string> callers = RuntimeMetadataInspection.FindMethodsCallingMember(
                typeof(FileService),
                member => member.DeclaringType == typeof(FileService) && member.Name == forbiddenMethod);
            Assert.DoesNotContain(callers, static caller => caller.Contains("<UploadPartAsync>", StringComparison.Ordinal)
                || caller.Contains("<CompleteUploadAsync>", StringComparison.Ordinal));
        }
    }

    [Fact]
    public void UploadSessionStorage_UsesRandomPrivateManifestTempFiles()
    {
        foreach ((Type declaringType, string methodName) in new[]
        {
            (typeof(Path), nameof(Path.GetRandomFileName)),
            (typeof(File), nameof(File.Replace)),
            (typeof(FileService), "CreatePrivateWriteOptions")
        })
        {
            IReadOnlyList<string> callers = RuntimeMetadataInspection.FindMethodsCallingMember(
                typeof(FileService),
                member => member.DeclaringType == declaringType && member.Name == methodName);
            Assert.Contains(callers, static caller => caller.Contains("<SaveSessionAsync>", StringComparison.Ordinal));
        }
    }

    [Fact]
    public void UploadSessionCleanup_SourceUsesExpirationBucketIndex()
    {
        string cleanup = RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
            typeof(FileService),
            "EnumerateExpiredExpirationBuckets",
            "RecordUploadSessionCleanup");

        Assert.NotNull(typeof(FileService).GetMethod("WriteExpirationIndexAsync", BindingFlags.Instance | BindingFlags.NonPublic));
        Assert.NotNull(typeof(FileService).GetMethod("TryReadExpirationIndexOwner", BindingFlags.Instance | BindingFlags.NonPublic));
        Assert.NotNull(typeof(FileService).GetMethod("DeleteOwnedExpirationIndex", BindingFlags.Instance | BindingFlags.NonPublic));
        Assert.Contains("EnumerateExpiredExpirationBuckets", cleanup, StringComparison.Ordinal);
        Assert.Contains("RecordUploadSessionCleanup", cleanup, StringComparison.Ordinal);
        Assert.Null(typeof(FileService).GetMethod("CleanupLegacySessionRootSweepAsync", BindingFlags.Instance | BindingFlags.NonPublic));

        // Background cleanup may enumerate expired hour buckets; request hot paths must not.
        IReadOnlyList<string> enumerateCallers = RuntimeMetadataInspection.FindMethodsCallingMember(
            typeof(FileService),
            static member => member.DeclaringType == typeof(Directory)
                && member.Name == nameof(Directory.EnumerateDirectories));
        Assert.Contains(enumerateCallers, static caller => caller.Contains("EnumerateExpiredExpirationBuckets", StringComparison.Ordinal));
        Assert.DoesNotContain(enumerateCallers, static caller =>
            caller.Contains("AbortUploadAsync", StringComparison.Ordinal)
            || caller.Contains("CompleteUploadAsync", StringComparison.Ordinal)
            || caller.Contains("DeleteOwnedExpirationIndex", StringComparison.Ordinal)
            || caller.Contains("DeleteSessionDirectoryAsync", StringComparison.Ordinal));
    }

    [Fact]
    public void UploadSessionLockCleanup_RunsOutsideAcquireHotPath()
    {
        IReadOnlyList<string> cleanupCallers = RuntimeMetadataInspection.FindMethodsCallingMember(
            typeof(FileService),
            static member => member.DeclaringType == typeof(FileService) && member.Name == "CleanupStaleSessionLocks");
        Assert.Contains(cleanupCallers, static caller => caller.Contains("<CleanupExpiredSessionsAsync>", StringComparison.Ordinal));
        Assert.DoesNotContain(cleanupCallers, static caller => caller.Contains("<AcquireSessionLockAsync>", StringComparison.Ordinal));

        IReadOnlyList<string> acquireTelemetryCallers = RuntimeMetadataInspection.FindMethodsCallingMember(
            typeof(FileService),
            static member => member.DeclaringType == typeof(FsusObservability)
                && member.Name == nameof(FsusObservability.RecordUploadSessionLockAcquire));
        Assert.Contains(acquireTelemetryCallers, static caller => caller.Contains("<AcquireSessionLockAsync>", StringComparison.Ordinal));
        IReadOnlyList<string> cleanupTelemetryCallers = RuntimeMetadataInspection.FindMethodsCallingMember(
            typeof(FileService),
            static member => member.DeclaringType == typeof(FsusObservability)
                && member.Name == nameof(FsusObservability.RecordUploadSessionLockCleanup));
        Assert.Contains(cleanupTelemetryCallers, static caller => caller.Contains("<CleanupExpiredSessionsAsync>", StringComparison.Ordinal));
    }

    [Fact]
    public async Task UploadSessionExpirationIndex_IsCreatedAndRemovedWithSession()
    {
        ResetSessionLocks();
        string root = CreateTempDirectory();
        try
        {
            var svc = CreateService(root);

            Result<UploadInitDto> init = await svc.InitUploadSessionAsync(new UploadInitRequestDto
            {
                FileName = "sample.png",
                MimeType = "image/png",
                TargetFormat = "png",
                TotalBytes = 8,
                ChunkSize = 8
            });

            Assert.True(init.IsSuccess, init.Error.Message);
            string uploadId = init.Value!.UploadId;
            Assert.Single(GetExpirationIndexFiles(root, uploadId));
            string ownerPath = Path.Combine(GetSessionPath(root, uploadId), "expiration.bucket");
            Assert.True(File.Exists(ownerPath));
            string ownerBucket = (await File.ReadAllTextAsync(ownerPath)).Trim();
            Assert.Matches("^[0-9]{10}$", ownerBucket);
            Assert.True(File.Exists(Path.Combine(
                CreateStoragePaths(root).UploadSessionRoot,
                "expires",
                ownerBucket,
                uploadId)));

            Result<bool> abort = await svc.AbortUploadAsync(uploadId);

            Assert.True(abort.IsSuccess, abort.Error.Message);
            Assert.Empty(GetExpirationIndexFiles(root, uploadId));
            Assert.False(Directory.Exists(GetSessionPath(root, uploadId)));
        }
        finally
        {
            ResetSessionLocks();
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task DeleteOwnedExpirationIndex_IsExactO1WithoutBucketScan()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        ResetSessionLocks();
        string root = CreateTempDirectory();
        string expirationRoot = Path.Combine(CreateStoragePaths(root).UploadSessionRoot, "expires");
        UnixFileMode? originalMode = null;
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
            Assert.True(init.IsSuccess, init.Error.Message);
            string uploadId = init.Value!.UploadId;
            string ownerPath = Path.Combine(GetSessionPath(root, uploadId), "expiration.bucket");
            string ownerBucket = (await File.ReadAllTextAsync(ownerPath)).Trim();

            // Decoy index entries in other buckets must not be required for exact delete.
            string decoyBucket = Path.Combine(expirationRoot, "2099010100");
            Directory.CreateDirectory(decoyBucket);
            File.WriteAllBytes(Path.Combine(decoyBucket, uploadId), []);

            originalMode = File.GetUnixFileMode(expirationRoot);
            File.SetUnixFileMode(
                expirationRoot,
                UnixFileMode.UserExecute | UnixFileMode.GroupExecute | UnixFileMode.OtherExecute);
            Assert.Throws<UnauthorizedAccessException>(() => Directory.GetDirectories(expirationRoot));

            Result<bool> abort = await service.AbortUploadAsync(uploadId);
            Assert.True(abort.IsSuccess, abort.Error.Message);

            File.SetUnixFileMode(expirationRoot, originalMode.Value);
            originalMode = null;
            Assert.False(File.Exists(Path.Combine(expirationRoot, ownerBucket, uploadId)));
            Assert.True(File.Exists(Path.Combine(decoyBucket, uploadId)));
        }
        finally
        {
            if (originalMode.HasValue && Directory.Exists(expirationRoot))
            {
                File.SetUnixFileMode(expirationRoot, originalMode.Value);
            }

            ResetSessionLocks();
            Directory.Delete(root, recursive: true);
        }
    }

    [Theory]
    [InlineData("complete")]
    [InlineData("abort")]
    [InlineData("expired-status")]
    [InlineData("expired-part-map")]
    [InlineData("expired-part")]
    [InlineData("expired-token")]
    public async Task UploadRequestPaths_DoNotEnumerateExpirationIndexRoot(string operation)
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        ResetSessionLocks();
        string root = CreateTempDirectory();
        string expirationRoot = Path.Combine(CreateStoragePaths(root).UploadSessionRoot, "expires");
        UnixFileMode? originalMode = null;
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
            Assert.True(init.IsSuccess, init.Error.Message);

            string uploadId = init.Value!.UploadId;
            bool expiresSession = operation.StartsWith("expired-", StringComparison.Ordinal);
            if (operation == "complete")
            {
                Result<UploadPartAckDto> upload = await service.UploadPartAsync(
                    uploadId,
                    0,
                    0,
                    CreateFormFile(payload, "chunk"),
                    sha256);
                Assert.True(upload.IsSuccess, upload.Error.Message);
            }
            else if (expiresSession)
            {
                UploadSessionRecord expired = (await ReadManifestAsync(root, uploadId)) with
                {
                    ExpiresAt = DateTime.UtcNow.AddMinutes(-5)
                };
                await WriteManifestAsync(GetManifestPath(root, uploadId), expired);
            }

            originalMode = File.GetUnixFileMode(expirationRoot);
            File.SetUnixFileMode(
                expirationRoot,
                UnixFileMode.UserExecute | UnixFileMode.GroupExecute | UnixFileMode.OtherExecute);
            Assert.Throws<UnauthorizedAccessException>(() => Directory.GetDirectories(expirationRoot));

            bool expectedOutcome = operation switch
            {
                "complete" => (await service.CompleteUploadAsync(uploadId, sha256)).IsSuccess,
                "abort" => (await service.AbortUploadAsync(uploadId)).IsSuccess,
                "expired-status" => !(await service.GetUploadStatusAsync(uploadId)).IsSuccess,
                "expired-part-map" => !(await service.GetUploadPartMapAsync(uploadId)).IsSuccess,
                "expired-part" => !(await service.UploadPartAsync(
                    uploadId,
                    0,
                    0,
                    CreateFormFile(payload, "chunk"),
                    sha256)).IsSuccess,
                "expired-token" => !(await service.GetUploadStatusAsync(uploadId)).IsSuccess,
                _ => throw new ArgumentOutOfRangeException(nameof(operation), operation, null)
            };

            Assert.True(expectedOutcome);
            File.SetUnixFileMode(expirationRoot, originalMode.Value);
            originalMode = null;
            if (operation == "complete")
            {
                UploadSessionRecord completed = await ReadManifestAsync(root, uploadId);
                var owner = new UploadSessionAccess(uploadId, 1, init.Value.UploadToken);
                Result<UploadCompleteDto> retry = await service.CompleteUploadAsync(owner, sha256);
                Result<UploadCompleteDto> wrongOwner = await service.CompleteUploadAsync(
                    owner with
                    {
                        OwnerAdminPrincipalId = 2
                    }, sha256);
                Result<UploadCompleteDto> wrongToken = await service.CompleteUploadAsync(
                    owner with
                    {
                        UploadToken = "wrong-token"
                    }, sha256);

                Assert.Equal("completed", completed.Status);
                Assert.Equal(1, completed.OwnerAdminPrincipalId);
                Assert.Equal(SHA256.HashSizeInBytes, completed.UploadTokenSha256.Length);
                Assert.True(retry.IsSuccess);
                Assert.Equal(ErrorCode.NotFound, wrongOwner.Error.Code);
                Assert.Equal(ErrorCode.NotFound, wrongToken.Error.Code);
                Assert.True(Directory.Exists(GetSessionPath(root, uploadId)));
                Assert.Single(GetExpirationIndexFiles(root, uploadId));
            }
            else
            {
                Assert.False(Directory.Exists(GetSessionPath(root, uploadId)));
                Assert.Empty(GetExpirationIndexFiles(root, uploadId));
            }
        }
        finally
        {
            if (originalMode.HasValue && Directory.Exists(expirationRoot))
            {
                File.SetUnixFileMode(expirationRoot, originalMode.Value);
            }

            ResetSessionLocks();
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task CleanupExpiredSessionsAsync_RemovesExpiredSessionFromBucketIndex()
    {
        ResetSessionLocks();
        string root = CreateTempDirectory();
        try
        {
            var svc = CreateService(root);
            Result<UploadInitDto> expiredInit = await svc.InitUploadSessionAsync(new UploadInitRequestDto
            {
                FileName = "expired.png",
                MimeType = "image/png",
                TargetFormat = "png",
                TotalBytes = 8,
                ChunkSize = 8
            });
            Result<UploadInitDto> freshInit = await svc.InitUploadSessionAsync(new UploadInitRequestDto
            {
                FileName = "fresh.png",
                MimeType = "image/png",
                TargetFormat = "png",
                TotalBytes = 8,
                ChunkSize = 8
            });

            Assert.True(expiredInit.IsSuccess, expiredInit.Error.Message);
            Assert.True(freshInit.IsSuccess, freshInit.Error.Message);
            string expiredUploadId = expiredInit.Value!.UploadId;
            UploadSessionRecord expired = (await ReadManifestAsync(root, expiredUploadId)) with
            {
                ExpiresAt = DateTime.UtcNow.AddMinutes(-5)
            };
            await WriteManifestAsync(GetManifestPath(root, expiredUploadId), expired);
            WriteExpirationIndex(root, expiredUploadId, expired.ExpiresAt);

            await svc.CleanupExpiredSessionsAsync(CancellationToken.None);

            Assert.False(Directory.Exists(GetSessionPath(root, expiredUploadId)));
            Assert.True(Directory.Exists(GetSessionPath(root, freshInit.Value!.UploadId)));
            Assert.Empty(GetExpirationIndexFiles(root, expiredUploadId));
        }
        finally
        {
            ResetSessionLocks();
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void UploadSessionRoot_IsPrivateOnUnix()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        string root = CreateTempDirectory();
        try
        {
            _ = CreateService(root);
            UnixFileMode mode = File.GetUnixFileMode(CreateStoragePaths(root).UploadSessionRoot);

            Assert.False(mode.HasFlag(UnixFileMode.GroupRead));
            Assert.False(mode.HasFlag(UnixFileMode.GroupWrite));
            Assert.False(mode.HasFlag(UnixFileMode.GroupExecute));
            Assert.False(mode.HasFlag(UnixFileMode.OtherRead));
            Assert.False(mode.HasFlag(UnixFileMode.OtherWrite));
            Assert.False(mode.HasFlag(UnixFileMode.OtherExecute));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static FormFile CreateFormFile(byte[] payload, string name)
    {
        var stream = new MemoryStream(payload, writable: false);
        return new FormFile(stream, 0, payload.Length, name, $"{name}.bin");
    }

    private static byte[] CreatePngPart(int size, byte fill, bool includeHeader = false)
    {
        byte[] part = new byte[size];
        Array.Fill(part, fill);
        if (includeHeader)
        {
            byte[] pngHeader = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
            pngHeader.CopyTo(part, 0);
        }

        return part;
    }

    private static int GetSessionLockCount()
    {
        FieldInfo field = typeof(FileService).GetField("s_sessionLocks", BindingFlags.Static | BindingFlags.NonPublic)!;
        object dictionary = field.GetValue(null)!;
        return (int)dictionary.GetType().GetProperty("Count")!.GetValue(dictionary)!;
    }

    private static void ResetSessionLocks()
    {
        FieldInfo field = typeof(FileService).GetField("s_sessionLocks", BindingFlags.Static | BindingFlags.NonPublic)!;
        object dictionary = field.GetValue(null)!;
        dictionary.GetType().GetMethod("Clear")!.Invoke(dictionary, null);
    }

    private static void RegisterSessionLock(string uploadId, FileService.SessionLockEntry entry)
    {
        FieldInfo field = typeof(FileService).GetField("s_sessionLocks", BindingFlags.Static | BindingFlags.NonPublic)!;
        object dictionary = field.GetValue(null)!;
        dictionary.GetType().GetMethod("TryAdd")!.Invoke(dictionary, [uploadId, entry]);
    }

    private static void TryDisposeSessionLock(string uploadId, FileService.SessionLockEntry entry)
    {
        MethodInfo method = typeof(FileService).GetMethod("TryDisposeSessionLock", BindingFlags.Static | BindingFlags.NonPublic)!;
        method.Invoke(null, [uploadId, entry]);
    }

    private static async Task AcquireSessionLockForTestsAsync(string uploadId, CancellationToken cancellationToken)
    {
        MethodInfo method = typeof(FileService).GetMethod("AcquireSessionLockAsync", BindingFlags.Static | BindingFlags.NonPublic)!;
        var task = (Task)method.Invoke(null, [uploadId, cancellationToken])!;
        await task;
    }

    private static string GetSessionPath(string root, string uploadId)
        => Path.Combine(CreateStoragePaths(root).UploadSessionRoot, uploadId);

    private static string GetManifestPath(string root, string uploadId)
        => Path.Combine(GetSessionPath(root, uploadId), "manifest.aeds");

    private static string GetPartPath(string root, string uploadId, int partNumber)
        => Path.Combine(GetSessionPath(root, uploadId), "parts", $"{partNumber:D8}.part");

    private static string GetWorkingFilePath(string root, string uploadId)
        => Path.Combine(GetSessionPath(root, uploadId), "upload.tmp");

    private static string[] GetExpirationIndexFiles(string root, string uploadId)
    {
        string indexRoot = Path.Combine(CreateStoragePaths(root).UploadSessionRoot, "expires");
        return Directory.Exists(indexRoot)
            ? Directory.GetFiles(indexRoot, uploadId, SearchOption.AllDirectories)
            : [];
    }

    private static void WriteExpirationIndex(string root, string uploadId, DateTime expiresAtUtc)
    {
        string bucket = expiresAtUtc.ToUniversalTime().ToString("yyyyMMddHH", CultureInfo.InvariantCulture);
        string bucketPath = Path.Combine(CreateStoragePaths(root).UploadSessionRoot, "expires", bucket);
        Directory.CreateDirectory(bucketPath);
        File.WriteAllBytes(Path.Combine(bucketPath, uploadId), []);
    }

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

    private static Task<T> StartTogetherAsync<T>(Barrier barrier, Func<Task<T>> action)
        => Task.Factory.StartNew(
            async () =>
            {
                Assert.True(
                    barrier.SignalAndWait(TimeSpan.FromSeconds(30)),
                    "Timed out waiting for concurrent upload completion requests.");
                return await action();
            },
            CancellationToken.None,
            TaskCreationOptions.LongRunning,
            TaskScheduler.Default).Unwrap();

    private static async Task FlushFileSystemWatcherAsync(FileSystemWatcher watcher, string directory)
    {
        string sentinelName = $"{Guid.NewGuid():N}.sync";
        var observed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        FileSystemEventHandler handler = (_, args) =>
        {
            if (string.Equals(args.Name, sentinelName, StringComparison.Ordinal))
            {
                observed.TrySetResult();
            }
        };
        watcher.Created += handler;
        string sentinelPath = Path.Combine(directory, sentinelName);
        try
        {
            await File.WriteAllBytesAsync(sentinelPath, []);
            await observed.Task.WaitAsync(TimeSpan.FromSeconds(30));
        }
        finally
        {
            watcher.Created -= handler;
            File.Delete(sentinelPath);
        }
    }

    private static string CreateTempDirectory()
    {
        string path = Path.Combine(Path.GetTempPath(), "fsus-file-service-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }

    private static string GetIllustrationFolder(string root)
        => Path.Combine(CreateStoragePaths(root).PublicAssetRoot, "illustration");

    private sealed class CapturingLogger<T> : ILogger<T>
    {
        public List<string> Messages { get; } = [];

        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull
            => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            Messages.Add(formatter(state, exception));
        }
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
    [InlineData(".ico", true)]
    [InlineData(".avif", false)]
    [InlineData(".svg", false)]
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
    [InlineData("image/x-icon", true)]
    [InlineData("image/vnd.microsoft.icon", true)]
    [InlineData("image/avif", false)]
    [InlineData("image/svg+xml", false)]
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
    [InlineData("image/x-icon", "ico", true)]
    [InlineData("image/vnd.microsoft.icon", "ico", true)]
    [InlineData("image/jpeg", "png", false)]
    [InlineData("image/svg+xml", "svg", false)]
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
