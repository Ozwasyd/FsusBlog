using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
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
            return AdminSessionValidationResult.Valid;
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

        AdminSession? session = await db.Queryable<AdminSession>().InSingleAsync(sessionId);
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

        await db.Updateable<AdminSession>()
            .SetColumns(s => s.LastSeenAtUtc == now)
            .Where(s => s.SessionId == sessionId && s.RevokedAtUtc == null)
            .ExecuteCommandAsync();

        return AdminSessionValidationResult.Valid;
    }

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
