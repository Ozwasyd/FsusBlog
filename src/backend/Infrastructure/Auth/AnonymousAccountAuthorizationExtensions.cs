namespace FsusBlog.Server.Infrastructure.Auth;

public static class AnonymousAccountAuthorizationExtensions
{
    public static RouteHandlerBuilder RequireAnonymousAccountPrincipal(this RouteHandlerBuilder builder)
        => builder.RequireAuthorization(policy => policy
            .RequireAuthenticatedUser()
            .RequireClaim("identity_kind", AnonymousIdentityRuntime.AnonymousAccountKind));
}
