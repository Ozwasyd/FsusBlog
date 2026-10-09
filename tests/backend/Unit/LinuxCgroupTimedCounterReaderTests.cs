using System.Text.Json;

using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Platform;
using FsusBlog.Server.Infrastructure.Memory.Pressure;

using Xunit.Abstractions;

namespace FsusBlog.Server.Tests.Unit;

public sealed class LinuxCgroupTimedCounterReaderTests
{
    private readonly ITestOutputHelper _output;

    public LinuxCgroupTimedCounterReaderTests(ITestOutputHelper output)
    {
        _output = output;
    }

    [Theory]
    [InlineData(LinuxCgroupCounter.AnonymousBytes)]
    [InlineData(LinuxCgroupCounter.FileBytes)]
    [InlineData(LinuxCgroupCounter.MajorFaults)]
    [InlineData(LinuxCgroupCounter.LocalHighEvents)]
    [InlineData(LinuxCgroupCounter.LocalMaxEvents)]
    [InlineData(LinuxCgroupCounter.LocalOutOfMemoryEvents)]
    [InlineData(LinuxCgroupCounter.LocalOutOfMemoryKillEvents)]
    [InlineData(LinuxCgroupCounter.PressureSomeMicroseconds)]
    [InlineData(LinuxCgroupCounter.PressureFullMicroseconds)]
    public void NativeReadUsesItsOwnWindowAndPreservesUnavailableFields(LinuxCgroupCounter counter)
    {
        using LinuxCgroupDirectoryReader reader = OpenReader(out string path);
        byte[] scratch = new byte[8192];
        Array.Fill(scratch, (byte)0xcc);
        var clock = new WindowClock();
        LinuxCgroupTimedCounterCapture actual = LinuxCgroupTimedCounterReader.Capture(
            reader, counter, clock, TimeSpan.FromSeconds(1), scratch);
        MemoryObservationState nativeState = ProbeAvailability(path + "/" + LinuxCgroupCounterParser.FileName(counter));
        Assert.Equal(nativeState, actual.State);
        Assert.Equal(counter, actual.Counter);
        Assert.Equal(LinuxCgroupCounterParser.Unit(counter), actual.Unit);
        Assert.Equal(reader.Identity, actual.Identity);
        Assert.True(actual.Captured);
        Assert.Null(actual.Failure);
        Assert.Equal(DateTimeOffset.UnixEpoch, actual.StartedAt);
        Assert.Equal(DateTimeOffset.UnixEpoch.AddMilliseconds(1), actual.CompletedAt);
        Assert.Equal(100L, actual.Timestamp);
        Assert.Equal(101L, actual.CompletedTimestamp);
        Assert.Equal(1000L, actual.TimestampFrequency);
        Assert.Equal(MemoryQualification.NotVerified, actual.Qualification);
        Assert.Contains("Linux.cgroup.counter;pid=", actual.Source, StringComparison.Ordinal);
        Assert.Contains(";instance=", actual.Source, StringComparison.Ordinal);
        if (nativeState == MemoryObservationState.Available)
        {
            Assert.True(actual.Value >= 0);
        }
        else
        {
            Assert.Null(actual.Value);
        }
        Assert.All(scratch, value => Assert.Equal((byte)0, value));
        _output.WriteLine(JsonSerializer.Serialize(new { Path = path, NativeState = nativeState, Capture = actual }));
    }

