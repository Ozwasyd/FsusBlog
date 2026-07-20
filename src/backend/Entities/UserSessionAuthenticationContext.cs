namespace FsusBlog.Server.Entities;

public static class UserSessionAuthenticationMethods
{
    public const string Passkey = "passkey";
    public const string RecoveryKey = "recovery_key";
    public const string Enrollment = "enrollment";
    public const string Other = "other";

    public static bool IsValid(string? value)
        => value is Passkey or RecoveryKey or Enrollment or Other;
}

public static class UserSessionAuthenticationStrengths
{
    public const string WebAuthnUv = "webauthn_uv";
    public const string Mfa = "mfa";
    public const string Recovery = "recovery";
    public const string LegacyVerified = "legacy_verified";
    public const string LegacyUnverified = "legacy_unverified";

    public static bool IsValid(string? value)
        => value is WebAuthnUv or Mfa or Recovery or LegacyVerified or LegacyUnverified;

    public static bool IsCoarseMfa(string value)
        => value is WebAuthnUv or Mfa or Recovery or LegacyVerified;
}

public static class UserSessionDurationPolicies
{
    public const string BrowserSession = "browser_session";
    public const string Persistent30Days = "persistent_30d";

    public static string FromRememberMe(bool rememberMe)
        => rememberMe ? Persistent30Days : BrowserSession;

    public static bool IsPersistent(string? value)
        => string.Equals(value, Persistent30Days, StringComparison.Ordinal);

    public static bool IsValid(string? value)
        => value is BrowserSession or Persistent30Days;
}

public enum UserSessionMode
{
    Normal = 0,
    Restricted = 1,
    Revoked = 2
}

public static class UserSessionModes
{
    public const string ClaimType = "session_mode";

    public static string ToClaimValue(UserSessionMode mode)
        => mode switch
        {
            UserSessionMode.Normal => "normal",
            UserSessionMode.Restricted => "restricted",
            UserSessionMode.Revoked => "revoked",
            _ => throw new ArgumentOutOfRangeException(nameof(mode))
        };

    public static bool TryParseClaim(string? value, out UserSessionMode mode)
    {
        mode = value switch
        {
            "normal" => UserSessionMode.Normal,
            "restricted" => UserSessionMode.Restricted,
            "revoked" => UserSessionMode.Revoked,
            _ => (UserSessionMode)(-1)
        };
        return Enum.IsDefined(mode);
    }
}

public readonly record struct UserSessionAuthenticationContext(
    string Method,
    string Strength,
    DateTime AuthenticatedAtUtc,
    int? CredentialRowId = null,
    string DurationPolicy = UserSessionDurationPolicies.BrowserSession,
    UserSessionMode SessionMode = UserSessionMode.Normal)
{
    public static UserSessionAuthenticationContext FromLegacy(bool mfaVerified, bool rememberMe, DateTime? authenticatedAtUtc = null)
        => new(
            UserSessionAuthenticationMethods.Other,
            mfaVerified
                ? UserSessionAuthenticationStrengths.LegacyVerified
                : UserSessionAuthenticationStrengths.LegacyUnverified,
            authenticatedAtUtc ?? DateTime.UtcNow,
            null,
            UserSessionDurationPolicies.FromRememberMe(rememberMe),
            UserSessionMode.Normal);

    public static bool TryFromSession(UserSession session, out UserSessionAuthenticationContext context)
    {
        if (!UserSessionAuthenticationMethods.IsValid(session.AuthenticationMethod) ||
            !UserSessionAuthenticationStrengths.IsValid(session.AuthenticationStrength) ||
            !UserSessionDurationPolicies.IsValid(session.DurationPolicy) ||
            session.AuthenticatedAtUtc == default)
        {
            context = default;
            return false;
        }

        context = new UserSessionAuthenticationContext(
            session.AuthenticationMethod,
            session.AuthenticationStrength,
            DateTime.SpecifyKind(session.AuthenticatedAtUtc, DateTimeKind.Utc),
            session.AuthenticatedCredentialRowId,
            session.DurationPolicy,
            session.SessionMode);
        return true;
    }
}
