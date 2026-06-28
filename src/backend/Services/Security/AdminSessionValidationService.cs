using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Data.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
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

public sealed class AdminSessionValidationService(ISqlSugarClient db) : IAdminSessionValidationService
{
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

        AdminSessionValidationState? session = await LoadAdminSessionValidationStateAsync(sessionId, cancellationToken);
        if (session is null)
        {
            return AdminSessionValidationResult.Invalid("admin_session_not_found");
        }

        if (session.AdminPrincipalId != adminId)
        {
            return AdminSessionValidationResult.Invalid("admin_session_principal_mismatch");
        }

        AdminPrincipal? adminPrincipal = await db.Queryable<AdminPrincipal>().InSingleAsync(adminId);
        if (adminPrincipal is null || !string.Equals(adminPrincipal.Status, AdminPrincipalStatus.Active, StringComparison.Ordinal))
        {
            return AdminSessionValidationResult.Invalid("admin_principal_inactive");
        }

        DateTime now = DateTime.UtcNow;
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

        string currentTokenHash = HashAccessTokenForStorage(accessToken);
        if (!FixedTimeHexEquals(session.AccessTokenHash, currentTokenHash))
        {
            return AdminSessionValidationResult.Invalid("admin_session_token_mismatch");
        }

        if (await TryTouchAdminSessionAsync(session, now, cancellationToken))
        {
            return AdminSessionValidationResult.Valid;
        }

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
                   adminprincipalid,
                   accesstokenhash,
                   revokedatutc,
                   idleexpiresatutc,
                   absoluteexpiresatutc,
                   xmin::text AS row_version
            FROM admin_session
            WHERE sessionid = @SessionId;
            """,
            new SugarParameter("@SessionId", sessionId));

        if (!await reader.ReadAsync(cancellationToken))
        {
            return null;
        }

        return new AdminSessionValidationState(
            reader.GetString(0),
            reader.GetInt64(1),
            reader.GetString(2),
            reader.IsDBNull(3) ? null : AsUtc(reader.GetDateTime(3)),
            AsUtc(reader.GetDateTime(4)),
            AsUtc(reader.GetDateTime(5)),
            reader.GetString(6));
    }

    private async Task<bool> TryTouchAdminSessionAsync(
        AdminSessionValidationState session,
        DateTime now,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
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

    private sealed record AdminSessionValidationState(
        string SessionId,
        long AdminPrincipalId,
        string AccessTokenHash,
        DateTime? RevokedAtUtc,
        DateTime IdleExpiresAtUtc,
        DateTime AbsoluteExpiresAtUtc,
        string RowVersion);

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
