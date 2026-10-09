using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Platform;
using FsusBlog.Server.Infrastructure.Memory.Pressure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class LinuxCgroupTimedCounterCompositionTests
{
    [Theory]
    [InlineData(LinuxCgroupCounter.AnonymousBytes, LinuxCgroupCounterUnit.Bytes, 10L, 5L, MemoryPressureTransition.Comparable, -5L)]
    [InlineData(LinuxCgroupCounter.MajorFaults, LinuxCgroupCounterUnit.Events, 10L, 5L, MemoryPressureTransition.CounterReset, null)]
    [InlineData(LinuxCgroupCounter.PressureSomeMicroseconds, LinuxCgroupCounterUnit.Microseconds, 10L, 15L, MemoryPressureTransition.Comparable, 5L)]
    public void FreshReadWindowsUseThePublishedDeltaComponentWithoutProducingRates(
        LinuxCgroupCounter counter, LinuxCgroupCounterUnit unit, long before, long after,
        MemoryPressureTransition transition, long? change)
    {
        LinuxCgroupTimedCounterCapture previous = Capture(counter, unit, before, 1000);
        LinuxCgroupTimedCounterCapture current = Capture(counter, unit, after, 2000);
        MemoryPressureDelta actual = Compare(previous, current);
        Assert.Equal(transition, actual.Transition);
        Assert.Equal(change, actual.Change);
        Assert.Null(actual.PerSecond);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    [InlineData(5)]
    public void FreshContextsCannotRescueMissingOrDiscontinuousCounterWindows(int mutation)
    {
        LinuxCgroupTimedCounterCapture previous = Capture(LinuxCgroupCounter.AnonymousBytes, LinuxCgroupCounterUnit.Bytes, 10, 1000);
        LinuxCgroupTimedCounterCapture current = Capture(LinuxCgroupCounter.AnonymousBytes, LinuxCgroupCounterUnit.Bytes, 15, 2000);
        current = mutation switch
        {
            0 => current with { Timestamp = null },
            1 => current with { Timestamp = 900 },
            2 => current with { TimestampFrequency = 2000 },
            3 => current with { Timestamp = long.MinValue, CompletedTimestamp = long.MaxValue },
            4 => current with { CompletedAt = DateTimeOffset.UnixEpoch.AddSeconds(4) },
            _ => current with { Source = "different-source" }
        };
        MemoryPressureDelta actual = Compare(previous, current);
        Assert.Equal(mutation == 0 ? MemoryPressureTransition.Unknown
            : mutation == 5 ? MemoryPressureTransition.SourceChanged : MemoryPressureTransition.ClockDiscontinuity,
            actual.Transition);
        Assert.Null(actual.Change);
        Assert.Null(actual.PerSecond);
    }

    [Fact]
    public void StaleCounterWindowsAreRejectedEvenWhenTheContextsAreFresh()
    {
        LinuxCgroupTimedCounterCapture previous = Capture(LinuxCgroupCounter.AnonymousBytes, LinuxCgroupCounterUnit.Bytes, 10, 1000);
        LinuxCgroupTimedCounterCapture current = Capture(LinuxCgroupCounter.AnonymousBytes, LinuxCgroupCounterUnit.Bytes, 15, 2000);
        MemoryPressureDelta actual = LinuxCgroupTimedCounterReader.Compare(previous, current, Context(1000), Context(2000),
            DateTimeOffset.UnixEpoch.AddMilliseconds(2100), TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(3));
        Assert.Equal(MemoryPressureTransition.Stale, actual.Transition);
        Assert.Null(actual.Change);
        Assert.Null(actual.PerSecond);
    }

    private static MemoryPressureDelta Compare(LinuxCgroupTimedCounterCapture previous, LinuxCgroupTimedCounterCapture current)
        => LinuxCgroupTimedCounterReader.Compare(previous, current, Context(1000), Context(2000),
            DateTimeOffset.UnixEpoch.AddMilliseconds(2100), TimeSpan.FromSeconds(3), TimeSpan.FromSeconds(3));

    private static LinuxCgroupTimedCounterCapture Capture(LinuxCgroupCounter counter, LinuxCgroupCounterUnit unit, long value, long timestamp)
        => new(counter, unit, new(2, 11, 22, 0, 3), MemoryObservationState.Available, value, "fixture-read-source", true, null,
            DateTimeOffset.UnixEpoch.AddMilliseconds(timestamp), DateTimeOffset.UnixEpoch.AddMilliseconds(timestamp + 1),
            timestamp, timestamp + 1, 1000);

    private static LinuxCgroupContextCapture Context(long timestamp)
        => new(MemoryObservationState.Available, LinuxCgroupScopeReason.Ready,
            new(new(2, 0, 41, 42, 22, "0:3", "/", "/", "/fixture/cgroup"), ["/fixture/cgroup"]),
            DateTimeOffset.UnixEpoch.AddMilliseconds(timestamp), timestamp, timestamp + 1,
            1000, "fixture-context-source", 41, 41, 42, 42);
}
