using System.Threading.Channels;

namespace FsusBlog.Server.Infrastructure.Audit;

public sealed class AuditLogChannel
{
    private readonly Channel<AuditRecord> _channel;
    private long _droppedCount;
    private long _queuedCount;

    public AuditLogChannel()
        : this(new BoundedChannelOptions(20_000)
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.Wait
        })
    {
    }

    internal AuditLogChannel(BoundedChannelOptions options)
    {
        _channel = Channel.CreateBounded<AuditRecord>(options);
    }

    public ChannelReader<AuditRecord> Reader => _channel.Reader;

    public bool TryWrite(AuditRecord record)
    {
        bool written = _channel.Writer.TryWrite(record);
        if (!written)
        {
            Interlocked.Increment(ref _droppedCount);
            return false;
        }

        Interlocked.Increment(ref _queuedCount);
        return true;
    }

    public long DrainDroppedCount()
        => Interlocked.Exchange(ref _droppedCount, 0);

    public AuditLogChannelSnapshot Snapshot()
        => new(
            Volatile.Read(ref _queuedCount),
            Volatile.Read(ref _droppedCount));

    internal void MarkRead()
    {
        long current;
        do
        {
            current = Volatile.Read(ref _queuedCount);
            if (current <= 0)
            {
                return;
            }
        }
        while (Interlocked.CompareExchange(ref _queuedCount, current - 1, current) != current);
    }
}

public sealed record AuditLogChannelSnapshot(long QueuedCount, long DroppedCount);
