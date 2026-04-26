using FsusBlog.Core.DependencyInjection;
using FsusBlog.Server.Infrastructure;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.CoreBridge.Adapters;
using FsusBlog.Server.Infrastructure.CoreBridge.Gateways;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Helpers.Initializer;
using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Infrastructure.Sse;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Services.Sse;
using FsusBlog.Server.Services.VistitLog;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.ObjectPool;
using Serilog;
using SqlSugar;
using System.Diagnostics;
using System.IO.Pipelines;
using System.Reflection;
using System.Security.Claims;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Threading.RateLimiting;
using FsusBlog.Shared.Contracts.Sse;

SetRuntimeOptimizationEnvironmentVariables();

var builder = WebApplication.CreateBuilder(args);

if (builder.Environment.IsProduction())
{
    ProductionStartupValidator.Validate(builder.Configuration, builder.Environment);
}

// =================================================================================
// 性能最大化配置 (修复日期: 2026-02-22)
// 动态倍增线程池下限，解决 StackExchange.Redis 瞬间高并发下的饥饿超时问题
// =================================================================================
int workerThreads, iocpThreads;
ThreadPool.GetMinThreads(out workerThreads, out iocpThreads);

int minThreadsBasedOnCpu = Environment.ProcessorCount * 50;
int targetMinThreads = Math.Max(minThreadsBasedOnCpu, workerThreads);
ThreadPool.SetMinThreads(targetMinThreads, targetMinThreads);

// 1. 日志
builder.Host.UseSerilog((context, services, configuration) => configuration
    .ReadFrom.Configuration(context.Configuration)
    .ReadFrom.Services(services)
    .Enrich.FromLogContext()
    .Enrich.With(services.GetRequiredService<AuditSerilogEnricher>())
    .WriteTo.Sink(services.GetRequiredService<AuditSerilogSink>()));

// 2. 基础网络 (针对多层代理进行安全加固)
builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto | ForwardedHeaders.XForwardedHost;
    options.KnownIPNetworks.Clear();
    options.KnownProxies.Clear();
});

builder.Services
    .AddFsusApiFoundation(builder.Configuration)
    .AddFsusRuntimeServices();

builder.Services.AddSingleton<ISearchIndexService, SearchIndexService>();
builder.Services.TryAddSingleton<ObjectPoolProvider, DefaultObjectPoolProvider>();

builder.Services.AddSingleton(sp =>
{
    var env = sp.GetRequiredService<IWebHostEnvironment>();
    var logger = sp.GetRequiredService<ILogger<IP2LocationPooledObjectPolicy>>();

    string baseDir = AppContext.BaseDirectory;
    string? binPath = ProductionResourcePaths.ResolveIp2LocationBinPath(baseDir);

    if (string.IsNullOrEmpty(binPath))
    {
        var allFiles = Directory.GetFiles(baseDir, "IP2LOCATION.BIN", SearchOption.AllDirectories);
        throw new FileNotFoundException($"[严重] 找不到数据库文件。BaseDir: {baseDir}。 实际发现于: {string.Join(", ", allFiles)}");
    }

    var policy = new IP2LocationPooledObjectPolicy(binPath, logger);
    return sp.GetRequiredService<ObjectPoolProvider>().Create(policy);
});

builder.Services.AddFsusRateLimiting();

var app = builder.Build();

// ==============================================================================
// 5. 中间件管道 (Order is CRITICAL)
// ==============================================================================

app.UseForwardedHeaders();

