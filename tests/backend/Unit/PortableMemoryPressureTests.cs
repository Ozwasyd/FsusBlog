using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Pressure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PortableMemoryPressureTests
{
    private static readonly ResourceDomainId s_domain = new(Guid.Parse("ffec1a22-6d73-48b1-ae06-4cb16bd9802b"));
    private static readonly DateTimeOffset s_origin = DateTimeOffset.UnixEpoch;

    [Theory]
    [InlineData(MemoryObservationState.Unknown)]
    [InlineData(MemoryObservationState.Denied)]
    [InlineData(MemoryObservationState.Malformed)]
    public void UnavailableNeverBecomesZeroOrRate(MemoryObservationState state)
    {
        MemoryPressureObservation previous = Observation(10, 1);
        MemoryPressureObservation current = Observation(null, 2, state: state);
        MemoryPressureDelta delta = Compare(previous, current);
        Assert.Equal(MemoryPressureTransition.Unknown, delta.Transition);
        Assert.Null(current.Value);
        Assert.Null(delta.Change);
        Assert.Null(delta.PerSecond);
        Assert.Throws<ArgumentException>(() => Observation(0, 2, state: state));
    }

    [Fact]
    public void CounterResetAndReleasedCapacityHaveDifferentMeanings()
    {
        MemoryPressureDelta reset = Compare(Observation(100, 1), Observation(10, 2));
        Assert.Equal(MemoryPressureTransition.CounterReset, reset.Transition);
        Assert.Null(reset.Change);
        MemoryPressureDelta reclaim = Compare(Observation(100, 1, metric: MemoryPressureMetric.LedgerChargedBytes),
            Observation(10, 2, metric: MemoryPressureMetric.LedgerChargedBytes));
        Assert.Equal(MemoryPressureTransition.Comparable, reclaim.Transition);
        Assert.Equal(-90, reclaim.Change);
        Assert.Equal(-90, reclaim.PerSecond);
    }

    [Fact]
    public void ActiveDomainRevisionRejectsEvenTwoInternallyConsistentOldSamples()
    {
        MemoryPressureObservation previous = Observation(10, 1);
        MemoryPressureObservation current = Observation(20, 2);
        Assert.Equal(MemoryPressureTransition.DomainChanged,
            MemoryPressureNormalizer.Compare(previous, current, s_domain, 2, s_origin.AddSeconds(2), TimeSpan.FromSeconds(10)).Transition);
        Assert.Equal(MemoryPressureTransition.DomainChanged,
            MemoryPressureNormalizer.Compare(previous, current, new(Guid.NewGuid()), 1, s_origin.AddSeconds(2), TimeSpan.FromSeconds(10)).Transition);
    }

    [Fact]
    public void StaleAndDiscontinuousClocksNeverSupplyGrowth()
    {
        MemoryPressureObservation previous = Observation(10, 1);
        MemoryPressureObservation current = Observation(20, 2);
        Assert.Equal(MemoryPressureTransition.Stale,
            MemoryPressureNormalizer.Compare(previous, current, s_domain, 1, s_origin.AddSeconds(30), TimeSpan.FromSeconds(10)).Transition);
        Assert.Equal(MemoryPressureTransition.ClockDiscontinuity, Compare(current, previous).Transition);
        Assert.Equal(MemoryPressureTransition.ClockDiscontinuity,
            MemoryPressureNormalizer.Compare(previous, current, s_domain, 1, s_origin, TimeSpan.FromSeconds(10)).Transition);
        MemoryPressureObservation overflowPrevious = Observation(10, 1, timestamp: long.MinValue);
        MemoryPressureObservation overflowCurrent = Observation(20, 2, timestamp: long.MaxValue);
        Assert.Equal(MemoryPressureTransition.ClockDiscontinuity, Compare(overflowPrevious, overflowCurrent).Transition);
    }

    [Fact]
    public void LastGcSnapshotCannotMasqueradeAsInstantaneousUsageRate()
    {
        MemoryPressureDelta delta = Compare(Observation(10, 1, metric: MemoryPressureMetric.GcHeapBytes,
            scope: MemoryPressureScope.HeapAtLastCollection), Observation(20, 2, metric: MemoryPressureMetric.GcHeapBytes,
            scope: MemoryPressureScope.HeapAtLastCollection));
        Assert.Equal(MemoryPressureTransition.SnapshotOnly, delta.Transition);
        Assert.Null(delta.PerSecond);
    }

    [Fact]
    public void ReplayPreservesStepsBurstsOscillationAndExactNegativeGrowth()
    {
        long[] values = [10, 10, 20, 80, 20, 21, 20];
        long[] expected = [0, 10, 60, -60, 1, -1];
        for (int repeat = 0; repeat < 2; repeat++)
        {
            MemoryPressureObservation previous = Observation(values[0], 1, metric: MemoryPressureMetric.LedgerChargedBytes);
            for (int index = 1; index < values.Length; index++)
            {
                MemoryPressureObservation current = Observation(values[index], index + 1, metric: MemoryPressureMetric.LedgerChargedBytes);
                MemoryPressureDelta delta = Compare(previous, current);
                Assert.Equal(MemoryPressureTransition.Comparable, delta.Transition);
                Assert.Equal(expected[index - 1], delta.Change);
                Assert.Equal(expected[index - 1], delta.PerSecond);
                previous = current;
            }
        }
    }

    [Fact]
    public void LivePortableCaptureUsesRealApiProvenanceAndBoundedRetention()
    {
        ResourceDomainId operations = new(Guid.NewGuid());
        var topology = new MemoryResourceTopology([
            new(s_domain, "payload", MemoryResourceUnit.Bytes, null),
            new(operations, "operations", MemoryResourceUnit.OperationSlots, null)
        ]);
        var ledger = new MemoryReservationCoordinator(topology, [
            new(s_domain, MemoryResourceUnit.Bytes, 64), new(operations, MemoryResourceUnit.OperationSlots, 2)
        ], 1, 8, 16);
        var source = new PortableMemoryPressureSource(ledger, s_domain, new(Guid.NewGuid()), [
            new(s_domain, "payload", MemoryResourceUnit.Bytes), new(operations, "operations", MemoryResourceUnit.OperationSlots)
        ], TimeProvider.System, traceCapacity: 2);
        using MemoryReservation reservation = ledger.TryReserve([new(s_domain, MemoryResourceUnit.Bytes, 32)]).Value!;
        for (int index = 0; index < 5; index++)
        {
            MemoryPressureSample sample = source.Capture();
            Assert.Equal(9, sample.Observations.Count);
            Assert.Equal(32, Assert.Single(sample.Observations, item => item.Metric == MemoryPressureMetric.LedgerChargedBytes).Value);
            Assert.Equal(0, Assert.Single(sample.Observations, item => item.Metric == MemoryPressureMetric.LedgerOperationSlots).Value);
            Assert.Contains($"pid={Environment.ProcessId}",
                Assert.Single(sample.Observations, item => item.Metric == MemoryPressureMetric.ProcessWorkingSetBytes).Source);
            Assert.All(sample.Observations, item =>
            {
                Assert.False(string.IsNullOrWhiteSpace(item.Source));
                Assert.True(item.TimestampFrequency > 0);
                Assert.NotEqual(Guid.Empty, item.Domain.Value);
                Assert.True(item.State == MemoryObservationState.Available ? item.Value is >= 0 : item.Value is null);
            });
        }
        Assert.Equal(2, source.Trace().Count);
        source.InvalidateDomain(2);
        Assert.Empty(source.Trace());
        Assert.Equal(2UL, source.Capture().DomainRevision);
        Assert.Throws<ArgumentOutOfRangeException>(() => source.InvalidateDomain(2));
        Assert.Throws<ArgumentException>(() => new PortableMemoryPressureSource(ledger, s_domain, new(Guid.NewGuid()), [
            new(s_domain, "other-capacity", MemoryResourceUnit.Bytes)
        ], TimeProvider.System, 2));
    }

    [Fact]
    public async Task DomainInvalidationDuringRealCaptureRefusesOldHistory()
    {
        var topology = new MemoryResourceTopology([new(s_domain, "payload", MemoryResourceUnit.Bytes, null)]);
        var ledger = new MemoryReservationCoordinator(topology, [new(s_domain, MemoryResourceUnit.Bytes, 64)], 1, 8, 16);
        using var clock = new BlockingClock();
        var source = new PortableMemoryPressureSource(ledger, s_domain, new(Guid.NewGuid()), [], clock, 2);
        Task<MemoryPressureSample> capture = Task.Run(source.Capture);
        try
        {
            await clock.Started.Task.WaitAsync(TimeSpan.FromSeconds(30));
            source.InvalidateDomain(2);
        }
        finally
        {
            clock.Resume();
        }
        await Assert.ThrowsAsync<InvalidOperationException>(async () =>
        {
            await capture;
        });
        Assert.Empty(source.Trace());
        Assert.Equal(2UL, source.Capture().DomainRevision);
    }

    [Fact]
    public void UnitsScopesAndDifferentMeasurementMeaningsCannotBeSubstituted()
    {
        Assert.Throws<ArgumentException>(() => Observation(1, 1, metric: MemoryPressureMetric.GcHeapBytes));
        Assert.Throws<ArgumentException>(() => new MemoryPressureObservation(MemoryPressureMetric.LedgerOperationSlots,
            MemoryResourceUnit.Bytes, MemoryPressureScope.Ledger, s_domain, 1, MemoryObservationState.Available,
            1, "wrong-unit", s_origin, 1, 1));
        Assert.Equal(MemoryPressureTransition.SourceChanged,
            Compare(Observation(10, 1), Observation(20, 2, metric: MemoryPressureMetric.ProcessWorkingSetBytes)).Transition);
    }

    private sealed class BlockingClock : TimeProvider, IDisposable
    {
        private readonly ManualResetEventSlim _resume = new(false);
        private int _entered;
        public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public override DateTimeOffset GetUtcNow()
        {
            if (Interlocked.Exchange(ref _entered, 1) == 0)
            {
                Started.SetResult();
                if (!_resume.Wait(TimeSpan.FromSeconds(30)))
                {
                    throw new TimeoutException("Controlled capture barrier was not resumed.");
                }
            }
            return DateTimeOffset.UtcNow;
        }
        public void Resume() => _resume.Set();
        public void Dispose()
        {
            _resume.Set();
            _resume.Dispose();
        }
    }

    private static MemoryPressureObservation Observation(long? value, int seconds,
        MemoryObservationState state = MemoryObservationState.Available,
        MemoryPressureMetric metric = MemoryPressureMetric.TotalAllocatedBytes,
        MemoryPressureScope? scope = null, long? timestamp = null)
        => new(metric, MemoryResourceUnit.Bytes, scope ?? (metric == MemoryPressureMetric.LedgerChargedBytes
            ? MemoryPressureScope.Ledger : MemoryPressureScope.Process), s_domain, 1, state, value, "replay-fixture-v1",
            s_origin.AddSeconds(seconds), timestamp ?? seconds * 1000L, 1000);

    private static MemoryPressureDelta Compare(MemoryPressureObservation previous, MemoryPressureObservation current)
        => MemoryPressureNormalizer.Compare(previous, current, s_domain, 1, s_origin.AddSeconds(10), TimeSpan.FromSeconds(20));
}
