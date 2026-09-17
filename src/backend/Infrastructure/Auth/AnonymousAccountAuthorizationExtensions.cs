namespace FsusBlog.Server.Infrastructure.Auth;

/// <summary>Configures authorization policies that admit only authenticated anonymous-account principals.</summary>
public static class AnonymousAccountAuthorizationExtensions
{
    /// <summary>Requires the anonymous-account identity-kind claim on the decorated endpoint.</summary>
    public static RouteHandlerBuilder RequireAnonymousAccountPrincipal(this RouteHandlerBuilder builder)
        => builder.RequireAuthorization(policy => policy
            .RequireAuthenticatedUser()
            .RequireClaim("identity_kind", AnonymousIdentityRuntime.AnonymousAccountKind));
}
