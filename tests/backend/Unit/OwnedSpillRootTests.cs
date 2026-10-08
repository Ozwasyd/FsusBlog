using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Disk;

using Xunit;

namespace FsusBlog.Server.Tests.Unit;

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
        Assert.Equal(MemoryObservationState.Unknown, one.QuotaBytes.State);
        Assert.Null(one.QuotaBytes.Value);
    }

    private sealed class RootFixture : IDisposable
    {
        internal const UnixFileMode OwnerMode = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;
        internal string Parent { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"mem-root-test-{Guid.NewGuid():N}");
        internal string Path { get; }
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
