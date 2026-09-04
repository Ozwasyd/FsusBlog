using System.Reflection;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Storage;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.PrivateAssets;

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
    public void ProductionGateway_UsesOnlyInternalPrivateStorageAlias()
    {
        string repositoryRoot = RepositoryRoot();
        string compose = File.ReadAllText(Path.Combine(repositoryRoot, "ops/docker/docker-compose.production.yml"));
        string gateway = File.ReadAllText(Path.Combine(repositoryRoot, "ops/gateway/production-openresty.conf"));

        Assert.Contains("location ^~ /assets/private/", gateway, StringComparison.Ordinal);
        Assert.Contains("access_log off;", gateway, StringComparison.Ordinal);
        Assert.Contains("location ^~ /_fsus/private-assets/", gateway, StringComparison.Ordinal);
        Assert.Contains("internal;", gateway, StringComparison.Ordinal);
        Assert.Contains(
            "alias /var/lib/fsusblog/storage/shared/assets/private/;",
            gateway,
            StringComparison.Ordinal);
        Assert.DoesNotContain("PrivateAssetRoot", gateway, StringComparison.Ordinal);
        Assert.DoesNotContain("/app/storage/shared/assets/private", compose, StringComparison.Ordinal);
        Assert.Contains("FSUSBLOG_SHARED_STORAGE_ROOT=/app/storage/shared", compose, StringComparison.Ordinal);
        Assert.Contains("FSUSBLOG_INSTANCE_STORAGE_ROOT=/app/storage/instances", compose, StringComparison.Ordinal);
        Assert.Contains("fsus-storage:/app/storage", compose, StringComparison.Ordinal);
        Assert.Contains("device: /var/lib/fsusblog/storage", compose, StringComparison.Ordinal);
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

        public Task<bool> CompleteCommitAsync(
            AssetRecord expected,
            CancellationToken cancellationToken)
        {
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
