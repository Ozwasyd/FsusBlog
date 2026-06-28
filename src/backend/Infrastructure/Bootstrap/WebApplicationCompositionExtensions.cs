using System.Collections.Concurrent;
using System.Buffers;
using System.IO.Compression;
using System.Net;
using System.Text;
using System.Text.Json;
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
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Primitives;

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
    private const string PublicAotHydrationSidecarMediaType = "application/vnd.fsus.aeds";
    private const string ImmutableStaticAssetCacheControl = "public,max-age=31536000,immutable";

    private const string CspNonceContextKey = "__fsusblog_csp_nonce";
    private const string CspNonceTemplatePlaceholder = "%%FSUSBLOG_CSP_NONCE%%";
    private const string HtmlContentType = "text/html; charset=utf-8";
    private const int DefaultSpaHeadInjectionCacheMaxEntries = 256;
    private const int SpaFallbackCompressionMinBytes = 1024;
    private const string HeadInjectionKindRoutePreload = "route-preload";
    private const string HeadInjectionKindPublicAssetSet = "public-asset-set";
    private static readonly byte[] EmptyBytes = [];
    private static readonly ConditionalWeakTable<string, CspNonceHtmlTemplate> CspNonceHtmlTemplates = new();
    private static readonly ConditionalWeakTable<byte[], SpaHtmlByteTemplate> SpaHtmlByteTemplates = new();
    private static readonly ConcurrentDictionary<HeadInjectionCacheKey, CachedHeadInjection> SpaHeadInjectionCache = new();
    private static long SpaHeadInjectionBuildCount;
    private static long SpaHeadInjectionHitCount;

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
        app.Use(async (ctx, next) =>
        {
            if (IsManifestRequest(ctx.Request))
            {
                var systemService = ctx.RequestServices.GetRequiredService<ISystemService>();
                SeoConfigReadModel seo = await systemService.GetSeoConfigAsync();
                await WriteDynamicManifestAsync(ctx, seo);
                return;
            }

            await next();
        });

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
        app.UseMiddleware<AnonymousGatewayHeaderGuardMiddleware>();
        app.UseAuthentication();
        app.UseRateLimiter();
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
        app.MapLocalAuthFixtureEndpoints();
        app.MapNotificationStreamDrillEndpoints();
        app.MapProductionHealthEndpoints();
    }

    private static void MapFsusApiRoutes(this WebApplication app)
    {
        app.MapBinaryEndpoints();
        app.MapAuthoringEndpoints();
        app.MapSecurityEndpoints();
        app.MapPublicAotEndpoints();

        app.MapGet("/api/notifications/stream/preflight", (
            HttpContext ctx,
            INotificationStreamHandshakeService handshakeService,
            IAedsEncoder aeds,
            CancellationToken ct) => ValidateNotificationStreamPreflightAsync(ctx, handshakeService, aeds, ct))
            .AllowAnonymous()
            .RequireRateLimiting("notification_stream")
            .WithMetadata(new FsusRouteKindMetadata("notification-stream"));
        app.MapGet("/api/notifications/stream", (
            HttpContext ctx,
            INotificationStreamHandler handler,
            CancellationToken ct) => handler.HandleAsync(ctx, ct))
            .AllowAnonymous()
            .RequireRateLimiting("notification_stream")
            .WithMetadata(new FsusRouteKindMetadata("notification-stream"));
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
            ISystemService systemService,
            IWebHostEnvironment env,
            StartupRuntimeState runtimeState,
            CancellationToken ct) => ServePublicShellOrIndexAsync(ctx, shellService, assetService, systemService, env, runtimeState, ct))
            .AllowAnonymous()
            .WithMetadata(new FsusRouteKindMetadata("public"));
        app.MapFallback((
            HttpContext ctx,
            IPublicAotShellService shellService,
            ISpaAssetManifestService assetService,
            ISystemService systemService,
            IWebHostEnvironment env,
            StartupRuntimeState runtimeState,
            CancellationToken ct) => ServePublicShellOrIndexAsync(ctx, shellService, assetService, systemService, env, runtimeState, ct))
            .WithMetadata(new FsusRouteKindMetadata("public"));
    }

    private static async Task<IResult> ValidateNotificationStreamPreflightAsync(
        HttpContext ctx,
        INotificationStreamHandshakeService handshakeService,
        IAedsEncoder aeds,
        CancellationToken ct)
    {
        NotificationStreamHandshakeResult result = await handshakeService.ValidateAsync(ctx, ct, requireWebSocket: false);
        if (result.IsSuccess)
        {
            return TypedResults.NoContent();
        }

        ctx.Response.Headers["X-Fsus-Notification-Stream-Error-Code"] = result.ErrorCode ?? "notification_handshake_failed";
        ctx.Response.Headers["X-Fsus-Notification-Stream-Status-Code"] = result.StatusCode.ToString(System.Globalization.CultureInfo.InvariantCulture);
        ErrorDetail error = ApiErrorSemanticMapper.CreateError(
            result.StatusCode,
            result.ErrorCode ?? "notification_handshake_failed",
            ctx.TraceIdentifier);
        return BinaryResults.FromError(error, aeds, result.StatusCode);
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
        headers["X-Content-Type-Options"] = "nosniff";

        if (string.Equals(requestPath, "/sw.js", StringComparison.Ordinal)
            || string.Equals(requestPath, "/search/index.manifest.aeds", StringComparison.Ordinal)
            || string.Equals(requestPath, "/search/index.bin", StringComparison.Ordinal)
            || string.Equals(requestPath, "/favicon.svg", StringComparison.Ordinal)
            || string.Equals(requestPath, "/manifest.webmanifest", StringComparison.Ordinal))
        {
            headers["Cache-Control"] = "no-cache";
            return;
        }

        if (IsPublicAotHydrationSidecarPath(requestPath))
        {
            ctx.Context.Response.ContentType = PublicAotHydrationSidecarMediaType;
            headers["Cache-Control"] = ImmutableStaticAssetCacheControl;
            headers.Remove("ETag");
            headers.Remove("Last-Modified");
            return;
        }

        if (requestPath.StartsWith("/search/patches/", StringComparison.Ordinal)
            || IsImmutableSearchIndexAssetPath(requestPath.AsSpan())
            || requestPath.StartsWith("/search/dictionaries/", StringComparison.Ordinal))
        {
            headers["Cache-Control"] = ImmutableStaticAssetCacheControl;
            headers.Remove("ETag");
            headers.Remove("Last-Modified");
            return;
        }

        if (ctx.File.Name.EndsWith(".js", StringComparison.OrdinalIgnoreCase)
            || ctx.File.Name.EndsWith(".css", StringComparison.OrdinalIgnoreCase)
            || ctx.File.Name.EndsWith(".wasm", StringComparison.OrdinalIgnoreCase)
            || ctx.File.Name.EndsWith(".woff", StringComparison.OrdinalIgnoreCase)
            || ctx.File.Name.EndsWith(".woff2", StringComparison.OrdinalIgnoreCase)
            || ctx.File.Name.EndsWith(".ttf", StringComparison.OrdinalIgnoreCase)
            || ctx.File.Name.EndsWith(".otf", StringComparison.OrdinalIgnoreCase))
        {
            headers["Cache-Control"] = ImmutableStaticAssetCacheControl;
            headers.Remove("ETag");
            headers.Remove("Last-Modified");
        }
    }

    internal static bool IsPublicAotHydrationSidecarPath(string path)
        => path.StartsWith("/aot-cache/payloads/", StringComparison.Ordinal)
            && path.EndsWith(".aeds", StringComparison.Ordinal);

    private static bool IsManifestRequest(HttpRequest request)
        => (HttpMethods.IsGet(request.Method) || HttpMethods.IsHead(request.Method))
            && string.Equals(request.Path.Value, "/manifest.webmanifest", StringComparison.Ordinal);

    private static async Task WriteDynamicManifestAsync(HttpContext ctx, SeoConfigReadModel seo)
    {
        var icons = new List<Dictionary<string, string>>(3);
        AddManifestIcon(icons, seo.PwaIcon192Url, "192x192", "image/png", "any");
        AddManifestIcon(icons, seo.PwaIcon512Url, "512x512", "image/png", "any");
        AddManifestIcon(icons, seo.PwaMaskableIconUrl, "512x512", "image/png", "maskable");

        var manifest = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["name"] = string.IsNullOrWhiteSpace(seo.ManifestName) ? seo.Title : seo.ManifestName,
            ["short_name"] = string.IsNullOrWhiteSpace(seo.ManifestShortName) ? seo.Title : seo.ManifestShortName,
            ["description"] = seo.Description,
            ["start_url"] = "/",
            ["scope"] = "/",
            ["display"] = "standalone",
            ["background_color"] = seo.BackgroundColor,
            ["theme_color"] = seo.ThemeColor,
            ["icons"] = icons
        };

        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(manifest);
        ctx.Response.StatusCode = StatusCodes.Status200OK;
        ctx.Response.ContentType = "application/manifest+json; charset=utf-8";
        ctx.Response.ContentLength = bytes.Length;
        ctx.Response.Headers["Cache-Control"] = "no-cache";
        ctx.Response.Headers.Remove("ETag");
        ctx.Response.Headers.Remove("Last-Modified");
        if (HttpMethods.IsHead(ctx.Request.Method))
        {
            return;
        }

        await ctx.Response.BodyWriter.WriteAsync(bytes, ctx.RequestAborted);
    }

    private static void AddManifestIcon(List<Dictionary<string, string>> icons, string src, string sizes, string type, string purpose)
    {
        if (string.IsNullOrWhiteSpace(src))
        {
            return;
        }

        icons.Add(new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["src"] = src,
            ["sizes"] = sizes,
            ["type"] = type,
            ["purpose"] = purpose
        });
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
        ISystemService systemService,
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
            PublicAotCacheEntry? aotEntry = await shellService.RenderAsync(ctx, aotMatch, ct);
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
            string assetMode = ctx.Items.TryGetValue(PublicAotShellService.PublicAotAssetModeContextKey, out object? assetModeObj)
                ? assetModeObj?.ToString() ?? "unknown"
                : "unknown";
            FsusObservability.RecordAotRender(
                source,
                backfill,
                aotEntry is null ? "fallback" : "hit",
                FsusObservability.GetElapsed(aotStartedAt));
            if (aotEntry is not null)
            {
                await WritePublicAotHtmlEntryAsync(ctx, env, aotEntry, source, version, backfill, state, assetMode, ct);
                return TypedResults.Empty;
            }
        }

        SpaAssetSet? publicAssetSet = isPublicAotRoute ? assetService.GetPublicAssetSet(ctx, aotMatch.PageId) : null;
        bool preferSourceTemplate = publicAssetSet?.UsesSourceAssets == true || IsDevelopmentViteProxyRequest(env, ctx);
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
        string spaAssetMode = ctx.Items.TryGetValue(PublicAotShellService.PublicAotAssetModeContextKey, out object? spaAssetModeObj)
            ? spaAssetModeObj?.ToString() ?? "unknown"
            : publicAssetSet?.UsesSourceAssets == true ? "dev-source-assets" : "unknown";
        ctx.Response.Headers["X-Fsus-Public-Aot-Source"] = spaSource;
        ctx.Response.Headers["X-Fsus-Public-Aot-Version"] = spaVersion;
        ctx.Response.Headers["X-Fsus-Public-Aot-Backfill"] = spaBackfill;
        ctx.Response.Headers["X-Fsus-Public-Aot-State"] = spaState;
        ctx.Response.Headers["X-Fsus-Public-Aot-Asset-Mode"] = spaAssetMode;
        ctx.Response.Headers["Cache-Control"] = "no-cache";
        ctx.Response.Headers.Remove("ETag");
        ctx.Response.Headers.Remove("Last-Modified");

        if (runtimeState.SystemCachesClearedOnStartup)
        {
            ctx.Response.Headers["Clear-Site-Data"] = "\"cache\"";
        }

        ReadOnlyMemory<byte> templateBytes = await PublicSpaTemplateLocator.ReadIndexTemplateBytesAsync(env, ct, preferSourceTemplate);
        SeoConfigReadModel seo = await systemService.GetSeoConfigAsync();
        ReadOnlyMemory<byte> seoHeadInjection = BuildSeoBrandHeadInjection(seo);

        string path = ctx.Request.Path.Value ?? string.Empty;
        if (templateBytes.Length > 0)
        {
            var preloads = assetService.GetPreloadsForPath(path, ctx);
            if (preloads.Count > 0)
            {
                ReadOnlyMemory<byte> headInjection = GetCachedRoutePreloadHeadInjection(
                    assetService.GetFrontendAssetVersion(ctx),
                    path,
                    preloads);
                await WriteSpaHtmlResponseAsync(ctx, env, templateBytes, CombineHeadInjections(seoHeadInjection, headInjection), ct);
                return TypedResults.Empty;
            }
            if (publicAssetSet is not null)
            {
                string routeKey = isPublicAotRoute ? aotMatch.RouteKey : path;
                ReadOnlyMemory<byte> headInjection = GetCachedPublicAssetHeadInjection(routeKey, publicAssetSet);
                await WriteSpaHtmlResponseAsync(ctx, env, templateBytes, CombineHeadInjections(seoHeadInjection, headInjection), ct);
                return TypedResults.Empty;
            }
        }

        await WriteSpaHtmlResponseAsync(ctx, env, templateBytes, seoHeadInjection, ct);

        return TypedResults.Empty;
    }

    private static bool IsDevelopmentViteProxyRequest(IWebHostEnvironment env, HttpContext ctx)
    {
        if (!env.IsDevelopment())
        {
            return false;
        }

        string forwardedHost = ctx.Request.Headers["X-Forwarded-Host"].ToString();
        string host = string.IsNullOrWhiteSpace(forwardedHost)
            ? ctx.Request.Host.Value ?? string.Empty
            : forwardedHost;

        return host.Contains(":3000", StringComparison.Ordinal);
    }

    private static async Task WritePublicAotHtmlEntryAsync(
        HttpContext ctx,
        IWebHostEnvironment env,
        PublicAotCacheEntry entry,
        string source,
        string version,
        string backfill,
        string state,
        string assetMode,
        CancellationToken cancellationToken)
    {
        PublicAotHtmlArtifact document = entry.GetDocument();
        SetPublicAotHtmlHeaders(ctx, document, source, version, backfill, state, assetMode);
        EnsureHtmlCspHeader(ctx, env);

        if (document.RequiresCspNonceMutation)
        {
            await WritePublicAotHtmlSlowPathAsync(ctx, entry.GetHtml(), cancellationToken);
            return;
        }

        if (!PublicAotHtmlResponseNegotiation.TrySelectVariant(
                ctx.Request.Headers.AcceptEncoding,
                document,
                out PublicAotHtmlArtifactVariant variant))
        {
            ctx.Response.StatusCode = StatusCodes.Status406NotAcceptable;
            ctx.Response.ContentLength = 0;
            return;
        }

        HttpResponse response = ctx.Response;
        response.StatusCode = StatusCodes.Status200OK;
        response.ContentType = string.IsNullOrWhiteSpace(document.ContentType) ? HtmlContentType : document.ContentType;
        response.ContentLength = variant.Bytes.Length;
        if (string.IsNullOrWhiteSpace(variant.ContentEncoding))
        {
            response.Headers.Remove("Content-Encoding");
        }
        else
        {
            response.Headers["Content-Encoding"] = variant.ContentEncoding;
        }

        if (!string.IsNullOrWhiteSpace(variant.ETag))
        {
            response.Headers["ETag"] = variant.ETag;
        }
        else
        {
            response.Headers.Remove("ETag");
        }

        if (PublicAotHtmlResponseNegotiation.MatchesIfNoneMatch(ctx.Request.Headers.IfNoneMatch, variant.ETag))
        {
            response.StatusCode = StatusCodes.Status304NotModified;
            response.ContentLength = 0;
            return;
        }

        if (HttpMethods.IsHead(ctx.Request.Method) || variant.Bytes.IsEmpty)
        {
            return;
        }

        ValueTask<FlushResult> write = response.BodyWriter.WriteAsync(variant.Bytes, cancellationToken);
        if (!write.IsCompletedSuccessfully)
        {
            await write;
        }
    }

    private static async Task WritePublicAotHtmlSlowPathAsync(
        HttpContext ctx,
        string html,
        CancellationToken cancellationToken)
    {
        // CSP nonce mutation changes the document per request, so precomputed
        // compressed variants and ETags are intentionally skipped on this path.
        html = ApplyCspNonceToHtml(ctx, html);
        byte[] bytes = Encoding.UTF8.GetBytes(html);
        HttpResponse response = ctx.Response;
        response.StatusCode = StatusCodes.Status200OK;
        response.ContentType = HtmlContentType;
        response.ContentLength = bytes.Length;
        response.Headers.Remove("Content-Encoding");
        response.Headers.Remove("ETag");
        if (HttpMethods.IsHead(ctx.Request.Method) || bytes.Length == 0)
        {
            return;
        }

        ValueTask<FlushResult> write = response.BodyWriter.WriteAsync(bytes, cancellationToken);
        if (!write.IsCompletedSuccessfully)
        {
            await write;
        }
    }

    private static void SetPublicAotHtmlHeaders(
        HttpContext ctx,
        PublicAotHtmlArtifact document,
        string source,
        string version,
        string backfill,
        string state,
        string assetMode)
    {
        var headers = ctx.Response.Headers;
        headers["X-Fsus-Public-Aot-Source"] = source;
        headers["X-Fsus-Public-Aot-Version"] = version;
        headers["X-Fsus-Public-Aot-Backfill"] = backfill;
        headers["X-Fsus-Public-Aot-State"] = state;
        headers["X-Fsus-Public-Aot-Asset-Mode"] = string.IsNullOrWhiteSpace(assetMode) ? "unknown" : assetMode;

        headers["Cache-Control"] = string.IsNullOrWhiteSpace(document.CacheControl)
            ? PublicAotHtmlArtifactOptions.DefaultCacheControl
            : document.CacheControl;
        EnsureAcceptEncodingVary(headers);
        headers["Accept-Ranges"] = "none";
        headers.Remove("Last-Modified");
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
        => BuildStaticCsp(env.IsDevelopment());

    internal static string BuildStaticCsp(bool isDevelopment)
        => isDevelopment
            ? "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob: http: https:; font-src 'self' data:; connect-src 'self' http://127.0.0.1:3000 http://localhost:3000 http://127.0.0.1:7568 http://localhost:7568 ws://127.0.0.1:3000 ws://localhost:3000 ws://127.0.0.1:7568 ws://localhost:7568; worker-src 'self' blob:;"
            : "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob: http: https:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:;";

    private static string BuildHtmlCsp(IWebHostEnvironment env, string nonce)
        => BuildHtmlCsp(env.IsDevelopment(), nonce);

    internal static string BuildHtmlCsp(bool isDevelopment, string nonce)
        => isDevelopment
            ? $"default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self' 'wasm-unsafe-eval' 'nonce-{nonce}'; style-src 'self' 'nonce-{nonce}'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob: http: https:; font-src 'self' data:; connect-src 'self' http://127.0.0.1:3000 http://localhost:3000 http://127.0.0.1:7568 http://localhost:7568 ws://127.0.0.1:3000 ws://localhost:3000 ws://127.0.0.1:7568 ws://localhost:7568; worker-src 'self' blob:;"
            : $"default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self' 'wasm-unsafe-eval' 'nonce-{nonce}'; style-src 'self' 'nonce-{nonce}'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob: http: https:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:;";

    internal static string EnsureCspNonce(HttpContext ctx)
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
        => WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(16));

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
        EnsureAcceptEncodingVary(ctx.Response.Headers);

        ArrayBufferWriter<byte> output = new(Math.Max(contentLength, 0));
        template.Write(output, nonceBytes.Span, headInjection.Span);
        if (!TrySelectSpaHtmlResponseVariant(
                ctx.Request.Headers.AcceptEncoding,
                output.WrittenMemory,
                out PublicAotHtmlArtifactVariant variant))
        {
            ctx.Response.StatusCode = StatusCodes.Status406NotAcceptable;
            ctx.Response.ContentLength = 0;
            ctx.Response.Headers.Remove("Content-Encoding");
            return;
        }

        ctx.Response.ContentLength = variant.Bytes.Length;
        if (string.IsNullOrWhiteSpace(variant.ContentEncoding))
        {
            ctx.Response.Headers.Remove("Content-Encoding");
        }
        else
        {
            ctx.Response.Headers["Content-Encoding"] = variant.ContentEncoding;
        }

        if (HttpMethods.IsHead(ctx.Request.Method) || variant.Bytes.IsEmpty)
        {
            return;
        }

        ValueTask<FlushResult> write = ctx.Response.BodyWriter.WriteAsync(variant.Bytes, cancellationToken);
        if (!write.IsCompletedSuccessfully)
        {
            await write;
        }
    }

    private static bool TrySelectSpaHtmlResponseVariant(
        StringValues acceptEncoding,
        ReadOnlyMemory<byte> identityBytes,
        out PublicAotHtmlArtifactVariant variant)
    {
        ReadOnlyMemory<byte> brotliBytes = EmptyBytes;
        ReadOnlyMemory<byte> gzipBytes = EmptyBytes;
        if (identityBytes.Length >= SpaFallbackCompressionMinBytes)
        {
            brotliBytes = TryCompressSpaHtml(identityBytes.Span, "br") ?? EmptyBytes;
            gzipBytes = TryCompressSpaHtml(identityBytes.Span, "gzip") ?? EmptyBytes;
        }

        var document = new PublicAotHtmlArtifact(
            identityBytes,
            string.Empty,
            brotliBytes,
            string.Empty,
            gzipBytes,
            string.Empty,
            HtmlContentType,
            PublicAotHtmlArtifactOptions.DefaultCacheControl,
            string.Empty,
            string.Empty,
            RequiresCspNonceMutation: false);
        return PublicAotHtmlResponseNegotiation.TrySelectVariant(acceptEncoding, document, out variant);
    }

    private static byte[]? TryCompressSpaHtml(ReadOnlySpan<byte> bytes, string encoding)
    {
        using var output = new MemoryStream();
        if (encoding == "br")
        {
            using (var brotli = new BrotliStream(output, CompressionLevel.Fastest, leaveOpen: true))
            {
                brotli.Write(bytes);
            }
        }
        else
        {
            using (var gzip = new GZipStream(output, CompressionLevel.Fastest, leaveOpen: true))
            {
                gzip.Write(bytes);
            }
        }

        return output.Length < bytes.Length ? output.ToArray() : null;
    }

    private static void EnsureAcceptEncodingVary(IHeaderDictionary headers)
    {
        string existing = headers.Vary.ToString();
        if (string.IsNullOrWhiteSpace(existing))
        {
            headers["Vary"] = "Accept-Encoding";
            return;
        }

        foreach (string segment in existing.Split(','))
        {
            if (string.Equals(segment.Trim(), "Accept-Encoding", StringComparison.OrdinalIgnoreCase))
            {
                return;
            }
        }

        headers["Vary"] = string.Concat(existing, ", Accept-Encoding");
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

    private static ReadOnlyMemory<byte> GetCachedRoutePreloadHeadInjection(
        string assetVersion,
        string routeKey,
        IReadOnlyList<string> preloads)
    {
        if (preloads.Count == 0)
        {
            return EmptyBytes;
        }

        var key = new HeadInjectionCacheKey(
            NormalizeHeadInjectionCacheSegment(assetVersion, "missing-manifest"),
            NormalizeHeadInjectionCacheSegment(routeKey, "/"),
            HeadInjectionKindRoutePreload);
        CachedHeadInjection cached = GetOrAddHeadInjection(
            key,
            preloads.Count,
            () => BuildRoutePreloadHeadInjection(preloads));
        return cached.Bytes;
    }

    private static ReadOnlyMemory<byte> GetCachedPublicAssetHeadInjection(string routeKey, SpaAssetSet publicAssetSet)
    {
        int assetCount = publicAssetSet.ModulePreloads.Count + publicAssetSet.Stylesheets.Count;
        if (assetCount == 0)
        {
            return EmptyBytes;
        }

        var key = new HeadInjectionCacheKey(
            NormalizeHeadInjectionCacheSegment(publicAssetSet.FrontendAssetVersion, "missing-manifest"),
            NormalizeHeadInjectionCacheSegment(routeKey, "/"),
            HeadInjectionKindPublicAssetSet);
        CachedHeadInjection cached = GetOrAddHeadInjection(
            key,
            assetCount,
            () => BuildPublicAssetHeadInjection(publicAssetSet));
        return cached.Bytes;
    }

    private static CachedHeadInjection GetOrAddHeadInjection(
        HeadInjectionCacheKey key,
        int assetCount,
        Func<ReadOnlyMemory<byte>> build)
    {
        if (SpaHeadInjectionCache.TryGetValue(key, out CachedHeadInjection cached))
        {
            Interlocked.Increment(ref SpaHeadInjectionHitCount);
            return cached;
        }

        if (SpaHeadInjectionCache.Count >= DefaultSpaHeadInjectionCacheMaxEntries)
        {
            SpaHeadInjectionCache.Clear();
        }

        return SpaHeadInjectionCache.GetOrAdd(
            key,
            static (cacheKey, state) =>
            {
                Interlocked.Increment(ref SpaHeadInjectionBuildCount);
                return new CachedHeadInjection(state.Build(), state.AssetCount, cacheKey.AssetVersion);
            },
            (Build: build, AssetCount: assetCount));
    }

    private static string NormalizeHeadInjectionCacheSegment(string value, string fallback)
    {
        string normalized = value.Trim();
        return normalized.Length == 0 ? fallback : normalized;
    }

    internal static void ResetSpaHeadInjectionCacheForTests()
    {
        SpaHeadInjectionCache.Clear();
        Interlocked.Exchange(ref SpaHeadInjectionBuildCount, 0);
        Interlocked.Exchange(ref SpaHeadInjectionHitCount, 0);
    }

    internal static SpaHeadInjectionCacheStats GetSpaHeadInjectionCacheStatsForTests()
        => new(
            SpaHeadInjectionCache.Count,
            Volatile.Read(ref SpaHeadInjectionBuildCount),
            Volatile.Read(ref SpaHeadInjectionHitCount));

    internal static ReadOnlyMemory<byte> GetRoutePreloadHeadInjectionForTests(
        string assetVersion,
        string routeKey,
        IReadOnlyList<string> preloads)
        => GetCachedRoutePreloadHeadInjection(assetVersion, routeKey, preloads);

    internal static ReadOnlyMemory<byte> GetPublicAssetHeadInjectionForTests(string routeKey, SpaAssetSet publicAssetSet)
        => GetCachedPublicAssetHeadInjection(routeKey, publicAssetSet);

    internal static ReadOnlyMemory<byte> GetSeoBrandHeadInjectionForTests(SeoConfigReadModel seo)
        => BuildSeoBrandHeadInjection(seo);

    internal static async Task<string> RenderSpaHtmlForTestsAsync(
        string templateHtml,
        ReadOnlyMemory<byte> headInjection,
        string nonce)
    {
        SpaHtmlByteTemplate template = GetSpaHtmlByteTemplate(Encoding.UTF8.GetBytes(templateHtml));
        string encodedNonce = System.Net.WebUtility.HtmlEncode(nonce);
        await using var output = new MemoryStream();
        PipeWriter writer = PipeWriter.Create(output);
        template.Write(writer, Encoding.UTF8.GetBytes(encodedNonce), headInjection.Span);
        await writer.FlushAsync();
        await writer.CompleteAsync();
        return Encoding.UTF8.GetString(output.ToArray());
    }

    internal static Task WriteSpaHtmlResponseForTestsAsync(
        HttpContext ctx,
        IWebHostEnvironment env,
        string templateHtml,
        ReadOnlyMemory<byte> headInjection)
        => WriteSpaHtmlResponseAsync(
            ctx,
            env,
            Encoding.UTF8.GetBytes(templateHtml),
            headInjection,
            CancellationToken.None);

    internal static Task WritePublicAotHtmlEntryForTestsAsync(
        HttpContext ctx,
        IWebHostEnvironment env,
        PublicAotCacheEntry entry,
        string state = "fresh")
        => WritePublicAotHtmlEntryAsync(
            ctx,
            env,
            entry,
            entry.Source.ToHeaderValue(),
            entry.RendererVersion,
            "none",
            state,
            "prod-manifest",
            CancellationToken.None);

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

    private static ReadOnlyMemory<byte> BuildSeoBrandHeadInjection(SeoConfigReadModel seo)
    {
        var sb = new StringBuilder(512);
        AppendMeta(sb, "theme-color", seo.ThemeColor);
        AppendLink(sb, "icon", seo.FaviconSvgUrl, "image/svg+xml");
        AppendLink(sb, "icon", seo.FaviconIcoUrl, "image/x-icon");
        AppendLink(sb, "icon", seo.FaviconPngUrl, "image/png");
        AppendLink(sb, "apple-touch-icon", seo.AppleTouchIconUrl, null);
        AppendMetaProperty(sb, "og:image", seo.OgImage);
        AppendMeta(sb, "twitter:image", seo.OgImage);
        return sb.Length == 0 ? EmptyBytes : Encoding.UTF8.GetBytes(sb.ToString());
    }

    private static ReadOnlyMemory<byte> CombineHeadInjections(ReadOnlyMemory<byte> first, ReadOnlyMemory<byte> second)
    {
        if (first.IsEmpty)
        {
            return second;
        }

        if (second.IsEmpty)
        {
            return first;
        }

        byte[] bytes = new byte[first.Length + second.Length];
        first.Span.CopyTo(bytes);
        second.Span.CopyTo(bytes.AsSpan(first.Length));
        return bytes;
    }

    private static void AppendMeta(StringBuilder sb, string name, string content)
    {
        if (string.IsNullOrWhiteSpace(content))
        {
            return;
        }

        sb.Append("    <meta name=\"")
            .Append(WebUtility.HtmlEncode(name))
            .Append("\" content=\"")
            .Append(WebUtility.HtmlEncode(content))
            .AppendLine("\" data-fsusblog-seo=\"runtime\" />");
    }

    private static void AppendMetaProperty(StringBuilder sb, string property, string content)
    {
        if (string.IsNullOrWhiteSpace(content))
        {
            return;
        }

        sb.Append("    <meta property=\"")
            .Append(WebUtility.HtmlEncode(property))
            .Append("\" content=\"")
            .Append(WebUtility.HtmlEncode(content))
            .AppendLine("\" data-fsusblog-seo=\"runtime\" />");
    }

    private static void AppendLink(StringBuilder sb, string rel, string href, string? type)
    {
        if (string.IsNullOrWhiteSpace(href))
        {
            return;
        }

        sb.Append("    <link rel=\"")
            .Append(WebUtility.HtmlEncode(rel))
            .Append('"');
        if (!string.IsNullOrWhiteSpace(type))
        {
            sb.Append(" type=\"")
                .Append(WebUtility.HtmlEncode(type))
                .Append('"');
        }

        sb.Append(" href=\"")
            .Append(WebUtility.HtmlEncode(href))
            .AppendLine("\" data-fsusblog-seo=\"runtime\" />");
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

        public void Write(IBufferWriter<byte> writer, ReadOnlySpan<byte> nonce, ReadOnlySpan<byte> headInjection)
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

        public void Write(IBufferWriter<byte> writer, ReadOnlySpan<byte> nonce)
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

    private static void WriteBytes(IBufferWriter<byte> writer, ReadOnlySpan<byte> bytes)
    {
        if (bytes.IsEmpty)
        {
            return;
        }

        bytes.CopyTo(writer.GetSpan(bytes.Length));
        writer.Advance(bytes.Length);
    }

    private readonly record struct HeadInjectionCacheKey(
        string AssetVersion,
        string RouteKey,
        string Kind);

    private readonly record struct CachedHeadInjection(
        ReadOnlyMemory<byte> Bytes,
        int AssetCount,
        string AssetVersion);

    internal readonly record struct SpaHeadInjectionCacheStats(
        int EntryCount,
        long BuildCount,
        long HitCount);

    private sealed record CspNonceHtmlTemplate(string Html, bool HasPlaceholders)
    {
        public static CspNonceHtmlTemplate Unchanged { get; } = new(string.Empty, false);
    }
}
