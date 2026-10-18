using System.Security.Cryptography;

using FsusBlog.Server.Infrastructure.Testing;

namespace FsusBlog.Server.Infrastructure.Security;

/// <summary>
/// Sets hard limits on retained session entries, principal entries, and estimated resident bytes.
/// A limit breach makes the projection not-ready instead of evicting an active session.
/// </summary>
public sealed record AdminSessionProjectionLimits(
    int MaxSessionEntries,
    int MaxPrincipalEntries,
    long MaxResidentBytes)
{
    /// <summary>
    /// Rejects nonpositive limits before they can govern a projection instance.
    /// </summary>
    public void Validate()
    {
        if (MaxSessionEntries <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(MaxSessionEntries));
        }

        if (MaxPrincipalEntries <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(MaxPrincipalEntries));
        }

        if (MaxResidentBytes <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(MaxResidentBytes));
        }
    }
}

/// <summary>
/// Distinguishes an active principal from one that local validation must reject.
/// </summary>
public enum AdminSessionProjectionPrincipalStatus : byte
{
    Active = 0,
    Disabled = 1
}

/// <summary>
/// Describes whether a versioned update changed state, repeated or lagged behind it,
/// or was rejected because its facts, capacity, or same-version content conflicted.
/// </summary>
public enum AdminSessionProjectionApplyStatus : byte
{
    Applied = 0,
    Duplicate = 1,
    Stale = 2,
    Invalid = 3,
    CapacityExceeded = 4,
    Conflict = 5
}

/// <summary>
/// Identifies whether a validation decision came from the local projection.
/// A decision made before a local lookup has no projection source.
/// </summary>
public static class AdminSessionProjectionSources
{
    public const string None = "none";
    public const string LocalProjection = "local-projection";
}

/// <summary>
/// Provides distinct local validation reasons for readiness, identity, principal state,
/// revocation, expiry, and token-hash checks.
/// </summary>
public static class AdminSessionProjectionReasons
{
    public const string Valid = "ok";
    public const string NotReady = "admin_session_projection_not_ready";
    public const string UnknownSession = "admin_session_projection_unknown";
    public const string UnknownPrincipal = "admin_principal_projection_unknown";
    public const string PrincipalMismatch = "admin_session_principal_mismatch";
    public const string PrincipalInactive = "admin_principal_inactive";
    public const string Revoked = "admin_session_revoked";
    public const string IdleExpired = "admin_session_idle_expired";
    public const string AbsoluteExpired = "admin_session_absolute_expired";
    public const string TokenMismatch = "admin_session_token_mismatch";
}

/// <summary>
/// Carries a principal's current status, per-principal version, and delivery generation.
/// Stale versions cannot replace newer projected state.
/// </summary>
public readonly record struct AdminSessionProjectionPrincipalUpdate(
    long PrincipalId,
    AdminSessionProjectionPrincipalStatus Status,
    long Version,
    long Generation);

/// <summary>
/// Carries one session's identity, fixed-size token hash, expiry and revocation facts,
/// version, generation, and matching principal update for atomic local admission.
/// </summary>
public readonly record struct AdminSessionProjectionSessionUpdate(
    string SessionId,
    long PrincipalId,
    ReadOnlyMemory<byte> AccessTokenHash,
    DateTimeOffset? RevokedAtUtc,
    DateTimeOffset IdleExpiresAtUtc,
    DateTimeOffset AbsoluteExpiresAtUtc,
    long Version,
    long Generation,
    AdminSessionProjectionPrincipalUpdate Principal);

/// <summary>
/// Reports the update disposition and highest processed generation, with a rejection detail
/// when invalid input, capacity, or conflicting same-version facts prevent admission.
/// </summary>
public readonly record struct AdminSessionProjectionApplyResult(
    AdminSessionProjectionApplyStatus Status,
    long LastProcessedGeneration,
    string? Detail = null)
{
    /// <summary>
    /// Indicates that the update was applied or was already represented by equal or newer state;
    /// invalid, capacity-rejected, and conflicting updates are not accepted.
    /// </summary>
    public bool Accepted => Status is AdminSessionProjectionApplyStatus.Applied
        or AdminSessionProjectionApplyStatus.Duplicate
        or AdminSessionProjectionApplyStatus.Stale;
}

