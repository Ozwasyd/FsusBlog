using System.Diagnostics;
using System.Globalization;
using System.Runtime.Versioning;

using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Disk;

using Xunit;

namespace FsusBlog.Server.Tests.Unit;

[SupportedOSPlatform("linux")]
public sealed class OwnedSpillRootTests
{
    [Fact]
    public void DisabledDoesNotCreateOrProbeAMissingRoot()
    {
        string missing = Path.Combine(Path.GetTempPath(), $"mem-disabled-{Guid.NewGuid():N}");
        Assert.Throws<InvalidOperationException>(() => new OwnedSpillRoot(missing, Guid.NewGuid(), MemoryCapabilityMode.Disabled));
        Assert.False(Directory.Exists(missing));
    }

    [Fact]
    public void TraversalForeignOwnerAndSymlinkRootAreRejected()
    {
        using var fixture = new RootFixture();
        using var root = fixture.Open();
        Assert.Throws<ArgumentException>(() => root.CreateFile("../escape"));
        Assert.Throws<ArgumentException>(() => root.OpenRead($"mem-{Guid.NewGuid():N}-{Guid.NewGuid():N}.segment"));
        Assert.Throws<ArgumentException>(() => new OwnedSpillRoot(fixture.Path + "/../spill", fixture.Owner));
        string link = System.IO.Path.Combine(fixture.Parent, "link");
        Directory.CreateSymbolicLink(link, fixture.Path);
        Assert.Throws<DiskFileSystemException>(() => new OwnedSpillRoot(link, fixture.Owner));
        Directory.Delete(link);
    }

    [Fact]
    public void RootReplacementIsRejectedBeforeNewReadOrWrite()
    {
        using var fixture = new RootFixture();
        using var root = fixture.Open();
        string name = root.NewName("stage");
        using (FileStream stream = root.CreateFile(name))
        {
            stream.WriteByte(7);
        }
        string moved = System.IO.Path.Combine(fixture.Parent, "moved");
        Directory.Move(fixture.Path, moved);
        Directory.CreateDirectory(fixture.Path, RootFixture.OwnerMode);
        Assert.Throws<DiskFileSystemException>(() => root.Validate());
        Assert.Throws<DiskFileSystemException>(() => root.OpenRead(name));
        Assert.Throws<DiskFileSystemException>(() => root.CreateFile(root.NewName("stage")));
        Assert.Equal(new byte[] { 7 }, File.ReadAllBytes(System.IO.Path.Combine(moved, name)));
    }

    [Fact]
    public void UntrustedWritableRootAndLeafLinksAreRejected()
    {
        using var fixture = new RootFixture();
        File.SetUnixFileMode(fixture.Path, RootFixture.OwnerMode | UnixFileMode.GroupWrite);
        Assert.Throws<UnauthorizedAccessException>(() => fixture.Open());
        File.SetUnixFileMode(fixture.Path, RootFixture.OwnerMode);
        using var root = fixture.Open();
        string foreign = System.IO.Path.Combine(fixture.Parent, "other-owner");
        File.WriteAllText(foreign, "unrelated");
        string name = root.NewName("segment");
        File.CreateSymbolicLink(System.IO.Path.Combine(fixture.Path, name), foreign);
        Assert.Throws<DiskFileSystemException>(() => root.OpenRead(name));
        Assert.Throws<DiskFileSystemException>(() => root.Delete(name));
        Assert.Equal("unrelated", File.ReadAllText(foreign));
    }

    [Fact]
    public void NamesAreOwnerScopedAndPublishDoesNotOverwrite()
    {
        using var fixture = new RootFixture();
        using var root = fixture.Open();
        string source = root.NewName("stage");
        string destination = source.Replace(".stage", ".segment", StringComparison.Ordinal);
        string unrelated = System.IO.Path.Combine(fixture.Path, "database.log");
        File.WriteAllText(unrelated, "sentinel");
        using (FileStream file = root.CreateFile(source))
        {
            file.WriteByte(4);
        }
        root.Rename(source, destination);
        using (FileStream file = root.CreateFile(source))
        {
            file.WriteByte(5);
        }
        Assert.Throws<DiskFileSystemException>(() => root.Rename(source, destination));
        Assert.Equal(2, root.EnumerateNames(16).Count());
        root.Delete(source);
        using (FileStream read = root.OpenRead(destination))
        {
            Assert.Equal(4, read.ReadByte());
        }
        Assert.Throws<ArgumentException>(() => root.Delete("database.log"));
        Assert.Equal("sentinel", File.ReadAllText(unrelated));
    }

