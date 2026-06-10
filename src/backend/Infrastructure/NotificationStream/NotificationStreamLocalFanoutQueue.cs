using System.Threading.Channels;

namespace FsusBlog.Server.Infrastructure.NotificationStream;

public sealed class NotificationStreamLocalFanoutQueue
{
    private readonly Channel<NotificationStreamLocalFanoutWorkItem> _channel;
    private long _droppedCount;

    public NotificationStreamLocalFanoutQueue(IConfiguration configuration)
    {
        int capacity = Math.Clamp(configuration.GetValue<int?>("NotificationStream:LocalFanoutQueueCapacity") ?? 4096, 128, 65_536);
        _channel = Channel.CreateBounded<NotificationStreamLocalFanoutWorkItem>(new BoundedChannelOptions(capacity)
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.DropWrite,
            AllowSynchronousContinuations = false
        });
    }

    public bool TryEnqueue(SharedNotificationStreamFrame frame, NotificationStreamTarget target)
    {
        frame.Retain();
        if (_channel.Writer.TryWrite(new NotificationStreamLocalFanoutWorkItem(frame, target)))
        {
            return true;
        }

        frame.Release();
        Interlocked.Increment(ref _droppedCount);
        return false;
    }

    public long DroppedCount => Volatile.Read(ref _droppedCount);

    internal ChannelReader<NotificationStreamLocalFanoutWorkItem> Reader => _channel.Reader;
}

internal readonly record struct NotificationStreamLocalFanoutWorkItem(SharedNotificationStreamFrame Frame, NotificationStreamTarget Target);

public sealed class NotificationStreamLocalFanoutWorker(
    NotificationStreamLocalFanoutQueue queue,
    NotificationStreamConnectionManager connectionManager,
    ILogger<NotificationStreamLocalFanoutWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (NotificationStreamLocalFanoutWorkItem item in queue.Reader.ReadAllAsync(stoppingToken).ConfigureAwait(false))
        {
            try
            {
                int delivered = connectionManager.Publish(item.Frame, item.Target);
                logger.LogDebug("notification-stream-local-fanout-delivered {Delivered}", delivered);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "notification-stream-local-fanout-failed");
            }
            finally
            {
                item.Frame.Release();
            }
        }
    }
}
