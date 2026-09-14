using System.Data.Common;
using System.Diagnostics;
using System.Globalization;
using System.Security.Claims;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Observability;

using SqlSugar;

using StackExchange.Redis;

namespace FsusBlog.Server.Services.Security;

public interface IUserSessionValidationService
{
    Task<UserSessionValidationResult> ValidateAsync(ClaimsPrincipal? principal, CancellationToken cancellationToken);
}

public sealed record UserSessionValidationResult(bool IsValid, string Reason, UserSessionMode? SessionMode = null)
{
    public static readonly UserSessionValidationResult Valid = new(true, "ok", UserSessionMode.Normal);

    public static UserSessionValidationResult Allowed(UserSessionMode mode) => new(true, "ok", mode);

    public static UserSessionValidationResult Invalid(string reason) => new(false, reason);
}

public sealed record UserSessionValidationCacheState(
    string SessionId,
    int AccountId,
    DateTime? RevokedAtUtc,
    DateTime IdleExpiresAtUtc,
    DateTime AbsoluteExpiresAtUtc,
    string RowVersion,
    int AccountStatus,
    DateTime? AccountDeletedAtUtc,
    string IdentityKind,
    string AuthenticationMethod = "",
    string AuthenticationStrength = "",
    DateTime? AuthenticatedAtUtc = null,
    UserSessionMode SessionMode = UserSessionMode.Normal,
    string AccountRowVersion = "");

public interface IUserSessionDbFallbackGate
{
    ValueTask<IUserSessionDbFallbackLease?> TryEnterAsync(CancellationToken cancellationToken);
}

public interface IUserSessionDbFallbackLease : IDisposable
{
    void RecordSuccess();
    void RecordFailure();
}

public sealed class UserSessionDbFallbackGate : IUserSessionDbFallbackGate
{
    internal const string SectionName = "Security:UserSessionValidation:DbFallback";
    private readonly SemaphoreSlim _concurrency;
    private readonly int _failureThreshold;
    private readonly TimeSpan _breakDuration;
    private int _consecutiveFailures;
    private long _openUntilTimestamp;

    public UserSessionDbFallbackGate(IConfiguration configuration)
    {
        int maxConcurrent = Math.Clamp(configuration.GetValue<int?>($"{SectionName}:MaxConcurrent") ?? 32, 1, 512);
        _failureThreshold = Math.Clamp(configuration.GetValue<int?>($"{SectionName}:FailureThreshold") ?? 5, 1, 100);
        _breakDuration = TimeSpan.FromSeconds(Math.Clamp(
            configuration.GetValue<int?>($"{SectionName}:BreakSeconds") ?? 5,
            1,
            60));
        _concurrency = new SemaphoreSlim(maxConcurrent, maxConcurrent);
    }

    public ValueTask<IUserSessionDbFallbackLease?> TryEnterAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (Stopwatch.GetTimestamp() < Volatile.Read(ref _openUntilTimestamp) || !_concurrency.Wait(0))
        {
            FsusObservability.RecordUserSessionDbFallbackRejected();
            return ValueTask.FromResult<IUserSessionDbFallbackLease?>(null);
        }

        FsusObservability.RecordUserSessionDbFallbackConcurrency(1);
        return ValueTask.FromResult<IUserSessionDbFallbackLease?>(new Lease(this));
    }

    private void Success() => Interlocked.Exchange(ref _consecutiveFailures, 0);

    private void Failure()
    {
        if (Interlocked.Increment(ref _consecutiveFailures) >= _failureThreshold)
        {
            long until = Stopwatch.GetTimestamp() + (long)(_breakDuration.TotalSeconds * Stopwatch.Frequency);
            Interlocked.Exchange(ref _openUntilTimestamp, until);
            Interlocked.Exchange(ref _consecutiveFailures, 0);
        }
    }

    private void Exit()
    {
        FsusObservability.RecordUserSessionDbFallbackConcurrency(-1);
        _concurrency.Release();
    }

    private sealed class Lease(UserSessionDbFallbackGate owner) : IUserSessionDbFallbackLease
    {
        private int _disposed;
        public void RecordSuccess() => owner.Success();
        public void RecordFailure() => owner.Failure();
        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0)
            {
                owner.Exit();
            }
        }
    }
}

