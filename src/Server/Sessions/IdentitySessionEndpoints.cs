namespace FsusBlog.V2.Server.Sessions;

internal static class IdentitySessionEndpoints
{
    internal static void Map(WebApplication app, string readerCookie, string authorCookie, bool persistentSite)
    {
        // Owner access tickets provision the first Passkey; they are not a public sign-in method.
        app.MapPost(WireRoutes.SignIn, (HttpContext ctx) =>
            ServerHttp.Error(ctx, 401, "Sign in with a Passkey.", "passkey_required"))
            .RequireRateLimiting("sign-in");

        app.MapGet(WireRoutes.Session, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var token = ctx.Request.Cookies[readerCookie];
            return await store.WithSession(token, false, async (db, tx, actor) =>
            {
                if (persistentSite && await SiteRefreshStore.FindCurrentFamily(db, tx, Store.TokenDigest(token)!, ct) is { } family)
                {
                    ctx.Response.Headers[WireHeaders.SiteRefresh] = "persistent";
                    ctx.Response.Headers[WireHeaders.SiteSessionContinuity] = SiteSessions.Continuity(actor.Id, family);
                }
                return ServerHttp.SessionResponse(ctx, actor, token!);
            }, ct);
        });

        app.MapCommandGet(WireRoutes.AuthoringSession, (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var adminToken = ctx.Request.Cookies[authorCookie];
            return store.WithSession(adminToken, true, (_, _, actor) => Task.FromResult(ServerHttp.SessionResponse(ctx, actor, adminToken!)), ct);
        });

        app.MapCommandPost(WireRoutes.SignOut, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            await store.SignOut(ctx.Request.Cookies[readerCookie], ct);
            ctx.Response.Cookies.Delete(readerCookie, ServerHttp.CookieSettings(ctx));
            if (persistentSite)
                SiteRefreshEndpoints.ClearRefreshCookie(ctx);
            return ServerHttp.EmptyFrame();
        });
    }
}
