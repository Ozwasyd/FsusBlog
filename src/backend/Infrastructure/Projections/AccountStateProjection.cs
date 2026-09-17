using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Infrastructure.Testing;

namespace FsusBlog.Server.Infrastructure.Projections;

public enum AccountStateKnowledge
{
    Present = 0,
    Missing = 1,
    Deleted = 2,
    Unknown = 3
}

public enum AccountStateReadOutcome
{
    Present = 0,
    Missing = 1,
    Deleted = 2,
    Unknown = 3,
    SubjectMismatch = 4,
    Conflict = 5
}

public enum AccountStateApplyOutcome
{
    Added = 0,
    Updated = 1,
    Idempotent = 2,
    IgnoredStale = 3,
    Conflict = 4,
    Rejected = 5
}

public sealed record AccountStateSnapshot
{
    public required int AccountId
    {
        get;
        init;
    }

    public required long Generation
    {
        get;
        init;
    }

    public required AccountStateKnowledge Knowledge
    {
        get;
        init;
    }

    public string? AccountSubjectHash
    {
        get;
        init;
    }

    public int Status
    {
        get;
        init;
    }

    public string? BanReason
    {
        get;
        init;
    }

    public DateTime? DeletedAt
    {
        get;
        init;
    }

    public string IdentityKind
    {
        get;
        init;
    } = string.Empty;

    public string RegistrationState
    {
        get;
        init;
    } = string.Empty;

    public bool MfaEnabled
    {
        get;
        init;
    }

    public bool PasskeyEnabled
    {
        get;
        init;
    }

    public bool RecoveryEnabled
    {
        get;
        init;
    }

    public string? PublicHandle
    {
        get;
        init;
    }

    public string? AnonymousCredentialStatus
    {
        get;
        init;
    }

    public string? AnonymousCredentialLevel
    {
        get;
        init;
    }
}

public readonly record struct AccountStateReadResult(
    AccountStateReadOutcome Outcome,
    AccountStateSnapshot? Snapshot,
    bool LocalHit)
{
    public bool IsPresent => Outcome == AccountStateReadOutcome.Present && Snapshot is not null;
}

public sealed class AccountStateProjectionOptions
{
    public int MaxEntries { get; set; } = 100_000;

    public long MaxLogicalBytes { get; set; } = 48L * 1024 * 1024;

    public long MaxCapacityBytes { get; set; } = 96L * 1024 * 1024;

    public TimeSpan MissingTtl { get; set; } = TimeSpan.FromSeconds(5);

    public TimeSpan DeletedTtl { get; set; } = TimeSpan.FromSeconds(15);

    public TimeSpan UnknownTtl { get; set; } = TimeSpan.FromSeconds(1);

    internal bool IsValid()
        => MaxEntries > 0
            && MaxLogicalBytes > 0
            && MaxCapacityBytes >= MaxLogicalBytes
            && MissingTtl > TimeSpan.Zero
            && DeletedTtl > TimeSpan.Zero
            && UnknownTtl > TimeSpan.Zero;
}

public readonly record struct AccountStateProjectionRuntimeSnapshot(
    int Entries,
    long LogicalBytes,
    long CapacityBytes,
    int ActiveLoads,
    long HighestGeneration,
    long Evictions,
    long Expirations,
    long AdmissionRejects,
    long Conflicts,
    long SourceLoads,
    long SourceFailures,
    long LocalHits,
    long AuthoritativeRefreshes,
    AccountStateProjectionOptions Limits);

public interface IAccountStateProjectionSource
{
    ValueTask<AccountStateSnapshot> LoadAsync(int accountId, CancellationToken cancellationToken);
}

public interface IAccountStateProjection
{
    ValueTask<AccountStateReadResult> ReadAsync(
        int accountId,
        string expectedAccountSubjectHash,
        CancellationToken cancellationToken = default);

    ValueTask<AccountStateReadResult> ReadByIdAsync(
        int accountId,
        CancellationToken cancellationToken = default);

