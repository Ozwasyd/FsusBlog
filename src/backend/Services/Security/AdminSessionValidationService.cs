using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Data.Common;
using System.Collections.Concurrent;
using System.Diagnostics;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Observability;
using Microsoft.Extensions.Caching.Memory;
using SqlSugar;

namespace FsusBlog.Server.Services.Security;

public interface IAdminSessionValidationService
{
    Task<AdminSessionValidationResult> ValidateAsync(ClaimsPrincipal? principal, string accessToken, CancellationToken cancellationToken);
}

public sealed record AdminSessionValidationResult(bool IsValid, string Reason)
{
    public static readonly AdminSessionValidationResult Valid = new(true, "ok");

    public static AdminSessionValidationResult Invalid(string reason) => new(false, reason);
}

public sealed class AdminSessionValidationService : IAdminSessionValidationService
{
    private static readonly TimeSpan AdminSessionValidationSnapshotTtl = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan AdminSessionTouchMinInterval = TimeSpan.FromSeconds(45);
    private static readonly MemoryCacheEntryOptions ValidationSnapshotOptions = new()
    {
        AbsoluteExpirationRelativeToNow = AdminSessionValidationSnapshotTtl
    };
    private static readonly ConcurrentDictionary<string, DateTime> LastTouchBySession = new(StringComparer.Ordinal);

    private readonly ISqlSugarClient db;
    private readonly IMemoryCache validationCache;

    public AdminSessionValidationService(ISqlSugarClient db, IMemoryCache? validationCache = null)
    {
        this.db = db;
        this.validationCache = validationCache ?? new MemoryCache(new MemoryCacheOptions());
    }

    public async Task<AdminSessionValidationResult> ValidateAsync(ClaimsPrincipal? principal, string accessToken, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        if (principal?.IsAdminPrincipal() != true)
        {
            return AdminSessionValidationResult.Invalid("admin_principal_required");
        }

        if (!principal.TryGetAdminPrincipalId(out long adminId))
        {
            return AdminSessionValidationResult.Invalid("admin_id_missing");
        }

        string? sessionId = principal.GetAdminSessionId();
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return AdminSessionValidationResult.Invalid("admin_sid_missing");
        }

        if (string.IsNullOrWhiteSpace(accessToken))
        {
            return AdminSessionValidationResult.Invalid("admin_access_token_missing");
        }

        DateTime now = DateTime.UtcNow;
        string currentTokenHash = HashAccessTokenForStorage(accessToken);
        string snapshotKey = SnapshotKey(sessionId, currentTokenHash);
        if (TryGetValidationSnapshot(snapshotKey, out AdminSessionValidationSnapshot? snapshot) && snapshot is not null)
        {
            FsusObservability.RecordAdminSessionValidationCacheHit();
            return ValidateSnapshot(snapshot, adminId, currentTokenHash, now);
        }

        AdminSessionValidationState? session = await LoadAdminSessionValidationStateAsync(sessionId, cancellationToken);
        if (session is null)
        {
            return AdminSessionValidationResult.Invalid("admin_session_not_found");
        }

        if (session.AdminPrincipalId != adminId)
        {
            return AdminSessionValidationResult.Invalid("admin_session_principal_mismatch");
        }

        if (!string.Equals(session.PrincipalStatus, AdminPrincipalStatus.Active, StringComparison.Ordinal))
        {
            return AdminSessionValidationResult.Invalid("admin_principal_inactive");
        }

        if (session.RevokedAtUtc.HasValue)
        {
            return AdminSessionValidationResult.Invalid("admin_session_revoked");
        }

        if (session.IdleExpiresAtUtc <= now)
        {
            return AdminSessionValidationResult.Invalid("admin_session_idle_expired");
        }

        if (session.AbsoluteExpiresAtUtc <= now)
        {
            return AdminSessionValidationResult.Invalid("admin_session_absolute_expired");
        }

        if (!FixedTimeHexEquals(session.AccessTokenHash, currentTokenHash))
        {
            return AdminSessionValidationResult.Invalid("admin_session_token_mismatch");
        }

        SetValidationSnapshot(snapshotKey, AdminSessionValidationSnapshot.From(session));
        if (!ShouldTouchAdminSession(session.SessionId, session.AccessTokenHash, now))
        {
            FsusObservability.RecordAdminSessionTouchSkipped();
            return AdminSessionValidationResult.Valid;
        }

