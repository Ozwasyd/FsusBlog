using System.Runtime.InteropServices;

using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Platform;

namespace FsusBlog.Server.Tests.Unit;

public sealed class WindowsNativeMemoryPressureReaderTests
{
    [Theory]
    [InlineData(0UL, 4096UL, MemoryObservationState.Available, 0L)]
    [InlineData(3UL, 4096UL, MemoryObservationState.Available, 12288L)]
    [InlineData((ulong)long.MaxValue, 1UL, MemoryObservationState.Available, long.MaxValue)]
    [InlineData(ulong.MaxValue, 1UL, MemoryObservationState.Malformed, null)]
    [InlineData(ulong.MaxValue, 4096UL, MemoryObservationState.Malformed, null)]
    [InlineData(0UL, 0UL, MemoryObservationState.Malformed, null)]
    public void NativeByteAndPageConversionNeverWrapsOrInventsZero(ulong value, ulong multiplier,
        MemoryObservationState state, long? expected)
    {
        var actual = WindowsNativeMemoryPressureReader.ConvertNative(value, multiplier);
        Assert.Equal(state, actual.State);
        Assert.Equal(expected, actual.Value);
    }

    [Fact]
    public void DisabledAndInvalidStorageMakeNoNativeOrClockCaptureAndRetainNoOldValues()
    {
        var clock = new ThrowingClock();
        WindowsPressureObservation[] output = FilledOutput();
        var disabled = WindowsNativeMemoryPressureReader.Capture(clock, TimeSpan.FromSeconds(1), output,
            MemoryCapabilityMode.Disabled);
        Assert.Equal(MemoryCapabilityMode.Disabled, disabled.Mode);
        Assert.False(disabled.Captured);
        Assert.Equal(0, disabled.NativeCallAttempts);
        Assert.Null(disabled.Failure);
        Assert.Null(disabled.ReportedOsMajor);
        Assert.All(output, item =>
        {
            Assert.Equal(MemoryObservationState.Unknown, item.State);
            Assert.Null(item.Value);
            Assert.Null(item.SampledAt);
            Assert.Null(item.Timestamp);
            Assert.Equal(MemoryQualification.NotVerified, item.Qualification);
        });
        Assert.Equal(8, output.Select(item => item.Metric).Distinct().Count());
        WindowsPressureObservation[] shortOutput = FilledOutput()[..7];
        var invalid = WindowsNativeMemoryPressureReader.Capture(clock, TimeSpan.FromSeconds(1), shortOutput);
        Assert.Equal(MemoryFailure.BoundsViolation, invalid.Failure);
        Assert.False(invalid.Captured);
        Assert.All(shortOutput, item => Assert.Null(item.Value));
        Assert.Equal(0, clock.Captures);
    }

    [Fact]
    public void ActualLinuxHostRejectsWindowsAbiWithoutAWindowsNativeCapture()
    {
        Assert.True(OperatingSystem.IsLinux(), "This is the actual Linux unsupported-target assertion, not Windows qualification.");
        var clock = new ThrowingClock();
        WindowsPressureObservation[] output = FilledOutput();
        var result = WindowsNativeMemoryPressureReader.Capture(clock, TimeSpan.FromSeconds(1), output);
        Assert.Equal(MemoryCapabilityMode.Auto, result.Mode);
        Assert.Equal(MemoryFailure.UnsupportedCapability, result.Failure);
        Assert.False(result.Captured);
        Assert.Equal(0, result.NativeCallAttempts);
        Assert.Equal(0, clock.Captures);
        Assert.All(output, item =>
        {
            Assert.Equal(MemoryObservationState.Unknown, item.State);
            Assert.Null(item.Value);
            Assert.Equal(MemoryFailure.UnsupportedCapability, item.Failure);
            Assert.Equal(MemoryQualification.NotVerified, item.Qualification);
        });
        Assert.Equal(WindowsPressureScope.HostPhysical, output[0].Scope);
        Assert.Equal(WindowsPressureScope.SystemCommit, output[2].Scope);
        Assert.Equal(WindowsPressureScope.CurrentProcess, output[5].Scope);
        Assert.True(output[6].IsByteValue);
        Assert.False(output[7].IsByteValue);
        Assert.Equal(WindowsPressureMetric.ProcessPrivateCommitBytes, output[6].Metric);
        Assert.Equal(WindowsPressureMetric.ProcessPageFaultCount, output[7].Metric);
        var required = WindowsNativeMemoryPressureReader.Capture(clock, TimeSpan.FromSeconds(1), output, MemoryCapabilityMode.Required);
        Assert.Equal(MemoryCapabilityMode.Required, required.Mode);
        Assert.Equal(MemoryFailure.UnsupportedCapability, required.Failure);
        Assert.Equal(0, required.NativeCallAttempts);
    }

