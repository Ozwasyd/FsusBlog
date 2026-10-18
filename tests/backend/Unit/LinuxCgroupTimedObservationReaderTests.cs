using System.Reflection;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Platform;
using FsusBlog.Server.Infrastructure.Memory.Pressure;

using Microsoft.Win32.SafeHandles;

using Xunit.Abstractions;

namespace FsusBlog.Server.Tests.Unit;

public sealed class LinuxCgroupTimedObservationReaderTests
{
    private readonly ITestOutputHelper _output;

    public LinuxCgroupTimedObservationReaderTests(ITestOutputHelper output)
    {
        _output = output;
    }

    [Theory]
    [InlineData(LinuxCgroupScalar.UsageBytes)]
    [InlineData(LinuxCgroupScalar.HighBytes)]
    [InlineData(LinuxCgroupScalar.HardLimitBytes)]
    [InlineData(LinuxCgroupScalar.SwapUsageBytes)]
    [InlineData(LinuxCgroupScalar.SwapLimitBytes)]
    public void AllowedNativeScalarsKeepTheirActualIdentityValueAndUnlimitedMeaning(LinuxCgroupScalar scalar)
    {
        using LinuxCgroupDirectoryReader reader = OpenNativeReader();
        byte[] scratch = Scratch();
        var clock = new WindowClock();
        LinuxCgroupTimedObservationCapture<LinuxCgroupScalarCapture> actual = LinuxCgroupTimedObservationReader.Capture(
            reader, scalar, clock, TimeSpan.FromSeconds(1), scratch);
        AssertWindow(actual, reader, clock);
        LinuxCgroupScalarCapture raw = Assert.IsType<LinuxCgroupScalarCapture>(actual.Observation);
        Assert.Equal(raw.State, actual.State);
        Assert.Equal(reader.Identity, raw.Identity);
        if (raw.Unlimited)
        {
            Assert.Contains(scalar, new[] { LinuxCgroupScalar.HighBytes, LinuxCgroupScalar.HardLimitBytes, LinuxCgroupScalar.SwapLimitBytes });
            Assert.Equal(MemoryObservationState.Unknown, raw.State);
            Assert.Null(raw.Value);
        }
        else
        {
            Assert.Equal(MemoryObservationState.Available, raw.State);
            Assert.True(raw.Value >= 0);
        }
        AssertCleared(scratch);
        _output.WriteLine(JsonSerializer.Serialize(new
        {
            Scalar = scalar,
            Capture = actual,
            ProcessBindingQualified = false
        }));
    }

