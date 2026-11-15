using System.Buffers.Binary;
using System.Globalization;
using System.Net;
using System.Threading.RateLimiting;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Administration;
using FsusBlog.V2.Server.Analytics;
using FsusBlog.V2.Server.Authoring;
using FsusBlog.V2.Server.Communication;
using FsusBlog.V2.Server.Content;
using FsusBlog.V2.Server.Operations;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.FileProviders;
using Npgsql;

const string Cookie = "fsus-v2-session";
const string Binary = "application/octet-stream";
const string Html = "text/html; charset=utf-8";
var builder = WebApplication.CreateBuilder(args);
var trustLoopbackProxy = LoopbackProxy.ReadConfiguration(builder.Configuration);
var adminIdentity = FsusBlog.V2.Server.Administration.AdminIdentityEndpoints.ReadConfiguration(builder.Configuration);
var adminInboxLive = adminIdentity is not null && builder.Configuration.GetValue(AdminInboxEndpoints.LiveSetting, false);
var adminArticleRollback = builder.Configuration.GetValue(
    FsusBlog.V2.Server.Administration.AdminArticleRollbackEndpoints.Setting, false);
if (adminArticleRollback && adminIdentity?.Origin.Scheme != Uri.UriSchemeHttps)
    throw new InvalidOperationException("Published article rollback requires a dedicated HTTPS administrator origin.");
var adminTagMetadata = builder.Configuration.GetValue(FsusBlog.V2.Server.Administration.AdminTagMetadataEndpoints.Setting, false);
if (adminTagMetadata && adminIdentity?.Origin.Scheme != Uri.UriSchemeHttps)
    throw new InvalidOperationException("Tag metadata editing requires a dedicated HTTPS administrator origin.");
var sitePageEditor = builder.Configuration.GetValue(SitePages.EditorSetting, false);
var recoveryKey = FsusBlog.V2.Server.Passkeys.RecoveryKeySecret.Read(builder.Configuration);
var persistentSite = FsusBlog.V2.Server.Passkeys.SiteRefreshStore.ReadConfiguration(builder.Configuration);
var subscription = SubscriptionIdentity.Read(builder.Configuration[SubscriptionIdentity.KeySetting]);
var evidenceDirectory = builder.Configuration["FSUSBLOG_RUNTIME_EVIDENCE_CONTROL"];
var wideSearchCorpus = builder.Configuration.GetValue(WideSearchCorpusEndpoints.Setting, false);
var connectionString = builder.Configuration["FSUSBLOG_DB"] ?? throw new InvalidOperationException("FSUSBLOG_DB is required.");
var integrityKeys = new IntegrityKeys(builder.Configuration);
var dist = Path.GetFullPath(builder.Configuration["FSUSBLOG_WEB_DIST"] ?? "src/Web/dist");
var template = await File.ReadAllTextAsync(Path.Combine(dist, "index.html"));
if (!template.Contains("<!--fsus-public-content-->", StringComparison.Ordinal))
    throw new InvalidOperationException("The v2 web build is missing the public content slot.");
var onlineAppearance = builder.Configuration.GetValue(AppearanceAssets.OnlineSetting, false);
var appearance = AppearanceAssets.Load(builder.Configuration[AppearanceAssets.RootSetting],
    dist, builder.Configuration[MediaEndpoints.StorageSetting], onlineAppearance);

builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = WireLimits.MaxCommandFrameBytes);
builder.Services.AddSingleton(NpgsqlDataSource.Create(connectionString));
builder.Services.AddSingleton(services => new InstanceLease(connectionString, services.GetService<RuntimeEvidence>()));
if (!string.IsNullOrEmpty(evidenceDirectory))
{
    var output = builder.Configuration["FSUSBLOG_RUNTIME_EVIDENCE_OUTPUT"] ??
        throw new InvalidOperationException("Runtime evidence output is required.");
    builder.Services.AddHttpContextAccessor();
    var slowRequests = builder.Configuration.GetValue("FSUSBLOG_RUNTIME_SLOW_REQUESTS", false);
    builder.Services.AddSingleton(services => new RuntimeEvidence(evidenceDirectory, output,
        services.GetRequiredService<IHttpContextAccessor>(), slowRequests));
}
var publicSite = FsusBlog.V2.Server.Content.PublicSiteConfiguration.Read(builder.Configuration);
var pdfExport = FsusBlog.V2.Server.Authoring.PdfDocumentExport.Read(builder.Configuration);
if (pdfExport is not null)
    template = template.Replace("</head>", FsusBlog.V2.Server.Authoring.PdfDocumentExport.PageMarker + "</head>", StringComparison.Ordinal);
