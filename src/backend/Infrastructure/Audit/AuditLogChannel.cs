using System.Collections.Concurrent;
using System.Diagnostics.CodeAnalysis;
using System.Threading.Channels;

namespace FsusBlog.Server.Infrastructure.Audit;

public sealed class AuditLogChannel
{
    private readonly Channel<AuditRecord> _bestEffortChannel;
    private readonly Channel<AuditRecord> _durableChannel;
    private readonly ConcurrentDictionary<string, long> _droppedBySourceType = new(StringComparer.Ordinal);
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
        _bestEffortChannel = Channel.CreateBounded<AuditRecord>(options);
        _durableChannel = Channel.CreateUnbounded<AuditRecord>(new UnboundedChannelOptions
        {
            SingleReader = true,
            SingleWriter = false
        });
    }

    public ChannelReader<AuditRecord> Reader => _bestEffortChannel.Reader;

    public bool TryWrite(AuditRecord record)
    {
        ChannelWriter<AuditRecord> writer = record.RequiresDurableWrite
            ? _durableChannel.Writer
            : _bestEffortChannel.Writer;
        bool written = writer.TryWrite(record);
        if (!written)
        {
            Interlocked.Increment(ref _droppedCount);
            _droppedBySourceType.AddOrUpdate(
                $"{record.Source}:{record.Type}",
                1,
                static (_, current) => current + 1);
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
            Volatile.Read(ref _droppedCount),
            _droppedBySourceType.ToDictionary(
                static pair => pair.Key,
                static pair => pair.Value,
                StringComparer.Ordinal));

    internal async ValueTask<bool> WaitToReadAsync(CancellationToken cancellationToken)
    {
        while (true)
        {
            if (_durableChannel.Reader.TryPeek(out _)
                || _bestEffortChannel.Reader.TryPeek(out _))
            {
                return true;
            }

            Task<bool> durableTask = _durableChannel.Reader.WaitToReadAsync(cancellationToken).AsTask();
            Task<bool> bestEffortTask = _bestEffortChannel.Reader.WaitToReadAsync(cancellationToken).AsTask();
            Task<bool> completed = await Task.WhenAny(durableTask, bestEffortTask);
            if (await completed)
            {
                return true;
            }

            if (!await durableTask && !await bestEffortTask)
            {
                return false;
            }
        }
    }

    internal async ValueTask<AuditRecord> ReadAsync(CancellationToken cancellationToken)
    {
        if (_durableChannel.Reader.TryRead(out AuditRecord? durable))
        {
            MarkRead();
            return durable;
        }

        AuditRecord record = await _bestEffortChannel.Reader.ReadAsync(cancellationToken);
        MarkRead();
        return record;
    }

    internal bool TryRead([NotNullWhen(true)] out AuditRecord? record)
    {
        if (_durableChannel.Reader.TryRead(out record)
            || _bestEffortChannel.Reader.TryRead(out record))
        {
            MarkRead();
            return true;
        }

        return false;
    }

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

public sealed record AuditLogChannelSnapshot(
    long QueuedCount,
    long DroppedCount,
    IReadOnlyDictionary<string, long> DroppedBySourceType);
