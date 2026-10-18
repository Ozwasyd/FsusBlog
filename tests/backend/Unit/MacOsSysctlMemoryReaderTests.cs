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
        var result = MacOsSysctlMemoryReader.Capture(clock, TimeSpan.FromSeconds(1), output, MemoryCapabilityMode.Disabled);
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
            var result = MacOsSysctlMemoryReader.Capture(clock, TimeSpan.FromSeconds(1), output);
            Assert.Equal(MemoryFailure.BoundsViolation, result.Failure);
            Assert.False(result.Captured);
            Assert.Equal(0, result.NativeCallAttempts);
            Assert.All(output, item => Assert.Null(item.Value));
        }
        MacOsSysctlMemoryObservation[] full = FilledOutput();
        var invalid = MacOsSysctlMemoryReader.Capture(clock, TimeSpan.FromSeconds(1), full, (MemoryCapabilityMode)999);
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
            var result = MacOsSysctlMemoryReader.Capture(clock, TimeSpan.FromSeconds(1), output, mode);
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

    [Theory]
    [InlineData(999)]
    [InlineData(1000)]
    public void SyntheticNativeReturnsRetainBytesAndPerReadClocksWithinInclusiveDuration(int completed)
    {
        var clock = new WindowClock();
        clock.Timestamps[3] = completed;
        clock.Utc[3] = DateTimeOffset.UnixEpoch.AddMilliseconds(completed);
        MacOsSysctlMemoryObservation[] output = [.. FilledOutput(), FilledOutput()[0]];
        var result = CaptureSynthetic(clock, output);
        Assert.True(result.Captured);
        Assert.Equal(2, result.NativeCallAttempts);
        Assert.Null(result.Failure);
        AssertValue(output[0], 17179869184);
        AssertValue(output[1], 8192);
        AssertValue(output[2], 6144);
        AssertValue(output[3], 2048);
        Assert.Equal(clock.Utc[1], output[0].SampledAt);
        Assert.Equal(100, output[0].Timestamp);
        Assert.All(output[1..4], item =>
        {
            Assert.Equal(clock.Utc[2], item.SampledAt);
            Assert.Equal(200, item.Timestamp);
        });
        Assert.All(output[..4], item => Assert.Equal(1000, item.TimestampFrequency));
        Assert.Equal(123, output[4].Value);
        Assert.Equal(12, clock.Calls);
        Assert.Equal(MemoryQualification.NotVerified, result.Qualification);
    }

    [Theory]
    [InlineData("utc-duration")]
    [InlineData("monotonic-duration")]
    [InlineData("utc-completion-backward")]
    [InlineData("monotonic-completion-backward")]
    [InlineData("utc-first-before-start")]
    [InlineData("monotonic-first-before-start")]
    [InlineData("utc-second-backward")]
    [InlineData("monotonic-second-backward")]
    [InlineData("utc-second-after-end")]
    [InlineData("monotonic-second-after-end")]
    [InlineData("first-frequency")]
    [InlineData("second-frequency")]
    [InlineData("final-frequency")]
    [InlineData("timestamp-overflow")]
    public void SyntheticNativeSuccessCannotSurviveInvalidCaptureOrIntermediateWindow(string fault)
    {
        var clock = InvalidWindow(fault);
        MacOsSysctlMemoryObservation[] output = [.. FilledOutput(), FilledOutput()[0]];
        var result = CaptureSynthetic(clock, output);
        Assert.True(result.Captured);
        Assert.Equal(2, result.NativeCallAttempts);
        Assert.All(output[..4], item =>
        {
            Assert.Equal(MemoryObservationState.Stale, item.State);
            Assert.Null(item.Value);
            Assert.Equal(MemoryQualification.NotVerified, item.Qualification);
        });
        Assert.Equal(123, output[4].Value);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public void InvalidInitialFrequencyPreventsSyntheticNativeReads(long frequency)
    {
        var clock = new WindowClock();
        clock.Frequencies[0] = frequency;
        var output = FilledOutput();
        var result = CaptureSynthetic(clock, output);
        Assert.False(result.Captured);
        Assert.Equal(0, result.NativeCallAttempts);
        Assert.Equal(MemoryFailure.BoundsViolation, result.Failure);
        Assert.All(output, item =>
        {
            Assert.Equal(MemoryObservationState.Malformed, item.State);
            Assert.Null(item.Value);
        });
        Assert.Equal(3, clock.Calls);
    }

    [Theory]
    [InlineData(-1000, 1000)]
    [InlineData(long.MinValue, long.MaxValue)]
    public void NegativeTimestampOriginAndLargeFrequencyDoNotInventClockDiscontinuity(long started, long frequency)
    {
        var clock = new WindowClock();
        clock.Timestamps[0] = started;
        clock.Timestamps[1] = started + frequency / 4;
        clock.Timestamps[2] = started + frequency / 2;
        clock.Timestamps[3] = started + frequency;
        Array.Fill(clock.Frequencies, frequency);
        var output = FilledOutput();
        var capture = CaptureSynthetic(clock, output);
        Assert.True(capture.Captured);
        Assert.All(output, item => Assert.Equal(MemoryObservationState.Available, item.State));
    }

    [Theory]
    [InlineData(1)]
    [InlineData(13)]
    [InlineData(2)]
    [InlineData(45)]
    [InlineData(78)]
    [InlineData(84)]
    [InlineData(5)]
    public void InvalidTimingPreservesSyntheticNativeErrorAndAvailabilityEvidence(int error)
    {
        foreach (bool physicalFails in new[] { false, true })
        {
            var output = FilledOutput();
            var result = CaptureSynthetic(InvalidWindow("monotonic-duration"), output,
                physicalFails ? error : 0, physicalFails ? 0 : error);
            Assert.Equal(2, result.NativeCallAttempts);
            int failedRow = physicalFails ? 0 : 1;
            Assert.Equal(error, output[failedRow].NativeError);
            Assert.Equal(error is 1 or 13 ? MemoryObservationState.Denied
                : error == 84 ? MemoryObservationState.Malformed : MemoryObservationState.Unknown, output[failedRow].State);
            Assert.Equal(error is 2 or 45 or 78 ? MemoryFailure.UnsupportedCapability
                : MemoryFailure.TierUnavailable, output[failedRow].Failure);
            Assert.Equal(MemoryObservationState.Stale, output[physicalFails ? 1 : 0].State);
            Assert.All(output, item => Assert.Null(item.Value));
        }
    }

    [Theory]
    [InlineData("utc", 0)]
    [InlineData("utc", 1)]
    [InlineData("utc", 2)]
    [InlineData("utc", 3)]
    [InlineData("timestamp", 0)]
    [InlineData("timestamp", 1)]
    [InlineData("timestamp", 2)]
    [InlineData("timestamp", 3)]
    [InlineData("frequency", 0)]
    [InlineData("frequency", 1)]
    [InlineData("frequency", 2)]
    [InlineData("frequency", 3)]
    [InlineData("physical", 0)]
    [InlineData("swap", 0)]
    public void ClockOrSyntheticNativeExceptionClearsOnlyAdmittedPrefix(string phase, int position)
    {
        var clock = new WindowClock { ThrowPhase = phase, ThrowPosition = position };
        MacOsSysctlMemoryObservation[] output = [.. FilledOutput(), FilledOutput()[0]];
        var error = Assert.Throws<InvalidOperationException>(() => CaptureSynthetic(clock, output,
            throwPhysical: phase == "physical", throwSwap: phase == "swap"));
        Assert.Equal("synthetic-capture-failure", error.Message);
        Assert.All(output[..4], item => Assert.Equal(default, item));
        Assert.Equal(123, output[4].Value);
    }

    [Fact]
    public void InvalidDurationOrNullClockClearsOldFactsBeforePlatformProbe()
    {
        var clock = new ThrowingClock();
        foreach (TimeSpan duration in new[] { TimeSpan.Zero, TimeSpan.FromTicks(-1) })
        {
            MacOsSysctlMemoryObservation[] output = [.. FilledOutput(), FilledOutput()[0]];
            var result = MacOsSysctlMemoryReader.Capture(clock, duration, output);
            Assert.Equal(MemoryFailure.BoundsViolation, result.Failure);
            Assert.False(result.Captured);
            Assert.Equal(0, result.NativeCallAttempts);
            Assert.All(output[..4], item => Assert.Equal(default, item));
            Assert.Equal(123, output[4].Value);
        }
        var rows = FilledOutput();
        Assert.Throws<ArgumentNullException>(() => MacOsSysctlMemoryReader.Capture(null!, TimeSpan.FromSeconds(1), rows));
        Assert.All(rows, item => Assert.Equal(default, item));
        Assert.Equal(0, clock.Captures);
    }

    [Fact]
    public void FinalFrequencyOverflowExceptionClearsFactsInsteadOfBecomingElapsedOverflow()
    {
        var clock = new WindowClock { ThrowPhase = "frequency", ThrowPosition = 3, ThrowOverflow = true };
        MacOsSysctlMemoryObservation[] output = [.. FilledOutput(), FilledOutput()[0]];
        Assert.Throws<OverflowException>(() => CaptureSynthetic(clock, output));
        Assert.All(output[..4], item => Assert.Equal(default, item));
        Assert.Equal(123, output[4].Value);
    }

    private static WindowClock InvalidWindow(string fault)
    {
        var clock = new WindowClock();
        switch (fault)
        {
            case "utc-duration":
                clock.Utc[3] = DateTimeOffset.UnixEpoch.AddTicks(TimeSpan.TicksPerSecond + 1);
                break;
            case "monotonic-duration":
                clock.Timestamps[3] = 1001;
                break;
            case "utc-completion-backward":
                clock.Utc[3] = DateTimeOffset.UnixEpoch.AddTicks(-1);
                break;
            case "monotonic-completion-backward":
                clock.Timestamps[3] = -1;
                break;
            case "utc-first-before-start":
                clock.Utc[1] = DateTimeOffset.UnixEpoch.AddTicks(-1);
                break;
            case "monotonic-first-before-start":
                clock.Timestamps[1] = -1;
                break;
            case "utc-second-backward":
                clock.Utc[2] = clock.Utc[1].AddTicks(-1);
                break;
            case "monotonic-second-backward":
                clock.Timestamps[2] = 99;
                break;
            case "utc-second-after-end":
                clock.Utc[2] = clock.Utc[3].AddTicks(1);
                break;
            case "monotonic-second-after-end":
                clock.Timestamps[2] = 1001;
                break;
            case "first-frequency":
                clock.Frequencies[1] = 2000;
                break;
            case "second-frequency":
                clock.Frequencies[2] = 2000;
                break;
            case "final-frequency":
                clock.Frequencies[3] = 2000;
                break;
            case "timestamp-overflow":
                clock.Timestamps[0] = long.MinValue;
                clock.Timestamps[1] = long.MinValue + 1;
                clock.Timestamps[2] = long.MinValue + 2;
                clock.Timestamps[3] = long.MaxValue;
                break;
            default:
                throw new ArgumentException("Unknown clock fault.", nameof(fault));
        }
        return clock;
    }

    private static MacOsSysctlMemoryCapture CaptureSynthetic(WindowClock clock, MacOsSysctlMemoryObservation[] output,
        int physicalError = 0, int swapError = 0, bool throwPhysical = false, bool throwSwap = false)
    {
        return MacOsSysctlMemoryReader.CaptureTimed(clock, TimeSpan.FromSeconds(1), output.AsSpan(0, 4),
            MemoryCapabilityMode.Auto, new SyntheticNativeReader(physicalError, swapError, throwPhysical, throwSwap));
    }

    private readonly struct SyntheticNativeReader(int physicalError, int swapError, bool throwPhysical, bool throwSwap)
        : MacOsSysctlMemoryReader.INativeReader
    {
        public void ReadPhysical(Span<MacOsSysctlMemoryObservation> rows, ref int attempts)
        {
            attempts++;
            if (throwPhysical)
            {
                throw new InvalidOperationException("synthetic-capture-failure");
            }
            MacOsSysctlMemoryReader.MapPhysical(rows, physicalError == 0 ? 0 : -1, physicalError, 8, 17179869184);
        }
        public void ReadSwap(Span<MacOsSysctlMemoryObservation> rows, ref int attempts)
        {
            attempts++;
            if (throwSwap)
            {
                throw new InvalidOperationException("synthetic-capture-failure");
            }
            MacOsSysctlMemoryReader.MapSwap(rows, swapError == 0 ? 0 : -1, swapError, 32,
                new()
                {
                    _total = 8192,
                    _available = 6144,
                    _used = 2048,
                    _pageSize = 4096,
                    _encrypted = 1
                });
        }
    }

    private sealed class WindowClock : TimeProvider
    {
        private int _utcIndex;
        private int _timestampIndex;
        private int _frequencyIndex;
        public DateTimeOffset[] Utc
        {
            get;
        } =
            [DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch.AddMilliseconds(100),
                DateTimeOffset.UnixEpoch.AddMilliseconds(200), DateTimeOffset.UnixEpoch.AddSeconds(1)];
        public long[] Timestamps { get; } = [0, 100, 200, 1000];
        public long[] Frequencies { get; } = [1000, 1000, 1000, 1000];
        public string? ThrowPhase
        {
            get; init;
        }
        public int ThrowPosition
        {
            get; init;
        }
        public bool ThrowOverflow
        {
            get; init;
        }
        public int Calls
        {
            get; private set;
        }
        public override DateTimeOffset GetUtcNow() => Utc[Next("utc", ref _utcIndex)];
        public override long GetTimestamp() => Timestamps[Next("timestamp", ref _timestampIndex)];
        public override long TimestampFrequency => Frequencies[Next("frequency", ref _frequencyIndex)];

        private int Next(string phase, ref int index)
        {
            Calls++;
            if (ThrowPhase == phase && ThrowPosition == index)
            {
                if (ThrowOverflow)
                {
                    throw new OverflowException("synthetic-capture-failure");
                }
                throw new InvalidOperationException("synthetic-capture-failure");
            }
            return index++;
        }
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
        public override long GetTimestamp()
        {
            Captures++;
            throw new InvalidOperationException("This refusal control permits no clock capture.");
        }
        public override long TimestampFrequency => throw new InvalidOperationException("This refusal control permits no clock capture.");
    }
}
