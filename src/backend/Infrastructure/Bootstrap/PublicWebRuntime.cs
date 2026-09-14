using System.Buffers;
using System.Collections.Concurrent;
using System.IO.Pipelines;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Helpers.Initializer;
using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Infrastructure.Spa;
using FsusBlog.Server.Infrastructure.Storage;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services;

using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Primitives;

namespace FsusBlog.Server.Infrastructure.Bootstrap;

internal static partial class PublicWebRuntime
{
    private const string PublicAotHydrationSidecarMediaType = "application/vnd.fsus.aeds";
    private const string ImmutableStaticAssetCacheControl = "public,max-age=31536000,immutable";

    private const string CspNonceContextKey = "__fsusblog_csp_nonce";
    private const string CspNonceTemplatePlaceholder = "%%FSUSBLOG_CSP_NONCE%%";
    private const string HtmlContentType = "text/html; charset=utf-8";
    private const int DefaultSpaHeadInjectionCacheMaxEntries = 256;
    private const int DefaultSpaTemplateCacheMaxEntries = 64;
    private const string HeadInjectionKindRoutePreload = "route-preload";
    private const string HeadInjectionKindPublicAssetSet = "public-asset-set";
    private static readonly byte[] s_emptyBytes = [];
    private static readonly byte[] s_searchNoIndexHeadInjection = Encoding.UTF8.GetBytes(
        "<meta name=\"robots\" content=\"noindex,follow\" data-fsus-search-head>\n");
    private static readonly ConcurrentDictionary<string, SpaHtmlByteTemplate> s_spaHtmlByteTemplates = new(StringComparer.Ordinal);
    private static readonly ConcurrentDictionary<HeadInjectionCacheKey, CachedHeadInjection> s_spaHeadInjectionCache = new();
    private static readonly ConcurrentDictionary<string, CachedDynamicManifest> s_dynamicManifestCache = new(StringComparer.Ordinal);
    private static long s_spaHeadInjectionBuildCount;
    private static long s_spaHeadInjectionHitCount;

    private sealed record CachedDynamicManifest(byte[] Bytes, string Etag);

    internal static void ReportHttp3TransportStartup(WebApplication app)
    {
        FsusHttp3TransportReport? report = app.Services.GetService<FsusHttp3TransportReport>();
        if (report is null)
        {
            return;
        }

        string fallbackReason = report.FallbackReasons.Count == 0
            ? "none"
            : string.Join(',', report.FallbackReasons);
        app.Logger.LogInformation(
            "HTTP/3 transport startup | Status={Status} EnabledRequested={EnabledRequested} EndpointConfigured={EndpointConfigured} QuicProbePerformed={QuicProbePerformed} QuicSupported={QuicSupported} HttpsCertificateReady={HttpsCertificateReady} EndpointConfigurationReady={EndpointConfigurationReady} Port={Port} FallbackReason={FallbackReason}",
            report.Status,
            report.EnabledRequested,
            report.EndpointConfigured,
            report.QuicProbePerformed,
            report.QuicSupported,
            report.HttpsCertificateReady,
            report.EndpointConfigurationReady,
            report.Port,
            fallbackReason);
        HttpTransportObservability.RecordHttp3Startup(report.Status, report.FallbackReasons);
    }