if (builder.Configuration.GetValue(PublicHotArticles.Setting, false))
{
    template = template.Replace("</head>", PublicHotArticles.PageMarker + "</head>", StringComparison.Ordinal);
    builder.Services.AddSingleton<PublicHotArticles>();
    builder.Services.AddHostedService(services => services.GetRequiredService<PublicHotArticles>());
}
var articleReadEnabled = builder.Configuration.GetValue(ArticleReadEndpoints.Setting, false);
if (articleReadEnabled)
{
    if (publicSite.Origin is null)
        throw new InvalidOperationException("Article read proof requires an explicit public HTTPS origin.");
    template = template.Replace("</head>", ArticleReadEndpoints.PageMarker + "</head>", StringComparison.Ordinal);
    builder.Services.AddSingleton(services => new ArticleReadAuthority(connectionString,
        services.GetRequiredService<InstanceLease>(), TimeProvider.System));
}
using var proofKeys = PublicationProofKeys.Read(builder.Configuration, integrityKeys, publicSite.Origin, dist);
var checkpointArchive = PublicationCheckpointArchive.Read(builder.Configuration, integrityKeys, publicSite.Origin, dist, TimeProvider.System);
if (proofKeys is not null)
{
    builder.Services.AddSingleton(proofKeys);
    builder.Services.AddSingleton<PublicationProofs>();
    builder.Services.AddHostedService(services => services.GetRequiredService<PublicationProofs>());
}
if (onlineAppearance && (adminIdentity?.Origin.Scheme != Uri.UriSchemeHttps || publicSite.Origin is null ||
    Uri.Compare(adminIdentity.Origin, new Uri(publicSite.Origin), UriComponents.SchemeAndServer, UriFormat.SafeUnescaped,
        StringComparison.OrdinalIgnoreCase) == 0))
    throw new InvalidOperationException("Online appearance requires independent HTTPS administrator and public origins.");
if (appearance is not null) builder.Services.AddSingleton(appearance);
if (sitePageEditor && (adminIdentity?.Origin.Scheme != Uri.UriSchemeHttps || publicSite.Origin is null))
    throw new InvalidOperationException("The site page editor requires independent HTTPS administrator and public origins.");
if (subscription is not null && publicSite.Origin is null)
    throw new InvalidOperationException("Subscription preferences require an explicit public HTTPS origin.");
builder.Services.AddSingleton(new WebPages(template, publicSite, appearance));
builder.Services.AddSingleton(services => new FsusBlog.V2.Server.Content.SitePages(builder.Configuration,
    services.GetRequiredService<WebPages>(), services.GetRequiredService<NpgsqlDataSource>(),
    services.GetRequiredService<InstanceLease>(), sitePageEditor));
builder.Services.AddSingleton(services => new FsusBlog.V2.Server.Content.DistributionSettings(publicSite,
    services.GetRequiredService<FsusBlog.V2.Server.Content.SitePages>().ConfiguredPaths));
builder.Services.AddSingleton<Store>();
builder.Services.AddSingleton<PublicProjection>();
builder.Services.AddSingleton<Publications>();
if (wideSearchCorpus)
{
    builder.Services.AddSingleton<WideSearchCorpusSignal>();
    builder.Services.AddHostedService<WideSearchCorpusWorker>();
}
builder.Services.AddSingleton(services => new InboxWake(connectionString, services.GetRequiredService<ILogger<InboxWake>>()));
builder.Services.AddHostedService(services => services.GetRequiredService<InboxWake>());
builder.Services.AddSingleton<FsusBlog.V2.Server.Comments.CommentReadStore>();
builder.Services.AddSingleton(_ => new FsusBlog.V2.Server.Security.ScopedPow(TimeProvider.System));
if (builder.Configuration[FsusBlog.V2.Server.Content.MediaEndpoints.StorageSetting] is { Length: > 0 } mediaRoot)
{
    builder.Services.AddSingleton(_ => new FsusBlog.V2.Server.Content.MediaFiles(mediaRoot, dist));
    builder.Services.AddSingleton<FsusBlog.V2.Server.Content.MediaStore>();
}
var publicMediaEnabled = PublishedMediaEndpoints.Configure(builder, dist, trustLoopbackProxy);
builder.Services.AddHostedService<OutboxWorker>();
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = 429;
    options.OnRejected = async (context, ct) =>
    {
        if (context.HttpContext.GetEndpoint()?.Metadata.GetMetadata<FsusBlog.V2.Server.Content.MediaEndpoints.PrivateRead>() is not null)
            FsusBlog.V2.Server.Content.MediaEndpoints.SetHidden(context.HttpContext.Response);
        else if (publicMediaEnabled && context.HttpContext.Request.Path.StartsWithSegments(PublishedMediaEndpoints.PathPrefix))
            PublishedMediaEndpoints.SetHeaders(context.HttpContext.Response);
        else await Error(context.HttpContext, 429, "Rate limit reached.").ExecuteAsync(context.HttpContext);
    };
    options.AddPolicy("sign-in", context => RateLimitPartition.GetFixedWindowLimiter(
        context.Connection.RemoteIpAddress, _ => new FixedWindowRateLimiterOptions { PermitLimit = 12, Window = TimeSpan.FromMinutes(1) }));
    options.AddPolicy("mfa", context => RateLimitPartition.GetFixedWindowLimiter(
        (context.Connection.RemoteIpAddress, (context.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText),
        _ => new FixedWindowRateLimiterOptions { PermitLimit = 8, Window = TimeSpan.FromMinutes(1) }));
    options.AddConcurrencyLimiter("command", limiter => { limiter.PermitLimit = 32; limiter.QueueLimit = 0; });
    if (pdfExport is not null)
        options.AddConcurrencyLimiter(FsusBlog.V2.Server.Authoring.PdfDocumentExport.RatePolicy,
            limiter => { limiter.PermitLimit = 1; limiter.QueueLimit = 0; });
    options.AddPolicy("comment-author-challenge", context => RateLimitPartition.GetFixedWindowLimiter(
        context.Connection.RemoteIpAddress, _ => new FixedWindowRateLimiterOptions { PermitLimit = 24, Window = TimeSpan.FromMinutes(1) }));
    if (proofKeys is not null || checkpointArchive is not null)
        options.AddConcurrencyLimiter("publication-proof", limiter => { limiter.PermitLimit = 4; limiter.QueueLimit = 0; });
    if (articleReadEnabled) ArticleReadEndpoints.AddRateLimit(options);
    options.AddConcurrencyLimiter("query", limiter => { limiter.PermitLimit = 32; limiter.QueueLimit = 0; });
    if (wideSearchCorpus)
    {
        options.AddConcurrencyLimiter(WideSearchCorpusEndpoints.ManifestPolicy, limiter => { limiter.PermitLimit = 8; limiter.QueueLimit = 0; });
        options.AddConcurrencyLimiter(WideSearchCorpusEndpoints.PagePolicy, limiter => { limiter.PermitLimit = 2; limiter.QueueLimit = 0; });
    }
    options.AddConcurrencyLimiter("inbox-stream", limiter => { limiter.PermitLimit = 32; limiter.QueueLimit = 0; });
    if (adminInboxLive)
        options.AddConcurrencyLimiter(AdminInboxEndpoints.LivePolicy, limiter => { limiter.PermitLimit = 4; limiter.QueueLimit = 0; });
    FsusBlog.V2.Server.Administration.AdminIdentityEndpoints.AddRateLimits(options);
    FsusBlog.V2.Server.Content.MediaEndpoints.AddRateLimits(options);
    if (publicMediaEnabled) PublishedMediaEndpoints.AddRateLimit(options);
    if (subscription is not null) SubscriptionEndpoints.AddRateLimits(options);
});

