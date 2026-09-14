using System.Diagnostics;

using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Testing;

namespace FsusBlog.Server.Infrastructure.Cache;

public readonly record struct CacheRebuildStrategy(TimeSpan LeaseTtl, TimeSpan WaitTimeout, TimeSpan RebuildTimeout);

/// <summary>
/// Documented miss-path wait budget: local singleflight acquire, then lease
/// wait, then rebuild. Followers with qualified last-good skip this budget.
/// </summary>
public static class CacheMissPathBudget
{
    public static readonly TimeSpan SingleFlightMaxAcquireWait = TimeSpan.FromMilliseconds(750);
    public const int SingleFlightMaxWaitersPerKey = 1024;
    public static readonly TimeSpan MinLeaseWait = TimeSpan.FromMilliseconds(750);
    public static readonly TimeSpan MaxLeaseWait = TimeSpan.FromSeconds(5);
    public static readonly TimeSpan MinLeaseTtl = TimeSpan.FromSeconds(5);
    public static readonly TimeSpan MaxLeaseTtl = TimeSpan.FromSeconds(30);

    public static TimeSpan ComputeTotal(CacheRebuildStrategy strategy)
        => SingleFlightMaxAcquireWait + strategy.WaitTimeout + strategy.RebuildTimeout;
}

public sealed class CacheCoordinationException(string reason, CachePolicyId policyId, int retryAfterSeconds = 1)
    : TimeoutException($"Cache coordination failed: {reason} ({policyId}).")
{
    public string Reason { get; } = reason;

    public int RetryAfterSeconds { get; } = retryAfterSeconds;
}