/// <summary>
/// Returns a local validation decision and its reason, source, and version coordinates.
/// Successful decisions also carry the projected idle and absolute expiry times.
/// </summary>
public readonly record struct AdminSessionProjectionValidationResult(
    bool IsValid,
    string Reason,
    string Source,
    long SessionVersion,
    long PrincipalVersion,
    long Generation)
{
    public DateTimeOffset IdleExpiresAtUtc
    {
        get;
        init;
    }

    public DateTimeOffset AbsoluteExpiresAtUtc
    {
        get;
        init;
    }

    internal static AdminSessionProjectionValidationResult Invalid(
        string reason,
        string source = AdminSessionProjectionSources.None,
        long sessionVersion = 0,
        long principalVersion = 0,
        long generation = 0)
        => new(false, reason, source, sessionVersion, principalVersion, generation);
}

/// <summary>
/// Captures readiness, entry and byte budgets, and local decision counters under the
/// projection lock. Authority-read count remains zero for this process-local owner.
/// </summary>
public readonly record struct AdminSessionProjectionSnapshot(
    bool IsReady,
    string? NotReadyReason,
    long ReadyGeneration,
    long LastProcessedGeneration,
    int SessionEntries,
    int PrincipalEntries,
    long ResidentBytes,
    int MaxSessionEntries,
    int MaxPrincipalEntries,
    long MaxResidentBytes,
    long ValidationCount,
    long ProjectionReadCount,
    long AuthorityReadCount,
    long AppliedCount,
    long DuplicateCount,
    long StaleCount,
    long InvalidUpdateCount,
    long CapacityRejectedCount,
    long ConflictCount,
    long PrunedSessionCount);

/// <summary>
/// Process-local authority projection for admin access-session validation.
/// Mutable projection state is serialized by the same <c>_gate</c> lock for reads and writes.
/// It owns no Redis, database, filesystem, HTTP, DI, mutation, or touch dependency.
/// Active sessions are never evicted to admit another update: a budget breach makes
/// the projection not-ready so subsequent validation remains fail-closed.
/// </summary>
public sealed partial class AdminSessionProjection
{
    private const int SessionFixedBytes = 224;
    private const int PrincipalFixedBytes = 80;
    private const int Sha256Bytes = 32;
    private const int MaxSessionIdLength = 128;

    private readonly object _gate = new();
    private readonly Dictionary<string, SessionEntry> _sessions = new(StringComparer.Ordinal);
    private readonly Dictionary<long, PrincipalEntry> _principals = [];
    private readonly AdminSessionProjectionLimits _limits;
    private readonly TimeProvider _timeProvider;
    private bool _ready;
    private string? _notReadyReason = "cold-start";
    private long _readyGeneration;
    private long _lastProcessedGeneration;
    private long _residentBytes;
    private long _validationCount;
    private long _projectionReadCount;
    private long _appliedCount;
    private long _duplicateCount;
    private long _staleCount;
    private long _invalidUpdateCount;
    private long _capacityRejectedCount;
    private long _conflictCount;
    private long _prunedSessionCount;

    /// <summary>
    /// Creates an empty, not-ready projection after validating positive budgets.
    /// An injected time provider controls expiry checks; otherwise the system provider is used.
    /// </summary>
    public AdminSessionProjection(AdminSessionProjectionLimits limits, TimeProvider? timeProvider = null)
    {
        ArgumentNullException.ThrowIfNull(limits);
        limits.Validate();
        _limits = limits;
        _timeProvider = timeProvider ?? TimeProvider.System;
    }

    /// <summary>
    /// Marks the projection ready only after its processed generation reaches the supplied
    /// authority generation; a lagged projection stays not-ready.
    /// </summary>
    public bool MarkReady(long authorityGeneration)
    {
        if (authorityGeneration < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(authorityGeneration));
        }

