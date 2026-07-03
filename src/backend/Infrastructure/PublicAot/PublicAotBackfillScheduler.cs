using System.Collections.Concurrent;
using System.Globalization;
using System.Threading.Channels;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed class PublicAotBackfillScheduler : IPublicAotBackfillScheduler
{
    private readonly Channel<PublicAotBackfillRequest> _channel;
    private readonly ConcurrentDictionary<string, long> _inFlight = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, long> _inFlightRouteKeys = new(StringComparer.Ordinal);
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
        if (!TryReserve(_inFlightRouteKeys, routeIdentity, request.ScheduledInvalidationVersion))
        {
            _runtimeState.RecordBackfillDropped(request, "duplicate-route-key", InFlightCount);
            return false;
        }

        if (!TryReserve(_inFlight, request.CacheKey, request.ScheduledInvalidationVersion))
        {
            RemoveReservation(_inFlightRouteKeys, routeIdentity, request.ScheduledInvalidationVersion);
            _runtimeState.RecordBackfillDropped(request, "duplicate-cache-key", InFlightCount);
            return false;
        }

        if (_channel.Writer.TryWrite(request))
        {
            _runtimeState.RecordBackfillScheduled(request, InFlightCount);
            return true;
        }

        RemoveReservation(_inFlight, request.CacheKey, request.ScheduledInvalidationVersion);
        RemoveReservation(_inFlightRouteKeys, routeIdentity, request.ScheduledInvalidationVersion);
        _runtimeState.RecordBackfillDropped(request, "queue-full", InFlightCount);
        return false;
    }

    internal IAsyncEnumerable<PublicAotBackfillRequest> ReadAllAsync(CancellationToken cancellationToken)
        => _channel.Reader.ReadAllAsync(cancellationToken);

    internal void Complete(PublicAotBackfillRequest request)
    {
        RemoveReservation(_inFlight, request.CacheKey, request.ScheduledInvalidationVersion);
        RemoveReservation(_inFlightRouteKeys, BuildRouteIdentity(request), request.ScheduledInvalidationVersion);
    }

    private static bool TryReserve(ConcurrentDictionary<string, long> reservations, string key, long version)
    {
        while (true)
        {
            if (!reservations.TryGetValue(key, out long existingVersion))
            {
                if (reservations.TryAdd(key, version))
                {
                    return true;
                }

                continue;
            }

            if (existingVersion >= version)
            {
                return false;
            }

            if (reservations.TryUpdate(key, version, existingVersion))
            {
                return true;
            }
        }
    }

    private static void RemoveReservation(ConcurrentDictionary<string, long> reservations, string key, long version)
        => ((ICollection<KeyValuePair<string, long>>)reservations).Remove(new KeyValuePair<string, long>(key, version));

    private static string BuildRouteIdentity(PublicAotBackfillRequest request)
        => string.Create(
            CultureInfo.InvariantCulture,
            $"{request.TestSessionId ?? string.Empty}|{request.Kind}|{request.RouteKey}");
}
