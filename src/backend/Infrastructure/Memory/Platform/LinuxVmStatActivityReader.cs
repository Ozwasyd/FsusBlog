using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Pressure;

namespace FsusBlog.Server.Infrastructure.Memory.Platform;

/// <summary>
/// Raw host counters with the actual read window and observed system page size.
/// Field validity is independent; neither the host nor a process domain is qualified.
/// </summary>
internal readonly record struct LinuxVmStatActivityCapture(
    MemoryObservationState State,
    LinuxVmStatActivityParser.Activity Activity,
    LinuxVmStatActivityParser.SwapByteCounts SwapBytes,
    long? PageSizeBytes,
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
/// Reads only /proc/vmstat into caller-owned admitted scratch. The caller supplies
/// finite byte and duration bounds; this primitive creates no sampling scheduler.
/// Its file is operation-owned and the supplied scratch is cleared on every exit.
/// Native read failures remain unavailable; clock exceptions remain visible.
/// </summary>
internal static class LinuxVmStatActivityReader
{
    private static readonly string s_sourceIdentity = $"Linux.procfs.vmstat.host;pid={Environment.ProcessId};instance={Guid.NewGuid():D}";

    internal static LinuxVmStatActivityCapture Capture(TimeProvider clock, int maximumReadBytes,
        TimeSpan maximumDuration, Span<byte> admittedScratch, MemoryCapabilityMode mode = MemoryCapabilityMode.Auto)
    {
        try
        {
            ArgumentNullException.ThrowIfNull(clock);
            if (maximumReadBytes <= 0 || maximumReadBytes == int.MaxValue
                || admittedScratch.Length <= maximumReadBytes || maximumDuration <= TimeSpan.Zero
                || !Enum.IsDefined(mode))
            {
                return Empty(MemoryObservationState.Malformed, MemoryFailure.BoundsViolation);
            }
            if (mode == MemoryCapabilityMode.Disabled)
            {
                return Empty(MemoryObservationState.Unknown, null);
            }
            if (!OperatingSystem.IsLinux())
            {
                return Empty(MemoryObservationState.Unknown, MemoryFailure.UnsupportedCapability);
            }
            long frequency = clock.TimestampFrequency;
            if (frequency <= 0)
            {
                return Empty(MemoryObservationState.Malformed, MemoryFailure.BoundsViolation);
            }
            DateTimeOffset startedAt = clock.GetUtcNow();
            long started = clock.GetTimestamp();
            long pageSize = Environment.SystemPageSize;
            Span<byte> buffer = admittedScratch[..(maximumReadBytes + 1)];
            (MemoryObservationState State, int Length) read = Read(buffer);
            long completed = clock.GetTimestamp();
            DateTimeOffset completedAt = clock.GetUtcNow();
            MemoryObservationState state = read.State;
            try
            {
                long elapsed = checked(completed - started);
                if (frequency != clock.TimestampFrequency || completedAt < startedAt
                    || completedAt - startedAt > maximumDuration || elapsed < 0
                    || elapsed / (double)frequency > maximumDuration.TotalSeconds)
                {
                    state = MemoryObservationState.Stale;
                }
            }
            catch (OverflowException)
            {
                state = MemoryObservationState.Stale;
            }
            if (pageSize <= 0)
            {
                state = MemoryObservationState.Malformed;
            }
            LinuxVmStatActivityParser.Activity activity = state == MemoryObservationState.Available
                ? LinuxVmStatActivityParser.Parse(buffer[..read.Length]) : Unavailable(state);
            LinuxVmStatActivityParser.SwapByteCounts swapBytes = pageSize > 0
                ? LinuxVmStatActivityParser.ConvertSwapPagesToBytes(activity, pageSize)
                : new(new(MemoryObservationState.Malformed, null), new(MemoryObservationState.Malformed, null));
            return new(state, activity, swapBytes, pageSize > 0 ? pageSize : null, s_sourceIdentity,
                true, null, startedAt, completedAt, started, completed, frequency);
        }
        finally
        {
            admittedScratch.Clear();
        }
    }

    private static LinuxVmStatActivityCapture Empty(MemoryObservationState state, MemoryFailure? failure)
    {
        LinuxVmStatActivityParser.Activity activity = Unavailable(state);
        return new(state, activity, new(activity.SwapInPages, activity.SwapOutPages), null,
            s_sourceIdentity, false, failure, null, null, null, null, null);
    }

    private static LinuxVmStatActivityParser.Activity Unavailable(MemoryObservationState state)
        => new(new(state, null), new(state, null), new(state, null));

    private static (MemoryObservationState State, int Length) Read(Span<byte> buffer)
    {
        try
        {
            using var stream = new FileStream("/proc/vmstat", FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 1);
            int length = 0;
            while (length < buffer.Length)
            {
                int read = stream.Read(buffer[length..]);
                if (read == 0)
                {
                    return (MemoryObservationState.Available, length);
                }
                length += read;
            }
            return (MemoryObservationState.Malformed, 0);
        }
        catch (UnauthorizedAccessException)
        {
            return (MemoryObservationState.Denied, 0);
        }
        catch (IOException)
        {
            return (MemoryObservationState.Unknown, 0);
        }
    }
}
