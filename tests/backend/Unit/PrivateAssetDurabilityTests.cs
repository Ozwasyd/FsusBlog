using FsusBlog.Server.Services.PrivateAssets;

using Microsoft.Win32.SafeHandles;

namespace FsusBlog.Server.Tests;

public sealed class PrivateAssetDurabilityTests
{
    [Fact]
    public async Task AtomicRenameRejectsExistingDestinationAndRemovesStagingEntry()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }

        string root = Path.Combine(Path.GetTempPath(), $"fsus-private-rename-{Guid.NewGuid():N}");
        string privateRoot = Path.Combine(root, "private");
        string commitRoot = Path.Combine(root, "commit");
        Directory.CreateDirectory(privateRoot);
        Directory.CreateDirectory(commitRoot);
        try
        {
            var fileSystem = new PrivateAssetAnchoredFileSystem(privateRoot, commitRoot);
            await using AnchoredTemporaryFile first = fileSystem.CreateTemporary();
            await first.Stream.WriteAsync(new byte[] { 1, 2, 3 });
            first.Stream.Flush(flushToDisk: true);
            fileSystem.Commit(first, "ab/asset.bin");
            await using AnchoredTemporaryFile second = fileSystem.CreateTemporary();
            await second.Stream.WriteAsync(new byte[] { 4, 5, 6 });
            second.Stream.Flush(flushToDisk: true);

            Assert.Throws<IOException>(() => fileSystem.Commit(second, "ab/asset.bin"));

            Assert.Equal(new byte[] { 1, 2, 3 }, await File.ReadAllBytesAsync(Path.Combine(privateRoot, "ab/asset.bin")));
            Assert.Empty(Directory.EnumerateFileSystemEntries(Path.Combine(commitRoot, "private-assets")));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RetrySynchronizesParentEntriesAfterDirectorySyncFailure(bool afterPublication)
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }

        string root = Path.Combine(Path.GetTempPath(), $"fsus-private-durability-{Guid.NewGuid():N}");
        string privateRoot = Path.Combine(root, "private");
        string commitRoot = Path.Combine(root, "commit");
        Directory.CreateDirectory(privateRoot);
        Directory.CreateDirectory(commitRoot);
        try
        {
            var sync = new FaultingDirectorySync();
            var fileSystem = new PrivateAssetAnchoredFileSystem(privateRoot, commitRoot, sync);
            await using AnchoredTemporaryFile temporary = fileSystem.CreateTemporary();
            await temporary.Stream.WriteAsync(new byte[] { 1, 2, 3 });
            temporary.Stream.Flush(flushToDisk: true);
            const string StorageKey = "ab/asset.bin";
            sync.FailNext = afterPublication
                ? PrivateAssetDirectoryDurabilityPoint.Published
                : PrivateAssetDirectoryDurabilityPoint.ParentCreated;

            Assert.Throws<PrivateAssetDurabilityException>(() => fileSystem.Commit(temporary, StorageKey));
            Assert.Equal(afterPublication, File.Exists(Path.Combine(privateRoot, StorageKey)));
            sync.Points.Clear();

            if (afterPublication)
            {
                fileSystem.SyncExistingEntry(StorageKey);
            }
            else
            {
                fileSystem.Commit(temporary, StorageKey);
            }

            Assert.Equal(PrivateAssetDirectoryDurabilityPoint.ParentCreated, sync.Points[0]);
            Assert.Equal(
                afterPublication
                    ? PrivateAssetDirectoryDurabilityPoint.ExistingPublication
                    : PrivateAssetDirectoryDurabilityPoint.Published,
                sync.Points[^1]);
            Assert.Equal(new byte[] { 1, 2, 3 }, await File.ReadAllBytesAsync(Path.Combine(privateRoot, StorageKey)));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task RetrySynchronizesBothDirectoriesAfterCommitSourceSyncFailure()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }

        string root = Path.Combine(Path.GetTempPath(), $"fsus-private-source-sync-{Guid.NewGuid():N}");
        string privateRoot = Path.Combine(root, "private");
        string commitRoot = Path.Combine(root, "commit");
        Directory.CreateDirectory(privateRoot);
        Directory.CreateDirectory(commitRoot);
        try
        {
            var sync = new FaultingDirectorySync();
            var fileSystem = new PrivateAssetAnchoredFileSystem(privateRoot, commitRoot, sync);
            await using AnchoredTemporaryFile temporary = fileSystem.CreateTemporary();
            byte[] expected = [7, 8, 9];
            await temporary.Stream.WriteAsync(expected);
            temporary.Stream.Flush(flushToDisk: true);
            const string StorageKey = "cd/asset.bin";
            sync.FailNext = PrivateAssetDirectoryDurabilityPoint.CommitSource;

            Assert.Throws<PrivateAssetDurabilityException>(() => fileSystem.Commit(temporary, StorageKey));
            Assert.Equal(expected, await File.ReadAllBytesAsync(Path.Combine(privateRoot, StorageKey)));
            Assert.Empty(Directory.EnumerateFileSystemEntries(Path.Combine(commitRoot, "private-assets")));
            Assert.DoesNotContain(PrivateAssetDirectoryDurabilityPoint.Published, sync.Points);

            sync.Points.Clear();
            fileSystem.SyncExistingEntry(StorageKey);

            Assert.Contains(PrivateAssetDirectoryDurabilityPoint.CommitSource, sync.Points);
            Assert.Equal(PrivateAssetDirectoryDurabilityPoint.ExistingPublication, sync.Points[^1]);
            Assert.True(sync.Points.IndexOf(PrivateAssetDirectoryDurabilityPoint.CommitSource)
                < sync.Points.IndexOf(PrivateAssetDirectoryDurabilityPoint.ExistingPublication));
            Assert.Equal(expected, await File.ReadAllBytesAsync(Path.Combine(privateRoot, StorageKey)));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    internal sealed class FaultingDirectorySync : IPrivateAssetDirectorySync
    {
        private readonly LinuxPrivateAssetDirectorySync _inner = new();

        public PrivateAssetDirectoryDurabilityPoint? FailNext
        {
            get;
            set;
        }

        public List<PrivateAssetDirectoryDurabilityPoint> Points { get; } = [];

        public void Sync(SafeFileHandle directory, PrivateAssetDirectoryDurabilityPoint point)
        {
            Points.Add(point);
            if (FailNext == point)
            {
                FailNext = null;
                throw new PrivateAssetDurabilityException("private_asset_injected_directory_sync_failure");
            }

            _inner.Sync(directory, point);
        }
    }
}
