using System.Threading.RateLimiting;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server.Comments;
using FsusBlog.V2.Server.Operations;
using FsusBlog.V2.Server.Passkeys;
using Microsoft.AspNetCore.RateLimiting;
using Npgsql;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminIdentityEndpoints
{
    private const string OriginSetting = "FSUSBLOG_ADMIN_ORIGIN";
    private const string RpSetting = "FSUSBLOG_ADMIN_RP_ID";
    private const string PublicOriginSetting = "FSUSBLOG_PUBLIC_ORIGIN";
    private const string ApiPath = "/api/v2/admin/identity";
    private const string PagePath = "/admin/identity";
    private const string Limit = "admin-passkey";

    internal static void AddRateLimits(RateLimiterOptions options) =>
        options.AddPolicy(Limit, context => RateLimitPartition.GetFixedWindowLimiter(
            (context.Connection.RemoteIpAddress, (context.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText),
            _ => new FixedWindowRateLimiterOptions { PermitLimit = 8, Window = TimeSpan.FromMinutes(1) }));

    internal static bool IsAllowed(HttpContext ctx, PasskeyConfiguration? config)
    {
        var path = ctx.Request.Path;
        var administration = path == PagePath || path.StartsWithSegments(ApiPath) || AdminSitePages.IsLegacyRoute(path) ||
            path.StartsWithSegments("/api/binary/author/comments");
        if (config is null) return !administration;
        var isAdminOrigin = string.Equals(config.Origin.Scheme, ctx.Request.Scheme, StringComparison.OrdinalIgnoreCase) &&
            string.Equals(config.Origin.Authority, ctx.Request.Host.Value, StringComparison.OrdinalIgnoreCase);
        return isAdminOrigin
            ? administration || path.StartsWithSegments("/assets") || path.StartsWithSegments("/dist")
            : !administration;
    }

    internal static PasskeyConfiguration? ReadConfiguration(IConfiguration configuration)
    {
        var config = PasskeyConfiguration.Read(configuration, OriginSetting, RpSetting);
        if (config is null) return null;
        var site = PasskeyConfiguration.Read(configuration);
        var publicHost = configuration[PublicOriginSetting];
        if (site?.RpId == config.RpId ||
            (Uri.TryCreate(publicHost, UriKind.Absolute, out var siteOrigin) && siteOrigin.IdnHost == config.RpId) ||
            (!config.Origin.IsLoopback && !Uri.TryCreate(publicHost, UriKind.Absolute, out _)))
            throw new InvalidOperationException("Administration requires a dedicated origin and RP ID distinct from this site's public host and account RP.");
        return config;
    }

    internal static void Map(WebApplication app, PasskeyConfiguration? config,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame, InstalledCommentRoutes commentRoutes, bool trustLoopbackProxy)
    {
        if (config is null) return;
        var secure = config.Origin.Scheme == "https";
        var session = secure ? "__Host-FsusAdminSession" : "fsus-v2-admin-session";
        var bootstrap = secure ? "__Host-FsusAdminBootstrap" : "fsus-v2-admin-bootstrap";
        var login = secure ? "__Host-FsusAdminAssertion" : "fsus-v2-admin-assertion";
        var store = new AdminPasskeyStore(app.Services.GetRequiredService<NpgsqlDataSource>(),
            app.Services.GetRequiredService<InstanceLease>(), config);
        var appearance = app.Services.GetService<FsusBlog.V2.Server.Content.AppearanceAssets>();

        app.MapGet(PagePath, (HttpContext ctx) =>
        {
            ctx.Response.Headers.CacheControl = "no-store";
            ctx.Response.Headers["X-Robots-Tag"] = "noindex";
            return Results.Bytes(app.Services.GetRequiredService<WebPages>().Page(useAppearance: false), "text/html; charset=utf-8");
        });
        app.MapPost(WireRoutes.AdminBootstrapBegin, async (HttpContext ctx, CancellationToken ct) =>
        {
            var result = await store.BeginBootstrap(BootstrapToken(ctx), ct);
            ctx.Response.Cookies.Append(bootstrap, result.Binding, Ceremony(WireRoutes.AdminBootstrapComplete));
            return Frame(result.Frame);
        }).RequireRateLimiting(Limit);
        app.MapPost(WireRoutes.AdminBootstrapComplete, async (HttpContext ctx, CancellationToken ct) =>
        {
            var input = PasskeyWire.ReadProvision(await readFrame(ctx, WireLimits.MaxPasskeyFrameBytes, ct));
            await store.CompleteBootstrap(input, ctx.Request.Cookies[bootstrap], BootstrapToken(ctx), ct);
            ctx.Response.Cookies.Delete(bootstrap, Cookie(WireRoutes.AdminBootstrapComplete));
            return Frame(Wire.EncodeEmptySuccess());
        }).RequireRateLimiting(Limit);
        app.MapPost(WireRoutes.AdminPasskeyBegin, async (HttpContext ctx, CancellationToken ct) =>
        {
            var result = await store.BeginLogin(ct);
            ctx.Response.Cookies.Append(login, result.Binding, Ceremony(WireRoutes.AdminPasskeyComplete));
            return Frame(result.Frame);
        }).RequireRateLimiting(Limit);
        app.MapPost(WireRoutes.AdminPasskeyComplete, async (HttpContext ctx, CancellationToken ct) =>
        {
            var input = PasskeyWire.ReadLogin(await readFrame(ctx, WireLimits.MaxPasskeyFrameBytes, ct));
            var token = await store.CompleteLogin(input, ctx.Request.Cookies[login], ct);
            ctx.Response.Cookies.Delete(login, Cookie(WireRoutes.AdminPasskeyComplete));
            ctx.Response.Cookies.Append(session, token, Cookie(ApiPath));
            return Frame(Wire.EncodeEmptySuccess());
        }).RequireRateLimiting(Limit);
        app.MapGet(WireRoutes.AdminSession, async (HttpContext ctx, CancellationToken ct) =>
        {
            var active = await store.SessionWithPermissionBinding(ctx.Request.Cookies[session], ct);
            if (appearance is { Online: true }) ctx.Response.Headers[WireHeaders.AdminAppearanceEnabled] = "1";
            ctx.Response.Headers[WireHeaders.AdminPermissionSession] = active.PermissionSession;
            return Frame(Wire.EncodeAdminSessionSnapshot(active.Snapshot));
        }).RequireRateLimiting("command");
        app.MapGet(WireRoutes.AdminEffectivePermissions, async (HttpContext ctx, CancellationToken ct) =>
        {
            var scope = await store.EffectivePermissions(ctx.Request.Cookies[session], ct);
            ctx.Response.Headers[WireHeaders.AdminPermissionSession] = scope.PermissionSession;
            return Frame(Wire.EncodeAdminEffectivePermissions(scope.Permissions));
        }).RequireRateLimiting("command");
        app.MapGet(WireRoutes.AdminSignInHistory, async (HttpContext ctx, CancellationToken ct) =>
        {
            var scope = await store.RecentSignIns(ctx.Request.Cookies[session], ct);
            ctx.Response.Headers[WireHeaders.AdminPermissionSession] = scope.PermissionSession;
            return Frame(Wire.EncodeAdminSignInHistory(scope.History));
        }).RequireRateLimiting("command");
        app.MapPost(WireRoutes.AdminStepUpBegin, async (HttpContext ctx, CancellationToken ct) =>
        {
            var intent = Wire.DecodeAdminModerationIntent(await readFrame(ctx, WireLimits.AdminModerationFrameBytes, ct));
            return Frame(await store.BeginModerationStepUp(ctx.Request.Cookies[session], intent, ct));
        }).RequireRateLimiting(Limit);
        app.MapPost(WireRoutes.AdminStepUpComplete, async (HttpContext ctx, CancellationToken ct) =>
        {
            var input = PasskeyWire.ReadLogin(await readFrame(ctx, WireLimits.MaxPasskeyFrameBytes, ct), discoverable: false);
            return Frame(await store.CompleteModerationStepUp(ctx.Request.Cookies[session], input, ct));
        }).RequireRateLimiting(Limit);
        app.MapGet(WireRoutes.AdminOperationsStatus, async (HttpContext ctx, Publications publications, CancellationToken ct) =>
        {
            var result = await store.OperationsStatus(ctx.Request.Cookies[session], publications, ct);
            ctx.Response.Headers[WireHeaders.AdminPermissionSession] = result.PermissionSession;
            return Frame(Wire.EncodeAdminOperationsStatus(result.Status));
        }).RequireRateLimiting("command");
        var batchModeration = app.Configuration.GetValue(AdminModerationBatchEndpoints.Setting, false);
        app.MapGet(WireRoutes.AdminCommentQueue, async (HttpContext ctx, CancellationToken ct) =>
            Frame(Wire.EncodeAdminCommentQueue(await store.CommentQueue(ctx.Request.Cookies[session], ctx.Request.Query, ct,
                batchModeration ? () => ctx.Response.Headers[WireHeaders.AdminModerationBatchEnabled] = "1" : null))))
            .RequireRateLimiting("command");
        AdminClusterEndpoints.Map(app, store, session, Limit);
        if (secure) AdminRiskReadinessEndpoints.Map(app, config.Origin, store, session, Limit, commentRoutes, trustLoopbackProxy, readFrame);
        AdminModerationEndpoints.Map(app, config.Origin, store, session, Limit, readFrame);
        AdminInboxEndpoints.Map(app, store, session, readFrame);
        AdminSitePages.Map(app, store, session);
        AdminCommentRevisions.Map(app, store, session);
        if (app.Configuration.GetValue(AdminTagMetadataEndpoints.Setting, false))
            AdminTagMetadataEndpoints.Map(app, config.Origin, store, session, readFrame);
        if (app.Configuration.GetValue(AdminArticleRollbackEndpoints.Setting, false))
            AdminArticleRollbackEndpoints.Map(app, config.Origin, store, session, Limit, readFrame);
        if (app.Services.GetRequiredService<FsusBlog.V2.Server.Content.SitePages>().EditorEnabled)
            AdminSitePageEditorEndpoints.Map(app, config.Origin, store, session, Limit, readFrame);
        if (appearance is { Online: true })
            AdminAppearanceEndpoints.Map(app, config.Origin, store, session, Limit, readFrame, appearance.Registry);
        app.MapGet(WireRoutes.AdminCategories, async (HttpContext ctx, Publications publications, CancellationToken ct) =>
            Frame(Wire.EncodeAdminTaxonomyPage(await store.Taxonomy(ctx.Request.Cookies[session], false, ctx.Request.Query, publications, ct))))
            .RequireRateLimiting("command");
        app.MapGet(WireRoutes.AdminTags, async (HttpContext ctx, Publications publications, CancellationToken ct) =>
            Frame(Wire.EncodeAdminTaxonomyPage(await store.Taxonomy(ctx.Request.Cookies[session], true, ctx.Request.Query, publications, ct))))
            .RequireRateLimiting("command");
        app.MapPost(WireRoutes.AdminSignOut, async (HttpContext ctx, CancellationToken ct) =>
        {
            await store.SignOut(ctx.Request.Cookies[session], ct);
            ctx.Response.Cookies.Delete(session, Cookie(ApiPath));
            return Frame(Wire.EncodeEmptySuccess());
        }).RequireRateLimiting("command");

        CookieOptions Cookie(string path) => new() { HttpOnly = true, Secure = secure, SameSite = SameSiteMode.Strict, Path = secure ? "/" : path };
        CookieOptions Ceremony(string path)
        {
            var options = Cookie(path);
            options.MaxAge = TimeSpan.FromMinutes(2);
            return options;
        }
    }

    private static string? BootstrapToken(HttpContext ctx) =>
        ctx.Request.Headers[WireHeaders.AdminBootstrapToken] is { Count: 1 } value ? value[0] : null;

    private static IResult Frame(byte[] frame) => Results.Bytes(frame, Aeds.ContentType);
}