        using (EnterGate())
        {
            if (_lastProcessedGeneration < authorityGeneration)
            {
                _ready = false;
                _notReadyReason = "generation-lag";
                return false;
            }

            _ready = true;
            _notReadyReason = null;
            _readyGeneration = authorityGeneration;
            return true;
        }
    }

    /// <summary>
    /// Withdraws readiness with a required nonblank reason without discarding retained facts.
    /// </summary>
    public void MarkNotReady(string reason)
    {
        if (string.IsNullOrWhiteSpace(reason))
        {
            throw new ArgumentException("A not-ready reason is required.", nameof(reason));
        }

        using (EnterGate())
        {
            _ready = false;
            _notReadyReason = reason.Trim();
        }
    }

    /// <summary>
    /// Applies a principal update by per-principal version, rejecting invalid, conflicting,
    /// or over-budget facts without evicting active sessions.
    /// </summary>
    public AdminSessionProjectionApplyResult Apply(AdminSessionProjectionPrincipalUpdate update)
    {
        if (!TryCreatePrincipalEntry(update, out PrincipalEntry? candidate, out string? error))
        {
            using (EnterGate())
            {
                _invalidUpdateCount++;
                return Result(AdminSessionProjectionApplyStatus.Invalid, error);
            }
        }

        using (EnterGate())
        {
            PrincipalEntry principalCandidate = candidate!;
            PruneTerminalSessionsLocked(_timeProvider.GetUtcNow(), preserveSessionId: null);
            EntityDisposition disposition = ComparePrincipalLocked(principalCandidate);
            if (disposition == EntityDisposition.Conflict)
            {
                return FailConflictLocked("principal-version-conflict");
            }

            if (disposition != EntityDisposition.Apply)
            {
                RecordProcessedGenerationLocked(update.Generation);
                return RecordNoChangeLocked(disposition);
            }

            int principalDelta = _principals.ContainsKey(principalCandidate.PrincipalId) ? 0 : 1;
            long byteDelta = principalCandidate.Bytes - (_principals.TryGetValue(principalCandidate.PrincipalId, out PrincipalEntry? current)
                ? current.Bytes
                : 0);
            if (!FitsLocked(sessionDelta: 0, principalDelta, byteDelta))
            {
                return FailCapacityLocked("principal-budget-exceeded");
            }

            _principals[principalCandidate.PrincipalId] = principalCandidate;
            _residentBytes += byteDelta;
            _appliedCount++;
            RecordProcessedGenerationLocked(update.Generation);
            return Result(AdminSessionProjectionApplyStatus.Applied);
        }
    }

    /// <summary>
    /// Applies a session and its matching principal update under one lock. Stale and duplicate
    /// versions do not rewrite state; conflicts or budget breaches withdraw readiness.
    /// </summary>
    public AdminSessionProjectionApplyResult Apply(AdminSessionProjectionSessionUpdate update)
    {
        if (!TryCreateSessionEntry(update, out SessionEntry? session, out PrincipalEntry? principal, out string? error))
        {
            using (EnterGate())
            {
                _invalidUpdateCount++;
                return Result(AdminSessionProjectionApplyStatus.Invalid, error);
            }
        }

        using (EnterGate())
        {
            SessionEntry sessionCandidate = session!;
            PrincipalEntry principalCandidate = principal!;
            PruneTerminalSessionsLocked(_timeProvider.GetUtcNow(), update.SessionId);
            EntityDisposition sessionDisposition = CompareSessionLocked(sessionCandidate);
            EntityDisposition principalDisposition = ComparePrincipalLocked(principalCandidate);
            if (sessionDisposition == EntityDisposition.Conflict || principalDisposition == EntityDisposition.Conflict)
            {
                return FailConflictLocked(sessionDisposition == EntityDisposition.Conflict
                    ? "session-version-conflict"
                    : "principal-version-conflict");
            }

            bool applySession = sessionDisposition == EntityDisposition.Apply;
            bool applyPrincipal = principalDisposition == EntityDisposition.Apply;
            if (!applySession && !applyPrincipal)
            {
                RecordProcessedGenerationLocked(update.Generation);
                return RecordNoChangeLocked(
                    sessionDisposition == EntityDisposition.Stale || principalDisposition == EntityDisposition.Stale
                        ? EntityDisposition.Stale
                        : EntityDisposition.Duplicate);
            }

            int sessionDelta = applySession && !_sessions.ContainsKey(sessionCandidate.SessionId) ? 1 : 0;
            int principalDelta = applyPrincipal && !_principals.ContainsKey(principalCandidate.PrincipalId) ? 1 : 0;
            long byteDelta = 0;
            if (applySession)
            {
                byteDelta += sessionCandidate.Bytes - (_sessions.TryGetValue(sessionCandidate.SessionId, out SessionEntry? currentSession)
                    ? currentSession.Bytes
                    : 0);
            }
            if (applyPrincipal)
            {
                byteDelta += principalCandidate.Bytes - (_principals.TryGetValue(principalCandidate.PrincipalId, out PrincipalEntry? currentPrincipal)
                    ? currentPrincipal.Bytes
                    : 0);
            }

            if (!FitsLocked(sessionDelta, principalDelta, byteDelta))
            {
                return FailCapacityLocked("session-budget-exceeded");
            }

            if (applyPrincipal)
            {
                _principals[principalCandidate.PrincipalId] = principalCandidate;
            }
            if (applySession)
            {
                _sessions[sessionCandidate.SessionId] = sessionCandidate;
            }
            _residentBytes += byteDelta;
            _appliedCount++;
            RecordProcessedGenerationLocked(update.Generation);
            return Result(AdminSessionProjectionApplyStatus.Applied);
        }
    }

    /// <summary>
    /// Validates a ready local session against principal state, revocation, expiry, and a
    /// fixed-size token hash without consulting Redis or the database. Expired entries are pruned.
    /// </summary>
    public AdminSessionProjectionValidationResult Validate(
        string sessionId,
        long principalId,
        ReadOnlySpan<byte> accessTokenHash)
    {
        using (EnterGate())
        {
            _validationCount++;
            if (!_ready)
            {
                return AdminSessionProjectionValidationResult.Invalid(AdminSessionProjectionReasons.NotReady);
            }

            if (string.IsNullOrWhiteSpace(sessionId)
                || !_sessions.TryGetValue(sessionId, out SessionEntry? session))
            {
                return AdminSessionProjectionValidationResult.Invalid(AdminSessionProjectionReasons.UnknownSession);
            }

            _projectionReadCount++;
            RuntimeCacheEvidenceObservation.Current?.RecordCacheEvent(
                "security-admin-session-projection",
                sessionId,
                "hit");
            if (session.PrincipalId != principalId)
            {
                return InvalidLocal(AdminSessionProjectionReasons.PrincipalMismatch, session, principalVersion: 0);
            }

            if (!_principals.TryGetValue(session.PrincipalId, out PrincipalEntry? principal))
            {
                return InvalidLocal(AdminSessionProjectionReasons.UnknownPrincipal, session, principalVersion: 0);
            }

            if (principal.Status != AdminSessionProjectionPrincipalStatus.Active)
            {
                return InvalidLocal(AdminSessionProjectionReasons.PrincipalInactive, session, principal.Version);
            }

            if (session.RevokedAtUtc.HasValue)
            {
                return InvalidLocal(AdminSessionProjectionReasons.Revoked, session, principal.Version);
            }

            DateTimeOffset now = _timeProvider.GetUtcNow();
            if (session.IdleExpiresAtUtc <= now)
            {
                RemoveSessionLocked(session.SessionId, session);
                RemovePrincipalIfUnreferencedLocked(session.PrincipalId);
                return InvalidLocal(AdminSessionProjectionReasons.IdleExpired, session, principal.Version);
            }

            if (session.AbsoluteExpiresAtUtc <= now)
            {
                RemoveSessionLocked(session.SessionId, session);
                RemovePrincipalIfUnreferencedLocked(session.PrincipalId);
                return InvalidLocal(AdminSessionProjectionReasons.AbsoluteExpired, session, principal.Version);
            }

            Span<byte> normalizedHash = stackalloc byte[Sha256Bytes];
            accessTokenHash[..Math.Min(accessTokenHash.Length, Sha256Bytes)].CopyTo(normalizedHash);
            bool tokenMatches = CryptographicOperations.FixedTimeEquals(session.AccessTokenHash, normalizedHash);
            if (accessTokenHash.Length != Sha256Bytes || !tokenMatches)
            {
                return InvalidLocal(AdminSessionProjectionReasons.TokenMismatch, session, principal.Version);
            }

            return new AdminSessionProjectionValidationResult(
                true,
                AdminSessionProjectionReasons.Valid,
                AdminSessionProjectionSources.LocalProjection,
                session.Version,
                principal.Version,
                Math.Max(session.Generation, principal.Generation))
            {
                IdleExpiresAtUtc = session.IdleExpiresAtUtc,
                AbsoluteExpiresAtUtc = session.AbsoluteExpiresAtUtc
            };
        }
    }

    /// <summary>
    /// Removes revoked or expired sessions and principals left without any session reference.
    /// Returns the number of removed sessions.
    /// </summary>
    public int PruneExpiredAndRevoked()
    {
        using (EnterGate())
        {
            return PruneTerminalSessionsLocked(_timeProvider.GetUtcNow(), preserveSessionId: null);
        }
    }

    /// <summary>
    /// Returns one lock-consistent view of readiness, residency, limits, and local counters
    /// without reading an external authority.
    /// </summary>
    public AdminSessionProjectionSnapshot Snapshot()
    {
        using (EnterGate())
        {
            return new AdminSessionProjectionSnapshot(
                _ready,
                _notReadyReason,
                _readyGeneration,
                _lastProcessedGeneration,
                _sessions.Count,
                _principals.Count,
                _residentBytes,
                _limits.MaxSessionEntries,
                _limits.MaxPrincipalEntries,
                _limits.MaxResidentBytes,
                _validationCount,
                _projectionReadCount,
                AuthorityReadCount: 0,
                _appliedCount,
                _duplicateCount,
                _staleCount,
                _invalidUpdateCount,
                _capacityRejectedCount,
                _conflictCount,
                _prunedSessionCount);
        }
    }

    private AdminSessionProjectionValidationResult InvalidLocal(
        string reason,
        SessionEntry session,
        long principalVersion)
        => AdminSessionProjectionValidationResult.Invalid(
            reason,
            AdminSessionProjectionSources.LocalProjection,
            session.Version,
            principalVersion,
            session.Generation);

    private EntityDisposition CompareSessionLocked(SessionEntry candidate)
    {
        if (!_sessions.TryGetValue(candidate.SessionId, out SessionEntry? current))
        {
            return EntityDisposition.Apply;
        }

        if (candidate.Version < current.Version)
        {
            return EntityDisposition.Stale;
        }

        if (candidate.Version > current.Version)
        {
            return EntityDisposition.Apply;
        }

        return SessionContentEquals(candidate, current)
            ? EntityDisposition.Duplicate
            : EntityDisposition.Conflict;
    }

    private EntityDisposition ComparePrincipalLocked(PrincipalEntry candidate)
    {
        if (!_principals.TryGetValue(candidate.PrincipalId, out PrincipalEntry? current))
        {
            return EntityDisposition.Apply;
        }

        if (candidate.Version < current.Version)
        {
            return EntityDisposition.Stale;
        }

        if (candidate.Version > current.Version)
        {
            return EntityDisposition.Apply;
        }

        return candidate.Status == current.Status
            ? EntityDisposition.Duplicate
            : EntityDisposition.Conflict;
    }

    private bool FitsLocked(int sessionDelta, int principalDelta, long byteDelta)
        => _sessions.Count + sessionDelta <= _limits.MaxSessionEntries
            && _principals.Count + principalDelta <= _limits.MaxPrincipalEntries
            && _residentBytes + byteDelta <= _limits.MaxResidentBytes;

    private AdminSessionProjectionApplyResult RecordNoChangeLocked(EntityDisposition disposition)
    {
        if (disposition == EntityDisposition.Stale)
        {
            _staleCount++;
            return Result(AdminSessionProjectionApplyStatus.Stale);
        }

        _duplicateCount++;
        return Result(AdminSessionProjectionApplyStatus.Duplicate);
    }

    private AdminSessionProjectionApplyResult FailCapacityLocked(string detail)
    {
        _capacityRejectedCount++;
        _ready = false;
        _notReadyReason = detail;
        return Result(AdminSessionProjectionApplyStatus.CapacityExceeded, detail);
    }

    private AdminSessionProjectionApplyResult FailConflictLocked(string detail)
    {
        _conflictCount++;
        _ready = false;
        _notReadyReason = detail;
        return Result(AdminSessionProjectionApplyStatus.Conflict, detail);
    }

    private AdminSessionProjectionApplyResult Result(AdminSessionProjectionApplyStatus status, string? detail = null)
        => new(status, _lastProcessedGeneration, detail);

    private void RecordProcessedGenerationLocked(long generation)
        => _lastProcessedGeneration = Math.Max(_lastProcessedGeneration, generation);

    private int PruneTerminalSessionsLocked(DateTimeOffset now, string? preserveSessionId)
    {
        List<SessionEntry>? victims = null;
        foreach (SessionEntry entry in _sessions.Values)
        {
            if (!string.Equals(entry.SessionId, preserveSessionId, StringComparison.Ordinal)
                && (entry.RevokedAtUtc.HasValue
                    || entry.IdleExpiresAtUtc <= now
                    || entry.AbsoluteExpiresAtUtc <= now))
            {
                (victims ??= []).Add(entry);
            }
        }

        if (victims is null)
        {
            return 0;
        }

        foreach (SessionEntry victim in victims)
        {
            RemoveSessionLocked(victim.SessionId, victim);
        }

        foreach (long principalId in victims.Select(static item => item.PrincipalId).Distinct())
        {
            RemovePrincipalIfUnreferencedLocked(principalId);
        }

        _prunedSessionCount += victims.Count;
        return victims.Count;
    }

    private void RemoveSessionLocked(string sessionId, SessionEntry session)
    {
        if (_sessions.Remove(sessionId))
        {
            _residentBytes = Math.Max(0, _residentBytes - session.Bytes);
        }
    }

    private void RemovePrincipalIfUnreferencedLocked(long principalId)
    {
        if (_sessions.Values.Any(session => session.PrincipalId == principalId))
        {
            return;
        }

        if (_principals.Remove(principalId, out PrincipalEntry? principal))
        {
            _residentBytes = Math.Max(0, _residentBytes - principal.Bytes);
        }
    }

    private static bool TryCreateSessionEntry(
        AdminSessionProjectionSessionUpdate update,
        out SessionEntry? session,
        out PrincipalEntry? principal,
        out string? error)
    {
        session = null;
        principal = null;
        if (string.IsNullOrWhiteSpace(update.SessionId) || update.SessionId.Length > MaxSessionIdLength)
        {
            error = "session-id-invalid";
            return false;
        }
        if (update.PrincipalId <= 0 || update.Principal.PrincipalId != update.PrincipalId)
        {
            error = "principal-id-invalid";
            return false;
        }
        if (update.AccessTokenHash.Length != Sha256Bytes)
        {
            error = "token-hash-length-invalid";
            return false;
        }
        if (!IsUtc(update.IdleExpiresAtUtc)
            || !IsUtc(update.AbsoluteExpiresAtUtc)
            || update.IdleExpiresAtUtc == default
            || update.AbsoluteExpiresAtUtc == default
            || (update.RevokedAtUtc.HasValue && !IsUtc(update.RevokedAtUtc.Value)))
        {
            error = "session-time-invalid";
            return false;
        }
        if (update.Version <= 0 || update.Generation <= 0 || update.Version > update.Generation)
        {
            error = "session-version-invalid";
            return false;
        }
        if (!TryCreatePrincipalEntry(update.Principal, out principal, out error)
            || update.Principal.Generation > update.Generation)
        {
            error ??= "principal-generation-invalid";
            return false;
        }

        byte[] tokenHash = update.AccessTokenHash.ToArray();
        session = new SessionEntry(
            update.SessionId,
            update.PrincipalId,
            tokenHash,
            update.RevokedAtUtc,
            update.IdleExpiresAtUtc,
            update.AbsoluteExpiresAtUtc,
            update.Version,
            update.Generation,
            EstimateSessionBytes(update.SessionId));
        return true;
    }

    private static bool TryCreatePrincipalEntry(
        AdminSessionProjectionPrincipalUpdate update,
        out PrincipalEntry? principal,
        out string? error)
    {
        principal = null;
        if (update.PrincipalId <= 0
            || !Enum.IsDefined(update.Status)
            || update.Version <= 0
            || update.Generation <= 0
            || update.Version > update.Generation)
        {
            error = "principal-update-invalid";
            return false;
        }

        principal = new PrincipalEntry(
            update.PrincipalId,
            update.Status,
            update.Version,
            update.Generation,
            PrincipalFixedBytes);
        error = null;
        return true;
    }

    private static bool SessionContentEquals(SessionEntry left, SessionEntry right)
        => left.PrincipalId == right.PrincipalId
            && left.RevokedAtUtc == right.RevokedAtUtc
            && left.IdleExpiresAtUtc == right.IdleExpiresAtUtc
            && left.AbsoluteExpiresAtUtc == right.AbsoluteExpiresAtUtc
            && CryptographicOperations.FixedTimeEquals(left.AccessTokenHash, right.AccessTokenHash);

    private static bool IsUtc(DateTimeOffset value) => value.Offset == TimeSpan.Zero;

    private static int EstimateSessionBytes(string sessionId)
        => checked(SessionFixedBytes + (sessionId.Length * sizeof(char)) + Sha256Bytes);

    private enum EntityDisposition : byte
    {
        Apply = 0,
        Duplicate = 1,
        Stale = 2,
        Conflict = 3
    }

    private sealed record SessionEntry(
        string SessionId,
        long PrincipalId,
        byte[] AccessTokenHash,
        DateTimeOffset? RevokedAtUtc,
        DateTimeOffset IdleExpiresAtUtc,
        DateTimeOffset AbsoluteExpiresAtUtc,
        long Version,
        long Generation,
        int Bytes);

    private sealed record PrincipalEntry(
        long PrincipalId,
        AdminSessionProjectionPrincipalStatus Status,
        long Version,
        long Generation,
        int Bytes);
}