await using var app = builder.Build();
if (app.Services.GetService<RuntimeEvidence>() is { } runtimeEvidence)
{
    app.Use(async (ctx, next) =>
    {
        var sample = runtimeEvidence.SampleObserverCost();
        var started = sample ? System.Diagnostics.Stopwatch.GetTimestamp() : 0;
        var category = RuntimeEvidence.Classify(ctx);
        var before = sample ? System.Diagnostics.Stopwatch.GetTimestamp() - started : 0;
        var requestStarted = runtimeEvidence.SlowRequestStart(category);
        try { await next(ctx); }
        finally
        {
            if (sample) started = System.Diagnostics.Stopwatch.GetTimestamp();
            runtimeEvidence.CountRequest(ctx, category, requestStarted);
            if (sample) runtimeEvidence.AccountObserverSample(before + System.Diagnostics.Stopwatch.GetTimestamp() - started);
        }
    });
}
var lease = app.Services.GetRequiredService<InstanceLease>();
using var stopLease = app.Lifetime.ApplicationStopping.Register(lease.Stop);
await lease.Start(app.Logger, app.Lifetime.ApplicationStopping, requireSubscription: subscription is null ? null : true,
    requireRecoveryKey: recoveryKey is null ? null : true,
    requireAdminInboxStatus: adminIdentity is not null && app.Configuration.GetValue(FsusBlog.V2.Server.Administration.AdminInboxEndpoints.StatusSetting, false) ? true : null,
    requireAdminInboxNotice: adminIdentity is not null && app.Configuration.GetValue(FsusBlog.V2.Server.Administration.AdminInboxEndpoints.NoticeSetting, false) ? true : null,
    requireAdminInboxRead: adminIdentity is not null && app.Configuration.GetValue(FsusBlog.V2.Server.Administration.AdminInboxEndpoints.SharedReadSetting, false) ? true : null,
    requireAdminInboxReply: adminIdentity is not null && app.Configuration.GetValue(FsusBlog.V2.Server.Administration.AdminInboxEndpoints.ReplySetting, false) ? true : null, requireSiteRefresh: persistentSite ? true : null, requireSitePageEditor: sitePageEditor ? true : null,
    requireAdminArticleRollback: adminArticleRollback ? true : null, requireAppearanceActivation: onlineAppearance ? true : null,
    requireAdminTagMetadata: adminTagMetadata ? true : null, requirePublicationMedia: publicMediaEnabled ? true : null);
var publishedMedia = app.Services.GetService<PublishedMediaStore>();
var publications = app.Services.GetRequiredService<Publications>();
var publicationProofs = app.Services.GetService<PublicationProofs>();
if (publicationProofs is not null) await publicationProofs.Initialize(app.Lifetime.ApplicationStopping);
app.Logger.LogInformation("Building initial public projection from current PostgreSQL schema.");
await publications.Refresh(CancellationToken.None);