app.Use(async (ctx, next) =>
{
    var headers = ctx.Response.Headers;
    headers["X-Content-Type-Options"] = "nosniff";
    headers["Referrer-Policy"] = "strict-origin-when-cross-origin";
    headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), browsing-topics=()";
    headers["X-Frame-Options"] = "DENY";

    if (!app.Environment.IsDevelopment())
    {
        headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
    }

    string csp = app.Environment.IsDevelopment()
        ? "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data: https:; connect-src 'self' ws: wss: http://127.0.0.1:3000 http://localhost:3000 http://127.0.0.1:5000 http://localhost:5000; worker-src 'self' blob:;"
        : "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data: https:; connect-src 'self'; worker-src 'self' blob:;";
    headers["Content-Security-Policy"] = csp;

    if (ctx.Request.Path.StartsWithSegments("/api/Auth", StringComparison.OrdinalIgnoreCase))
    {
        ctx.Response.OnStarting(static state =>
        {
            var response = (HttpResponse)state;
            response.Headers["Cache-Control"] = "no-store";
            response.Headers["Pragma"] = "no-cache";
            return Task.CompletedTask;
        }, ctx.Response);
    }

    await next();
});

// 核心：这里只加载了 ShieldMiddleware，因此 CrawlerAuthMiddleware 属于死代码
app.UseMiddleware<ShieldMiddleware>();

app.UseMiddleware<GlobalExceptionMiddleware>();
app.UseMiddleware<ApiBinaryResponseMiddleware>();

var provider = new FileExtensionContentTypeProvider();
provider.Mappings[".wasm"] = "application/wasm";
provider.Mappings[".patch"] = "application/octet-stream";

app.UseStaticFiles(new StaticFileOptions
{
    ContentTypeProvider = provider,
    OnPrepareResponse = ctx =>
    {
        string requestPath = ctx.Context.Request.Path.Value ?? string.Empty;
        var headers = ctx.Context.Response.Headers;

        if (string.Equals(requestPath, "/sw.js", StringComparison.Ordinal)
            || string.Equals(requestPath, "/search/index.manifest.json", StringComparison.Ordinal)
            || string.Equals(requestPath, "/search/index.bin", StringComparison.Ordinal))
        {
            headers["Cache-Control"] = "no-cache";
            headers.Remove("ETag");
            headers.Remove("Last-Modified");
            return;
        }

        if (requestPath.StartsWith("/search/patches/", StringComparison.Ordinal)
            || Regex.IsMatch(requestPath, @"^/search/index\.(?:core|recent|archive|body)\.[0-9a-f]{16}\.bin$", RegexOptions.IgnoreCase)
            || requestPath.StartsWith("/search/dictionaries/", StringComparison.Ordinal))
        {
            headers["Cache-Control"] = "public,max-age=31536000,immutable";
            headers.Remove("ETag");
            headers.Remove("Last-Modified");
            return;
        }

        if (ctx.File.Name.EndsWith(".js")
            || ctx.File.Name.EndsWith(".css")
            || ctx.File.Name.EndsWith(".wasm")
            || ctx.File.Name.EndsWith(".woff")
            || ctx.File.Name.EndsWith(".woff2")
            || ctx.File.Name.EndsWith(".ttf")
            || ctx.File.Name.EndsWith(".otf"))
        {
            headers["Cache-Control"] = "public,max-age=31536000,immutable";
            headers.Remove("ETag");
            headers.Remove("Last-Modified");
        }
    }
});

if (app.Environment.IsDevelopment())
{
    string devClientAssetsRoot = Path.GetFullPath(Path.Combine(app.Environment.ContentRootPath, "..", "FsusBlog.Client", "src", "assets"));
    if (Directory.Exists(devClientAssetsRoot))
    {
        app.UseStaticFiles(new StaticFileOptions
        {
            FileProvider = new PhysicalFileProvider(devClientAssetsRoot),
            RequestPath = "/src/assets",
            ContentTypeProvider = provider,
            OnPrepareResponse = ctx =>
            {
                var headers = ctx.Context.Response.Headers;
                headers["Cache-Control"] = "no-cache";
                headers.Remove("ETag");
                headers.Remove("Last-Modified");
            }
        });
    }
}

app.UseRouting();
app.UseOutputCache();
app.UseCors();

app.UseRateLimiter();
app.UseAuthentication();
app.UseMiddleware<BannedUserFilter>();
app.UseAuthorization();
app.UseMiddleware<RequestAuditContextMiddleware>();
app.UseMiddleware<VisitLogMiddleware>();