    [Fact]
    public void Managed64BitAbiFixtureDoesNotQualifyWindowsRuntime()
    {
        Assert.Equal(8, IntPtr.Size);
        Assert.Equal(64, Marshal.SizeOf<WindowsNativeMemoryPressureReader.NativeMemoryStatus>());
        Assert.Equal(104, Marshal.SizeOf<WindowsNativeMemoryPressureReader.NativePerformanceInfo>());
        // Official PSAPI EX layout: two DWORDs plus nine 64-bit SIZE_T fields.
        Assert.Equal(80, Marshal.SizeOf<WindowsNativeMemoryPressureReader.NativeProcessMemory>());
        Assert.Equal(8, Marshal.OffsetOf<WindowsNativeMemoryPressureReader.NativePerformanceInfo>("_commitTotal").ToInt32());
        Assert.Equal(80, Marshal.OffsetOf<WindowsNativeMemoryPressureReader.NativePerformanceInfo>("_pageSize").ToInt32());
        Assert.Equal(72, Marshal.OffsetOf<WindowsNativeMemoryPressureReader.NativeProcessMemory>("_privateUsage").ToInt32());
    }

    [Fact]
    public void CapturedRowClockDiscontinuityCannotHideInsideAValidOverallWindow()
    {
        var at = DateTimeOffset.UnixEpoch;
        var rows = FilledOutput();
        for (int index = 0; index < rows.Length; index++)
        {
            rows[index] = rows[index] with
            {
                SampledAt = at.AddMilliseconds(index),
                Timestamp = index,
                TimestampFrequency = 1000
            };
        }
        bool Valid() => WindowsNativeMemoryPressureReader.ValidObservationWindow(rows, at, at.AddSeconds(1), 0, 1000, 1000);
        Assert.True(Valid());
        rows[3] = rows[3] with
        {
            TimestampFrequency = 2000
        };
        Assert.False(Valid());
        rows[3] = rows[3] with
        {
            TimestampFrequency = 1000,
            Timestamp = 1
        };
        Assert.False(Valid());
        rows[3] = rows[3] with
        {
            Timestamp = 3,
            SampledAt = at.AddMilliseconds(1)
        };
        Assert.False(Valid());
        rows[3] = rows[3] with
        {
            SampledAt = at.AddSeconds(2)
        };
        Assert.False(Valid());
    }

    private static WindowsPressureObservation[] FilledOutput()
        => Enumerable.Range(0, 8).Select(index => new WindowsPressureObservation((WindowsPressureMetric)index,
            WindowsPressureApi.GlobalMemoryStatusEx, WindowsPressureScope.HostPhysical,
            MemoryObservationState.Available, 123, null, null, DateTimeOffset.UnixEpoch, 1, 1000)).ToArray();

    private sealed class ThrowingClock : TimeProvider
    {
        public int Captures
        {
            get; private set;
        }
        public override DateTimeOffset GetUtcNow()
        {
            Captures++;
            throw new InvalidOperationException("No clock capture is permitted in this control.");
        }
    }
}
