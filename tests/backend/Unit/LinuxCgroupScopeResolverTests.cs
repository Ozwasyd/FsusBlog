using System.Text;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Pressure;

using Xunit.Abstractions;

namespace FsusBlog.Server.Tests.Unit;

public sealed class LinuxCgroupScopeResolverTests
{
    private const string Mount = "71 23 0:34 /tenant /observed/groups rw,nosuid shared:9 future:unknown - cgroup2 none rw";
    private readonly ITestOutputHelper _output;

    public LinuxCgroupScopeResolverTests(ITestOutputHelper output)
    {
        _output = output;
    }

    [Fact]
    public void LiveLinuxNamespaceCaptureNeverCertifiesAdmissionOrAnUnavailableScope()
    {
        Assert.True(OperatingSystem.IsLinux(), "This assertion requires its actual Linux source row.");
        byte[] membership = ReadBounded("/proc/self/cgroup", 65536);
        byte[] mounts = ReadBounded("/proc/self/mountinfo", 65536);
        ulong cgroupNamespace = NamespaceInode("cgroup");
        ulong mountNamespace = NamespaceInode("mnt");
        var result = LinuxCgroupScopeResolver.Resolve(membership, mounts, MemoryObservationState.Available,
            MemoryObservationState.Available, cgroupNamespace, mountNamespace, 65536, 2048, 256);
        _output.WriteLine(JsonSerializer.Serialize(new
        {
            ProcessId = Environment.ProcessId,
            CapturedAt = DateTimeOffset.UtcNow,
            CgroupNamespaceInode = cgroupNamespace,
            MountNamespaceInode = mountNamespace,
            MembershipBytes = membership.Length,
            MountBytes = mounts.Length,
            Membership = Encoding.UTF8.GetString(membership),
            RelevantMounts = Encoding.UTF8.GetString(mounts).Split('\n')
                .Where(line => line.Contains(" - cgroup", StringComparison.Ordinal)).ToArray(),
            Resolution = result
        }));
        if (result.State == MemoryObservationState.Available)
        {
            Assert.NotNull(result.Scope);
            Assert.Equal(MemoryQualification.NotVerified, result.Scope.Qualification);
            Assert.Equal(cgroupNamespace, result.Scope.Identity.CgroupNamespaceInode);
            Assert.Equal(mountNamespace, result.Scope.Identity.MountNamespaceInode);
        }
        else
        {
            Assert.Null(result.Scope);
            Assert.NotEqual(LinuxCgroupScopeReason.Ready, result.Reason);
        }
    }

    [Fact]
    public void NonstandardMountReturnsEachObservableAncestorWithoutClaimingQualification()
    {
        LinuxCgroupScopeResolution resolved = Resolve("0::/tenant/service/worker\n", Mount);
        Assert.Equal(MemoryObservationState.Available, resolved.State);
        Assert.Equal(LinuxCgroupScopeReason.Ready, resolved.Reason);
        LinuxCgroupScope scope = resolved.Scope!;
        Assert.Equal(new[] { "/observed/groups/service/worker", "/observed/groups/service", "/observed/groups" }, scope.ObservableDirectories);
        Assert.Equal(2, scope.Identity.Version);
        Assert.Equal(71, scope.Identity.MountId);
        Assert.Equal("0:34", scope.Identity.DeviceIdentity);
        Assert.Equal("/tenant", scope.Identity.MountRoot);
        Assert.Equal(MemoryQualification.NotVerified, scope.Qualification);
        Assert.Throws<NotSupportedException>(() => ((IList<string>)scope.ObservableDirectories)[0] = "/forged");
    }

