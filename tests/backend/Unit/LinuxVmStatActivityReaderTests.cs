using System.Text.Json;

using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Platform;

using Xunit.Abstractions;

namespace FsusBlog.Server.Tests.Unit;

public sealed class LinuxVmStatActivityReaderTests
{
    private readonly ITestOutputHelper _output;

    public LinuxVmStatActivityReaderTests(ITestOutputHelper output)
    {
        _output = output;
    }

    [Fact]
    public void ActualHostActivityUsesTheObservedPageSizeAndItsOwnBoundedClockWindow()
    {
        Assert.True(OperatingSystem.IsLinux());
        byte[] scratch = new byte[65538];
        string? source = null;
        for (int attempt = 0; attempt < 3; attempt++)
        {
            Array.Fill(scratch, (byte)0xcc);
            DateTimeOffset outerStartedAt = TimeProvider.System.GetUtcNow();
            long outerStarted = TimeProvider.System.GetTimestamp();
            LinuxVmStatActivityCapture actual = LinuxVmStatActivityReader.Capture(
                TimeProvider.System, 65536, TimeSpan.FromSeconds(1), scratch);
            long outerCompleted = TimeProvider.System.GetTimestamp();
            DateTimeOffset outerCompletedAt = TimeProvider.System.GetUtcNow();
            Assert.True(actual.Captured);
            Assert.Null(actual.Failure);
            Assert.Equal(MemoryObservationState.Available, actual.State);
            Assert.Equal(MemoryObservationState.Available, actual.Activity.SwapInPages.State);
            Assert.Equal(MemoryObservationState.Available, actual.Activity.SwapOutPages.State);
            Assert.Equal(MemoryObservationState.Available, actual.Activity.MajorFaultEvents.State);
            Assert.True(actual.Activity.MajorFaultEvents.Value >= 0);
            Assert.Equal((long)Environment.SystemPageSize, actual.PageSizeBytes);
            Assert.Equal(checked(actual.Activity.SwapInPages.Value * actual.PageSizeBytes), actual.SwapBytes.SwapInBytes.Value);
            Assert.Equal(checked(actual.Activity.SwapOutPages.Value * actual.PageSizeBytes), actual.SwapBytes.SwapOutBytes.Value);
            Assert.InRange(actual.StartedAt!.Value, outerStartedAt, outerCompletedAt);
            Assert.InRange(actual.CompletedAt!.Value, actual.StartedAt.Value, outerCompletedAt);
            Assert.InRange(actual.Timestamp!.Value, outerStarted, outerCompleted);
            Assert.InRange(actual.CompletedTimestamp!.Value, actual.Timestamp.Value, outerCompleted);
            Assert.Equal(TimeProvider.System.TimestampFrequency, actual.TimestampFrequency);
            source ??= actual.Source;
            Assert.Equal(source, actual.Source);
            Assert.Contains("Linux.procfs.vmstat.host;", actual.Source, StringComparison.Ordinal);
            Assert.Equal(MemoryQualification.NotVerified, actual.Qualification);
            Assert.All(scratch, value => Assert.Equal((byte)0, value));
            _output.WriteLine(JsonSerializer.Serialize(new
            {
                Attempt = attempt,
                Capture = actual,
                HostDomainQualified = false,
                AnonymousSwapThrashingClassified = false
            }));
        }
    }

    [Fact]
    public void AnOverflowByteRefusesTruncatedContentAndReleasesScratch()
    {
        byte[] scratch = [0xcc, 0xcc, 0xcc];
        LinuxVmStatActivityCapture actual = LinuxVmStatActivityReader.Capture(
            TimeProvider.System, 1, TimeSpan.FromSeconds(1), scratch);
        Assert.True(actual.Captured);
        Assert.Equal(MemoryObservationState.Malformed, actual.State);
        Assert.Equal(MemoryObservationState.Malformed, actual.Activity.SwapInPages.State);
        Assert.Equal(MemoryObservationState.Malformed, actual.Activity.SwapOutPages.State);
        Assert.Equal(MemoryObservationState.Malformed, actual.Activity.MajorFaultEvents.State);
        Assert.Null(actual.Activity.SwapInPages.Value);
        Assert.Null(actual.Activity.SwapOutPages.Value);
        Assert.Null(actual.Activity.MajorFaultEvents.Value);
        Assert.Null(actual.SwapBytes.SwapInBytes.Value);
        Assert.Null(actual.SwapBytes.SwapOutBytes.Value);
        Assert.All(scratch, value => Assert.Equal((byte)0, value));
    }

    [Theory]
    [InlineData(MemoryCapabilityMode.Disabled, 1, 1, 2, MemoryObservationState.Unknown)]
    [InlineData(MemoryCapabilityMode.Auto, 0, 1, 2, MemoryObservationState.Malformed)]
    [InlineData(MemoryCapabilityMode.Auto, int.MaxValue, 1, 2, MemoryObservationState.Malformed)]
    [InlineData(MemoryCapabilityMode.Auto, 1, 0, 2, MemoryObservationState.Malformed)]
    [InlineData(MemoryCapabilityMode.Auto, 1, -1, 2, MemoryObservationState.Malformed)]
    [InlineData(MemoryCapabilityMode.Auto, 1, 1, 1, MemoryObservationState.Malformed)]
    [InlineData((MemoryCapabilityMode)999, 1, 1, 2, MemoryObservationState.Malformed)]
    public void DisabledAndInvalidInputsDoNotCaptureTimeOrAFile(MemoryCapabilityMode mode,
        int maximumBytes, int durationSeconds, int scratchBytes, MemoryObservationState expected)
    {
        byte[] scratch = new byte[scratchBytes];
        Array.Fill(scratch, (byte)0xcc);
        LinuxVmStatActivityCapture actual = LinuxVmStatActivityReader.Capture(
            new ThrowingClock(), maximumBytes, TimeSpan.FromSeconds(durationSeconds), scratch, mode);
        Assert.False(actual.Captured);
        Assert.Equal(expected, actual.State);
        Assert.Equal(expected, actual.Activity.SwapInPages.State);
        Assert.Equal(expected, actual.Activity.SwapOutPages.State);
        Assert.Equal(expected, actual.Activity.MajorFaultEvents.State);
        Assert.Null(actual.Activity.SwapInPages.Value);
        Assert.Null(actual.Activity.SwapOutPages.Value);
        Assert.Null(actual.Activity.MajorFaultEvents.Value);
        Assert.Null(actual.PageSizeBytes);
        Assert.Null(actual.StartedAt);
        Assert.Null(actual.Timestamp);
        Assert.Equal(MemoryQualification.NotVerified, actual.Qualification);
        Assert.All(scratch, value => Assert.Equal((byte)0, value));
    }

    [Fact]
    public void APreReadClockExceptionRemainsVisibleAndClearsCallerScratch()
    {
        byte[] scratch = new byte[2];
        Array.Fill(scratch, (byte)0xcc);
        Assert.Throws<InvalidOperationException>(() => LinuxVmStatActivityReader.Capture(
            new ThrowingClock(), 1, TimeSpan.FromSeconds(1), scratch));
        Assert.All(scratch, value => Assert.Equal((byte)0, value));
    }

    private sealed class ThrowingClock : TimeProvider
    {
        public override long TimestampFrequency => throw new InvalidOperationException("Clock was accessed.");
    }
}
