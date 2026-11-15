namespace FsusBlog.V2.Server.Passkeys;

internal sealed class SiteMfaPostRoutes(WebApplication app, Action<HttpContext> requireOrigin)
{
    internal void Post(string route, Func<HttpContext, CancellationToken, Task<IResult>> handle) =>
        app.MapPost(route, (HttpContext ctx, CancellationToken ct) =>
        {
            requireOrigin(ctx);
            return handle(ctx, ct);
        }).RequireRateLimiting("mfa");
}