    [Theory]
    [InlineData(100L, 99L, 1000L, 1000L, 1, 1000, MemoryObservationState.Stale)]
    [InlineData(long.MinValue, long.MaxValue, 1000L, 1000L, 1, 1000, MemoryObservationState.Stale)]
    [InlineData(100L, 101L, 1000L, 2000L, 1, 1000, MemoryObservationState.Stale)]
    [InlineData(100L, 101L, 1000L, 1000L, -1, 1000, MemoryObservationState.Stale)]
    [InlineData(100L, 101L, 1000L, 1000L, 1001, 1000, MemoryObservationState.Stale)]
    [InlineData(100L, 1101L, 1000L, 1000L, 1, 1000, MemoryObservationState.Stale)]
    [InlineData(100L, 1100L, 1000L, 1000L, 1000, 1000, MemoryObservationState.Available)]
    [InlineData(100L, 100L, 1000L, 1000L, 0, 1000, MemoryObservationState.Available)]
    public void ClockFaultsRemoveValuesWithoutFabricatingAZeroOrPointTimestamp(long start, long end,
        long frequency, long finalFrequency, int utcMilliseconds, int durationMilliseconds,
        MemoryObservationState expected)
    {
        using LinuxCgroupDirectoryReader reader = OpenReader(out _);
        byte[] scratch = new byte[4097];
        var clock = new WindowClock(start, end, frequency, finalFrequency, utcMilliseconds);
        LinuxCgroupTimedCounterCapture actual = LinuxCgroupTimedCounterReader.Capture(
            reader, LinuxCgroupCounter.AnonymousBytes, clock, TimeSpan.FromMilliseconds(durationMilliseconds), scratch);
        Assert.Equal(expected, actual.State);
        Assert.True(actual.Captured);
        Assert.Equal(start, actual.Timestamp);
        Assert.Equal(end, actual.CompletedTimestamp);
        if (expected == MemoryObservationState.Stale)
        {
            Assert.Null(actual.Value);
        }
        else
        {
            Assert.True(actual.Value >= 0);
        }
        Assert.Equal(MemoryQualification.NotVerified, actual.Qualification);
        Assert.All(scratch, value => Assert.Equal((byte)0, value));
    }