app.Use(async (ctx, next) =>
{
    if ((publicationProofs is not null && PublicationProofs.IsRoute(ctx.Request.Path)) ||
        ctx.Request.Path.StartsWithSegments(PublicationCheckpointArchive.Prefix)) NoStore(ctx);
    ctx.Response.Headers.XContentTypeOptions = "nosniff";
    ctx.Response.Headers["Referrer-Policy"] = "same-origin";
    var imageRequest = publicMediaEnabled && ctx.Request.Path.StartsWithSegments(PublishedMediaEndpoints.PathPrefix);
    if (imageRequest) PublishedMediaEndpoints.SetHeaders(ctx.Response);
    ctx.Response.Headers.ContentSecurityPolicy = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob: https:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
    try
    {
        if (trustLoopbackProxy)
        {
            if (!LoopbackProxy.IsTrustedPeer(ctx.Connection.RemoteIpAddress))
                throw new BusinessException(Rejection.Forbidden, "A local reverse proxy is required.");
            if (!LoopbackProxy.TryApply(ctx))
                throw new BusinessException(Rejection.Invalid, "Invalid forwarding headers.");
            if (!ctx.Request.IsHttps)
                throw new BusinessException(Rejection.Forbidden, "Secure transport is required.");
        }
        if (!lease.IsCurrent)
        {
            NoStore(ctx);
            throw new PublicUnavailableException();
        }
        if (!FsusBlog.V2.Server.Administration.AdminIdentityEndpoints.IsAllowed(ctx, adminIdentity))
        {
            NoStore(ctx);
            throw new BusinessException(Rejection.NotFound, "This route is unavailable on the current origin.");
        }
        if (imageRequest && !HttpMethods.IsGet(ctx.Request.Method) && !HttpMethods.IsHead(ctx.Request.Method))
        {
            ctx.Response.Headers.Allow = "GET, HEAD";
            ctx.Response.StatusCode = StatusCodes.Status405MethodNotAllowed;
            return;
        }
        if (ctx.Request.Path.StartsWithSegments("/api"))
        {
            ctx.Response.Headers[WireHeaders.TraceId] = ctx.TraceIdentifier;
            ctx.Response.Headers.CacheControl = "no-store";
            if (HttpMethods.IsPost(ctx.Request.Method)) VerifyMutation(ctx);
        }
        await next();
    }
    catch (OperationCanceledException) when (ctx.RequestAborted.IsCancellationRequested) { }
    catch (Exception ex) when (!ctx.Response.HasStarted)
    {
        if (ctx.GetEndpoint()?.Metadata.GetMetadata<FsusBlog.V2.Server.Content.MediaEndpoints.PrivateRead>() is not null)
        {
            FsusBlog.V2.Server.Content.MediaEndpoints.SetHidden(ctx.Response);
            return;
        }
        var (status, message) = ex switch
        {
            BusinessException err => (err.Rejection switch
            {
                Rejection.Invalid => 400, Rejection.Unauthorized => 401, Rejection.Forbidden => 403,
                Rejection.NotFound => 404, Rejection.Conflict => 409, _ => 500
            }, err.Message),
            PublicListFailure err => (err.Status, err.Message),
            AuthorHeadingBudgetException => (422, "A saved article exceeds the heading parser's work limit."),
            ProtocolException => (400, "Invalid AEDS payload."),
            BadHttpRequestException bad => (bad.StatusCode, "Invalid HTTP request."),
            PublicUnavailableException or NpgsqlException => (503, "This operation is temporarily unavailable."),
            _ => (500, "An internal error occurred.")
        };
        if (status >= 500 && (ex is not PublicUnavailableException || lease.IsCurrent))
            app.Logger.LogError(ex, "Request {TraceId} failed", ctx.TraceIdentifier);
        var result = ctx.Request.Path.StartsWithSegments("/api")
            ? Error(ctx, status, message, (ex as PublicListFailure)?.Details) : Results.Text(message, "text/plain; charset=utf-8", statusCode: status);
        await result.ExecuteAsync(ctx);
    }
});

foreach (var asset in new[] { "assets", "dist" })
{
    var assetDir = Path.Combine(dist, asset);
    if (Directory.Exists(assetDir))
        app.UseStaticFiles(new StaticFileOptions { FileProvider = new PhysicalFileProvider(assetDir), RequestPath = "/" + asset });
}
app.UseWhen(ctx => ctx.Request.Path == WireRoutes.InboxStream ||
    adminInboxLive && ctx.GetEndpoint()?.Metadata.GetMetadata<AdminInboxEndpoints.LiveSocket>() is not null,
    branch => branch.UseWebSockets(new WebSocketOptions
{
    KeepAliveInterval = TimeSpan.FromSeconds(20), KeepAliveTimeout = TimeSpan.FromSeconds(10)
}));
app.UseRateLimiter();
appearance?.Map(app);
FsusBlog.V2.Server.Passkeys.PasskeyEndpoints.Map(app, Cookie, ReadFrame, recoveryKey, persistentSite);
FsusBlog.V2.Server.Sessions.SiteSessionEndpoints.Map(app, Cookie, persistentSite);
FsusBlog.V2.Server.Communication.InboxEndpoints.Map(app, Cookie, ReadFrame);
InboxStreamEndpoints.Map(app, Cookie);
if (app.Services.GetService<FsusBlog.V2.Server.Content.MediaStore>() is not null)
    FsusBlog.V2.Server.Content.MediaEndpoints.Map(app, Cookie, publicMediaEnabled);
if (publishedMedia is not null)
    PublishedMediaEndpoints.Map(app, Cookie, publications, publishedMedia, ReadFrame);
FsusBlog.V2.Server.Content.TaxonomyEndpoints.Map(app, Snapshot, RequireCurrentSnapshot, Query, ReadListCursor, Cookie, ReadFrame);
app.Services.GetRequiredService<FsusBlog.V2.Server.Content.SitePages>().Map(app);
integrityKeys.Map(app);
publicationProofs?.Map(app);
checkpointArchive?.Map(app);
publicSite.Map(app);
if (subscription is not null) SubscriptionEndpoints.Map(app, subscription, publicSite.Origin!, ReadFrame);
if (articleReadEnabled) ArticleReadEndpoints.Map(app, publicSite.Origin!, publications, ReadFrame);
FsusBlog.V2.Server.Content.DistributionEndpoints.Map(app, publications,
    app.Services.GetRequiredService<FsusBlog.V2.Server.Content.DistributionSettings>());
