namespace FsusBlog.Server.Entities;

/// <summary>Carries the verified current authentication provenance through login, issuance and refresh.</summary>
public readonly record struct UserSessionAuthenticationContext(
    string Method,
    string Strength,
    DateTime AuthenticatedAtUtc,
    int? CredentialRowId,
    string DurationPolicy = UserSessionDurationPolicies.BrowserSession,
    UserSessionMode SessionMode = UserSessionMode.Normal)
{
    /// <summary>Requires an exact current producer combination and its verified credential reference.</summary>
    public bool IsValid()
        => UserSessionAuthenticationContract.IsValid(Method, Strength, CredentialRowId)
            && AuthenticatedAtUtc != default
            && AuthenticatedAtUtc.Kind == DateTimeKind.Utc
            && UserSessionDurationPolicies.IsValid(DurationPolicy)
            && SessionMode is UserSessionMode.Normal or UserSessionMode.Restricted;

    public static bool TryFromSession(UserSession session, out UserSessionAuthenticationContext context)
    {
        context = new UserSessionAuthenticationContext(
            session.AuthenticationMethod,
            session.AuthenticationStrength,
            DateTime.SpecifyKind(session.AuthenticatedAtUtc, DateTimeKind.Utc),
            session.AuthenticatedCredentialRowId,
            session.DurationPolicy,
            session.SessionMode);
        if (!context.IsValid())
        {
            context = default;
            return false;
        }
        return true;
    }
}
