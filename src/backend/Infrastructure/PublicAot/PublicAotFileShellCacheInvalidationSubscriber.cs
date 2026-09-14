using FsusBlog.Server.Infrastructure.Cache;

using System.Threading.Channels;

using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed class PublicAotFileShellCacheInvalidationSubscriber(
    IRedisOperationExecutor redis,
    PublicAotFileShellCache cache,
    ILogger<PublicAotFileShellCacheInvalidationSubscriber> logger) : BackgroundService
{
    private readonly Channel<PublicAotInvalidationMessage> _messages = Channel.CreateBounded<PublicAotInvalidationMessage>(
        new BoundedChannelOptions(1024)
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.DropWrite
        });

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

            if (!_messages.Writer.TryWrite(invalidation))
            {
                logger.LogWarning("public_aot_remote_invalidation_buffer_full {Type}", invalidation.Type);
            }
        });

        try
        {
            await foreach (PublicAotInvalidationMessage invalidation in _messages.Reader
                .ReadAllAsync(stoppingToken).ConfigureAwait(false))
            {
                try
                {
                    _ = await cache.ApplyRemoteInvalidation(invalidation, stoppingToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    logger.LogWarning(ex, "public_aot_remote_invalidation_failed {Type}", invalidation.Type);
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
        finally
        {
            _messages.Writer.TryComplete();
            await redis.ExecuteAsync(
                    RedisOperationPort.PublicAotInvalidationDelivery,
                    (_, _) => subscriber.UnsubscribeAsync(channel),
                    CancellationToken.None)
                .ConfigureAwait(false);
        }
    }
}