    [Fact]
    public void ActualDeviceAliasesShareCapacityAndQuotaUnknownSurvives()
    {
        using var first = new RootFixture();
        using var second = new RootFixture();
        using var left = first.Open();
        using var right = second.Open();
        var capacity = new ResourceDomainId(Guid.NewGuid());
        var inodes = new ResourceDomainId(Guid.NewGuid());
        var quota = new MemoryResourceObservation(capacity, MemoryResourceUnit.Bytes,
            MemoryObservationState.Unknown, null, "fixture:no-quota-probe", DateTimeOffset.UtcNow);
        DiskCapacityObservation one = left.Observe(capacity, inodes, quota, TimeSpan.FromSeconds(10), 1);
        DiskCapacityObservation two = right.Observe(capacity, inodes, quota, TimeSpan.FromSeconds(10), 1);
        Assert.Equal(one.CapacityIdentity, two.CapacityIdentity);
        Assert.StartsWith("linux-device:", one.CapacityIdentity);
        Assert.Equal(MemoryObservationState.Available, one.AvailableBytes.State);
        Assert.Equal(MemoryObservationState.Available, one.AvailableInodes.State);
        Assert.Equal(MemoryResourceUnit.Inodes, one.AvailableInodes.Unit);
        Assert.Equal(inodes, one.AvailableInodes.Domain);
        Assert.Equal(MemoryObservationState.Unknown, one.QuotaBytes.State);
        Assert.Null(one.QuotaBytes.Value);
    }

    [Fact]
    public void ExclusiveCreationRecordsOwnershipBeforeManagedWrappingCanFail()
    {
        using var fixture = new RootFixture();
        using var root = fixture.Open();
        string name = root.NewName("stage");
        bool created = false;
        Assert.Throws<InvalidOperationException>(() => root.CreateFile(name, () =>
        {
            created = true;
            throw new InvalidOperationException("Task-owned wrapper failure injection.");
        }));
        Assert.True(created);
        Assert.Single(root.EnumerateNames(16));
        root.Delete(name);
        Assert.Empty(root.EnumerateNames(16));
    }

    [Fact]
    public void DescriptorFootprintMatchesIndependentStatLogicalBytesAllocatedBlocksAndInode()
    {
        using var fixture = new RootFixture();
        using var root = fixture.Open();
        string name = root.NewName("segment");
        using (FileStream file = root.CreateFile(name))
        {
            file.SetLength(2L * 1024 * 1024);
            file.WriteByte(7);
            file.Flush(flushToDisk: true);
        }
        DateTimeOffset observedAt = DateTimeOffset.Parse("2026-10-08T08:00:00Z", CultureInfo.InvariantCulture);
        DiskFileFootprint actual = root.ObserveFileFootprint(name, new FixedTimeProvider(observedAt));
        var start = new ProcessStartInfo("stat")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        start.ArgumentList.Add("--printf=%i %s %b %B");
        start.ArgumentList.Add("--");
        start.ArgumentList.Add(System.IO.Path.Combine(fixture.Path, name));
        using Process process = Process.Start(start)!;
        if (!process.WaitForExit(10_000))
        {
            process.Kill(entireProcessTree: true);
            process.WaitForExit();
            Assert.Fail("Task-owned stat observer exceeded its timeout.");
        }
        string output = process.StandardOutput.ReadToEnd();
        string errors = process.StandardError.ReadToEnd();
        Assert.True(process.ExitCode == 0, errors);
        string[] values = output.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal(4, values.Length);
        Assert.Equal(ulong.Parse(values[0], CultureInfo.InvariantCulture), actual.Inode);
        Assert.Equal(long.Parse(values[1], CultureInfo.InvariantCulture), actual.LogicalBytes);
        long allocated = checked(long.Parse(values[2], CultureInfo.InvariantCulture)
            * long.Parse(values[3], CultureInfo.InvariantCulture));
        Assert.Equal(allocated, actual.AllocatedFileBytes);
        Assert.Equal(observedAt, actual.SampledAt);
        Assert.False(actual.IsDirectory);
        Assert.Equal(1, actual.ObservedInodes);
        Assert.Equal(root.ObserveRootFootprint().CapacityIdentity, actual.CapacityIdentity);
    }