    internal static void UseFsusSecurityHeaders(this WebApplication app)
    {
        ReleaseIdentitySnapshot releaseIdentity = app.Services.GetRequiredService<IReleaseIdentityProvider>().Current;
        app.Use(async (ctx, next) =>
        {
            var headers = ctx.Response.Headers;
            ReleaseIdentityResponseHeaders.Apply(headers, releaseIdentity);
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
                headers["Content-Security-Policy"] = BuildHtmlCsp(
                    ShouldUseDevelopmentCspPolicy(app.Environment, app.Configuration),
                    nonce);
            }
            else
            {
                headers["Content-Security-Policy"] = BuildStaticCsp(
                    ShouldUseDevelopmentCspPolicy(app.Environment, app.Configuration));
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

    internal static void UseFsusCoreMiddlewares(this WebApplication app)
    {
        app.UseMiddleware<ShieldMiddleware>();
        app.UseMiddleware<GlobalExceptionMiddleware>();
        app.UseMiddleware<ApiBinaryResponseMiddleware>();
    }

    internal static void UseFsusTestSessionValidation(this WebApplication app)
    {
        if (HttpTestSessionKeyScope.IsIsolationEnabled(app.Environment))
        {
            app.UseMiddleware<TestSessionValidationMiddleware>();
        }
    }

    internal static void UseFsusEndpointRateLimiter(this IApplicationBuilder app)
        => app.UseWhen(
            static context => ShouldRunEndpointRateLimiter(context),
            static branch => branch.UseRateLimiter());

    internal static bool ShouldRunEndpointRateLimiter(HttpContext context)
    {
        PublicHotReadEarlyPipelineState? state = context.Features.Get<PublicHotReadEarlyPipelineState>();
        if (state?.RateLimitEvaluated != true)
        {
            return true;
        }

        state.MarkEndpointRateLimiterSkipped();
        return false;
    }

    internal static void UseFsusEndpointRequestAuditContext(this IApplicationBuilder app)
        => app.Use(next =>
        {
            var middleware = new RequestAuditContextMiddleware(next);
            return context =>
            {
                PublicHotReadEarlyPipelineState? state =
                    context.Features.Get<PublicHotReadEarlyPipelineState>();
                if (state?.RequestAuditContextEvaluated != true)
                {
                    return middleware.InvokeAsync(context);
                }

                state.MarkEndpointRequestAuditContextSkipped();
                return next(context);
            };
        });

    internal static void UseFsusStaticAssets(this WebApplication app)
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

        UseReleaseScopedStaticAssets(app);

        ReleaseStoragePaths storagePaths = app.Services.GetRequiredService<ReleaseStoragePaths>();
        var publicAssetProvider = new PhysicalFileProvider(storagePaths.PublicAssetRoot);
        app.Lifetime.ApplicationStopped.Register(publicAssetProvider.Dispose);
        app.UseStaticFiles(new StaticFileOptions
        {
            RequestPath = "/uploads",
            FileProvider = publicAssetProvider,
            ContentTypeProvider = provider,
            ServeUnknownFileTypes = false,
            OnPrepareResponse = PrepareStaticAssetResponse
        });

        PhysicalFileProvider authoritativeWebRoot = CreateAuthoritativeWebRootFileProvider(app.Environment);
        app.Lifetime.ApplicationStopped.Register(authoritativeWebRoot.Dispose);
        app.UseStaticFiles(new StaticFileOptions
        {
            FileProvider = authoritativeWebRoot,
            ContentTypeProvider = provider,
            OnPrepareResponse = PrepareStaticAssetResponse
        });

        if (app.Environment.IsDevelopment())
        {
            UseDevelopmentClientAssetFiles(app, provider);
        }
    }

    internal static PhysicalFileProvider CreateAuthoritativeWebRootFileProvider(IWebHostEnvironment environment)
    {
        ArgumentNullException.ThrowIfNull(environment);
        string webRootPath = Path.GetFullPath(environment.WebRootPath);
        if (!Directory.Exists(webRootPath))
        {
            throw new DirectoryNotFoundException($"Configured web root does not exist: {webRootPath}");
        }

        // Development static-web-assets can wrap WebRootFileProvider in a
        // CompositeFileProvider whose source-tree entry precedes a run-bound
        // ASPNETCORE_WEBROOT. Mutable search aliases must be read from the same
        // physical root that SearchIndexService atomically updates.
        return new PhysicalFileProvider(webRootPath);
    }

    private static void UseReleaseScopedStaticAssets(WebApplication app)
    {
        string? releaseAssetRoot = app.Configuration["FSUSBLOG_RELEASE_ASSET_ROOT"]
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_RELEASE_ASSET_ROOT");
        string? releaseDerivedRoot = app.Configuration["FSUSBLOG_RELEASE_DERIVED_ROOT"]
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_RELEASE_DERIVED_ROOT");
        if (app.Environment.IsProduction()
            && (string.IsNullOrWhiteSpace(releaseAssetRoot) || string.IsNullOrWhiteSpace(releaseDerivedRoot)))
        {
            throw new InvalidOperationException(
                "Production requires FSUSBLOG_RELEASE_ASSET_ROOT and FSUSBLOG_RELEASE_DERIVED_ROOT before SPA fallback registration.");
        }

        if (!string.IsNullOrWhiteSpace(releaseAssetRoot))
        {
            app.UseFsusReleaseAssets(releaseAssetRoot);
        }

        if (!string.IsNullOrWhiteSpace(releaseDerivedRoot))
        {
            app.UseFsusReleaseDerivedArtifacts(releaseDerivedRoot);
        }
    }

    internal static void UseFsusEndpointMetadataHeaders(this WebApplication app)
    {
        app.Use(async (ctx, next) =>
        {
            if (ctx.GetEndpoint()?.Metadata.GetMetadata<NoStoreResponseMetadata>() != null)
            {
                ctx.Response.OnStarting(static state =>
                {
                    var response = (HttpResponse)state;
                    if (!response.Headers.CacheControl.ToString().Contains("no-store", StringComparison.OrdinalIgnoreCase))
                    {
                        response.Headers.CacheControl = "no-store";
                    }

                    response.Headers["Pragma"] = "no-cache";
                    return Task.CompletedTask;
                }, ctx.Response);
            }

            await next();
        });
    }

    internal static void MapFsusOperationalRoutes(this WebApplication app)
    {
        app.MapLocalAuthFixtureEndpoints();
        app.MapLocalAccountProfilePreferenceFixtureEndpoints();
        app.MapLocalPublicContentFixtureEndpoints();
        app.MapLocalMessagingFixtureEndpoints();
        app.MapLocalCommentFixtureEndpoints();
        app.MapLocalAuditFixtureEndpoints();
        app.MapLocalDemoFixtureEndpoints();
        app.MapLocalSecurityFixtureEndpoints();
        app.MapNotificationStreamDrillEndpoints();
        app.MapRuntimeCacheEvidenceEndpoints();
        app.MapRuntimeCacheScenarioEvidenceEndpoints();
        app.MapRuntimeCacheDistributedL1EvidenceEndpoints();
        app.MapReleaseSchemaQualificationEndpoints();
        app.MapProductionHealthEndpoints();
        app.MapDeploymentControlEndpoints();
        app.MapActiveReleaseFenceEndpoints();
        app.MapNotificationStreamRestartEndpoints();
        app.MapNotificationStreamDeploymentDrillEndpoints();
        app.MapClusterMembershipEndpoints();
        app.MapThemeAdminEndpoints();
        app.MapCustomizationEndpoints();
        app.MapFontAdminEndpoints();
    }

    internal static void MapFsusApiRoutes(this WebApplication app)
    {
        app.MapPrivateAssetEndpoints();
        app.MapBinaryEndpoints();
        app.MapAuthoringEndpoints();
        app.MapCspReportEndpoints();
        app.MapSecurityEndpoints();
        app.MapAdminIntegrityConsoleEndpoints();
        app.MapPublicAotEndpoints();

        app.MapGet("/api/notifications/stream/preflight", (
            HttpContext ctx,
            [FromServices] INotificationStreamHandshakeService handshakeService,
            [FromServices] IAedsEncoder aeds,
            CancellationToken ct) => ValidateNotificationStreamPreflightAsync(ctx, handshakeService, aeds, ct))
            .AllowAnonymous()
            .RequireRateLimiting("notification_stream")
            .WithMetadata(new FsusRouteKindMetadata("notification-stream"));
        app.MapGet("/api/notifications/stream", (
            HttpContext ctx,
            [FromServices] INotificationStreamHandler handler,
            CancellationToken ct) => handler.HandleAsync(ctx, ct))
            .AllowAnonymous()
            .RequireRateLimiting("notification_stream")
            .WithMetadata(new FsusRouteKindMetadata("notification-stream"));
        app.Map("/api/{**path}", ([FromServices] IAedsEncoder aeds) =>
        {
            return BinaryResults.FromError(
                ErrorDetail.Create(ErrorCode.NotFound, "旧文本 API 已移除，请使用 /api/binary/** AEDS 二进制端点"),
                aeds,
                StatusCodes.Status404NotFound);
        }).WithMetadata(new FsusRouteKindMetadata("api"));
    }

    internal static void MapFsusPublicRoutes(this WebApplication app)
    {
        app.MapDistributionEndpoints();
        app.MapIntegrityVerificationEndpoints();

        app.MapGet("/", (
            HttpContext ctx,
            [FromServices] IPublicAotRouteIdentity routeIdentity,
            [FromServices] IPublicAotShellService shellService,
            [FromServices] ISpaAssetManifestService assetService,
            [FromServices] ISystemService systemService,
            [FromServices] IWebHostEnvironment env,
            [FromServices] StartupRuntimeState runtimeState,
            CancellationToken ct) => ServePublicShellOrIndexAsync(ctx, routeIdentity, shellService, assetService, systemService, env, runtimeState, ct))
            .AllowAnonymous()
            .RequireRateLimiting("public_read")
            .WithRiskAction(RiskActionNames.PublicRead, "public.html.home")
            .AddEndpointFilter<RiskAwarePublicReadFilter>()
            .WithMetadata(new FsusRouteKindMetadata("public"));
        app.MapFallback((
            HttpContext ctx,
            [FromServices] IPublicAotRouteIdentity routeIdentity,
            [FromServices] IPublicAotShellService shellService,
            [FromServices] ISpaAssetManifestService assetService,
            [FromServices] ISystemService systemService,
            [FromServices] IWebHostEnvironment env,
            [FromServices] StartupRuntimeState runtimeState,
            CancellationToken ct) => ServePublicShellOrIndexAsync(ctx, routeIdentity, shellService, assetService, systemService, env, runtimeState, ct))
            .RequireRateLimiting("public_read")
            .WithRiskAction(RiskActionNames.PublicRead, "public.html.fallback")
            .AddEndpointFilter<RiskAwarePublicReadFilter>()
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
            if (!string.IsNullOrWhiteSpace(result.PreflightGrantToken))
            {
                ctx.Response.Cookies.Append(
                    NotificationStreamRiskProofPolicy.PreflightGrantCookieName,
                    result.PreflightGrantToken,
                    new CookieOptions
                    {
                        HttpOnly = true,
                        Secure = ctx.Request.IsHttps,
                        SameSite = SameSiteMode.Strict,
                        Path = "/api/notifications/stream",
                        IsEssential = true
                    });
            }
            return TypedResults.NoContent();
        }

        ctx.Response.Headers["X-Fsus-Notification-Stream-Error-Code"] = result.ErrorCode ?? "notification_handshake_failed";
        ctx.Response.Headers["X-Fsus-Notification-Stream-Status-Code"] = result.StatusCode.ToString(System.Globalization.CultureInfo.InvariantCulture);
        if (result.StatusCode == StatusCodes.Status503ServiceUnavailable)
        {
            ctx.Response.Headers["Retry-After"] = "5";
        }
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
        provider.Mappings.Remove(".avif");
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
        string cacheKey = BuildDynamicManifestCacheKey(seo);
        CachedDynamicManifest cached = s_dynamicManifestCache.GetOrAdd(cacheKey, _ => BuildDynamicManifest(seo));
        ctx.Response.Headers["Cache-Control"] = "no-cache";
        ctx.Response.Headers["ETag"] = cached.Etag;
        if (HttpEntityTagPreconditions.MatchesIfNoneMatch(ctx.Request.Headers.IfNoneMatch, cached.Etag))
        {
            ctx.Response.StatusCode = StatusCodes.Status304NotModified;
            ctx.Response.ContentLength = 0;
            return;
        }

        ctx.Response.StatusCode = StatusCodes.Status200OK;
        ctx.Response.ContentType = "application/manifest+json; charset=utf-8";
        ctx.Response.ContentLength = cached.Bytes.Length;
        if (HttpMethods.IsHead(ctx.Request.Method))
        {
            return;
        }

        await ctx.Response.BodyWriter.WriteAsync(cached.Bytes, ctx.RequestAborted);
    }

    private static CachedDynamicManifest BuildDynamicManifest(SeoConfigReadModel seo)
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
        return new CachedDynamicManifest(bytes, ComputeDynamicManifestEtag(bytes));
    }

