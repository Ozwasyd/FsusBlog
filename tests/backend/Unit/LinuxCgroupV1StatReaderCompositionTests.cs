using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Platform;
using FsusBlog.Server.Infrastructure.Memory.Pressure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class LinuxCgroupV1StatReaderCompositionTests
{
    [Theory]
    [InlineData("rss", LinuxCgroupV1StatScope.Local, LinuxCgroupCounterUnit.Bytes)]
    [InlineData("total_rss", LinuxCgroupV1StatScope.HierarchicalTotal, LinuxCgroupCounterUnit.Bytes)]
    [InlineData("pgmajfault", LinuxCgroupV1StatScope.Local, LinuxCgroupCounterUnit.Events)]
    [InlineData("hierarchical_memsw_limit", LinuxCgroupV1StatScope.HierarchicalLimit, LinuxCgroupCounterUnit.Bytes)]
    public void ARealV2OwnerNeverAliasesV1KeysAndClearsItsDeclaredScratch(
        string key, LinuxCgroupV1StatScope scope, LinuxCgroupCounterUnit unit)
    {
        Assert.True(OperatingSystem.IsLinux());
        string line = Assert.Single(File.ReadAllLines("/proc/self/mountinfo"),
            item => item.Contains(" - cgroup2 ", StringComparison.Ordinal));
        string path = line.Split(' ')[4].Replace("\\040", " ", StringComparison.Ordinal)
            .Replace("\\011", "\t", StringComparison.Ordinal).Replace("\\012", "\n", StringComparison.Ordinal)
            .Replace("\\134", "\\", StringComparison.Ordinal);
        LinuxCgroupDirectoryIdentity identity = LinuxCgroupDirectoryReader.TryInspectDirectory(path, 2).Value!;
        using LinuxCgroupDirectoryReader reader = LinuxCgroupDirectoryReader.TryOpenObservedDirectory(path, identity, 4096).Value!;
        byte[] scratch = new byte[4097];
        Array.Fill(scratch, (byte)0xcc);
        LinuxCgroupV1StatCapture actual = reader.CaptureV1Stat(key, scratch);
        Assert.Equal(MemoryObservationState.Unknown, actual.State);
        Assert.Null(actual.Value);
        Assert.Equal(scope, actual.Scope);
        Assert.Equal(unit, actual.Unit);
        Assert.Equal(key, actual.Key);
        Assert.Equal(identity, actual.Identity);
        Assert.Equal(MemoryQualification.NotVerified, actual.Qualification);
        Assert.All(scratch, value => Assert.Equal((byte)0, value));
        Assert.Throws<ArgumentException>(() => reader.CaptureV1Stat("anon", scratch));
        Assert.Throws<ArgumentException>(() => reader.CaptureV1Stat(key, new byte[4096]));
        reader.Dispose();
        Assert.Throws<ObjectDisposedException>(() => reader.CaptureV1Stat(key, scratch));
    }
}
