using System.Threading.RateLimiting;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Analytics;
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
    private const string ApiPath = "/api/v2/admin/identity";
    private static readonly string[] DocumentPaths =
        ["/admin", "/admin/articles", "/admin/articles/write", "/admin/articles/workspace", "/admin/canvas", "/admin/assets", "/admin/interaction", "/admin/site", "/admin/system", "/admin/identity"];
    private static readonly string[] ParameterizedDocumentPaths =
        ["/admin/articles/edit/{id:int}", "/admin/canvas/{id:guid}"];
    private const string Limit = "admin-passkey";

    internal static string SessionCookieName(PasskeyConfiguration config) =>
        config.Origin.Scheme == "https" ? "__Host-FsusAdminSession" : "fsus-v2-admin-session";

    internal static bool IsAdminOrigin(HttpContext ctx, PasskeyConfiguration? config) =>
        config is not null &&
        string.Equals(config.Origin.Scheme, ctx.Request.Scheme, StringComparison.OrdinalIgnoreCase) &&
        string.Equals(config.Origin.Authority, ctx.Request.Host.Value, StringComparison.OrdinalIgnoreCase);

    internal static void AddRateLimits(RateLimiterOptions options) =>
        options.AddPolicy(Limit, context => RateLimitPartition.GetFixedWindowLimiter(
            (context.Connection.RemoteIpAddress, (context.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText),
            _ => new FixedWindowRateLimiterOptions { PermitLimit = 8, Window = TimeSpan.FromMinutes(1) }));

    internal static bool IsAllowed(HttpContext ctx, PasskeyConfiguration? config)
    {
        var path = ctx.Request.Path;
        var administration = path.StartsWithSegments("/admin") ||
            path.StartsWithSegments(ApiPath) || path.StartsWithSegments("/api/v2/authoring") ||
            path.StartsWithSegments("/api/v2/media") || AdminSitePages.IsLegacyRoute(path) ||
            path.StartsWithSegments("/api/binary/author/comments");
        return !administration || IsAdminOrigin(ctx, config);
    }

    internal static PasskeyConfiguration? ReadConfiguration(IConfiguration configuration, string? publicOrigin = null)
    {
        var explicitOrigin = configuration[OriginSetting];
        var explicitRp = configuration[RpSetting];
        if (explicitOrigin is not null || explicitRp is not null)
        {
            if (string.IsNullOrWhiteSpace(explicitOrigin) && string.IsNullOrWhiteSpace(explicitRp))
                return null;
            return PasskeyConfiguration.Read(configuration, OriginSetting, RpSetting);
        }
        if (string.IsNullOrWhiteSpace(publicOrigin) ||
            !Uri.TryCreate(publicOrigin, UriKind.Absolute, out var derived) ||
            !string.Equals(publicOrigin, derived.GetLeftPart(UriPartial.Authority), StringComparison.Ordinal) ||
            (derived.HostNameType != UriHostNameType.Dns && !derived.IsLoopback))
            return null;
        return new(derived, derived.IdnHost);
    }

    internal static void Map(WebApplication app, SiteCapabilities capabilities,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame, InstalledCommentRoutes commentRoutes,
        Func<HttpContext, string, int, string?> query)
    {
        var config = capabilities.AdminIdentity;
        if (config is null) return;
        var secure = config.Origin.Scheme == "https";
        var session = SessionCookieName(config);
        var bootstrap = secure ? "__Host-FsusAdminBootstrap" : "fsus-v2-admin-bootstrap";
        var login = secure ? "__Host-FsusAdminAssertion" : "fsus-v2-admin-assertion";
        var store = new AdminPasskeyStore(app.Services.GetRequiredService<NpgsqlDataSource>(),
            app.Services.GetRequiredService<InstanceLease>(), config);
        var appearance = app.Services.GetService<FsusBlog.V2.Server.Content.AppearanceAssets>();

        var document = app.Services.GetRequiredService<WebPages>().AdminPage(capabilities.PublicSite.Origin);
        foreach (var path in DocumentPaths.Concat(ParameterizedDocumentPaths))
            app.MapGet(path, (HttpContext ctx) =>
            {
                ctx.Response.Headers.CacheControl = "no-store";
                ctx.Response.Headers["X-Robots-Tag"] = "noindex";
                return Results.Bytes(document, ServerHttp.HtmlContentType);
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
            ctx.Response.Cookies.Append(session, token, Cookie("/"));
            return Frame(Wire.EncodeEmptySuccess());
        }).RequireRateLimiting(Limit);
        app.MapGet(WireRoutes.AdminSession, async (HttpContext ctx, CancellationToken ct) =>
        {
            var active = await store.SessionWithPermissionBinding(ctx.Request.Cookies[session], ct);
            if (appearance is { Online: true }) ctx.Response.Headers[WireHeaders.AdminAppearanceEnabled] = "1";
            ctx.Response.Headers[WireHeaders.AdminPermissionSession] = active.PermissionSession;
            return Frame(Wire.EncodeAdminSessionSnapshot(active.Snapshot));
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
        app.MapGet(WireRoutes.AdminSiteTraffic, async (HttpContext ctx, SiteTraffic traffic, CancellationToken ct) =>
        {
            var result = await store.ReadSiteTraffic(ctx.Request.Cookies[session], traffic, ct);
            ctx.Response.Headers[WireHeaders.AdminPermissionSession] = result.PermissionSession;
            return Frame(Wire.EncodeAdminSiteTraffic(result.Traffic));
        }).RequireRateLimiting("command");
        var batchModeration = capabilities.AdminCommentBatch;
        app.MapGet(WireRoutes.AdminCommentQueue, async (HttpContext ctx, CancellationToken ct) =>
            Frame(Wire.EncodeAdminCommentQueue(await store.CommentQueue(ctx.Request.Cookies[session], ctx.Request.Query, ct,
                batchModeration ? () => ctx.Response.Headers[WireHeaders.AdminModerationBatchEnabled] = "1" : null))))
            .RequireRateLimiting("command");
        AdminClusterEndpoints.Map(app, store, session, Limit);
        if (secure) AdminRiskReadinessEndpoints.Map(app, config.Origin, store, session, Limit, commentRoutes, capabilities.TrustLoopbackProxy, readFrame);
        AdminModerationEndpoints.Map(app, config.Origin, store, session, Limit, readFrame, capabilities);
        AdminInboxEndpoints.Map(app, store, session, readFrame, capabilities);
        AdminSitePages.Map(app, store, session);
        AdminCommentRevisions.Map(app, store, session);
        AdminArticleTrashRestore.Map(app, config.Origin, store, session, Limit, readFrame);
        AdminArticleTrashPublication.Map(app, config.Origin, store, session, Limit, readFrame);
        if (capabilities.AdminTagMetadata)
            AdminTagMetadataEndpoints.Map(app, config.Origin, store, session, readFrame);
        if (capabilities.AdminCategoryMetadata)
            AdminTagMetadataEndpoints.Map(app, config.Origin, store, session, readFrame, category: true);
        if (capabilities.AdminArticleRollback)
            AdminArticleRollbackEndpoints.Map(app, config.Origin, store, session, Limit, readFrame);
        if (app.Services.GetRequiredService<FsusBlog.V2.Server.Content.SitePages>().EditorEnabled)
            AdminSitePageEditorEndpoints.Map(app, config.Origin, store, session, Limit, readFrame);
        if (appearance is { Online: true })
            AdminAppearanceEndpoints.Map(app, config.Origin, store, session, Limit, readFrame, appearance.Registry);
        app.MapGet(WireRoutes.AdminCategories, (HttpContext ctx, Publications publications, CancellationToken ct) =>
            Taxonomy(ctx, publications, false, ct))
            .RequireRateLimiting("command");
        app.MapGet(WireRoutes.AdminTags, (HttpContext ctx, Publications publications, CancellationToken ct) =>
            Taxonomy(ctx, publications, true, ct))
            .RequireRateLimiting("command");
        async Task<IResult> Taxonomy(HttpContext ctx, Publications publications, bool tags, CancellationToken ct)
        {
            var token = ctx.Request.Cookies[session];
            var input = ctx.Request.Query;
            return Frame(input.ContainsKey("dependency")
                ? Wire.EncodeAdminTaxonomyDependencies(await store.TaxonomyDependencies(token, tags, input, ct))
                : Wire.EncodeAdminTaxonomyPage(await store.Taxonomy(token, tags, input, publications, ct)));
        }
        app.MapGet(WireRoutes.AdminArticleInventory, (HttpContext ctx, CancellationToken ct) =>
        {
            ctx.Response.Headers.CacheControl = "no-store";
            return store.ArticleInventory(ctx.Request.Cookies[session], ctx, query, ct);
        }).RequireRateLimiting("command");
        app.MapPost(WireRoutes.AdminArticleDelete, async (HttpContext ctx, int id, Publications publications, CancellationToken ct) =>
        {
            AdminActionRoutes.RequireOrigin(ctx, config.Origin.GetLeftPart(UriPartial.Authority));
            if (id <= 0) throw new BusinessException(Rejection.Invalid, "Invalid article ID.");
            return Frame(await publications.AdministrativePublication(
                invalidate => store.DeleteArticle(ctx.Request.Cookies[session], id, invalidate, ct), ct));
        }).RequireRateLimiting("command");
        app.MapPost(WireRoutes.AdminSignOut, async (HttpContext ctx, CancellationToken ct) =>
        {
            await store.SignOut(ctx.Request.Cookies[session], ct);
            ctx.Response.Cookies.Delete(session, Cookie("/"));
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