app.MapProductionHealthEndpoints();
app.MapControllers();

// 6. 最小API挂载注册
app.MapMessageEndpoints();
app.MapArticleEndpoints();
app.MapAuthEndpoints();
app.MapCategoryEndpoints();
app.MapCommentEndpoints();
app.MapSystemEndpoints(); 
app.MapTagEndpoints();
app.MapBinaryEndpoints();

app.MapGet("/", ServePublicHomeAsync).AllowAnonymous();

// [极限物理重构] 接驳 Minimal API SSE 流式传输，自动承载 Token 与 PoW
app.MapGet("/api/notifications/stream", StreamNotificationsAsync).AllowAnonymous();
app.MapFallback(ServeSpaEntryAsync);

async Task StreamNotificationsAsync(
    HttpContext ctx,
    SseConnectionManager manager,
    SseBacklogStore backlogStore,
    IPowService powService,
    AdaptivePowGovernor powGovernor,
    IBlacklistService blacklistService,
    IUserService userService,
    ILoggerFactory loggerFactory,
    CancellationToken ct)
{
    if (!string.Equals(ctx.Request.Headers["X-Fsus-Sse-Protocol"], SseProtocolV2.Version, StringComparison.Ordinal))
    {
        await WriteHandshakeFailureAsync(ctx, StatusCodes.Status409Conflict, "protocol_mismatch", ct);
        return;
    }

    bool isAuthenticated = ctx.User.Identity?.IsAuthenticated == true;
    bool hasAuthHeader = ctx.Request.Headers.ContainsKey("Authorization");
    if (hasAuthHeader && !isAuthenticated)
    {
        await WriteHandshakeFailureAsync(ctx, StatusCodes.Status401Unauthorized, "auth_failed", ct);
        return;
    }

    if (!isAuthenticated)
    {
        Microsoft.Extensions.Logging.ILogger powLogger = loggerFactory.CreateLogger("FsusBlog.Sse.Pow");
        IActionResult? powFailure = await PowValidationLogic.ValidateAsync(ctx, powLogger, powService, powGovernor);
        if (powFailure is not null)
        {
            await WriteHandshakeFailureAsync(ctx, ResolveStatusCode(powFailure, StatusCodes.Status401Unauthorized), "pow_failed", ct);
            return;
        }
    }

    ctx.Response.Headers.Append("Content-Type", "text/event-stream");
    ctx.Response.Headers.Append("Cache-Control", "no-cache");
    ctx.Response.Headers.Append("Connection", "keep-alive");
    ctx.Response.Headers.Append("X-Accel-Buffering", "no");
    ctx.Response.Headers.Append("X-Fsus-Sse-Protocol", SseProtocolV2.Version);

    var feature = ctx.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpResponseBodyFeature>();
    feature?.DisableBuffering();

    string? userId = isAuthenticated
        ? ctx.User.FindFirst(ClaimTypes.NameIdentifier)?.Value
        : null;

    if (!string.IsNullOrWhiteSpace(userId) && int.TryParse(userId, out int numericUserId))
    {
        BanStateSnapshot banState = await blacklistService.GetBanStateAsync(numericUserId);
        if (banState.IsBanned)
        {
            await WriteHandshakeFailureAsync(ctx, StatusCodes.Status423Locked, "account_blocked", ct);
            return;
        }

        var userSnapshot = await userService.GetByIdAsync(numericUserId);
        if (userSnapshot == null || userSnapshot.DeletedAt.HasValue || userSnapshot.Status == 2)
        {
            await WriteHandshakeFailureAsync(ctx, StatusCodes.Status401Unauthorized, "account_deleted", ct);
            return;
        }
    }

    var groups = new HashSet<string>(StringComparer.Ordinal) { SseGroups.ContentFeed };
    if (!string.IsNullOrEmpty(userId))
    {
        groups.Add(SseGroups.AuthenticatedUsers);
        if (ctx.User.IsInRole("admin"))
        {
            groups.Add(SseGroups.AdminUsers);
        }
    }

    string connectionId = Guid.NewGuid().ToString("N");
    SseConnection connection = manager.RegisterConnection(connectionId, userId, groups);
    SseCursor cursor = ResolveCursor(ctx);

    try
    {
        SseReplayBatch replay = await backlogStore.ReplayAsync(cursor, userId, groups, ct);
        if (replay.MissedGap)
        {
            ctx.Response.Headers.Append("X-Fsus-Sse-Replay-Missed", "1");
        }

        await ctx.Response.StartAsync(ct);

        PipeWriter bodyWriter = ctx.Response.BodyWriter;
        await WriteReplayAsync(bodyWriter, connection, replay.Frames, ct);
        await PumpConnectionAsync(bodyWriter, connection, ct);
    }
    catch (OperationCanceledException)
    {
    }
    finally
    {
        manager.RemoveConnection(connectionId);
    }
}

