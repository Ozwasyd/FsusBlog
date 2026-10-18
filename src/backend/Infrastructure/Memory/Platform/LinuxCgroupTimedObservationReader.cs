using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Pressure;

namespace FsusBlog.Server.Infrastructure.Memory.Platform;

/// <summary>
/// One directory-owner observation and the actual window surrounding that call.
/// A null observation means the owner was not called. Invalid windows retain their
/// endpoints but remove numerical values and unlimited-limit assertions. Native
/// identity, scope and units never establish qualified process-domain headroom.
/// </summary>
public readonly record struct LinuxCgroupTimedObservationCapture<T>(
    T? Observation,
    LinuxCgroupDirectoryIdentity Identity,
    MemoryObservationState State,
    string Source,
    bool Captured,
    MemoryFailure? Failure,
    DateTimeOffset? StartedAt,
    DateTimeOffset? CompletedAt,
    long? Timestamp,
    long? CompletedTimestamp,
    long? TimestampFrequency,
    long? CompletedTimestampFrequency) where T : class
{
    public MemoryQualification Qualification => MemoryQualification.NotVerified;
}

/// <summary>
/// Borrows the existing descriptor owner and caller-admitted scratch for one scalar
/// or v1 statistic read. It performs no parsing, retries, scheduling or domain
/// admission. A duration bound validates completion; it cannot interrupt native I/O.
/// Scratch is cleared on every exit and the borrowed owner remains caller-owned.
/// </summary>
public static class LinuxCgroupTimedObservationReader
{
    private static readonly string s_sourceIdentity = $"Linux.cgroup.observation;pid={Environment.ProcessId};instance={Guid.NewGuid():D}";

    public static LinuxCgroupTimedObservationCapture<LinuxCgroupScalarCapture> Capture(
        LinuxCgroupDirectoryReader reader, LinuxCgroupScalar scalar, TimeProvider clock,
        TimeSpan maximumDuration, Span<byte> admittedScratch, MemoryCapabilityMode mode = MemoryCapabilityMode.Auto)
    {
        try
        {
            ArgumentNullException.ThrowIfNull(reader);
            ArgumentNullException.ThrowIfNull(clock);
            if (!Enum.IsDefined(scalar))
            {
                throw new ArgumentOutOfRangeException(nameof(scalar));
            }
            if (!TryStart(clock, maximumDuration, mode, out CaptureStart start,
                out MemoryObservationState state, out MemoryFailure? failure))
            {
                return Empty<LinuxCgroupScalarCapture>(reader.Identity, state, failure);
            }
            LinuxCgroupScalarCapture raw = reader.Capture(scalar, admittedScratch);
            CaptureWindow window = Complete(clock, maximumDuration, start);
            if (!window.Valid)
            {
                raw = raw with
                {
                    State = MemoryObservationState.Stale,
                    Value = null,
                    Unlimited = false
                };
            }
            return Result(raw, raw.Identity, raw.State, window);
        }
        finally
        {
            admittedScratch.Clear();
        }
    }

    public static LinuxCgroupTimedObservationCapture<LinuxCgroupV1StatCapture> CaptureV1Stat(
        LinuxCgroupDirectoryReader reader, string key, TimeProvider clock,
        TimeSpan maximumDuration, Span<byte> admittedScratch, MemoryCapabilityMode mode = MemoryCapabilityMode.Auto)
    {
        try
        {
            ArgumentNullException.ThrowIfNull(reader);
            ArgumentNullException.ThrowIfNull(clock);
            ArgumentException.ThrowIfNullOrEmpty(key);
            if (!TryStart(clock, maximumDuration, mode, out CaptureStart start,
                out MemoryObservationState state, out MemoryFailure? failure))
            {
                return Empty<LinuxCgroupV1StatCapture>(reader.Identity, state, failure);
            }
            LinuxCgroupV1StatCapture raw = reader.CaptureV1Stat(key, admittedScratch);
            CaptureWindow window = Complete(clock, maximumDuration, start);
            if (!window.Valid)
            {
                raw = raw with
                {
                    State = MemoryObservationState.Stale,
                    Value = null
                };
            }
            return Result(raw, raw.Identity, raw.State, window);
        }
        finally
        {
            admittedScratch.Clear();
        }
    }

    private static bool TryStart(TimeProvider clock, TimeSpan maximumDuration, MemoryCapabilityMode mode,
        out CaptureStart start, out MemoryObservationState state, out MemoryFailure? failure)
    {
        start = default;
        state = MemoryObservationState.Malformed;
        failure = MemoryFailure.BoundsViolation;
        if (!Enum.IsDefined(mode) || maximumDuration <= TimeSpan.Zero)
        {
            return false;
        }
        if (mode == MemoryCapabilityMode.Disabled)
        {
            state = MemoryObservationState.Unknown;
            failure = null;
            return false;
        }
        long frequency = clock.TimestampFrequency;
        if (frequency <= 0)
        {
            return false;
        }
        DateTimeOffset startedAt = clock.GetUtcNow();
        long timestamp = clock.GetTimestamp();
        start = new(startedAt, timestamp, frequency);
        return true;
    }

    private static CaptureWindow Complete(TimeProvider clock, TimeSpan maximumDuration, CaptureStart start)
    {
        long completed = clock.GetTimestamp();
        DateTimeOffset completedAt = clock.GetUtcNow();
        long finalFrequency = clock.TimestampFrequency;
        bool valid;
        try
        {
            long elapsed = checked(completed - start.Timestamp);
            // Integer cross multiplication preserves the inclusive duration bound
            // even when a large frequency would round an extra tick down in double.
            valid = finalFrequency == start.Frequency && completedAt >= start.StartedAt
                && completedAt - start.StartedAt <= maximumDuration && elapsed >= 0
                && (UInt128)(ulong)elapsed * TimeSpan.TicksPerSecond
                    <= (UInt128)(ulong)maximumDuration.Ticks * (ulong)start.Frequency;
        }
        catch (OverflowException)
        {
            valid = false;
        }
        return new(start, completedAt, completed, finalFrequency, valid);
    }

    private static LinuxCgroupTimedObservationCapture<T> Empty<T>(LinuxCgroupDirectoryIdentity identity,
        MemoryObservationState state, MemoryFailure? failure) where T : class
        => new(null, identity, state, s_sourceIdentity, false, failure, null, null, null, null, null, null);

    private static LinuxCgroupTimedObservationCapture<T> Result<T>(T observation,
        LinuxCgroupDirectoryIdentity identity, MemoryObservationState state, CaptureWindow window) where T : class
        => new(observation, identity, state, s_sourceIdentity, true, null, window.Start.StartedAt,
            window.CompletedAt, window.Start.Timestamp, window.CompletedTimestamp,
            window.Start.Frequency, window.FinalFrequency);

    private readonly record struct CaptureStart(DateTimeOffset StartedAt, long Timestamp, long Frequency);
    private readonly record struct CaptureWindow(CaptureStart Start, DateTimeOffset CompletedAt,
        long CompletedTimestamp, long FinalFrequency, bool Valid);
}
