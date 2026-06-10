using System.Text;
using System.Security.Cryptography;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.IO.Pipelines;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Helpers.Initializer;
using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Spa;
using FsusBlog.Server.Infrastructure.Sse;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;

namespace FsusBlog.Server.Infrastructure.Bootstrap;

public sealed record StartupLifecycleTaskReport(
    string Status,
    DateTimeOffset UpdatedAt,
    string? Detail);

public sealed record StartupRuntimeSnapshot(
    bool SystemCachesClearedOnStartup,
    IReadOnlyDictionary<string, StartupLifecycleTaskReport> Tasks);

public sealed class StartupRuntimeState
{
    private readonly object _gate = new();
    private readonly Dictionary<string, StartupLifecycleTaskReport> _startupTasks = new(StringComparer.Ordinal);

    public bool SystemCachesClearedOnStartup { get; set; }

    public void ReportStartupTask(string taskName, string status, string? detail = null)
    {
        lock (_gate)
        {
            _startupTasks[taskName] = new StartupLifecycleTaskReport(status, DateTimeOffset.UtcNow, detail);
        }
    }

    public IReadOnlyDictionary<string, StartupLifecycleTaskReport> GetStartupTasks()
    {
        lock (_gate)
        {
            return new Dictionary<string, StartupLifecycleTaskReport>(_startupTasks, StringComparer.Ordinal);
        }
    }

    public StartupRuntimeSnapshot CreateSnapshot()
    {
        lock (_gate)
        {
            return new StartupRuntimeSnapshot(
                SystemCachesClearedOnStartup,
                new Dictionary<string, StartupLifecycleTaskReport>(_startupTasks, StringComparer.Ordinal));
        }
    }
}

public static class WebApplicationCompositionExtensions
{
    private const string CspNonceContextKey = "__fsusblog_csp_nonce";
    private const string CspNonceTemplatePlaceholder = "%%FSUSBLOG_CSP_NONCE%%";
    private const string HtmlContentType = "text/html; charset=utf-8";
    private static readonly byte[] EmptyBytes = [];
    private static readonly ConditionalWeakTable<string, CspNonceHtmlTemplate> CspNonceHtmlTemplates = new();
    private static readonly ConditionalWeakTable<byte[], SpaHtmlByteTemplate> SpaHtmlByteTemplates = new();

    public static void UseFsusApplicationPipeline(this WebApplication app)
    {
        app.UseForwardedHeaders();
        app.UseFsusSecurityHeaders();
        app.UseFsusCoreMiddlewares();
        app.UseFsusStaticAssets();
        app.UseFsusEndpointPipeline();
    }

    public static void MapFsusApplicationRoutes(this WebApplication app)
    {
        app.MapFsusOperationalRoutes();
        app.MapFsusApiRoutes();
        app.MapFsusPublicRoutes();
    }