static async Task WriteReplayAsync(PipeWriter writer, SseConnection connection, IReadOnlyList<SharedSseFrame> frames, CancellationToken cancellationToken)
{
    int flushedBatch = 0;
    int releasedCount = 0;

    try
    {
        for (int i = 0; i < frames.Count; i++)
        {
            WriteToPipe(writer, frames[i].Memory.Span);
            frames[i].Release();
            releasedCount++;
            flushedBatch++;
            connection.MarkWriteActivity();

            if (flushedBatch >= 32)
            {
                await FlushWriterAsync(writer, flushedBatch, connection, cancellationToken);
                flushedBatch = 0;
            }
        }

        if (flushedBatch > 0)
        {
            await FlushWriterAsync(writer, flushedBatch, connection, cancellationToken);
        }
    }
    finally
    {
        for (int i = releasedCount; i < frames.Count; i++)
        {
            frames[i].Release();
        }
    }
}

static async Task PumpConnectionAsync(PipeWriter writer, SseConnection connection, CancellationToken cancellationToken)
{
    const int flushThresholdBytes = 32 * 1024;
    TimeSpan flushWindow = TimeSpan.FromMilliseconds(16);
    TimeSpan heartbeatWindow = TimeSpan.FromSeconds(25);

    while (!cancellationToken.IsCancellationRequested)
    {
        bool? canRead = await WaitToReadWithTimeoutAsync(connection.Reader, heartbeatWindow, cancellationToken);
        if (canRead is null)
        {
            if (connection.IsIdle(heartbeatWindow))
            {
                WriteToPipe(writer, SseProtocolV2.HeartbeatFrame.Span);
                connection.MarkWriteActivity();
                await FlushWriterAsync(writer, 1, connection, cancellationToken);
            }

            continue;
        }

        if (canRead is false)
        {
            break;
        }

        await FlushQueuedFramesAsync(writer, connection, flushWindow, flushThresholdBytes, cancellationToken);
    }
}

static async Task FlushQueuedFramesAsync(
    PipeWriter writer,
    SseConnection connection,
    TimeSpan flushWindow,
    int flushThresholdBytes,
    CancellationToken cancellationToken)
{
    int batchSize = 0;
    int batchBytes = 0;
    long batchStarted = Stopwatch.GetTimestamp();

    while (true)
    {
        while (connection.Reader.TryRead(out SharedSseFrame? frame))
        {
            batchBytes += SseFramePump.WriteDequeuedFrame(writer, connection, frame);
            batchSize++;
            if (batchBytes >= flushThresholdBytes)
            {
                await FlushWriterAsync(writer, batchSize, connection, cancellationToken);
                return;
            }
        }

        TimeSpan remaining = flushWindow - Stopwatch.GetElapsedTime(batchStarted);
        if (batchSize == 0 || remaining <= TimeSpan.Zero)
        {
            break;
        }

        bool? additionalRead = await WaitToReadWithTimeoutAsync(connection.Reader, remaining, cancellationToken);
        if (additionalRead is null)
        {
            break;
        }

        if (additionalRead is false)
        {
            break;
        }
    }

    if (batchSize > 0)
    {
        await FlushWriterAsync(writer, batchSize, connection, cancellationToken);
    }
}

