using System.Globalization;
using System.Net;
using System.Threading.RateLimiting;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Operations;
using FsusBlogV2.Storage;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.FileProviders;
using Npgsql;

const string Cookie = "fsus-v2-session";
const string Binary = "application/octet-stream";
const string Html = "text/html; charset=utf-8";
var builder = WebApplication.CreateBuilder(args);
var trustLoopbackProxy = LoopbackProxy.ReadConfiguration(builder.Configuration);
var connectionString = builder.Configuration["FSUSBLOG_DB"] ?? throw new InvalidOperationException("FSUSBLOG_DB is required.");
var dist = Path.GetFullPath(builder.Configuration["FSUSBLOG_WEB_DIST"] ?? "src/Web/dist");
var template = await File.ReadAllTextAsync(Path.Combine(dist, "index.html"));
if (!template.Contains("<!--fsus-public-content-->", StringComparison.Ordinal))
    throw new InvalidOperationException("The v2 web build is missing the public content slot.");

builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = WireLimits.MaxCommandFrameBytes);
builder.Services.AddSingleton(NpgsqlDataSource.Create(connectionString));
builder.Services.AddSingleton(new WebPages(template));
builder.Services.AddSingleton<Store>();
builder.Services.AddSingleton<Publications>();
builder.Services.AddSingleton<FsusBlog.V2.Server.Comments.CommentReadStore>();
builder.Services.AddHostedService<OutboxWorker>();
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = 429;
    options.OnRejected = async (context, ct) =>
        await Error(context.HttpContext, 429, "Rate limit reached.").ExecuteAsync(context.HttpContext);
    options.AddPolicy("sign-in", context => RateLimitPartition.GetFixedWindowLimiter(
        context.Connection.RemoteIpAddress, _ => new FixedWindowRateLimiterOptions { PermitLimit = 12, Window = TimeSpan.FromMinutes(1) }));
    options.AddConcurrencyLimiter("command", limiter => { limiter.PermitLimit = 32; limiter.QueueLimit = 0; });
    options.AddConcurrencyLimiter("query", limiter => { limiter.PermitLimit = 32; limiter.QueueLimit = 0; });
});

await using var app = builder.Build();
var database = app.Services.GetRequiredService<NpgsqlDataSource>();
await using var lease = await database.OpenConnectionAsync();
await CurrentSchema.VerifyAsync(lease, CancellationToken.None);
await using (var acquire = Store.Sql(lease, null, "select pg_try_advisory_lock($1)", Publications.InstanceLock))
    if (await acquire.ExecuteScalarAsync() is not true) throw new InvalidOperationException("Another v2 server already owns this database.");
var publications = app.Services.GetRequiredService<Publications>();
app.Logger.LogInformation("Building initial public projection from current PostgreSQL schema.");
await publications.Refresh(CancellationToken.None);

