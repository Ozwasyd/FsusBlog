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
    private readonly ClaimsPrincipal? _validatedPrincipal;
    private readonly long _adminPrincipalId;
    private readonly string? _sessionId;
    private readonly AdminSessionProjectionValidationResult? _projectionValidation;

    public static readonly AdminSessionValidationResult Valid = new(true, "ok");

    public static AdminSessionValidationResult Invalid(string reason) => new(false, reason);

    private AdminSessionValidationResult(
        ClaimsPrincipal principal,
        long adminPrincipalId,
        string sessionId,
        AdminSessionProjectionValidationResult validation)
        : this(true, validation.Reason)
    {
        _validatedPrincipal = principal;
        _adminPrincipalId = adminPrincipalId;
        _sessionId = sessionId;
        _projectionValidation = validation;
    }

    // Copies keep the existing boolean/reason value contract, without copying a validated observation.
    private AdminSessionValidationResult(AdminSessionValidationResult original)
    {
        IsValid = original.IsValid;
        Reason = original.Reason;
    }

    public bool Equals(AdminSessionValidationResult? other)
        => other is not null && IsValid == other.IsValid && string.Equals(Reason, other.Reason, StringComparison.Ordinal);

    public override int GetHashCode() => HashCode.Combine(IsValid, Reason);

    internal static AdminSessionValidationResult FromProjection(
        ClaimsPrincipal principal,
        long adminPrincipalId,
        string sessionId,
        AdminSessionProjectionValidationResult validation)
    {
        if (!validation.IsValid)
        {
            throw new ArgumentException("Only a successful projection observation can be retained.", nameof(validation));
        }

        return new AdminSessionValidationResult(principal, adminPrincipalId, sessionId, validation);
    }

    internal bool TryGetProjectionValidation(
        ClaimsPrincipal? principal,
        out AdminSessionProjectionValidationResult validation)
    {
        validation = default;
        if (!IsValid
            || !ReferenceEquals(_validatedPrincipal, principal)
            || principal?.IsAdminPrincipal() != true
            || !principal.TryGetAdminPrincipalId(out long adminPrincipalId)
            || adminPrincipalId != _adminPrincipalId
            || !string.Equals(principal.GetAdminSessionId(), _sessionId, StringComparison.Ordinal)
            || _projectionValidation is not { IsValid: true } observed
            || !string.Equals(Reason, observed.Reason, StringComparison.Ordinal))
        {
            return false;
        }

        validation = observed;
        return true;
    }
}

public sealed class AdminSessionValidationService : IAdminSessionValidationService
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

        if (principal is null || !principal.IsAdminPrincipal())
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
        return Task.FromResult(AdminSessionValidationResult.FromProjection(principal, adminId, sessionId, validation));
    }
}
