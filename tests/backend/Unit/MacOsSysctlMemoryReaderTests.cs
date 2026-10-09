using System.Reflection;
using System.Runtime.InteropServices;

using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Platform;

namespace FsusBlog.Server.Tests.Unit;

public sealed class MacOsSysctlMemoryReaderTests
{
    [Fact]
    public void ManagedLayoutMatchesPinnedXnuFieldWidthsWithoutNativeQualification()
    {
        Type layout = typeof(MacOsSysctlMemoryReader.NativeSwapUsage);
        Assert.Equal(32, Marshal.SizeOf<MacOsSysctlMemoryReader.NativeSwapUsage>());
        string[] names = ["_total", "_available", "_used", "_pageSize", "_encrypted"];
        int[] offsets = [0, 8, 16, 24, 28];
        Type[] types = [typeof(ulong), typeof(ulong), typeof(ulong), typeof(uint), typeof(uint)];
        for (int index = 0; index < names.Length; index++)
        {
            Assert.Equal(offsets[index], Marshal.OffsetOf(layout, names[index]).ToInt32());
            Assert.Equal(types[index], layout.GetField(names[index], BindingFlags.NonPublic | BindingFlags.Instance)!.FieldType);
        }
        foreach (string method in new[] { "ReadPhysicalByName", "ReadSwapByName" })
        {
            MethodInfo declaration = typeof(MacOsSysctlMemoryReader).GetMethod(method,
                BindingFlags.NonPublic | BindingFlags.Static)!;
            var import = declaration.GetCustomAttribute<DllImportAttribute>()!;
            Assert.Equal("sysctlbyname", import.EntryPoint);
            Assert.Equal("/usr/lib/libSystem.B.dylib", import.Value);
            Assert.True(import.SetLastError);
            Assert.Equal(CallingConvention.Cdecl, import.CallingConvention);
            Assert.Equal(typeof(int), declaration.ReturnType);
            ParameterInfo[] parameters = declaration.GetParameters();
            Assert.Equal(typeof(nuint).MakeByRefType(), parameters[2].ParameterType);
            Assert.Equal(typeof(nint), parameters[3].ParameterType);
            Assert.Equal(typeof(nuint), parameters[4].ParameterType);
        }
    }

    [Fact]
    public void PhysicalMappingKeepsBytesZeroAndCheckedSignedBoundary()
    {
        MacOsSysctlMemoryObservation[] output = FilledOutput();
        foreach (ulong value in new[] { 0UL, 17179869184UL, (ulong)long.MaxValue })
        {
            MacOsSysctlMemoryReader.MapPhysical(output, 0, 13, 8, value);
            AssertValue(output[0], (long)value);
        }
        foreach (ulong value in new[] { (ulong)long.MaxValue + 1, ulong.MaxValue })
        {
            MacOsSysctlMemoryReader.MapPhysical(output, 0, 0, 8, value);
            Assert.Equal(MemoryObservationState.Malformed, output[0].State);
            Assert.Null(output[0].Value);
        }
        Assert.Equal(MacOsMemoryScope.HostPhysical, output[0].Scope);
        Assert.Equal("hw.memsize", output[0].Source);
        Assert.Equal(MacOsMemoryMetric.HostPhysicalTotalBytes, output[0].Metric);
        Assert.Equal(DateTimeOffset.UnixEpoch, output[0].SampledAt);
        Assert.Equal(123, output[1].Value);
    }

    [Fact]
    public void SwapMappingPreservesByteOccupancyAndSuccessfulNoSwapZeros()
    {
        MacOsSysctlMemoryObservation[] output = FilledOutput();
        var native = new MacOsSysctlMemoryReader.NativeSwapUsage
        {
            _total = 8192,
            _available = 6144,
            _used = 2048,
            _pageSize = 4096,
            _encrypted = 1
        };
        MacOsSysctlMemoryReader.MapSwap(output.AsSpan(1), 0, 13, 32, native);
        AssertValue(output[1], 8192);
        AssertValue(output[2], 6144);
        AssertValue(output[3], 2048);
        Assert.Equal(123, output[0].Value);
        Assert.All(output[1..], item =>
        {
            Assert.Equal(MacOsMemoryScope.HostSwap, item.Scope);
            Assert.Equal("vm.swapusage", item.Source);
            Assert.Equal(DateTimeOffset.UnixEpoch, item.SampledAt);
        });
        MacOsSysctlMemoryReader.MapSwap(output.AsSpan(1), 0, 0, 32, default);
        Assert.All(output[1..], item => AssertValue(item, 0));
        native._total = 0;
        native._available = 0;
        native._used = 0;
        MacOsSysctlMemoryReader.MapSwap(output.AsSpan(1), 0, 0, 32, native);
        Assert.All(output[1..], item => AssertValue(item, 0));
        native._total = ulong.MaxValue;
        native._available = ulong.MaxValue - 7;
        native._used = 7;
        MacOsSysctlMemoryReader.MapSwap(output.AsSpan(1), 0, 0, 32, native);
        Assert.Equal(MemoryObservationState.Malformed, output[1].State);
        Assert.Null(output[1].Value);
        Assert.Equal(MemoryObservationState.Malformed, output[2].State);
        Assert.Null(output[2].Value);
        AssertValue(output[3], 7);
    }

