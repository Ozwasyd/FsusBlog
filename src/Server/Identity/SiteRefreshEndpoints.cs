namespace FsusBlog.V2.Server.Passkeys;

internal sealed class SiteRefreshEndpoints(SiteRefreshStore store, string accessCookie, bool secure, Action<HttpContext> requireHost,
    Func<string, CookieOptions> cookie)
{
    private const string Scope = "/api/v2/identity/refresh";
    private string RefreshCookie => CookieName(secure);

    internal void Map(WebApplication app)
    {
        app.MapGet(WireRoutes.SiteRefreshAvailability, (HttpContext ctx) =>
        {
            requireHost(ctx);
            return ServerHttp.EmptyFrame();
        });
        app.MapQueryGet(WireRoutes.SiteRefreshStatus, async (HttpContext ctx, CancellationToken ct) =>
        {
            requireHost(ctx);
            return await store.HasCurrent(ctx.Request.Cookies[RefreshCookie], ct)
                ? ServerHttp.EmptyFrame() : Failure(ctx, 401, "REFRESH_EXPIRED_OR_UNKNOWN");
        });
        app.MapPost(WireRoutes.SiteRefreshRotate, async (HttpContext ctx, CancellationToken ct) =>
        {
            RequirePost(ctx);
            var result = await store.Rotate(ctx.Request.Cookies[RefreshCookie], ctx.Request.Cookies[accessCookie], ct);
            if (result.Cookies is { } issued)
            {
                Issue(ctx, issued);
                return ServerHttp.EmptyFrame();
            }
            if (result.Kind == SiteRefreshStore.ResultKind.Contention) return Failure(ctx, 409, "REFRESH_ROTATION_CONFLICT");
            return Failure(ctx, 401,
                result.Kind == SiteRefreshStore.ResultKind.Compromised ? "REFRESH_FAMILY_COMPROMISED" : "REFRESH_EXPIRED_OR_UNKNOWN");
        }).RequireRateLimiting("mfa");
        app.MapPost(WireRoutes.SiteRefreshSignOut, async (HttpContext ctx, Store accessStore, CancellationToken ct) =>
        {
            RequirePost(ctx);
            var access = ctx.Request.Cookies[accessCookie];
            await store.SignOut(ctx.Request.Cookies[RefreshCookie], access, ct);
            // A browser may have a normal session and a surviving refresh cookie from a prior login.
            await accessStore.SignOut(access, ct);
            ctx.Response.Cookies.Delete(accessCookie, cookie("/"));
            ctx.Response.Cookies.Delete(RefreshCookie, cookie(Scope));
            return ServerHttp.EmptyFrame();
        }).RequireRateLimiting("mfa");
    }

    internal void Issue(HttpContext ctx, SiteRefreshStore.Issued issued)
    {
        var accessOptions = cookie("/");
        accessOptions.Expires = issued.RefreshExpires;
        ctx.Response.Cookies.Append(accessCookie, issued.Access, accessOptions);
        var refreshOptions = cookie(Scope);
        if (issued.Refresh is not null && issued.RefreshExpires is { } refreshExpires)
        {
            refreshOptions.Expires = refreshExpires;
            ctx.Response.Cookies.Append(RefreshCookie, issued.Refresh, refreshOptions);
            ctx.Response.Headers[WireHeaders.SiteRefresh] = "persistent";
        }
        else ctx.Response.Cookies.Delete(RefreshCookie, refreshOptions);
        SetAccessExpiry(ctx, issued.AccessExpires);
    }

    internal static void SetAccessExpiry(HttpContext ctx, DateTimeOffset expiry) =>
        ctx.Response.Headers[WireHeaders.AccessExpiresAtUtc] = expiry.UtcDateTime.ToString("O", CultureInfo.InvariantCulture);

    internal static void ClearRefreshCookie(HttpContext ctx) =>
        ctx.Response.Cookies.Delete(CookieName(ctx.Request.IsHttps), new CookieOptions
        {
            HttpOnly = true, Secure = ctx.Request.IsHttps, SameSite = SameSiteMode.Strict, Path = Scope
        });

    private static string CookieName(bool secure) => secure ? "__Secure-FsusSiteRefresh" : "fsus-v2-site-refresh";

    private void RequirePost(HttpContext ctx)
    {
        requireHost(ctx);
        if (ctx.Request.ContentLength is > 0 || ctx.Request.Headers.ContainsKey("Transfer-Encoding"))
            throw new BadHttpRequestException("This action does not accept a request body.", 400);
        var expected = $"{ctx.Request.Scheme}://{ctx.Request.Host}";
        if (ctx.Request.Headers.Origin is { Count: 1 } origin &&
            string.Equals(origin[0], expected, StringComparison.OrdinalIgnoreCase)) return;
        throw new BusinessException(Rejection.Forbidden, "A same-origin refresh request is required.");
    }

    private static IResult Failure(HttpContext ctx, int status, string code) => ServerHttp.ErrorFrame(ctx, status, code);
}
