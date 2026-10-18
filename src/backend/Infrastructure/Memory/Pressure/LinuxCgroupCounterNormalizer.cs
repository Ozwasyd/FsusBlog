using System.Globalization;

using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Platform;

namespace FsusBlog.Server.Infrastructure.Memory.Pressure;

/// <summary>
/// Compares captured counters only within an agreeing directory and process context.
/// Context timestamps establish context freshness, not counter sample times: every
/// result leaves PerSecond absent. The sampling owner retains directory-to-roster
/// binding and capture lifetime responsibilities; a delta grants no qualification.
/// </summary>
public static class LinuxCgroupCounterNormalizer
{
    public static MemoryPressureDelta Compare(LinuxCgroupCounterCapture previous,
        LinuxCgroupCounterCapture current, LinuxCgroupContextCapture previousContext,
        LinuxCgroupContextCapture currentContext, DateTimeOffset now, TimeSpan maximumAge)
    {
        ArgumentNullException.ThrowIfNull(previous);
        ArgumentNullException.ThrowIfNull(current);
        ArgumentNullException.ThrowIfNull(previousContext);
        ArgumentNullException.ThrowIfNull(currentContext);
        if (maximumAge <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(maximumAge));
        }
        if (previous.State == MemoryObservationState.Stale || current.State == MemoryObservationState.Stale
            || previousContext.State == MemoryObservationState.Stale || currentContext.State == MemoryObservationState.Stale)
        {
            return Refuse(MemoryPressureTransition.Stale);
        }
        if (previous.State != MemoryObservationState.Available || current.State != MemoryObservationState.Available
            || previousContext.State != MemoryObservationState.Available || currentContext.State != MemoryObservationState.Available
            || previous.Value is null or < 0 || current.Value is null or < 0
            || !ValidCounter(previous) || !ValidCounter(current)
            || string.IsNullOrWhiteSpace(previousContext.Source) || string.IsNullOrWhiteSpace(currentContext.Source))
        {
            return Refuse(MemoryPressureTransition.Unknown);
        }
        if (previous.Counter != current.Counter || previous.Unit != current.Unit
            || previousContext.Source != currentContext.Source)
        {
            return Refuse(MemoryPressureTransition.SourceChanged);
        }
        if (previous.Identity != current.Identity
            || !MatchesScope(previous.Identity, previousContext.Scope)
            || !MatchesScope(current.Identity, currentContext.Scope))
        {
            return Refuse(MemoryPressureTransition.DomainChanged);
        }
        MemoryObservationState contextState = LinuxCgroupContextReader.CompareContexts(
            previousContext, currentContext, now, maximumAge);
        if (contextState != MemoryObservationState.Available)
        {
            return Refuse(contextState == MemoryObservationState.Stale
                ? MemoryPressureTransition.Stale : MemoryPressureTransition.Unknown);
        }
        long delta = current.Value.Value - previous.Value.Value;
        if (previous.Unit != LinuxCgroupCounterUnit.Bytes && delta < 0)
        {
            return Refuse(MemoryPressureTransition.CounterReset);
        }
        return new(MemoryPressureTransition.Comparable, delta, null);
    }

    private static bool ValidCounter(LinuxCgroupCounterCapture capture)
        => Enum.IsDefined(capture.Counter) && Enum.IsDefined(capture.Unit)
            && capture.Unit == LinuxCgroupCounterParser.Unit(capture.Counter)
            && capture.Identity is { Version: 2, Inode: > 0, MountId: > 0 };

    private static bool MatchesScope(LinuxCgroupDirectoryIdentity identity, LinuxCgroupScope? scope)
        => scope is not null && scope.ObservableDirectories.Count > 0
            && identity.Version == scope.Identity.Version && scope.Identity.MountId > 0
            && identity.MountId == (ulong)scope.Identity.MountId
            && scope.Identity.DeviceIdentity == string.Create(CultureInfo.InvariantCulture,
                $"{identity.DeviceMajor}:{identity.DeviceMinor}");

    private static MemoryPressureDelta Refuse(MemoryPressureTransition transition)
        => new(transition, null, null);
}
