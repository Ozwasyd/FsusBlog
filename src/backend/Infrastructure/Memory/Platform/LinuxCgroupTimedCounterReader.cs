using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Pressure;

namespace FsusBlog.Server.Infrastructure.Memory.Platform;

/// <summary>
/// A raw native counter and the actual interval surrounding its synchronous read.
/// The directory identity is not a qualified process or resource-domain binding.
/// Invalid clocks retain their observed endpoints but provide no usable value.
/// </summary>
public readonly record struct LinuxCgroupTimedCounterCapture(
    LinuxCgroupCounter Counter,
    LinuxCgroupCounterUnit Unit,
    LinuxCgroupDirectoryIdentity Identity,
    MemoryObservationState State,
    long? Value,
    string Source,
    bool Captured,
    MemoryFailure? Failure,
    DateTimeOffset? StartedAt,
    DateTimeOffset? CompletedAt,
    long? Timestamp,
    long? CompletedTimestamp,
    long? TimestampFrequency)
{
    public MemoryQualification Qualification => MemoryQualification.NotVerified;
}

/// <summary>
/// Borrows the existing directory owner and caller-admitted scratch for one read.
/// Clears the supplied scratch on every exit, including disabled and clock faults.
/// The background owner supplies a finite duration bound and controls admission,
/// scheduling, domain qualification and the lifetime of the borrowed reader.
/// </summary>
public static class LinuxCgroupTimedCounterReader
{
    private static readonly string s_sourceIdentity = $"Linux.cgroup.counter;pid={Environment.ProcessId};instance={Guid.NewGuid():D}";

    public static LinuxCgroupTimedCounterCapture Capture(LinuxCgroupDirectoryReader reader,
        LinuxCgroupCounter counter, TimeProvider clock, TimeSpan maximumDuration,
        Span<byte> admittedScratch, MemoryCapabilityMode mode = MemoryCapabilityMode.Auto)
    {
        try
        {
            ArgumentNullException.ThrowIfNull(reader);
            ArgumentNullException.ThrowIfNull(clock);
            if (!Enum.IsDefined(counter))
            {
                throw new ArgumentOutOfRangeException(nameof(counter));
            }
            LinuxCgroupCounterUnit unit = LinuxCgroupCounterParser.Unit(counter);
            if (!Enum.IsDefined(mode) || maximumDuration <= TimeSpan.Zero)
            {
                return Empty(MemoryObservationState.Malformed, MemoryFailure.BoundsViolation);
            }
            if (mode == MemoryCapabilityMode.Disabled)
            {
                return Empty(MemoryObservationState.Unknown, null);
            }
            long frequency = clock.TimestampFrequency;
            if (frequency <= 0)
            {
                return Empty(MemoryObservationState.Malformed, MemoryFailure.BoundsViolation);
            }
            DateTimeOffset startedAt = clock.GetUtcNow();
            long started = clock.GetTimestamp();
            LinuxCgroupCounterCapture raw = reader.CaptureCounter(counter, admittedScratch);
            long completed = clock.GetTimestamp();
            DateTimeOffset completedAt = clock.GetUtcNow();
            bool valid;
            try
            {
                long elapsed = checked(completed - started);
                valid = frequency == clock.TimestampFrequency
                    && completedAt >= startedAt
                    && completedAt - startedAt <= maximumDuration
                    && elapsed >= 0
                    && elapsed / (double)frequency <= maximumDuration.TotalSeconds;
            }
            catch (OverflowException)
            {
                valid = false;
            }
            return new(counter, unit, raw.Identity,
                valid ? raw.State : MemoryObservationState.Stale,
                valid ? raw.Value : null, s_sourceIdentity, true, null,
                startedAt, completedAt, started, completed, frequency);

            LinuxCgroupTimedCounterCapture Empty(MemoryObservationState state, MemoryFailure? failure)
                => new(counter, unit, reader.Identity, state, null, s_sourceIdentity, false,
                    failure, null, null, null, null, null);
        }
        finally
        {
            admittedScratch.Clear();
        }
    }

    /// <summary>
    /// Adds actual counter-window freshness checks before the canonical raw delta
    /// comparison. Context freshness does not stand in for counter freshness.
    /// The caller still owns directory-to-roster binding; no rate or qualification
    /// is inferred from these raw windows and context records.
    /// </summary>
    public static MemoryPressureDelta Compare(LinuxCgroupTimedCounterCapture previous,
        LinuxCgroupTimedCounterCapture current, LinuxCgroupContextCapture previousContext,
        LinuxCgroupContextCapture currentContext, DateTimeOffset now,
        TimeSpan maximumCaptureAge, TimeSpan maximumContextAge)
    {
        ArgumentNullException.ThrowIfNull(previousContext);
        ArgumentNullException.ThrowIfNull(currentContext);
        if (maximumCaptureAge <= TimeSpan.Zero || maximumContextAge <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(maximumCaptureAge));
        }
        if (previous.State == MemoryObservationState.Stale || current.State == MemoryObservationState.Stale)
        {
            return Refuse(MemoryPressureTransition.Stale);
        }
        if (!previous.Captured || !current.Captured || previous.Failure is not null || current.Failure is not null
            || previous.State != MemoryObservationState.Available || current.State != MemoryObservationState.Available
            || string.IsNullOrWhiteSpace(previous.Source) || string.IsNullOrWhiteSpace(current.Source)
            || previous.StartedAt is null || current.StartedAt is null
            || previous.CompletedAt is null || current.CompletedAt is null
            || previous.Timestamp is null || current.Timestamp is null
            || previous.CompletedTimestamp is null || current.CompletedTimestamp is null
            || previous.TimestampFrequency is null || current.TimestampFrequency is null)
        {
            return Refuse(MemoryPressureTransition.Unknown);
        }
        if (previous.Source != current.Source)
        {
            return Refuse(MemoryPressureTransition.SourceChanged);
        }
        if (!ValidWindow(previous, maximumCaptureAge) || !ValidWindow(current, maximumCaptureAge)
            || previous.TimestampFrequency != current.TimestampFrequency
            || previous.CompletedTimestamp > current.Timestamp
            || previous.CompletedAt > current.StartedAt || current.CompletedAt > now)
        {
            return Refuse(MemoryPressureTransition.ClockDiscontinuity);
        }
        if (now - previous.StartedAt.Value > maximumCaptureAge || now - current.StartedAt.Value > maximumCaptureAge)
        {
            return Refuse(MemoryPressureTransition.Stale);
        }
        return LinuxCgroupCounterNormalizer.Compare(
            new(previous.Counter, previous.Unit, previous.State, previous.Value, previous.Identity),
            new(current.Counter, current.Unit, current.State, current.Value, current.Identity),
            previousContext, currentContext, now, maximumContextAge);
    }

    private static bool ValidWindow(LinuxCgroupTimedCounterCapture capture, TimeSpan maximumAge)
    {
        if (capture.TimestampFrequency is not > 0 || capture.StartedAt > capture.CompletedAt)
        {
            return false;
        }
        try
        {
            long elapsed = checked(capture.CompletedTimestamp!.Value - capture.Timestamp!.Value);
            return elapsed >= 0 && elapsed / (double)capture.TimestampFrequency.Value <= maximumAge.TotalSeconds
                && capture.CompletedAt!.Value - capture.StartedAt!.Value <= maximumAge;
        }
        catch (OverflowException)
        {
            return false;
        }
    }

    private static MemoryPressureDelta Refuse(MemoryPressureTransition transition)
        => new(transition, null, null);
}
