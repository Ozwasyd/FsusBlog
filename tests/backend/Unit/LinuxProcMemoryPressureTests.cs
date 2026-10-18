using System.Reflection;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Platform;
using FsusBlog.Server.Infrastructure.Memory.Pressure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class LinuxProcMemoryPressureTests
{
    private readonly Xunit.Abstractions.ITestOutputHelper _output;

    public LinuxProcMemoryPressureTests(Xunit.Abstractions.ITestOutputHelper output)
    {
        _output = output;
    }

    private static readonly ResourceDomainId s_buffer = new(Guid.NewGuid());
    private static readonly ResourceDomainId s_process = new(Guid.NewGuid());
    private static readonly ResourceDomainId s_host = new(Guid.NewGuid());

    [Theory]
    [InlineData("SwapTotal: 0 kB\n", MemoryObservationState.Available, 0L)]
    [InlineData("SwapTotal: 17 kB\n", MemoryObservationState.Available, 17408L)]
    [InlineData("SwapTotal:\t 17 kB\n", MemoryObservationState.Available, 17408L)]
    [InlineData("SwapFree: 17 kB\n", MemoryObservationState.Unknown, null)]
    [InlineData("SwapTotal: -1 kB\n", MemoryObservationState.Malformed, null)]
    [InlineData("SwapTotal: 17 MB\n", MemoryObservationState.Malformed, null)]
    [InlineData("SwapTotal: 17\n", MemoryObservationState.Malformed, null)]
    [InlineData("SwapTotal: 9223372036854775807 kB\n", MemoryObservationState.Malformed, null)]
    [InlineData("SwapTotal: 999999999999999999999999999 kB\n", MemoryObservationState.Malformed, null)]
    [InlineData("SwapTotal: 0 kB\nSwapTotal: 0 kB\n", MemoryObservationState.Malformed, null)]
    public void ParserDistinguishesActualZeroFromUnknownMalformedAndOverflow(string content,
        MemoryObservationState expectedState, long? expectedBytes)
    {
        var actual = LinuxProcMemoryPressureSource.ParseKilobytes(Encoding.ASCII.GetBytes(content), "SwapTotal");
        Assert.Equal(expectedState, actual.State);
        Assert.Equal(expectedBytes, actual.Bytes);
    }

    [Fact]
    public void DisabledHasNoSamplingOrBufferAdmissionAndRejectedBudgetHasNoPhysicalOwner()
    {
        MemoryReservationCoordinator ledger = Ledger(0);
        using LinuxProcMemoryPressureSource disabled = Create(ledger, 64, MemoryCapabilityMode.Disabled).Value!;
        Assert.Equal(0, disabled.ReadAttempts);
        Assert.Throws<InvalidOperationException>(() => disabled.Capture(1));
        Assert.Equal(0, disabled.ReadAttempts);
        Assert.Equal(0, ledger.Snapshot().Used["sampling"]);
        MemoryOperationResult<LinuxProcMemoryPressureSource> rejected = Create(ledger, 64);
        Assert.False(rejected.Succeeded);
        Assert.Equal(OperatingSystem.IsLinux() ? MemoryFailure.BudgetRejected : MemoryFailure.UnsupportedCapability, rejected.Failure);
        Assert.Equal(0, ledger.Snapshot().Used["sampling"]);
    }

    [Fact]
    public void LiveLinuxReadsHaveActualProvenanceAndRetainBufferChargeUntilDisable()
    {
        Assert.True(OperatingSystem.IsLinux(), "This assertion requires its actual Linux source row.");
        MemoryReservationCoordinator ledger = Ledger(65537);
        using LinuxProcMemoryPressureSource source = Create(ledger, 65536).Value!;
        Assert.Equal(65537, ledger.Snapshot().Used["sampling"]);
        Assert.Equal(0, source.ReadAttempts);
        for (int repeat = 0; repeat < 3; repeat++)
        {
            DateTimeOffset outerStartedAt = TimeProvider.System.GetUtcNow();
            long outerStarted = TimeProvider.System.GetTimestamp();
            IReadOnlyList<MemoryPressureObservation> observations = source.Capture(7);
            long outerCompleted = TimeProvider.System.GetTimestamp();
            DateTimeOffset outerCompletedAt = TimeProvider.System.GetUtcNow();
            Assert.Equal(5, observations.Count);
            _output.WriteLine(JsonSerializer.Serialize(observations));
            Assert.All(observations, item =>
            {
                Assert.Equal(MemoryObservationState.Available, item.State);
                Assert.Contains($"pid={Environment.ProcessId}", item.Source);
                Assert.Equal(7UL, item.DomainRevision);
                Assert.Equal(TimeProvider.System.TimestampFrequency, item.TimestampFrequency);
                Assert.InRange(item.SampledAt, outerStartedAt, outerCompletedAt);
                Assert.InRange(item.Timestamp, outerStarted, outerCompleted);
                Assert.Equal(observations[0].SampledAt, item.SampledAt);
                Assert.Equal(observations[0].Timestamp, item.Timestamp);
                Assert.True(item.State == MemoryObservationState.Available ? item.Value is >= 0 : item.Value is null);
            });
            Assert.All(Scratch(source), value => Assert.Equal((byte)0, value));
            MemoryPressureObservation available = Assert.Single(observations, item => item.Metric == MemoryPressureMetric.HostAvailableBytes);
            Assert.Equal(MemoryPressureScope.HostCurrent, available.Scope);
            Assert.Equal(s_host, available.Domain);
            Assert.Equal(MemoryObservationState.Available, available.State);
            MemoryPressureObservation swap = Assert.Single(observations, item => item.Metric == MemoryPressureMetric.ProcessSwapBytes);
            Assert.Equal(MemoryPressureScope.Process, swap.Scope);
            Assert.Equal(s_process, swap.Domain);
            Assert.Contains("/proc/self/status:VmSwap", swap.Source);
        }
        Assert.Equal(6, source.ReadAttempts);
        source.Disable();
        source.Disable();
        Assert.Equal(0, ledger.Snapshot().Used["sampling"]);
        Assert.Throws<InvalidOperationException>(() => source.Capture(8));
        Assert.Equal(6, source.ReadAttempts);
    }

    [Fact]
    public void OversizedLiveProcFilesAndExpiredCaptureNeverProduceInventedValues()
    {
        Assert.True(OperatingSystem.IsLinux(), "This assertion requires its actual Linux source row.");
        MemoryReservationCoordinator ledger = Ledger(65537);
        using (LinuxProcMemoryPressureSource tiny = Create(ledger, 8).Value!)
        {
            Assert.All(tiny.Capture(1), item =>
            {
                Assert.Equal(MemoryObservationState.Malformed, item.State);
                Assert.Null(item.Value);
            });
        }
        Assert.Equal(0, ledger.Snapshot().Used["sampling"]);
        using LinuxProcMemoryPressureSource slow = LinuxProcMemoryPressureSource.TryCreate(ledger,
            s_buffer, s_process, s_host, new AdvancingClock(), 65536, TimeSpan.FromMilliseconds(1)).Value!;
        Assert.All(slow.Capture(1), item =>
        {
            Assert.Equal(MemoryObservationState.Stale, item.State);
            Assert.Null(item.Value);
        });
    }

    [Theory]
    [InlineData(100L, 101L, 1000L, 1000L, 10000L, 10000000L, MemoryObservationState.Available)]
    [InlineData(100L, 1100L, 1000L, 1000L, 10000000L, 10000000L, MemoryObservationState.Available)]
    [InlineData(100L, 100L, 1000L, 1000L, 0L, 10000000L, MemoryObservationState.Available)]
    [InlineData(100L, 99L, 1000L, 1000L, 10000L, 10000000L, MemoryObservationState.Stale)]
    [InlineData(long.MinValue, long.MaxValue, 1000L, 1000L, 10000L, 10000000L, MemoryObservationState.Stale)]
    [InlineData(100L, 101L, 1000L, 2000L, 10000L, 10000000L, MemoryObservationState.Stale)]
    [InlineData(100L, 101L, 1000L, 0L, 10000L, 10000000L, MemoryObservationState.Stale)]
    [InlineData(100L, 101L, 1000L, -1L, 10000L, 10000000L, MemoryObservationState.Stale)]
    [InlineData(100L, 101L, 1000L, 1000L, -1L, 10000000L, MemoryObservationState.Stale)]
    [InlineData(100L, 101L, 1000L, 1000L, 10000001L, 10000000L, MemoryObservationState.Stale)]
    [InlineData(100L, 1101L, 1000L, 1000L, 10000L, 10000000L, MemoryObservationState.Stale)]
    // These intervals straddle half a second by one timestamp unit, below double precision.
    [InlineData(0L, 4611686018427387903L, 9223372036854775806L, 9223372036854775806L, 0L, 5000000L, MemoryObservationState.Available)]
    [InlineData(0L, 4611686018427387904L, 9223372036854775806L, 9223372036854775806L, 0L, 5000000L, MemoryObservationState.Stale)]
    public void SyntheticClockWindowsFreezeProvenanceAndRefuseInvalidIntervals(long start, long end,
        long frequency, long finalFrequency, long utcTicks, long maximumTicks, MemoryObservationState expected)
    {
        Assert.True(OperatingSystem.IsLinux(), "This control combines real procfs reads with a synthetic clock.");
        MemoryReservationCoordinator ledger = Ledger(65537);
        var clock = new WindowClock(start, end, frequency, finalFrequency, utcTicks);
        using LinuxProcMemoryPressureSource source = LinuxProcMemoryPressureSource.TryCreate(ledger,
            s_buffer, s_process, s_host, clock, 65536, TimeSpan.FromTicks(maximumTicks)).Value!;

        IReadOnlyList<MemoryPressureObservation> observations = source.Capture(7);

        Assert.Equal(5, observations.Count);
        Assert.All(observations, item =>
        {
            Assert.Equal(expected, item.State);
            Assert.Equal(DateTimeOffset.UnixEpoch, item.SampledAt);
            Assert.Equal(start, item.Timestamp);
            Assert.Equal(frequency, item.TimestampFrequency);
            Assert.Equal(7UL, item.DomainRevision);
            Assert.Equal(MemoryResourceUnit.Bytes, item.Unit);
            Assert.Contains($"pid={Environment.ProcessId}", item.Source);
            Assert.Equal(item.Scope == MemoryPressureScope.Process ? s_process : s_host, item.Domain);
            if (expected == MemoryObservationState.Available)
            {
                Assert.True(item.Value >= 0);
            }
            else
            {
                Assert.Null(item.Value);
            }
        });
        Assert.Equal(2, clock.UtcReads);
        Assert.Equal(2, clock.TimestampReads);
        Assert.Equal(2, clock.FrequencyReads);
        Assert.Equal(2, source.ReadAttempts);
        Assert.All(Scratch(source), value => Assert.Equal((byte)0, value));
    }

    [Theory]
    [InlineData(0L)]
    [InlineData(-1L)]
    public void InvalidInitialFrequencyRefusesBeforeProcReadsAndClearsScratch(long frequency)
    {
        Assert.True(OperatingSystem.IsLinux(), "This assertion requires its actual Linux source row.");
        MemoryReservationCoordinator ledger = Ledger(65537);
        var clock = new WindowClock(100, 101, frequency, frequency, 0);
        using LinuxProcMemoryPressureSource source = LinuxProcMemoryPressureSource.TryCreate(ledger,
            s_buffer, s_process, s_host, clock, 65536, TimeSpan.FromSeconds(1)).Value!;
        byte[] scratch = Scratch(source);
        Array.Fill(scratch, (byte)0xcc);

        Assert.Throws<InvalidOperationException>(() => source.Capture(1));

        Assert.Equal(0, source.ReadAttempts);
        Assert.Equal(0, clock.UtcReads);
        Assert.Equal(0, clock.TimestampReads);
        Assert.Equal(1, clock.FrequencyReads);
        Assert.Equal(-1, scratch.AsSpan().IndexOfAnyExcept((byte)0));
        Assert.Equal(65537, ledger.Snapshot().Used["sampling"]);
    }

    [Theory]
    [InlineData("frequency", 1)]
    [InlineData("frequency", 2)]
    [InlineData("utc", 1)]
    [InlineData("utc", 2)]
    [InlineData("timestamp", 1)]
    [InlineData("timestamp", 2)]
    public void SyntheticClockExceptionsRemainVisibleAndFinallyClearOwnedScratch(string member, int call)
    {
        Assert.True(OperatingSystem.IsLinux(), "This assertion requires its actual Linux source row.");
        MemoryReservationCoordinator ledger = Ledger(65537);
        var clock = new FaultingClock(member, call);
        using LinuxProcMemoryPressureSource source = LinuxProcMemoryPressureSource.TryCreate(ledger,
            s_buffer, s_process, s_host, clock, 65536, TimeSpan.FromSeconds(1)).Value!;
        byte[] scratch = Scratch(source);
        clock.Fault = () => Array.Fill(scratch, (byte)0xcc);

        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() => source.Capture(1));

        Assert.Equal("synthetic_clock_failure", error.Message);
        Assert.Equal(-1, scratch.AsSpan().IndexOfAnyExcept((byte)0));
        Assert.Equal(65537, ledger.Snapshot().Used["sampling"]);
        source.Disable();
        Assert.Equal(0, ledger.Snapshot().Used["sampling"]);
    }

    [Fact]
    public void InodesRemainDistinctFromOperationSlotsDuringRealPortableCapture()
    {
        ResourceDomainId inodes = new(Guid.NewGuid());
        var topology = new MemoryResourceTopology([new(inodes, "inodes", MemoryResourceUnit.Inodes, null)]);
        var ledger = new MemoryReservationCoordinator(topology, [new(inodes, MemoryResourceUnit.Inodes, 3)], 1, 8, 16);
        using MemoryReservation reservation = ledger.TryReserve([new(inodes, MemoryResourceUnit.Inodes, 2)]).Value!;
        var source = new PortableMemoryPressureSource(ledger, s_process, s_host,
            [new(inodes, "inodes", MemoryResourceUnit.Inodes)], TimeProvider.System, 2);
        MemoryPressureObservation sample = Assert.Single(source.Capture().Observations,
            item => item.Metric == MemoryPressureMetric.LedgerInodes);
        Assert.Equal(MemoryResourceUnit.Inodes, sample.Unit);
        Assert.Equal(2, sample.Value);
        Assert.Equal(MemoryPressureScope.Ledger, sample.Scope);
        Assert.DoesNotContain(source.Trace()[0].Observations, item => item.Metric == MemoryPressureMetric.LedgerOperationSlots);
        Assert.Throws<ArgumentException>(() => new MemoryPressureObservation(MemoryPressureMetric.LedgerInodes,
            MemoryResourceUnit.OperationSlots, MemoryPressureScope.Ledger, inodes, 1, MemoryObservationState.Available,
            2, "wrong-unit", DateTimeOffset.UtcNow, 1, 1));
    }

    private static MemoryReservationCoordinator Ledger(long cap)
    {
        var topology = new MemoryResourceTopology([new(s_buffer, "sampling", MemoryResourceUnit.Bytes, null)]);
        return new(topology, [new(s_buffer, MemoryResourceUnit.Bytes, cap)], 1, 8, 16);
    }

    private static MemoryOperationResult<LinuxProcMemoryPressureSource> Create(MemoryReservationCoordinator ledger,
        int maximumReadBytes, MemoryCapabilityMode mode = MemoryCapabilityMode.Auto)
        => LinuxProcMemoryPressureSource.TryCreate(ledger, s_buffer, s_process, s_host,
            TimeProvider.System, maximumReadBytes, TimeSpan.FromSeconds(30), mode);

    private static byte[] Scratch(LinuxProcMemoryPressureSource source)
        => (byte[])typeof(LinuxProcMemoryPressureSource).GetField("_buffer", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(source)!;

    private sealed class WindowClock(long start, long end, long frequency, long finalFrequency, long utcTicks) : TimeProvider
    {
        public int UtcReads
        {
            get;
            private set;
        }
        public int TimestampReads
        {
            get;
            private set;
        }
        public int FrequencyReads
        {
            get;
            private set;
        }
        public override DateTimeOffset GetUtcNow()
            => ++UtcReads == 1 ? DateTimeOffset.UnixEpoch : DateTimeOffset.UnixEpoch.AddTicks(utcTicks);
        public override long GetTimestamp() => ++TimestampReads == 1 ? start : end;
        public override long TimestampFrequency => ++FrequencyReads == 1 ? frequency : finalFrequency;
    }

    private sealed class FaultingClock(string member, int call) : TimeProvider
    {
        private int _frequencies;
        private int _utcReads;
        private int _timestamps;
        public Action? Fault
        {
            get;
            set;
        }
        public override long TimestampFrequency => Read("frequency", ++_frequencies, 1000);
        public override long GetTimestamp() => Read("timestamp", ++_timestamps, 100);
        public override DateTimeOffset GetUtcNow()
        {
            Read("utc", ++_utcReads, 0);
            return DateTimeOffset.UnixEpoch;
        }
        private long Read(string actualMember, int actualCall, long value)
        {
            if (actualMember == member && actualCall == call)
            {
                Fault?.Invoke();
                throw new InvalidOperationException("synthetic_clock_failure");
            }
            return value;
        }
    }

    private sealed class AdvancingClock : TimeProvider
    {
        private long _time;
        public override long TimestampFrequency => 1000;
        public override long GetTimestamp() => Interlocked.Add(ref _time, 1000);
    }
}