    ValueTask<AccountStateReadResult> RefreshAsync(
        int accountId,
        string? expectedAccountSubjectHash = null,
        CancellationToken cancellationToken = default);

    AccountStateApplyOutcome ApplyAuthoritative(AccountStateSnapshot snapshot);

    void FailClosed(int accountId);

    AccountStateProjectionRuntimeSnapshot Snapshot();
}

/// <summary>
/// Process-local, byte-bounded account-state authority. A miss has exactly one
/// account-scoped source flight; hot reads never invoke the source. Durable
/// producers can apply authoritative snapshots in any delivery order.
/// </summary>
public sealed class AccountStateProjection : IAccountStateProjection
{
    private const int SubjectHashHexLength = 64;
    private const long EntryLogicalOverhead = 48;
    private const long EntryCapacityOverhead = 192;

    private readonly IAccountStateProjectionSource _source;
    private readonly AccountStateProjectionOptions _limits;
    private readonly TimeProvider _timeProvider;
    private readonly Dictionary<int, Entry> _entries = [];
    private readonly Dictionary<int, LinkedListNode<int>> _nodes = [];
    private readonly LinkedList<int> _order = [];
    private readonly ConcurrentDictionary<int, LoadFlight> _loads = new();
    private readonly object _entryLock = new();
    private long _logicalBytes;
    private long _capacityBytes;
    private long _highestGeneration;
    private long _evictions;
    private long _expirations;
    private long _admissionRejects;
    private long _conflicts;
    private long _sourceLoads;
    private long _sourceFailures;
    private long _localHits;
    private long _authoritativeRefreshes;

    public AccountStateProjection(
        IAccountStateProjectionSource source,
        AccountStateProjectionOptions? options = null,
        TimeProvider? timeProvider = null)
    {
        ArgumentNullException.ThrowIfNull(source);
        _source = source;
        _limits = options ?? new AccountStateProjectionOptions();
        if (!_limits.IsValid())
        {
            throw new InvalidOperationException("AccountStateProjection limits are invalid.");
        }

        _timeProvider = timeProvider ?? TimeProvider.System;
    }

    public async ValueTask<AccountStateReadResult> ReadAsync(
        int accountId,
        string expectedAccountSubjectHash,
        CancellationToken cancellationToken = default)
    {
        if (accountId <= 0 || !TryNormalizeSubjectHash(expectedAccountSubjectHash, out string expectedSubjectHash))
        {
            return new AccountStateReadResult(AccountStateReadOutcome.SubjectMismatch, null, LocalHit: false);
        }

        if (TryReadLocal(accountId, expectedSubjectHash, out AccountStateReadResult local))
        {
            Interlocked.Increment(ref _localHits);
            RuntimeCacheEvidenceObservation.Current?.RecordCacheEvent(
                "security-account-projection",
                accountId.ToString(System.Globalization.CultureInfo.InvariantCulture),
                "hit");
            return local;
        }

        AccountStateSnapshot loaded = await LoadThroughSingleFlightAsync(accountId, cancellationToken).ConfigureAwait(false);
        if (TryReadLocal(accountId, expectedSubjectHash, out local))
        {
            return local with
            {
                LocalHit = false
            };
        }

        return Evaluate(loaded, accountId, expectedSubjectHash, localHit: false, conflict: false);
    }

    public async ValueTask<AccountStateReadResult> ReadByIdAsync(
        int accountId,
        CancellationToken cancellationToken = default)
    {
        if (accountId <= 0)
        {
            return new AccountStateReadResult(AccountStateReadOutcome.Conflict, null, LocalHit: false);
        }

        if (TryReadLocalById(accountId, out AccountStateReadResult local))
        {
            Interlocked.Increment(ref _localHits);
            RuntimeCacheEvidenceObservation.Current?.RecordCacheEvent(
                "security-account-projection",
                accountId.ToString(System.Globalization.CultureInfo.InvariantCulture),
                "hit");
            return local;
        }

        AccountStateSnapshot loaded = await LoadThroughSingleFlightAsync(accountId, cancellationToken).ConfigureAwait(false);
        if (TryReadLocalById(accountId, out local))
        {
            return local with
            {
                LocalHit = false
            };
        }

        return EvaluateById(loaded, accountId, localHit: false, conflict: false);
    }

