using System.Collections.Concurrent;
using System.Diagnostics;

using FsusBlog.Server.Infrastructure.Observability;

namespace FsusBlog.Server.Infrastructure.Cache;

public sealed class CacheSingleFlightCoordinator : ICacheSingleFlightCoordinator, IDisposable
{
    private readonly ICacheKeyResolver _keyResolver;
    private readonly TimeSpan _maxAcquireWait;
    private readonly int _maxWaitersPerKey;
    private readonly ConcurrentDictionary<string, Entry> _entries = new(StringComparer.Ordinal);
    private int _disposed;
    private long _rejectByCap;
    private long _rejectByTimeout;

    public CacheSingleFlightCoordinator(ICacheKeyResolver keyResolver)
        : this(
            keyResolver,
            CacheMissPathBudget.SingleFlightMaxAcquireWait,
            CacheMissPathBudget.SingleFlightMaxWaitersPerKey)
    {
    }

    public CacheSingleFlightCoordinator(
        ICacheKeyResolver keyResolver,
        TimeSpan maxAcquireWait,
        int maxWaitersPerKey)
    {
        ArgumentNullException.ThrowIfNull(keyResolver);
        ArgumentOutOfRangeException.ThrowIfLessThanOrEqual(maxAcquireWait, TimeSpan.Zero);
        ArgumentOutOfRangeException.ThrowIfLessThan(maxWaitersPerKey, 1);
        _keyResolver = keyResolver;
        _maxAcquireWait = maxAcquireWait;
        _maxWaitersPerKey = maxWaitersPerKey;
    }

    public int ActiveEntryCount => _entries.Count;

    internal TimeSpan MaxAcquireWait => _maxAcquireWait;

    internal int MaxWaitersPerKey => _maxWaitersPerKey;

    internal long RejectByCapCount => Volatile.Read(ref _rejectByCap);

    internal long RejectByTimeoutCount => Volatile.Read(ref _rejectByTimeout);

    public Task<IAsyncDisposable> AcquireAsync(
        CachePolicyId policyId,
        string identity,
        CancellationToken cancellationToken = default)
        => AcquireKeyedAsync(
            $"singleflight:{_keyResolver.BuildKey(policyId, identity)}",
            cancellationToken,
            policyId,
            applyWaitBudget: true);

    public bool IsHeld(CachePolicyId policyId, string identity)
    {
        string key = $"singleflight:{_keyResolver.BuildKey(policyId, identity)}";
        return _entries.TryGetValue(key, out Entry? entry) && entry.IsHeld;
    }

    internal Task<IAsyncDisposable> AcquireMutationAsync(string redisKey, CancellationToken cancellationToken)
        => AcquireKeyedAsync($"owned-frame:{redisKey}", cancellationToken, default, applyWaitBudget: false);

    internal async Task<IAsyncDisposable> AcquireMutationsAsync(
        IEnumerable<string> redisKeys,
        CancellationToken cancellationToken)
    {
        string[] orderedKeys = redisKeys
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray();
        var leases = new List<IAsyncDisposable>(orderedKeys.Length);
        try
        {
            foreach (string redisKey in orderedKeys)
            {
                cancellationToken.ThrowIfCancellationRequested();
                leases.Add(await AcquireMutationAsync(redisKey, cancellationToken).ConfigureAwait(false));
            }

            return new CompositeLease(leases);
        }
        catch
        {
            for (int index = leases.Count - 1; index >= 0; index--)
            {
                await leases[index].DisposeAsync().ConfigureAwait(false);
            }

            throw;
        }
    }

