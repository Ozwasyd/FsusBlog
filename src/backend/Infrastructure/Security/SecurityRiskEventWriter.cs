using System.Diagnostics;
using System.Threading.Channels;
using Microsoft.Extensions.Options;

namespace FsusBlog.Server.Infrastructure.Security;

public sealed class SecurityRiskEventWriterOptions
{
    public const string SectionName = "Security:RiskEventWriter";

    public int Capacity { get; set; } = 20_000;

    public int BatchSize { get; set; } = 256;

    public int FlushWindowMs { get; set; } = 500;
}

public sealed record SecurityRiskEventWriteQueueSnapshot(long QueuedCount, long DroppedCount);

public sealed class SecurityRiskEventWriteQueue
{
    private readonly Channel<SecurityRiskEventWrite> _channel;
    private readonly ILogger<SecurityRiskEventWriteQueue> _logger;
    private long _queuedCount;
    private long _droppedCount;

    public SecurityRiskEventWriteQueue(
        IOptions<SecurityRiskEventWriterOptions> options,
        ILogger<SecurityRiskEventWriteQueue> logger)
    {
        SecurityRiskEventWriterOptions value = options.Value;
        _logger = logger;
        _channel = Channel.CreateBounded<SecurityRiskEventWrite>(new BoundedChannelOptions(Math.Clamp(value.Capacity, 1, 1_000_000))
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.Wait
        });
    }

    public ChannelReader<SecurityRiskEventWrite> Reader => _channel.Reader;

    public bool TryWrite(SecurityRiskEventWrite write)
    {
        if (!_channel.Writer.TryWrite(write))
        {
            Interlocked.Increment(ref _droppedCount);
            _logger.LogWarning(
                "security-risk-event-queue-full Source={Source} Reason={Reason} Action={Action} TraceId={TraceId}",
                write.Source,
                write.Reason,
                write.Action,
                write.TraceId);
            return false;
        }

        Interlocked.Increment(ref _queuedCount);
        return true;
    }

    public bool TryRead(out SecurityRiskEventWrite write)
    {
        if (!_channel.Reader.TryRead(out write))
        {
            return false;
        }

        MarkRead();
        return true;
    }

    public SecurityRiskEventWriteQueueSnapshot Snapshot()
        => new(
            Volatile.Read(ref _queuedCount),
            Volatile.Read(ref _droppedCount));

    private void MarkRead()
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

public sealed class SecurityRiskEventWriterWorker(
    SecurityRiskEventWriteQueue queue,
    IServiceScopeFactory scopeFactory,
    IOptions<SecurityRiskEventWriterOptions> options,
    ILogger<SecurityRiskEventWriterWorker> logger) : BackgroundService
{
    private readonly SecurityRiskEventWriteQueue _queue = queue;
    private readonly IServiceScopeFactory _scopeFactory = scopeFactory;
    private readonly ILogger<SecurityRiskEventWriterWorker> _logger = logger;
    private readonly int _batchSize = Math.Clamp(options.Value.BatchSize, 1, 10_000);
    private readonly TimeSpan _flushWindow = TimeSpan.FromMilliseconds(Math.Clamp(options.Value.FlushWindowMs, 1, 60_000));

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var batch = new List<SecurityRiskEventWrite>(_batchSize);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                if (!await _queue.Reader.WaitToReadAsync(stoppingToken))
                {
                    continue;
                }

                batch.Clear();
                if (!_queue.TryRead(out SecurityRiskEventWrite first))
                {
                    continue;
                }

                batch.Add(first);
                await FillBatchUntilFlushWindowAsync(batch, stoppingToken);
                await PersistSafelyAsync(batch, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "security-risk-event writer loop recovered from an unexpected failure.");
            }
        }

        using var drainCts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        await DrainRemainingAsync(drainCts.Token);
    }

    public async Task<int> FlushOnceAsync(CancellationToken cancellationToken)
    {
        var batch = new List<SecurityRiskEventWrite>(_batchSize);
        while (batch.Count < _batchSize && _queue.TryRead(out SecurityRiskEventWrite write))
        {
            batch.Add(write);
        }

        if (batch.Count == 0)
        {
            return 0;
        }

        await PersistSafelyAsync(batch, cancellationToken);
        return batch.Count;
    }

    internal async Task PersistSafelyAsync(IReadOnlyList<SecurityRiskEventWrite> batch, CancellationToken cancellationToken)
    {
        try
        {
            await using AsyncServiceScope scope = _scopeFactory.CreateAsyncScope();
            ISecurityRiskEventStore store = scope.ServiceProvider.GetRequiredService<ISecurityRiskEventStore>();
            foreach (SecurityRiskEventWrite write in batch)
            {
                await store.AppendAsync(write, cancellationToken);
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            SecurityRiskEventWrite first = batch[0];
            _logger.LogWarning(
                ex,
                "security-risk-persist-failed Count={Count} Source={Source} Reason={Reason} Action={Action} TraceId={TraceId}",
                batch.Count,
                first.Source,
                first.Reason,
                first.Action,
                first.TraceId);
        }
    }

    private async Task FillBatchUntilFlushWindowAsync(List<SecurityRiskEventWrite> batch, CancellationToken stoppingToken)
    {
        long startedAt = Stopwatch.GetTimestamp();
        while (batch.Count < _batchSize)
        {
            while (batch.Count < _batchSize && _queue.TryRead(out SecurityRiskEventWrite ready))
            {
                batch.Add(ready);
            }

            if (batch.Count >= _batchSize)
            {
                return;
            }

            TimeSpan remaining = _flushWindow - Stopwatch.GetElapsedTime(startedAt);
            if (remaining <= TimeSpan.Zero)
            {
                return;
            }

            ValueTask<bool> waitToRead = _queue.Reader.WaitToReadAsync(stoppingToken);
            if (waitToRead.IsCompletedSuccessfully)
            {
                if (!waitToRead.Result)
                {
                    return;
                }

                continue;
            }

            Task delay = Task.Delay(remaining, stoppingToken);
            Task<bool> waitTask = waitToRead.AsTask();
            Task completed = await Task.WhenAny(waitTask, delay);
            if (completed == delay)
            {
                return;
            }

            if (!await waitTask)
            {
                return;
            }
        }
    }

    private async Task DrainRemainingAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            int flushed = await FlushOnceAsync(cancellationToken);
            if (flushed == 0)
            {
                return;
            }
        }
    }
}
