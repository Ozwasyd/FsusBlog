using System.Data.Common;
using System.Globalization;
using System.Security.Claims;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using SqlSugar;
using StackExchange.Redis;

namespace FsusBlog.Server.Services.Security;

public interface IUserSessionValidationService
{
    Task<UserSessionValidationResult> ValidateAsync(ClaimsPrincipal? principal, CancellationToken cancellationToken);
}

public sealed record UserSessionValidationResult(bool IsValid, string Reason)
{
    public static readonly UserSessionValidationResult Valid = new(true, "ok");

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
    string IdentityKind);

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
    IUnifiedCache cache,
    IConnectionMultiplexer redis,
    IConfiguration configuration) : IUserSessionValidationCache
{
    internal const string DistributedCacheEnabledKey = "Security:UserSessionValidation:DistributedCacheEnabled";
    private const string PayloadVersion = "v1";
    private static readonly TimeSpan SnapshotTtl = TimeSpan.FromMinutes(2);
    private readonly IDatabase database = redis.GetDatabase();

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

        string key = cache.BuildKey(CachePolicyId.SecurityUserSessionValidation, identity);
        RedisValue value = await database.StringGetAsync(key).ConfigureAwait(false);
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

        return cache.TrySetVersionedStringAsync(
            CachePolicyId.SecurityUserSessionValidation,
            identity,
            Encode(state),
            state.RowVersion,
            allowOverwrite,
            SnapshotTtl,
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

        return cache.RemoveManyAsync(keys, cancellationToken);
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
            state.IdentityKind);

    internal static UserSessionValidationCacheState? Decode(string payload, string expectedSessionId)
    {
        string[] fields = payload.Split('|');
        if (fields.Length != 9 ||
            !string.Equals(fields[0], PayloadVersion, StringComparison.Ordinal) ||
            string.IsNullOrWhiteSpace(fields[1]) ||
            !int.TryParse(fields[2], NumberStyles.None, CultureInfo.InvariantCulture, out int accountId) ||
            accountId <= 0 ||
            !TryParseNullableUtc(fields[3], out DateTime? revokedAtUtc) ||
            !TryParseRequiredUtc(fields[4], out DateTime idleExpiresAtUtc) ||
            !TryParseRequiredUtc(fields[5], out DateTime absoluteExpiresAtUtc) ||
            !int.TryParse(fields[6], NumberStyles.Integer, CultureInfo.InvariantCulture, out int accountStatus) ||
            !TryParseNullableUtc(fields[7], out DateTime? accountDeletedAtUtc) ||
            string.IsNullOrWhiteSpace(fields[8]))
        {
            return null;
        }

        return new UserSessionValidationCacheState(
            expectedSessionId,
            accountId,
            revokedAtUtc,
            idleExpiresAtUtc,
            absoluteExpiresAtUtc,
            fields[1],
            accountStatus,
            accountDeletedAtUtc,
            fields[8]);
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
    IUserSessionValidationCache cache) : IUserSessionValidationService
{
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
        try
        {
            state = await cache.ReadAsync(sessionId, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is RedisException or InvalidDataException or ArgumentException)
        {
            return UserSessionValidationResult.Invalid("user_session_cache_unavailable");
        }

        if (state is not null)
        {
            return ValidateState(state, accountId, DateTime.UtcNow);
        }

        state = await LoadStateAsync(sessionId, cancellationToken).ConfigureAwait(false);
        if (state is null)
        {
            return UserSessionValidationResult.Invalid("user_session_not_found");
        }

        try
        {
            bool published = await cache.PublishAsync(
                state,
                allowOverwrite: false,
                cancellationToken: cancellationToken).ConfigureAwait(false);
            if (!published)
            {
                UserSessionValidationCacheState? current = await cache.ReadAsync(sessionId, cancellationToken).ConfigureAwait(false);
                return current is null
                    ? UserSessionValidationResult.Invalid("user_session_cache_conflict")
                    : ValidateState(current, accountId, DateTime.UtcNow);
            }
        }
        catch (Exception exception) when (exception is RedisException or InvalidDataException or InvalidOperationException or ArgumentException)
        {
            return UserSessionValidationResult.Invalid("user_session_cache_unavailable");
        }

        return ValidateState(state, accountId, DateTime.UtcNow);
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
                   u.identity_kind
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
            reader.GetString(0),
            reader.GetInt32(1),
            reader.IsDBNull(2) ? null : AsUtc(reader.GetDateTime(2)),
            AsUtc(reader.GetDateTime(3)),
            AsUtc(reader.GetDateTime(4)),
            reader.GetString(5),
            reader.GetInt32(6),
            reader.IsDBNull(7) ? null : AsUtc(reader.GetDateTime(7)),
            reader.IsDBNull(8) ? string.Empty : reader.GetString(8));
    }

    private static UserSessionValidationResult ValidateState(
        UserSessionValidationCacheState state,
        int accountId,
        DateTime now)
    {
        if (state.AccountId != accountId)
        {
            return UserSessionValidationResult.Invalid("user_session_account_mismatch");
        }

        if (state.RevokedAtUtc.HasValue)
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

        return UserSessionValidationResult.Valid;
    }

    private static DateTime AsUtc(DateTime value)
        => value.Kind switch
        {
            DateTimeKind.Utc => value,
            DateTimeKind.Local => value.ToUniversalTime(),
            _ => DateTime.SpecifyKind(value, DateTimeKind.Utc)
        };
}
