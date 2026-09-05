using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Storage;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.PrivateAssets;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;

using SqlSugar;

namespace FsusBlog.Server.Tests;

public sealed class PrivateAssetStoreTests
{
    [Fact]
    public async Task CreateAsync_StreamsToCanonicalPrivateKeyWithRestrictedPermissions()
    {
        using var directory = new TemporaryDirectory();
        byte[] bytes = Encoding.UTF8.GetBytes("private payload");
        AssetRecord record = CreateRecord(bytes);
        var source = new TestRecordSource(record);
        var store = CreateStore(directory.Path, source);

        AssetStorageKey storageKey = await store.CreateAsync(
            WriteRequest(record.Id, bytes));

        Assert.Equal(record.StorageKey, storageKey);
        Assert.Equal(ContentAssetState.Active, source.Current!.State);
        string storedPath = Path.Combine(
            ReleaseStorageTestPaths.Create(directory.Path).PrivateAssetRoot,
            storageKey.Value.Replace('/', Path.DirectorySeparatorChar));
        Assert.Equal(bytes, await File.ReadAllBytesAsync(storedPath));
        await using PrivateAssetReadHandle handle = Assert.IsType<PrivateAssetReadHandle>(
            await store.OpenReadAsync(record.Id));
        Assert.NotNull(handle.Content);
        using var copy = new MemoryStream();
        await handle.Content.CopyToAsync(copy);
        Assert.Equal(bytes, copy.ToArray());
        Assert.Empty(Directory.EnumerateFiles(
            Path.Combine(ReleaseStorageTestPaths.Create(directory.Path).UploadCommitRoot, "private-assets")));

        if (!OperatingSystem.IsWindows())
        {
            Assert.Equal(
                UnixFileMode.UserRead | UnixFileMode.UserWrite,
                File.GetUnixFileMode(storedPath));
            Assert.Equal(
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute,
                File.GetUnixFileMode(Path.GetDirectoryName(storedPath)!));
        }
    }