public interface IUserSessionValidationCache
{
    Task<UserSessionValidationCacheState?> ReadAsync(string sessionId, CancellationToken cancellationToken = default);

    Task<bool> PublishAsync(
        UserSessionValidationCacheState state,
        bool allowOverwrite,
        CancellationToken cancellationToken = default);

    Task PublishManyAsync(
        IReadOnlyList<UserSessionValidationCacheState> states,
        bool allowOverwrite,
        CancellationToken cancellationToken = default);

    Task InvalidateManyAsync(
        IReadOnlyList<UserSessionValidationCacheState> states,
        CancellationToken cancellationToken = default);
}

public sealed class UserSessionValidationCache(
    ICacheKeyResolver keyResolver,
    ICacheCompareExchangeStore compareExchange,
    ICacheInvalidationStore invalidation,
    IRedisOperationExecutor redis,
    IConfiguration configuration) : IUserSessionValidationCache
{
    internal const string DistributedCacheEnabledKey = "Security:UserSessionValidation:DistributedCacheEnabled";
    private const string PayloadVersion = "v3";
    private static readonly TimeSpan s_snapshotTtl = TimeSpan.FromMinutes(2);
    public async Task<UserSessionValidationCacheState?> ReadAsync(
        string sessionId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string identity = NormalizeSessionIdentity(sessionId);
        if (!IsDistributedCacheEnabled())
        {
            return null;
        }

        string key = keyResolver.BuildKey(CachePolicyId.SecurityUserSessionValidation, identity);
        RedisValue value = await redis.ExecuteAsync(
                RedisOperationPort.UserSessionValidation,
                (multiplexer, _) => multiplexer.GetDatabase().StringGetAsync(key),
                cancellationToken)
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (!value.HasValue)
        {
            return null;
        }

        return Decode(value.ToString(), identity)
            ?? throw new InvalidDataException("user session validation cache payload is invalid");
    }

    public Task<bool> PublishAsync(
        UserSessionValidationCacheState state,
        bool allowOverwrite,
        CancellationToken cancellationToken = default)
    {
        string identity = NormalizeSessionIdentity(state.SessionId);
        cancellationToken.ThrowIfCancellationRequested();
        if (!IsDistributedCacheEnabled())
        {
            // Emergency DB-only mode deliberately skips Redis. The validator still performs
            // the exact primary-key PostgreSQL read and therefore never weakens revocation.
            return Task.FromResult(true);
        }

        return compareExchange.TrySetVersionedStringAsync(
            CachePolicyId.SecurityUserSessionValidation,
            identity,
            Encode(state),
            state.RowVersion,
            allowOverwrite,
            s_snapshotTtl,
            cancellationToken);
    }

    public async Task PublishManyAsync(
        IReadOnlyList<UserSessionValidationCacheState> states,
        bool allowOverwrite,
        CancellationToken cancellationToken = default)
    {
        if (states.Count == 0)
        {
            return;
        }

        Task<bool>[] writes = new Task<bool>[states.Count];
        for (int i = 0; i < states.Count; i++)
        {
            writes[i] = PublishAsync(states[i], allowOverwrite, cancellationToken);
        }

        bool[] results = await Task.WhenAll(writes).ConfigureAwait(false);
        if (results.Any(static published => !published))
        {
            throw new InvalidOperationException("user session validation cache rejected a revocation snapshot");
        }
    }

    public Task InvalidateManyAsync(
        IReadOnlyList<UserSessionValidationCacheState> states,
        CancellationToken cancellationToken = default)
    {
        if (states.Count == 0)
        {
            return Task.CompletedTask;
        }

        var sessionIds = new HashSet<string>(StringComparer.Ordinal);
        var keys = new List<CacheKeyIdentity>(states.Count);
        foreach (UserSessionValidationCacheState state in states)
        {
            cancellationToken.ThrowIfCancellationRequested();
            string sessionId = NormalizeSessionIdentity(state.SessionId);
            if (sessionIds.Add(sessionId))
            {
                keys.Add(new CacheKeyIdentity(CachePolicyId.SecurityUserSessionValidation, sessionId));
            }
        }

        return invalidation.RemoveManyAsync(keys, cancellationToken);
    }

    internal static string Encode(UserSessionValidationCacheState state)
        => string.Join('|',
            PayloadVersion,
            state.RowVersion,
            state.AccountId.ToString(CultureInfo.InvariantCulture),
            ToTicks(state.RevokedAtUtc),
            ToTicks(state.IdleExpiresAtUtc),
            ToTicks(state.AbsoluteExpiresAtUtc),
            state.AccountStatus.ToString(CultureInfo.InvariantCulture),
            ToTicks(state.AccountDeletedAtUtc),
            state.IdentityKind,
            state.AuthenticationMethod,
            state.AuthenticationStrength,
            ToTicks(state.AuthenticatedAtUtc),
            ((int)state.SessionMode).ToString(CultureInfo.InvariantCulture),
            string.IsNullOrWhiteSpace(state.AccountRowVersion) ? state.RowVersion : state.AccountRowVersion);

    internal static UserSessionValidationCacheState? Decode(string payload, string expectedSessionId)
    {
        string[] fields = payload.Split('|');
        bool legacyV2 = fields.Length == 12 && string.Equals(fields[0], "v2", StringComparison.Ordinal);
        if ((!legacyV2 && fields.Length != 14) ||
            (!legacyV2 && !string.Equals(fields[0], PayloadVersion, StringComparison.Ordinal)) ||
            string.IsNullOrWhiteSpace(fields[1]) ||
            !int.TryParse(fields[2], NumberStyles.None, CultureInfo.InvariantCulture, out int accountId) ||
            accountId <= 0 ||
            !TryParseNullableUtc(fields[3], out DateTime? revokedAtUtc) ||
            !TryParseRequiredUtc(fields[4], out DateTime idleExpiresAtUtc) ||
            !TryParseRequiredUtc(fields[5], out DateTime absoluteExpiresAtUtc) ||
            !int.TryParse(fields[6], NumberStyles.Integer, CultureInfo.InvariantCulture, out int accountStatus) ||
            !TryParseNullableUtc(fields[7], out DateTime? accountDeletedAtUtc) ||
            string.IsNullOrWhiteSpace(fields[8]) ||
            !TryParseNullableUtc(fields[11], out DateTime? authenticatedAtUtc) ||
            (!legacyV2 && (!int.TryParse(fields[12], NumberStyles.Integer, CultureInfo.InvariantCulture, out int sessionModeValue)
                || !Enum.IsDefined((UserSessionMode)sessionModeValue)
                || string.IsNullOrWhiteSpace(fields[13]))))
        {
            return null;
        }

        bool validAuthenticationContext = UserSessionAuthenticationMethods.IsValid(fields[9])
            && UserSessionAuthenticationStrengths.IsValid(fields[10])
            && authenticatedAtUtc.HasValue;
        if (!revokedAtUtc.HasValue && !validAuthenticationContext)
        {
            return null;
        }

        UserSessionMode sessionMode = legacyV2
            ? revokedAtUtc.HasValue
                ? UserSessionMode.Revoked
                : accountStatus == 1 ? UserSessionMode.Restricted : UserSessionMode.Normal
            : (UserSessionMode)int.Parse(fields[12], CultureInfo.InvariantCulture);
        return new UserSessionValidationCacheState(
            expectedSessionId,
            accountId,
            revokedAtUtc,
            idleExpiresAtUtc,
            absoluteExpiresAtUtc,
            fields[1],
            accountStatus,
            accountDeletedAtUtc,
            fields[8],
            fields[9],
            fields[10],
            authenticatedAtUtc,
            sessionMode,
            legacyV2 ? string.Empty : fields[13]);
    }

    private static string NormalizeSessionIdentity(string sessionId)
    {
        string normalized = sessionId?.Trim() ?? string.Empty;
        if (normalized.Length == 0 || normalized.Length > 128 || normalized.Contains('|'))
        {
            throw new ArgumentException("Session id is invalid.", nameof(sessionId));
        }

        return normalized;
    }

    private bool IsDistributedCacheEnabled()
        => configuration.GetValue<bool?>(DistributedCacheEnabledKey) ?? true;

    private static string ToTicks(DateTime? value)
        => value.HasValue
            ? AsUtc(value.Value).Ticks.ToString(CultureInfo.InvariantCulture)
            : "-1";

    private static bool TryParseRequiredUtc(string value, out DateTime result)
    {
        result = default;
        return long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out long ticks) &&
            ticks > 0 &&
            TryCreateUtc(ticks, out result);
    }

    private static bool TryParseNullableUtc(string value, out DateTime? result)
    {
        result = null;
        if (string.Equals(value, "-1", StringComparison.Ordinal))
        {
            return true;
        }

        if (!long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out long ticks) ||
            ticks <= 0 ||
            !TryCreateUtc(ticks, out DateTime parsed))
        {
            return false;
        }

        result = parsed;
        return true;
    }

    private static bool TryCreateUtc(long ticks, out DateTime result)
    {
        try
        {
            result = new DateTime(ticks, DateTimeKind.Utc);
            return true;
        }
        catch (ArgumentOutOfRangeException)
        {
            result = default;
            return false;
        }
    }

    private static DateTime AsUtc(DateTime value)
        => value.Kind switch
        {
            DateTimeKind.Utc => value,
            DateTimeKind.Local => value.ToUniversalTime(),
            _ => DateTime.SpecifyKind(value, DateTimeKind.Utc)
        };
}