FsusBlog.V2.Server.Authoring.CanvasEndpoints.Map(app, Cookie, ReadFrame);
FsusBlog.V2.Server.Authoring.PropertyEndpoints.Map(app, Cookie, ReadFrame, Query);
FsusBlog.V2.Server.Authoring.AuthorTextSearchEndpoints.Map(app, Cookie, ReadFrame);
FsusBlog.V2.Server.Authoring.ArticleSummaryEndpoints.Map(app, Cookie, ReadFrame);
FsusBlog.V2.Server.Authoring.SavedViewEndpoints.Map(app, Cookie, ReadFrame, Query);
FsusBlog.V2.Server.Authoring.RecoveryScopeEndpoints.Map(app, Cookie);
FsusBlog.V2.Server.Authoring.AuthoringWorkspaceEndpoints.Map(app, Cookie, ReadFrame);
FsusBlog.V2.Server.Authoring.AuthorRecentOpenEndpoints.Map(app, Cookie, ReadFrame, Query);
FsusBlog.V2.Server.Authoring.RevisionHistoryEndpoints.Map(app, Cookie, Query, ReadFrame);
FsusBlog.V2.Server.Authoring.PublicationRightsEndpoints.Map(app, Cookie, Query, ReadFrame);
FsusBlog.V2.Server.Authoring.ArticleInventoryEndpoints.Map(app, Cookie, Query);
FsusBlog.V2.Server.Authoring.ArticleScheduleEndpoints.Map(app, Cookie, Query, ReadFrame);
FsusBlog.V2.Server.Authoring.MarkdownExportEndpoints.Map(app, Cookie, Query, pdfExport);
var commentRoutes = FsusBlog.V2.Server.Comments.CommentReadEndpoints.Map(app, publications, Cookie, ReadFrame,
    lease.RootCommentPowPolicyInstalled);
FsusBlog.V2.Server.Administration.AdminIdentityEndpoints.Map(app, adminIdentity, ReadFrame, commentRoutes, trustLoopbackProxy);
FsusBlog.V2.Server.Comments.CommentAuthorDeleteEndpoints.Map(app, Cookie, ReadFrame);

app.MapGet(WireRoutes.PublicList, (HttpContext ctx, int page, int size) => PublicList(ctx, "home", page, size)).RequireRateLimiting("query");
app.MapGet(WireRoutes.PublicArchive, (HttpContext ctx, int page, int size) => PublicList(ctx, "archive", page, size)).RequireRateLimiting("query");
app.MapGet(WireRoutes.PublicArticle, (HttpContext ctx, int id) => PublicDetail(ctx, id, asHtml: false));
app.MapGet(WireRoutes.PublicRelatedReading, (HttpContext ctx, int articleId) =>
{
    var snapshot = Snapshot(ctx);
    var article = snapshot.Article(articleId);
    if (article is null) return Error(ctx, 404, "Article not found.", "article_not_found");
    var publication = Query(ctx, "publication", 19);
    if (publication is not null && publication != article.Publication.ToString(CultureInfo.InvariantCulture))
        return Error(ctx, 409, "The article changed. Reload its latest publication.", "article_publication_changed");
    var frame = snapshot.RelatedReading.Read(articleId, ctx.RequestAborted);
    RequireCurrentSnapshot(ctx, snapshot);
    return frame is null ? Error(ctx, 404, "Article not found.", "article_not_found") : Results.Bytes(frame, Binary);
}).RequireRateLimiting("query");
app.MapGet(WireRoutes.PublicSearch, (HttpContext ctx) =>
{
    var keyword = Query(ctx, "q", 256)?.Trim();
    if (string.IsNullOrEmpty(keyword)) return Error(ctx, 400, "A search term is required.");
    var snapshot = Snapshot(ctx);
    var bytes = snapshot.Search(keyword, ctx.RequestAborted);
    RequireCurrentSnapshot(ctx, snapshot);
    return bytes is null ? Error(ctx, 503, "The article search projection is unavailable.") : Results.Bytes(bytes, Binary);
}).RequireRateLimiting("query");
if (wideSearchCorpus) WideSearchCorpusEndpoints.Map(app, app.Services.GetRequiredService<PublicProjection>(), lease);
if (app.Services.GetService<PublicHotArticles>() is { } hotArticles)
{
    app.MapMethods(WireRoutes.PublicArticleHot, [HttpMethods.Get, HttpMethods.Head], (HttpContext ctx, string size) =>
    {
        if (size.Length > 9 || !int.TryParse(size, NumberStyles.None, CultureInfo.InvariantCulture, out var count) ||
            count is < 1 or > WireLimits.PublicArticleHotMaxSize)
            return Error(ctx, 404, "Public article ranking size is unavailable.");
        var snapshot = Snapshot(ctx);
        var head = HttpMethods.IsHead(ctx.Request.Method);
        var generation = Query(ctx, "generation", 20);
        if (head && generation is null) return Error(ctx, 400, "A publication generation is required.");
        if (generation is not null && generation != snapshot.GenerationHeader)
            return Error(ctx, 409, "The public articles changed. Reload the ranking.");
        var ranking = hotArticles.Read(snapshot, count) ?? throw new PublicUnavailableException();
        RequireCurrentSnapshot(ctx, snapshot);
        ctx.Response.Headers.ETag = ranking.Tag;
        return head ? Results.NoContent() : Results.Bytes(ranking.Bytes, Binary);
    });
}
app.MapGet(WireRoutes.PublicIndex, (HttpContext ctx) =>
{
    var snapshot = Snapshot(ctx);
    var page = Query(ctx, "page", 10);
    var generation = Query(ctx, "generation", 20);
    if (generation is not null && generation != snapshot.GenerationHeader)
        return Error(ctx, 409, "The search index changed. Reload it from page 1.");
    if (page is not null && (!int.TryParse(page, NumberStyles.None, CultureInfo.InvariantCulture, out var value) || (value > 1 && generation is null)))
        return Error(ctx, 400, "Invalid search index page or missing generation.");
    RequireCurrentSnapshot(ctx, snapshot);
    ctx.Response.Headers[WireHeaders.SearchIndexPages] = snapshot.IndexPageCount.ToString(CultureInfo.InvariantCulture);
    return snapshot.Index(page is null ? 1 : int.Parse(page, CultureInfo.InvariantCulture)) is { } index
        ? Results.Bytes(index, Binary) : Error(ctx, 404, "Index page not found.");
});
app.MapMethods(WireRoutes.PublicSearchCorpus, [HttpMethods.Get, HttpMethods.Head], (HttpContext ctx) =>
{
    var snapshot = Snapshot(ctx);
    var generation = Query(ctx, "generation", 20);
    var pageText = Query(ctx, "page", 10);
    var page = 1;
    if (pageText is not null && (!int.TryParse(pageText, NumberStyles.None, CultureInfo.InvariantCulture, out page) || page < 1))
        return Error(ctx, 400, "Invalid search corpus page.");
    var head = HttpMethods.IsHead(ctx.Request.Method);
    if ((head || page > 1) && generation is null)
        return Error(ctx, 400, "A search generation is required.");
    if (generation is not null && generation != snapshot.GenerationHeader)
        return Error(ctx, 409, "The search corpus changed. Reload it from page 1.");
    if (snapshot.CorpusPageCount == 0)
        return Error(ctx, 503, "The search corpus is unavailable.");
    RequireCurrentSnapshot(ctx, snapshot);
    ctx.Response.Headers[WireHeaders.SearchIndexPages] = snapshot.CorpusPageCount.ToString(CultureInfo.InvariantCulture);
    if (head) return Results.NoContent();
    if (page > 1 && ctx.Request.Headers.Accept.ToString() == SearchCorpusPatch.Accept &&
        Query(ctx, "baseGeneration", 19) is { } baseGeneration && ctx.Request.Headers.IfNoneMatch is { Count: 1 } validators &&
        snapshot.CorpusPatch(page, baseGeneration, validators[0]) is { } patch)
        return new CurrentSearchCorpusPatch(snapshot, publications, snapshot.CorpusTag(page).Tag.ToString()[1..^1], patch);
    return snapshot.Corpus(page) is { } bytes ? Results.Bytes(bytes, Binary, entityTag: snapshot.CorpusTag(page))
        : Error(ctx, 404, "Search corpus page not found.");
});

