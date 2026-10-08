using System.Collections.Concurrent;
using System.Text;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Testing;

namespace FsusBlog.Server.Infrastructure.Security;

public enum BanStateProjectionStatus
{
    Unknown = 0,
    Normal = 1,
    Banned = 2,
    Deleted = 3
}

public readonly record struct BanStateProjectionUpdate(
    string AccountSubjectHash,
    BanStateProjectionStatus Status,
    string? ReasonCode,
    long Generation);

public readonly record struct BanStateProjectionLookup(
    BanStateProjectionStatus Status,
    string? ReasonCode,
    long Generation)
{
    public bool IsKnown => Status is not BanStateProjectionStatus.Unknown;

    public static BanStateProjectionLookup Unknown(long generation = 0)
        => new(BanStateProjectionStatus.Unknown, null, generation);
}

public enum BanStateProjectionApplyResult
{
    Applied = 0,
    RejectedInvalid = 1,
    RejectedStale = 2,
    RejectedDuplicate = 3,
    FailedClosedConflict = 4,
    RejectedOverBudget = 5
}

public sealed class BanStateProjectionLimits
{
    public int MaxEntries { get; init; } = 100_000;

    public long MaxUtf8ResidentBytes { get; init; } = 8 * 1024 * 1024;

    public int MaxReasonCodeUtf8Bytes { get; init; } = 64;

    internal bool IsValid()
        => MaxEntries > 0
            && MaxUtf8ResidentBytes >= AccountSubjectHashRequirement.Sha256HexLength
            && MaxReasonCodeUtf8Bytes > 0
            && MaxReasonCodeUtf8Bytes <= MaxUtf8ResidentBytes;
}

public readonly record struct BanStateProjectionSnapshot(
    int Entries,
    long Utf8ResidentBytes,
    int MaxEntries,
    long MaxUtf8ResidentBytes,
    long AppliedUpdates,
    long InvalidUpdates,
    long StaleUpdates,
    long DuplicateUpdates,
    long Conflicts,
    long Evictions,
    long OverBudgetUpdates,
    long KnownReads,
    long UnknownReads,
    long SourceLoads,
    long HighestObservedGeneration,
    long HighestAppliedGeneration)
{
    public long VersionLag => Math.Max(0, HighestObservedGeneration - HighestAppliedGeneration);
}

/// <summary>
/// Loads one authoritative ban-state fact. Implementations may use a database or
/// another authority, but the projection itself has no dependency on either.
/// A missing row is represented by <see langword="null"/> and remains unknown.
/// </summary>
public interface IBanStateProjectionSource
{
    ValueTask<BanStateProjectionUpdate?> LoadAsync(
        int accountId,
        string accountSubjectHash,
        CancellationToken cancellationToken = default);
}

/// <summary>
/// Bounded process-local ban-state projection keyed only by the normalized
/// account subject hash. Known reads are lock-free and never invoke the source.
/// Unknown asynchronous reads are coalesced per subject.
/// </summary>
public sealed class BanStateProjection
{
    private readonly ConcurrentDictionary<string, Entry> _entries = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, Lazy<Task<BanStateProjectionLookup>>> _sourceLoads = new(StringComparer.Ordinal);
    private readonly Dictionary<string, LinkedListNode<string>> _orderNodes = new(StringComparer.Ordinal);
    private readonly LinkedList<string> _writeOrder = [];
    private readonly object _writeLock = new();
    private readonly IBanStateProjectionSource _source;
    private readonly BanStateProjectionLimits _limits;
    private long _utf8ResidentBytes;
    private long _appliedUpdates;
    private long _invalidUpdates;
    private long _staleUpdates;
    private long _duplicateUpdates;
    private long _conflicts;
    private long _evictions;
    private long _overBudgetUpdates;
    private long _knownReads;
    private long _unknownReads;
    private long _sourceLoadCount;
    private long _highestObservedGeneration;
    private long _highestAppliedGeneration;

    public BanStateProjection(
        IBanStateProjectionSource source,
        BanStateProjectionLimits? limits = null)
    {
        ArgumentNullException.ThrowIfNull(source);
        _source = source;
        _limits = limits ?? new BanStateProjectionLimits();
        if (!_limits.IsValid())
        {
            throw new ArgumentOutOfRangeException(nameof(limits), "Ban-state projection limits are invalid.");
        }
    }

