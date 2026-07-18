using System.Collections.Concurrent;

using FsusBlog.Server.Infrastructure.Execution;

namespace FsusBlog.Server.Infrastructure.Cache;

public readonly record struct CacheRebuildStrategy(TimeSpan LeaseTtl, TimeSpan WaitTimeout, TimeSpan PollInterval);

public interface ICacheMissCoordinator
{
    Task<T?> CoordinateAsync<T>(
        CachePolicyId policyId,
        string identity,
        Func<CancellationToken, Task<CacheReadResult<T>>> tryReadAsync,
        Func<CancellationToken, Task<T?>> rebuildAsync,
        string operation,
        CancellationToken cancellationToken = default,
        CacheRebuildStrategy? strategy = null);

    Task<T?> CoordinateAsync<T>(
        CachePolicyId policyId,
        int identity,
        Func<CancellationToken, Task<CacheReadResult<T>>> tryReadAsync,
        Func<CancellationToken, Task<T?>> rebuildAsync,
        string operation,
        CancellationToken cancellationToken = default,
        CacheRebuildStrategy? strategy = null)
        => CoordinateIntegerAsync(
            this,
            policyId,
            identity,
            tryReadAsync,
            rebuildAsync,
            operation,
            cancellationToken,
            strategy);

    private static async Task<T?> CoordinateIntegerAsync<T>(
        ICacheMissCoordinator coordinator,
        CachePolicyId policyId,
        int identity,
        Func<CancellationToken, Task<CacheReadResult<T>>> tryReadAsync,
        Func<CancellationToken, Task<T?>> rebuildAsync,
        string operation,
        CancellationToken cancellationToken,
        CacheRebuildStrategy? strategy)
    {
        CacheReadResult<T> hit = await tryReadAsync(cancellationToken).ConfigureAwait(false);
        if (hit.Hit)
        {
            return hit.Value;
        }

        return await coordinator.CoordinateAsync(
                policyId,
                identity.ToString(System.Globalization.CultureInfo.InvariantCulture),
                tryReadAsync,
                rebuildAsync,
                operation,
                cancellationToken,
                strategy)
            .ConfigureAwait(false);
    }
}