public interface ICacheLastGoodLookup
{
    bool TryGetQualifiedLastGood<T>(CachePolicyId policyId, string identity, out T? value);
}

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
    ICacheSingleFlightCoordinator singleFlightCoordinator,
    ICacheLeaseStore leaseStore,
    ICachePolicyRegistry policyRegistry,
    ILogger<CacheMissCoordinator> logger) : ICacheMissCoordinator
{
    private static readonly TimeSpan s_minLeaseTtl = CacheMissPathBudget.MinLeaseTtl;
    private static readonly TimeSpan s_maxLeaseTtl = CacheMissPathBudget.MaxLeaseTtl;
    private static readonly TimeSpan s_minWaitTimeout = CacheMissPathBudget.MinLeaseWait;
    private static readonly TimeSpan s_maxWaitTimeout = CacheMissPathBudget.MaxLeaseWait;

    internal ICacheLastGoodLookup? LastGoodLookup
    {
        get; init;
    }

    public async Task<T?> CoordinateAsync<T>(
        CachePolicyId policyId,
        string identity,
        Func<CancellationToken, Task<CacheReadResult<T>>> tryReadAsync,
        Func<CancellationToken, Task<T?>> rebuildAsync,
        string operation,
        CancellationToken cancellationToken = default,
        CacheRebuildStrategy? strategy = null)
    {
        using var observation = CacheCoordinationObservation.Begin(policyId, singleFlightCoordinator);
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
        using var observation = CacheCoordinationObservation.Begin(policyId, singleFlightCoordinator);
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

        CacheCoordinationObservation observation = CacheCoordinationObservation.Current!;
        if (TryServeLastGoodWhileRebuild(policyId, identity, observation, out T? stale))
        {
            return stale;
        }

        long localWaitStarted = Stopwatch.GetTimestamp();
        IAsyncDisposable acquired;
        try
        {
            acquired = await singleFlightCoordinator.AcquireAsync(policyId, identity, cancellationToken).ConfigureAwait(false);
        }
        catch (CacheCoordinationException exception) when (
            string.Equals(exception.Reason, "singleflight-timeout", StringComparison.Ordinal)
            || string.Equals(exception.Reason, "singleflight-waiter-cap", StringComparison.Ordinal))
        {
            observation.LocalWait = Stopwatch.GetElapsedTime(localWaitStarted);
            if (TryServeLastGood(policyId, identity, observation, out T? rejectedStale))
            {
                return rejectedStale;
            }

            throw;
        }
        finally
        {
            observation.LocalWait = Stopwatch.GetElapsedTime(localWaitStarted);
        }
        await using IAsyncDisposable singleFlight = acquired;

        CacheReadResult<T> hit = await tryReadAsync(cancellationToken).ConfigureAwait(false);
        if (hit.Hit)
        {
            RuntimeCacheEvidenceObservation.Current?.RecordCacheEvent(
                "cache-miss-singleflight",
                BuildEvidenceIdentity(policyId, identity),
                "hit");
            return hit.Value;
        }

        CacheRebuildStrategy effectiveStrategy = strategy ?? ResolveStrategy(policyId);
        if (effectiveStrategy.LeaseTtl < TimeSpan.FromMilliseconds(3) || effectiveStrategy.WaitTimeout < TimeSpan.Zero || effectiveStrategy.RebuildTimeout <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(strategy), "Lease TTL must be at least 3 ms, refill wait must not be negative and rebuild timeout must be positive.");
        }
        string leaseIdentity = $"__lease__:{identity}";
        string leaseValue = $"{Environment.ProcessId}:{Guid.NewGuid():N}";
        long acquireStarted = Stopwatch.GetTimestamp();
        bool leaseAcquired;
        try
        {
            leaseAcquired = await leaseStore.TryAcquireLeaseAsync(policyId, leaseIdentity, leaseValue, effectiveStrategy.LeaseTtl, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            observation.LeaseWait = Stopwatch.GetElapsedTime(acquireStarted);
        }
        if (!leaseAcquired)
        {
            try
            {
                await Task.Delay(effectiveStrategy.WaitTimeout, cancellationToken).ConfigureAwait(false);
            }
            finally
            {
                observation.LeaseWait = Stopwatch.GetElapsedTime(acquireStarted);
            }
            CacheReadResult<T> finalRead = await tryReadAsync(cancellationToken).ConfigureAwait(false);
            if (finalRead.Hit)
            {
                return finalRead.Value;
            }

            throw new CacheCoordinationException("refill-timeout", policyId);
        }

        using CancellationTokenSource ownershipCancellation = new();
        ArmOwnershipDeadline(ownershipCancellation, effectiveStrategy.LeaseTtl - Stopwatch.GetElapsedTime(acquireStarted));
        using CancellationTokenSource rebuildCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, ownershipCancellation.Token);
        using CancellationTokenSource renewalCancellation = new();
        rebuildCancellation.CancelAfter(effectiveStrategy.RebuildTimeout);
        Task renewal = RenewUntilStoppedAsync(
            policyId, leaseIdentity, leaseValue, effectiveStrategy.LeaseTtl,
            ownershipCancellation, renewalCancellation.Token);
        using var publication = new CacheRebuildLeaseScope(leaseStore, policyId, leaseIdentity, leaseValue, rebuildCancellation.Token);
        try
        {
            rebuildCancellation.Token.ThrowIfCancellationRequested();
            observation.RebuildCount++;
            T? result = await rebuildAsync(rebuildCancellation.Token).ConfigureAwait(false);
            rebuildCancellation.Token.ThrowIfCancellationRequested();
            RuntimeCacheEvidenceObservation.Current?.RecordCacheEvent(
                "cache-miss-singleflight",
                BuildEvidenceIdentity(policyId, identity),
                result is null ? "negative" : "built");
            return result;
        }
        finally
        {
            publication.StopPublishing();
            try
            {
                await renewalCancellation.CancelAsync().ConfigureAwait(false);
                await renewal.ConfigureAwait(false);
            }
            finally
            {
                try
                {
                    bool released = await leaseStore.TryReleaseLeaseAsync(
                        policyId, leaseIdentity, leaseValue, CancellationToken.None).ConfigureAwait(false);
                    observation.ReleaseOutcome = released ? "released" : "lost";
                    logger.LogDebug("cache-lease-release {Operation} {PolicyId} {Released}", operation, policyId, released);
                }
                catch (Exception exception)
                {
                    observation.ReleaseOutcome = "failed";
                    logger.LogWarning(exception, "cache-lease-release-failed {Operation} {PolicyId}", operation, policyId);
                }
            }
        }
    }

    private static string BuildEvidenceIdentity(CachePolicyId policyId, string identity)
        => $"{CachePolicyTelemetry.Name(policyId)}:{identity}";

    private async Task RenewUntilStoppedAsync(
        CachePolicyId policyId,
        string leaseIdentity,
        string leaseValue,
        TimeSpan leaseTtl,
        CancellationTokenSource rebuildCancellation,
        CancellationToken cancellationToken)
    {
        try
        {
            using var timer = new PeriodicTimer(TimeSpan.FromTicks(Math.Max(TimeSpan.TicksPerMillisecond, leaseTtl.Ticks / 3)));
            while (await timer.WaitForNextTickAsync(cancellationToken).ConfigureAwait(false))
            {
                long renewStarted = Stopwatch.GetTimestamp();
                bool renewed = await leaseStore.TryRenewLeaseAsync(
                    policyId, leaseIdentity, leaseValue, leaseTtl, cancellationToken).ConfigureAwait(false);
                if (!renewed)
                {
                    await rebuildCancellation.CancelAsync().ConfigureAwait(false);
                    return;
                }
                ArmOwnershipDeadline(rebuildCancellation, leaseTtl - Stopwatch.GetElapsedTime(renewStarted));
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "cache-lease-renew-failed {PolicyId}", policyId);
            await rebuildCancellation.CancelAsync().ConfigureAwait(false);
        }
    }

    private static void ArmOwnershipDeadline(CancellationTokenSource ownershipCancellation, TimeSpan remaining)
    {
        if (remaining <= TimeSpan.Zero)
        {
            ownershipCancellation.Cancel();
        }
        else
        {
            ownershipCancellation.CancelAfter(remaining);
        }
    }

    private CacheRebuildStrategy ResolveStrategy(CachePolicyId policyId)
    {
        CachePolicy policy = ResolvePolicy(policyId);
        TimeSpan leaseTtl = policy.L2Ttl <= TimeSpan.Zero
            ? s_minLeaseTtl
            : TimeSpan.FromTicks(Math.Clamp(policy.L2Ttl.Ticks / 20L, s_minLeaseTtl.Ticks, s_maxLeaseTtl.Ticks));
        TimeSpan waitTimeout = TimeSpan.FromTicks(Math.Clamp(leaseTtl.Ticks / 4L, s_minWaitTimeout.Ticks, s_maxWaitTimeout.Ticks));
        return new CacheRebuildStrategy(leaseTtl, waitTimeout, TimeSpan.FromTicks(leaseTtl.Ticks * 4));
    }

    private bool TryServeLastGoodWhileRebuild<T>(
        CachePolicyId policyId,
        string identity,
        CacheCoordinationObservation observation,
        out T? value)
    {
        if (!singleFlightCoordinator.IsHeld(policyId, identity))
        {
            value = default;
            return false;
        }

        return TryServeLastGood(policyId, identity, observation, out value);
    }

    private bool TryServeLastGood<T>(
        CachePolicyId policyId,
        string identity,
        CacheCoordinationObservation observation,
        out T? value)
    {
        if (LastGoodLookup is not null
            && LastGoodLookup.TryGetQualifiedLastGood(policyId, identity, out value))
        {
            observation.LastGoodWhileRebuild++;
            FsusObservability.RecordLastGoodWhileRebuild(CachePolicyTelemetry.Name(policyId));
            return true;
        }

        value = default;
        return false;
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
