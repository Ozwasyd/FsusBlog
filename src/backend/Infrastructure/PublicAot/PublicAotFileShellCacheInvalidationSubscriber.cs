using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed class PublicAotFileShellCacheInvalidationSubscriber(
    IConnectionMultiplexer redis,
    PublicAotFileShellCache cache,
    ILogger<PublicAotFileShellCacheInvalidationSubscriber> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        ISubscriber subscriber = redis.GetSubscriber();
        RedisChannel channel = RedisChannel.Literal(PublicAotInvalidationMessage.Channel);
        ChannelMessageQueue queue = await subscriber.SubscribeAsync(channel).ConfigureAwait(false);
        queue.OnMessage(message =>
        {
            if (!PublicAotInvalidationMessage.TryParse(message.Message, out PublicAotInvalidationMessage invalidation))
            {
                logger.LogDebug("public_aot_invalidation_message_ignored");
                return;
            }

            try
            {
                _ = cache.ApplyRemoteInvalidation(invalidation);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "public_aot_remote_invalidation_failed {Type}", invalidation.Type);
            }
        });

        try
        {
            await Task.Delay(Timeout.InfiniteTimeSpan, stoppingToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
        finally
        {
            await subscriber.UnsubscribeAsync(channel).ConfigureAwait(false);
        }
    }
}