        if (await TryTouchAdminSessionAsync(session, now, cancellationToken))
        {
            return AdminSessionValidationResult.Valid;
        }

        validationCache.Remove(snapshotKey);

        return await ValidateCurrentSessionAfterTouchConflictAsync(
            adminId,
            sessionId,
            currentTokenHash,
            now,
            cancellationToken);
    }

    private async Task<AdminSessionValidationState?> LoadAdminSessionValidationStateAsync(
        string sessionId,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT sessionid,
                   s.adminprincipalid,
                   accesstokenhash,
                   revokedatutc,
                   idleexpiresatutc,
                   absoluteexpiresatutc,
                   s.xmin::text AS row_version,
                   ap.status AS principal_status
            FROM admin_session s
            JOIN admin_principal ap ON ap.id = s.adminprincipalid
            WHERE s.sessionid = @SessionId;
            """,
            new SugarParameter("@SessionId", sessionId));
        FsusObservability.RecordAdminSessionValidationDbRead();

        if (!await reader.ReadAsync(cancellationToken))
        {
            return null;
        }

        return new AdminSessionValidationState(
            reader.ReadString("sessionid"),
            reader.ReadInt64("adminprincipalid"),
            reader.ReadString("accesstokenhash"),
            reader.IsNull("revokedatutc") ? null : AsUtc(reader.ReadDateTime("revokedatutc")),
            AsUtc(reader.ReadDateTime("idleexpiresatutc")),
            AsUtc(reader.ReadDateTime("absoluteexpiresatutc")),
            reader.ReadString("row_version"),
            reader.ReadString("principal_status"));
    }

    private async Task<bool> TryTouchAdminSessionAsync(
        AdminSessionValidationState session,
        DateTime now,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        long startedAt = Stopwatch.GetTimestamp();
        int updated = await db.Ado.ExecuteCommandAsync(
            """
            UPDATE admin_session
            SET lastseenatutc = @LastSeenAtUtc
            WHERE sessionid = @SessionId
              AND revokedatutc IS NULL
              AND accesstokenhash = @AccessTokenHash
              AND idleexpiresatutc = @IdleExpiresAtUtc
              AND absoluteexpiresatutc = @AbsoluteExpiresAtUtc
              AND xmin::text = @RowVersion;
            """,
            new SugarParameter("@SessionId", session.SessionId),
            new SugarParameter("@LastSeenAtUtc", now),
            new SugarParameter("@AccessTokenHash", session.AccessTokenHash),
            new SugarParameter("@IdleExpiresAtUtc", session.IdleExpiresAtUtc),
            new SugarParameter("@AbsoluteExpiresAtUtc", session.AbsoluteExpiresAtUtc),
            new SugarParameter("@RowVersion", session.RowVersion));
        FsusObservability.RecordAdminSessionTouch(updated == 1, Stopwatch.GetElapsedTime(startedAt));
        return updated == 1;
    }

    private async Task<AdminSessionValidationResult> ValidateCurrentSessionAfterTouchConflictAsync(
        long adminId,
        string sessionId,
        string currentTokenHash,
        DateTime now,
        CancellationToken cancellationToken)
    {
        AdminSessionValidationState? current = await LoadAdminSessionValidationStateAsync(sessionId, cancellationToken);
        if (current is null)
        {
            return AdminSessionValidationResult.Invalid("admin_session_not_found");
        }

        if (current.AdminPrincipalId != adminId)
        {
            return AdminSessionValidationResult.Invalid("admin_session_principal_mismatch");
        }

        if (!string.Equals(current.PrincipalStatus, AdminPrincipalStatus.Active, StringComparison.Ordinal))
        {
            return AdminSessionValidationResult.Invalid("admin_principal_inactive");
        }

        if (current.RevokedAtUtc.HasValue)
        {
            return AdminSessionValidationResult.Invalid("admin_session_revoked");
        }

        if (current.IdleExpiresAtUtc <= now)
        {
            return AdminSessionValidationResult.Invalid("admin_session_idle_expired");
        }

        if (current.AbsoluteExpiresAtUtc <= now)
        {
            return AdminSessionValidationResult.Invalid("admin_session_absolute_expired");
        }

        if (!FixedTimeHexEquals(current.AccessTokenHash, currentTokenHash))
        {
            return AdminSessionValidationResult.Invalid("admin_session_token_mismatch");
        }

        return AdminSessionValidationResult.Valid;
    }

    private bool TryGetValidationSnapshot(string snapshotKey, out AdminSessionValidationSnapshot? snapshot)
        => validationCache.TryGetValue(snapshotKey, out snapshot);

    private void SetValidationSnapshot(string snapshotKey, AdminSessionValidationSnapshot snapshot)
        => validationCache.Set(snapshotKey, snapshot, ValidationSnapshotOptions);

    private static AdminSessionValidationResult ValidateSnapshot(
        AdminSessionValidationSnapshot snapshot,
        long adminId,
        string currentTokenHash,
        DateTime now)
    {
        if (snapshot.AdminPrincipalId != adminId)
        {
            return AdminSessionValidationResult.Invalid("admin_session_principal_mismatch");
        }

        if (!string.Equals(snapshot.PrincipalStatus, AdminPrincipalStatus.Active, StringComparison.Ordinal))
        {
            return AdminSessionValidationResult.Invalid("admin_principal_inactive");
        }

        if (snapshot.RevokedAtUtc.HasValue)
        {
            return AdminSessionValidationResult.Invalid("admin_session_revoked");
        }

        if (snapshot.IdleExpiresAtUtc <= now)
        {
            return AdminSessionValidationResult.Invalid("admin_session_idle_expired");
        }

        if (snapshot.AbsoluteExpiresAtUtc <= now)
        {
            return AdminSessionValidationResult.Invalid("admin_session_absolute_expired");
        }

        if (!FixedTimeHexEquals(snapshot.AccessTokenHash, currentTokenHash))
        {
            return AdminSessionValidationResult.Invalid("admin_session_token_mismatch");
        }

        return AdminSessionValidationResult.Valid;
    }

    private static bool ShouldTouchAdminSession(string sessionId, string accessTokenHash, DateTime now)
    {
        string touchKey = SnapshotKey(sessionId, accessTokenHash);
        if (LastTouchBySession.TryGetValue(touchKey, out DateTime lastTouchedAt) &&
            now - lastTouchedAt < AdminSessionTouchMinInterval)
        {
            return false;
        }

        LastTouchBySession[touchKey] = now;
        return true;
    }

    private static string SnapshotKey(string sessionId, string accessTokenHash)
        => string.Concat("admin-session-validation:", sessionId, ':', accessTokenHash);

    private sealed record AdminSessionValidationState(
        string SessionId,
        long AdminPrincipalId,
        string AccessTokenHash,
        DateTime? RevokedAtUtc,
        DateTime IdleExpiresAtUtc,
        DateTime AbsoluteExpiresAtUtc,
        string RowVersion,
        string PrincipalStatus);

    private sealed record AdminSessionValidationSnapshot(
        long AdminPrincipalId,
        string AccessTokenHash,
        DateTime? RevokedAtUtc,
        DateTime IdleExpiresAtUtc,
        DateTime AbsoluteExpiresAtUtc,
        string PrincipalStatus)
    {
        public static AdminSessionValidationSnapshot From(AdminSessionValidationState state)
            => new(
                state.AdminPrincipalId,
                state.AccessTokenHash,
                state.RevokedAtUtc,
                state.IdleExpiresAtUtc,
                state.AbsoluteExpiresAtUtc,
                state.PrincipalStatus);
    }

    private static DateTime AsUtc(DateTime value)
        => value.Kind switch
        {
            DateTimeKind.Utc => value,
            DateTimeKind.Local => value.ToUniversalTime(),
            _ => DateTime.SpecifyKind(value, DateTimeKind.Utc)
        };

    private static string HashAccessTokenForStorage(string value)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    private static bool FixedTimeHexEquals(string expectedHex, string actualHex)
    {
        if (expectedHex.Length != actualHex.Length)
        {
            return false;
        }

        try
        {
            byte[] expected = Convert.FromHexString(expectedHex);
            byte[] actual = Convert.FromHexString(actualHex);
            return CryptographicOperations.FixedTimeEquals(expected, actual);
        }
        catch (FormatException)
        {
            return false;
        }
    }
}