    [Fact]
    public void FootprintsKeepObjectIdentityAcrossRenameAndReportSubsequentChange()
    {
        using var fixture = new RootFixture();
        using var root = fixture.Open();
        DiskFileFootprint directory = root.ObserveRootFootprint();
        Assert.True(directory.IsDirectory);
        Assert.Equal(1, directory.ObservedInodes);
        string stage = root.NewName("stage");
        using (FileStream file = root.CreateFile(stage))
        {
            file.WriteByte(1);
            file.Flush(flushToDisk: true);
        }
        DiskFileFootprint before = root.ObserveFileFootprint(stage);
        string final = System.IO.Path.ChangeExtension(stage, "segment");
        root.Rename(stage, final);
        DiskFileFootprint renamed = root.ObserveFileFootprint(final);
        Assert.Equal(before.Inode, renamed.Inode);
        Assert.Equal(before.CapacityIdentity, renamed.CapacityIdentity);
        Assert.Equal(before.LogicalBytes, renamed.LogicalBytes);
        Assert.Equal(before.AllocatedFileBytes, renamed.AllocatedFileBytes);
        using (var file = new FileStream(System.IO.Path.Combine(fixture.Path, final), FileMode.Open, FileAccess.Write))
        {
            file.SetLength(8192);
            file.WriteByte(2);
            file.Flush(flushToDisk: true);
        }
        DiskFileFootprint changed = root.ObserveFileFootprint(final);
        Assert.Equal(before.Inode, changed.Inode);
        Assert.Equal(8192, changed.LogicalBytes);
        Assert.NotEqual(renamed.ChangeStamp, changed.ChangeStamp);
        root.Delete(final);
        root.Delete(final);
        Assert.Empty(root.EnumerateNames(16));
    }

    [Fact]
    public void ExpectedDeletionReportsOnlyActualUnlinkAndPreservesAnInodeMovedOutOfItsName()
    {
        using var fixture = new RootFixture();
        using var root = fixture.Open();
        string name = root.NewName("segment");
        using (FileStream file = root.CreateFile(name))
        {
            file.WriteByte(11);
        }
        DiskFileFootprint original = root.ObserveFileFootprint(name);
        string path = System.IO.Path.Combine(fixture.Path, name);
        string backup = System.IO.Path.Combine(fixture.Parent, "held-original");
        File.Move(path, backup);
        Assert.False(root.Delete(name, original));
        Assert.Equal(new byte[] { 11 }, File.ReadAllBytes(backup));
        File.Move(backup, path);
        Assert.Equal(original.Inode, root.ObserveFileFootprint(name).Inode);
        Assert.True(root.Delete(name, original));
        Assert.False(root.Delete(name, original));
        Assert.False(File.Exists(path));
        Assert.False(File.Exists(backup));
    }

    [Fact]
    public void FootprintObservationRejectsForeignNamesLinksAndReplacedRoot()
    {
        using var fixture = new RootFixture();
        using var root = fixture.Open();
        string unrelated = System.IO.Path.Combine(fixture.Parent, "authoritative-file");
        File.WriteAllText(unrelated, "sentinel");
        Assert.Throws<ArgumentException>(() => root.ObserveFileFootprint("../authoritative-file"));
        Assert.Throws<ArgumentException>(() => root.ObserveFileFootprint($"mem-{Guid.NewGuid():N}-{Guid.NewGuid():N}.segment"));
        string link = root.NewName("segment");
        File.CreateSymbolicLink(System.IO.Path.Combine(fixture.Path, link), unrelated);
        Assert.Throws<DiskFileSystemException>(() => root.ObserveFileFootprint(link));
        string moved = System.IO.Path.Combine(fixture.Parent, "held-root");
        Directory.Move(fixture.Path, moved);
        Directory.CreateDirectory(fixture.Path, RootFixture.OwnerMode);
        Assert.Throws<DiskFileSystemException>(() => root.ObserveRootFootprint());
        Assert.Equal("sentinel", File.ReadAllText(unrelated));
    }

    [Fact]
    public void EnumerationCountsForeignFilesAndDirectoriesBeforeOwnerFiltering()
    {
        using var fixture = new RootFixture();
        using var root = fixture.Open();
        File.WriteAllText(System.IO.Path.Combine(fixture.Path, "foreign-one"), "one");
        File.WriteAllText(System.IO.Path.Combine(fixture.Path, "foreign-two"), "two");
        Directory.CreateDirectory(System.IO.Path.Combine(fixture.Path, "foreign-directory"), RootFixture.OwnerMode);
        DiskFileSystemException failure = Assert.Throws<DiskFileSystemException>(() => root.EnumerateNames(2).ToArray());
        Assert.Equal(MemoryFailure.BudgetRejected, failure.OperationFailure);
        Assert.Equal(3, Directory.EnumerateFileSystemEntries(fixture.Path).Count());
    }

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    private sealed class RootFixture : IDisposable
    {
        internal const UnixFileMode OwnerMode = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;
        internal string Parent { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"mem-root-test-{Guid.NewGuid():N}");
        internal string Path
        {
            get;
        }
        internal Guid Owner { get; } = Guid.NewGuid();

        internal RootFixture()
        {
            Path = System.IO.Path.Combine(Parent, "spill");
            Directory.CreateDirectory(Path, OwnerMode);
            File.SetUnixFileMode(Parent, OwnerMode);
        }

        internal OwnedSpillRoot Open() => new(Path, Owner);

        public void Dispose()
        {
            // Only this fixture's random directory and its deliberately created resources.
            Directory.Delete(Parent, recursive: true);
        }
    }
}
