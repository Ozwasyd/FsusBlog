namespace FsusBlog.Server.Infrastructure.Audit;

public sealed class AuditLogRuntimeState(AuditLogChannel channel)
{
    private readonly AuditLogChannel _channel = channel;
    private long _writeSuccessCount;
    private long _writeFailureCount;
    private long _fallbackWriteCount;
    private long _lastWriteSuccessTicks;
    private long _lastWriteFailureTicks;
    private long _lastFallbackWriteTicks;

    public void RecordWriteSuccess(int count)
    {
        if (count <= 0)
        {
            return;
        }

        Interlocked.Add(ref _writeSuccessCount, count);
        Volatile.Write(ref _lastWriteSuccessTicks, DateTime.UtcNow.Ticks);
    }

    public void RecordWriteFailure(int count)
    {
        if (count <= 0)
        {
            return;
        }

        Interlocked.Add(ref _writeFailureCount, count);
        Volatile.Write(ref _lastWriteFailureTicks, DateTime.UtcNow.Ticks);
    }

    public void RecordFallbackWrite(int count)
    {
        if (count <= 0)
        {
            return;
        }

        Interlocked.Add(ref _fallbackWriteCount, count);
        Volatile.Write(ref _lastFallbackWriteTicks, DateTime.UtcNow.Ticks);
    }

    public AuditLogRuntimeSnapshot Snapshot()
    {
        AuditLogChannelSnapshot channel = _channel.Snapshot();
        return new AuditLogRuntimeSnapshot(
            channel.QueuedCount,
            channel.DroppedCount,
            channel.DroppedBySourceType,
            Volatile.Read(ref _writeSuccessCount),
            Volatile.Read(ref _writeFailureCount),
            Volatile.Read(ref _fallbackWriteCount),
            FromTicks(Volatile.Read(ref _lastWriteSuccessTicks)),
            FromTicks(Volatile.Read(ref _lastWriteFailureTicks)),
            FromTicks(Volatile.Read(ref _lastFallbackWriteTicks)),
            channel.InFlightCount,
            channel.DurablePendingCount,
            channel.DurableAcceptedCount,
            channel.CommittedCount,
            channel.RequeuedCount,
            channel.RejectedCount,
            channel.TerminalFailureCount,
            channel.Sequence,
            channel.LastDisposition,
            channel.LastFailureReason,
            channel.LastItemReference);
    }

    private static DateTime? FromTicks(long ticks)
        => ticks <= 0 ? null : new DateTime(ticks, DateTimeKind.Utc);
}

public sealed record AuditLogRuntimeSnapshot(
    long QueuedCount,
    long DroppedCount,
    IReadOnlyDictionary<string, long> DroppedBySourceType,
    long WriteSuccessCount,
    long WriteFailureCount,
    long FallbackWriteCount,
    DateTime? LastWriteSuccessUtc,
    DateTime? LastWriteFailureUtc,
    DateTime? LastFallbackWriteUtc,
    long InFlightCount = 0,
    long DurablePendingCount = 0,
    long DurableAcceptedCount = 0,
    long CommittedCount = 0,
    long RequeuedCount = 0,
    long RejectedCount = 0,
    long TerminalFailureCount = 0,
    long Sequence = 0,
    string? LastDisposition = null,
    string? LastFailureReason = null,
    string? LastItemReference = null);