    public async ValueTask<AccountStateReadResult> RefreshAsync(
        int accountId,
        string? expectedAccountSubjectHash = null,
        CancellationToken cancellationToken = default)
    {
        if (accountId <= 0
            || (expectedAccountSubjectHash is not null
                && !TryNormalizeSubjectHash(expectedAccountSubjectHash, out _)))
        {
            return new AccountStateReadResult(AccountStateReadOutcome.SubjectMismatch, null, LocalHit: false);
        }

        Interlocked.Increment(ref _authoritativeRefreshes);
        AccountStateSnapshot loaded = await LoadThroughSingleFlightAsync(accountId, cancellationToken).ConfigureAwait(false);
        if (loaded.Knowledge == AccountStateKnowledge.Unknown)
        {
            return new AccountStateReadResult(AccountStateReadOutcome.Unknown, null, LocalHit: false);
        }

        if (expectedAccountSubjectHash is not null)
        {
            return TryReadLocal(accountId, expectedAccountSubjectHash, out AccountStateReadResult bound)
                ? bound with
                {
                    LocalHit = false
                }
                : Evaluate(loaded, accountId, expectedAccountSubjectHash, localHit: false, conflict: false);
        }

        return TryReadLocalById(accountId, out AccountStateReadResult local)
            ? local with
            {
                LocalHit = false
            }
            : EvaluateById(loaded, accountId, localHit: false, conflict: false);
    }

    public AccountStateApplyOutcome ApplyAuthoritative(AccountStateSnapshot snapshot)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        if (!TryNormalizeSnapshot(snapshot, authoritative: true, out AccountStateSnapshot normalized))
        {
            Interlocked.Increment(ref _admissionRejects);
            return AccountStateApplyOutcome.Rejected;
        }