    private static string BuildDynamicManifestCacheKey(SeoConfigReadModel seo)
    {
        return string.Join('\u001F',
            seo.ManifestName,
            seo.ManifestShortName,
            seo.Title,
            seo.Description,
            seo.BackgroundColor,
            seo.ThemeColor,
            seo.PwaIcon192Url,
            seo.PwaIcon512Url,
            seo.PwaMaskableIconUrl);
    }

    private static string ComputeDynamicManifestEtag(byte[] bytes)
    {
        Span<byte> hash = stackalloc byte[32];
        SHA256.HashData(bytes, hash);
        return string.Concat("\"manifest-", Convert.ToHexString(hash[..8]).ToLowerInvariant(), "\"");
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
        IPublicAotRouteIdentity routeIdentity,
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

        bool isSearchRoute = PublicSearchRequestPolicy.IsSearchPath(ctx.Request.Path);
        if (isSearchRoute)
        {
            ctx.Response.Headers["X-Robots-Tag"] = "noindex, follow";
            PublicSearchRequestResolution resolution = PublicSearchRequestPolicy.Resolve(ctx.Request);
            if (resolution.IsBadRequest)
            {
                await WritePublicStatusHtmlAsync(ctx, env, StatusCodes.Status400BadRequest, ct);
                return TypedResults.Empty;
            }

            if (resolution.RequiresRedirect)
            {
                return TypedResults.Redirect(resolution.RedirectLocation!, permanent: true);
            }
        }

        if (TryBuildTrailingSlashRedirect(ctx.Request, out string redirectLocation))
        {
            return TypedResults.Redirect(redirectLocation, permanent: true);
        }

        bool isPublicAotRoute = routeIdentity.TryResolve(ctx, out PublicAotRouteMatch aotMatch);
        if (!isPublicAotRoute && !IsKnownSpaRoute(ctx.Request.Path))
        {
            await WritePublicStatusHtmlAsync(ctx, env, StatusCodes.Status404NotFound, ct);
            return TypedResults.Empty;
        }

        if (isPublicAotRoute)
        {
            long aotStartedAt = System.Diagnostics.Stopwatch.GetTimestamp();
            PublicAotRenderOutcome outcome = await shellService.RenderClassifiedAsync(ctx, aotMatch, ct);
            PublicAotCacheEntry? aotEntry = outcome.Entry;
            string source = ctx.Items.TryGetValue(PublicAotRuntimeState.PublicAotSourceContextKey, out object? sourceObj)
                ? sourceObj?.ToString() ?? "unknown"
                : "unknown";
            string version = ctx.Items.TryGetValue(PublicAotRuntimeState.PublicAotVersionContextKey, out object? versionObj)
                ? versionObj?.ToString() ?? "unknown"
                : "unknown";
            string backfill = ctx.Items.TryGetValue(PublicAotRuntimeState.PublicAotBackfillContextKey, out object? backfillObj)
                ? backfillObj?.ToString() ?? "none"
                : "none";
            string state = ctx.Items.TryGetValue(PublicAotRuntimeState.PublicAotStateContextKey, out object? stateObj)
                ? stateObj?.ToString() ?? "unknown"
                : "unknown";
            string assetMode = ctx.Items.TryGetValue(PublicAotRuntimeState.PublicAotAssetModeContextKey, out object? assetModeObj)
                ? assetModeObj?.ToString() ?? "unknown"
                : "unknown";
            FsusObservability.RecordAotRender(
                source,
                backfill,
                outcome.Status == PublicAotRenderStatus.Success
                    ? aotEntry is null ? "fallback" : "hit"
                    : outcome.Status.ToString().ToLowerInvariant(),
                FsusObservability.GetElapsed(aotStartedAt));
            if (outcome.Status == PublicAotRenderStatus.PermanentRedirect
                && !string.IsNullOrWhiteSpace(outcome.RedirectPath))
            {
                string redirectTarget = string.Concat(
                    ctx.Request.PathBase.Value,
                    outcome.RedirectPath);
                return TypedResults.Redirect(redirectTarget, permanent: true);
            }

            if (outcome.Status != PublicAotRenderStatus.Success)
            {
                int statusCode = outcome.Status switch
                {
                    PublicAotRenderStatus.Gone => StatusCodes.Status410Gone,
                    PublicAotRenderStatus.TransientFailure => StatusCodes.Status503ServiceUnavailable,
                    _ => StatusCodes.Status404NotFound
                };
                await WritePublicStatusHtmlAsync(ctx, env, statusCode, ct);
                return TypedResults.Empty;
            }

            if (aotEntry is not null)
            {
                await WritePublicAotHtmlEntryAsync(ctx, env, aotEntry, source, version, backfill, state, assetMode, ct);
                return TypedResults.Empty;
            }
        }

        SpaAssetSet? publicAssetSet = isPublicAotRoute ? assetService.GetPublicAssetSet(ctx, aotMatch.PageId) : null;
        bool preferSourceTemplate = publicAssetSet?.UsesSourceAssets == true || IsDevelopmentViteProxyRequest(env, ctx);
        string spaSource = ctx.Items.TryGetValue(PublicAotRuntimeState.PublicAotSourceContextKey, out object? spaSourceObj)
            ? spaSourceObj?.ToString() ?? "spa-index"
            : "spa-index";
        string spaVersion = ctx.Items.TryGetValue(PublicAotRuntimeState.PublicAotVersionContextKey, out object? spaVersionObj)
            ? spaVersionObj?.ToString() ?? "unknown"
            : "unknown";
        string spaBackfill = ctx.Items.TryGetValue(PublicAotRuntimeState.PublicAotBackfillContextKey, out object? spaBackfillObj)
            ? spaBackfillObj?.ToString() ?? "none"
            : "none";
        string spaState = ctx.Items.TryGetValue(PublicAotRuntimeState.PublicAotStateContextKey, out object? spaStateObj)
            ? spaStateObj?.ToString() ?? "fallback"
            : "fallback";
        string spaAssetMode = ctx.Items.TryGetValue(PublicAotRuntimeState.PublicAotAssetModeContextKey, out object? spaAssetModeObj)
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

        ReadOnlyMemory<byte> templateBytes = await PublicSpaTemplateLocator.ReadIndexTemplateBytesAsync(
            env,
            ct,
            preferSourceTemplate,
            assetService.GetIndexTemplatePath());
        SeoConfigReadModel seo = await systemService.GetSeoConfigAsync();
        ReadOnlyMemory<byte> seoHeadInjection = BuildSeoBrandHeadInjection(seo);
        if (isSearchRoute)
        {
            seoHeadInjection = CombineHeadInjections(seoHeadInjection, s_searchNoIndexHeadInjection);
        }

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

    internal static bool TryBuildTrailingSlashRedirect(HttpRequest request, out string location)
    {
        location = string.Empty;
        string path = request.Path.Value ?? string.Empty;
        if (path.Length <= 1 || !path.EndsWith("/", StringComparison.Ordinal))
        {
            return false;
        }

        string canonicalPath = path.TrimEnd('/');
        if (canonicalPath.StartsWith(PublicRouteIdentityRegistry.TagPathPrefix, StringComparison.OrdinalIgnoreCase)
            && canonicalPath.AsSpan(PublicRouteIdentityRegistry.TagPathPrefix.Length).IndexOf('/') < 0)
        {
            // Tag aliases need the database-backed identity resolver. Let the
            // AOT shell turn /tag/{name}/ directly into /tag/{id}, avoiding a
            // name-without-slash intermediate redirect.
            return false;
        }

        if (canonicalPath.Length == 0)
        {
            canonicalPath = "/";
        }

        location = string.Concat(request.PathBase.Value, canonicalPath, request.QueryString.Value);
        return true;
    }

    internal static bool IsKnownSpaRoute(PathString path)
    {
        string value = path.Value ?? string.Empty;
        if (string.Equals(value, PublicRouteIdentityRegistry.SearchPath, StringComparison.OrdinalIgnoreCase)
            || string.Equals(value, "/login", StringComparison.OrdinalIgnoreCase)
            || string.Equals(value, "/register", StringComparison.OrdinalIgnoreCase)
            || string.Equals(value, "/recover", StringComparison.OrdinalIgnoreCase)
            || string.Equals(value, "/403", StringComparison.OrdinalIgnoreCase)
            || string.Equals(value, "/404", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return string.Equals(value, "/user", StringComparison.OrdinalIgnoreCase)
            || value.StartsWith("/user/", StringComparison.OrdinalIgnoreCase);
    }

    internal static async Task WritePublicStatusHtmlAsync(
        HttpContext context,
        IWebHostEnvironment environment,
        int statusCode,
        CancellationToken cancellationToken = default)
    {
        (string title, string heading, string detail) = statusCode switch
        {
            StatusCodes.Status400BadRequest => ("搜索参数无效", "搜索参数无效", "请检查搜索词、排序方式和页码。"),
            StatusCodes.Status410Gone => ("内容已移除", "内容已永久移除", "该内容已不再提供。"),
            StatusCodes.Status503ServiceUnavailable => ("暂时无法访问", "服务暂时不可用", "请稍后重试。"),
            _ => ("页面不存在", "页面不存在", "请检查地址后重试。")
        };
        EnsureHtmlCspHeader(context, environment);
        string nonce = EnsureCspNonce(context);
        string html = BuildPublicStatusHtml(title, heading, detail, nonce);
        byte[] body = Encoding.UTF8.GetBytes(html);

        context.Response.StatusCode = statusCode;
        context.Response.ContentType = HtmlContentType;
        context.Response.ContentLength = body.Length;
        context.Response.Headers["Cache-Control"] = "no-store";
        context.Response.Headers["Pragma"] = "no-cache";
        context.Response.Headers["X-Robots-Tag"] = "noindex, follow";
        context.Response.Headers["X-Fsus-Public-Aot-Source"] = "server-status";
        context.Response.Headers["X-Fsus-Public-Aot-Version"] = PublicAotShellService.PublicRendererVersion;
        context.Response.Headers["X-Fsus-Public-Aot-Backfill"] = "none";
        context.Response.Headers["X-Fsus-Public-Aot-State"] = statusCode switch
        {
            StatusCodes.Status400BadRequest => "invalid-request",
            StatusCodes.Status410Gone => "gone",
            StatusCodes.Status503ServiceUnavailable => "transient-failure",
            _ => "not-found"
        };
        context.Response.Headers.Remove("ETag");
        context.Response.Headers.Remove("Last-Modified");
        if (statusCode == StatusCodes.Status503ServiceUnavailable)
        {
            context.Response.Headers["Retry-After"] = "5";
        }
        else
        {
            context.Response.Headers.Remove("Retry-After");
        }

        if (HttpMethods.IsHead(context.Request.Method))
        {
            return;
        }

        await context.Response.BodyWriter.WriteAsync(body, cancellationToken);
    }

    internal static string BuildPublicStatusHtml(string title, string heading, string detail)
        => BuildPublicStatusHtml(title, heading, detail, null);

    internal static string BuildPublicStatusHtml(string title, string heading, string detail, string? nonce)
    {
        string styleNonceAttr = string.IsNullOrWhiteSpace(nonce) ? string.Empty : $" nonce=\"{WebUtility.HtmlEncode(nonce)}\"";
        return string.Concat(
            "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"UTF-8\">",
            "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
            "<meta name=\"color-scheme\" content=\"light dark\">",
            "<meta name=\"robots\" content=\"noindex,follow\"><title>",
            WebUtility.HtmlEncode(title),
            "</title><style",
            styleNonceAttr,
            ">",
            ":root{color-scheme:light dark;--bg:#ffffff;--text:#18181b;--muted:#71717a;--btn-bg:#18181b;--btn-text:#ffffff;--border:#e4e4e7}",
            "html.dark,:root.dark,[data-theme='dark']{--bg:#000000;--text:#f4f4f5;--muted:#a1a1aa;--btn-bg:#f4f4f5;--btn-text:#000000;--border:#27272a}",
            "@media(prefers-color-scheme:dark){:root:not(.light){--bg:#000000;--text:#f4f4f5;--muted:#a1a1aa;--btn-bg:#f4f4f5;--btn-text:#000000;--border:#27272a}}",
            "body{margin:0;padding:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;-webkit-font-smoothing:antialiased}",
            "main{max-width:32rem;margin:0 auto;padding:6rem 1.5rem;box-sizing:border-box;text-align:left}",
            "h1{font-size:1.5rem;font-weight:700;line-height:1.25;margin:0 0 0.75rem;letter-spacing:-0.01em}",
            "p{font-size:0.9375rem;line-height:1.6;color:var(--muted);margin:0 0 2rem}",
            "a{display:inline-flex;align-items:center;padding:0.5rem 1rem;background:var(--btn-bg);color:var(--btn-text);text-decoration:none;font-size:0.875rem;font-weight:500;border-radius:4px;transition:opacity 0.15s}",
            "a:hover{opacity:0.9}",
            "</style></head><body><main><h1>",
            WebUtility.HtmlEncode(heading),
            "</h1><p>",
            WebUtility.HtmlEncode(detail),
            "</p><a href=\"/\">返回首页</a></main></body></html>");
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
        SetPublicAotHtmlHeaders(ctx, document, entry.Locale, source, version, backfill, state, assetMode);
        EnsureHtmlCspHeader(ctx, env);

        if (document.RequiresCspNonceMutation)
        {
            await WritePublicAotHtmlNonceTemplateAsync(
                ctx,
                document.CspNonceTemplate
                    ?? throw new InvalidOperationException("nonce HTML artifact is missing its compiled template"),
                cancellationToken);
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

        if (HttpEntityTagPreconditions.MatchesIfNoneMatch(ctx.Request.Headers.IfNoneMatch, variant.ETag))
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

    private static Task WritePublicAotHtmlNonceTemplateAsync(
        HttpContext ctx,
        CspNonceUtf8Template template,
        CancellationToken cancellationToken)
    {
        HttpResponse response = ctx.Response;
        response.Headers["Cache-Control"] = "private,no-store";
        response.Headers.Remove("Content-Encoding");
        response.Headers.Remove("ETag");
        response.Headers.Remove("Vary");
        EnsureLocaleVary(response.Headers);
        if (!PublicAotHtmlResponseNegotiation.AcceptsIdentity(ctx.Request.Headers.AcceptEncoding))
        {
            response.StatusCode = StatusCodes.Status406NotAcceptable;
            response.ContentLength = 0;
            return Task.CompletedTask;
        }

        // The per-request nonce changes the entity. Use identity streaming with
        // private/no-store semantics; static compressed variants and validators
        // are deliberately unavailable on this path.
        string nonce = EnsureCspNonce(ctx);
        response.StatusCode = StatusCodes.Status200OK;
        response.ContentType = HtmlContentType;
        response.ContentLength = template.GetRenderedLength(nonce.Length);
        if (HttpMethods.IsHead(ctx.Request.Method) || response.ContentLength == 0)
        {
            return Task.CompletedTask;
        }

        return CspNonceHtmlResponseWriter.WriteBodyAsync(response, template, nonce, cancellationToken);
    }

    private static void SetPublicAotHtmlHeaders(
        HttpContext ctx,
        PublicAotHtmlArtifact document,
        string locale,
        string source,
        string version,
        string backfill,
        string state,
        string assetMode)
    {
        var headers = ctx.Response.Headers;
        headers["X-Fsus-Public-Aot-Source"] = source;
        headers["X-Fsus-Public-Aot-Version"] = version;
        headers["X-Fsus-Public-Aot-Frontend-Asset-Version"] = document.FrontendAssetVersion;
        headers["X-Fsus-Public-Aot-Backfill"] = backfill;
        headers["X-Fsus-Public-Aot-State"] = state;
        headers["X-Fsus-Public-Aot-Asset-Mode"] = string.IsNullOrWhiteSpace(assetMode) ? "unknown" : assetMode;
        headers["Content-Language"] = locale;

        headers["Cache-Control"] = string.IsNullOrWhiteSpace(document.CacheControl)
            ? PublicAotHtmlArtifactOptions.DefaultCacheControl
            : document.CacheControl;
        EnsureAcceptEncodingVary(headers);
        EnsureLocaleVary(headers);
        headers["Accept-Ranges"] = "none";
        headers.Remove("Last-Modified");
    }

    private static void EnsureLocaleVary(IHeaderDictionary headers)
    {
        EnsureVary(headers, "Accept-Language");
        EnsureVary(headers, "Cookie");
    }

    private static void EnsureVary(IHeaderDictionary headers, string value)
    {
        string existing = headers.Vary.ToString();
        if (existing.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Any(segment => string.Equals(segment, value, StringComparison.OrdinalIgnoreCase)))
        {
            return;
        }

        headers["Vary"] = string.IsNullOrWhiteSpace(existing)
            ? value
            : string.Concat(existing, ", ", value);
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
            || path.EndsWith(".svg".AsSpan(), StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".ico".AsSpan(), StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".map".AsSpan(), StringComparison.OrdinalIgnoreCase);

    internal static bool IsImmutableSearchIndexAssetPath(ReadOnlySpan<char> path)
    {
        const string Prefix = "/search/index.";
        const string Suffix = ".bin";
        if (!path.StartsWith(Prefix.AsSpan(), StringComparison.OrdinalIgnoreCase)
            || !path.EndsWith(Suffix.AsSpan(), StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        ReadOnlySpan<char> middle = path[Prefix.Length..^Suffix.Length];
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

    internal static string BuildStaticCsp(bool isDevelopment)
        => isDevelopment
            ? "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'none'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' http://127.0.0.1:3000 http://localhost:3000 http://127.0.0.1:7568 http://localhost:7568 ws://127.0.0.1:3000 ws://localhost:3000 ws://127.0.0.1:7568 ws://localhost:7568; worker-src 'self' blob:; report-uri /api/security/csp-report;"
            : "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'none'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; require-trusted-types-for 'script'; trusted-types vue fsusblog fsusblog-spa-entry fsusui-markdown-feature; report-uri /api/security/csp-report;";

    internal static string BuildHtmlCsp(bool isDevelopment, string nonce)
        => isDevelopment
            ? $"default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self' 'wasm-unsafe-eval' 'nonce-{nonce}'; style-src 'self' 'nonce-{nonce}'; style-src-attr 'none'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' http://127.0.0.1:3000 http://localhost:3000 http://127.0.0.1:7568 http://localhost:7568 ws://127.0.0.1:3000 ws://localhost:3000 ws://127.0.0.1:7568 ws://localhost:7568; worker-src 'self' blob:; report-uri /api/security/csp-report;"
            : $"default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self' 'wasm-unsafe-eval' 'nonce-{nonce}'; style-src 'self' 'nonce-{nonce}'; style-src-attr 'none'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; require-trusted-types-for 'script'; trusted-types vue fsusblog fsusblog-spa-entry fsusui-markdown-feature; report-uri /api/security/csp-report;";

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
        IConfiguration? configuration = ctx.RequestServices?.GetService<IConfiguration>();
        ctx.Response.Headers["Content-Security-Policy"] = BuildHtmlCsp(
            ShouldUseDevelopmentCspPolicy(env, configuration),
            nonce);
    }

    internal static bool ShouldUseDevelopmentCspPolicy(
        IWebHostEnvironment environment,
        IConfiguration? configuration)
        => environment.IsDevelopment()
            && configuration?.GetValue<bool>("Testing:EnforceProductionCsp") != true;

    private static string CreateCspNonce()
        => WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(16));

}
