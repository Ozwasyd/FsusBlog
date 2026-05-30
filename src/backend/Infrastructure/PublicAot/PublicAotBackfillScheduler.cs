using System.Collections.Concurrent;
using System.Threading.Channels;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed class PublicAotBackfillScheduler : IPublicAotBackfillScheduler
{
    private readonly Channel<PublicAotBackfillRequest> _channel;
    private readonly ConcurrentDictionary<string, byte> _inFlight = new(StringComparer.Ordinal);
    private readonly int _queueCapacity;
    internal int InFlightCount => _inFlight.Count;

    public PublicAotBackfillScheduler(IConfiguration configuration)
    {
        int queueCapacity = Math.Clamp(configuration.GetValue<int?>("PublicAot:BackfillQueueCapacity") ?? 512, 32, 4096);
        _queueCapacity = queueCapacity;
        _channel = Channel.CreateBounded<PublicAotBackfillRequest>(
            new BoundedChannelOptions(queueCapacity)
            {
                SingleReader = true,
                SingleWriter = false,
                FullMode = BoundedChannelFullMode.Wait,
                AllowSynchronousContinuations = false
            });
    }

    internal int QueueCapacity => _queueCapacity;

    public bool TrySchedule(PublicAotBackfillRequest request)
    {
        if (!_inFlight.TryAdd(request.CacheKey, 0))
        {
            return false;
        }

        if (_channel.Writer.TryWrite(request))
        {
            return true;
        }

        _inFlight.TryRemove(request.CacheKey, out _);
        return false;
    }

    internal IAsyncEnumerable<PublicAotBackfillRequest> ReadAllAsync(CancellationToken cancellationToken)
        => _channel.Reader.ReadAllAsync(cancellationToken);

    internal void Complete(PublicAotBackfillRequest request)
        => _inFlight.TryRemove(request.CacheKey, out _);
}
