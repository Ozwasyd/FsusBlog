using static FsusBlog.V2.Server.Administration.AdminActionRoutes;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminIdentityEndpoints
{
    private const string OriginSetting = "FSUSBLOG_ADMIN_ORIGIN";
    private const string RpSetting = "FSUSBLOG_ADMIN_RP_ID";
    private const string ApiPath = "/api/v2/admin/identity";
    private static readonly string[] DocumentPaths =
    [
        "/admin", "/admin/articles", "/admin/articles/write", "/admin/articles/workspace", "/admin/canvas",
        "/admin/assets", "/admin/interaction", "/admin/site", "/admin/identity", "/admin/articles/edit/{id:int}", "/admin/canvas/{id:guid}"
    ];
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
        var administration = path.StartsWithSegments("/admin") || path.StartsWithSegments(ApiPath) ||
            path.StartsWithSegments("/api/v2/authoring") || path.StartsWithSegments("/api/v2/media") ||
            AdminSitePages.IsLegacyRoute(path) || path.StartsWithSegments("/api/binary/author/comments");
        return !administration || IsAdminOrigin(ctx, config);
    }

    internal static PasskeyConfiguration? ReadConfiguration(IConfiguration configuration, string? publicOrigin = null)
    {
        var (explicitOrigin, explicitRp) = (configuration[OriginSetting], configuration[RpSetting]);
        if (explicitOrigin is not null || explicitRp is not null)
        {
            if ((explicitOrigin is not null && string.IsNullOrWhiteSpace(explicitOrigin)) ||
                (string.IsNullOrWhiteSpace(explicitOrigin) && string.IsNullOrWhiteSpace(explicitRp)))
                return null;
            return PasskeyConfiguration.Read(configuration, OriginSetting, RpSetting);
        }
        if (string.IsNullOrWhiteSpace(publicOrigin) || !Uri.TryCreate(publicOrigin, UriKind.Absolute, out var derived) ||
            !string.Equals(publicOrigin, derived.GetLeftPart(UriPartial.Authority), StringComparison.Ordinal) ||
            (derived.HostNameType != UriHostNameType.Dns && !derived.IsLoopback))
            return null;
        return new(derived, derived.IdnHost);
    }

    internal static void Map(WebApplication app, SiteCapabilities capabilities, InstalledCommentRoutes commentRoutes)
    {
        if (capabilities.AdminIdentity is not { } config) return;
        var secure = config.Origin.Scheme == "https";
        var session = SessionCookieName(config);
        var actions = new AdminActionRoutes(app, config.Origin.GetLeftPart(UriPartial.Authority), session, Limit);
        var (bootstrap, login) = secure
            ? ("__Host-FsusAdminBootstrap", "__Host-FsusAdminAssertion")
            : ("fsus-v2-admin-bootstrap", "fsus-v2-admin-assertion");
        var database = app.Services.GetRequiredService<NpgsqlDataSource>();
        var lease = app.Services.GetRequiredService<InstanceLease>();
        var gate = new AdminSessionGate(database, lease);
        var passkeys = new AdminPasskeyStore(database, lease, config);
        var stepUp = new AdminStepUpService(gate, passkeys);
        var operations = new AdminOperationsStore(gate);
        var signInHistory = new AdminSignInHistoryStore(gate);
        var commentQueue = new AdminCommentQueueStore(gate);
        var sitePagesService = app.Services.GetRequiredService<SitePages>();
        var sitePageStore = sitePagesService.EditorEnabled ? new AdminSitePageStore(gate, stepUp) : new AdminSitePageStore(gate);
        var trashRestore = new AdminArticleTrashRestoreStore(gate, stepUp);
        var taxonomy = new AdminTaxonomyStore(gate);
        var appearance = app.Services.GetService<AppearanceAssets>();

        var webPages = app.Services.GetRequiredService<WebPages>();
        var adminDocument = Tuple.Create(webPages.SiteConfigRevision, webPages.AdminPage(capabilities.PublicSite.Origin));
        foreach (var path in DocumentPaths)
            app.MapGet(path, (HttpContext ctx) =>
            {
                ctx.Response.Headers.CacheControl = "no-store";
                ctx.Response.Headers["X-Robots-Tag"] = "noindex";
                var currentRevision = webPages.SiteConfigRevision;
                var cached = Volatile.Read(ref adminDocument);
                if (cached.Item1 != currentRevision)
                    Volatile.Write(ref adminDocument, cached = Tuple.Create(currentRevision, webPages.AdminPage(capabilities.PublicSite.Origin)));
                return Results.Bytes(cached.Item2, ServerHttp.HtmlContentType);
            });
        app.MapPost(WireRoutes.AdminBootstrapBegin, async (HttpContext ctx, CancellationToken ct) =>
        {
            var result = await passkeys.BeginBootstrap(BootstrapToken(ctx), ct);
            ctx.Response.Cookies.Append(bootstrap, result.Binding, Ceremony(WireRoutes.AdminBootstrapComplete));
            return Frame(result.Frame);
        }).RequireRateLimiting(Limit);
        app.MapPost(WireRoutes.AdminBootstrapComplete, async (HttpContext ctx, CancellationToken ct) =>
        {
            var input = PasskeyWire.ReadProvision(await ServerHttp.ReadFrame(ctx, WireLimits.MaxPasskeyFrameBytes, ct));
            await passkeys.CompleteBootstrap(input, ctx.Request.Cookies[bootstrap], BootstrapToken(ctx), ct);
            ctx.Response.Cookies.Delete(bootstrap, Cookie(WireRoutes.AdminBootstrapComplete));
            return ServerHttp.EmptyFrame();
        }).RequireRateLimiting(Limit);
        app.MapPost(WireRoutes.AdminPasskeyBegin, async (HttpContext ctx, CancellationToken ct) =>
        {
            var result = await passkeys.BeginLogin(ct);
            ctx.Response.Cookies.Append(login, result.Binding, Ceremony(WireRoutes.AdminPasskeyComplete));
            return Frame(result.Frame);
        }).RequireRateLimiting(Limit);
        app.MapPost(WireRoutes.AdminPasskeyComplete, async (HttpContext ctx, CancellationToken ct) =>
        {
            var input = PasskeyWire.ReadLogin(await ServerHttp.ReadFrame(ctx, WireLimits.MaxPasskeyFrameBytes, ct));
            var token = await passkeys.CompleteLogin(input, ctx.Request.Cookies[login], ct);
            ctx.Response.Cookies.Delete(login, Cookie(WireRoutes.AdminPasskeyComplete));
            ctx.Response.Cookies.Append(session, token, Cookie("/"));
            return ServerHttp.EmptyFrame();
        }).RequireRateLimiting(Limit);

        actions.GetPermission(WireRoutes.AdminSession, (_, s, ct) => gate.SessionWithPermissionBinding(s, ct),
            Wire.EncodeAdminSessionSnapshot, extraHeaders: ctx =>
            {
                if (appearance is { Online: true }) ctx.Response.Headers[WireHeaders.AdminAppearanceEnabled] = "1";
                if (capabilities.SiteConfigEditor) ctx.Response.Headers[WireHeaders.AdminSiteConfigEnabled] = "1";
            });
        actions.GetPermission(WireRoutes.AdminSignInHistory, (_, s, ct) => signInHistory.RecentSignIns(s, ct), Wire.EncodeAdminSignInHistorySnapshot);
        actions.GetPermission(WireRoutes.AdminOperationsStatus,
            (ctx, s, ct) => operations.OperationsStatus(s, ctx.RequestServices.GetRequiredService<Publications>(), ct), Wire.EncodeAdminOperationsStatus);
        actions.GetPermission(WireRoutes.AdminSiteTraffic,
            (ctx, s, ct) => operations.ReadSiteTraffic(s, ctx.RequestServices.GetRequiredService<SiteTraffic>(), ct), Wire.EncodeAdminSiteTraffic);

        app.MapPost(WireRoutes.AdminStepUpBegin, async (HttpContext ctx, CancellationToken ct) =>
            Frame(await stepUp.BeginModerationStepUp(actions.Session(ctx),
                Wire.DecodeAdminModerationIntent(await ServerHttp.ReadFrame(ctx, WireLimits.AdminModerationFrameBytes, ct)), ct)))
            .RequireRateLimiting(Limit);
        app.MapPost(WireRoutes.AdminStepUpComplete, async (HttpContext ctx, CancellationToken ct) =>
            Frame(await stepUp.CompleteModerationStepUp(actions.Session(ctx),
                PasskeyWire.ReadLogin(await ServerHttp.ReadFrame(ctx, WireLimits.MaxPasskeyFrameBytes, ct), discoverable: false), ct)))
            .RequireRateLimiting(Limit);

        app.MapCommandGet(WireRoutes.AdminCommentQueue, async (HttpContext ctx, CancellationToken ct) =>
            Frame(Wire.EncodeAdminCommentQueue(await commentQueue.CommentQueue(actions.Session(ctx), ctx.Request.Query, ct,
                capabilities.AdminCommentBatch ? () => ctx.Response.Headers[WireHeaders.AdminModerationBatchEnabled] = "1" : null))));

        AdminClusterEndpoints.Map(app, operations, session, Limit);
        if (secure)
            AdminRiskReadinessEndpoints.Map(actions, operations, commentRoutes.RootPowPolicy ? new(gate, stepUp) : null,
                commentRoutes, capabilities.TrustLoopbackProxy);
        var fenceVisibleMessages = capabilities.AdminInboxActivityOrder;
        AdminCommentAppeals.Map(actions, new(gate, stepUp), fenceVisibleMessages);
        if (capabilities.AdminCommentBatch)
            AdminModerationBatchEndpoints.Map(actions, new(gate, stepUp), fenceVisibleMessages);
        AdminModerationEndpoints.Map(actions, new(gate, stepUp), fenceVisibleMessages);
        AdminReaderGovernanceEndpoints.Map(actions, new(gate, stepUp));
        AdminHandleEndpoints.Map(actions, new(gate, stepUp));
        AdminInboxEndpoints.Map(app, gate, session, capabilities);
        AdminSitePages.Map(app, sitePageStore, session);
        AdminCommentRevisions.Map(app, new(gate), session);
        AdminArticleTrashRestore.Map(actions, trashRestore);
        AdminArticleTrashPublication.Map(actions, new(gate, stepUp));
        if (capabilities.AdminTagMetadata || capabilities.AdminCategoryMetadata)
        {
            var tagMetadata = new AdminTagMetadataStore(gate);
            if (capabilities.AdminTagMetadata) AdminTagMetadataEndpoints.Map(actions, tagMetadata);
            if (capabilities.AdminCategoryMetadata) AdminTagMetadataEndpoints.Map(actions, tagMetadata, category: true);
        }
        if (capabilities.AdminArticleRollback)
            AdminArticleRollbackEndpoints.Map(actions, new(gate, stepUp), new(gate, stepUp));
        if (sitePagesService.EditorEnabled) AdminSitePageEditorEndpoints.Map(actions, sitePageStore);
        if (capabilities.SiteConfigEditor) AdminSiteConfigEndpoints.Map(actions, new(gate, stepUp), capabilities.PublicSite);
        if (appearance is { Online: true }) AdminAppearanceEndpoints.Map(actions, new(gate, stepUp), appearance.Registry);

        app.MapCommandGet(WireRoutes.AdminCategories, (HttpContext ctx, Publications publications, CancellationToken ct) => Taxonomy(ctx, publications, false, ct));
        app.MapCommandGet(WireRoutes.AdminTags, (HttpContext ctx, Publications publications, CancellationToken ct) => Taxonomy(ctx, publications, true, ct));
        async Task<IResult> Taxonomy(HttpContext ctx, Publications publications, bool tags, CancellationToken ct)
        {
            var (token, input) = (actions.Session(ctx), ctx.Request.Query);
            return Frame(input.ContainsKey("dependency")
                ? Wire.EncodeAdminTaxonomyDependencies(await taxonomy.TaxonomyDependencies(token, tags, input, ct))
                : Wire.EncodeAdminTaxonomyPage(await taxonomy.Taxonomy(token, tags, input, publications, ct)));
        }
        app.MapCommandGet(WireRoutes.AdminArticleInventory, (HttpContext ctx, CancellationToken ct) =>
        {
            ctx.Response.Headers.CacheControl = "no-store";
            return gate.WithSession(actions.Session(ctx), (db, tx, _) => ArticleInventoryEndpoints.ReadPage(ctx, db, tx, null, ct), ct);
        });
        app.MapCommandPost(WireRoutes.AdminArticleDelete, async (HttpContext ctx, int id, Publications publications, CancellationToken ct) =>
        {
            actions.RequireOrigin(ctx);
            if (id <= 0) throw new BusinessException(Rejection.Invalid, "Invalid article ID.");
            return Frame(await publications.AdministrativePublication(inv => trashRestore.DeleteArticle(actions.Session(ctx), id, inv, ct), ct));
        });
        app.MapCommandPost(WireRoutes.AdminSignOut, async (HttpContext ctx, CancellationToken ct) =>
        {
            await gate.SignOut(actions.Session(ctx), ct);
            ctx.Response.Cookies.Delete(session, Cookie("/"));
            return ServerHttp.EmptyFrame();
        });

        CookieOptions Cookie(string path) => new() { HttpOnly = true, Secure = secure, SameSite = SameSiteMode.Strict, Path = secure ? "/" : path };
        CookieOptions Ceremony(string path) { var o = Cookie(path); o.MaxAge = TimeSpan.FromMinutes(2); return o; }
    }

    private static string? BootstrapToken(HttpContext ctx) =>
        ctx.Request.Headers[WireHeaders.AdminBootstrapToken] is { Count: 1 } value ? value[0] : null;
}