app.Use(async (ctx, next) =>
{
    ctx.Response.Headers.XContentTypeOptions = "nosniff";
    ctx.Response.Headers["Referrer-Policy"] = "same-origin";
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
        var (status, message) = ex switch
        {
            BusinessException err => (err.Rejection switch
            {
                Rejection.Invalid => 400, Rejection.Unauthorized => 401, Rejection.Forbidden => 403,
                Rejection.NotFound => 404, Rejection.Conflict => 409, _ => 500
            }, err.Message),
            PublicListFailure err => (err.Status, err.Message),
            ProtocolException => (400, "Invalid AEDS payload."),
            BadHttpRequestException bad => (bad.StatusCode, "Invalid HTTP request."),
            PublicUnavailableException or NpgsqlException => (503, "This operation is temporarily unavailable."),
            _ => (500, "An internal error occurred.")
        };
        if (status >= 500) app.Logger.LogError(ex, "Request {TraceId} failed", ctx.TraceIdentifier);
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
app.UseRateLimiter();
FsusBlog.V2.Server.Passkeys.PasskeyEndpoints.Map(app, Cookie, ReadFrame);
FsusBlog.V2.Server.Communication.InboxEndpoints.Map(app, Cookie, ReadFrame);
FsusBlog.V2.Server.Content.TaxonomyEndpoints.Map(app, Snapshot, Query, ReadListCursor, Cookie, ReadFrame);
FsusBlog.V2.Server.Content.SitePages.Map(app, app.Services.GetRequiredService<WebPages>());
FsusBlog.V2.Server.Authoring.CanvasEndpoints.Map(app, Cookie, ReadFrame);
FsusBlog.V2.Server.Authoring.PropertyEndpoints.Map(app, Cookie, ReadFrame);
FsusBlog.V2.Server.Comments.CommentReadEndpoints.Map(app, publications, Cookie, ReadFrame);

app.MapGet(WireRoutes.PublicList, (HttpContext ctx, int page, int size) => PublicList(ctx, "home", page, size)).RequireRateLimiting("query");
app.MapGet(WireRoutes.PublicArchive, (HttpContext ctx, int page, int size) => PublicList(ctx, "archive", page, size)).RequireRateLimiting("query");
app.MapGet(WireRoutes.PublicArticle, (HttpContext ctx, int id) => PublicDetail(ctx, id, asHtml: false));
app.MapGet(WireRoutes.PublicSearch, (HttpContext ctx) =>
{
    var keyword = Query(ctx, "q", 256)?.Trim();
    return string.IsNullOrEmpty(keyword)
        ? Error(ctx, 400, "A search term is required.")
        : Results.Bytes(Snapshot(ctx).Search(keyword), Binary);
}).RequireRateLimiting("query");
app.MapGet(WireRoutes.PublicIndex, (HttpContext ctx) =>
{
    var snapshot = Snapshot(ctx);
    var page = Query(ctx, "page", 10);
    var generation = Query(ctx, "generation", 20);
    if (generation is not null && generation != snapshot.Generation.ToString(CultureInfo.InvariantCulture))
        return Error(ctx, 409, "The search index changed. Reload it from page 1.");
    if (page is not null && (!int.TryParse(page, NumberStyles.None, CultureInfo.InvariantCulture, out var value) || (value > 1 && generation is null)))
        return Error(ctx, 400, "Invalid search index page or missing generation.");
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
    if (generation is not null && generation != snapshot.Generation.ToString(CultureInfo.InvariantCulture))
        return Error(ctx, 409, "The search corpus changed. Reload it from page 1.");
    if (snapshot.CorpusPageCount == 0)
        return Error(ctx, 503, "The search corpus is unavailable.");
    ctx.Response.Headers[WireHeaders.SearchIndexPages] = snapshot.CorpusPageCount.ToString(CultureInfo.InvariantCulture);
    if (head) return Results.NoContent();
    return snapshot.Corpus(page) is { } bytes ? Results.Bytes(bytes, Binary) : Error(ctx, 404, "Search corpus page not found.");
});

app.MapPost(WireRoutes.SignIn, async (HttpContext ctx, Store store, CancellationToken ct) =>
{
    var signIn = Wire.DecodeSignIn(await ReadFrame(ctx, WireLimits.MaxSignInFrameBytes, ct));
    var issued = await store.SignIn(signIn.Ticket, ct);
    ctx.Response.Cookies.Append(Cookie, issued.Token, CookieSettings(ctx, issued.User.ExpiresAt));
    return SessionResponse(ctx, issued.User);
}).RequireRateLimiting("sign-in");
app.MapGet(WireRoutes.Session, (HttpContext ctx, Store store, CancellationToken ct) =>
    store.WithSession(ctx.Request.Cookies[Cookie], false, (_, _, actor) => Task.FromResult(SessionResponse(ctx, actor)), ct));
app.MapPost(WireRoutes.SignOut, async (HttpContext ctx, Store store, CancellationToken ct) =>
{
    await store.SignOut(ctx.Request.Cookies[Cookie], ct);
    ctx.Response.Cookies.Delete(Cookie, CookieSettings(ctx));
    return Results.Bytes(Wire.EncodeEmptySuccess(), Binary);
}).RequireRateLimiting("command");
app.MapGet(WireRoutes.Draft, (HttpContext ctx, Store store, int id, CancellationToken ct) =>
    store.WithSession(ctx.Request.Cookies[Cookie], true, async (db, tx, actor) =>
        DraftResponse(await Store.Find(db, tx, actor, id, false, ct)), ct)).RequireRateLimiting("command");
Mutation(WireRoutes.Save, ArticleAction.Save);
Mutation(WireRoutes.Publish, ArticleAction.Publish);
Mutation(WireRoutes.Retract, ArticleAction.Retract);
Mutation(WireRoutes.Delete, ArticleAction.Delete);

var shell = app.Services.GetRequiredService<WebPages>().Page();
app.MapGet("/", (HttpContext ctx) => Results.Bytes(Snapshot(ctx).Home, Html));
app.MapGet("/article/{id:int}", (HttpContext ctx, int id) => PublicDetail(ctx, id, asHtml: true));
foreach (var route in new[] { "/archive", "/search", "/login", "/user/messagebox", "/user/manage/article/write", "/user/manage/article/edit/{id:int}" })
    app.MapGet(route, (HttpContext ctx) => { NoStore(ctx); return Results.Bytes(shell, Html); });
app.MapGet("/health/ready", (HttpContext ctx) => { NoStore(ctx); return Results.StatusCode(publications.Snapshot is null ? 503 : 204); });
app.MapFallback("/api/{**rest}", ctx => Error(ctx, 404, "Unknown API route.").ExecuteAsync(ctx));
await app.RunAsync();

IResult PublicList(HttpContext ctx, string scope, int page, int size) =>
    Results.Bytes(Snapshot(ctx).List(scope, page, size, Query(ctx, "keyword", 256), Query(ctx, "sort", 20),
        ReadListCursor(ctx), ctx.RequestAborted), Binary);

async Task<IResult> PublicDetail(HttpContext ctx, int id, bool asHtml)
{
    var snapshot = Snapshot(ctx);
    var article = await snapshot.Detail(id, ctx.RequestAborted);
    if (!ReferenceEquals(snapshot, publications.Snapshot)) throw new PublicUnavailableException();
    if (article is not null) return asHtml ? Results.Bytes(article.Html, Html) : Results.Bytes(article.Wire, Binary);
    return asHtml ? Results.Text("文章不存在", "text/plain; charset=utf-8", statusCode: 404) : Error(ctx, 404, "Article not found.");
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
        var input = Wire.DecodeArticleCommand(await ReadFrame(ctx, WireLimits.MaxCommandFrameBytes, ct));
        if (ctx.Request.Headers.TryGetValue(WireHeaders.ClientMutationId, out var header) &&
            (header.Count != 1 || !Guid.TryParseExact(header[0], "D", out var id) || id != input.IdempotencyKey))
            return Error(ctx, 400, "Command key does not match its request header.");
        var edit = Publishing.Validate(action, new(input.Id, input.ExpectedRevision, input.IdempotencyKey, input.Title, input.Body));
        var result = await publications.Command(store, ctx.Request.Cookies[Cookie], action, edit, ct);
        return action == ArticleAction.Delete ? Results.Bytes(Wire.EncodeEmptySuccess(), Binary) : DraftResponse(result.Article);
    }).RequireRateLimiting("command");
}

PublicSnapshot Snapshot(HttpContext ctx)
{
    NoStore(ctx);
    var snapshot = publications.Snapshot ?? throw new PublicUnavailableException();
    ctx.Response.Headers[WireHeaders.SearchIndexGeneration] = snapshot.Generation.ToString(CultureInfo.InvariantCulture);
    return snapshot;
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

static IResult SessionResponse(HttpContext ctx, Identity actor)
{
    ctx.Response.Headers[WireHeaders.AccessExpiresAtUtc] = actor.ExpiresAt.UtcDateTime.ToString("O", CultureInfo.InvariantCulture);
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