    [Theory]
    [InlineData(MemoryCapabilityMode.Disabled, 1, 1000L, MemoryObservationState.Unknown)]
    [InlineData((MemoryCapabilityMode)999, 1, 1000L, MemoryObservationState.Malformed)]
    [InlineData(MemoryCapabilityMode.Auto, 0, 1000L, MemoryObservationState.Malformed)]
    [InlineData(MemoryCapabilityMode.Required, -1, 1000L, MemoryObservationState.Malformed)]
    [InlineData(MemoryCapabilityMode.Auto, 1, 0L, MemoryObservationState.Malformed)]
    [InlineData(MemoryCapabilityMode.Auto, 1, -1L, MemoryObservationState.Malformed)]
    public void DisabledAndInvalidBoundsDoNotUseTheDisposedReaderOrCaptureTime(
        MemoryCapabilityMode mode, int durationSeconds, long frequency, MemoryObservationState expected)
    {
        using LinuxCgroupDirectoryReader reader = OpenReader(out _);
        reader.Dispose();
        byte[] scratch = new byte[4097];
        Array.Fill(scratch, (byte)0xcc);
        var clock = new WindowClock(frequency: frequency);
        LinuxCgroupTimedCounterCapture actual = LinuxCgroupTimedCounterReader.Capture(
            reader, LinuxCgroupCounter.AnonymousBytes, clock, TimeSpan.FromSeconds(durationSeconds), scratch, mode);
        Assert.Equal(expected, actual.State);
        Assert.False(actual.Captured);
        Assert.Null(actual.Value);
        Assert.Null(actual.StartedAt);
        Assert.Null(actual.CompletedAt);
        Assert.Null(actual.Timestamp);
        Assert.Null(actual.CompletedTimestamp);
        Assert.Null(actual.TimestampFrequency);
        Assert.Equal(0, clock.UtcReads);
        Assert.Equal(0, clock.TickReads);
        Assert.All(scratch, value => Assert.Equal((byte)0, value));
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    public void ClockExceptionsClearScratchAndDoNotDisposeTheBorrowedOwner(int throwAtTick)
    {
        using LinuxCgroupDirectoryReader reader = OpenReader(out _);
        byte[] scratch = new byte[8192];
        Array.Fill(scratch, (byte)0xcc);
        var clock = new WindowClock(throwAtTick: throwAtTick);
        Assert.Throws<InvalidOperationException>(() => LinuxCgroupTimedCounterReader.Capture(
            reader, LinuxCgroupCounter.AnonymousBytes, clock, TimeSpan.FromSeconds(1), scratch));
        Assert.All(scratch, value => Assert.Equal((byte)0, value));
        Assert.Equal(MemoryObservationState.Available, reader.CaptureCounter(LinuxCgroupCounter.AnonymousBytes, scratch).State);
    }

    [Fact]
    public void InvalidScratchAndDisposedOwnersKeepTheirErrorsAndClearTheSuppliedSpan()
    {
        using LinuxCgroupDirectoryReader reader = OpenReader(out _);
        byte[] scratch = new byte[4096];
        Array.Fill(scratch, (byte)0xcc);
        Assert.Throws<ArgumentException>(() => LinuxCgroupTimedCounterReader.Capture(
            reader, LinuxCgroupCounter.AnonymousBytes, new WindowClock(), TimeSpan.FromSeconds(1), scratch));
        Assert.All(scratch, value => Assert.Equal((byte)0, value));
        reader.Dispose();
        scratch = new byte[8192];
        Array.Fill(scratch, (byte)0xcc);
        Assert.Throws<ObjectDisposedException>(() => LinuxCgroupTimedCounterReader.Capture(
            reader, LinuxCgroupCounter.AnonymousBytes, new WindowClock(), TimeSpan.FromSeconds(1), scratch));
        Assert.All(scratch, value => Assert.Equal((byte)0, value));
    }

    private static LinuxCgroupDirectoryReader OpenReader(out string path)
    {
        Assert.True(OperatingSystem.IsLinux());
        string line = Assert.Single(File.ReadAllLines("/proc/self/mountinfo"),
            item => item.Contains(" - cgroup2 ", StringComparison.Ordinal));
        path = line.Split(' ')[4].Replace("\\040", " ", StringComparison.Ordinal)
            .Replace("\\011", "\t", StringComparison.Ordinal).Replace("\\012", "\n", StringComparison.Ordinal)
            .Replace("\\134", "\\", StringComparison.Ordinal);
        var inspected = LinuxCgroupDirectoryReader.TryInspectDirectory(path, 2);
        Assert.True(inspected.Succeeded);
        var opened = LinuxCgroupDirectoryReader.TryOpenObservedDirectory(path, inspected.Value!, 4096);
        Assert.True(opened.Succeeded);
        return opened.Value!;
    }

    private static MemoryObservationState ProbeAvailability(string path)
    {
        try
        {
            using FileStream stream = File.OpenRead(path);
            return MemoryObservationState.Available;
        }
        catch (UnauthorizedAccessException)
        {
            return MemoryObservationState.Denied;
        }
        catch (FileNotFoundException)
        {
            return MemoryObservationState.Unknown;
        }
        catch (DirectoryNotFoundException)
        {
            return MemoryObservationState.Unknown;
        }
    }

    private sealed class WindowClock : TimeProvider
    {
        private readonly long _start;
        private readonly long _end;
        private readonly long _frequency;
        private readonly long _finalFrequency;
        private readonly int _utcMilliseconds;
        private readonly int _throwAtTick;
        private int _frequencyReads;
        private int _utcReads;
        private int _tickReads;

        public WindowClock(long start = 100, long end = 101, long frequency = 1000,
            long finalFrequency = 1000, int utcMilliseconds = 1, int throwAtTick = 0)
        {
            _start = start;
            _end = end;
            _frequency = frequency;
            _finalFrequency = finalFrequency;
            _utcMilliseconds = utcMilliseconds;
            _throwAtTick = throwAtTick;
        }

        public int UtcReads => _utcReads;
        public int TickReads => _tickReads;
        public override long TimestampFrequency => ++_frequencyReads == 1 ? _frequency : _finalFrequency;

        public override DateTimeOffset GetUtcNow()
            => ++_utcReads == 1 ? DateTimeOffset.UnixEpoch : DateTimeOffset.UnixEpoch.AddMilliseconds(_utcMilliseconds);

        public override long GetTimestamp()
        {
            _tickReads++;
            if (_tickReads == _throwAtTick)
            {
                throw new InvalidOperationException("Clock capture failed.");
            }
            return _tickReads == 1 ? _start : _end;
        }
    }
}
