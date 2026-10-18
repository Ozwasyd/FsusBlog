using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Platform;
using FsusBlog.Server.Infrastructure.Memory.Pressure;
using FsusBlog.Server.Tests.Helpers;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PlatformMemoryPressureCompositionTests
{
    [Theory]
    [InlineData(MemoryCapabilityMode.Auto)]
    [InlineData(MemoryCapabilityMode.Required)]
    public void ActualLinuxCallerRetainsUnsupportedRawRowsWithoutNativeOrClockCalls(MemoryCapabilityMode mode)
    {
        Assert.True(OperatingSystem.IsLinux());
        var clock = new RejectingClock();
        PortableMemoryPressureSource source = Create(clock);
        var macOs = new MacOsSysctlMemoryObservation[MacOsSysctlMemoryReader.ObservationCount];
        var windowsJob = new WindowsJobMemoryObservation[WindowsCurrentJobMemoryReader.ObservationCount];

        var capture = source.CapturePlatformObservations(macOs, windowsJob, TimeSpan.FromSeconds(1), mode);

        Assert.Equal(mode, capture.MacOs.Mode);
        Assert.Equal(mode, capture.WindowsJob.Mode);
        Assert.False(capture.MacOs.Captured);
        Assert.False(capture.WindowsJob.Captured);
        Assert.Equal(MemoryFailure.UnsupportedCapability, capture.MacOs.Failure);
        Assert.Equal(MemoryFailure.UnsupportedCapability, capture.WindowsJob.Failure);
        Assert.Equal(0, capture.MacOs.NativeCallAttempts);
        Assert.Equal(0, capture.WindowsJob.NativeCallAttempts);
        Assert.Equal(0, clock.Calls);
        Assert.All(macOs, item =>
        {
            Assert.Equal(MemoryObservationState.Unknown, item.State);
            Assert.Null(item.Value);
            Assert.Null(item.SampledAt);
            Assert.Equal(MemoryQualification.NotVerified, item.Qualification);
        });
        Assert.All(windowsJob, item =>
        {
            Assert.Equal(MemoryObservationState.Unknown, item.State);
            Assert.Null(item.Value);
            Assert.Null(item.ObservedAt);
            Assert.Null(item.Timestamp);
            Assert.Equal(MemoryQualification.NotVerified, item.Qualification);
        });
        Assert.Equal(MacOsMemoryScope.HostPhysical, macOs[0].Scope);
        Assert.Equal(MacOsMemoryMetric.HostPhysicalTotalBytes, macOs[0].Metric);
        Assert.Equal(MacOsMemoryMetric.HostSwapUsedBytes, macOs[3].Metric);
        Assert.Equal(MacOsMemoryScope.HostSwap, macOs[3].Scope);
        Assert.Equal(WindowsJobMemoryMetric.NotificationJobCommitBytes, windowsJob[4].Metric);
        Assert.Equal(WindowsJobInformationClass.LimitViolation, windowsJob[4].InformationClass);
        Assert.Equal(WindowsJobMemoryScope.ImmediateJob, windowsJob[4].Scope);
        Assert.Empty(source.Trace());
    }

    [Fact]
    public void DisabledClearsOldFactsThroughBothReadersAndLeavesCallerTailsAlone()
    {
        var clock = new RejectingClock();
        PortableMemoryPressureSource source = Create(clock);
        var macOs = new MacOsSysctlMemoryObservation[MacOsSysctlMemoryReader.ObservationCount + 1];
        var windowsJob = new WindowsJobMemoryObservation[WindowsCurrentJobMemoryReader.ObservationCount + 1];
        Array.Fill(macOs, new()
        {
            State = MemoryObservationState.Available,
            Value = 123
        });
        Array.Fill(windowsJob, new()
        {
            State = MemoryObservationState.Available,
            Value = 123
        });

        var capture = source.CapturePlatformObservations(macOs, windowsJob, TimeSpan.FromSeconds(1), MemoryCapabilityMode.Disabled);

        Assert.False(capture.MacOs.Captured);
        Assert.False(capture.WindowsJob.Captured);
        Assert.Null(capture.MacOs.Failure);
        Assert.Null(capture.WindowsJob.Failure);
        Assert.Equal(0, capture.MacOs.NativeCallAttempts);
        Assert.Equal(0, capture.WindowsJob.NativeCallAttempts);
        Assert.Equal(0, clock.Calls);
        Assert.All(macOs[..^1], item => Assert.Null(item.Value));
        Assert.All(windowsJob[..^1], item => Assert.Null(item.Value));
        Assert.Equal(123, macOs[^1].Value);
        Assert.Equal(123, windowsJob[^1].Value);
        Assert.Empty(source.Trace());
    }

    [Fact]
    public void InvalidAdmissionShapeOrPolicyClearsBothOwnedPrefixesBeforeAnyProbe()
    {
        var clock = new RejectingClock();
        PortableMemoryPressureSource source = Create(clock);
        foreach (var input in new[]
        {
            (MacOsLength: 3, WindowsLength: 6, Duration: TimeSpan.FromSeconds(1), Mode: MemoryCapabilityMode.Auto),
            (MacOsLength: 4, WindowsLength: 5, Duration: TimeSpan.FromSeconds(1), Mode: MemoryCapabilityMode.Auto),
            (MacOsLength: 4, WindowsLength: 6, Duration: TimeSpan.Zero, Mode: MemoryCapabilityMode.Auto),
            (MacOsLength: 4, WindowsLength: 6, Duration: TimeSpan.FromSeconds(1), Mode: (MemoryCapabilityMode)99)
        })
        {
            var macOs = new MacOsSysctlMemoryObservation[5];
            var windowsJob = new WindowsJobMemoryObservation[7];
            Array.Fill(macOs, new()
            {
                State = MemoryObservationState.Available,
                Value = 123
            });
            Array.Fill(windowsJob, new()
            {
                State = MemoryObservationState.Available,
                Value = 123
            });
            Assert.ThrowsAny<ArgumentException>(() => source.CapturePlatformObservations(
                macOs.AsSpan(0, input.MacOsLength), windowsJob.AsSpan(0, input.WindowsLength), input.Duration, input.Mode));
            Assert.All(macOs[..input.MacOsLength], item => Assert.Null(item.Value));
            Assert.All(windowsJob[..input.WindowsLength], item => Assert.Null(item.Value));
            Assert.Equal(123, macOs[^1].Value);
            Assert.Equal(123, windowsJob[^1].Value);
        }
        Assert.Equal(0, clock.Calls);
        Assert.Empty(source.Trace());
    }

    [Fact]
    public void OmittedModeIsAutoAndRawRowsCannotEnterComparablePortableHistory()
    {
        Assert.True(OperatingSystem.IsLinux());
        PortableMemoryPressureSource source = Create(TimeProvider.System);
        var macOs = new MacOsSysctlMemoryObservation[MacOsSysctlMemoryReader.ObservationCount];
        var windowsJob = new WindowsJobMemoryObservation[WindowsCurrentJobMemoryReader.ObservationCount];
        for (int iteration = 0; iteration < 2; iteration++)
        {
            var capture = source.CapturePlatformObservations(macOs, windowsJob, TimeSpan.FromSeconds(1));
            Assert.Equal(MemoryCapabilityMode.Auto, capture.MacOs.Mode);
            Assert.Equal(MemoryCapabilityMode.Auto, capture.WindowsJob.Mode);
            Assert.Equal(MemoryQualification.NotVerified, capture.MacOs.Qualification);
            Assert.Equal(MemoryQualification.NotVerified, capture.WindowsJob.Qualification);
        }
        Assert.Empty(source.Trace());
        MemoryPressureSample portable = source.Capture();
        Assert.Single(source.Trace());
        Assert.Equal(7, portable.Observations.Count);
        Assert.DoesNotContain(portable.Observations, item => item.Source.Contains("sysctlbyname", StringComparison.Ordinal)
            || item.Source.Contains("QueryInformationJobObject", StringComparison.Ordinal));
    }

    private static PortableMemoryPressureSource Create(TimeProvider clock)
    {
        var (ledger, host, _) = TransientMemoryTestLedger.Create(64);
        return new(ledger, new(Guid.NewGuid()), host, [], clock, traceCapacity: 2);
    }

    private sealed class RejectingClock : TimeProvider
    {
        public int Calls
        {
            get; private set;
        }
        public override DateTimeOffset GetUtcNow()
        {
            Calls++;
            throw new InvalidOperationException("No native capture should request time on this control.");
        }
        public override long GetTimestamp()
        {
            Calls++;
            throw new InvalidOperationException("No native capture should request time on this control.");
        }
    }
}