        lock (_entryLock)
        {
            return ApplyLocked(normalized, sourceLoad: false);
        }
    }

    public void FailClosed(int accountId)
    {
        if (accountId <= 0)
        {
            return;
        }

        lock (_entryLock)
        {
            RemoveEntryLocked(accountId, expiration: false);
            _ = ReplaceLocked(accountId, Unknown(accountId), conflict: false, AccountStateApplyOutcome.Added);
        }
    }

    public AccountStateProjectionRuntimeSnapshot Snapshot()
    {
        lock (_entryLock)
        {
            return new AccountStateProjectionRuntimeSnapshot(
                _entries.Count,
                _logicalBytes,
                _capacityBytes,
                _loads.Count,
                Volatile.Read(ref _highestGeneration),
                Volatile.Read(ref _evictions),
                Volatile.Read(ref _expirations),
                Volatile.Read(ref _admissionRejects),
                Volatile.Read(ref _conflicts),
                Volatile.Read(ref _sourceLoads),
                Volatile.Read(ref _sourceFailures),
                Volatile.Read(ref _localHits),
                Volatile.Read(ref _authoritativeRefreshes),
                CopyOptions());
        }
    }

    private async ValueTask<AccountStateSnapshot> LoadThroughSingleFlightAsync(
        int accountId,
        CancellationToken cancellationToken)
    {
        LoadFlight candidate = new();
        LoadFlight flight = _loads.GetOrAdd(accountId, candidate);
        if (ReferenceEquals(candidate, flight))
        {
            _ = RunSourceLoadAsync(accountId, flight);
        }

        return await flight.Task.WaitAsync(cancellationToken).ConfigureAwait(false);
    }

    private async Task RunSourceLoadAsync(int accountId, LoadFlight flight)
    {
        Interlocked.Increment(ref _sourceLoads);
        AccountStateSnapshot loaded;
        try
        {
            loaded = await _source.LoadAsync(accountId, CancellationToken.None).ConfigureAwait(false);
            RuntimeCacheEvidenceObservation.Current?.RecordCacheEvent(
                "security-account-projection",
                accountId.ToString(System.Globalization.CultureInfo.InvariantCulture),
                "built");
            if (!TryNormalizeSnapshot(loaded, authoritative: false, out AccountStateSnapshot normalized)
                || normalized.AccountId != accountId)
            {
                Interlocked.Increment(ref _sourceFailures);
                loaded = Unknown(accountId);
                lock (_entryLock)
                {
                    MarkConflictLocked(accountId, Math.Max(0, normalized?.Generation ?? 0));
                }
            }
            else
            {
                loaded = normalized;
                lock (_entryLock)
                {
                    _ = ApplyLocked(loaded, sourceLoad: true);
                }
            }
        }
        catch (Exception)
        {
            Interlocked.Increment(ref _sourceFailures);
            loaded = Unknown(accountId);
            lock (_entryLock)
            {
                _ = ApplyLocked(loaded, sourceLoad: true);
            }
        }
        flight.SetResult(loaded);
        _loads.TryRemove(new KeyValuePair<int, LoadFlight>(accountId, flight));
    }

    private bool TryReadLocal(
        int accountId,
        string expectedSubjectHash,
        out AccountStateReadResult result)
    {
        lock (_entryLock)
        {
            if (!_entries.TryGetValue(accountId, out Entry? entry))
            {
                result = default;
                return false;
            }

            if (IsExpired(entry))
            {
                RemoveEntryLocked(accountId, expiration: true);
                result = default;
                return false;
            }

            TouchLocked(accountId);
            result = Evaluate(entry.Snapshot, accountId, expectedSubjectHash, localHit: true, entry.Conflict);
            return true;
        }
    }

    private bool TryReadLocalById(int accountId, out AccountStateReadResult result)
    {
        lock (_entryLock)
        {
            if (!_entries.TryGetValue(accountId, out Entry? entry))
            {
                result = default;
                return false;
            }

            if (IsExpired(entry))
            {
                RemoveEntryLocked(accountId, expiration: true);
                result = default;
                return false;
            }

            TouchLocked(accountId);
            result = EvaluateById(entry.Snapshot, accountId, localHit: true, entry.Conflict);
            return true;
        }
    }

    private AccountStateApplyOutcome ApplyLocked(AccountStateSnapshot snapshot, bool sourceLoad)
    {
        if (_entries.TryGetValue(snapshot.AccountId, out Entry? current) && IsExpired(current))
        {
            RemoveEntryLocked(snapshot.AccountId, expiration: true);
            current = null;
        }

        if (current is not null)
        {
            if (snapshot.Knowledge == AccountStateKnowledge.Unknown)
            {
                return AccountStateApplyOutcome.IgnoredStale;
            }

            if (snapshot.Generation < current.Generation)
            {
                return AccountStateApplyOutcome.IgnoredStale;
            }

            if (snapshot.Generation == current.Generation)
            {
                if (current.Conflict)
                {
                    return AccountStateApplyOutcome.Conflict;
                }

                if (current.Snapshot == snapshot)
                {
                    return AccountStateApplyOutcome.Idempotent;
                }

                if (current.Snapshot.Knowledge == AccountStateKnowledge.Unknown && sourceLoad)
                {
                    return ReplaceLocked(snapshot.AccountId, snapshot, conflict: false, AccountStateApplyOutcome.Updated);
                }

                MarkConflictLocked(snapshot.AccountId, snapshot.Generation);
                return AccountStateApplyOutcome.Conflict;
            }
        }

        AccountStateApplyOutcome outcome = current is null
            ? AccountStateApplyOutcome.Added
            : AccountStateApplyOutcome.Updated;
        return ReplaceLocked(snapshot.AccountId, snapshot, conflict: false, outcome);
    }

    private AccountStateApplyOutcome ReplaceLocked(
        int accountId,
        AccountStateSnapshot snapshot,
        bool conflict,
        AccountStateApplyOutcome outcome)
    {
        if (_entries.TryGetValue(accountId, out Entry? current))
        {
            _logicalBytes -= current.LogicalBytes;
            _capacityBytes -= current.CapacityBytes;
        }

        (long logicalBytes, long capacityBytes) = Measure(snapshot);
        _entries[accountId] = new Entry(
            snapshot,
            snapshot.Generation,
            conflict,
            ResolveExpiration(snapshot.Knowledge),
            logicalBytes,
            capacityBytes);
        _logicalBytes += logicalBytes;
        _capacityBytes += capacityBytes;
        Volatile.Write(ref _highestGeneration, Math.Max(Volatile.Read(ref _highestGeneration), snapshot.Generation));

        if (_nodes.TryGetValue(accountId, out LinkedListNode<int>? existingNode))
        {
            _order.Remove(existingNode);
            _order.AddLast(existingNode);
        }
        else
        {
            _nodes[accountId] = _order.AddLast(accountId);
        }

        TrimToBudgetLocked();
        if (!_entries.ContainsKey(accountId))
        {
            Interlocked.Increment(ref _admissionRejects);
            return AccountStateApplyOutcome.Rejected;
        }

        return outcome;
    }

    private void MarkConflictLocked(int accountId, long generation)
    {
        Interlocked.Increment(ref _conflicts);
        if (_entries.TryGetValue(accountId, out Entry? current))
        {
            _entries[accountId] = current with
            {
                Conflict = true,
                Generation = Math.Max(current.Generation, generation),
                ExpiresAtTimestamp = AddTimestamp(_limits.UnknownTtl)
            };
            TouchLocked(accountId);
            return;
        }

        AccountStateSnapshot unknown = Unknown(accountId) with
        {
            Generation = generation
        };
        _ = ReplaceLocked(accountId, unknown, conflict: true, AccountStateApplyOutcome.Conflict);
    }

    private void TrimToBudgetLocked()
    {
        while (_order.First is { } oldest
            && (_entries.Count > _limits.MaxEntries
                || _logicalBytes > _limits.MaxLogicalBytes
                || _capacityBytes > _limits.MaxCapacityBytes))
        {
            RemoveEntryLocked(oldest.Value, expiration: false);
        }
    }

    private void TouchLocked(int accountId)
    {
        if (_nodes.TryGetValue(accountId, out LinkedListNode<int>? node))
        {
            _order.Remove(node);
            _order.AddLast(node);
        }
    }

    private void RemoveEntryLocked(int accountId, bool expiration)
    {
        if (_nodes.Remove(accountId, out LinkedListNode<int>? node))
        {
            _order.Remove(node);
        }

        if (_entries.Remove(accountId, out Entry? entry))
        {
            _logicalBytes -= entry.LogicalBytes;
            _capacityBytes -= entry.CapacityBytes;
            if (expiration)
            {
                Interlocked.Increment(ref _expirations);
            }
            else
            {
                Interlocked.Increment(ref _evictions);
            }
        }
    }

    private bool IsExpired(Entry entry)
        => entry.ExpiresAtTimestamp != long.MaxValue
            && _timeProvider.GetTimestamp() >= entry.ExpiresAtTimestamp;

    private long ResolveExpiration(AccountStateKnowledge knowledge)
        => knowledge switch
        {
            AccountStateKnowledge.Present => long.MaxValue,
            AccountStateKnowledge.Missing => AddTimestamp(_limits.MissingTtl),
            AccountStateKnowledge.Deleted => AddTimestamp(_limits.DeletedTtl),
            _ => AddTimestamp(_limits.UnknownTtl)
        };

    private long AddTimestamp(TimeSpan ttl)
    {
        long delta = Math.Max(
            1L,
            (long)Math.Ceiling(ttl.TotalSeconds * _timeProvider.TimestampFrequency));
        long now = _timeProvider.GetTimestamp();
        return now > long.MaxValue - delta ? long.MaxValue : now + delta;
    }

    private static AccountStateReadResult Evaluate(
        AccountStateSnapshot snapshot,
        int requestedAccountId,
        string expectedSubjectHash,
        bool localHit,
        bool conflict)
    {
        if (conflict || snapshot.AccountId != requestedAccountId)
        {
            return new AccountStateReadResult(AccountStateReadOutcome.Conflict, null, localHit);
        }

        if (snapshot.Knowledge == AccountStateKnowledge.Unknown)
        {
            return new AccountStateReadResult(AccountStateReadOutcome.Unknown, null, localHit);
        }

        if (snapshot.Knowledge == AccountStateKnowledge.Missing)
        {
            return new AccountStateReadResult(AccountStateReadOutcome.Missing, null, localHit);
        }

        if (!SubjectHashesEqual(snapshot.AccountSubjectHash, expectedSubjectHash))
        {
            return new AccountStateReadResult(AccountStateReadOutcome.SubjectMismatch, null, localHit);
        }

        AccountStateReadOutcome outcome = snapshot.Knowledge == AccountStateKnowledge.Deleted
            ? AccountStateReadOutcome.Deleted
            : AccountStateReadOutcome.Present;
        return new AccountStateReadResult(outcome, snapshot, localHit);
    }

    private static AccountStateReadResult EvaluateById(
        AccountStateSnapshot snapshot,
        int requestedAccountId,
        bool localHit,
        bool conflict)
    {
        if (conflict || snapshot.AccountId != requestedAccountId)
        {
            return new AccountStateReadResult(AccountStateReadOutcome.Conflict, null, localHit);
        }

        AccountStateReadOutcome outcome = snapshot.Knowledge switch
        {
            AccountStateKnowledge.Present => AccountStateReadOutcome.Present,
            AccountStateKnowledge.Missing => AccountStateReadOutcome.Missing,
            AccountStateKnowledge.Deleted => AccountStateReadOutcome.Deleted,
            _ => AccountStateReadOutcome.Unknown
        };
        return new AccountStateReadResult(
            outcome,
            outcome is AccountStateReadOutcome.Present or AccountStateReadOutcome.Deleted ? snapshot : null,
            localHit);
    }

    private static bool TryNormalizeSnapshot(
        AccountStateSnapshot snapshot,
        bool authoritative,
        out AccountStateSnapshot normalized)
    {
        normalized = snapshot;
        if (snapshot.AccountId <= 0 || snapshot.Generation < 0 || (authoritative && snapshot.Generation == 0))
        {
            return false;
        }

        if (snapshot.Knowledge == AccountStateKnowledge.Unknown)
        {
            return !authoritative && snapshot.Generation == 0;
        }

        if (snapshot.Knowledge == AccountStateKnowledge.Missing)
        {
            return !authoritative || snapshot.Generation > 0;
        }

        if (!TryNormalizeSubjectHash(snapshot.AccountSubjectHash, out string subjectHash)
            || string.IsNullOrWhiteSpace(snapshot.IdentityKind)
            || string.IsNullOrWhiteSpace(snapshot.RegistrationState)
            || (snapshot.Knowledge == AccountStateKnowledge.Present && snapshot.DeletedAt.HasValue)
            || (snapshot.Knowledge == AccountStateKnowledge.Deleted && !snapshot.DeletedAt.HasValue))
        {
            return false;
        }

        normalized = snapshot with
        {
            AccountSubjectHash = subjectHash,
            IdentityKind = snapshot.IdentityKind.Trim(),
            RegistrationState = snapshot.RegistrationState.Trim(),
            PublicHandle = NormalizeOptional(snapshot.PublicHandle),
            AnonymousCredentialStatus = NormalizeOptional(snapshot.AnonymousCredentialStatus),
            AnonymousCredentialLevel = NormalizeOptional(snapshot.AnonymousCredentialLevel)
        };
        return true;
    }

    private static string? NormalizeOptional(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static bool SubjectHashesEqual(string? actual, string expected)
    {
        if (!TryNormalizeSubjectHash(actual, out string normalizedActual))
        {
            return false;
        }

        Span<byte> actualBytes = stackalloc byte[SubjectHashHexLength / 2];
        Span<byte> expectedBytes = stackalloc byte[SubjectHashHexLength / 2];
        return TryDecodeSubjectHash(normalizedActual, actualBytes)
            && TryDecodeSubjectHash(expected, expectedBytes)
            && CryptographicOperations.FixedTimeEquals(actualBytes, expectedBytes);
    }

    private static bool TryDecodeSubjectHash(string value, Span<byte> destination)
    {
        if (value.Length != destination.Length * 2)
        {
            return false;
        }

        for (int index = 0; index < destination.Length; index++)
        {
            int high = HexValue(value[index * 2]);
            int low = HexValue(value[(index * 2) + 1]);
            if (high < 0 || low < 0)
            {
                return false;
            }

            destination[index] = (byte)((high << 4) | low);
        }

        return true;
    }

    private static int HexValue(char value)
    {
        if (value is >= '0' and <= '9')
        {
            return value - '0';
        }

        if (value is >= 'a' and <= 'f')
        {
            return value - 'a' + 10;
        }

        return -1;
    }

    private static bool TryNormalizeSubjectHash(string? value, out string normalized)
    {
        normalized = string.Empty;
        if (value is null || value.Length != SubjectHashHexLength)
        {
            return false;
        }

        for (int index = 0; index < value.Length; index++)
        {
            char character = value[index];
            if (character is not (>= '0' and <= '9' or >= 'a' and <= 'f' or >= 'A' and <= 'F'))
            {
                return false;
            }
        }

        normalized = value.ToLowerInvariant();
        return true;
    }

    private static (long LogicalBytes, long CapacityBytes) Measure(AccountStateSnapshot snapshot)
    {
        string?[] strings =
        [
            snapshot.AccountSubjectHash,
            snapshot.IdentityKind,
            snapshot.RegistrationState,
            snapshot.BanReason,
            snapshot.PublicHandle,
            snapshot.AnonymousCredentialStatus,
            snapshot.AnonymousCredentialLevel
        ];
        long logical = EntryLogicalOverhead;
        long capacity = EntryCapacityOverhead;
        foreach (string? value in strings)
        {
            if (value is null)
            {
                continue;
            }

            logical += Encoding.UTF8.GetByteCount(value);
            capacity += 24L + (value.Length * sizeof(char));
        }

        return (logical, capacity);
    }

    private static AccountStateSnapshot Unknown(int accountId)
        => new()
        {
            AccountId = accountId,
            Generation = 0,
            Knowledge = AccountStateKnowledge.Unknown
        };

    private AccountStateProjectionOptions CopyOptions()
        => new()
        {
            MaxEntries = _limits.MaxEntries,
            MaxLogicalBytes = _limits.MaxLogicalBytes,
            MaxCapacityBytes = _limits.MaxCapacityBytes,
            MissingTtl = _limits.MissingTtl,
            DeletedTtl = _limits.DeletedTtl,
            UnknownTtl = _limits.UnknownTtl
        };

    private sealed record Entry(
        AccountStateSnapshot Snapshot,
        long Generation,
        bool Conflict,
        long ExpiresAtTimestamp,
        long LogicalBytes,
        long CapacityBytes);

    private sealed class LoadFlight
    {
        private readonly TaskCompletionSource<AccountStateSnapshot> _completion =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        internal Task<AccountStateSnapshot> Task => _completion.Task;

        internal void SetResult(AccountStateSnapshot snapshot)
            => _completion.TrySetResult(snapshot);
    }
}