    [Fact]
    public void HybridHostResolvesTheActuallyBoundLegacyMemoryController()
    {
        string membership = "0::/unified/service\n3:cpu,cpuacct:/cpu/service\n5:memory:/tenant/worker\n";
        string mounts = Mount + "\n81 23 0:45 /tenant /legacy/memory rw - cgroup none rw,memory\n";
        var resolved = Resolve(membership, mounts);
        Assert.Equal(MemoryObservationState.Available, resolved.State);
        Assert.Equal(1, resolved.Scope!.Identity.Version);
        Assert.Equal(5, resolved.Scope.Identity.HierarchyId);
        Assert.Equal(new[] { "/legacy/memory/worker", "/legacy/memory" }, resolved.Scope.ObservableDirectories);
        Assert.Equal(MemoryQualification.NotVerified, resolved.Scope.Qualification);
    }

    [Fact]
    public void MountEscapesAreDecodedBeforeCheckingContainment()
    {
        var result = Resolve("0::/tenant space/worker\n", "71 23 0:34 /tenant\\040space /observed\\040groups rw - cgroup2 none rw");
        Assert.Equal(MemoryObservationState.Available, result.State);
        Assert.Equal(new[] { "/observed groups/worker", "/observed groups" }, result.Scope!.ObservableDirectories);
    }

    [Theory]
    [InlineData("0::/tenant/../worker\n", Mount)]
    [InlineData("0::/tenant/worker (deleted)\n", Mount)]
    [InlineData("0::/tenant//worker\n", Mount)]
    [InlineData("0::/\n", "71 23 0:34 /.. /observed/groups rw - cgroup2 none rw")]
    [InlineData("0::/tenant/worker\n", "71 23 0:34 /tenant /observed\\777groups rw - cgroup2 none rw")]
    public void InvalidOrNamespaceEscapingMetadataNeverProducesAnAvailableScope(string membership, string mount)
    {
        var result = Resolve(membership, mount);
        Assert.Equal(MemoryObservationState.Malformed, result.State);
        Assert.Equal(LinuxCgroupScopeReason.InvalidFormat, result.Reason);
        Assert.Null(result.Scope);
    }

    [Theory]
    [InlineData(MemoryObservationState.Unknown)]
    [InlineData(MemoryObservationState.Denied)]
    [InlineData(MemoryObservationState.Malformed)]
    [InlineData(MemoryObservationState.Stale)]
    public void UnavailableCaptureRetainsItsExactStateAndNoFabricatedNumericScope(MemoryObservationState state)
    {
        var result = LinuxCgroupScopeResolver.Resolve("0::/tenant/worker"u8, Encoding.UTF8.GetBytes(Mount),
            state, MemoryObservationState.Available, 10, 11, 4096, 16, 8);
        Assert.Equal(state, result.State);
        Assert.Equal(LinuxCgroupScopeReason.Unavailable, result.Reason);
        Assert.Null(result.Scope);
    }

    [Fact]
    public void PrefixCollisionAndNamespaceCoordinateMismatchRemainUnobservable()
    {
        Assert.Equal(LinuxCgroupScopeReason.Unobservable, Resolve("0::/tenant-other/worker", Mount).Reason);
        Assert.Equal(LinuxCgroupScopeReason.Unobservable, Resolve("0::/", Mount).Reason);
        Assert.Equal(LinuxCgroupScopeReason.Missing, Resolve("", Mount).Reason);
    }

    [Fact]
    public void AmbiguousMountsAndMembershipsCannotSilentlyChooseAnAdmissionDomain()
    {
        Assert.Equal(LinuxCgroupScopeReason.Ambiguous,
            Resolve("0::/tenant/worker", Mount + "\n72 23 0:34 /tenant /other/groups rw - cgroup2 none rw").Reason);
        Assert.Equal(LinuxCgroupScopeReason.Ambiguous, Resolve("0::/tenant/worker\n0::/other/worker", Mount).Reason);
    }

