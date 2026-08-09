using System.Runtime.CompilerServices;
using System.Threading.Channels;

using FsusBlog.Server.Infrastructure.Cache;

using Microsoft.Extensions.DependencyInjection;

using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.Distributed;

public sealed class RedisDistributedInvalidationTransport : IDistributedInvalidationTransport
{
    private readonly IConnectionMultiplexer _redis;
    private readonly TimeProvider _timeProvider;
    private readonly DistributedInvalidationOptions _options;
    private readonly DistributedInvalidationTopologyManifest _topology;
    private readonly RedisChannel _channel;
    private readonly DistributedInvalidationIngressRuntimeState _ingressRuntimeState;
    private readonly DistributedInvalidationIngressSink _ingressSink;

    public RedisDistributedInvalidationTransport(
        IConnectionMultiplexer redis,
        IRuntimeKeyScope runtimeKeyScope,
        DistributedInvalidationOptions options,
        TimeProvider timeProvider,
        IServiceScopeFactory? scopeFactory = null,
        DistributedInvalidationIngressRuntimeState? ingressRuntimeState = null,
        DistributedInvalidationRuntimeState? runtimeState = null)
    {
        _redis = redis;
        _timeProvider = timeProvider;
        _options = options;
        _topology = options.Topology
            ?? throw new InvalidOperationException("distributed_invalidation_topology_manifest_required");
        _channel = RedisChannel.Literal(runtimeKeyScope.PrefixKey(options.Channel));
        _ingressRuntimeState = ingressRuntimeState
            ?? new DistributedInvalidationIngressRuntimeState(options.IngressCapacity);
        _ingressSink = new DistributedInvalidationIngressSink(
            options,
            _ingressRuntimeState,
            runtimeState ?? new DistributedInvalidationRuntimeState(timeProvider),
            scopeFactory);
    }

    public async Task<DistributedInvalidationTransportPublishResult> PublishAsync(
        string payload,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        try
        {
            long subscriberCount = await _redis.GetSubscriber()
                .PublishAsync(_channel, payload)
                .ConfigureAwait(false);
            return DistributedInvalidationTransportPublishResult.Observe(
                _channel.ToString(),
                subscriberCount,
                _topology,
                _topology.SubscriberNodeIds.Contains(_options.NodeId, StringComparer.Ordinal),
                _timeProvider);
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
                _topology.SubscriberNodeIds.Contains(_options.NodeId, StringComparer.Ordinal),
                _timeProvider,
                exception.GetType().Name);
        }
    }

    public async IAsyncEnumerable<string> ReadAllAsync(
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        ISubscriber subscriber = _redis.GetSubscriber();
        var messages = Channel.CreateBounded<string>(new BoundedChannelOptions(_options.IngressCapacity)
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.Wait,
            AllowSynchronousContinuations = false
        });
        ChannelMessageQueue queue = await subscriber.SubscribeAsync(_channel).ConfigureAwait(false);
        queue.OnMessage(message =>
        {
            if (message.Message.IsNullOrEmpty)
            {
                return;
            }

            string payload = message.Message.ToString();
            _ = Task.Run(async () =>
            {
                try
                {
                    await _ingressSink.HandlePayloadAsync(payload, messages.Writer).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    // Shutdown path; durable inbox remains the recovery truth.
                }
                catch (Exception ex)
                {
                    _ingressRuntimeState.RecordDegraded($"ingress:unhandled:{ex.GetType().Name}");
                }
            });
        });

        try
        {
            await foreach (string item in messages.Reader.ReadAllAsync(cancellationToken).ConfigureAwait(false))
            {
                _ingressRuntimeState.RecordQueued(messages.Reader.Count);
                yield return item;
            }
        }
        finally
        {
            messages.Writer.TryComplete();
            await subscriber.UnsubscribeAsync(_channel).ConfigureAwait(false);
        }
    }
}
