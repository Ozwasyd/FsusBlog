using System.Collections.Concurrent;
using System.Text;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Testing;

namespace FsusBlog.Server.Infrastructure.Security;

/// <summary>
/// Describes a process-local ban fact. Unknown is not a normal-account fact or
/// permission to admit a request; these values are not database status codes.
/// </summary>
public enum BanStateProjectionStatus
{
    Unknown = 0,
    Normal = 1,
    Banned = 2,
    Deleted = 3
}

/// <summary>
/// Carries a subject-scoped source fact for local validation and generation ordering.
/// Constructing an update does not apply it or commit an authority transaction.
/// </summary>
/// <param name="AccountSubjectHash">Account subject hash normalized when the update is applied.</param>
/// <param name="Status">Normal, banned, or deleted fact; unknown is not an admissible source payload.</param>
/// <param name="ReasonCode">Ban reason validated as trimmed UTF-8; ignored for non-banned facts.</param>
/// <param name="Generation">Positive source generation used to reject older or conflicting facts.</param>
public readonly record struct BanStateProjectionUpdate(
    string AccountSubjectHash,
    BanStateProjectionStatus Status,
    string? ReasonCode,
    long Generation);

/// <summary>
/// Returns the local status and generation fence without certifying authority
/// availability or request authorization. Unknown may retain a conflict generation.
/// </summary>
/// <param name="Status">Known local fact or unknown when no usable fact is stored.</param>
/// <param name="ReasonCode">Stored ban reason, or null for normal, deleted, and unknown results.</param>
/// <param name="Generation">Stored source generation, or zero when no subject fence is available.</param>
public readonly record struct BanStateProjectionLookup(
    BanStateProjectionStatus Status,
    string? ReasonCode,
    long Generation)
{
    /// <summary>
    /// Reports only whether the status differs from unknown; it performs no
    /// authority read and does not turn a banned or deleted fact into permission.
    /// </summary>
    public bool IsKnown => Status is not BanStateProjectionStatus.Unknown;

    /// <summary>Creates an unknown result while retaining the supplied generation fence.</summary>
    /// <param name="generation">Fence to carry, or zero when no generation is known.</param>
    /// <returns>An unknown lookup with no reason code.</returns>
    public static BanStateProjectionLookup Unknown(long generation = 0)
        => new(BanStateProjectionStatus.Unknown, null, generation);
}

/// <summary>
/// Distinguishes local application from validation, ordering, conflict, and
/// capacity outcomes. A conflict can replace a known fact with an unknown fence.
/// </summary>
public enum BanStateProjectionApplyResult
{
    Applied = 0,
    RejectedInvalid = 1,
    RejectedStale = 2,
    RejectedDuplicate = 3,
    FailedClosedConflict = 4,
    RejectedOverBudget = 5
}

/// <summary>
/// Bounds stored entry count and UTF-8 subject/reason payload accounting.
/// These limits do not measure or cap CLR objects, dictionaries, or total heap use.
/// </summary>
public sealed class BanStateProjectionLimits
{
    /// <summary>
    /// Maximum stored subjects, including unknown fences. Capacity admission
    /// evicts earlier-written entries; local reads stay unknown until a fact is restored.
    /// </summary>
    public int MaxEntries { get; init; } = 100_000;

    /// <summary>
    /// Maximum sum of UTF-8 bytes for stored normalized subjects and ban reasons,
    /// excluding collection and managed-object overhead.
    /// </summary>
    public long MaxUtf8ResidentBytes { get; init; } = 8 * 1024 * 1024;

    /// <summary>
    /// Maximum UTF-8 byte length, not character count, of a trimmed nonempty ban reason.
    /// A banned fact with an invalid reason is rejected rather than truncated.
    /// </summary>
    public int MaxReasonCodeUtf8Bytes { get; init; } = 64;

    internal bool IsValid()
        => MaxEntries > 0
            && MaxUtf8ResidentBytes >= AccountSubjectHashRequirement.Sha256HexLength
            && MaxReasonCodeUtf8Bytes > 0
            && MaxReasonCodeUtf8Bytes <= MaxUtf8ResidentBytes;
}

