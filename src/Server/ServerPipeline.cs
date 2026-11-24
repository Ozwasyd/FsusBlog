using Microsoft.Extensions.FileProviders;

namespace FsusBlog.V2.Server;

internal sealed record RequestGuardOptions(
    Func<bool> LeaseIsCurrent,
    PasskeyConfiguration? AdminIdentity,
    bool TrustLoopbackProxy,
    bool PublicMediaEnabled,
    bool HasPublicationProofs,
    SiteTraffic? SiteTraffic,
    Uri? TrafficOrigin);

internal static class ServerPipeline
{
    internal static void UseRuntimeEvidence(WebApplication app)
    {
        if (app.Services.GetService<RuntimeEvidence>() is not { } runtimeEvidence) return;
        app.Use(async (ctx, next) =>
        {
            var sample = runtimeEvidence.SampleObserverCost();
            var started = sample ? Stopwatch.GetTimestamp() : 0;
            var category = RuntimeEvidence.Classify(ctx);
            var before = sample ? Stopwatch.GetTimestamp() - started : 0;
            var requestStarted = runtimeEvidence.SlowRequestStart(category);
            try { await next(ctx); }
            finally
            {
                if (sample) started = Stopwatch.GetTimestamp();
                runtimeEvidence.CountRequest(ctx, category, requestStarted);
                if (sample) runtimeEvidence.AccountObserverSample(before + Stopwatch.GetTimestamp() - started);
            }
        });
    }

    internal static void UseRequestPipeline(WebApplication app, ServerBootstrapContext bootstrap)
    {
        var capabilities = bootstrap.Capabilities;
        var lease = app.Services.GetRequiredService<InstanceLease>();
        var siteTraffic = capabilities.SiteTraffic ? app.Services.GetRequiredService<SiteTraffic>() : null;
        var hasPublicationProofs = app.Services.GetService<PublicationProofs>() is not null;
        var guardOptions = new RequestGuardOptions(
            LeaseIsCurrent: () => lease.IsCurrent,
            AdminIdentity: capabilities.AdminIdentity,
            TrustLoopbackProxy: capabilities.TrustLoopbackProxy,
            PublicMediaEnabled: bootstrap.PublicMediaEnabled,
            HasPublicationProofs: hasPublicationProofs,
            SiteTraffic: siteTraffic,
            TrafficOrigin: capabilities.TrafficOrigin);

        // Preserve exact middleware order:
        // 1. Security headers + trusted loopback proxy + instance lease + canonical admin origin gate + /api mutation check + exception mapping
        // 2. Static assets (/assets, /dist)
        // 3. WebSocket upgrades for inbox streams
        // 4. Rate limiting (after canonical origin hiding so non-admin origins return 404 and never leak 429)
        app.Use((ctx, next) => ExecuteRequestGuardAsync(ctx, next, guardOptions, app.Logger));
        UseStaticAssets(app, bootstrap.WebDist);
        UseSocketUpgrades(app, capabilities.AdminInboxLive);
        app.UseRateLimiter();
    }

    internal static async Task ExecuteRequestGuardAsync(HttpContext ctx, Func<Task> next,
        RequestGuardOptions options, ILogger logger)
    {
        if ((options.HasPublicationProofs && PublicationProofs.IsRoute(ctx.Request.Path)) ||
            ctx.Request.Path.StartsWithSegments(PublicationCheckpointArchive.Prefix) ||
            LegacyReleaseResponsibility.IsHistoricalRoute(ctx.Request.Path))
            ServerHttp.NoStore(ctx);

        ctx.Response.Headers.XContentTypeOptions = "nosniff";
        ctx.Response.Headers["Referrer-Policy"] = "same-origin";
        var imageRequest = options.PublicMediaEnabled && ctx.Request.Path.StartsWithSegments(PublishedMediaEndpoints.PathPrefix);
        if (imageRequest) PublishedMediaEndpoints.SetHeaders(ctx.Response);
        ctx.Response.Headers.ContentSecurityPolicy = ServerHttp.ContentSecurityPolicy;

        try
        {
            if (options.TrustLoopbackProxy)
            {
                if (!LoopbackProxy.IsTrustedPeer(ctx.Connection.RemoteIpAddress))
                    throw new BusinessException(Rejection.Forbidden, "A local reverse proxy is required.");
                if (!LoopbackProxy.TryApply(ctx))
                    throw new BusinessException(Rejection.Invalid, "Invalid forwarding headers.");
                if (!ctx.Request.IsHttps)
                    throw new BusinessException(Rejection.Forbidden, "Secure transport is required.");
            }
            if (!options.LeaseIsCurrent())
            {
                ServerHttp.NoStore(ctx);
                throw new PublicUnavailableException();
            }
            if (!AdminIdentityEndpoints.IsAllowed(ctx, options.AdminIdentity))
            {
                ServerHttp.NoStore(ctx);
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
                if (HttpMethods.IsPost(ctx.Request.Method) || HttpMethods.IsPut(ctx.Request.Method))
                    ServerHttp.VerifyMutation(ctx);
            }

            await next();

            if (options.SiteTraffic is not null && options.TrafficOrigin is not null &&
                string.Equals(ctx.Request.Scheme, options.TrafficOrigin.Scheme, StringComparison.OrdinalIgnoreCase) &&
                string.Equals(ctx.Request.Host.Value, options.TrafficOrigin.Authority, StringComparison.OrdinalIgnoreCase))
                options.SiteTraffic.Observe(ctx);
        }
        catch (OperationCanceledException) when (ctx.RequestAborted.IsCancellationRequested) { }
        catch (Exception ex) when (!ctx.Response.HasStarted)
        {
            if (ctx.GetEndpoint()?.Metadata.GetMetadata<MediaEndpoints.PrivateRead>() is not null)
            {
                MediaEndpoints.SetHidden(ctx.Response);
                return;
            }
            var (status, message, details) = ServerHttp.MapException(ex);
            if (status >= 500 && (ex is not PublicUnavailableException || options.LeaseIsCurrent()))
                logger.LogError(ex, "Request {TraceId} failed", ctx.TraceIdentifier);
            var result = ctx.Request.Path.StartsWithSegments("/api")
                ? ServerHttp.Error(ctx, status, message, details)
                : Results.Text(message, ServerHttp.TextContentType, statusCode: status);
            await result.ExecuteAsync(ctx);
        }
    }

    private static void UseStaticAssets(WebApplication app, string webDist)
    {
        foreach (var asset in new[] { "assets", "dist" })
        {
            var assetDir = Path.Combine(webDist, asset);
            if (Directory.Exists(assetDir))
                app.UseStaticFiles(new StaticFileOptions
                {
                    FileProvider = new PhysicalFileProvider(assetDir),
                    RequestPath = "/" + asset
                });
        }
    }

    private static void UseSocketUpgrades(WebApplication app, bool adminInboxLive)
    {
        app.UseWhen(ctx => ctx.Request.Path == WireRoutes.InboxStream ||
            (adminInboxLive && ctx.GetEndpoint()?.Metadata.GetMetadata<AdminInboxEndpoints.LiveSocket>() is not null),
            branch => branch.UseWebSockets(new WebSocketOptions
            {
                KeepAliveInterval = TimeSpan.FromSeconds(20),
                KeepAliveTimeout = TimeSpan.FromSeconds(10)
            }));
    }
}
