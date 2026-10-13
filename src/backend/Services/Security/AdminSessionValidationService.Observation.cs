using System.Runtime.CompilerServices;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Security;

namespace FsusBlog.Server.Services.Security;

public sealed partial class AdminSessionValidationService
{
    private readonly ConditionalWeakTable<CurrentSessionObservation, ObservedSessionState> _observedSessions = new();

    /// <summary>
    /// Exact original projected session validation data, owned by this validator instance.
    /// This is not a JWT signature result, native scope, site/operation permission or revocation lease.
    /// </summary>
    internal sealed class CurrentSessionObservation
    {
        internal long AdminPrincipalId
        {
            get;
        }
        internal AdminSessionProjectionValidationResult Facts
        {
            get;
        }

        internal CurrentSessionObservation(long adminPrincipalId, AdminSessionProjectionValidationResult facts)
        {
            AdminPrincipalId = adminPrincipalId;
            Facts = facts;
        }
    }

    private sealed record ObservedSessionState(ClaimsPrincipal Principal, long AdminPrincipalId, string SessionId, byte[] TokenHash);

    /// <summary>
    /// Runs the original validation/touch path, then captures a fresh validation from the same
    /// original projection and exact unchanged principal/session/token. Keeps no raw access token.
    /// Null is refusal, never a fabricated source generation or Bulk permission observation.
    /// </summary>
    internal async Task<CurrentSessionObservation?> CaptureCurrentSessionObservationAsync(
        ClaimsPrincipal? principal, string accessToken, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (principal?.Identity?.IsAuthenticated != true || !principal.IsAdminPrincipal()
            || !principal.TryGetAdminPrincipalId(out long adminId) || adminId <= 0
            || principal.GetAdminSessionId() is not { Length: > 0 and <= 64 } sessionId
            || string.IsNullOrWhiteSpace(accessToken))
            return null;
        byte[] tokenHash = SHA256.HashData(Encoding.UTF8.GetBytes(accessToken));
        AdminSessionValidationResult original = await ValidateAsync(principal, accessToken, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (!original.IsValid || !MatchesObservedPrincipal(principal, principal, adminId, sessionId))
            return null;
        AdminSessionProjectionValidationResult current = ReadCurrentObservedValidation(sessionId, adminId, tokenHash);
        cancellationToken.ThrowIfCancellationRequested();
        if (!current.IsValid)
            return null;
        var observation = new CurrentSessionObservation(adminId, current);
        _observedSessions.Add(observation, new(principal, adminId, sessionId, tokenHash));
        cancellationToken.ThrowIfCancellationRequested();
        return observation;
    }

    /// <summary>
    /// Revalidates against the live original projection at this call's actual validation point.
    /// Cannot attest future revocation, native DB locks, permission policy or a later commit.
    /// Revalidation does not schedule another touch or use caller-supplied version/deadline DTOs.
    /// </summary>
    internal bool IsCurrentSessionObservation(CurrentSessionObservation observation, ClaimsPrincipal? principal,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!_observedSessions.TryGetValue(observation, out ObservedSessionState? state)
            || !MatchesObservedPrincipal(principal, state.Principal, state.AdminPrincipalId, state.SessionId)
            || observation.AdminPrincipalId != state.AdminPrincipalId)
            return false;
        // Keep the actual projection decision as the last validation callout; no metric/touch callback follows it.
        AdminSessionProjectionValidationResult current = _projection.Validate(state.SessionId,
            state.AdminPrincipalId, state.TokenHash);
        cancellationToken.ThrowIfCancellationRequested();
        return current.IsValid && current == observation.Facts;
    }

    private AdminSessionProjectionValidationResult ReadCurrentObservedValidation(string sessionId, long adminId, byte[] tokenHash)
    {
        AdminSessionProjectionValidationResult validation = _projection.Validate(sessionId, adminId, tokenHash);
        AdminSessionProjectionSnapshot snapshot = _projection.Snapshot();
        FsusObservability.RecordAdminSessionProjectionValidation(validation.Source, validation.IsValid,
            snapshot.SessionEntries + snapshot.PrincipalEntries, snapshot.ResidentBytes,
            Math.Max(0, snapshot.ReadyGeneration - snapshot.LastProcessedGeneration));
        return validation;
    }

    private static bool MatchesObservedPrincipal(ClaimsPrincipal? principal, ClaimsPrincipal original,
        long adminId, string sessionId)
        => ReferenceEquals(principal, original) && principal.Identity?.IsAuthenticated == true
            && principal.IsAdminPrincipal() && principal.TryGetAdminPrincipalId(out long currentId) && currentId == adminId
            && string.Equals(principal.GetAdminSessionId(), sessionId, StringComparison.Ordinal);
}