    /// <summary>Reads only process-local memory and never invokes the authority source.</summary>
    public BanStateProjectionLookup Read(string? accountSubjectHash)
    {
        if (!TryNormalizeSubjectHash(accountSubjectHash, out string normalized))
        {
            Interlocked.Increment(ref _unknownReads);
            return BanStateProjectionLookup.Unknown();
        }

        if (!_entries.TryGetValue(normalized, out Entry entry))
        {
            Interlocked.Increment(ref _unknownReads);
            return BanStateProjectionLookup.Unknown();
        }

        if (entry.Status is BanStateProjectionStatus.Unknown)
        {
            Interlocked.Increment(ref _unknownReads);
            return BanStateProjectionLookup.Unknown(entry.Generation);
        }

        Interlocked.Increment(ref _knownReads);
        RuntimeCacheEvidenceObservation.Current?.RecordCacheEvent(
            "security-ban-projection",
            normalized,
            "hit");
        return entry.ToLookup();
    }

    /// <summary>
    /// Returns a known local value immediately. Unknown values use one shared
    /// authority load for the normalized subject, regardless of waiter count.
    /// Waiter cancellation never cancels the shared load for other waiters.
    /// </summary>
    public ValueTask<BanStateProjectionLookup> GetAsync(
        int accountId,
        string? accountSubjectHash,
        CancellationToken cancellationToken = default)
    {
        if (!TryNormalizeSubjectHash(accountSubjectHash, out string normalized))
        {
            Interlocked.Increment(ref _unknownReads);
            return ValueTask.FromResult(BanStateProjectionLookup.Unknown());
        }

        if (TryReadKnown(normalized, out BanStateProjectionLookup known))
        {
            Interlocked.Increment(ref _knownReads);
            return ValueTask.FromResult(known);
        }

        return new ValueTask<BanStateProjectionLookup>(LoadUnknownAsync(accountId, normalized, cancellationToken));
    }

    public ValueTask<BanStateProjectionLookup> GetAsync(
        string? accountSubjectHash,
        CancellationToken cancellationToken = default)
        => GetAsync(0, accountSubjectHash, cancellationToken);

    public BanStateProjectionApplyResult Apply(BanStateProjectionUpdate update)
    {
        ObserveGeneration(update.Generation);
        if (!TryNormalizeSubjectHash(update.AccountSubjectHash, out string subjectHash)
            || update.Generation <= 0)
        {
            Interlocked.Increment(ref _invalidUpdates);
            return BanStateProjectionApplyResult.RejectedInvalid;
        }

        if (!TryNormalizePayload(update.Status, update.ReasonCode, out string? reasonCode))
        {
            Interlocked.Increment(ref _invalidUpdates);
            FailClosedInvalidGeneration(subjectHash, update.Generation);
            return BanStateProjectionApplyResult.RejectedInvalid;
        }

        var candidate = new Entry(
            update.Status,
            reasonCode,
            update.Generation,
            EstimateUtf8Bytes(subjectHash, reasonCode));

        lock (_writeLock)
        {
            if (_entries.TryGetValue(subjectHash, out Entry current))
            {
                if (candidate.Generation < current.Generation)
                {
                    Interlocked.Increment(ref _staleUpdates);
                    return BanStateProjectionApplyResult.RejectedStale;
                }

                if (candidate.Generation == current.Generation)
                {
                    if (candidate.HasSamePayload(current))
                    {
                        Interlocked.Increment(ref _duplicateUpdates);
                        return BanStateProjectionApplyResult.RejectedDuplicate;
                    }

                    ReplaceWithConflictLocked(subjectHash, current.Generation);
                    Interlocked.Increment(ref _conflicts);
                    return BanStateProjectionApplyResult.FailedClosedConflict;
                }

                if (candidate.Utf8Bytes > _limits.MaxUtf8ResidentBytes)
                {
                    ReplaceWithConflictLocked(subjectHash, candidate.Generation);
                    Interlocked.Increment(ref _overBudgetUpdates);
                    return BanStateProjectionApplyResult.RejectedOverBudget;
                }

                EnsureCapacityLocked(
                    candidate.Utf8Bytes - current.Utf8Bytes,
                    subjectHash,
                    requireEntrySlot: false);
                ReplaceLocked(subjectHash, current, candidate);
                Interlocked.Increment(ref _appliedUpdates);
                ObserveAppliedGeneration(candidate.Generation);
                return BanStateProjectionApplyResult.Applied;
            }

            if (candidate.Utf8Bytes > _limits.MaxUtf8ResidentBytes)
            {
                StoreUnknownFenceLocked(subjectHash, candidate.Generation);
                Interlocked.Increment(ref _overBudgetUpdates);
                return BanStateProjectionApplyResult.RejectedOverBudget;
            }

            EnsureCapacityLocked(
                candidate.Utf8Bytes,
                excludedSubjectHash: null,
                requireEntrySlot: true);
            if (_entries.Count >= _limits.MaxEntries
                || _utf8ResidentBytes + candidate.Utf8Bytes > _limits.MaxUtf8ResidentBytes)
            {
                Interlocked.Increment(ref _overBudgetUpdates);
                return BanStateProjectionApplyResult.RejectedOverBudget;
            }

            _entries[subjectHash] = candidate;
            _orderNodes[subjectHash] = _writeOrder.AddLast(subjectHash);
            _utf8ResidentBytes += candidate.Utf8Bytes;
            Interlocked.Increment(ref _appliedUpdates);
            ObserveAppliedGeneration(candidate.Generation);
            return BanStateProjectionApplyResult.Applied;
        }
    }

