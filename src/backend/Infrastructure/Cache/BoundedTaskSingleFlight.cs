using System.Collections.Concurrent;

namespace FsusBlog.Server.Infrastructure.Cache;

/// <summary>
/// Shares one bounded asynchronous build per exact key without transferring a
/// caller-owned result lease between waiters.
/// </summary>
public sealed class BoundedTaskSingleFlight<T>(int maxActiveKeys = 1024)
{
    private readonly ConcurrentDictionary<string, Entry> _entries = new(StringComparer.Ordinal);
    private readonly int _maxActiveKeys = maxActiveKeys > 0
        ? maxActiveKeys
        : throw new ArgumentOutOfRangeException(nameof(maxActiveKeys));

    public int ActiveKeyCount => _entries.Count;

    public async Task<T> RunAsync(
        CachePolicyId policyId,
        string key,
        Func<CancellationToken, Task<T>> buildAsync,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(key);
        ArgumentNullException.ThrowIfNull(buildAsync);

        while (true)
        {
            if (_entries.TryGetValue(key, out Entry? existing))
            {
                return await existing.Completion.Task.WaitAsync(cancellationToken).ConfigureAwait(false);
            }

            if (_entries.Count >= _maxActiveKeys)
            {
                throw new CacheCoordinationException("build-flight-cap", policyId);
            }

            var created = new Entry();
            if (!_entries.TryAdd(key, created))
            {
                continue;
            }

            _ = CompleteAsync(key, created, buildAsync);
            return await created.Completion.Task.WaitAsync(cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task CompleteAsync(
        string key,
        Entry entry,
        Func<CancellationToken, Task<T>> buildAsync)
    {
        try
        {
            T result = await buildAsync(CancellationToken.None).ConfigureAwait(false);
            entry.Completion.TrySetResult(result);
        }
        catch (Exception exception)
        {
            entry.Completion.TrySetException(exception);
        }
        finally
        {
            _entries.TryRemove(new KeyValuePair<string, Entry>(key, entry));
        }
    }

    private sealed class Entry
    {
        internal TaskCompletionSource<T> Completion { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }
}