app.MapPost(WireRoutes.SignIn, async (HttpContext ctx, Store store, CancellationToken ct) =>
{
    var signIn = Wire.DecodeSignIn(await ReadFrame(ctx, WireLimits.MaxSignInFrameBytes, ct));
    var issued = await store.SignIn(signIn.Ticket, ct);
    ctx.Response.Cookies.Append(Cookie, issued.Token, CookieSettings(ctx, issued.User.ExpiresAt));
    if (persistentSite)
        FsusBlog.V2.Server.Passkeys.SiteRefreshEndpoints.ClearRefreshCookie(ctx);
    return SessionResponse(ctx, issued.User, issued.Token);
}).RequireRateLimiting("sign-in");
app.MapGet(WireRoutes.Session, async (HttpContext ctx, Store store, CancellationToken ct) =>
{
    var token = ctx.Request.Cookies[Cookie];
    return await store.WithSession(token, false, async (db, tx, actor) =>
    {
        if (persistentSite && await FsusBlog.V2.Server.Passkeys.SiteRefreshStore.FindCurrentFamily(db, tx, Store.TokenDigest(token)!, ct) is { } family)
        {
            ctx.Response.Headers[WireHeaders.SiteRefresh] = "persistent";
            ctx.Response.Headers[WireHeaders.SiteSessionContinuity] = FsusBlog.V2.Server.Sessions.SiteSessions.Continuity(actor.Id, family);
        }
        return SessionResponse(ctx, actor, token!);
    }, ct);
});
app.MapPost(WireRoutes.SignOut, async (HttpContext ctx, Store store, CancellationToken ct) =>
{
    await store.SignOut(ctx.Request.Cookies[Cookie], ct);
    ctx.Response.Cookies.Delete(Cookie, CookieSettings(ctx));
    if (persistentSite)
        FsusBlog.V2.Server.Passkeys.SiteRefreshEndpoints.ClearRefreshCookie(ctx);
    return Results.Bytes(Wire.EncodeEmptySuccess(), Binary);
}).RequireRateLimiting("command");
app.MapGet(WireRoutes.Draft, (HttpContext ctx, Store store, int id, CancellationToken ct) =>
{
    var token = ctx.Request.Cookies[Cookie];
    var expected = FsusBlog.V2.Server.Sessions.SiteSessions.Requested(ctx);
    return store.WithSession(token, true, async (db, tx, actor) =>
    {
        FsusBlog.V2.Server.Sessions.SiteSessions.IfCurrent(actor.Id, token, expected);
        return DraftResponse(await Store.Find(db, tx, actor, id, false, ct));
    }, ct);
}).RequireRateLimiting("command");
Mutation(WireRoutes.Save, ArticleAction.Save);
Mutation(WireRoutes.Publish, ArticleAction.Publish);
Mutation(WireRoutes.Retract, ArticleAction.Retract);
Mutation(WireRoutes.Delete, ArticleAction.Delete);
Mutation(WireRoutes.Restore, ArticleAction.Restore);