static async Task<bool?> WaitToReadWithTimeoutAsync(System.Threading.Channels.ChannelReader<SharedSseFrame> reader, TimeSpan timeout, CancellationToken cancellationToken)
{
    using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
    timeoutCts.CancelAfter(timeout);

    try
    {
        return await reader.WaitToReadAsync(timeoutCts.Token);
    }
    catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested && timeoutCts.IsCancellationRequested)
    {
        return null;
    }
}

static async Task FlushWriterAsync(PipeWriter writer, int batchSize, SseConnection connection, CancellationToken cancellationToken)
{
    long flushStarted = Stopwatch.GetTimestamp();
    FlushResult result = await writer.FlushAsync(cancellationToken);
    connection.MarkWriteActivity();
    SseMetrics.RecordFlushBatch(batchSize, Stopwatch.GetElapsedTime(flushStarted));

    if (result.IsCompleted)
    {
        connection.Complete();
    }
}

static SseCursor ResolveCursor(HttpContext context)
{
    if (SseCursor.TryParse(context.Request.Query["cursor"], out SseCursor cursor))
    {
        return cursor;
    }

    return SseCursor.TryParse(context.Request.Headers["Last-Event-ID"], out cursor)
        ? cursor
        : SseCursor.Empty;
}

static async Task WriteHandshakeFailureAsync(HttpContext context, int statusCode, string errorCode, CancellationToken cancellationToken)
{
    context.Response.StatusCode = statusCode;
    context.Response.ContentType = "application/json; charset=utf-8";
    await context.Response.WriteAsJsonAsync(
        new
        {
            code = statusCode,
            message = errorCode,
            traceId = context.TraceIdentifier
        },
        cancellationToken);
}

static int ResolveStatusCode(IActionResult result, int fallback)
{
    return result switch
    {
        ObjectResult objectResult when objectResult.StatusCode.HasValue => objectResult.StatusCode.Value,
        StatusCodeResult statusCodeResult => statusCodeResult.StatusCode,
        _ => fallback
    };
}

static void WriteToPipe(PipeWriter writer, ReadOnlySpan<byte> data)
{
    data.CopyTo(writer.GetSpan(data.Length));
    writer.Advance(data.Length);
}

async Task<IResult> ServePublicHomeAsync(
    HttpContext ctx,
    IPublicAotShellService shellService,
    IWebHostEnvironment env,
    CancellationToken ct)
{
    return await ServePublicShellOrIndexAsync(ctx, shellService, env, ct);
}

async Task<IResult> ServeSpaEntryAsync(
    HttpContext ctx,
    IPublicAotShellService shellService,
    IWebHostEnvironment env,
    CancellationToken ct)
{
    return await ServePublicShellOrIndexAsync(ctx, shellService, env, ct);
}

