using System.Threading.Channels;

namespace FsusBlog.Server.Infrastructure.Audit;

public sealed class AuditLogChannel
{
    private readonly Channel<AuditRecord> _channel;
    private long _droppedCount;

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
        }

        return written;
    }

    public long DrainDroppedCount()
        => Interlocked.Exchange(ref _droppedCount, 0);
}
