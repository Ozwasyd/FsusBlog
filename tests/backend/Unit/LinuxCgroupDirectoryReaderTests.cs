using System.Text;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Platform;
using FsusBlog.Server.Infrastructure.Memory.Pressure;

using Xunit.Abstractions;

namespace FsusBlog.Server.Tests.Unit;

public sealed class LinuxCgroupDirectoryReaderTests
{
    private readonly ITestOutputHelper _output;

    public LinuxCgroupDirectoryReaderTests(ITestOutputHelper output)
    {
        _output = output;
    }

    [Theory]
    [InlineData("0\n", false, MemoryObservationState.Available, 0L, false)]
    [InlineData(" 9223372036854775807\n", true, MemoryObservationState.Available, long.MaxValue, false)]
    [InlineData("max\n", true, MemoryObservationState.Unknown, null, true)]
    [InlineData("max\n", false, MemoryObservationState.Malformed, null, false)]
    [InlineData("", false, MemoryObservationState.Unknown, null, false)]
    [InlineData("-1", true, MemoryObservationState.Malformed, null, false)]
    [InlineData("9223372036854775808", false, MemoryObservationState.Malformed, null, false)]
    [InlineData("12 34", false, MemoryObservationState.Malformed, null, false)]
    [InlineData("12\0", false, MemoryObservationState.Malformed, null, false)]
    public void ScalarsKeepUnknownUnlimitedAndMalformedDistinctFromActualZero(string text, bool limit,
        MemoryObservationState state, long? value, bool unlimited)
    {
        var identity = new LinuxCgroupDirectoryIdentity(2, 11, 22, 0, 3);
        var result = LinuxCgroupDirectoryReader.ParseScalar(Encoding.UTF8.GetBytes(text), limit, identity);
        Assert.Equal(state, result.State);
        Assert.Equal(value, result.Value);
        Assert.Equal(unlimited, result.Unlimited);
        Assert.Same(identity, result.Identity);
        Assert.Equal(MemoryQualification.NotVerified, result.Identity.Qualification);
    }

    [Fact]
    public void OrdinaryFilesAndDirectorySymlinksCannotImpersonateKernelControllerFiles()
    {
        string root = Path.Combine(Path.GetTempPath(), "fsus-mem-cgroup-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            File.WriteAllText(Path.Combine(root, "memory.current"), "0\n");
            File.WriteAllText(Path.Combine(root, "memory.max"), "4096\n");
            var ordinary = LinuxCgroupDirectoryReader.ProbeDirectory(root, 2);
            Assert.Equal(MemoryObservationState.Unknown, ordinary.State);
            Assert.Equal(MemoryFailure.UnsupportedCapability, ordinary.Failure);
            Assert.Null(ordinary.Identity);
            string link = Path.Combine(root, "link");
            Directory.CreateSymbolicLink(link, root);
            Assert.False(LinuxCgroupDirectoryReader.TryInspectDirectory(link, 2).Succeeded);
            Assert.False(LinuxCgroupDirectoryReader.TryInspectDirectory(root, 1).Succeeded);
            Assert.Equal(MemoryFailure.BoundsViolation,
                LinuxCgroupDirectoryReader.TryInspectDirectory(root + "/../", 2).Failure);
            Assert.Equal(MemoryFailure.BoundsViolation,
                LinuxCgroupDirectoryReader.TryInspectDirectory(root, 3).Failure);
            // Every failed probe closes its actual descriptor; cleanup remains possible.
            for (int repeat = 0; repeat < 32; repeat++)
            {
                Assert.False(LinuxCgroupDirectoryReader.TryInspectDirectory(root, 2).Succeeded);
            }
        }
        finally
        {
            Directory.Delete(root, true);
        }
        Assert.False(Directory.Exists(root));
    }