    public BanStateProjectionSnapshot Snapshot()
    {
        lock (_writeLock)
        {
            return new BanStateProjectionSnapshot(
                _entries.Count,
                _utf8ResidentBytes,
                _limits.MaxEntries,
                _limits.MaxUtf8ResidentBytes,
                Volatile.Read(ref _appliedUpdates),
                Volatile.Read(ref _invalidUpdates),
                Volatile.Read(ref _staleUpdates),
                Volatile.Read(ref _duplicateUpdates),
                Volatile.Read(ref _conflicts),
                Volatile.Read(ref _evictions),
                Volatile.Read(ref _overBudgetUpdates),
                Volatile.Read(ref _knownReads),
                Volatile.Read(ref _unknownReads),
                Volatile.Read(ref _sourceLoadCount),
                Volatile.Read(ref _highestObservedGeneration),
                Volatile.Read(ref _highestAppliedGeneration));
        }
    }

    private async Task<BanStateProjectionLookup> LoadUnknownAsync(
        int accountId,
        string subjectHash,
        CancellationToken cancellationToken)
    {
        var candidate = new Lazy<Task<BanStateProjectionLookup>>(
            () => LoadFromSourceAsync(accountId, subjectHash),
            LazyThreadSafetyMode.ExecutionAndPublication);
        Lazy<Task<BanStateProjectionLookup>> operation = _sourceLoads.GetOrAdd(
            subjectHash,
            candidate);
        Task<BanStateProjectionLookup> sharedLoad = operation.Value;
        if (ReferenceEquals(candidate, operation))
        {
            _ = RemoveSourceLoadWhenCompleteAsync(subjectHash, operation, sharedLoad);
        }

        return await sharedLoad.WaitAsync(cancellationToken).ConfigureAwait(false);
    }

    private async Task RemoveSourceLoadWhenCompleteAsync(
        string subjectHash,
        Lazy<Task<BanStateProjectionLookup>> operation,
        Task<BanStateProjectionLookup> sharedLoad)
    {
        try
        {
            _ = await sharedLoad.ConfigureAwait(false);
        }
        catch
        {
            // Waiters observe the source failure. This observer only guarantees
            // that a canceled first waiter cannot strand the singleflight entry.
        }
        finally
        {
            _sourceLoads.TryRemove(
                new KeyValuePair<string, Lazy<Task<BanStateProjectionLookup>>>(subjectHash, operation));
        }
    }

    private async Task<BanStateProjectionLookup> LoadFromSourceAsync(int accountId, string subjectHash)
    {
        if (TryReadKnown(subjectHash, out BanStateProjectionLookup known))
        {
            return known;
        }

        Interlocked.Increment(ref _sourceLoadCount);
        BanStateProjectionUpdate? loaded = await _source
            .LoadAsync(accountId, subjectHash, CancellationToken.None)
            .ConfigureAwait(false);
        RuntimeCacheEvidenceObservation.Current?.RecordCacheEvent(
            "security-ban-projection",
            subjectHash,
            "built");
        if (loaded is null
            || !TryNormalizeSubjectHash(loaded.Value.AccountSubjectHash, out string loadedSubjectHash)
            || !string.Equals(subjectHash, loadedSubjectHash, StringComparison.Ordinal))
        {
            return Read(subjectHash);
        }

        _ = Apply(loaded.Value with
        {
            AccountSubjectHash = loadedSubjectHash
        });
        return Read(subjectHash);
    }

    private bool TryReadKnown(string subjectHash, out BanStateProjectionLookup lookup)
    {
        if (_entries.TryGetValue(subjectHash, out Entry entry)
            && entry.Status is not BanStateProjectionStatus.Unknown)
        {
            lookup = entry.ToLookup();
            return true;
        }

        lookup = BanStateProjectionLookup.Unknown(
            _entries.TryGetValue(subjectHash, out entry) ? entry.Generation : 0);
        return false;
    }

    private void FailClosedInvalidGeneration(string subjectHash, long generation)
    {
        lock (_writeLock)
        {
            if (_entries.TryGetValue(subjectHash, out Entry current)
                && generation >= current.Generation)
            {
                ReplaceWithConflictLocked(subjectHash, generation);
                return;
            }

            if (!_entries.ContainsKey(subjectHash))
            {
                StoreUnknownFenceLocked(subjectHash, generation);
            }
        }
    }

