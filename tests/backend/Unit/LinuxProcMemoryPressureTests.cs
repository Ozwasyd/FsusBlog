using System.Text;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Platform;
using FsusBlog.Server.Infrastructure.Memory.Pressure;

using Xunit.Abstractions;

namespace FsusBlog.Server.Tests.Unit;

public sealed class LinuxProcMemoryPressureTests
{
    private readonly ITestOutputHelper _output;

    public LinuxProcMemoryPressureTests(ITestOutputHelper output)
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
            IReadOnlyList<MemoryPressureObservation> observations = source.Capture(7);
            Assert.Equal(5, observations.Count);
            _output.WriteLine(JsonSerializer.Serialize(observations));
            Assert.All(observations, item =>
            {
                Assert.Equal(MemoryObservationState.Available, item.State);
                Assert.Contains($"pid={Environment.ProcessId}", item.Source);
                Assert.Equal(7UL, item.DomainRevision);
                Assert.True(item.TimestampFrequency > 0);
                Assert.True(item.State == MemoryObservationState.Available ? item.Value is >= 0 : item.Value is null);
            });
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

    private sealed class AdvancingClock : TimeProvider
    {
        private long _time;
        public override long TimestampFrequency => 1000;
        public override long GetTimestamp() => Interlocked.Add(ref _time, 1000);
    }
}