/// <param name="Entries">Stored subjects, including unknown fences.</param>
/// <param name="Utf8ResidentBytes">Accounted subject and reason UTF-8 payload bytes.</param>
/// <param name="MaxEntries">Configured stored-subject limit.</param>
/// <param name="MaxUtf8ResidentBytes">Configured payload-byte limit, not a managed-heap limit.</param>
/// <param name="AppliedUpdates">Updates accepted into the local projection.</param>
/// <param name="InvalidUpdates">Updates rejected for invalid subject, generation, status, or reason.</param>
/// <param name="StaleUpdates">Updates rejected because a newer subject generation is stored.</param>
/// <param name="DuplicateUpdates">Same-generation updates whose payload matches the stored fact.</param>
/// <param name="Conflicts">Same-generation payload conflicts replaced by unknown fences.</param>
/// <param name="Evictions">Entries removed by capacity eviction.</param>
/// <param name="OverBudgetUpdates">Updates rejected by payload or entry capacity admission.</param>
/// <param name="KnownReads">Counted read outcomes with a status other than unknown.</param>
/// <param name="UnknownReads">Counted unknown read outcomes, including invalid or absent subjects.</param>
/// <param name="SourceLoads">Authority loads started after the local known-value recheck.</param>
/// <param name="HighestObservedGeneration">Largest generation observed by Apply, including rejected facts.</param>
/// <param name="HighestAppliedGeneration">Largest generation accepted into the local projection.</param>
/// <summary>
/// Captures local capacity accounting, outcome counters, and generation watermarks
/// for diagnostics; it is not a per-subject convergence or readiness certificate.
/// </summary>
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
    /// <summary>
    /// Nonnegative difference between observed and applied global watermarks.
    /// Zero does not prove that every subject is current or ready for admission.
    /// </summary>
    public long VersionLag => Math.Max(0, HighestObservedGeneration - HighestAppliedGeneration);
}

/// <summary>
/// Loads one authoritative ban-state fact. Implementations may use a database or
/// another authority, but the projection itself has no dependency on either.
/// A missing row is represented by <see langword="null"/> and supplies no fact.
/// The projection then rereads local state, which may contain a concurrent update.
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

    /// <summary>Creates an initially empty local projection backed by the supplied authority source.</summary>
    /// <param name="source">Authority used only for unknown asynchronous reads.</param>
    /// <param name="limits">Payload and entry limits, or null to use the default limits.</param>
    /// <exception cref="ArgumentNullException">The source is null.</exception>
    /// <exception cref="ArgumentOutOfRangeException">The supplied limits are invalid.</exception>
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

    /// <summary>
    /// Reads by subject alone, forwarding account ID zero to the existing load path.
    /// This does not supply the physical account identity an authority may require.
    /// Source failures propagate rather than becoming successful lookups.
    /// </summary>
    /// <param name="accountSubjectHash">Subject hash to normalize and resolve locally or through the source.</param>
    /// <param name="cancellationToken">Cancels this wait, not a shared authority load for other waiters.</param>
    /// <returns>A known local result or the lookup remaining after the shared load.</returns>
    public ValueTask<BanStateProjectionLookup> GetAsync(
        string? accountSubjectHash,
        CancellationToken cancellationToken = default)
        => GetAsync(0, accountSubjectHash, cancellationToken);

    /// <summary>
    /// Validates and applies a fact under the local write lock, rejecting older
    /// generations and duplicates. Same-generation conflicts and invalid payloads
    /// at the stored generation or newer fail closed to unknown; capacity admission
    /// can evict other subjects.
    /// No authority write or cross-node acknowledgement is performed here.
    /// </summary>
    /// <param name="update">Source fact whose generation is observed before payload validation.</param>
    /// <returns>The local validation, ordering, conflict, capacity, or application outcome.</returns>
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

    /// <summary>
    /// Reads entry and payload accounting under the write lock and samples counters
    /// with volatile reads. Counters updated outside that lock are not one transaction.
    /// </summary>
    /// <returns>Local diagnostic accounting without an all-subject freshness guarantee.</returns>
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
    /// <summary>
    /// Raises a shared signed 64-bit value only while the candidate exceeds the
    /// observed value. A lost compare-exchange retries against the winning value;
    /// a candidate no larger than that observation leaves the location unchanged.
    /// </summary>
    /// <param name="location">Shared generation watermark read with volatile and compare-exchange operations.</param>
    /// <param name="value">Candidate watermark; values no larger than the current observation are ignored.</param>
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