    private static void UseFsusSecurityHeaders(this WebApplication app)
    {
        app.Use(async (ctx, next) =>
        {
            var headers = ctx.Response.Headers;
            headers["X-Content-Type-Options"] = "nosniff";
            headers["Referrer-Policy"] = "strict-origin-when-cross-origin";
            headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), browsing-topics=()";
            headers["X-Frame-Options"] = "DENY";
            headers["Cross-Origin-Embedder-Policy"] = "credentialless";
            headers["Cross-Origin-Opener-Policy"] = "same-origin";
            headers["Cross-Origin-Resource-Policy"] = "same-origin";

            if (!app.Environment.IsDevelopment())
            {
                headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
            }

            if (ShouldApplyHtmlCsp(ctx))
            {
                string nonce = EnsureCspNonce(ctx);
                headers["Content-Security-Policy"] = BuildHtmlCsp(app.Environment, nonce);
            }
            else
            {
                headers["Content-Security-Policy"] = BuildStaticCsp(app.Environment);
            }

            ctx.Response.OnStarting(static state =>
            {
                var response = (HttpResponse)state;
                if (response.StatusCode >= 400 && !response.Headers.ContainsKey("Cache-Control"))
                {
                    response.Headers["Cache-Control"] = "no-store";
                    response.Headers["Pragma"] = "no-cache";
                }

                return Task.CompletedTask;
            }, ctx.Response);

            await next();
        });
    }

    private static void UseFsusCoreMiddlewares(this WebApplication app)
    {
        app.UseMiddleware<ShieldMiddleware>();
        app.UseMiddleware<GlobalExceptionMiddleware>();
        app.UseMiddleware<ApiBinaryResponseMiddleware>();
    }

    private static void UseFsusStaticAssets(this WebApplication app)
    {
        var provider = CreateStaticFileContentTypeProvider();
        app.UseStaticFiles(new StaticFileOptions
        {
            ContentTypeProvider = provider,
            OnPrepareResponse = PrepareStaticAssetResponse
        });

        if (app.Environment.IsDevelopment())
        {
            UseDevelopmentClientAssetFiles(app, provider);
        }
    }

    private static void UseFsusEndpointPipeline(this WebApplication app)
    {
        app.UseRouting();
        app.UseMiddleware<ObservabilityCorrelationMiddleware>();
        app.UseFsusEndpointMetadataHeaders();
        app.UseWebSockets();
        if (HttpTestSessionKeyScope.IsIsolationEnabled(app.Environment))
        {
            app.UseMiddleware<TestSessionValidationMiddleware>();
        }

        app.UseOutputCache();
        app.UseCors();
        app.UseRateLimiter();
        app.UseAuthentication();
        app.UseMiddleware<BannedUserMiddleware>();
        app.UseAuthorization();
        app.UseMiddleware<RequestAuditContextMiddleware>();
    }

    private static void UseFsusEndpointMetadataHeaders(this WebApplication app)
    {
        app.Use(async (ctx, next) =>
        {
            if (ctx.GetEndpoint()?.Metadata.GetMetadata<NoStoreResponseMetadata>() != null)
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
    }

    private static void MapFsusOperationalRoutes(this WebApplication app)
    {
        app.MapProductionHealthEndpoints();
    }

    private static void MapFsusApiRoutes(this WebApplication app)
    {
        app.MapBinaryEndpoints();
        app.MapReadProofEndpoints();
        app.MapAuthoringEndpoints();
        app.MapSecurityEndpoints();
        app.MapSubscriptionEndpoints();
        app.MapTelemetryEndpoints();
        app.MapPublicAotEndpoints();

        app.MapGet("/api/notifications/stream/preflight", (
            HttpContext ctx,
            INotificationStreamHandshakeService handshakeService,
            CancellationToken ct) => ValidateNotificationStreamPreflightAsync(ctx, handshakeService, ct))
            .AllowAnonymous()
            .WithMetadata(new FsusRouteKindMetadata("sse"));
        app.MapGet("/api/notifications/stream", (
            HttpContext ctx,
            INotificationStreamHandler handler,
            CancellationToken ct) => handler.HandleAsync(ctx, ct))
            .AllowAnonymous()
            .WithMetadata(new FsusRouteKindMetadata("sse"));
        app.Map("/api/{**path}", (IAedsEncoder aeds) =>
        {
            return BinaryResults.FromError(
                ErrorDetail.Create(ErrorCode.NotFound, "旧文本 API 已移除，请使用 /api/binary/** AEDS 二进制端点"),
                aeds,
                StatusCodes.Status404NotFound);
        }).WithMetadata(new FsusRouteKindMetadata("api"));
    }

    private static void MapFsusPublicRoutes(this WebApplication app)
    {
        app.MapDistributionEndpoints();

        app.MapGet("/", (
            HttpContext ctx,
            IPublicAotShellService shellService,
            ISpaAssetManifestService assetService,
            IWebHostEnvironment env,
            StartupRuntimeState runtimeState,
            CancellationToken ct) => ServePublicShellOrIndexAsync(ctx, shellService, assetService, env, runtimeState, ct))
            .AllowAnonymous()
            .WithMetadata(new FsusRouteKindMetadata("public"));
        app.MapFallback((
            HttpContext ctx,
            IPublicAotShellService shellService,
            ISpaAssetManifestService assetService,
            IWebHostEnvironment env,
            StartupRuntimeState runtimeState,
            CancellationToken ct) => ServePublicShellOrIndexAsync(ctx, shellService, assetService, env, runtimeState, ct))
            .WithMetadata(new FsusRouteKindMetadata("public"));
    }

    private static async Task<IResult> ValidateNotificationStreamPreflightAsync(
        HttpContext ctx,
        INotificationStreamHandshakeService handshakeService,
        CancellationToken ct)
    {
        NotificationStreamHandshakeResult result = await handshakeService.ValidateAsync(ctx, ct, requireWebSocket: false);
        if (result.IsSuccess)
        {
            return TypedResults.NoContent();
        }

        ctx.Response.Headers["X-Fsus-Sse-Error-Code"] = result.ErrorCode ?? "notification_handshake_failed";
        ctx.Response.Headers["X-Fsus-Sse-Status-Code"] = result.StatusCode.ToString(System.Globalization.CultureInfo.InvariantCulture);
        ErrorDetail error = ApiErrorSemanticMapper.CreateError(
            result.StatusCode,
            result.ErrorCode ?? "notification_handshake_failed",
            ctx.TraceIdentifier);
        return TypedResults.Json(
            new
            {
                ok = false,
                statusCode = result.StatusCode,
                errorCode = result.ErrorCode ?? "notification_handshake_failed",
                message = error.Message,
                data = (object?)null
            },
            statusCode: result.StatusCode);
    }

    private static FileExtensionContentTypeProvider CreateStaticFileContentTypeProvider()
    {
        var provider = new FileExtensionContentTypeProvider();
        provider.Mappings[".wasm"] = "application/wasm";
        provider.Mappings[".patch"] = "application/octet-stream";
        provider.Mappings[".aeds"] = "application/octet-stream";
        return provider;
    }

    private static void PrepareStaticAssetResponse(StaticFileResponseContext ctx)
    {
        string requestPath = ctx.Context.Request.Path.Value ?? string.Empty;
        var headers = ctx.Context.Response.Headers;

        if (string.Equals(requestPath, "/sw.js", StringComparison.Ordinal)
            || string.Equals(requestPath, "/search/index.manifest.aeds", StringComparison.Ordinal)
            || string.Equals(requestPath, "/search/index.bin", StringComparison.Ordinal)
            || string.Equals(requestPath, "/favicon.svg", StringComparison.Ordinal)
            || string.Equals(requestPath, "/manifest.webmanifest", StringComparison.Ordinal))
        {
            headers["Cache-Control"] = "no-cache";
            headers.Remove("ETag");
            headers.Remove("Last-Modified");
            return;
        }

        if (requestPath.StartsWith("/search/patches/", StringComparison.Ordinal)
            || IsImmutableSearchIndexAssetPath(requestPath.AsSpan())
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

    private static void UseDevelopmentClientAssetFiles(WebApplication app, FileExtensionContentTypeProvider provider)
    {
        string[] devClientAssetCandidates =
        [
            Path.GetFullPath(Path.Combine(app.Environment.ContentRootPath, "..", "frontend", "src", "assets")),
            Path.GetFullPath(Path.Combine(app.Environment.ContentRootPath, "..", "..", "frontend", "src", "assets")),
            Path.GetFullPath(Path.Combine(app.Environment.ContentRootPath, "..", "FsusBlog.Client", "src", "assets")),
            Path.GetFullPath(Path.Combine(app.Environment.ContentRootPath, "FsusBlog.Client", "src", "assets"))
        ];

        string devClientAssetsRoot = devClientAssetCandidates.FirstOrDefault(Directory.Exists) ?? string.Empty;
        if (!Directory.Exists(devClientAssetsRoot))
        {
            return;
        }

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

    private static async Task<IResult> ServePublicShellOrIndexAsync(
        HttpContext ctx,
        IPublicAotShellService shellService,
        ISpaAssetManifestService assetService,
        IWebHostEnvironment env,
        StartupRuntimeState runtimeState,
        CancellationToken ct)
    {
        if (!HttpMethods.IsGet(ctx.Request.Method) && !HttpMethods.IsHead(ctx.Request.Method))
        {
            return TypedResults.NotFound();
        }

        bool isPublicAotRoute = shellService.TryResolve(ctx, out PublicAotRouteMatch aotMatch);
        if (isPublicAotRoute)
        {
            long aotStartedAt = System.Diagnostics.Stopwatch.GetTimestamp();
            string? html = await shellService.RenderAsync(ctx, aotMatch, ct);
            string source = ctx.Items.TryGetValue(PublicAotShellService.PublicAotSourceContextKey, out object? sourceObj)
                ? sourceObj?.ToString() ?? "unknown"
                : "unknown";
            string version = ctx.Items.TryGetValue(PublicAotShellService.PublicAotVersionContextKey, out object? versionObj)
                ? versionObj?.ToString() ?? "unknown"
                : "unknown";
            string backfill = ctx.Items.TryGetValue(PublicAotShellService.PublicAotBackfillContextKey, out object? backfillObj)
                ? backfillObj?.ToString() ?? "none"
                : "none";
            string state = ctx.Items.TryGetValue(PublicAotShellService.PublicAotStateContextKey, out object? stateObj)
                ? stateObj?.ToString() ?? "unknown"
                : "unknown";
            FsusObservability.RecordAotRender(
                source,
                backfill,
                string.IsNullOrEmpty(html) ? "fallback" : "hit",
                FsusObservability.GetElapsed(aotStartedAt));
            if (!string.IsNullOrEmpty(html))
            {
                ctx.Response.Headers["X-Fsus-Public-Aot-Source"] = source;
                ctx.Response.Headers["X-Fsus-Public-Aot-Version"] = version;
                ctx.Response.Headers["X-Fsus-Public-Aot-Backfill"] = backfill;
                ctx.Response.Headers["X-Fsus-Public-Aot-State"] = state;
                if (string.Equals(state, "stale", StringComparison.Ordinal))
                {
                    ctx.Response.Headers["X-Fsus-Public-Aot-Stale"] = "1";
                }
                ctx.Response.Headers["Cache-Control"] = "no-cache";
                ctx.Response.Headers.Remove("ETag");
                ctx.Response.Headers.Remove("Last-Modified");
                EnsureHtmlCspHeader(ctx, env);
                html = ApplyCspNonceToHtml(ctx, html);
                return TypedResults.Content(html, "text/html; charset=utf-8");
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
        string spaState = ctx.Items.TryGetValue(PublicAotShellService.PublicAotStateContextKey, out object? spaStateObj)
            ? spaStateObj?.ToString() ?? "fallback"
            : "fallback";
        ctx.Response.Headers["X-Fsus-Public-Aot-Source"] = spaSource;
        ctx.Response.Headers["X-Fsus-Public-Aot-Version"] = spaVersion;
        ctx.Response.Headers["X-Fsus-Public-Aot-Backfill"] = spaBackfill;
        ctx.Response.Headers["X-Fsus-Public-Aot-State"] = spaState;
        ctx.Response.Headers["Cache-Control"] = "no-cache";
        ctx.Response.Headers.Remove("ETag");
        ctx.Response.Headers.Remove("Last-Modified");

        if (runtimeState.SystemCachesClearedOnStartup)
        {
            ctx.Response.Headers["Clear-Site-Data"] = "\"cache\"";
        }

        ReadOnlyMemory<byte> templateBytes = await PublicSpaTemplateLocator.ReadIndexTemplateBytesAsync(env, ct, preferSourceTemplate);

        string path = ctx.Request.Path.Value ?? string.Empty;
        if (templateBytes.Length > 0)
        {
            var preloads = assetService.GetPreloadsForPath(path, ctx);
            SpaAssetSet? publicAssetSet = isPublicAotRoute ? assetService.GetPublicAssetSet(ctx) : null;
            if (preloads.Count > 0)
            {
                ReadOnlyMemory<byte> headInjection = BuildRoutePreloadHeadInjection(preloads);
                await WriteSpaHtmlResponseAsync(ctx, env, templateBytes, headInjection, ct);
                return TypedResults.Empty;
            }
            if (publicAssetSet is not null)
            {
                ReadOnlyMemory<byte> headInjection = BuildPublicAssetHeadInjection(publicAssetSet);
                await WriteSpaHtmlResponseAsync(ctx, env, templateBytes, headInjection, ct);
                return TypedResults.Empty;
            }
        }

        await WriteSpaHtmlResponseAsync(ctx, env, templateBytes, EmptyBytes, ct);

        return TypedResults.Empty;
    }

    private static bool ShouldApplyHtmlCsp(HttpContext ctx)
    {
        if (!HttpMethods.IsGet(ctx.Request.Method) && !HttpMethods.IsHead(ctx.Request.Method))
        {
            return false;
        }

        string path = ctx.Request.Path.Value ?? string.Empty;
        if (IsNonHtmlHotPath(path.AsSpan()))
        {
            return false;
        }

        return HttpAcceptNegotiation.Accepts(ctx.Request.Headers.Accept, "text/html");
    }

    private static bool IsNonHtmlHotPath(ReadOnlySpan<char> path)
    {
        if (path.IsEmpty)
        {
            return false;
        }

        if (path.StartsWith("/api/".AsSpan(), StringComparison.OrdinalIgnoreCase)
            || path.StartsWith("/health/".AsSpan(), StringComparison.OrdinalIgnoreCase)
            || path.StartsWith("/assets/".AsSpan(), StringComparison.OrdinalIgnoreCase)
            || path.StartsWith("/src/assets/".AsSpan(), StringComparison.OrdinalIgnoreCase)
            || path.StartsWith("/search/".AsSpan(), StringComparison.OrdinalIgnoreCase)
            || path.StartsWith("/uploads/".AsSpan(), StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return path.Equals("/sw.js".AsSpan(), StringComparison.OrdinalIgnoreCase)
            || path.Equals("/favicon.svg".AsSpan(), StringComparison.OrdinalIgnoreCase)
            || path.Equals("/manifest.webmanifest".AsSpan(), StringComparison.OrdinalIgnoreCase)
            || HasStaticAssetExtension(path);
    }

    private static bool HasStaticAssetExtension(ReadOnlySpan<char> path)
        => path.EndsWith(".js".AsSpan(), StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".css".AsSpan(), StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".wasm".AsSpan(), StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".woff".AsSpan(), StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".woff2".AsSpan(), StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".ttf".AsSpan(), StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".otf".AsSpan(), StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".png".AsSpan(), StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".jpg".AsSpan(), StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".jpeg".AsSpan(), StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".gif".AsSpan(), StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".webp".AsSpan(), StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".avif".AsSpan(), StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".svg".AsSpan(), StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".ico".AsSpan(), StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".map".AsSpan(), StringComparison.OrdinalIgnoreCase);

    internal static bool IsImmutableSearchIndexAssetPath(ReadOnlySpan<char> path)
    {
        const string prefix = "/search/index.";
        const string suffix = ".bin";
        if (!path.StartsWith(prefix.AsSpan(), StringComparison.OrdinalIgnoreCase)
            || !path.EndsWith(suffix.AsSpan(), StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        ReadOnlySpan<char> middle = path[prefix.Length..^suffix.Length];
        int dot = middle.LastIndexOf('.');
        if (dot <= 0 || dot == middle.Length - 1)
        {
            return false;
        }

        ReadOnlySpan<char> kind = middle[..dot];
        ReadOnlySpan<char> hash = middle[(dot + 1)..];
        return IsSearchIndexKind(kind) && IsSixteenHex(hash);
    }

    private static bool IsSearchIndexKind(ReadOnlySpan<char> value)
        => value.Equals("core".AsSpan(), StringComparison.OrdinalIgnoreCase)
            || value.Equals("recent".AsSpan(), StringComparison.OrdinalIgnoreCase)
            || value.Equals("archive".AsSpan(), StringComparison.OrdinalIgnoreCase)
            || value.Equals("body".AsSpan(), StringComparison.OrdinalIgnoreCase);

    private static bool IsSixteenHex(ReadOnlySpan<char> value)
    {
        if (value.Length != 16)
        {
            return false;
        }

        foreach (char ch in value)
        {
            bool isHex = ch is >= '0' and <= '9'
                || ch is >= 'a' and <= 'f'
                || ch is >= 'A' and <= 'F';
            if (!isHex)
            {
                return false;
            }
        }

        return true;
    }

    private static string BuildStaticCsp(IWebHostEnvironment env)
        => env.IsDevelopment()
            ? "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' http://127.0.0.1:3000 http://localhost:3000 http://127.0.0.1:5000 http://localhost:5000 ws://127.0.0.1:3000 ws://localhost:3000 ws://127.0.0.1:5000 ws://localhost:5000; worker-src 'self' blob:;"
            : "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:;";

    private static string BuildHtmlCsp(IWebHostEnvironment env, string nonce)
        => env.IsDevelopment()
            ? $"default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self' 'wasm-unsafe-eval' 'nonce-{nonce}'; style-src 'self' 'nonce-{nonce}'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' http://127.0.0.1:3000 http://localhost:3000 http://127.0.0.1:5000 http://localhost:5000 ws://127.0.0.1:3000 ws://localhost:3000 ws://127.0.0.1:5000 ws://localhost:5000; worker-src 'self' blob:;"
            : $"default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self' 'wasm-unsafe-eval' 'nonce-{nonce}'; style-src 'self' 'nonce-{nonce}'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:;";

    private static string EnsureCspNonce(HttpContext ctx)
    {
        if (ctx.Items.TryGetValue(CspNonceContextKey, out object? nonceObj)
            && nonceObj is string nonce
            && !string.IsNullOrWhiteSpace(nonce))
        {
            return nonce;
        }

        nonce = CreateCspNonce();
        ctx.Items[CspNonceContextKey] = nonce;
        return nonce;
    }

    private static void EnsureHtmlCspHeader(HttpContext ctx, IWebHostEnvironment env)
    {
        string nonce = EnsureCspNonce(ctx);
        ctx.Response.Headers["Content-Security-Policy"] = BuildHtmlCsp(env, nonce);
    }

    private static string CreateCspNonce()
        => Convert.ToBase64String(RandomNumberGenerator.GetBytes(16));

    private static async Task WriteSpaHtmlResponseAsync(
        HttpContext ctx,
        IWebHostEnvironment env,
        ReadOnlyMemory<byte> templateBytes,
        ReadOnlyMemory<byte> headInjection,
        CancellationToken cancellationToken)
    {
        EnsureHtmlCspHeader(ctx, env);
        SpaHtmlByteTemplate template = GetSpaHtmlByteTemplate(templateBytes);
        ReadOnlyMemory<byte> nonceBytes = GetEncodedNonceBytes(ctx);
        int contentLength = template.GetLength(nonceBytes.Length, headInjection.Length);

        ctx.Response.ContentType = HtmlContentType;
        ctx.Response.ContentLength = contentLength;
        if (HttpMethods.IsHead(ctx.Request.Method) || contentLength == 0)
        {
            return;
        }

        template.Write(ctx.Response.BodyWriter, nonceBytes.Span, headInjection.Span);
        await ctx.Response.BodyWriter.FlushAsync(cancellationToken);
    }

    private static SpaHtmlByteTemplate GetSpaHtmlByteTemplate(ReadOnlyMemory<byte> templateBytes)
    {
        if (templateBytes.Length == 0)
        {
            return SpaHtmlByteTemplate.Empty;
        }

        if (MemoryMarshal.TryGetArray(templateBytes, out ArraySegment<byte> segment)
            && segment.Array is not null
            && segment.Offset == 0
            && segment.Count == segment.Array.Length)
        {
            return SpaHtmlByteTemplates.GetValue(segment.Array, static bytes => SpaHtmlByteTemplate.Create(bytes));
        }

        return SpaHtmlByteTemplate.Create(templateBytes.Span);
    }

    private static ReadOnlyMemory<byte> GetEncodedNonceBytes(HttpContext ctx)
    {
        string nonce = EnsureCspNonce(ctx);
        string encodedNonce = System.Net.WebUtility.HtmlEncode(nonce);
        return Encoding.UTF8.GetBytes(encodedNonce);
    }

    private static ReadOnlyMemory<byte> BuildRoutePreloadHeadInjection(IReadOnlyList<string> preloads)
    {
        if (preloads.Count == 0)
        {
            return EmptyBytes;
        }

        var sb = new StringBuilder(preloads.Count * 64);
        foreach (string asset in preloads)
        {
            if (asset.EndsWith(".js", StringComparison.OrdinalIgnoreCase))
            {
                sb.Append("<link rel=\"modulepreload\" href=\"");
                sb.Append(asset);
                sb.AppendLine("\">");
            }
            else if (asset.EndsWith(".css", StringComparison.OrdinalIgnoreCase))
            {
                sb.Append("<link rel=\"stylesheet\" href=\"");
                sb.Append(asset);
                sb.AppendLine("\">");
            }
        }

        return sb.Length == 0 ? EmptyBytes : Encoding.UTF8.GetBytes(sb.ToString());
    }

    private static ReadOnlyMemory<byte> BuildPublicAssetHeadInjection(SpaAssetSet publicAssetSet)
    {
        int assetCount = publicAssetSet.ModulePreloads.Count + publicAssetSet.Stylesheets.Count;
        if (assetCount == 0)
        {
            return EmptyBytes;
        }

        var sb = new StringBuilder(assetCount * 72);
        foreach (string asset in publicAssetSet.ModulePreloads)
        {
            sb.Append("<link rel=\"modulepreload\" crossorigin href=\"");
            sb.Append(asset);
            sb.AppendLine("\">");
        }

        foreach (string asset in publicAssetSet.Stylesheets)
        {
            sb.Append("<link rel=\"stylesheet\" href=\"");
            sb.Append(asset);
            sb.AppendLine("\">");
        }

        return Encoding.UTF8.GetBytes(sb.ToString());
    }

    internal static string ApplyCspNonceToHtml(HttpContext ctx, string html)
    {
        if (!ctx.Items.TryGetValue(CspNonceContextKey, out object? nonceObj)
            || nonceObj is not string nonce
            || string.IsNullOrWhiteSpace(nonce))
        {
            return html;
        }

        string encodedNonce = System.Net.WebUtility.HtmlEncode(nonce);
        CspNonceHtmlTemplate template = CspNonceHtmlTemplates.GetValue(html, BuildCspNonceHtmlTemplate);
        if (!template.HasPlaceholders)
        {
            return html;
        }

        return template.Html.Replace(CspNonceTemplatePlaceholder, encodedNonce, StringComparison.Ordinal);
    }

    private static CspNonceHtmlTemplate BuildCspNonceHtmlTemplate(string html)
    {
        bool needsCspMeta = !html.Contains("property=\"csp-nonce\"", StringComparison.OrdinalIgnoreCase)
            && !html.Contains("property='csp-nonce'", StringComparison.OrdinalIgnoreCase);
        if (!html.Contains("<script", StringComparison.OrdinalIgnoreCase)
            && !html.Contains("<style", StringComparison.OrdinalIgnoreCase)
            && (!needsCspMeta || !html.Contains("<head>", StringComparison.OrdinalIgnoreCase)))
        {
            return CspNonceHtmlTemplate.Unchanged;
        }

        var builder = new StringBuilder(html.Length + CspNonceTemplatePlaceholder.Length * 4 + 64);
        int position = 0;
        bool hasPlaceholders = false;
        while (position < html.Length)
        {
            int tagStart = html.IndexOf('<', position);
            if (tagStart < 0)
            {
                builder.Append(html, position, html.Length - position);
                break;
            }

            builder.Append(html, position, tagStart - position);
            int tagEnd = html.IndexOf('>', tagStart);
            if (tagEnd < 0)
            {
                builder.Append(html, tagStart, html.Length - tagStart);
                break;
            }

            if (IsTagStart(html, tagStart, "script") && !TagContainsNonce(html, tagStart, tagEnd))
            {
                AppendTagWithNonce(builder, html, tagStart, tagEnd, "script", CspNonceTemplatePlaceholder);
                hasPlaceholders = true;
            }
            else if (IsTagStart(html, tagStart, "style") && !TagContainsNonce(html, tagStart, tagEnd))
            {
                AppendTagWithNonce(builder, html, tagStart, tagEnd, "style", CspNonceTemplatePlaceholder);
                hasPlaceholders = true;
            }
            else
            {
                builder.Append(html, tagStart, tagEnd - tagStart + 1);
                if (needsCspMeta && IsExactHeadTag(html, tagStart, tagEnd))
                {
                    builder.Append('\n');
                    builder.Append("    <meta property=\"csp-nonce\" nonce=\"");
                    builder.Append(CspNonceTemplatePlaceholder);
                    builder.Append("\" />");
                    needsCspMeta = false;
                    hasPlaceholders = true;
                }
            }

            position = tagEnd + 1;
        }

        return hasPlaceholders
            ? new CspNonceHtmlTemplate(builder.ToString(), true)
            : CspNonceHtmlTemplate.Unchanged;
    }

    private static bool IsTagStart(string html, int tagStart, string tagName)
    {
        int nameStart = tagStart + 1;
        if (html.Length < nameStart + tagName.Length
            || !html.AsSpan(nameStart, tagName.Length).Equals(tagName, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        int nameEnd = nameStart + tagName.Length;
        return nameEnd >= html.Length
            || char.IsWhiteSpace(html[nameEnd])
            || html[nameEnd] == '>'
            || html[nameEnd] == '/';
    }

    private static bool IsExactHeadTag(string html, int tagStart, int tagEnd)
        => tagEnd - tagStart == 5
            && html.AsSpan(tagStart, 6).Equals("<head>", StringComparison.OrdinalIgnoreCase);

    private static bool TagContainsNonce(string html, int tagStart, int tagEnd)
        => html.AsSpan(tagStart, tagEnd - tagStart + 1).IndexOf("nonce=", StringComparison.OrdinalIgnoreCase) >= 0;

    private static void AppendTagWithNonce(
        StringBuilder builder,
        string html,
        int tagStart,
        int tagEnd,
        string tagName,
        string encodedNonce)
    {
        int insertAt = tagStart + 1 + tagName.Length;
        builder.Append(html, tagStart, insertAt - tagStart);
        builder.Append(" nonce=\"");
        builder.Append(encodedNonce);
        builder.Append('"');
        builder.Append(html, insertAt, tagEnd - insertAt + 1);
    }

    private sealed class SpaHtmlByteTemplate
    {
        public static SpaHtmlByteTemplate Empty { get; } = new(
            NoncePatchedByteTemplate.Empty,
            NoncePatchedByteTemplate.Empty);

        private readonly NoncePatchedByteTemplate _beforeHeadClose;
        private readonly NoncePatchedByteTemplate _headCloseAndAfter;

        private SpaHtmlByteTemplate(NoncePatchedByteTemplate beforeHeadClose, NoncePatchedByteTemplate headCloseAndAfter)
        {
            _beforeHeadClose = beforeHeadClose;
            _headCloseAndAfter = headCloseAndAfter;
        }

        public static SpaHtmlByteTemplate Create(ReadOnlySpan<byte> templateBytes)
        {
            if (templateBytes.IsEmpty)
            {
                return Empty;
            }

            string html = Encoding.UTF8.GetString(templateBytes);
            CspNonceHtmlTemplate cspTemplate = BuildCspNonceHtmlTemplate(html);
            string patchedHtml = cspTemplate.HasPlaceholders ? cspTemplate.Html : html;
            int headClose = patchedHtml.IndexOf("</head>", StringComparison.OrdinalIgnoreCase);
            if (headClose < 0)
            {
                return new SpaHtmlByteTemplate(
                    NoncePatchedByteTemplate.Create(patchedHtml),
                    NoncePatchedByteTemplate.Empty);
            }

            return new SpaHtmlByteTemplate(
                NoncePatchedByteTemplate.Create(patchedHtml[..headClose]),
                NoncePatchedByteTemplate.Create(patchedHtml[headClose..]));
        }

        public int GetLength(int nonceLength, int headInjectionLength)
            => _beforeHeadClose.GetLength(nonceLength)
                + headInjectionLength
                + _headCloseAndAfter.GetLength(nonceLength);

        public void Write(PipeWriter writer, ReadOnlySpan<byte> nonce, ReadOnlySpan<byte> headInjection)
        {
            _beforeHeadClose.Write(writer, nonce);
            WriteBytes(writer, headInjection);
            _headCloseAndAfter.Write(writer, nonce);
        }
    }

    private sealed class NoncePatchedByteTemplate
    {
        public static NoncePatchedByteTemplate Empty { get; } = new([], 0, 0);

        private readonly byte[][] _segments;
        private readonly int _placeholderCount;
        private readonly int _lengthWithoutNonce;

        private NoncePatchedByteTemplate(byte[][] segments, int placeholderCount, int lengthWithoutNonce)
        {
            _segments = segments;
            _placeholderCount = placeholderCount;
            _lengthWithoutNonce = lengthWithoutNonce;
        }

        public static NoncePatchedByteTemplate Create(string source)
        {
            if (string.IsNullOrEmpty(source))
            {
                return Empty;
            }

            var segments = new List<byte[]>();
            int lengthWithoutNonce = 0;
            int placeholderCount = 0;
            int position = 0;
            while (position < source.Length)
            {
                int placeholder = source.IndexOf(CspNonceTemplatePlaceholder, position, StringComparison.Ordinal);
                if (placeholder < 0)
                {
                    byte[] segment = Encoding.UTF8.GetBytes(source[position..]);
                    segments.Add(segment);
                    lengthWithoutNonce += segment.Length;
                    break;
                }

                byte[] before = Encoding.UTF8.GetBytes(source[position..placeholder]);
                segments.Add(before);
                lengthWithoutNonce += before.Length;
                placeholderCount++;
                position = placeholder + CspNonceTemplatePlaceholder.Length;
            }

            if (source.EndsWith(CspNonceTemplatePlaceholder, StringComparison.Ordinal))
            {
                segments.Add([]);
            }

            return new NoncePatchedByteTemplate([.. segments], placeholderCount, lengthWithoutNonce);
        }

        public int GetLength(int nonceLength)
            => _lengthWithoutNonce + _placeholderCount * nonceLength;

        public void Write(PipeWriter writer, ReadOnlySpan<byte> nonce)
        {
            for (int i = 0; i < _segments.Length; i++)
            {
                WriteBytes(writer, _segments[i]);
                if (i < _placeholderCount)
                {
                    WriteBytes(writer, nonce);
                }
            }
        }
    }

    private static void WriteBytes(PipeWriter writer, ReadOnlySpan<byte> bytes)
    {
        if (bytes.IsEmpty)
        {
            return;
        }

        bytes.CopyTo(writer.GetSpan(bytes.Length));
        writer.Advance(bytes.Length);
    }

    private sealed record CspNonceHtmlTemplate(string Html, bool HasPlaceholders)
    {
        public static CspNonceHtmlTemplate Unchanged { get; } = new(string.Empty, false);
    }
}