    [Fact]
    public void DeniedDirectoryNeverBecomesAvailableOrNumericalZero()
    {
        if (!OperatingSystem.IsLinux())
        {
            throw new PlatformNotSupportedException("The denied-open receipt requires actual Linux permissions.");
        }
        string root = Path.Combine(Path.GetTempPath(), "fsus-mem-cgroup-denied-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            File.SetUnixFileMode(root, UnixFileMode.None);
            var denied = LinuxCgroupDirectoryReader.ProbeDirectory(root, 2);
            Assert.Equal(MemoryObservationState.Denied, denied.State);
            Assert.Null(denied.Identity);
        }
        finally
        {
            File.SetUnixFileMode(root, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            Directory.Delete(root);
        }
    }

    [Fact]
    public void ScopeNamespaceAndAncestorBoundsAreCheckedBeforeAnyControllerRead()
    {
        var identity = new LinuxCgroupScopeIdentity(2, 0, 1, 1, 71, "0:34", "/tenant",
            "/tenant/service", "/observed/groups");
        var scope = new LinuxCgroupScope(identity, new[] { "/observed/groups/service", "/observed/groups" });
        Assert.Equal(MemoryFailure.BoundsViolation, LinuxCgroupDirectoryReader.TryOpen(scope, 0, 0).Failure);
        Assert.Equal(MemoryFailure.BoundsViolation, LinuxCgroupDirectoryReader.TryOpen(scope, 2, 64).Failure);
        Assert.Equal(MemoryFailure.StaleLocation, LinuxCgroupDirectoryReader.TryOpen(scope, 0, 64).Failure);
        var current = identity with
        {
            CgroupNamespaceInode = NamespaceInode("cgroup"),
            MountNamespaceInode = NamespaceInode("mnt")
        };
        var forged = new LinuxCgroupScope(current, new[] { "/observed/groups/other", "/observed/groups" });
        Assert.Equal(MemoryFailure.BoundsViolation, LinuxCgroupDirectoryReader.TryOpen(forged, 0, 64).Failure);
    }

    [Fact]
    public void LiveKernelDirectoryIdentityAndRawScalarsRemainUnqualifiedWithoutProcessBinding()
    {
        Assert.True(OperatingSystem.IsLinux());
        // The mountpoint comes from this actual process's mountinfo, not a universal path.
        string[] mounts = File.ReadAllLines("/proc/self/mountinfo");
        string line = Assert.Single(mounts, item => item.Contains(" - cgroup2 ", StringComparison.Ordinal));
        string path = line.Split(' ')[4].Replace("\\040", " ", StringComparison.Ordinal)
            .Replace("\\011", "\t", StringComparison.Ordinal).Replace("\\012", "\n", StringComparison.Ordinal)
            .Replace("\\134", "\\", StringComparison.Ordinal);
        var observed = LinuxCgroupDirectoryReader.ProbeDirectory(path, 2);
        Assert.Equal(MemoryObservationState.Available, observed.State);
        LinuxCgroupDirectoryIdentity identity = Assert.IsType<LinuxCgroupDirectoryIdentity>(observed.Identity);
        Assert.Equal(MemoryQualification.NotVerified, identity.Qualification);
        Assert.Equal(ulong.Parse(line.Split(' ')[0]), identity.MountId);
        Assert.Equal(line.Split(' ')[2], identity.DeviceMajor + ":" + identity.DeviceMinor);
        Assert.False(LinuxCgroupDirectoryReader.TryInspectDirectory(path, 1).Succeeded);
        Assert.Equal(MemoryFailure.StaleLocation, LinuxCgroupDirectoryReader.TryOpenObservedDirectory(path,
            identity with
            {
                Inode = identity.Inode + 1
            }, 64).Failure);
        Assert.Equal(MemoryFailure.BoundsViolation,
            LinuxCgroupDirectoryReader.TryOpenObservedDirectory(path, identity, int.MaxValue).Failure);
        var opened = LinuxCgroupDirectoryReader.TryOpenObservedDirectory(path, identity, 64);
        Assert.True(opened.Succeeded);
        using LinuxCgroupDirectoryReader reader = opened.Value!;
        byte[] scratch = new byte[65]; // Explicit fixture bound; no production policy is inferred.
        Array.Fill(scratch, (byte)0xcc);
        LinuxCgroupScalarCapture usage = reader.Capture(LinuxCgroupScalar.UsageBytes, scratch);
        Assert.Equal(MemoryObservationState.Available, usage.State);
        Assert.True(usage.Value >= 0);
        Assert.All(scratch, item => Assert.Equal((byte)0, item));
        var limit = reader.Capture(LinuxCgroupScalar.HardLimitBytes, scratch);
        var high = reader.Capture(LinuxCgroupScalar.HighBytes, scratch);
        var swap = reader.Capture(LinuxCgroupScalar.SwapUsageBytes, scratch);
        var swapLimit = reader.Capture(LinuxCgroupScalar.SwapLimitBytes, scratch);
        Assert.Equal(identity, usage.Identity);
        Assert.Throws<ArgumentException>(() => reader.Capture(LinuxCgroupScalar.UsageBytes, new byte[64]));
        using (LinuxCgroupDirectoryReader bounded = LinuxCgroupDirectoryReader.TryOpenObservedDirectory(path, identity, 1).Value!)
        {
            byte[] tiny = new byte[2];
            Assert.Equal(MemoryObservationState.Malformed, bounded.Capture(LinuxCgroupScalar.UsageBytes, tiny).State);
            Assert.All(tiny, item => Assert.Equal((byte)0, item));
        }
        _output.WriteLine(JsonSerializer.Serialize(new
        {
            ProcessId = Environment.ProcessId,
            CapturedAt = DateTimeOffset.UtcNow,
            ActualMountRecord = line,
            Identity = identity,
            RawUsage = usage,
            RawHardLimit = limit,
            RawHigh = high,
            RawSwap = swap,
            RawSwapLimit = swapLimit,
            ProcessBindingQualified = false,
            GrowthAuthorized = false
        }));
        reader.Dispose();
        reader.Dispose();
        Assert.Throws<ObjectDisposedException>(() => reader.Capture(LinuxCgroupScalar.UsageBytes, scratch));
    }

    private static ulong NamespaceInode(string name)
    {
        string target = new FileInfo("/proc/self/ns/" + name).LinkTarget!;
        Assert.NotNull(target);
        return ulong.Parse(target.AsSpan(name.Length + 2, target.Length - name.Length - 3));
    }
}
