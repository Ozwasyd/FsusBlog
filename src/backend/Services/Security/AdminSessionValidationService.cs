using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Security;

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

public sealed partial class AdminSessionValidationService : IAdminSessionValidationService
{
    private readonly AdminSessionProjection _projection;
    private readonly IAdminSessionTouchScheduler _touchScheduler;

    public AdminSessionValidationService(
        AdminSessionProjection projection,
        IAdminSessionTouchScheduler touchScheduler)
    {
        _projection = projection;
        _touchScheduler = touchScheduler;
    }

    public Task<AdminSessionValidationResult> ValidateAsync(
        ClaimsPrincipal? principal,
        string accessToken,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        if (principal?.IsAdminPrincipal() != true)
        {
            return Task.FromResult(AdminSessionValidationResult.Invalid("admin_principal_required"));
        }

        if (!principal.TryGetAdminPrincipalId(out long adminId))
        {
            return Task.FromResult(AdminSessionValidationResult.Invalid("admin_id_missing"));
        }

        string? sessionId = principal.GetAdminSessionId();
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return Task.FromResult(AdminSessionValidationResult.Invalid("admin_sid_missing"));
        }

        if (string.IsNullOrWhiteSpace(accessToken))
        {
            return Task.FromResult(AdminSessionValidationResult.Invalid("admin_access_token_missing"));
        }

        byte[] tokenHash = SHA256.HashData(Encoding.UTF8.GetBytes(accessToken));
        AdminSessionProjectionValidationResult validation = _projection.Validate(sessionId, adminId, tokenHash);
        AdminSessionProjectionSnapshot snapshot = _projection.Snapshot();
        FsusObservability.RecordAdminSessionProjectionValidation(
            validation.Source,
            validation.IsValid,
            snapshot.SessionEntries + snapshot.PrincipalEntries,
            snapshot.ResidentBytes,
            Math.Max(0, snapshot.ReadyGeneration - snapshot.LastProcessedGeneration));
        if (!validation.IsValid)
        {
            return Task.FromResult(AdminSessionValidationResult.Invalid(validation.Reason));
        }

        _touchScheduler.TrySchedule(new AdminSessionTouchRequest(
            sessionId,
            validation.SessionVersion,
            tokenHash,
            validation.IdleExpiresAtUtc,
            validation.AbsoluteExpiresAtUtc));
        return Task.FromResult(AdminSessionValidationResult.Valid);
    }
}