    [Theory]
    [InlineData("rss", LinuxCgroupV1StatScope.Local, LinuxCgroupCounterUnit.Bytes)]
    [InlineData("total_rss", LinuxCgroupV1StatScope.HierarchicalTotal, LinuxCgroupCounterUnit.Bytes)]
    [InlineData("pgmajfault", LinuxCgroupV1StatScope.Local, LinuxCgroupCounterUnit.Events)]
    [InlineData("hierarchical_memsw_limit", LinuxCgroupV1StatScope.HierarchicalLimit, LinuxCgroupCounterUnit.Bytes)]
    public void NativeV2OwnerRetainsUnsupportedV1ScopeAndUnitWithoutAliasingV2Fields(
        string key, LinuxCgroupV1StatScope scope, LinuxCgroupCounterUnit unit)
    {
        using LinuxCgroupDirectoryReader reader = OpenNativeReader();
        byte[] scratch = Scratch();
        var clock = new WindowClock();
        LinuxCgroupTimedObservationCapture<LinuxCgroupV1StatCapture> actual = LinuxCgroupTimedObservationReader.CaptureV1Stat(
            reader, key, clock, TimeSpan.FromSeconds(1), scratch);
        AssertWindow(actual, reader, clock);
        LinuxCgroupV1StatCapture raw = Assert.IsType<LinuxCgroupV1StatCapture>(actual.Observation);
        Assert.Equal(key, raw.Key);
        Assert.Equal(scope, raw.Scope);
        Assert.Equal(unit, raw.Unit);
        Assert.Equal(reader.Identity, raw.Identity);
        Assert.Equal(MemoryObservationState.Unknown, raw.State);
        Assert.Equal(raw.State, actual.State);
        Assert.Null(raw.Value);
        AssertCleared(scratch);
        _output.WriteLine(JsonSerializer.Serialize(new
        {
            Capture = actual,
            V1HardwareVerified = false
        }));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void SyntheticOrdinaryDescriptorCannotTurnPlantedControllerBytesIntoAnObservation(bool v1)
    {
        string root = Path.Combine(Path.GetTempPath(), "fsus-cgroup-timed-negative-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            string file = Path.Combine(root, v1 ? "memory.stat" : "memory.current");
            File.WriteAllText(file, v1 ? "rss 7\ntotal_rss 13\npgmajfault 19\n" : "7\n");
            Assert.Equal(MemoryFailure.UnsupportedCapability, LinuxCgroupDirectoryReader.ProbeDirectory(root, v1 ? 1 : 2).Failure);
            using SafeFileHandle descriptor = File.OpenHandle(file, FileMode.Open, FileAccess.Read);
            var identity = new LinuxCgroupDirectoryIdentity(v1 ? 1 : 2, 11, 22, 0, 3);
            // A deliberately invalid fixture owner exercises the real descriptor
            // guard. It supplies no positive native or process-domain evidence.
            ConstructorInfo constructor = Assert.Single(typeof(LinuxCgroupDirectoryReader)
                .GetConstructors(BindingFlags.NonPublic | BindingFlags.Instance));
            using var reader = (LinuxCgroupDirectoryReader)constructor.Invoke([descriptor, identity, 4096]);
            byte[] scratch = Scratch();
            if (v1)
            {
                var actual = LinuxCgroupTimedObservationReader.CaptureV1Stat(reader, "total_rss", new WindowClock(), TimeSpan.FromSeconds(1), scratch);
                Assert.Equal(MemoryObservationState.Unknown, actual.State);
                Assert.Null(actual.Observation!.Value);
                Assert.Equal(LinuxCgroupV1StatScope.HierarchicalTotal, actual.Observation.Scope);
                Assert.Equal(LinuxCgroupCounterUnit.Bytes, actual.Observation.Unit);
                Assert.Equal(MemoryQualification.NotVerified, actual.Qualification);
            }
            else
            {
                var actual = LinuxCgroupTimedObservationReader.Capture(reader, LinuxCgroupScalar.UsageBytes, new WindowClock(), TimeSpan.FromSeconds(1), scratch);
                Assert.Equal(MemoryObservationState.Unknown, actual.State);
                Assert.Null(actual.Observation!.Value);
                Assert.False(actual.Observation.Unlimited);
                Assert.Equal(MemoryQualification.NotVerified, actual.Qualification);
            }
            AssertCleared(scratch);
            _output.WriteLine("Synthetic descriptor negative control only; no native-v1 qualification.");
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    [Theory]
    [InlineData(100L, 99L, 1000L, 1000L, 1L, 10000000L, false)]
    [InlineData(long.MinValue, long.MaxValue, 1000L, 1000L, 1L, 10000000L, false)]
    [InlineData(100L, 101L, 1000L, 2000L, 1L, 10000000L, false)]
    [InlineData(100L, 101L, 1000L, 0L, 1L, 10000000L, false)]
    [InlineData(100L, 101L, 1000L, -1L, 1L, 10000000L, false)]
    [InlineData(100L, 101L, 1000L, 1000L, -1L, 10000000L, false)]
    [InlineData(100L, 101L, 1000L, 1000L, 10000001L, 10000000L, false)]
    [InlineData(100L, 1101L, 1000L, 1000L, 1L, 10000000L, false)]
    [InlineData(100L, 1100L, 1000L, 1000L, 10000000L, 10000000L, true)]
    [InlineData(100L, 100L, 1000L, 1000L, 0L, 1L, true)]
    [InlineData(0L, 1152921504606846977L, 1152921504606846976L, 1152921504606846976L, 0L, 10000000L, false)]
    [InlineData(0L, 1152921504606846976L, 1152921504606846976L, 1152921504606846976L, 0L, 10000000L, true)]
    [InlineData(0L, long.MaxValue, long.MaxValue, long.MaxValue, 0L, long.MaxValue, true)]
    public void ScalarWindowChecksBothClocksAndExactInclusiveDurationWithoutDoubleRounding(
        long start, long end, long frequency, long finalFrequency, long utcTicks, long durationTicks, bool valid)
    {
        using LinuxCgroupDirectoryReader reader = OpenNativeReader();
        byte[] scratch = Scratch();
        var clock = new WindowClock(start, end, frequency, finalFrequency, utcTicks);
        var actual = LinuxCgroupTimedObservationReader.Capture(reader, LinuxCgroupScalar.UsageBytes,
            clock, TimeSpan.FromTicks(durationTicks), scratch);
        AssertWindow(actual, reader, clock);
        Assert.Equal(valid ? MemoryObservationState.Available : MemoryObservationState.Stale, actual.State);
        Assert.Equal(actual.State, actual.Observation!.State);
        if (valid)
        {
            Assert.True(actual.Observation.Value >= 0);
        }
        else
        {
            Assert.Null(actual.Observation.Value);
            Assert.False(actual.Observation.Unlimited);
        }
        Assert.Equal(start, actual.Timestamp);
        Assert.Equal(end, actual.CompletedTimestamp);
        Assert.Equal(frequency, actual.TimestampFrequency);
        Assert.Equal(finalFrequency, actual.CompletedTimestampFrequency);
        Assert.Equal(DateTimeOffset.UnixEpoch.AddTicks(utcTicks), actual.CompletedAt);
        AssertCleared(scratch);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void InvalidWindowRemovesUnlimitedAssertionsAndUnavailableV1Values(bool v1)
    {
        using LinuxCgroupDirectoryReader reader = OpenNativeReader();
        byte[] scratch = Scratch();
        var clock = new WindowClock(end: 99);
        if (v1)
        {
            var actual = LinuxCgroupTimedObservationReader.CaptureV1Stat(reader, "total_pgmajfault", clock, TimeSpan.FromSeconds(1), scratch);
            Assert.Equal(MemoryObservationState.Stale, actual.State);
            Assert.Equal(actual.State, actual.Observation!.State);
            Assert.Equal(LinuxCgroupV1StatScope.HierarchicalTotal, actual.Observation.Scope);
            Assert.Equal(LinuxCgroupCounterUnit.Events, actual.Observation.Unit);
            Assert.Null(actual.Observation.Value);
        }
        else
        {
            var actual = LinuxCgroupTimedObservationReader.Capture(reader, LinuxCgroupScalar.HighBytes, clock, TimeSpan.FromSeconds(1), scratch);
            Assert.Equal(MemoryObservationState.Stale, actual.State);
            Assert.Null(actual.Observation!.Value);
            Assert.False(actual.Observation.Unlimited);
        }
        AssertCleared(scratch);
    }

    [Theory]
    [InlineData(MemoryCapabilityMode.Disabled, 1, 1000L, MemoryObservationState.Unknown)]
    [InlineData((MemoryCapabilityMode)999, 1, 1000L, MemoryObservationState.Malformed)]
    [InlineData(MemoryCapabilityMode.Auto, 0, 1000L, MemoryObservationState.Malformed)]
    [InlineData(MemoryCapabilityMode.Required, -1, 1000L, MemoryObservationState.Malformed)]
    [InlineData(MemoryCapabilityMode.Auto, 1, 0L, MemoryObservationState.Malformed)]
    [InlineData(MemoryCapabilityMode.Auto, 1, -1L, MemoryObservationState.Malformed)]
    public void DisabledOrInvalidAdmissionDoesNotCallTheDisposedOwnerOrCaptureClockEndpoints(
        MemoryCapabilityMode mode, int durationSeconds, long frequency, MemoryObservationState expected)
    {
        using LinuxCgroupDirectoryReader reader = OpenNativeReader();
        reader.Dispose();
        foreach (bool v1 in new[] { false, true })
        {
            byte[] scratch = Scratch();
            var clock = new WindowClock(frequency: frequency);
            if (v1)
            {
                AssertEmpty(LinuxCgroupTimedObservationReader.CaptureV1Stat(reader, "rss", clock,
                    TimeSpan.FromSeconds(durationSeconds), scratch, mode), expected);
            }
            else
            {
                AssertEmpty(LinuxCgroupTimedObservationReader.Capture(reader, LinuxCgroupScalar.UsageBytes, clock,
                    TimeSpan.FromSeconds(durationSeconds), scratch, mode), expected);
            }
            Assert.Equal(0, clock.UtcReads);
            Assert.Equal(0, clock.TickReads);
            AssertCleared(scratch);
        }
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    [InlineData(5)]
    public void EveryClockExceptionClearsScratchAndKeepsTheBorrowedOwnerUsable(int throwAt)
    {
        using LinuxCgroupDirectoryReader reader = OpenNativeReader();
        foreach (bool v1 in new[] { false, true })
        {
            byte[] scratch = Scratch();
            var clock = new WindowClock(throwAt: throwAt);
            Assert.Throws<InvalidOperationException>(() => Invoke(v1, reader, clock, scratch));
            AssertCleared(scratch);
        }
        Assert.Equal(MemoryObservationState.Available, reader.Capture(LinuxCgroupScalar.UsageBytes, Scratch()).State);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ScratchDisposedOwnerAndSelectorErrorsRemainVisibleAndClearTheWholeSpan(bool v1)
    {
        using LinuxCgroupDirectoryReader reader = OpenNativeReader();
        byte[] scratch = Scratch(4096);
        Assert.Throws<ArgumentException>(() => Invoke(v1, reader, new WindowClock(), scratch));
        AssertCleared(scratch);
        scratch = Scratch();
        Assert.Throws<ArgumentNullException>(() => Invoke(v1, null!, new WindowClock(), scratch));
        AssertCleared(scratch);
        scratch = Scratch();
        Assert.Throws<ArgumentNullException>(() => Invoke(v1, reader, null!, scratch));
        AssertCleared(scratch);
        scratch = Scratch();
        if (v1)
        {
            Assert.Throws<ArgumentException>(() => LinuxCgroupTimedObservationReader.CaptureV1Stat(reader, "anon",
                new WindowClock(), TimeSpan.FromSeconds(1), scratch));
            AssertCleared(scratch);
            scratch = Scratch();
            Assert.Throws<ArgumentException>(() => LinuxCgroupTimedObservationReader.CaptureV1Stat(reader, "",
                new WindowClock(), TimeSpan.FromSeconds(1), scratch));
        }
        else
        {
            Assert.Throws<ArgumentOutOfRangeException>(() => LinuxCgroupTimedObservationReader.Capture(reader,
                (LinuxCgroupScalar)999, new WindowClock(), TimeSpan.FromSeconds(1), scratch));
        }
        AssertCleared(scratch);
        reader.Dispose();
        scratch = Scratch();
        Assert.Throws<ObjectDisposedException>(() => Invoke(v1, reader, new WindowClock(), scratch));
        AssertCleared(scratch);
    }

    [Fact]
    public void RepeatedAllowedReadsExposeActualSystemClockEnvelopesWithoutQualifyingTheDomain()
    {
        using LinuxCgroupDirectoryReader reader = OpenNativeReader();
        string? source = null;
        for (int attempt = 0; attempt < 3; attempt++)
        {
            byte[] scratch = Scratch();
            DateTimeOffset outerStart = TimeProvider.System.GetUtcNow();
            long outerTimestamp = TimeProvider.System.GetTimestamp();
            var actual = LinuxCgroupTimedObservationReader.Capture(reader, LinuxCgroupScalar.UsageBytes,
                TimeProvider.System, TimeSpan.FromSeconds(1), scratch, MemoryCapabilityMode.Required);
            long outerCompleted = TimeProvider.System.GetTimestamp();
            DateTimeOffset outerEnd = TimeProvider.System.GetUtcNow();
            Assert.Equal(MemoryObservationState.Available, actual.State);
            Assert.True(actual.Observation!.Value >= 0);
            Assert.InRange(actual.StartedAt!.Value, outerStart, outerEnd);
            Assert.InRange(actual.CompletedAt!.Value, actual.StartedAt.Value, outerEnd);
            Assert.InRange(actual.Timestamp!.Value, outerTimestamp, outerCompleted);
            Assert.InRange(actual.CompletedTimestamp!.Value, actual.Timestamp.Value, outerCompleted);
            Assert.Equal(TimeProvider.System.TimestampFrequency, actual.TimestampFrequency);
            Assert.Equal(actual.TimestampFrequency, actual.CompletedTimestampFrequency);
            Assert.Equal(MemoryQualification.NotVerified, actual.Qualification);
            source ??= actual.Source;
            Assert.Equal(source, actual.Source);
            AssertCleared(scratch);
            _output.WriteLine(JsonSerializer.Serialize(new
            {
                Attempt = attempt,
                Capture = actual,
                GrowthAuthorized = false
            }));
        }
    }

    private static void Invoke(bool v1, LinuxCgroupDirectoryReader reader, TimeProvider clock, byte[] scratch)
    {
        if (v1)
        {
            LinuxCgroupTimedObservationReader.CaptureV1Stat(reader, "rss", clock, TimeSpan.FromSeconds(1), scratch);
        }
        else
        {
            LinuxCgroupTimedObservationReader.Capture(reader, LinuxCgroupScalar.UsageBytes, clock, TimeSpan.FromSeconds(1), scratch);
        }
    }

    private static byte[] Scratch(int size = 8192)
    {
        byte[] scratch = new byte[size];
        Array.Fill(scratch, (byte)0xcc);
        return scratch;
    }

    private static void AssertCleared(byte[] scratch) => Assert.All(scratch, value => Assert.Equal((byte)0, value));

    private static void AssertWindow<T>(LinuxCgroupTimedObservationCapture<T> actual,
        LinuxCgroupDirectoryReader reader, WindowClock clock) where T : class
    {
        Assert.True(actual.Captured);
        Assert.Null(actual.Failure);
        Assert.Equal(reader.Identity, actual.Identity);
        Assert.NotNull(actual.Observation);
        Assert.Equal(DateTimeOffset.UnixEpoch, actual.StartedAt);
        Assert.NotNull(actual.CompletedAt);
        Assert.NotNull(actual.Timestamp);
        Assert.NotNull(actual.CompletedTimestamp);
        Assert.Equal(2, clock.UtcReads);
        Assert.Equal(2, clock.TickReads);
        Assert.Equal(2, clock.FrequencyReads);
        Assert.Equal(MemoryQualification.NotVerified, actual.Qualification);
        Assert.Contains("Linux.cgroup.observation;pid=", actual.Source, StringComparison.Ordinal);
    }

    private static void AssertEmpty<T>(LinuxCgroupTimedObservationCapture<T> actual, MemoryObservationState expected) where T : class
    {
        Assert.Equal(expected, actual.State);
        Assert.False(actual.Captured);
        Assert.Null(actual.Observation);
        Assert.Null(actual.StartedAt);
        Assert.Null(actual.CompletedAt);
        Assert.Null(actual.Timestamp);
        Assert.Null(actual.CompletedTimestamp);
        Assert.Null(actual.TimestampFrequency);
        Assert.Null(actual.CompletedTimestampFrequency);
        Assert.Equal(expected == MemoryObservationState.Malformed ? MemoryFailure.BoundsViolation : (MemoryFailure?)null, actual.Failure);
        Assert.Equal(MemoryQualification.NotVerified, actual.Qualification);
    }

    private static LinuxCgroupDirectoryReader OpenNativeReader()
    {
        Assert.True(OperatingSystem.IsLinux());
        string line = Assert.Single(File.ReadAllLines("/proc/self/mountinfo"),
            item => item.Contains(" - cgroup2 ", StringComparison.Ordinal));
        string path = line.Split(' ')[4].Replace("\\040", " ", StringComparison.Ordinal)
            .Replace("\\011", "\t", StringComparison.Ordinal).Replace("\\012", "\n", StringComparison.Ordinal)
            .Replace("\\134", "\\", StringComparison.Ordinal);
        var identity = LinuxCgroupDirectoryReader.TryInspectDirectory(path, 2);
        Assert.True(identity.Succeeded);
        var opened = LinuxCgroupDirectoryReader.TryOpenObservedDirectory(path, identity.Value!, 4096);
        Assert.True(opened.Succeeded);
        return opened.Value!;
    }

    private sealed class WindowClock(long start = 100, long end = 101, long frequency = 1000,
        long? finalFrequency = null, long utcTicks = 10000, int throwAt = -1) : TimeProvider
    {
        private int _calls;
        public int UtcReads
        {
            get; private set;
        }
        public int TickReads
        {
            get; private set;
        }
        public int FrequencyReads
        {
            get; private set;
        }

        public override long TimestampFrequency
        {
            get
            {
                ThrowIfRequested();
                return FrequencyReads++ == 0 ? frequency : finalFrequency ?? frequency;
            }
        }

        public override DateTimeOffset GetUtcNow()
        {
            ThrowIfRequested();
            return UtcReads++ == 0 ? DateTimeOffset.UnixEpoch : DateTimeOffset.UnixEpoch.AddTicks(utcTicks);
        }

        public override long GetTimestamp()
        {
            ThrowIfRequested();
            return TickReads++ == 0 ? start : end;
        }

        private void ThrowIfRequested()
        {
            if (_calls++ == throwAt)
            {
                throw new InvalidOperationException("fixture-clock-failure");
            }
        }
    }
}