    private async Task<IAsyncDisposable> AcquireKeyedAsync(
        string key,
        CancellationToken cancellationToken,
        CachePolicyId policyId,
        bool applyWaitBudget)
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) != 0, this);
        while (true)
        {
            Entry entry = _entries.GetOrAdd(key, static _ => new Entry());
            if (!entry.TryAddReference())
            {
                if (entry.TryRetireIfIdle())
                {
                    _entries.TryRemove(new KeyValuePair<string, Entry>(key, entry));
                }

                await Task.Yield();
                continue;
            }

            try
            {
                if (!applyWaitBudget)
                {
                    await entry.Semaphore.WaitAsync(cancellationToken).ConfigureAwait(false);
                    return new Lease(this, key, entry);
                }

                return await AcquireWithBudgetAsync(key, entry, policyId, cancellationToken).ConfigureAwait(false);
            }
            catch
            {
                Release(key, entry);
                throw;
            }
        }
    }

    private async Task<IAsyncDisposable> AcquireWithBudgetAsync(
        string key,
        Entry entry,
        CachePolicyId policyId,
        CancellationToken cancellationToken)
    {
        long waitStarted = Stopwatch.GetTimestamp();
        if (await entry.Semaphore.WaitAsync(TimeSpan.Zero, cancellationToken).ConfigureAwait(false))
        {
            FsusObservability.RecordSingleFlightWait(
                CachePolicyTelemetry.Name(policyId),
                Stopwatch.GetElapsedTime(waitStarted),
                waiterCount: 0);
            return new Lease(this, key, entry);
        }

        int waiters = entry.IncrementWaiters();
        try
        {
            FsusObservability.RecordSingleFlightWaiterCount(CachePolicyTelemetry.Name(policyId), waiters);
            if (waiters > _maxWaitersPerKey)
            {
                Interlocked.Increment(ref _rejectByCap);
                FsusObservability.RecordSingleFlightReject(CachePolicyTelemetry.Name(policyId), "waiter-cap");
                throw new CacheCoordinationException("singleflight-waiter-cap", policyId);
            }

            bool acquired = await entry.Semaphore.WaitAsync(_maxAcquireWait, cancellationToken).ConfigureAwait(false);
            FsusObservability.RecordSingleFlightWait(
                CachePolicyTelemetry.Name(policyId),
                Stopwatch.GetElapsedTime(waitStarted),
                waiters);
            if (!acquired)
            {
                Interlocked.Increment(ref _rejectByTimeout);
                FsusObservability.RecordSingleFlightReject(CachePolicyTelemetry.Name(policyId), "timeout");
                throw new CacheCoordinationException("singleflight-timeout", policyId);
            }

            return new Lease(this, key, entry);
        }
        finally
        {
            entry.DecrementWaiters();
        }
    }

    private void Release(string key, Entry entry)
    {
        if (entry.ReleaseReference(retireWhenIdle: true))
        {
            _entries.TryRemove(new KeyValuePair<string, Entry>(key, entry));
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        foreach ((string key, Entry entry) in _entries)
        {
            entry.MarkRetired();
            _entries.TryRemove(new KeyValuePair<string, Entry>(key, entry));
        }
    }

    private sealed class Entry : IDisposable
    {
        private int _references;
        private int _retired;
        private int _disposed;
        private int _waiters;

        internal SemaphoreSlim Semaphore { get; } = new(1, 1);

        internal bool IsHeld
        {
            get
            {
                if (Volatile.Read(ref _disposed) != 0 || Volatile.Read(ref _retired) != 0)
                {
                    return false;
                }

                try
                {
                    return Semaphore.CurrentCount == 0;
                }
                catch (ObjectDisposedException)
                {
                    return false;
                }
            }
        }

        internal int IncrementWaiters() => Interlocked.Increment(ref _waiters);

        internal int DecrementWaiters() => Interlocked.Decrement(ref _waiters);

        internal bool TryAddReference()
        {
            while (true)
            {
                if (Volatile.Read(ref _retired) != 0 || Volatile.Read(ref _disposed) != 0)
                {
                    return false;
                }

                int current = Volatile.Read(ref _references);
                if (Interlocked.CompareExchange(ref _references, current + 1, current) != current)
                {
                    continue;
                }

                if (Volatile.Read(ref _retired) == 0 && Volatile.Read(ref _disposed) == 0)
                {
                    return true;
                }

                _ = ReleaseReference();
                return false;
            }
        }

        internal bool ReleaseReference(bool retireWhenIdle = false)
        {
            int remaining;
            while (true)
            {
                int current = Volatile.Read(ref _references);
                if (current <= 0)
                {
                    throw new InvalidOperationException("Single-flight reference count is already zero.");
                }

                remaining = current - 1;
                if (Interlocked.CompareExchange(ref _references, remaining, current) == current)
                {
                    break;
                }
            }

            if (retireWhenIdle && remaining == 0)
            {
                Volatile.Write(ref _retired, 1);
            }

            // Another contender may add a reference after this caller decrements
            // the count to zero but before retirement becomes visible. Re-read the
            // shared count after publishing retirement so a live lease keeps the
            // semaphore alive until its own release.
            if (Volatile.Read(ref _retired) != 0 && Volatile.Read(ref _references) == 0)
            {
                Dispose();
                return true;
            }

            return false;
        }

        internal void MarkRetired()
            => _ = TryRetireIfIdle(force: true);

        internal bool TryRetireIfIdle()
            => TryRetireIfIdle(force: false);

        private bool TryRetireIfIdle(bool force)
        {
            if (!force && Volatile.Read(ref _references) != 0)
            {
                return false;
            }

            Volatile.Write(ref _retired, 1);
            if (Volatile.Read(ref _references) == 0)
            {
                Dispose();
                return true;
            }

            return false;
        }

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0)
            {
                Semaphore.Dispose();
            }
        }
    }

    private sealed class Lease(CacheSingleFlightCoordinator owner, string key, Entry entry) : IAsyncDisposable
    {
        private Entry? _entry = entry;

        public ValueTask DisposeAsync()
        {
            Entry? current = Interlocked.Exchange(ref _entry, null);
            if (current is not null)
            {
                current.Semaphore.Release();
                owner.Release(key, current);
            }

            return ValueTask.CompletedTask;
        }
    }

    private sealed class CompositeLease(List<IAsyncDisposable> leases) : IAsyncDisposable
    {
        private List<IAsyncDisposable>? _leases = leases;

        public async ValueTask DisposeAsync()
        {
            List<IAsyncDisposable>? current = Interlocked.Exchange(ref _leases, null);
            if (current is null)
            {
                return;
            }

            for (int index = current.Count - 1; index >= 0; index--)
            {
                await current[index].DisposeAsync().ConfigureAwait(false);
            }
        }
    }
}
