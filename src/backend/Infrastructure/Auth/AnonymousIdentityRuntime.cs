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
    {
        string role = string.IsNullOrWhiteSpace(user.Role) ? GuestRole : user.Role.Trim().ToLowerInvariant();
        if (!IsAnonymousIdentityModeEnabled())
        {
            return role;
        }

        if (string.Equals(user.IdentityKind, AdminPrincipalKind, StringComparison.Ordinal))
        {
            return role;
        }

        return string.Equals(role, "admin", StringComparison.Ordinal)
            ? AuthenticatedRole
            : role;
    }
}
