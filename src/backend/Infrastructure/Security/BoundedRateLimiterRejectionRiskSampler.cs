using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Infrastructure.Helpers;

using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace FsusBlog.Server.Infrastructure.Security;

internal enum RateLimiterRiskSampleDecision
{
    WriteRiskSignal = 0,
    DropWriteLimit = 1,
    DropCapacity = 2
}

internal readonly record struct RateLimiterRejectionSamplerSnapshot(
    long WindowMinute,
    int TrackedBucketCount,
    long WindowRotationCount,
    long WriteLimitDropCount,
    long CapacityDropCount);

internal sealed class BoundedRateLimiterRejectionRiskSampler
{
    private readonly int _maxRiskWritesPerBucket;
    private readonly int _maxTrackedBuckets;
    private readonly TimeProvider _timeProvider;
    private SamplerWindow _window;
    private int _rotationInProgress;
    private long _windowRotationCount;
    private long _writeLimitDropCount;
    private long _capacityDropCount;

    /// <summary>
    /// Creates a minute-window sampler that bounds both writes per logical bucket and the number of tracked buckets.
    /// </summary>
    /// <param name="maxRiskWritesPerBucket">Maximum risk signals emitted for one subject and route during a window.</param>
    /// <param name="maxTrackedBuckets">Maximum distinct subject-and-route buckets retained during a window.</param>
    /// <param name="timeProvider">Clock used to rotate sampling windows; the system clock is used when omitted.</param>
    public BoundedRateLimiterRejectionRiskSampler(
        int maxRiskWritesPerBucket,
        int maxTrackedBuckets,
        TimeProvider? timeProvider = null)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(maxRiskWritesPerBucket);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(maxTrackedBuckets);
        if (maxRiskWritesPerBucket == int.MaxValue)
        {
            throw new ArgumentOutOfRangeException(
                nameof(maxRiskWritesPerBucket),
                maxRiskWritesPerBucket,
                "The saturated counter requires one value above the write limit.");
        }
        _maxRiskWritesPerBucket = maxRiskWritesPerBucket;
        _maxTrackedBuckets = maxTrackedBuckets;
        _timeProvider = timeProvider ?? TimeProvider.System;
        _window = new SamplerWindow(long.MinValue, 1);
    }

    /// <summary>
    /// Samples a rejected request using its logical client identity and endpoint route.
    /// </summary>
    /// <param name="context">Rejected HTTP request whose risk-write eligibility is evaluated.</param>
    /// <returns>The decision to emit a signal or drop it because a configured bound was reached.</returns>
    public RateLimiterRiskSampleDecision Sample(HttpContext context)
    {
        ArgumentNullException.ThrowIfNull(context);
        long minute = _timeProvider.GetUtcNow().ToUnixTimeSeconds() / 60;
        return Sample(
            minute,
            context.GetClientIp(),
            RateLimiterRejectionRouteIdentity.Resolve(context));
    }

    internal RateLimiterRiskSampleDecision Sample(long minute, string logicalSubject, string logicalRoute)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(logicalSubject);
        ArgumentException.ThrowIfNullOrWhiteSpace(logicalRoute);

        SamplerWindow window = GetWindow(minute);
        var key = new SamplerBucketKey(logicalSubject, logicalRoute);
        if (window.BucketCounts.TryGetValue(key, out int currentCount))
        {
            return IncrementExisting(window, key, currentCount);
        }

        if (!TryReserveBucket(window))
        {
            // A concurrent request may have inserted this exact logical bucket
            // while this request observed the capacity boundary.
            if (window.BucketCounts.TryGetValue(key, out currentCount))
            {
                return IncrementExisting(window, key, currentCount);
            }

            Interlocked.Increment(ref _capacityDropCount);
            return RateLimiterRiskSampleDecision.DropCapacity;
        }

        if (window.BucketCounts.TryAdd(key, 1))
        {
            return RateLimiterRiskSampleDecision.WriteRiskSignal;
        }

        Interlocked.Decrement(ref window.ReservedBucketCount);
        if (window.BucketCounts.TryGetValue(key, out currentCount))
        {
            return IncrementExisting(window, key, currentCount);
        }

        Interlocked.Increment(ref _capacityDropCount);
        return RateLimiterRiskSampleDecision.DropCapacity;
    }

    internal RateLimiterRejectionSamplerSnapshot Snapshot()
    {
        SamplerWindow window = Volatile.Read(ref _window);
        return new RateLimiterRejectionSamplerSnapshot(
            window.Minute,
            Volatile.Read(ref window.ReservedBucketCount),
            Interlocked.Read(ref _windowRotationCount),
            Interlocked.Read(ref _writeLimitDropCount),
            Interlocked.Read(ref _capacityDropCount));
    }

    private RateLimiterRiskSampleDecision IncrementExisting(
        SamplerWindow window,
        SamplerBucketKey key,
        int currentCount)
    {
        while (currentCount <= _maxRiskWritesPerBucket)
        {
            int nextCount = currentCount + 1;
            if (window.BucketCounts.TryUpdate(key, nextCount, currentCount))
            {
                if (nextCount <= _maxRiskWritesPerBucket)
                {
                    return RateLimiterRiskSampleDecision.WriteRiskSignal;
                }

                Interlocked.Increment(ref _writeLimitDropCount);
                return RateLimiterRiskSampleDecision.DropWriteLimit;
            }

            if (!window.BucketCounts.TryGetValue(key, out currentCount))
            {
                Interlocked.Increment(ref _capacityDropCount);
                return RateLimiterRiskSampleDecision.DropCapacity;
            }
        }

        Interlocked.Increment(ref _writeLimitDropCount);
        return RateLimiterRiskSampleDecision.DropWriteLimit;
    }

    private bool TryReserveBucket(SamplerWindow window)
    {
        while (true)
        {
            int current = Volatile.Read(ref window.ReservedBucketCount);
            if (current >= _maxTrackedBuckets)
            {
                return false;
            }

            if (Interlocked.CompareExchange(ref window.ReservedBucketCount, current + 1, current) == current)
            {
                return true;
            }
        }
    }

    private SamplerWindow GetWindow(long minute)
    {
        var spinner = new SpinWait();
        while (true)
        {
            SamplerWindow current = Volatile.Read(ref _window);
            if (minute <= current.Minute)
            {
                return current;
            }

            if (Interlocked.CompareExchange(ref _rotationInProgress, 1, 0) != 0)
            {
                spinner.SpinOnce();
                continue;
            }

            try
            {
                current = Volatile.Read(ref _window);
                if (minute > current.Minute)
                {
                    current = new SamplerWindow(minute, _maxTrackedBuckets);
                    Volatile.Write(ref _window, current);
                    Interlocked.Increment(ref _windowRotationCount);
                }

                return current;
            }
            finally
            {
                Volatile.Write(ref _rotationInProgress, 0);
            }
        }
    }

    private readonly record struct SamplerBucketKey(string LogicalSubject, string LogicalRoute);

    private sealed class SamplerWindow(long minute, int capacity)
    {
        public long Minute { get; } = minute;

        public ConcurrentDictionary<SamplerBucketKey, int> BucketCounts
        {
            get;
        } = new(
            Math.Min(Environment.ProcessorCount, capacity),
            capacity);

        public int ReservedBucketCount;
    }
}

