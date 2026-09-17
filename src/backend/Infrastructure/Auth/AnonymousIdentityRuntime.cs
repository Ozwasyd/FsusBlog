using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Helpers;

namespace FsusBlog.Server.Infrastructure.Auth;

/// <summary>Centralizes anonymous-identity mode detection, identity kinds, and backend role normalization.</summary>
public static class AnonymousIdentityRuntime
{
    public const string ModeEnvironmentVariable = "FSUSBLOG_ANONYMOUS_IDENTITY_MODE";
    public const string AnonymousAccountKind = "anonymous_account";
    public const string AdminPrincipalKind = "admin_principal";
    public const string AccountSubjectHashClaim = "account_subject_hash";
    public const string AuthenticatedRole = "authenticated";
    public const string GuestRole = "guest";
    public const string LegacyPasswordDisabledMessage = "Legacy password identity is disabled in anonymous identity mode";

    /// <summary>Reads the process-level anonymous-identity feature switch using the accepted enabled values.</summary>
    public static bool IsAnonymousIdentityModeEnabled()
    {
        string? value = Environment.GetEnvironmentVariable(ModeEnvironmentVariable);
        return string.Equals(value, "1", StringComparison.OrdinalIgnoreCase)
            || string.Equals(value, "true", StringComparison.OrdinalIgnoreCase)
            || string.Equals(value, "enabled", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Resolves an account's effective backend role under the current anonymous-identity mode.</summary>
    public static string ResolveBackendRole(User user)
        => ResolveBackendRole(null, user.IdentityKind);

    /// <summary>Normalizes a supplied role while preventing non-admin identities from retaining the administrator role.</summary>
    public static string ResolveBackendRole(string? roleValue, string? identityKind)
        => ResolveBackendRole(roleValue, identityKind, IsAnonymousIdentityModeEnabled());

    internal static string ResolveBackendRole(string? roleValue, string? identityKind, bool anonymousIdentityModeEnabled)
    {
        string role = TextHelpers.LowerTrimmed(roleValue) ?? GuestRole;
        if (!anonymousIdentityModeEnabled)
        {
            return role;
        }

        if (string.Equals(identityKind, AdminPrincipalKind, StringComparison.Ordinal))
        {
            return role;
        }

        return string.Equals(role, "admin", StringComparison.Ordinal)
            ? AuthenticatedRole
            : role;
    }
}
