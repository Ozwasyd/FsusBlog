using System.Runtime.CompilerServices;
using System.Threading.Channels;

using FsusBlog.Server.Infrastructure.Cache;

using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.Distributed;

public sealed class RedisDistributedInvalidationTransport(
    IConnectionMultiplexer redis,
    IRuntimeKeyScope runtimeKeyScope,
    DistributedInvalidationOptions options,
    TimeProvider timeProvider) : IDistributedInvalidationTransport
{
    private readonly DistributedInvalidationTopologyManifest _topology = options.Topology
        ?? throw new InvalidOperationException("distributed_invalidation_topology_manifest_required");
    private readonly RedisChannel _channel = RedisChannel.Literal(
        runtimeKeyScope.PrefixKey(options.Channel));

    public async Task<DistributedInvalidationTransportPublishResult> PublishAsync(
        string payload,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        try
        {
            long subscriberCount = await redis.GetSubscriber()
                .PublishAsync(_channel, payload)
                .ConfigureAwait(false);
            return DistributedInvalidationTransportPublishResult.Observe(
                _channel.ToString(),
                subscriberCount,
                _topology,
                _topology.SubscriberNodeIds.Contains(options.NodeId, StringComparer.Ordinal),
                timeProvider);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
        {
            return DistributedInvalidationTransportPublishResult.Failed(
                _channel.ToString(),
                _topology,
                _topology.SubscriberNodeIds.Contains(options.NodeId, StringComparer.Ordinal),
                timeProvider,
                exception.GetType().Name);
        }
    }

    public async IAsyncEnumerable<string> ReadAllAsync(
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        ISubscriber subscriber = redis.GetSubscriber();
        var messages = Channel.CreateUnbounded<string>(new UnboundedChannelOptions
        {
            SingleReader = true,
            SingleWriter = false,
            AllowSynchronousContinuations = false
        });
        ChannelMessageQueue queue = await subscriber.SubscribeAsync(_channel).ConfigureAwait(false);
        queue.OnMessage(message =>
        {
            if (!message.Message.IsNullOrEmpty)
            {
                messages.Writer.TryWrite(message.Message.ToString());
            }
        });

        try
        {
            await foreach (string payload in messages.Reader.ReadAllAsync(cancellationToken).ConfigureAwait(false))
            {
                yield return payload;
            }
        }
        finally
        {
            messages.Writer.TryComplete();
            await subscriber.UnsubscribeAsync(_channel).ConfigureAwait(false);
        }
    }
}