    private void StoreUnknownFenceLocked(string subjectHash, long generation)
    {
        int utf8Bytes = Encoding.UTF8.GetByteCount(subjectHash);
        EnsureCapacityLocked(utf8Bytes, excludedSubjectHash: null, requireEntrySlot: true);
        if (_entries.Count >= _limits.MaxEntries
            || _utf8ResidentBytes + utf8Bytes > _limits.MaxUtf8ResidentBytes)
        {
            return;
        }

        _entries[subjectHash] = new Entry(
            BanStateProjectionStatus.Unknown,
            null,
            generation,
            utf8Bytes);
        _orderNodes[subjectHash] = _writeOrder.AddLast(subjectHash);
        _utf8ResidentBytes += utf8Bytes;
    }

    private void ReplaceWithConflictLocked(string subjectHash, long generation)
    {
        if (!_entries.TryGetValue(subjectHash, out Entry current))
        {
            return;
        }

        var conflict = new Entry(
            BanStateProjectionStatus.Unknown,
            null,
            Math.Max(generation, current.Generation),
            Encoding.UTF8.GetByteCount(subjectHash));
        ReplaceLocked(subjectHash, current, conflict);
    }

    private void ReplaceLocked(string subjectHash, Entry current, Entry replacement)
    {
        _entries[subjectHash] = replacement;
        _utf8ResidentBytes += replacement.Utf8Bytes - current.Utf8Bytes;
        if (_orderNodes.TryGetValue(subjectHash, out LinkedListNode<string>? node))
        {
            _writeOrder.Remove(node);
            _writeOrder.AddLast(node);
        }
    }

    private void EnsureCapacityLocked(
        long additionalBytes,
        string? excludedSubjectHash,
        bool requireEntrySlot)
    {
        while (((requireEntrySlot && _entries.Count >= _limits.MaxEntries)
                || _utf8ResidentBytes + Math.Max(0, additionalBytes) > _limits.MaxUtf8ResidentBytes)
            && _writeOrder.First is not null)
        {
            LinkedListNode<string>? victim = _writeOrder.First;
            while (victim is not null
                && string.Equals(victim.Value, excludedSubjectHash, StringComparison.Ordinal))
            {
                victim = victim.Next;
            }

            if (victim is null)
            {
                return;
            }

            RemoveLocked(victim.Value);
        }
    }

    private void RemoveLocked(string subjectHash)
    {
        if (_orderNodes.Remove(subjectHash, out LinkedListNode<string>? node))
        {
            _writeOrder.Remove(node);
        }

        if (_entries.TryRemove(subjectHash, out Entry removed))
        {
            _utf8ResidentBytes -= removed.Utf8Bytes;
            Interlocked.Increment(ref _evictions);
        }
    }

    private bool TryNormalizePayload(
        BanStateProjectionStatus status,
        string? reasonCode,
        out string? normalizedReasonCode)
    {
        normalizedReasonCode = null;
        if (status is not (BanStateProjectionStatus.Normal
            or BanStateProjectionStatus.Banned
            or BanStateProjectionStatus.Deleted))
        {
            return false;
        }

        if (status is not BanStateProjectionStatus.Banned)
        {
            return true;
        }

        string normalized = reasonCode?.Trim() ?? string.Empty;
        if (normalized.Length == 0
            || Encoding.UTF8.GetByteCount(normalized) > _limits.MaxReasonCodeUtf8Bytes)
        {
            return false;
        }

        normalizedReasonCode = normalized;
        return true;
    }

    private static bool TryNormalizeSubjectHash(string? value, out string normalized)
        => AccountSubjectHashRequirement.TryResolve(value, out normalized);

    private static int EstimateUtf8Bytes(string subjectHash, string? reasonCode)
        => checked(
            Encoding.UTF8.GetByteCount(subjectHash)
            + (reasonCode is null ? 0 : Encoding.UTF8.GetByteCount(reasonCode)));

    private void ObserveGeneration(long generation)
        => InterlockedExtensions.Max(ref _highestObservedGeneration, generation);

    private void ObserveAppliedGeneration(long generation)
        => InterlockedExtensions.Max(ref _highestAppliedGeneration, generation);

    private readonly record struct Entry(
        BanStateProjectionStatus Status,
        string? ReasonCode,
        long Generation,
        int Utf8Bytes)
    {
        public BanStateProjectionLookup ToLookup()
            => new(Status, ReasonCode, Generation);

        public bool HasSamePayload(Entry other)
            => Status == other.Status
                && string.Equals(ReasonCode, other.ReasonCode, StringComparison.Ordinal);
    }
}

internal static class InterlockedExtensions
{
    public static void Max(ref long location, long value)
    {
        long current = Volatile.Read(ref location);
        while (value > current)
        {
            long observed = Interlocked.CompareExchange(ref location, value, current);
            if (observed == current)
            {
                return;
            }

            current = observed;
        }
    }
}