    [Fact]
    public void WrongReturnedLengthsAndInvalidSwapFieldsNeverBecomeFacts()
    {
        foreach (nuint length in new nuint[] { 0, 4, 7, 9, nuint.MaxValue })
        {
            MacOsSysctlMemoryObservation[] output = FilledOutput();
            MacOsSysctlMemoryReader.MapPhysical(output, 0, 0, length, 0);
            Assert.Equal(MemoryObservationState.Malformed, output[0].State);
            Assert.Null(output[0].Value);
        }
        foreach (nuint length in new nuint[] { 0, 24, 28, 31, 33, nuint.MaxValue })
        {
            MacOsSysctlMemoryObservation[] output = FilledOutput();
            MacOsSysctlMemoryReader.MapSwap(output.AsSpan(1), 0, 0, length, default);
            AssertMalformedSwap(output);
        }
        MacOsSysctlMemoryReader.NativeSwapUsage[] invalid =
        [
            new() { _total = 1, _available = 2, _used = ulong.MaxValue, _pageSize = 4096 },
            new() { _total = 10, _available = 2, _used = 7, _pageSize = 4096 },
            new() { _total = 10, _available = 2, _used = 8 },
            new() { _encrypted = 1 },
            new() { _pageSize = 4096, _encrypted = 2 },
            new() { _pageSize = 4096, _encrypted = uint.MaxValue }
        ];
        foreach (var native in invalid)
        {
            MacOsSysctlMemoryObservation[] output = FilledOutput();
            MacOsSysctlMemoryReader.MapSwap(output.AsSpan(1), 0, 0, 32, native);
            AssertMalformedSwap(output);
        }
    }

    [Fact]
    public void NativeErrorsOverrideBufferContentsAndKeepUnavailableDistinctFromDenied()
    {
        int[] errors = [1, 13, 2, 45, 78, 12, 22, 84, 5, 0];
        foreach (int error in errors)
        {
            MacOsSysctlMemoryObservation[] output = FilledOutput();
            MacOsSysctlMemoryReader.MapPhysical(output, -1, error, 0, 0);
            MacOsSysctlMemoryReader.MapSwap(output.AsSpan(1), -1, error, 0, default);
            MemoryObservationState expected = error is 1 or 13 ? MemoryObservationState.Denied
                : error == 84 ? MemoryObservationState.Malformed : MemoryObservationState.Unknown;
            MemoryFailure failure = error is 2 or 45 or 78
                ? MemoryFailure.UnsupportedCapability : MemoryFailure.TierUnavailable;
            Assert.All(output, item =>
            {
                Assert.Equal(expected, item.State);
                Assert.Equal(failure, item.Failure);
                Assert.Equal(error, item.NativeError);
                Assert.Null(item.Value);
                Assert.Equal(MemoryQualification.NotVerified, item.Qualification);
            });
        }
    }

    [Fact]
    public void DisabledClearsOldFactsWithoutNativeOrClockCallsAndLeavesTailOwnedByCaller()
    {
        var clock = new ThrowingClock();
        MacOsSysctlMemoryObservation[] output = [.. FilledOutput(), FilledOutput()[0]];
        var result = MacOsSysctlMemoryReader.Capture(clock, output, MemoryCapabilityMode.Disabled);
        Assert.Equal(MemoryCapabilityMode.Disabled, result.Mode);
        Assert.False(result.Captured);
        Assert.Null(result.Failure);
        Assert.Equal(0, result.NativeCallAttempts);
        Assert.Equal(MemoryQualification.NotVerified, result.Qualification);
        Assert.All(output[..4], item =>
        {
            Assert.Equal(MemoryObservationState.Unknown, item.State);
            Assert.Null(item.Value);
            Assert.Null(item.NativeError);
            Assert.Null(item.SampledAt);
        });
        Assert.Equal(4, output[..4].Select(item => item.Metric).Distinct().Count());
        Assert.Equal(123, output[4].Value);
        Assert.Equal(0, clock.Captures);
    }

