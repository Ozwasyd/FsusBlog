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
}
