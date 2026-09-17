using System.Threading.Channels;

using FsusBlog.Server.Infrastructure.Cache;

using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.PublicAot;

internal readonly record struct PublicAotFileShellInvalidationQueueSnapshot(
    long QueuedCount,
    long InFlightCount,
    long CoalescedAllPendingCount,
    long TerminalFailureCount,
    long Sequence,
    long CoalescedCount);

/// <summary>
/// Bounded wake-up lane for file-shell invalidation. Saturation is represented by
/// one dominating invalidate-all marker instead of silently dropping a key or prefix.
/// </summary>
public sealed class PublicAotFileShellInvalidationQueue
{
    internal const int DefaultCapacity = 1024;

    private readonly Channel<PublicAotInvalidationMessage> _messages;
    private long _queuedCount;
    private long _inFlightCount;
    private long _coalescedAllPending;
    private long _terminalFailureCount;
    private long _sequence;
    private long _coalescedCount;

    public PublicAotFileShellInvalidationQueue()
        : this(DefaultCapacity)
    {
    }

    internal PublicAotFileShellInvalidationQueue(int capacity)
    {
        _messages = Channel.CreateBounded<PublicAotInvalidationMessage>(
            new BoundedChannelOptions(Math.Max(1, capacity))
            {
                SingleReader = true,
                SingleWriter = false,
                FullMode = BoundedChannelFullMode.Wait
            });
    }

    internal bool TryWrite(PublicAotInvalidationMessage invalidation)
    {
        if (_messages.Writer.TryWrite(invalidation))
        {
            Interlocked.Increment(ref _queuedCount);
            Interlocked.Increment(ref _sequence);
            return true;
        }

        Interlocked.Exchange(ref _coalescedAllPending, 1);
        Interlocked.Increment(ref _coalescedCount);
        Interlocked.Increment(ref _sequence);
        return false;
    }

    internal async IAsyncEnumerable<PublicAotInvalidationMessage> ReadAllAsync(
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken)
    {
        await foreach (PublicAotInvalidationMessage invalidation in _messages.Reader
            .ReadAllAsync(cancellationToken).ConfigureAwait(false))
        {
            MarkRead();
            yield return invalidation;
        }
    }

    internal bool TryTakeCoalescedAll(out PublicAotInvalidationMessage invalidation)
    {
        if (Interlocked.Exchange(ref _coalescedAllPending, 0) == 0)
        {
            invalidation = default;
            return false;
        }

        Interlocked.Increment(ref _inFlightCount);
        invalidation = PublicAotInvalidationMessage.All();
        return true;
    }

    internal void MarkProcessed()
    {
        Decrement(ref _inFlightCount);
        Interlocked.Exchange(ref _terminalFailureCount, 0);
    }

    internal void MarkFailedForRetry()
    {
        Decrement(ref _inFlightCount);
        Interlocked.Exchange(ref _coalescedAllPending, 1);
        Interlocked.Exchange(ref _terminalFailureCount, 1);
    }

    internal void Complete() => _messages.Writer.TryComplete();

    internal PublicAotFileShellInvalidationQueueSnapshot Snapshot()
        => new(
            Volatile.Read(ref _queuedCount),
            Volatile.Read(ref _inFlightCount),
            Volatile.Read(ref _coalescedAllPending),
            Volatile.Read(ref _terminalFailureCount),
            Volatile.Read(ref _sequence),
            Volatile.Read(ref _coalescedCount));

    internal bool TryReadForTests(out PublicAotInvalidationMessage invalidation)
    {
        if (!_messages.Reader.TryRead(out invalidation))
        {
            return false;
        }

        MarkRead();
        return true;
    }

    private void MarkRead()
    {
        Decrement(ref _queuedCount);
        Interlocked.Increment(ref _inFlightCount);
    }

    private static void Decrement(ref long value)
    {
        long current;
        do
        {
            current = Volatile.Read(ref value);
            if (current <= 0)
            {
                return;
            }
        }
        while (Interlocked.CompareExchange(ref value, current - 1, current) != current);
    }
}

public sealed class PublicAotFileShellCacheInvalidationSubscriber(
    IRedisOperationExecutor redis,
    PublicAotFileShellCache cache,
    PublicAotFileShellInvalidationQueue messages,
    ILogger<PublicAotFileShellCacheInvalidationSubscriber> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        RedisChannel channel = RedisChannel.Literal(PublicAotInvalidationMessage.Channel);
        (ISubscriber subscriber, ChannelMessageQueue queue) = await redis.ExecuteAsync(
                RedisOperationPort.PublicAotInvalidationDelivery,
                async (multiplexer, _) =>
                {
                    ISubscriber subscriber = multiplexer.GetSubscriber();
                    ChannelMessageQueue queue = await subscriber.SubscribeAsync(channel).ConfigureAwait(false);
                    return (subscriber, queue);
                },
                stoppingToken)
            .ConfigureAwait(false);
        queue.OnMessage(message =>
        {
            if (!PublicAotInvalidationMessage.TryParse(message.Message, out PublicAotInvalidationMessage invalidation))
            {
                logger.LogDebug("public_aot_invalidation_message_ignored");
                return;
            }

            if (!messages.TryWrite(invalidation))
            {
                logger.LogWarning(
                    "public_aot_remote_invalidation_buffer_full {Type} Disposition=coalesced-all",
                    invalidation.Type);
            }
        });

        try
        {
            await foreach (PublicAotInvalidationMessage invalidation in messages
                .ReadAllAsync(stoppingToken).ConfigureAwait(false))
            {
                await ApplyWithFailClosedRetryAsync(invalidation, stoppingToken).ConfigureAwait(false);
                while (messages.TryTakeCoalescedAll(out PublicAotInvalidationMessage coalesced))
                {
                    await ApplyWithFailClosedRetryAsync(coalesced, stoppingToken).ConfigureAwait(false);
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
        finally
        {
            messages.Complete();
            await redis.ExecuteAsync(
                    RedisOperationPort.PublicAotInvalidationDelivery,
                    (_, _) => subscriber.UnsubscribeAsync(channel),
                    CancellationToken.None)
                .ConfigureAwait(false);
        }
    }

    private async Task ApplyWithFailClosedRetryAsync(
        PublicAotInvalidationMessage invalidation,
        CancellationToken stoppingToken)
    {
        try
        {
            _ = await cache.ApplyRemoteInvalidation(invalidation, stoppingToken).ConfigureAwait(false);
            messages.MarkProcessed();
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            messages.MarkFailedForRetry();
            throw;
        }
        catch (Exception ex)
        {
            messages.MarkFailedForRetry();
            logger.LogError(
                ex,
                "public_aot_remote_invalidation_failed {Type} Disposition=retry-as-all",
                invalidation.Type);
            await Task.Delay(TimeSpan.FromMilliseconds(100), stoppingToken).ConfigureAwait(false);
        }
    }
}