public sealed class CacheMissCoordinator(
    IUnifiedCache cache,
    ICachePolicyRegistry policyRegistry,
    ILogger<CacheMissCoordinator> logger) : ICacheMissCoordinator
{
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _rebuildSemaphores = new(StringComparer.Ordinal);
    private static readonly TimeSpan s_minLeaseTtl = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan s_maxLeaseTtl = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan s_minWaitTimeout = TimeSpan.FromMilliseconds(750);
    private static readonly TimeSpan s_maxWaitTimeout = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan s_defaultPollInterval = TimeSpan.FromMilliseconds(125);
    private static readonly TimeSpan s_maxPollInterval = TimeSpan.FromMilliseconds(500);

    public async Task<T?> CoordinateAsync<T>(
        CachePolicyId policyId,
        string identity,
        Func<CancellationToken, Task<CacheReadResult<T>>> tryReadAsync,
        Func<CancellationToken, Task<T?>> rebuildAsync,
        string operation,
        CancellationToken cancellationToken = default,
        CacheRebuildStrategy? strategy = null)
    {
        CacheReadResult<T> hit = await tryReadAsync(cancellationToken).ConfigureAwait(false);
        if (hit.Hit)
        {
            return hit.Value;
        }

        return await CoordinateAfterInitialMissAsync(
                policyId,
                identity,
                tryReadAsync,
                rebuildAsync,
                operation,
                cancellationToken,
                strategy)
            .ConfigureAwait(false);
    }

    public async Task<T?> CoordinateAsync<T>(
        CachePolicyId policyId,
        int identity,
        Func<CancellationToken, Task<CacheReadResult<T>>> tryReadAsync,
        Func<CancellationToken, Task<T?>> rebuildAsync,
        string operation,
        CancellationToken cancellationToken = default,
        CacheRebuildStrategy? strategy = null)
    {
        CacheReadResult<T> hit = await tryReadAsync(cancellationToken).ConfigureAwait(false);
        if (hit.Hit)
        {
            return hit.Value;
        }

        return await CoordinateAfterInitialMissAsync(
                policyId,
                identity.ToString(System.Globalization.CultureInfo.InvariantCulture),
                tryReadAsync,
                rebuildAsync,
                operation,
                cancellationToken,
                strategy)
            .ConfigureAwait(false);
    }

    private async Task<T?> CoordinateAfterInitialMissAsync<T>(
        CachePolicyId policyId,
        string identity,
        Func<CancellationToken, Task<CacheReadResult<T>>> tryReadAsync,
        Func<CancellationToken, Task<T?>> rebuildAsync,
        string operation,
        CancellationToken cancellationToken,
        CacheRebuildStrategy? strategy)
    {

        await using IAsyncDisposable singleFlight = await cache.AcquireSingleFlightAsync(policyId, identity, cancellationToken).ConfigureAwait(false);

        CacheReadResult<T> hit = await tryReadAsync(cancellationToken).ConfigureAwait(false);
        if (hit.Hit)
        {
            return hit.Value;
        }

        CacheRebuildStrategy effectiveStrategy = strategy ?? ResolveStrategy(policyId);
        string leaseIdentity = $"__lease__:{identity}";
        string leaseValue = $"{Environment.ProcessId}:{Guid.NewGuid():N}";

        if (await cache.TryAcquireLeaseAsync(policyId, leaseIdentity, leaseValue, effectiveStrategy.LeaseTtl, cancellationToken).ConfigureAwait(false))
        {
            logger.LogDebug(
                "cache-lease-hit {Operation} {PolicyId} {Identity}",
                operation,
                policyId,
                identity);
            return await RebuildWithSemaphoreAsync(policyId, identity, tryReadAsync, rebuildAsync, cancellationToken)
                .ConfigureAwait(false);
        }

        logger.LogDebug(
            "cache-lease-miss {Operation} {PolicyId} {Identity}",
            operation,
            policyId,
            identity);

        CacheReadResult<T> waited = await WaitForRefillAsync(
            tryReadAsync,
            operation,
            policyId,
            identity,
            effectiveStrategy,
            cancellationToken).ConfigureAwait(false);

        if (waited.Hit)
        {
            return waited.Value;
        }

        string fallbackLeaseValue = $"{Environment.ProcessId}:{Guid.NewGuid():N}";
        if (await cache.TryAcquireLeaseAsync(policyId, leaseIdentity, fallbackLeaseValue, effectiveStrategy.LeaseTtl, cancellationToken).ConfigureAwait(false))
        {
            logger.LogDebug(
                "cache-lease-fallback-hit {Operation} {PolicyId} {Identity}",
                operation,
                policyId,
                identity);
            return await RebuildWithSemaphoreAsync(policyId, identity, tryReadAsync, rebuildAsync, cancellationToken)
                .ConfigureAwait(false);
        }

        logger.LogDebug(
            "cache-lease-fallback-miss {Operation} {PolicyId} {Identity}",
            operation,
            policyId,
            identity);

        CacheReadResult<T> fallbackWaited = await WaitForRefillAsync(
            tryReadAsync,
            operation,
            policyId,
            identity,
            effectiveStrategy,
            cancellationToken).ConfigureAwait(false);

        if (fallbackWaited.Hit)
        {
            return fallbackWaited.Value;
        }

        return await RebuildWithSemaphoreAsync(policyId, identity, tryReadAsync, rebuildAsync, cancellationToken)
            .ConfigureAwait(false);
    }

    private async Task<T?> RebuildWithSemaphoreAsync<T>(
        CachePolicyId policyId,
        string identity,
        Func<CancellationToken, Task<CacheReadResult<T>>> tryReadAsync,
        Func<CancellationToken, Task<T?>> rebuildAsync,
        CancellationToken cancellationToken)
    {
        string semaphoreKey = $"{(int)policyId}:{identity}";
        SemaphoreSlim semaphore = _rebuildSemaphores.GetOrAdd(semaphoreKey, static _ => new SemaphoreSlim(1, 1));
        await semaphore.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            CacheReadResult<T> hit = await tryReadAsync(cancellationToken).ConfigureAwait(false);
            if (hit.Hit)
            {
                return hit.Value;
            }

            return await rebuildAsync(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            semaphore.Release();
        }
    }

    private async Task<CacheReadResult<T>> WaitForRefillAsync<T>(
        Func<CancellationToken, Task<CacheReadResult<T>>> tryReadAsync,
        string operation,
        CachePolicyId policyId,
        string identity,
        CacheRebuildStrategy strategy,
        CancellationToken cancellationToken)
    {
        DateTimeOffset deadline = DateTimeOffset.UtcNow.Add(strategy.WaitTimeout);
        TimeSpan pollInterval = strategy.PollInterval <= TimeSpan.Zero ? s_defaultPollInterval : strategy.PollInterval;

        while (DateTimeOffset.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            CacheReadResult<T> probe = await tryReadAsync(cancellationToken).ConfigureAwait(false);
            if (probe.Hit)
            {
                logger.LogDebug(
                    "cache-wait-fallback-hit {Operation} {PolicyId} {Identity}",
                    operation,
                    policyId,
                    identity);
                return probe;
            }

            TimeSpan remaining = deadline - DateTimeOffset.UtcNow;
            if (remaining <= TimeSpan.Zero)
            {
                break;
            }

            TimeSpan delay = remaining < pollInterval ? remaining : pollInterval;
            await Task.Delay(delay, cancellationToken).ConfigureAwait(false);
            pollInterval = TimeSpan.FromTicks(Math.Min(pollInterval.Ticks * 2L, s_maxPollInterval.Ticks));
        }

        RuntimePressureSnapshot pressure = RuntimePressureSnapshot.Capture();
        logger.LogInformation(
            "cache-wait-fallback-timeout {Operation} {PolicyId} {Identity} waitMs={WaitMs} availableWorkers={AvailableWorkers} availableIo={AvailableIo}",
            operation,
            policyId,
            identity,
            (int)strategy.WaitTimeout.TotalMilliseconds,
            pressure.AvailableWorkerThreads,
            pressure.AvailableIoThreads);

        return new CacheReadResult<T>(false, default);
    }

    private CacheRebuildStrategy ResolveStrategy(CachePolicyId policyId)
    {
        CachePolicy policy = ResolvePolicy(policyId);
        TimeSpan leaseTtl = policy.L2Ttl <= TimeSpan.Zero
            ? s_minLeaseTtl
            : TimeSpan.FromTicks(Math.Clamp(policy.L2Ttl.Ticks / 20L, s_minLeaseTtl.Ticks, s_maxLeaseTtl.Ticks));
        TimeSpan waitTimeout = TimeSpan.FromTicks(Math.Clamp(leaseTtl.Ticks / 4L, s_minWaitTimeout.Ticks, s_maxWaitTimeout.Ticks));
        return new CacheRebuildStrategy(leaseTtl, waitTimeout, s_defaultPollInterval);
    }

    private CachePolicy ResolvePolicy(CachePolicyId policyId)
    {
        if (policyRegistry.TryGet(policyId, out CachePolicy policy))
        {
            return policy;
        }

        return new CachePolicy(policyId, "missing", $"policy-{policyId}", TimeSpan.Zero, TimeSpan.FromMinutes(5));
    }
}