var webPages = app.Services.GetRequiredService<WebPages>();
var shell = webPages.Page();
var archiveShell = webPages.Page(publicPath: "/archive");
app.MapGet("/", (HttpContext ctx) => PublicResponse.Write(ctx, Snapshot(ctx).Home, Html));
app.MapGet("/article/{id:int}", (HttpContext ctx, int id) => PublicDetail(ctx, id, asHtml: true));
app.MapGet("/archive", (HttpContext ctx) => { NoStore(ctx); return Results.Bytes(archiveShell, Html); });
foreach (var route in new[] { "/user/manage/article/list", "/user/manage/article/trash", "/user/comments" })
    app.MapGet(route, (HttpContext ctx) =>
    {
        NoStore(ctx);
        ctx.Response.Headers["X-Robots-Tag"] = "noindex, nofollow";
        return Results.Bytes(shell, Html);
    });
foreach (var route in new[] { "/search", "/login", "/user/identity/mfa", "/user/messagebox",
    "/user/manage/assets", "/user/manage/article/write", "/user/manage/article/workspace", "/user/manage/article/edit/{id:int}" })
    app.MapGet(route, (HttpContext ctx) => { NoStore(ctx); return Results.Bytes(shell, Html); });
foreach (var route in new[] { "/user/manage/canvas", "/user/manage/canvas/{id:guid}" })
    app.MapGet(route, (HttpContext ctx) =>
    {
        NoStore(ctx);
        ctx.Response.Headers["X-Robots-Tag"] = "noindex, nofollow";
        return Results.Bytes(shell, Html);
    });
app.MapGet("/health/ready", (HttpContext ctx) => { NoStore(ctx); return Results.StatusCode(publications.Snapshot is null ? 503 : 204); });
app.MapFallback("/api/{**rest}", ctx => Error(ctx, 404, "Unknown API route.").ExecuteAsync(ctx));
await app.RunAsync();

Task PublicList(HttpContext ctx, string scope, int page, int size)
{
    var snapshot = Snapshot(ctx);
    var bytes = snapshot.List(scope, page, size, Query(ctx, "keyword", 256), Query(ctx, "sort", 20),
        ReadListCursor(ctx), ctx.RequestAborted);
    RequireCurrentSnapshot(ctx, snapshot);
    return PublicResponse.Write(ctx, bytes, Binary);
}

async Task PublicDetail(HttpContext ctx, int id, bool asHtml)
{
    var snapshot = Snapshot(ctx);
    var article = await snapshot.Detail(id, ctx.RequestAborted);
    RequireCurrentSnapshot(ctx, snapshot);
    if (article is not null)
    {
        if (publicMediaEnabled && snapshot.HasPublishedImages(id))
            ctx.Response.Headers[WireHeaders.PublicArticleMediaPresent] = "1";
        await PublicResponse.Write(ctx, asHtml ? article.Html : article.Wire, asHtml ? Html : Binary);
        return;
    }
    var missing = asHtml ? Results.Text("文章不存在", "text/plain; charset=utf-8", statusCode: 404) : Error(ctx, 404, "Article not found.");
    await missing.ExecuteAsync(ctx);
}

static string? ReadListCursor(HttpContext ctx)
{
    if (!ctx.Request.Query.TryGetValue("cursor", out var values)) return null;
    if (values.Count != 1 || values[0] is not { Length: > 0 and <= WireLayouts.ArticleListCursorMaxBytes } value)
        throw PublicListFailure.InvalidCursor();
    return value;
}

void Mutation(string path, ArticleAction action)
{
    app.MapPost(path, async (HttpContext ctx, Store store, CancellationToken ct) =>
    {
        var frame = await ReadFrame(ctx, action == ArticleAction.Save ? WireLimits.MaxArticleBodyInsertionCommandFrameBytes :
            WireLimits.MaxCommandFrameBytes, ct);
        var insertion = action == ArticleAction.Save && frame.Length >= WireHeader.HeaderSize &&
            BinaryPrimitives.ReadUInt16LittleEndian(frame.AsSpan(WireHeader.TypeOffset)) == (ushort)FrameType.ArticleBodyInsertionCommand
            ? Wire.DecodeArticleBodyInsertionCommand(frame) : null;
        var input = insertion is null ? Wire.DecodeArticleCommand(frame) :
            new ArticleCommand(insertion.Id, insertion.ExpectedRevision, insertion.IdempotencyKey, insertion.Title, insertion.Body);
        if (ctx.Request.Headers.TryGetValue(WireHeaders.ClientMutationId, out var header) &&
            (header.Count != 1 || !Guid.TryParseExact(header[0], "D", out var id) || id != input.IdempotencyKey))
            return Error(ctx, 400, "Command key does not match its request header.");
        var edit = Publishing.Validate(action, new(input.Id, input.ExpectedRevision, input.IdempotencyKey, input.Title, input.Body));
        var result = await publications.Command(store, ctx.Request.Cookies[Cookie], action, edit, ct,
            FsusBlog.V2.Server.Sessions.SiteSessions.Requested(ctx), insertion);
        return action == ArticleAction.Delete ? Results.Bytes(Wire.EncodeEmptySuccess(), Binary) : DraftResponse(result.Article);
    }).RequireRateLimiting("command");
}