    [Fact]
    public void InvalidStorageOrModeRefusesCaptureAndClearsAdmittedRows()
    {
        var clock = new ThrowingClock();
        foreach (int length in new[] { 0, 1, 3 })
        {
            MacOsSysctlMemoryObservation[] output = FilledOutput()[..length];
            var result = MacOsSysctlMemoryReader.Capture(clock, output);
            Assert.Equal(MemoryFailure.BoundsViolation, result.Failure);
            Assert.False(result.Captured);
            Assert.Equal(0, result.NativeCallAttempts);
            Assert.All(output, item => Assert.Null(item.Value));
        }
        MacOsSysctlMemoryObservation[] full = FilledOutput();
        var invalid = MacOsSysctlMemoryReader.Capture(clock, full, (MemoryCapabilityMode)999);
        Assert.Equal(MemoryFailure.BoundsViolation, invalid.Failure);
        Assert.Equal(0, invalid.NativeCallAttempts);
        Assert.All(full, item => Assert.Null(item.Value));
        Assert.Equal(0, clock.Captures);
    }

    [Fact]
    public void ActualLinuxHostRefusesAutoAndRequiredWithoutMacOsNativeExecution()
    {
        Assert.True(OperatingSystem.IsLinux(), "This control observes Linux refusal, not macOS qualification.");
        var clock = new ThrowingClock();
        foreach (MemoryCapabilityMode mode in new[] { MemoryCapabilityMode.Auto, MemoryCapabilityMode.Required })
        {
            MacOsSysctlMemoryObservation[] output = FilledOutput();
            var result = MacOsSysctlMemoryReader.Capture(clock, output, mode);
            Assert.Equal(mode, result.Mode);
            Assert.False(result.Captured);
            Assert.Equal(MemoryFailure.UnsupportedCapability, result.Failure);
            Assert.Equal(0, result.NativeCallAttempts);
            Assert.Equal(MemoryQualification.NotVerified, result.Qualification);
            Assert.All(output, item =>
            {
                Assert.Equal(MemoryObservationState.Unknown, item.State);
                Assert.Null(item.Value);
                Assert.Null(item.SampledAt);
                Assert.Equal(MemoryFailure.UnsupportedCapability, item.Failure);
                Assert.Equal(MemoryQualification.NotVerified, item.Qualification);
            });
        }
        Assert.Equal(0, clock.Captures);
    }

    private static void AssertValue(MacOsSysctlMemoryObservation item, long expected)
    {
        Assert.Equal(MemoryObservationState.Available, item.State);
        Assert.Equal(expected, item.Value);
        Assert.Null(item.Failure);
        Assert.Null(item.NativeError);
        Assert.Equal(MemoryResourceUnit.Bytes, item.Unit);
        Assert.Equal(MemoryQualification.NotVerified, item.Qualification);
    }

    private static void AssertMalformedSwap(MacOsSysctlMemoryObservation[] output)
    {
        Assert.All(output[1..], item =>
        {
            Assert.Equal(MemoryObservationState.Malformed, item.State);
            Assert.Null(item.Value);
        });
    }

    private static MacOsSysctlMemoryObservation[] FilledOutput()
        => Enumerable.Range(0, 4).Select(index => new MacOsSysctlMemoryObservation((MacOsMemoryMetric)index,
            index == 0 ? MacOsMemoryScope.HostPhysical : MacOsMemoryScope.HostSwap,
            index == 0 ? "hw.memsize" : "vm.swapusage", MemoryObservationState.Available, 123,
            MemoryFailure.TierUnavailable, 13, DateTimeOffset.UnixEpoch)).ToArray();

    private sealed class ThrowingClock : TimeProvider
    {
        public int Captures
        {
            get; private set;
        }
        public override DateTimeOffset GetUtcNow()
        {
            Captures++;
            throw new InvalidOperationException("This refusal control permits no clock capture.");
        }
    }
}
