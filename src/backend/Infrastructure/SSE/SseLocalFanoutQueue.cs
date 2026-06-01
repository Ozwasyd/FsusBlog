using System.Threading.Channels;

namespace FsusBlog.Server.Infrastructure.Sse;

public sealed class SseLocalFanoutQueue
{
    private readonly Channel<SseLocalFanoutWorkItem> _channel;
    private long _droppedCount;

    public SseLocalFanoutQueue(IConfiguration configuration)
    {
        int capacity = Math.Clamp(configuration.GetValue<int?>("Sse:LocalFanoutQueueCapacity") ?? 4096, 128, 65_536);
        _channel = Channel.CreateBounded<SseLocalFanoutWorkItem>(new BoundedChannelOptions(capacity)
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.DropWrite,
            AllowSynchronousContinuations = false
        });
    }

    public bool TryEnqueue(SharedSseFrame frame, SseTarget target)
    {
        frame.Retain();
        if (_channel.Writer.TryWrite(new SseLocalFanoutWorkItem(frame, target)))
        {
            return true;
        }

        frame.Release();
        Interlocked.Increment(ref _droppedCount);
        return false;
    }

    public long DroppedCount => Volatile.Read(ref _droppedCount);

    internal ChannelReader<SseLocalFanoutWorkItem> Reader => _channel.Reader;
}

internal readonly record struct SseLocalFanoutWorkItem(SharedSseFrame Frame, SseTarget Target);

public sealed class SseLocalFanoutWorker(
    SseLocalFanoutQueue queue,
    SseConnectionManager connectionManager,
    ILogger<SseLocalFanoutWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (SseLocalFanoutWorkItem item in queue.Reader.ReadAllAsync(stoppingToken).ConfigureAwait(false))
        {
            try
            {
                int delivered = connectionManager.Publish(item.Frame, item.Target);
                logger.LogDebug("sse-local-fanout-delivered {Delivered}", delivered);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "sse-local-fanout-failed");
            }
            finally
            {
                item.Frame.Release();
            }
        }
    }
}