static async Task<IResult> ServePublicShellOrIndexAsync(
    HttpContext ctx,
    IPublicAotShellService shellService,
    IWebHostEnvironment env,
    CancellationToken ct)
{
    if (!HttpMethods.IsGet(ctx.Request.Method) && !HttpMethods.IsHead(ctx.Request.Method))
    {
        return Results.NotFound();
    }

    if (shellService.TryResolve(ctx, out _))
    {
        string? html = await shellService.RenderAsync(ctx, ct);
        if (!string.IsNullOrEmpty(html))
        {
            string source = ctx.Items.TryGetValue(PublicAotShellService.PublicAotSourceContextKey, out object? sourceObj)
                ? sourceObj?.ToString() ?? "unknown"
                : "unknown";
            string version = ctx.Items.TryGetValue(PublicAotShellService.PublicAotVersionContextKey, out object? versionObj)
                ? versionObj?.ToString() ?? "unknown"
                : "unknown";
            string backfill = ctx.Items.TryGetValue(PublicAotShellService.PublicAotBackfillContextKey, out object? backfillObj)
                ? backfillObj?.ToString() ?? "none"
                : "none";
            ctx.Response.Headers["X-Fsus-Public-Aot-Source"] = source;
            ctx.Response.Headers["X-Fsus-Public-Aot-Version"] = version;
            ctx.Response.Headers["X-Fsus-Public-Aot-Backfill"] = backfill;
            ctx.Response.Headers["Cache-Control"] = "no-cache";
            ctx.Response.Headers.Remove("ETag");
            ctx.Response.Headers.Remove("Last-Modified");
            return Results.Content(html, "text/html; charset=utf-8");
        }
    }

    bool preferSourceTemplate =
        env.IsDevelopment()
        && ctx.Request.Host.Value?.Contains(":3000", StringComparison.Ordinal) == true;
    string spaSource = ctx.Items.TryGetValue(PublicAotShellService.PublicAotSourceContextKey, out object? spaSourceObj)
        ? spaSourceObj?.ToString() ?? "spa-index"
        : "spa-index";
    string spaVersion = ctx.Items.TryGetValue(PublicAotShellService.PublicAotVersionContextKey, out object? spaVersionObj)
        ? spaVersionObj?.ToString() ?? "unknown"
        : "unknown";
    string spaBackfill = ctx.Items.TryGetValue(PublicAotShellService.PublicAotBackfillContextKey, out object? spaBackfillObj)
        ? spaBackfillObj?.ToString() ?? "none"
        : "none";
    ctx.Response.Headers["X-Fsus-Public-Aot-Source"] = spaSource;
    ctx.Response.Headers["X-Fsus-Public-Aot-Version"] = spaVersion;
    ctx.Response.Headers["X-Fsus-Public-Aot-Backfill"] = spaBackfill;
    ctx.Response.Headers["Cache-Control"] = "no-cache";
    ctx.Response.Headers.Remove("ETag");
    ctx.Response.Headers.Remove("Last-Modified");
    ReadOnlyMemory<byte> templateBytes = await PublicSpaTemplateLocator.ReadIndexTemplateBytesAsync(env, ct, preferSourceTemplate);
    ctx.Response.ContentType = "text/html; charset=utf-8";
    ctx.Response.ContentLength = templateBytes.Length;
    if (!HttpMethods.IsHead(ctx.Request.Method) && templateBytes.Length > 0)
    {
        await ctx.Response.BodyWriter.WriteAsync(templateBytes, ct);
    }

    return Results.Empty;
}

// 7. 数据库与系统初始化
try
{
    await using var scope = app.Services.CreateAsyncScope();
    var migrationRunner = scope.ServiceProvider.GetRequiredService<ISchemaMigrationRunner>();
    await migrationRunner.RunAsync(CancellationToken.None);
    var searchCompiler = scope.ServiceProvider.GetRequiredService<ISearchIndexService>();
    await searchCompiler.BuildIndexAsync([]);

    var initializer = scope.ServiceProvider.GetRequiredService<CacheInitializer>();
    await initializer.InitializeAsync();

    Console.WriteLine("Hello,world.System Ready (API Engine Mode).");
}
catch (Exception ex)
{
    Log.Fatal(ex, "System Halt.");
    if (!app.Environment.IsDevelopment()) throw;
}

app.Run();

void SetRuntimeOptimizationEnvironmentVariables()
{
    SetIfMissing("DOTNET_ReadyToRun", "1");
    SetIfMissing("DOTNET_TC_QuickJitForLoops", "1");
    SetIfMissing("DOTNET_TieredPGO", "1");
}

static void SetIfMissing(string key, string value)
{
    if (!string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(key)))
    {
        return;
    }

    Environment.SetEnvironmentVariable(key, value);
}