    [Fact]
    public void EveryDeclaredInputRecordAndAncestorBoundIsEnforced()
    {
        byte[] member = Encoding.UTF8.GetBytes("0::/tenant/service/worker");
        byte[] mounts = Encoding.UTF8.GetBytes(Mount);
        LinuxCgroupScopeResolution ResolveWith(int bytes, int records, int ancestors)
            => LinuxCgroupScopeResolver.Resolve(member, mounts, MemoryObservationState.Available,
                MemoryObservationState.Available, 10, 11, bytes, records, ancestors);
        Assert.Equal(LinuxCgroupScopeReason.BoundExceeded, ResolveWith(8, 16, 8).Reason);
        Assert.Equal(LinuxCgroupScopeReason.BoundExceeded, ResolveWith(4096, 16, 2).Reason);
        Assert.Equal(LinuxCgroupScopeReason.BoundExceeded,
            Resolve("0::/tenant/worker", Mount + "\n" + Mount, maximumRecords: 1).Reason);
        Assert.Equal(LinuxCgroupScopeReason.InvalidFormat, ResolveWith(4096, 0, 8).Reason);
    }

    [Fact]
    public void MembershipMountAndNamespaceIdentityChangesInvalidateMetadataIdentity()
    {
        LinuxCgroupScopeIdentity original = Resolve("0::/tenant/worker", Mount).Scope!.Identity;
        Assert.NotEqual(original, Resolve("0::/tenant/other", Mount).Scope!.Identity);
        Assert.NotEqual(original, Resolve("0::/tenant/worker", Mount.Replace("71 ", "72 ", StringComparison.Ordinal)).Scope!.Identity);
        Assert.NotEqual(original, LinuxCgroupScopeResolver.Resolve("0::/tenant/worker"u8,
            Encoding.UTF8.GetBytes(Mount), MemoryObservationState.Available, MemoryObservationState.Available,
            12, 11, 4096, 16, 8).Scope!.Identity);
        Assert.NotEqual(original, LinuxCgroupScopeResolver.Resolve("0::/tenant/worker"u8,
            Encoding.UTF8.GetBytes(Mount), MemoryObservationState.Available, MemoryObservationState.Available,
            10, 12, 4096, 16, 8).Scope!.Identity);
    }

    [Fact]
    public void InvalidUtf8AndBrokenMountRecordRejectRatherThanDroppingIdentityFields()
    {
        Assert.Equal(MemoryObservationState.Malformed, LinuxCgroupScopeResolver.Resolve(new byte[] { 0xff },
            Encoding.UTF8.GetBytes(Mount), MemoryObservationState.Available, MemoryObservationState.Available,
            10, 11, 4096, 16, 8).State);
        Assert.Equal(MemoryObservationState.Malformed, Resolve("0::/tenant/worker", "71 23 0:34 /tenant /observed rw cgroup2 none rw").State);
    }

    private static LinuxCgroupScopeResolution Resolve(string member, string mounts, int maximumRecords = 16)
        => LinuxCgroupScopeResolver.Resolve(Encoding.UTF8.GetBytes(member), Encoding.UTF8.GetBytes(mounts),
            MemoryObservationState.Available, MemoryObservationState.Available, 10, 11, 4096, maximumRecords, 8);

    private static byte[] ReadBounded(string path, int maximumBytes)
    {
        var bytes = new byte[maximumBytes + 1];
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        int length = 0;
        while (length < bytes.Length)
        {
            int read = stream.Read(bytes.AsSpan(length));
            if (read == 0)
            {
                break;
            }
            length += read;
        }
        Assert.True(length <= maximumBytes, "The live capture must fit the explicitly supplied fixture buffer.");
        return bytes.AsSpan(0, length).ToArray();
    }

    private static ulong NamespaceInode(string name)
    {
        string? target = new FileInfo("/proc/self/ns/" + name).LinkTarget;
        Assert.NotNull(target);
        Assert.StartsWith(name + ":[", target, StringComparison.Ordinal);
        Assert.EndsWith("]", target, StringComparison.Ordinal);
        Assert.True(ulong.TryParse(target.AsSpan(name.Length + 2, target.Length - name.Length - 3), out ulong inode));
        Assert.True(inode > 0);
        return inode;
    }
}