    [Fact]
    public async Task CreateAsync_IsIdempotentForSameHashAndRejectsExistingDifferentBytes()
    {
        using var directory = new TemporaryDirectory();
        byte[] bytes = Encoding.UTF8.GetBytes("same-length-value");
        AssetRecord record = CreateRecord(bytes);
        var source = new TestRecordSource(record);
        var store = CreateStore(directory.Path, source);

        await store.CreateAsync(WriteRequest(record.Id, bytes));
        await store.CreateAsync(WriteRequest(record.Id, bytes));

        string storedPath = Path.Combine(
            ReleaseStorageTestPaths.Create(directory.Path).PrivateAssetRoot,
            record.StorageKey.Value.Replace('/', Path.DirectorySeparatorChar));
        await File.WriteAllBytesAsync(storedPath, Encoding.UTF8.GetBytes("evil-length-value"));
        InvalidOperationException conflict = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            store.CreateAsync(WriteRequest(record.Id, bytes)));
        Assert.Equal("private_asset_commit_conflict", conflict.Message);
        Assert.Equal(ContentAssetState.PendingDelete, source.Current!.State);
    }

    [Fact]
    public async Task ValidateAndOpenRead_RejectSameLengthTamper()
    {
        using var directory = new TemporaryDirectory();
        byte[] bytes = Encoding.UTF8.GetBytes("original-private");
        AssetRecord record = CreateRecord(bytes);
        var source = new TestRecordSource(record);
        var store = CreateStore(directory.Path, source);
        await store.CreateAsync(WriteRequest(record.Id, bytes));
        string path = Path.Combine(
            ReleaseStorageTestPaths.Create(directory.Path).PrivateAssetRoot,
            record.StorageKey.Value.Replace('/', Path.DirectorySeparatorChar));
        await File.WriteAllBytesAsync(path, Encoding.UTF8.GetBytes("tampered-private"));

        Assert.Null(await store.ValidateAsync(record.Id));
        Assert.Null(await store.OpenReadAsync(record.Id));
    }

    [Fact]
    public void Constructor_RejectsCrossDeviceCommitRoot()
    {
        if (!OperatingSystem.IsLinux() || !Directory.Exists("/dev/shm"))
        {
            return;
        }

        using var directory = new TemporaryDirectory();
        string otherRoot = Path.Combine("/dev/shm", $"fsus-private-cross-device-{Guid.NewGuid():N}");
        Directory.CreateDirectory(otherRoot);
        try
        {
            ReleaseStoragePaths paths = ReleaseStorageTestPaths.Create(directory.Path) with
            {
                PrivateAssetRoot = Path.Combine(otherRoot, "private")
            };
            Directory.CreateDirectory(paths.PrivateAssetRoot);

            InvalidOperationException rejected = Assert.Throws<InvalidOperationException>(() =>
                new LocalPrivateAssetStore(
                    new TestRecordSource(null),
                    new PrivateAssetWritePolicy(),
                    paths));

            Assert.Equal("private_asset_roots_cross_device", rejected.Message);
            Assert.DoesNotContain(directory.Path, rejected.ToString(), StringComparison.Ordinal);
            Assert.DoesNotContain(otherRoot, rejected.ToString(), StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(otherRoot, recursive: true);
        }
    }

    [Fact]
    public async Task AnchoredDelete_RejectsParentReplacementWithoutTouchingOutside()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }

        using var directory = new TemporaryDirectory();
        byte[] bytes = [5, 6, 7];
        AssetRecord record = CreateRecord(bytes);
        var source = new TestRecordSource(record);
        var store = CreateStore(directory.Path, source);
        await store.CreateAsync(WriteRequest(record.Id, bytes));
        ReleaseStoragePaths paths = ReleaseStorageTestPaths.Create(directory.Path);
        string segment = record.StorageKey.Value.Split('/')[0];
        string parent = Path.Combine(paths.PrivateAssetRoot, segment);
        string detached = parent + "-detached";
        string outside = Path.Combine(directory.Path, "outside-race");
        Directory.CreateDirectory(outside);
        string outsideFile = Path.Combine(outside, Path.GetFileName(record.StorageKey.Value));
        await File.WriteAllBytesAsync(outsideFile, bytes);
        Directory.Move(parent, detached);
        Directory.CreateSymbolicLink(parent, outside);

        await Assert.ThrowsAsync<InvalidOperationException>(() => store.DeleteAsync(record.Id));

        Assert.Equal(bytes, await File.ReadAllBytesAsync(outsideFile));
        Assert.True(File.Exists(Path.Combine(detached, Path.GetFileName(record.StorageKey.Value))));
    }

    [Fact]
    public async Task AnchoredDelete_ParentSwapRaceNeverDeletesOutsideRoot()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }

        using var directory = new TemporaryDirectory();
        byte[] bytes = [5, 6, 7];
        AssetRecord record = CreateRecord(bytes) with
        {
            State = ContentAssetState.Active
        };
        ReleaseStoragePaths paths = ReleaseStorageTestPaths.Create(directory.Path);
        var store = CreateStore(directory.Path, new TestRecordSource(record));
        string segment = record.StorageKey.Value.Split('/')[0];
        string parent = Path.Combine(paths.PrivateAssetRoot, segment);
        string detached = parent + "-detached";
        string outside = Path.Combine(directory.Path, "outside-race-loop");
        Directory.CreateDirectory(parent);
        Directory.CreateDirectory(outside);
        string outsideFile = Path.Combine(outside, Path.GetFileName(record.StorageKey.Value));
        await File.WriteAllBytesAsync(outsideFile, bytes);

        using var stop = new CancellationTokenSource();
        Task mutator = Task.Run(() =>
        {
            while (!stop.IsCancellationRequested)
            {
                try
                {
                    Directory.Move(parent, detached);
                    Directory.CreateSymbolicLink(parent, outside);
                    Directory.Delete(parent);
                    Directory.Move(detached, parent);
                }
                catch (IOException)
                {
                }
            }
        });

        for (int index = 0; index < 250; index++)
        {
            try
            {
                await store.DeleteAsync(record.Id);
            }
            catch (InvalidOperationException exception)
            {
                Assert.Equal("private_asset_symlink_rejected", exception.Message);
            }
            catch (IOException exception)
            {
                Assert.Equal("private_asset_delete_failed", exception.Message);
            }
        }

        stop.Cancel();
        await mutator.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(bytes, await File.ReadAllBytesAsync(outsideFile));
    }

    [Fact]
    public async Task AnchoredDelete_PermissionFailureDoesNotDiscloseRootOrStorageKey()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        using var directory = new TemporaryDirectory();
        byte[] bytes = [8, 9, 10];
        AssetRecord record = CreateRecord(bytes);
        var source = new TestRecordSource(record);
        var store = CreateStore(directory.Path, source);
        await store.CreateAsync(WriteRequest(record.Id, bytes));
        ReleaseStoragePaths paths = ReleaseStorageTestPaths.Create(directory.Path);
        string parent = Path.Combine(paths.PrivateAssetRoot, record.StorageKey.Value.Split('/')[0]);
        File.SetUnixFileMode(parent, UnixFileMode.UserRead | UnixFileMode.UserExecute);
        try
        {
            IOException failure = await Assert.ThrowsAsync<IOException>(() => store.DeleteAsync(record.Id));
            Assert.Equal("private_asset_delete_failed", failure.Message);
            Assert.DoesNotContain(paths.PrivateAssetRoot, failure.ToString(), StringComparison.Ordinal);
            Assert.DoesNotContain(record.StorageKey.Value, failure.ToString(), StringComparison.Ordinal);
        }
        finally
        {
            File.SetUnixFileMode(
                parent,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
    }

    [Fact]
    public async Task LinuxTemporaryFile_IsUnnamedAndLeavesNoCrashResidualEntry()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }

        using var directory = new TemporaryDirectory();
        ReleaseStoragePaths paths = ReleaseStorageTestPaths.Create(directory.Path);
        Directory.CreateDirectory(paths.PrivateAssetRoot);
        Directory.CreateDirectory(paths.UploadCommitRoot);
        var fileSystem = new PrivateAssetAnchoredFileSystem(paths.PrivateAssetRoot, paths.UploadCommitRoot);

        await using (AnchoredTemporaryFile temporary = fileSystem.CreateTemporary())
        {
            await temporary.Stream.WriteAsync(new byte[] { 1, 2, 3 });
            Assert.Empty(Directory.EnumerateFileSystemEntries(
                Path.Combine(paths.UploadCommitRoot, "private-assets")));
        }

        Assert.Empty(Directory.EnumerateFileSystemEntries(
            Path.Combine(paths.UploadCommitRoot, "private-assets")));
    }

    [Fact]
    public async Task Validate_RejectsUnreadableFinalFileWithoutDisclosingPath()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        using var directory = new TemporaryDirectory();
        byte[] bytes = [8, 9, 10];
        AssetRecord record = CreateRecord(bytes);
        var source = new TestRecordSource(record);
        var store = CreateStore(directory.Path, source);
        await store.CreateAsync(WriteRequest(record.Id, bytes));
        string path = Path.Combine(
            ReleaseStorageTestPaths.Create(directory.Path).PrivateAssetRoot,
            record.StorageKey.Value.Replace('/', Path.DirectorySeparatorChar));
        File.SetUnixFileMode(path, UnixFileMode.None);
        try
        {
            Assert.Null(await store.ValidateAsync(record.Id));
        }
        finally
        {
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
    }

    [Fact]
    public async Task CreateAsync_RejectsNonPrivateInactiveAndNonCanonicalRecordsWithoutWriting()
    {
        using var directory = new TemporaryDirectory();
        byte[] bytes = [1, 2, 3];
        AssetRecord valid = CreateRecord(bytes);
        AssetRecord[] invalid =
        [
            valid with { StorageClass = "public" },
            valid with { Sha256 = null },
            valid with { StorageKey = AssetStorageKey.Parse("other/file.bin") }
        ];

        foreach (AssetRecord record in invalid)
        {
            var store = CreateStore(directory.Path, new TestRecordSource(record));
            await Assert.ThrowsAsync<InvalidOperationException>(() => store.CreateAsync(
                WriteRequest(record.Id, bytes)));
        }

        Assert.Empty(Directory.EnumerateFiles(
            ReleaseStorageTestPaths.Create(directory.Path).PrivateAssetRoot,
            "*",
            SearchOption.AllDirectories));
    }

    [Fact]
    public async Task CreateAsync_RejectsCanonicalKeyWhenParentIsSymlink()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        using var directory = new TemporaryDirectory();
        byte[] bytes = [4, 5, 6];
        AssetRecord record = CreateRecord(bytes);
        ReleaseStoragePaths paths = ReleaseStorageTestPaths.Create(directory.Path);
        Directory.CreateDirectory(paths.PrivateAssetRoot);
        string outside = Path.Combine(directory.Path, "outside");
        Directory.CreateDirectory(outside);
        string firstSegment = record.StorageKey.Value.Split('/')[0];
        Directory.CreateSymbolicLink(Path.Combine(paths.PrivateAssetRoot, firstSegment), outside);
        var store = new LocalPrivateAssetStore(
            new TestRecordSource(record),
            new PrivateAssetWritePolicy(),
            paths);

        await Assert.ThrowsAsync<InvalidOperationException>(() => store.CreateAsync(
            WriteRequest(record.Id, bytes)));
        Assert.Empty(Directory.EnumerateFiles(outside));
    }

    [Fact]
    public async Task DeleteAsync_RejectsSymlinkedParentWithoutDeletingOutsideFile()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        using var directory = new TemporaryDirectory();
        byte[] bytes = [4, 5, 6];
        AssetRecord record = CreateRecord(bytes) with
        {
            State = ContentAssetState.Active
        };
        ReleaseStoragePaths paths = ReleaseStorageTestPaths.Create(directory.Path);
        Directory.CreateDirectory(paths.PrivateAssetRoot);
        string outside = Path.Combine(directory.Path, "outside");
        Directory.CreateDirectory(outside);
        string firstSegment = record.StorageKey.Value.Split('/')[0];
        Directory.CreateSymbolicLink(Path.Combine(paths.PrivateAssetRoot, firstSegment), outside);
        string outsideFile = Path.Combine(outside, Path.GetFileName(record.StorageKey.Value));
        await File.WriteAllBytesAsync(outsideFile, bytes);
        var store = new LocalPrivateAssetStore(
            new TestRecordSource(record),
            new PrivateAssetWritePolicy(),
            paths);

        InvalidOperationException rejected = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            store.DeleteAsync(record.Id));

        Assert.Equal("private_asset_symlink_rejected", rejected.Message);
        Assert.True(File.Exists(outsideFile));
    }

    [Fact]
    public async Task CreateAsync_HashFailureLeavesRecordPendingAndNoFinalFile()
    {
        using var directory = new TemporaryDirectory();
        byte[] expected = [1, 2, 3];
        AssetRecord record = CreateRecord(expected) with
        {
            State = ContentAssetState.Active
        };
        var source = new TestRecordSource(record);
        var store = CreateStore(directory.Path, source);

        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            store.CreateAsync(WriteRequest(record.Id, [9, 8, 7])));

        Assert.Equal("private_asset_content_metadata_mismatch", failure.Message);
        Assert.Equal(ContentAssetState.PendingDelete, source.Current!.State);
        Assert.Null(await store.ValidateAsync(record.Id));
    }

    [Fact]
    public async Task CreateAsync_RejectsPurposeThatDoesNotMatchDurableMediaMetadata()
    {
        using var directory = new TemporaryDirectory();
        byte[] bytes = [1, 2, 3];
        AssetRecord record = CreateRecord(bytes);
        var source = new TestRecordSource(record);
        var store = CreateStore(directory.Path, source);

        await Assert.ThrowsAsync<ArgumentException>(() => store.CreateAsync(
            new PrivateAssetWriteRequest(
                record.Id,
                new MemoryStream(bytes),
                PrivateAssetWritePurpose.PortableDocument)));

        Assert.Equal(ContentAssetState.PendingDelete, source.Current!.State);
    }

    [Fact]
    public void WritePolicy_AppliesExplicitSizeBoundToEveryClosedPurpose()
    {
        AssetRecord atLimit = CreateRecord([1]) with
        {
            SizeBytes = PrivateAssetWritePolicy.MaximumBytesPerPurpose
        };
        AssetRecord overLimit = atLimit with
        {
            SizeBytes = PrivateAssetWritePolicy.MaximumBytesPerPurpose + 1
        };
        var policy = new PrivateAssetWritePolicy();

        Assert.True(policy.Allows(PrivateAssetWritePurpose.BinaryAttachment, atLimit));
        Assert.False(policy.Allows(PrivateAssetWritePurpose.BinaryAttachment, overLimit));
        Assert.False(policy.Allows(PrivateAssetWritePurpose.PortableDocument, atLimit));
    }

    [Fact]
    public async Task CreateAsync_CompletionFailureKeepsOwnedFileInExplicitRepairState()
    {
        using var directory = new TemporaryDirectory();
        byte[] bytes = [4, 5, 6];
        AssetRecord record = CreateRecord(bytes);
        var source = new TestRecordSource(record) { FailCompletion = true };
        var store = CreateStore(directory.Path, source);

        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            store.CreateAsync(WriteRequest(record.Id, bytes)));

        Assert.Equal("private_asset_commit_repair_required", failure.Message);
        Assert.Equal(ContentAssetState.PendingDelete, source.Current!.State);
        string finalPath = Path.Combine(
            ReleaseStorageTestPaths.Create(directory.Path).PrivateAssetRoot,
            record.StorageKey.Value.Replace('/', Path.DirectorySeparatorChar));
        Assert.True(File.Exists(finalPath));
        Assert.Null(await store.ValidateAsync(record.Id));
    }

    [Fact]
    public async Task CreateAsync_RecordDisappearsAfterRenameMovesBytesToExistingTempCleanupBoundary()
    {
        using var directory = new TemporaryDirectory();
        byte[] bytes = [7, 8, 9];
        AssetRecord record = CreateRecord(bytes);
        var source = new TestRecordSource(record) { DeleteOnCompletion = true };
        var store = CreateStore(directory.Path, source);

        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            store.CreateAsync(WriteRequest(record.Id, bytes)));

        Assert.Equal("private_asset_commit_cleanup_required", failure.Message);
        string finalPath = Path.Combine(
            ReleaseStorageTestPaths.Create(directory.Path).PrivateAssetRoot,
            record.StorageKey.Value.Replace('/', Path.DirectorySeparatorChar));
        Assert.False(File.Exists(finalPath));
        Assert.Single(Directory.EnumerateFiles(
            Path.Combine(ReleaseStorageTestPaths.Create(directory.Path).UploadCommitRoot, "private-assets"),
            "orphan-*.tmp"));
    }

    [Fact]
    public void PublicUrlCodec_RejectsPrivateRecord()
    {
        AssetRecord record = CreateRecord([1]);
        var codec = new PublicAssetUrlCodec();

        Assert.Throws<InvalidOperationException>(() =>
            codec.ToPublicUrl(record, new Uri("https://fsus.blog")));
    }

    [Theory]
    [InlineData("/absolute/file.bin")]
    [InlineData("../escape.bin")]
    [InlineData("%2e%2e/escape.bin")]
    [InlineData("folder\\escape.bin")]
    [InlineData("folder/escape\0.bin")]
    public void StorageKey_RejectsTraversalAndAmbiguousSeparators(string value)
        => Assert.False(AssetStorageKey.TryParse(value, out _));

    [Fact]
    public void Interface_DoesNotAcceptOrReturnStringPaths()
    {
        MethodInfo[] methods = typeof(IPrivateAssetStore).GetMethods();

        Assert.DoesNotContain(methods, method => method.ReturnType == typeof(string));
        Assert.DoesNotContain(methods.SelectMany(method => method.GetParameters()), parameter =>
            parameter.ParameterType == typeof(string));
        Assert.DoesNotContain(typeof(PrivateAssetReadHandle).GetProperties(), property =>
            property.Name.Contains("Path", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void ProductionGateway_DoesNotMountPrivateStorageAsPublicStaticContent()
    {
        string repositoryRoot = RepositoryRoot();
        string compose = File.ReadAllText(Path.Combine(repositoryRoot, "ops/docker/docker-compose.production.yml"));
        string gateway = File.ReadAllText(Path.Combine(repositoryRoot, "ops/gateway/production-openresty.conf"));

        Assert.DoesNotContain("assets/private", gateway, StringComparison.Ordinal);
        Assert.DoesNotContain("PrivateAssetRoot", gateway, StringComparison.Ordinal);
        Assert.DoesNotContain("/app/storage/shared/assets/private", compose, StringComparison.Ordinal);
        Assert.Contains("FSUSBLOG_SHARED_STORAGE_ROOT=/app/storage/shared", compose, StringComparison.Ordinal);
        Assert.Contains("FSUSBLOG_INSTANCE_STORAGE_ROOT=/app/storage/instances", compose, StringComparison.Ordinal);
        Assert.Contains("fsus-storage:/app/storage", compose, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ProductionStaticProviders_AllReturnTrue404ForPrivateOnlyBytes()
    {
        using var directory = new TemporaryDirectory();
        ReleaseStoragePaths paths = ReleaseStorageTestPaths.Create(directory.Path);
        string webRoot = Path.Combine(directory.Path, "wwwroot");
        string releaseAssets = Path.Combine(directory.Path, "release-assets");
        string releaseDerived = Path.Combine(directory.Path, "release-derived");
        Directory.CreateDirectory(paths.PublicAssetRoot);
        Directory.CreateDirectory(paths.PrivateAssetRoot);
        Directory.CreateDirectory(webRoot);
        Directory.CreateDirectory(releaseAssets);
        Directory.CreateDirectory(releaseDerived);
        AssetRecord record = CreateRecord([3, 1, 4]);
        string privateFile = Path.Combine(
            paths.PrivateAssetRoot,
            record.StorageKey.Value.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(privateFile)!);
        await File.WriteAllBytesAsync(privateFile, [3, 1, 4]);

        var builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            EnvironmentName = Environments.Production,
            ContentRootPath = directory.Path,
            WebRootPath = webRoot
        });
        builder.WebHost.UseTestServer();
        builder.Configuration["FSUSBLOG_RELEASE_ASSET_ROOT"] = releaseAssets;
        builder.Configuration["FSUSBLOG_RELEASE_DERIVED_ROOT"] = releaseDerived;
        builder.Services.AddSingleton(paths);
        await using WebApplication app = builder.Build();
        app.UseFsusStaticAssets();
        app.Run(context =>
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            return Task.CompletedTask;
        });
        await app.StartAsync();
        using HttpClient client = app.GetTestClient();
        string key = record.StorageKey.Value;
        string[] registeredAndGuessedPaths =
        [
            $"/uploads/{key}",
            $"/{key}",
            $"/release-assets/{key}",
            $"/release-derived/{key}",
            $"/src/assets/{key}",
            $"/assets/private/{key}",
            $"/app/storage/shared/assets/private/{key}"
        ];

        foreach (string requestPath in registeredAndGuessedPaths)
        {
            using HttpResponseMessage response = await client.GetAsync(requestPath);
            Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
            Assert.Empty(await response.Content.ReadAsByteArrayAsync());
        }
    }

    [Fact]
    public void StaticProviderOwners_NeverConsumePrivateAssetRoot()
    {
        string backendRoot = Path.Combine(RepositoryRoot(), "src/backend");
        string[] providerOwners = [.. Directory.EnumerateFiles(backendRoot, "*.cs", SearchOption.AllDirectories)
            .Where(path => File.ReadAllText(path).Contains("UseStaticFiles", StringComparison.Ordinal))];

        Assert.NotEmpty(providerOwners);
        Assert.All(providerOwners, path =>
        {
            string source = File.ReadAllText(path);
            Assert.DoesNotContain("PrivateAssetRoot", source, StringComparison.Ordinal);
            Assert.DoesNotContain("IPrivateAssetStore", source, StringComparison.Ordinal);
        });
    }

    private static LocalPrivateAssetStore CreateStore(string root, TestRecordSource source)
        => new(source, new PrivateAssetWritePolicy(), ReleaseStorageTestPaths.Create(root));

    private static PrivateAssetWriteRequest WriteRequest(AssetId assetId, byte[] content)
        => new(assetId, new MemoryStream(content), PrivateAssetWritePurpose.BinaryAttachment);

    private static AssetRecord CreateRecord(byte[] bytes)
    {
        AssetId id = AssetId.New();
        string hash = Convert.ToHexStringLower(SHA256.HashData(bytes));
        DateTimeOffset now = DateTimeOffset.UtcNow;
        return new AssetRecord(
            id,
            "private",
            LocalPrivateAssetStore.CreateStorageKey(id, ".bin"),
            "application/octet-stream",
            ".bin",
            bytes.LongLength,
            hash,
            null,
            null,
            1,
            ContentAssetState.PendingDelete,
            now,
            now);
    }

    private static string RepositoryRoot([System.Runtime.CompilerServices.CallerFilePath] string sourcePath = "")
        => Path.GetFullPath(Path.Combine(Path.GetDirectoryName(sourcePath)!, "../../.."));

    private sealed class TestRecordSource(AssetRecord? record) : IPrivateAssetRecordSource
    {
        public AssetRecord? Current { get; private set; } = record;

        public bool DeleteOnCompletion
        {
            get; init;
        }

        public bool FailCompletion
        {
            get; init;
        }

        public Task<AssetRecord?> FindAsync(AssetId assetId, CancellationToken cancellationToken)
            => Task.FromResult(Current?.Id == assetId ? Current : null);

        public Task<AssetRecord?> PrepareCommitAsync(
            AssetRecord expected,
            CancellationToken cancellationToken)
        {
            if (Current is null || Current.Id != expected.Id)
            {
                return Task.FromResult<AssetRecord?>(null);
            }

            Current = Current with
            {
                State = ContentAssetState.PendingDelete
            };
            return Task.FromResult<AssetRecord?>(Current);
        }

        public Task<bool> PublishAndCompleteCommitAsync(
            AssetRecord expected,
            Action publish,
            CancellationToken cancellationToken)
        {
            publish();
            if (DeleteOnCompletion)
            {
                Current = null;
                return Task.FromResult(false);
            }

            if (FailCompletion)
            {
                return Task.FromResult(false);
            }

            if (Current is null
                || Current.Id != expected.Id
                || Current.State != ContentAssetState.PendingDelete)
            {
                return Task.FromResult(false);
            }

            Current = Current with
            {
                State = ContentAssetState.Active
            };
            return Task.FromResult(true);
        }
    }

    private sealed class TemporaryDirectory : IDisposable
    {
        public TemporaryDirectory()
        {
            Path = System.IO.Path.Combine(
                System.IO.Path.GetTempPath(),
                $"fsus-private-assets-{Guid.NewGuid():N}");
            Directory.CreateDirectory(Path);
        }

        public string Path
        {
            get;
        }

        public void Dispose()
            => Directory.Delete(Path, recursive: true);
    }
}

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class PrivateAssetStorePostgresIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task DirectorySyncFailure_PreservesRepairFenceUntilDurableRetry()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using var directory = new PrivateAssetIntegrationTemporaryDirectory();
        ReleaseStoragePaths paths = ReleaseStorageTestPaths.Create(directory.Path);
        byte[] bytes = [2, 4, 6, 8];
        (AssetId assetId, AssetStorageKey storageKey) = SeedPrivateAsset(
            db, bytes, ContentAssetStates.PendingDelete);
        Directory.CreateDirectory(paths.PrivateAssetRoot);
        Directory.CreateDirectory(paths.UploadCommitRoot);
        var sync = new PrivateAssetDurabilityTests.FaultingDirectorySync();
        var fileSystem = new PrivateAssetAnchoredFileSystem(
            paths.PrivateAssetRoot, paths.UploadCommitRoot, sync);
        var store = new LocalPrivateAssetStore(
            new SqlPrivateAssetRecordSource(db), new PrivateAssetWritePolicy(), paths, fileSystem);

        foreach (PrivateAssetDirectoryDurabilityPoint point in new[]
        {
            PrivateAssetDirectoryDurabilityPoint.Published,
            PrivateAssetDirectoryDurabilityPoint.ExistingPublication
        })
        {
            sync.FailNext = point;
            InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() =>
                store.CreateAsync(new PrivateAssetWriteRequest(
                    assetId, new MemoryStream(bytes), PrivateAssetWritePurpose.BinaryAttachment)));

            Assert.Equal("private_asset_commit_durability_failed", failure.Message);
            Assert.Equal(ContentAssetStates.PendingDelete,
                db.Queryable<ContentAsset>().InSingle(assetId.Value).State);
            Assert.Equal(ContentAssetCleanupMarkers.PrivateCommitRepair,
                db.Queryable<ContentAssetCleanupQueueItem>().InSingle(assetId.Value).LastError);
            Assert.Equal(bytes, await File.ReadAllBytesAsync(ResolveFinalPath(paths, storageKey)));
        }

        await store.CreateAsync(new PrivateAssetWriteRequest(
            assetId, new MemoryStream(bytes), PrivateAssetWritePurpose.BinaryAttachment));

        Assert.Equal(ContentAssetStates.Active,
            db.Queryable<ContentAsset>().InSingle(assetId.Value).State);
        Assert.Null(db.Queryable<ContentAssetCleanupQueueItem>().InSingle(assetId.Value));
    }

    [Fact]
    public async Task CommitAndUnifiedCleanup_KeepDatabaseAndPrivateFileConsistent()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(ContentAsset),
            typeof(ContentAssetReference),
            typeof(ContentAssetCleanupQueueItem));
        using var directory = new PrivateAssetIntegrationTemporaryDirectory();
        ReleaseStoragePaths paths = ReleaseStorageTestPaths.Create(directory.Path);
        byte[] bytes = [1, 3, 3, 7];
        AssetId assetId = AssetId.New();
        AssetStorageKey storageKey = LocalPrivateAssetStore.CreateStorageKey(assetId, ".bin");
        string hash = Convert.ToHexStringLower(SHA256.HashData(bytes));
        DateTime now = DateTime.UtcNow;
        db.Insertable(new ContentAsset
        {
            AssetId = assetId.Value,
            StorageClass = "private",
            StorageKey = storageKey.Value,
            MimeType = "application/octet-stream",
            Extension = ".bin",
            SizeBytes = bytes.LongLength,
            Sha256 = hash,
            OwnerAdminPrincipalId = 1,
            State = ContentAssetStates.PendingDelete,
            CreatedAtUtc = now,
            UpdatedAtUtc = now
        }).ExecuteCommand();
        var privateStore = new LocalPrivateAssetStore(
            new SqlPrivateAssetRecordSource(db),
            new PrivateAssetWritePolicy(),
            paths);

        await privateStore.CreateAsync(new PrivateAssetWriteRequest(
            assetId,
            new MemoryStream(bytes),
            PrivateAssetWritePurpose.BinaryAttachment));

        ContentAsset committed = db.Queryable<ContentAsset>().InSingle(assetId.Value);
        Assert.Equal(ContentAssetStates.Active, committed.State);
        string finalPath = Path.Combine(
            paths.PrivateAssetRoot,
            storageKey.Value.Replace('/', Path.DirectorySeparatorChar));
        Assert.Equal(bytes, await File.ReadAllBytesAsync(finalPath));

        committed.State = ContentAssetStates.PendingDelete;
        committed.UpdatedAtUtc = DateTime.UtcNow;
        db.Updateable(committed)
            .UpdateColumns(item => new { item.State, item.UpdatedAtUtc })
            .ExecuteCommand();
        db.Insertable(new ContentAssetCleanupQueueItem
        {
            AssetId = assetId.Value,
            NotBeforeUtc = DateTime.UtcNow,
            UpdatedAtUtc = DateTime.UtcNow
        }).ExecuteCommand();
        var cleanupStore = new LocalContentAssetStore(
            db,
            paths,
            privateStore,
            NullLogger<LocalContentAssetStore>.Instance);

        Assert.Equal(AssetDeleteResult.Deleted, await cleanupStore.DeleteAsync(assetId));
        Assert.False(File.Exists(finalPath));
        Assert.Null(db.Queryable<ContentAsset>().InSingle(assetId.Value));
        Assert.Null(db.Queryable<ContentAssetCleanupQueueItem>().InSingle(assetId.Value));
    }

    [Fact]
    public async Task HashFailure_PersistsDiscoverableRepairStateUntilUnifiedCleanup()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using var directory = new PrivateAssetIntegrationTemporaryDirectory();
        ReleaseStoragePaths paths = ReleaseStorageTestPaths.Create(directory.Path);
        byte[] expected = [1, 2, 3];
        (AssetId assetId, _) = SeedPrivateAsset(db, expected, ContentAssetStates.Active);
        var privateStore = CreatePrivateStore(db, paths);

        InvalidOperationException rejected = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            privateStore.CreateAsync(new PrivateAssetWriteRequest(
                assetId,
                new MemoryStream([9, 8, 7]),
                PrivateAssetWritePurpose.BinaryAttachment)));

        Assert.Equal("private_asset_content_metadata_mismatch", rejected.Message);
        ContentAsset repair = db.Queryable<ContentAsset>().InSingle(assetId.Value);
        Assert.Equal(ContentAssetStates.PendingDelete, repair.State);
        ContentAssetCleanupQueueItem queued = db.Queryable<ContentAssetCleanupQueueItem>().InSingle(assetId.Value);
        Assert.Equal(ContentAssetCleanupMarkers.PrivateCommitRepair, queued.LastError);

        var referenceStore = new ArticleAssetReferenceStore(db);
        var referenceAttempt = await db.Ado.UseTranAsync(() => referenceStore.ReplaceDraftAsync(
            7,
            "commit-repair",
            null,
            [new ArticleAssetReferenceWrite(assetId, 1, null)]));
        Assert.False(referenceAttempt.IsSuccess);
        Assert.Contains(
            "content_asset_reference_repair_in_progress",
            referenceAttempt.ErrorException?.ToString(),
            StringComparison.Ordinal);

        MakeCleanupDue(db, assetId);
        Assert.Equal(1, await CreateCleanupService(db, paths, privateStore).ProcessDueAsync());
        Assert.Null(db.Queryable<ContentAsset>().InSingle(assetId.Value));
        Assert.Null(db.Queryable<ContentAssetCleanupQueueItem>().InSingle(assetId.Value));
    }

    [Fact]
    public async Task ByteDeleteFailure_LeavesDurableFenceAndRetryCompletes()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using var directory = new PrivateAssetIntegrationTemporaryDirectory();
        ReleaseStoragePaths paths = ReleaseStorageTestPaths.Create(directory.Path);
        byte[] bytes = [4, 5, 6];
        (AssetId assetId, AssetStorageKey storageKey) = SeedPrivateAsset(
            db,
            bytes,
            ContentAssetStates.PendingDelete);
        LocalPrivateAssetStore privateStore = CreatePrivateStore(db, paths);
        await privateStore.CreateAsync(new PrivateAssetWriteRequest(
            assetId,
            new MemoryStream(bytes),
            PrivateAssetWritePurpose.BinaryAttachment));
        string finalPath = ResolveFinalPath(paths, storageKey);
        var failingBytes = new DeleteOnlyPrivateAssetStore((_, _) =>
            throw new IOException("injected_byte_delete_failure"));
        var deleteStore = CreateContentStore(db, paths, failingBytes);

        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            deleteStore.DeleteAsync(assetId));

        Assert.Equal("content_asset_byte_delete_failed", failure.Message);
        Assert.DoesNotContain("injected_byte_delete_failure", failure.ToString(), StringComparison.Ordinal);
        Assert.True(File.Exists(finalPath));
        AssertDeleteFence(db, assetId);

        MakeCleanupDue(db, assetId);
        Assert.Equal(1, await CreateCleanupService(db, paths, privateStore).ProcessDueAsync());
        Assert.False(File.Exists(finalPath));
        Assert.Null(db.Queryable<ContentAsset>().InSingle(assetId.Value));
    }

    [Fact]
    public async Task FinalizeRowMismatch_RollsBackQueueDeleteAndRemainsRepairable()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using var directory = new PrivateAssetIntegrationTemporaryDirectory();
        ReleaseStoragePaths paths = ReleaseStorageTestPaths.Create(directory.Path);
        byte[] bytes = [7, 8, 9];
        (AssetId assetId, AssetStorageKey storageKey) = SeedPrivateAsset(
            db,
            bytes,
            ContentAssetStates.PendingDelete);
        LocalPrivateAssetStore privateStore = CreatePrivateStore(db, paths);
        await privateStore.CreateAsync(new PrivateAssetWriteRequest(
            assetId,
            new MemoryStream(bytes),
            PrivateAssetWritePurpose.BinaryAttachment));
        var driftingBytes = new DeleteOnlyPrivateAssetStore(async (id, cancellationToken) =>
        {
            await privateStore.DeleteAsync(id, cancellationToken);
            await db.Updateable<ContentAsset>()
                .SetColumns(item => new ContentAsset
                {
                    State = ContentAssetStates.Active,
                    UpdatedAtUtc = DateTime.UtcNow
                })
                .Where(item => item.AssetId == id.Value)
                .ExecuteCommandAsync(cancellationToken);
        });

        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            CreateContentStore(db, paths, driftingBytes).DeleteAsync(assetId));

        Assert.Equal("content_asset_delete_finalize_failed", failure.Message);
        Assert.False(File.Exists(ResolveFinalPath(paths, storageKey)));
        AssertDeleteFence(db, assetId, ContentAssetStates.Active);

        MakeCleanupDue(db, assetId);
        Assert.Equal(1, await CreateCleanupService(db, paths, privateStore).ProcessDueAsync());
        Assert.Null(db.Queryable<ContentAsset>().InSingle(assetId.Value));
        Assert.Null(db.Queryable<ContentAssetCleanupQueueItem>().InSingle(assetId.Value));
    }

    [Fact]
    public async Task DeleteFence_RejectsConcurrentReferenceResurrectionBeforeByteDelete()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        AssetId assetId;
        ReleaseStoragePaths paths;
        using var directory = new PrivateAssetIntegrationTemporaryDirectory();
        paths = ReleaseStorageTestPaths.Create(directory.Path);
        using (SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString))
        {
            CreateTables(setupDb);
            (assetId, _) = SeedPrivateAsset(setupDb, [1, 3, 5], ContentAssetStates.Active);
        }

        var enteredDelete = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseDelete = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var blockingBytes = new DeleteOnlyPrivateAssetStore(async (_, cancellationToken) =>
        {
            enteredDelete.SetResult();
            await releaseDelete.Task.WaitAsync(cancellationToken);
        });

        using SqlSugarClient deleteDb = PostgresSqlSugarTestClient.Create(connectionString);
        Task<AssetDeleteResult> deleteTask = CreateContentStore(deleteDb, paths, blockingBytes)
            .DeleteAsync(assetId);
        await enteredDelete.Task.WaitAsync(TimeSpan.FromSeconds(10));

        using SqlSugarClient referenceDb = PostgresSqlSugarTestClient.Create(connectionString);
        var referenceStore = new ArticleAssetReferenceStore(referenceDb);
        var referenceAttempt = await referenceDb.Ado.UseTranAsync(() => referenceStore.ReplaceDraftAsync(
            7,
            "delete-race",
            null,
            [new ArticleAssetReferenceWrite(assetId, 1, null)]));

        Assert.False(referenceAttempt.IsSuccess);
        Assert.Contains(
            "content_asset_reference_repair_in_progress",
            referenceAttempt.ErrorException?.ToString(),
            StringComparison.Ordinal);
        releaseDelete.SetResult();
        Assert.Equal(AssetDeleteResult.Deleted, await deleteTask.WaitAsync(TimeSpan.FromSeconds(10)));

        using SqlSugarClient assertDb = PostgresSqlSugarTestClient.Create(connectionString);
        Assert.Null(assertDb.Queryable<ContentAsset>().InSingle(assetId.Value));
        Assert.Empty(assertDb.Queryable<ContentAssetReference>().ToList());
        Assert.Null(assertDb.Queryable<ContentAssetCleanupQueueItem>().InSingle(assetId.Value));
    }

    [Fact]
    public async Task CleanupWinningBeforePublish_PreventsOrphanFinalBytes()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        byte[] bytes = [2, 4, 6, 8];
        AssetId assetId;
        AssetStorageKey storageKey;
        using var directory = new PrivateAssetIntegrationTemporaryDirectory();
        ReleaseStoragePaths paths = ReleaseStorageTestPaths.Create(directory.Path);
        using (SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString))
        {
            CreateTables(setupDb);
            (assetId, storageKey) = SeedPrivateAsset(setupDb, bytes, ContentAssetStates.Active);
        }

        var enteredRead = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseRead = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var content = new BlockingReadStream(bytes, enteredRead, releaseRead);
        using SqlSugarClient writerDb = PostgresSqlSugarTestClient.Create(connectionString);
        LocalPrivateAssetStore writerStore = CreatePrivateStore(writerDb, paths);
        Task<AssetStorageKey> writeTask = writerStore.CreateAsync(new PrivateAssetWriteRequest(
            assetId,
            content,
            PrivateAssetWritePurpose.BinaryAttachment));
        await enteredRead.Task.WaitAsync(TimeSpan.FromSeconds(10));

        using (SqlSugarClient cleanupDb = PostgresSqlSugarTestClient.Create(connectionString))
        {
            LocalPrivateAssetStore cleanupPrivateStore = CreatePrivateStore(cleanupDb, paths);
            Assert.Equal(
                AssetDeleteResult.Deleted,
                await CreateContentStore(cleanupDb, paths, cleanupPrivateStore).DeleteAsync(assetId));
        }

        releaseRead.SetResult();
        InvalidOperationException rejected = await Assert.ThrowsAsync<InvalidOperationException>(async () =>
            await writeTask.WaitAsync(TimeSpan.FromSeconds(10)));
        Assert.Equal("private_asset_commit_cleanup_required", rejected.Message);
        Assert.False(File.Exists(ResolveFinalPath(paths, storageKey)));
        Assert.Empty(Directory.EnumerateFileSystemEntries(
            Path.Combine(paths.UploadCommitRoot, "private-assets")));

        using SqlSugarClient assertDb = PostgresSqlSugarTestClient.Create(connectionString);
        Assert.Null(assertDb.Queryable<ContentAsset>().InSingle(assetId.Value));
        Assert.Null(assertDb.Queryable<ContentAssetCleanupQueueItem>().InSingle(assetId.Value));
    }

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        CreateTables(db);
        return db;
    }

    private static void CreateTables(SqlSugarClient db)
        => PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(ContentAsset),
            typeof(ContentAssetReference),
            typeof(ContentAssetCleanupQueueItem));

    private static (AssetId AssetId, AssetStorageKey StorageKey) SeedPrivateAsset(
        SqlSugarClient db,
        byte[] bytes,
        string state)
    {
        AssetId assetId = AssetId.New();
        AssetStorageKey storageKey = LocalPrivateAssetStore.CreateStorageKey(assetId, ".bin");
        DateTime now = DateTime.UtcNow;
        db.Insertable(new ContentAsset
        {
            AssetId = assetId.Value,
            StorageClass = "private",
            StorageKey = storageKey.Value,
            MimeType = "application/octet-stream",
            Extension = ".bin",
            SizeBytes = bytes.LongLength,
            Sha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)),
            OwnerAdminPrincipalId = 1,
            State = state,
            CreatedAtUtc = now,
            UpdatedAtUtc = now
        }).ExecuteCommand();
        return (assetId, storageKey);
    }

    private static LocalPrivateAssetStore CreatePrivateStore(SqlSugarClient db, ReleaseStoragePaths paths)
        => new(new SqlPrivateAssetRecordSource(db), new PrivateAssetWritePolicy(), paths);

    private static LocalContentAssetStore CreateContentStore(
        SqlSugarClient db,
        ReleaseStoragePaths paths,
        IPrivateAssetStore privateStore)
        => new(db, paths, privateStore, NullLogger<LocalContentAssetStore>.Instance);

    private static ArticleAssetCleanupService CreateCleanupService(
        SqlSugarClient db,
        ReleaseStoragePaths paths,
        IPrivateAssetStore privateStore)
        => new(
            db,
            CreateContentStore(db, paths, privateStore),
            TimeProvider.System,
            NullLogger<ArticleAssetCleanupService>.Instance);

    private static void MakeCleanupDue(SqlSugarClient db, AssetId assetId)
        => db.Updateable<ContentAssetCleanupQueueItem>()
            .SetColumns(item => new ContentAssetCleanupQueueItem
            {
                NotBeforeUtc = DateTime.UtcNow.AddMinutes(-1),
                UpdatedAtUtc = DateTime.UtcNow
            })
            .Where(item => item.AssetId == assetId.Value)
            .ExecuteCommand();

    private static void AssertDeleteFence(
        SqlSugarClient db,
        AssetId assetId,
        string expectedState = ContentAssetStates.PendingDelete)
    {
        Assert.Equal(expectedState, db.Queryable<ContentAsset>().InSingle(assetId.Value).State);
        Assert.Equal(
            ContentAssetCleanupMarkers.DeletePending,
            db.Queryable<ContentAssetCleanupQueueItem>().InSingle(assetId.Value).LastError);
    }

    private static string ResolveFinalPath(ReleaseStoragePaths paths, AssetStorageKey storageKey)
        => Path.Combine(
            paths.PrivateAssetRoot,
            storageKey.Value.Replace('/', Path.DirectorySeparatorChar));

    private sealed class DeleteOnlyPrivateAssetStore(
        Func<AssetId, CancellationToken, Task> delete) : IPrivateAssetStore
    {
        public Task<AssetStorageKey> CreateAsync(
            PrivateAssetWriteRequest request,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<PrivateAssetReadHandle?> OpenReadAsync(
            AssetId assetId,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<PrivateAssetReadHandle?> ValidateAsync(
            AssetId assetId,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task DeleteAsync(AssetId assetId, CancellationToken cancellationToken = default)
            => delete(assetId, cancellationToken);
    }

    private sealed class BlockingReadStream(
        byte[] content,
        TaskCompletionSource entered,
        TaskCompletionSource release) : MemoryStream(content)
    {
        private bool _blocked;

        public override async ValueTask<int> ReadAsync(
            Memory<byte> buffer,
            CancellationToken cancellationToken = default)
        {
            if (!_blocked)
            {
                _blocked = true;
                entered.SetResult();
                await release.Task.WaitAsync(cancellationToken);
            }

            return await base.ReadAsync(buffer, cancellationToken);
        }
    }

    private sealed class PrivateAssetIntegrationTemporaryDirectory : IDisposable
    {
        public PrivateAssetIntegrationTemporaryDirectory()
        {
            Path = System.IO.Path.Combine(
                System.IO.Path.GetTempPath(),
                $"fsus-private-assets-pg-{Guid.NewGuid():N}");
            Directory.CreateDirectory(Path);
        }

        public string Path
        {
            get;
        }

        public void Dispose()
            => Directory.Delete(Path, recursive: true);
    }
}
