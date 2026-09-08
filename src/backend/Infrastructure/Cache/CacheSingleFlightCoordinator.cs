using System.Collections.Concurrent;

namespace FsusBlog.Server.Infrastructure.Cache;

public sealed class CacheSingleFlightCoordinator(ICacheKeyResolver keyResolver) : ICacheSingleFlightCoordinator, IDisposable
{
    private readonly ConcurrentDictionary<string, Entry> _entries = new(StringComparer.Ordinal);
    private int _disposed;

    public int ActiveEntryCount => _entries.Count;

    public Task<IAsyncDisposable> AcquireAsync(
        CachePolicyId policyId,
        string identity,
        CancellationToken cancellationToken = default)
        => AcquireKeyedAsync($"singleflight:{keyResolver.BuildKey(policyId, identity)}", cancellationToken);

    internal Task<IAsyncDisposable> AcquireMutationAsync(string redisKey, CancellationToken cancellationToken)
        => AcquireKeyedAsync($"owned-frame:{redisKey}", cancellationToken);

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

    private async Task<IAsyncDisposable> AcquireKeyedAsync(string key, CancellationToken cancellationToken)
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
                await entry.Semaphore.WaitAsync(cancellationToken).ConfigureAwait(false);
                return new Lease(this, key, entry);
            }
            catch
            {
                Release(key, entry);
                throw;
            }
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

        internal SemaphoreSlim Semaphore { get; } = new(1, 1);

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
