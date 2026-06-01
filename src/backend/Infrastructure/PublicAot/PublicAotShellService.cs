using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Spa;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed class PublicAotShellService(
    IDbConcurrencyGate dbConcurrencyGate,
    IPublicAotRouteRegistry routeRegistry,
    IEnumerable<IPublicAotBootstrapProvider> bootstrapProviders,
    IPublicAotEntryRenderer entryRenderer,
    IPublicAotDocumentService documentService,
    IPublicAotShellCache cache,
    IPublicAotCacheWriter cacheWriter,
    IPublicAotBackfillScheduler backfillScheduler,
    ISpaAssetManifestService assetManifest,
    IRuntimeKeyScope runtimeKeyScope,
    PublicAotInvalidationTracker invalidationTracker,
    ILogger<PublicAotShellService> logger) : IPublicAotShellService, IPublicAotBackfillGenerator
{
    public const string PublicRendererVersion = PublicAotConstants.RendererVersion;
    public const string PublicAotSourceContextKey = "__fsus_public_aot_source";
    public const string PublicAotVersionContextKey = "__fsus_public_aot_version";
    public const string PublicAotBackfillContextKey = "__fsus_public_aot_backfill";
    private static readonly Action<ILogger, PublicPageKind, string, Exception?> PublicAotBackfillQueuedLog =
        LoggerMessage.Define<PublicPageKind, string>(
            LogLevel.Information,
            new EventId(17001, nameof(PublicAotBackfillQueuedLog)),
            "Public AOT cache miss -> SPA fallback (queued): {Kind} {RouteKey}");
    private static readonly Action<ILogger, PublicPageKind, string, Exception?> PublicAotBackfillDroppedLog =
        LoggerMessage.Define<PublicPageKind, string>(
            LogLevel.Debug,
            new EventId(17002, nameof(PublicAotBackfillDroppedLog)),
            "Public AOT cache miss -> SPA fallback (dropped): {Kind} {RouteKey}");
    private readonly IReadOnlyDictionary<PublicPageKind, IPublicAotBootstrapProvider> _bootstrapProviders =
        BuildBootstrapProviderMap(bootstrapProviders);

    public bool TryResolve(HttpContext context, out PublicAotRouteMatch match)
        => routeRegistry.TryResolve(context, out match);

    public async Task<string?> RenderAsync(HttpContext context, PublicAotRouteMatch match, CancellationToken cancellationToken = default)
    {
        string documentCacheKey = runtimeKeyScope.PrefixKey(CacheKeyBuilder.PublicAotDocument(match.PageId, match.RouteKey));
        string frontendAssetVersion = assetManifest.GetFrontendAssetVersion();
        PublicAotCacheEntry? entry = await cache.TryGetEntryAsync(documentCacheKey, cancellationToken);
        if (IsRenderableCacheEntry(entry, frontendAssetVersion))
        {
            context.Items[PublicAotSourceContextKey] = entry!.Source.ToHeaderValue();
            context.Items[PublicAotVersionContextKey] = entry.RendererVersion;
            context.Items[PublicAotBackfillContextKey] = "none";
            return entry.Value;
        }

        if (entry is not null)
        {
            await cache.RemoveAsync(documentCacheKey, cancellationToken);
        }

        string pagePrefixKey = runtimeKeyScope.PrefixKey(CacheKeyBuilder.PublicAotDocument(match.PageId, string.Empty));
        bool queued = backfillScheduler.TrySchedule(new PublicAotBackfillRequest(
            match.Kind,
            match.RouteKey,
            match.Path,
            match.QueryString,
            documentCacheKey)
        {
            PagePrefixKey = pagePrefixKey,
            ScheduledInvalidationVersion = invalidationTracker.GetCurrentVersion(documentCacheKey, pagePrefixKey),
            TestSessionId = ResolveTestSessionId(context)
        });
        context.Items[PublicAotSourceContextKey] = "spa-fallback";
        context.Items[PublicAotVersionContextKey] = PublicRendererVersion;
        context.Items[PublicAotBackfillContextKey] = queued ? "queued" : "dropped";
        if (queued)
        {
            PublicAotBackfillQueuedLog(logger, match.Kind, match.RouteKey, null);
        }
        else
        {
            PublicAotBackfillDroppedLog(logger, match.Kind, match.RouteKey, null);
        }

        return string.Empty;
    }

    public async Task GenerateAndStoreAsync(PublicAotBackfillRequest request, CancellationToken cancellationToken = default)
    {
        Result<(PublicAotRouteMatch Match, string Html, string RendererVersion)> document = await dbConcurrencyGate.ExecuteAsync(
            "public-aot-backfill",
            gateCt => BuildBackfillDocumentAsync(request, gateCt),
            _ =>
            {
                logger.LogWarning("db-gate-timeout public-aot-backfill {Kind} {RouteKey}", request.Kind, request.RouteKey);
                return Task.FromResult(Result<(PublicAotRouteMatch Match, string Html, string RendererVersion)>.Failure(ErrorCode.InfraFailure, "db-gate-timeout"));
            },
            cancellationToken);
        if (document.IsFailure)
        {
            logger.LogWarning(
                "Public AOT SSR backfill skipped due to recoverable render failure: {Kind} {RouteKey} {Message}",
                request.Kind,
                request.RouteKey,
                document.Error.Message);
            return;
        }

        (PublicAotRouteMatch match, string html, string rendererVersion) = document.Value;
        if (invalidationTracker.WasInvalidatedAfter(request))
        {
            logger.LogInformation(
                "Public AOT backfill skipped stale write after invalidation: {Kind} {RouteKey}",
                request.Kind,
                request.RouteKey);
            return;
        }

        string frontendAssetVersion = assetManifest.GetFrontendAssetVersion();
        await cacheWriter.WriteAsync(
            request.CacheKey,
            match.PageId,
            match.RouteKey,
            rendererVersion,
            frontendAssetVersion,
            html,
            PublicAotWriteSource.ServerSsrBackfill,
            DateTimeOffset.UtcNow,
            TimeSpan.FromDays(30),
            cancellationToken);
    }

    public async Task<Result> InvalidateAllAsync(CancellationToken cancellationToken = default)
    {
        await cache.InvalidateAllAsync(cancellationToken);
        return Result.Success();
    }

    internal static bool IsRenderableCacheEntry(PublicAotCacheEntry? entry, string frontendAssetVersion)
    {
        if (entry is null || string.IsNullOrWhiteSpace(entry.Value))
        {
            return false;
        }

        if (string.IsNullOrWhiteSpace(entry.RendererVersion) || string.IsNullOrWhiteSpace(entry.FrontendAssetVersion))
        {
            return false;
        }

        return string.Equals(entry.RendererVersion, PublicRendererVersion, StringComparison.Ordinal)
            && string.Equals(entry.FrontendAssetVersion, frontendAssetVersion, StringComparison.Ordinal);
    }

    private async Task<Result<(PublicAotRouteMatch Match, string Html, string RendererVersion)>> BuildBackfillDocumentAsync(
        PublicAotBackfillRequest request,
        CancellationToken cancellationToken)
    {
        PublicAotRouteMatch match = ResolveBackfillMatch(request);
        if (!_bootstrapProviders.TryGetValue(match.Kind, out IPublicAotBootstrapProvider? provider))
        {
            return Result<(PublicAotRouteMatch Match, string Html, string RendererVersion)>.Failure(ErrorCode.Validation, $"public_aot_provider_missing:{match.Kind}");
        }

        Result<PublicPageSnapshot> snapshot = await provider.BuildSnapshotAsync(match, cancellationToken);
        if (snapshot.IsFailure)
        {
            return Result<(PublicAotRouteMatch Match, string Html, string RendererVersion)>.Failure(snapshot.Error);
        }

        var renderRequest = new PublicAotRenderRequest(match, snapshot.Value!);
        Result<PublicAotShellEntryContract> entry = await entryRenderer.BuildEntryAsync(renderRequest, cancellationToken);
        if (entry.IsFailure)
        {
            return Result<(PublicAotRouteMatch Match, string Html, string RendererVersion)>.Failure(entry.Error);
        }

        PublicAotShellEntryContract renderedEntry = entry.Value!;
        if (!PublicAotShellContractRules.TryValidateEntry(renderedEntry, out string normalizedRouteKey, out string normalizedHtml, out string error))
        {
            return Result<(PublicAotRouteMatch Match, string Html, string RendererVersion)>.Failure(ErrorCode.Validation, error);
        }

        PublicAotShellEntryContract normalizedEntry = renderedEntry with
        {
            RouteKey = normalizedRouteKey,
            Html = normalizedHtml
        };
        Result<string> document = await documentService.ComposeAsync(normalizedEntry, cancellationToken);
        if (document.IsFailure)
        {
            return Result<(PublicAotRouteMatch Match, string Html, string RendererVersion)>.Failure(document.Error);
        }

        return Result<(PublicAotRouteMatch Match, string Html, string RendererVersion)>.Success((
            match with { RouteKey = normalizedRouteKey },
            document.Value!,
            normalizedEntry.RendererVersion ?? PublicRendererVersion));
    }

    private PublicAotRouteMatch ResolveBackfillMatch(PublicAotBackfillRequest request)
    {
        var context = new DefaultHttpContext();
        context.Request.Path = string.IsNullOrWhiteSpace(request.Path) ? "/" : request.Path;
        context.Request.QueryString = string.IsNullOrWhiteSpace(request.QueryString)
            ? QueryString.Empty
            : new QueryString(request.QueryString);

        if (routeRegistry.TryResolve(context, out PublicAotRouteMatch match))
        {
            return match;
        }

        PublicAotPageDescriptor descriptor = PublicAotPageCatalog.GetRequired(request.Kind);
        return new PublicAotRouteMatch(
            request.Kind,
            descriptor.PageId,
            request.RouteKey,
            PublicRouteIdentity.BuildCanonicalPath(descriptor.PageId, request.RouteKey, null),
            request.Path,
            request.QueryString);
    }

    private static IReadOnlyDictionary<PublicPageKind, IPublicAotBootstrapProvider> BuildBootstrapProviderMap(
        IEnumerable<IPublicAotBootstrapProvider> bootstrapProviders)
    {
        IPublicAotBootstrapProvider[] providers = bootstrapProviders.ToArray();
        PublicPageKind[] duplicateKinds = providers
            .GroupBy(static provider => provider.Kind)
            .Where(static group => group.Count() > 1)
            .Select(static group => group.Key)
            .OrderBy(static kind => kind)
            .ToArray();
        if (duplicateKinds.Length > 0)
        {
            throw new InvalidOperationException($"public_aot_provider_duplicate:{string.Join(',', duplicateKinds)}");
        }

        Dictionary<PublicPageKind, IPublicAotBootstrapProvider> providerMap = providers
            .ToDictionary(static provider => provider.Kind);

        PublicPageKind[] missingKinds = PublicAotPageIdentity.GetSeoEligibleKinds()
            .Where(kind => !providerMap.ContainsKey(kind))
            .OrderBy(static kind => kind)
            .ToArray();
        if (missingKinds.Length > 0)
        {
            throw new InvalidOperationException($"public_aot_provider_missing:{string.Join(',', missingKinds)}");
        }

        return providerMap;
    }

    private static string? ResolveTestSessionId(HttpContext context)
    {
        string? raw = context.Request.Headers[HttpTestSessionKeyScope.HeaderName].FirstOrDefault();
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        string normalized = raw.Trim().ToLowerInvariant();
        return HttpTestSessionKeyScope.IsValidSessionId(normalized) ? normalized : null;
    }
}