public sealed class UserSessionValidationService(
    ISqlSugarClient db,
    IUserSessionValidationCache cache,
    ILogger<UserSessionValidationService>? logger = null,
    IUserSessionDbFallbackGate? fallbackGate = null,
    TimeProvider? timeProvider = null) : IUserSessionValidationService
{
    private readonly IUserSessionDbFallbackGate _fallbackGate =
        fallbackGate ?? new UserSessionDbFallbackGate(new ConfigurationBuilder().Build());
    private readonly TimeProvider _timeProvider = timeProvider ?? TimeProvider.System;
    private const int BannedAccountStatus = 1;
    private const int DeletedAccountStatus = 2;

    public async Task<UserSessionValidationResult> ValidateAsync(
        ClaimsPrincipal? principal,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (principal?.Identity?.IsAuthenticated != true || principal.IsAdminPrincipal())
        {
            return UserSessionValidationResult.Invalid("anonymous_account_principal_required");
        }

        if (!string.Equals(
                principal.FindFirst("identity_kind")?.Value,
                AnonymousIdentityRuntime.AnonymousAccountKind,
                StringComparison.Ordinal))
        {
            return UserSessionValidationResult.Invalid("anonymous_account_identity_kind_required");
        }

        int accountId = principal.GetUserId();
        if (accountId <= 0)
        {
            return UserSessionValidationResult.Invalid("account_id_missing");
        }

        string? sessionId = principal.GetSessionId();
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return UserSessionValidationResult.Invalid("user_sid_missing");
        }

        UserSessionValidationCacheState? state;
        bool cacheReadFailed = false;
        try
        {
            state = await cache.ReadAsync(sessionId, cancellationToken).ConfigureAwait(false);
            FsusObservability.RecordUserSessionValidationCache(state is null ? "miss" : "hit");
        }
        catch (Exception exception) when (exception is RedisException or InvalidDataException or ArgumentException)
        {
            cacheReadFailed = true;
            state = null;
            FsusObservability.RecordUserSessionValidationCache("error");
            logger?.LogWarning(exception, "User session cache read failed; falling back to PostgreSQL");
        }

        if (state is not null)
        {
            return ValidateState(state, accountId, principal, _timeProvider.GetUtcNow().UtcDateTime);
        }

        long fallbackStarted = Stopwatch.GetTimestamp();
        IUserSessionDbFallbackLease? fallbackLease = await _fallbackGate
            .TryEnterAsync(cancellationToken).ConfigureAwait(false);
        if (fallbackLease is null)
        {
            return UserSessionValidationResult.Invalid("user_session_fallback_budget_exhausted");
        }

        try
        {
            state = await LoadStateAsync(sessionId, cancellationToken).ConfigureAwait(false);
            fallbackLease.RecordSuccess();
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            fallbackLease.RecordFailure();
            FsusObservability.RecordUserSessionDbFallback("error", cacheReadFailed, Stopwatch.GetElapsedTime(fallbackStarted));
            logger?.LogError(exception, "PostgreSQL user session validation failed closed");
            return UserSessionValidationResult.Invalid("user_session_database_unavailable");
        }
        finally
        {
            fallbackLease.Dispose();
        }

        if (state is null)
        {
            FsusObservability.RecordUserSessionDbFallback("reject", cacheReadFailed, Stopwatch.GetElapsedTime(fallbackStarted));
            return UserSessionValidationResult.Invalid("user_session_not_found");
        }

        UserSessionValidationResult result = ValidateState(
            state,
            accountId,
            principal,
            _timeProvider.GetUtcNow().UtcDateTime);
        try
        {
            bool published = await cache.PublishAsync(
                state,
                allowOverwrite: cacheReadFailed,
                cancellationToken: cancellationToken).ConfigureAwait(false);
            if (!published)
            {
                FsusObservability.RecordUserSessionCacheRepair("conflict");
                FsusObservability.RecordUserSessionDbFallback(
                    "reject",
                    cacheReadFailed,
                    Stopwatch.GetElapsedTime(fallbackStarted));
                if (!result.IsValid)
                {
                    return result;
                }

                try
                {
                    UserSessionValidationCacheState? winner = await cache.ReadAsync(
                        sessionId,
                        cancellationToken).ConfigureAwait(false);
                    return winner is null
                        ? UserSessionValidationResult.Invalid("user_session_cache_conflict")
                        : ValidateState(
                            winner,
                            accountId,
                            principal,
                            _timeProvider.GetUtcNow().UtcDateTime);
                }
                catch (Exception exception) when (exception is RedisException or InvalidDataException or ArgumentException)
                {
                    logger?.LogWarning(exception, "User session cache winner could not be read after repair conflict");
                    return UserSessionValidationResult.Invalid("user_session_cache_conflict");
                }
            }
            else
            {
                FsusObservability.RecordUserSessionCacheRepair(cacheReadFailed ? "repair" : "fill");
            }
        }
        catch (Exception exception) when (exception is RedisException or InvalidDataException or InvalidOperationException or ArgumentException)
        {
            FsusObservability.RecordUserSessionCacheRepair("error");
            logger?.LogWarning(exception, "User session cache repair failed; PostgreSQL result remains authoritative");
        }

        FsusObservability.RecordUserSessionDbFallback(
            result.IsValid ? "success" : "reject",
            cacheReadFailed,
            Stopwatch.GetElapsedTime(fallbackStarted));
        return result;
    }

    private async Task<UserSessionValidationCacheState?> LoadStateAsync(
        string sessionId,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT s.sessionid,
                   s.userid,
                   s.revokedat,
                   s.idleexpiresat,
                   s.absoluteexpiresat,
                   s.xmin::text AS row_version,
                   u.status,
                   u.deleted_at,
                   u.identity_kind,
                   s.session_mode,
                   u.xmin::text AS account_row_version,
                   s.authentication_method,
                   s.authentication_strength,
                   s.authenticated_at_utc
            FROM sys_user_session s
            JOIN sys_user u ON u.id = s.userid
            WHERE s.sessionid = @SessionId;
            """,
            new SugarParameter("@SessionId", sessionId));
        if (!await reader.ReadAsync(cancellationToken))
        {
            return null;
        }

        return new UserSessionValidationCacheState(
            reader.ReadString("sessionid"),
            reader.ReadInt32("userid"),
            reader.IsNull("revokedat") ? null : AsUtc(reader.ReadDateTime("revokedat")),
            AsUtc(reader.ReadDateTime("idleexpiresat")),
            AsUtc(reader.ReadDateTime("absoluteexpiresat")),
            reader.ReadString("row_version"),
            reader.ReadInt32("status"),
            reader.IsNull("deleted_at") ? null : AsUtc(reader.ReadDateTime("deleted_at")),
            reader.IsNull("identity_kind") ? string.Empty : reader.ReadString("identity_kind"),
            reader.IsNull("authentication_method") ? string.Empty : reader.ReadString("authentication_method"),
            reader.IsNull("authentication_strength") ? string.Empty : reader.ReadString("authentication_strength"),
            reader.IsNull("authenticated_at_utc") ? null : AsUtc(reader.ReadDateTime("authenticated_at_utc")),
            reader.IsNull("session_mode")
                ? UserSessionMode.Normal
                : (UserSessionMode)reader.ReadInt32("session_mode"),
            reader.ReadString("account_row_version"));
    }

    private static UserSessionValidationResult ValidateState(
        UserSessionValidationCacheState state,
        int accountId,
        ClaimsPrincipal principal,
        DateTime now)
    {
        if (state.AccountId != accountId)
        {
            return UserSessionValidationResult.Invalid("user_session_account_mismatch");
        }

        if (!Enum.IsDefined(state.SessionMode))
        {
            return UserSessionValidationResult.Invalid("user_session_mode_invalid");
        }

        if (state.RevokedAtUtc.HasValue || state.SessionMode == UserSessionMode.Revoked)
        {
            return UserSessionValidationResult.Invalid("user_session_revoked");
        }

        if (state.IdleExpiresAtUtc <= now)
        {
            return UserSessionValidationResult.Invalid("user_session_idle_expired");
        }

        if (state.AbsoluteExpiresAtUtc <= now)
        {
            return UserSessionValidationResult.Invalid("user_session_absolute_expired");
        }

        if (state.AccountStatus == DeletedAccountStatus || state.AccountDeletedAtUtc.HasValue)
        {
            return UserSessionValidationResult.Invalid("account_deleted");
        }

        if (!string.Equals(state.IdentityKind, AnonymousIdentityRuntime.AnonymousAccountKind, StringComparison.Ordinal))
        {
            return UserSessionValidationResult.Invalid("user_session_identity_kind_mismatch");
        }

        if (!UserSessionAuthenticationMethods.IsValid(state.AuthenticationMethod) ||
            !UserSessionAuthenticationStrengths.IsValid(state.AuthenticationStrength) ||
            !state.AuthenticatedAtUtc.HasValue ||
            !string.Equals(principal.FindFirst("auth_method")?.Value, state.AuthenticationMethod, StringComparison.Ordinal) ||
            !string.Equals(principal.FindFirst("auth_strength")?.Value, state.AuthenticationStrength, StringComparison.Ordinal) ||
            !long.TryParse(
                principal.FindFirst("auth_time")?.Value,
                NumberStyles.Integer,
                CultureInfo.InvariantCulture,
                out long tokenAuthTime) ||
            tokenAuthTime != new DateTimeOffset(AsUtc(state.AuthenticatedAtUtc.Value)).ToUnixTimeSeconds())
        {
            return UserSessionValidationResult.Invalid("user_session_authentication_context_mismatch");
        }

        UserSessionMode databaseMode = state.AccountStatus == BannedAccountStatus || state.SessionMode == UserSessionMode.Restricted
            ? UserSessionMode.Restricted
            : UserSessionMode.Normal;
        string? tokenModeClaim = principal.FindFirst(UserSessionModes.ClaimType)?.Value;
        UserSessionMode tokenMode = UserSessionModes.TryParseClaim(tokenModeClaim, out UserSessionMode parsedTokenMode)
            ? parsedTokenMode
            : UserSessionMode.Normal;
        if (tokenMode == UserSessionMode.Revoked)
        {
            return UserSessionValidationResult.Invalid("user_session_token_revoked");
        }

        // The server always chooses the stricter side. A ban takes effect immediately even for
        // an older normal JWT; an unban cannot silently upgrade an older restricted JWT.
        UserSessionMode effectiveMode = databaseMode == UserSessionMode.Restricted || tokenMode == UserSessionMode.Restricted
            ? UserSessionMode.Restricted
            : UserSessionMode.Normal;
        if (principal.Identity is ClaimsIdentity identity)
        {
            foreach (Claim claim in identity.FindAll(UserSessionModes.ClaimType).ToArray())
            {
                identity.RemoveClaim(claim);
            }
            identity.AddClaim(new Claim(UserSessionModes.ClaimType, UserSessionModes.ToClaimValue(effectiveMode)));
        }

        return UserSessionValidationResult.Allowed(effectiveMode);
    }

    private static DateTime AsUtc(DateTime value)
        => value.Kind switch
        {
            DateTimeKind.Utc => value,
            DateTimeKind.Local => value.ToUniversalTime(),
            _ => DateTime.SpecifyKind(value, DateTimeKind.Utc)
        };
}