PublicSnapshot Snapshot(HttpContext ctx)
{
    NoStore(ctx);
    var snapshot = publications.Snapshot ?? throw new PublicUnavailableException();
    ctx.Response.Headers[WireHeaders.SearchIndexGeneration] = snapshot.GenerationHeader;
    return snapshot;
}

void RequireCurrentSnapshot(HttpContext ctx, PublicSnapshot snapshot)
{
    if (ReferenceEquals(snapshot, publications.Snapshot)) return;
    ctx.Response.Headers.Remove(WireHeaders.SearchIndexGeneration);
    throw new PublicUnavailableException();
}

static string? Query(HttpContext ctx, string name, int limit)
{
    if (!ctx.Request.Query.TryGetValue(name, out var value)) return null;
    if (value.Count != 1 || value[0] is not { } text || text.Length > limit)
        throw new BusinessException(Rejection.Invalid, "Invalid query parameter.");
    return text;
}

static void VerifyMutation(HttpContext ctx)
{
    if (!ctx.Request.IsHttps && (ctx.Connection.RemoteIpAddress is not { } peer || !IPAddress.IsLoopback(peer)))
        throw new BusinessException(Rejection.Forbidden, "Secure transport is required.");
    var origin = ctx.Request.Headers.Origin;
    var expected = $"{ctx.Request.Scheme}://{ctx.Request.Host}";
    if (origin.Count > 0 && (origin.Count != 1 || !string.Equals(origin[0], expected, StringComparison.OrdinalIgnoreCase)))
        throw new BusinessException(Rejection.Forbidden, "Cross-origin requests are denied.");
    if (ctx.Request.Headers.TryGetValue("Sec-Fetch-Site", out var site) && site.ToString() != "same-origin")
        throw new BusinessException(Rejection.Forbidden, "Cross-origin requests are denied.");
}

static async Task<byte[]> ReadFrame(HttpContext ctx, int maximum, CancellationToken ct)
{
    if (!string.Equals(ctx.Request.ContentType, Binary, StringComparison.OrdinalIgnoreCase))
        throw new BadHttpRequestException("Expected AEDS.", 415);
    if (ctx.Request.ContentLength > maximum) throw new BadHttpRequestException("Request too large.", 413);
    var localLimit = ctx.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpMaxRequestBodySizeFeature>();
    if (localLimit is { IsReadOnly: false }) localLimit.MaxRequestBodySize = maximum;
    using var memory = new MemoryStream();
    await ctx.Request.Body.CopyToAsync(memory, ct);
    return memory.ToArray();
}

static CookieOptions CookieSettings(HttpContext ctx, DateTimeOffset? expiresAt = null) => new()
{
    HttpOnly = true, Secure = ctx.Request.IsHttps, SameSite = SameSiteMode.Strict, Path = "/", Expires = expiresAt
};

static IResult SessionResponse(HttpContext ctx, Identity actor, string token)
{
    ctx.Response.Headers[WireHeaders.AccessExpiresAtUtc] = actor.ExpiresAt.UtcDateTime.ToString("O", CultureInfo.InvariantCulture);
    ctx.Response.Headers[WireHeaders.CurrentSession] = FsusBlog.V2.Server.Sessions.SiteSessions.Id(actor.Id, Store.TokenDigest(token)!);
    return Results.Bytes(Wire.EncodeSession(new(actor.Name, actor.Generation, actor.CanAuthor)), Binary);
}

static IResult DraftResponse(ArticleState state) =>
    Results.Bytes(Wire.EncodeDraft(new(state.Id, state.Revision, state.Title, state.Body, state.PublishedRevision is not null)), Binary);

static void NoStore(HttpContext ctx) => ctx.Response.Headers.CacheControl = "no-store";
static IResult Error(HttpContext ctx, int status, string message, string? details = null)
{
    NoStore(ctx);
    return new AedsError(status, Wire.EncodeError(status, message, details, ctx.TraceIdentifier));
}

internal sealed record AedsError(int Status, byte[] Packet) : IResult
{
    public async Task ExecuteAsync(HttpContext ctx)
    {
        ctx.Response.StatusCode = Status;
        ctx.Response.ContentType = "application/octet-stream";
        ctx.Response.ContentLength = Packet.Length;
        await ctx.Response.Body.WriteAsync(Packet, ctx.RequestAborted);
    }
}

file sealed record CurrentSearchCorpusPatch(PublicSnapshot Snapshot, Publications Publications, string TargetDigest, byte[] Bytes) : IResult
{
    public Task ExecuteAsync(HttpContext context)
    {
        if (!ReferenceEquals(Snapshot, Publications.Snapshot))
        {
            context.Response.Headers.Remove(WireHeaders.SearchIndexGeneration);
            throw new PublicUnavailableException();
        }
        // Snapshot sets no-store. The full page's strong ETag never labels this representation.
        context.RequestAborted.ThrowIfCancellationRequested();
        context.Response.Headers[WireHeaders.SearchCorpusTargetDigest] = TargetDigest;
        return Results.Bytes(Bytes, SearchCorpusPatch.ContentType).ExecuteAsync(context);
    }
}
