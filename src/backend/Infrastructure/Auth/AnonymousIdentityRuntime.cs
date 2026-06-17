using FsusBlog.Server.Entities;

namespace FsusBlog.Server.Infrastructure.Auth;

public static class AnonymousIdentityRuntime
{
    public const string ModeEnvironmentVariable = "FSUSBLOG_ANONYMOUS_IDENTITY_MODE";
    public const string AnonymousAccountKind = "anonymous_account";
    public const string AdminPrincipalKind = "admin_principal";
    public const string AuthenticatedRole = "authenticated";
    public const string GuestRole = "guest";
    public const string LegacyPasswordDisabledMessage = "Legacy password identity is disabled in anonymous identity mode";

    public static bool IsAnonymousIdentityModeEnabled()
    {
        string? value = Environment.GetEnvironmentVariable(ModeEnvironmentVariable);
        return string.Equals(value, "1", StringComparison.OrdinalIgnoreCase)
            || string.Equals(value, "true", StringComparison.OrdinalIgnoreCase)
            || string.Equals(value, "enabled", StringComparison.OrdinalIgnoreCase);
    }

    public static string ResolveBackendRole(User user)
        => ResolveBackendRole(user.Role, user.IdentityKind);

    public static string ResolveBackendRole(string? roleValue, string? identityKind)
        => ResolveBackendRole(roleValue, identityKind, IsAnonymousIdentityModeEnabled());

    internal static string ResolveBackendRole(string? roleValue, string? identityKind, bool anonymousIdentityModeEnabled)
    {
        string role = string.IsNullOrWhiteSpace(roleValue) ? GuestRole : roleValue.Trim().ToLowerInvariant();
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
