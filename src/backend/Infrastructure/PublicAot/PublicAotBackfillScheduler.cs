using System.Collections.Concurrent;
using System.Globalization;
using System.Threading.Channels;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed class PublicAotBackfillScheduler : IPublicAotBackfillScheduler
{
    private readonly Channel<PublicAotBackfillRequest> _channel;
    private readonly ConcurrentDictionary<string, byte> _inFlight = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, byte> _inFlightRouteKeys = new(StringComparer.Ordinal);
    private readonly PublicAotSsrRuntimeState _runtimeState;
    private readonly int _queueCapacity;
    internal int InFlightCount => _inFlight.Count;
    internal int InFlightRouteKeyCount => _inFlightRouteKeys.Count;

    public PublicAotBackfillScheduler(IConfiguration configuration)
        : this(configuration, new PublicAotSsrRuntimeState(configuration))
    {
    }

    public PublicAotBackfillScheduler(IConfiguration configuration, PublicAotSsrRuntimeState runtimeState)
    {
        _runtimeState = runtimeState;
        int queueCapacity = Math.Clamp(configuration.GetValue<int?>("PublicAot:BackfillQueueCapacity") ?? 512, 32, 4096);
        _queueCapacity = queueCapacity;
        _channel = Channel.CreateBounded<PublicAotBackfillRequest>(
            new BoundedChannelOptions(queueCapacity)
            {
                SingleReader = false,
                SingleWriter = false,
                FullMode = BoundedChannelFullMode.Wait,
                AllowSynchronousContinuations = false
            });
    }

    internal int QueueCapacity => _queueCapacity;

    public bool TrySchedule(PublicAotBackfillRequest request)
    {
        if (!_runtimeState.TryBeginBackfill(request, out string blockReason))
        {
            _runtimeState.RecordBackfillDropped(request, blockReason, InFlightCount);
            return false;
        }

        string routeIdentity = BuildRouteIdentity(request);
        if (!_inFlightRouteKeys.TryAdd(routeIdentity, 0))
        {
            _runtimeState.RecordBackfillDropped(request, "duplicate-route-key", InFlightCount);
            return false;
        }

        if (!_inFlight.TryAdd(request.CacheKey, 0))
        {
            _inFlightRouteKeys.TryRemove(routeIdentity, out _);
            _runtimeState.RecordBackfillDropped(request, "duplicate-cache-key", InFlightCount);
            return false;
        }

        if (_channel.Writer.TryWrite(request))
        {
            _runtimeState.RecordBackfillScheduled(request, InFlightCount);
            return true;
        }

        _inFlight.TryRemove(request.CacheKey, out _);
        _inFlightRouteKeys.TryRemove(routeIdentity, out _);
        _runtimeState.RecordBackfillDropped(request, "queue-full", InFlightCount);
        return false;
    }

    internal IAsyncEnumerable<PublicAotBackfillRequest> ReadAllAsync(CancellationToken cancellationToken)
        => _channel.Reader.ReadAllAsync(cancellationToken);

    internal void Complete(PublicAotBackfillRequest request)
    {
        _inFlight.TryRemove(request.CacheKey, out _);
        _inFlightRouteKeys.TryRemove(BuildRouteIdentity(request), out _);
    }

    private static string BuildRouteIdentity(PublicAotBackfillRequest request)
        => string.Create(
            CultureInfo.InvariantCulture,
            $"{request.TestSessionId ?? string.Empty}|{request.Kind}|{request.RouteKey}");
}