internal static class RateLimiterRejectionRouteIdentity
{
    private const int MaxInlineRouteIdentityLength = 192;

    /// <summary>
    /// Builds a bounded, method-qualified identity for the matched endpoint without retaining an oversized route value.
    /// </summary>
    /// <param name="context">Request containing the matched endpoint and HTTP method.</param>
    /// <returns>The normalized method and route identity, with long routes represented by a SHA-256 digest.</returns>
    public static string Resolve(HttpContext context)
    {
        ArgumentNullException.ThrowIfNull(context);
        string method = NormalizeMethod(context.Request.Method);
        Endpoint? endpoint = context.GetEndpoint();
        string route = endpoint switch
        {
            RouteEndpoint routeEndpoint when !string.IsNullOrWhiteSpace(routeEndpoint.RoutePattern.RawText)
                => routeEndpoint.RoutePattern.RawText!,
            _ when !string.IsNullOrWhiteSpace(endpoint?.DisplayName)
                => endpoint.DisplayName!,
            _ => "unmatched"
        };

        return string.Concat(method, '|', CompactRouteIdentity(route));
    }

    private static string NormalizeMethod(string method)
    {
        if (HttpMethods.IsGet(method))
            return "GET";
        if (HttpMethods.IsHead(method))
            return "HEAD";
        if (HttpMethods.IsPost(method))
            return "POST";
        if (HttpMethods.IsPut(method))
            return "PUT";
        if (HttpMethods.IsPatch(method))
            return "PATCH";
        if (HttpMethods.IsDelete(method))
            return "DELETE";
        if (HttpMethods.IsOptions(method))
            return "OPTIONS";
        return "OTHER";
    }

    private static string CompactRouteIdentity(string route)
    {
        if (route.Length <= MaxInlineRouteIdentityLength)
        {
            return route;
        }

        byte[] digest = SHA256.HashData(Encoding.UTF8.GetBytes(route));
        return string.Concat("sha256:", Convert.ToHexString(digest));
    }
}
