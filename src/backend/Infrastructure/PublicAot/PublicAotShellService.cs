using System.Net;

using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Spa;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.Extensions.Hosting;

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
    PublicAotSsrRuntimeState ssrRuntimeState,
    ILogger<PublicAotShellService> logger) : IPublicAotShellService, IPublicAotBackfillGenerator
{
    public const string PublicRendererVersion = PublicAotConstants.RendererVersion;
    public const string PublicAotSourceContextKey = "__fsus_public_aot_source";
    public const string PublicAotVersionContextKey = "__fsus_public_aot_version";
    public const string PublicAotBackfillContextKey = "__fsus_public_aot_backfill";
    public const string PublicAotStateContextKey = "__fsus_public_aot_state";
    public const string PublicAotAssetModeContextKey = "__fsus_public_aot_asset_mode";
    private static readonly Action<ILogger, PublicPageKind, string, Exception?> PublicAotBackfillQueuedLog =
        LoggerMessage.Define<PublicPageKind, string>(
            LogLevel.Information,
            new EventId(17001, nameof(PublicAotBackfillQueuedLog)),
            "Public AOT cache miss -> retryable cold response (queued): {Kind} {RouteKey}");
    private static readonly Action<ILogger, PublicPageKind, string, Exception?> PublicAotBackfillDroppedLog =
        LoggerMessage.Define<PublicPageKind, string>(
            LogLevel.Debug,
            new EventId(17002, nameof(PublicAotBackfillDroppedLog)),
            "Public AOT cache miss -> retryable cold response (dropped): {Kind} {RouteKey}");
    private static readonly Action<ILogger, PublicPageKind, string, Exception?> PublicAotCacheFailedLog =
        LoggerMessage.Define<PublicPageKind, string>(
            LogLevel.Warning,
            new EventId(17003, nameof(PublicAotCacheFailedLog)),
            "Public AOT cache operation failed: {Kind} {RouteKey}");
    private readonly IReadOnlyDictionary<PublicPageKind, IPublicAotBootstrapProvider> _bootstrapProviders =
        BuildBootstrapProviderMap(bootstrapProviders);

    public bool TryResolve(HttpContext context, out PublicAotRouteMatch match)
        => routeRegistry.TryResolve(context, out match);

    public async Task<Result<PublicAotNavigationSnapshot>> BuildNavigationSnapshotAsync(
        HttpContext context,
        PublicAotRouteMatch match,
        CancellationToken cancellationToken = default)
    {
        DateTimeOffset generatedAtUtc = DateTimeOffset.UtcNow;
        return await dbConcurrencyGate.ExecuteAsync(
            "public-aot-navigation-snapshot",
            gateCt => BuildNavigationSnapshotCoreAsync(context, match, generatedAtUtc, gateCt),
            _ => Task.FromResult(Result<PublicAotNavigationSnapshot>.Failure(ErrorCode.InfraFailure, "db-gate-timeout")),
            cancellationToken);
    }

    public async Task<PublicAotCacheEntry?> RenderAsync(HttpContext context, PublicAotRouteMatch match, CancellationToken cancellationToken = default)
        => (await RenderCoreAsync(context, match, classifyColdMiss: false, cancellationToken)).Entry;

    public Task<PublicAotRenderOutcome> RenderClassifiedAsync(
        HttpContext context,
        PublicAotRouteMatch match,
        CancellationToken cancellationToken = default)
        => RenderCoreAsync(context, match, classifyColdMiss: true, cancellationToken);

    private async Task<PublicAotRenderOutcome> RenderCoreAsync(
        HttpContext context,
        PublicAotRouteMatch match,
        bool classifyColdMiss,
        CancellationToken cancellationToken)
    {
        string baseDocumentCacheKey = runtimeKeyScope.PrefixKey(CacheKeyBuilder.PublicAotDocument(match.PageId, match.RouteKey));
        string pagePrefixKey = runtimeKeyScope.PrefixKey(CacheKeyBuilder.PublicAotDocument(match.PageId, string.Empty));
        string documentCacheKey = ResolveVersionedDocumentCacheKey(match.PageId, baseDocumentCacheKey, pagePrefixKey);
        string frontendAssetVersion = assetManifest.GetFrontendAssetVersion(context);
        string assetMode = ResolveAssetMode(frontendAssetVersion);
        context.Items[PublicAotAssetModeContextKey] = assetMode;
        if (classifyColdMiss && PublicTagUrlIdentity.IsNameRouteKey(match.RouteKey))
        {
            PublicAotRenderOutcome canonicalOutcome = await ClassifyRouteAsync(match, cancellationToken);
            SetClassifiedFailureContext(context, canonicalOutcome.Status, assetMode);
            return canonicalOutcome;
        }

        if (classifyColdMiss
            && match.RequiresPaginationRedirect
            && !ShouldPreserveLocalFixtureQuery(context, match))
        {
            PublicAotRenderOutcome canonicalOutcome = PublicAotRenderOutcome.PermanentRedirect(match.CanonicalPathAndQuery);
            SetClassifiedFailureContext(context, canonicalOutcome.Status, assetMode);
            return canonicalOutcome;
        }

        if (classifyColdMiss
            && match.RouteKey.StartsWith(
                string.Concat(PublicRouteIdentityRegistry.TagBucket, ":"),
                StringComparison.OrdinalIgnoreCase)
            && !string.Equals(match.Path, match.CanonicalPath, StringComparison.Ordinal))
        {
            PublicAotRenderOutcome canonicalOutcome = PublicAotRenderOutcome.PermanentRedirect(match.CanonicalPathAndQuery);
            SetClassifiedFailureContext(context, canonicalOutcome.Status, assetMode);
            return canonicalOutcome;
        }

        if (string.Equals(frontendAssetVersion, SpaAssetManifestService.DevSourceAssetVersion, StringComparison.Ordinal))
        {
            if (classifyColdMiss)
            {
                PublicAotRenderOutcome routeOutcome = await ClassifyRouteAsync(match, cancellationToken);
                if (routeOutcome.Status != PublicAotRenderStatus.Success)
                {
                    SetClassifiedFailureContext(context, routeOutcome.Status, "dev-source-bypass");
                    return routeOutcome;
                }
            }

            context.Items[PublicAotSourceContextKey] = "spa-fallback";
            context.Items[PublicAotVersionContextKey] = PublicRendererVersion;
            context.Items[PublicAotBackfillContextKey] = "dev-source-bypass";
            context.Items[PublicAotStateContextKey] = "fallback";
            return PublicAotRenderOutcome.Success(null);
        }

        PublicAotCacheEntry? entry;
        try
        {
            entry = await cache.TryGetEntryAsync(documentCacheKey, frontendAssetVersion, cancellationToken);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex) when (classifyColdMiss)
        {
            PublicAotCacheFailedLog(logger, match.Kind, match.RouteKey, ex);
            SetClassifiedFailureContext(context, PublicAotRenderStatus.TransientFailure, assetMode);
            return PublicAotRenderOutcome.TransientFailure(
                ErrorDetail.Create(ErrorCode.InfraFailure, "public_aot_cache_read_failed"));
        }
        if (IsRenderableCacheEntry(entry, frontendAssetVersion))
        {
            context.Items[PublicAotSourceContextKey] = entry!.Source.ToHeaderValue();
            context.Items[PublicAotVersionContextKey] = entry.RendererVersion;
            context.Items[PublicAotBackfillContextKey] = "none";
            context.Items[PublicAotStateContextKey] = "fresh";
            return PublicAotRenderOutcome.Success(entry);
        }

        if (entry is not null)
        {
            try
            {
                await cache.RemoveAsync(documentCacheKey, cancellationToken);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex) when (classifyColdMiss)
            {
                PublicAotCacheFailedLog(logger, match.Kind, match.RouteKey, ex);
                SetClassifiedFailureContext(context, PublicAotRenderStatus.TransientFailure, assetMode);
                return PublicAotRenderOutcome.TransientFailure(
                    ErrorDetail.Create(ErrorCode.InfraFailure, "public_aot_cache_remove_failed"));
            }
        }

        if (classifyColdMiss)
        {
            PublicAotRenderOutcome routeOutcome = await ClassifyRouteAsync(match, cancellationToken);
            if (routeOutcome.Status != PublicAotRenderStatus.Success)
            {
                SetClassifiedFailureContext(context, routeOutcome.Status, "none");
                return routeOutcome;
            }
        }

        bool queued = ScheduleBackfill(context, match, documentCacheKey, pagePrefixKey);
        context.Items[PublicAotSourceContextKey] = classifyColdMiss ? "server-status" : "spa-fallback";
        context.Items[PublicAotVersionContextKey] = PublicRendererVersion;
        context.Items[PublicAotBackfillContextKey] = queued ? "queued" : "dropped";
        context.Items[PublicAotStateContextKey] = classifyColdMiss ? "cold-miss" : "fallback";
        if (queued)
        {
            PublicAotBackfillQueuedLog(logger, match.Kind, match.RouteKey, null);
        }
        else
        {
            PublicAotBackfillDroppedLog(logger, match.Kind, match.RouteKey, null);
        }

        return classifyColdMiss
            ? PublicAotRenderOutcome.TransientFailure(ErrorDetail.Create(
                ErrorCode.InfraFailure,
                queued ? "public_aot_cold_miss_backfill_queued" : "public_aot_cold_miss_backfill_dropped"))
            : PublicAotRenderOutcome.Success(null);
    }

    internal static bool ShouldPreserveLocalFixtureQuery(HttpContext context, PublicAotRouteMatch match)
    {
        IServiceProvider? services = context.RequestServices;
        if (!match.RequiresPaginationRedirect
            || services?.GetService<IWebHostEnvironment>()?.IsDevelopment() != true
            || context.Connection.RemoteIpAddress is not IPAddress remoteAddress
            || !IPAddress.IsLoopback(remoteAddress))
        {
            return false;
        }

        IQueryCollection query = context.Request.Query;
        Microsoft.Extensions.Primitives.StringValues login = query["fsusLocalFixtureLogin"];
        Microsoft.Extensions.Primitives.StringValues admin = query["fsusLocalFixtureAdmin"];
        if (login.Count != 1 || login[0] != "1"
            || admin.Count > 0 && (admin.Count != 1 || admin[0] != "1")
            || query.Keys.Any(static key => key is not ("page" or "fsusLocalFixtureLogin" or "fsusLocalFixtureAdmin")))
        {
            return false;
        }

        Microsoft.Extensions.Primitives.StringValues page = query["page"];
        return match.QueryString.Length == 0
            ? page.Count == 0
            : page.Count == 1
                && string.Equals(match.QueryString, $"?page={page[0]}", StringComparison.Ordinal);
    }

    private async Task<PublicAotRenderOutcome> ClassifyRouteAsync(
        PublicAotRouteMatch match,
        CancellationToken cancellationToken)
    {
        if (!_bootstrapProviders.TryGetValue(match.Kind, out IPublicAotBootstrapProvider? provider))
        {
            return PublicAotRenderOutcome.TransientFailure(
                ErrorDetail.Create(ErrorCode.InfraFailure, $"public_aot_provider_missing:{match.Kind}"));
        }

        Result<PublicPageSnapshot> snapshot;
        try
        {
            snapshot = await dbConcurrencyGate.ExecuteClassifiedAsync(
                DbWorkloadClass.PublicShortRead,
                "public-aot-route-status",
                gateCt => provider.BuildSnapshotAsync(match, gateCt),
                _ => Task.FromResult(Result<PublicPageSnapshot>.Failure(ErrorCode.InfraFailure, "db-gate-timeout")),
                cancellationToken);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception)
        {
            return PublicAotRenderOutcome.TransientFailure(
                ErrorDetail.Create(ErrorCode.InfraFailure, "public_aot_route_status_failed"));
        }

        if (snapshot.IsSuccess && snapshot.Value is not null)
        {
            if (PublicTagUrlIdentity.IsNameRouteKey(match.RouteKey)
                && snapshot.Value is PublicFilterPageSnapshot { FilterId: > 0 } filter)
            {
                string canonicalRouteKey = PublicRouteIdentity.BuildPaginatedRouteKey(
                    PublicRouteIdentity.BuildTagIdRouteKey(filter.FilterId),
                    match.Page);
                return PublicAotRenderOutcome.PermanentRedirect(string.Concat(
                    PublicRouteIdentity.BuildCanonicalPath(PublicPageId.Filter, canonicalRouteKey, null),
                    PublicRouteIdentity.BuildPaginationQueryString(match.Page)));
            }

            return PublicAotRenderOutcome.Success(null);
        }

        return snapshot.Error.Code is ErrorCode.NotFound or ErrorCode.Validation
            ? PublicAotRenderOutcome.NotFound(snapshot.Error)
            : PublicAotRenderOutcome.TransientFailure(snapshot.Error);
    }

    private static void SetClassifiedFailureContext(
        HttpContext context,
        PublicAotRenderStatus status,
        string assetMode)
    {
        context.Items[PublicAotSourceContextKey] = status == PublicAotRenderStatus.PermanentRedirect
            ? "server-redirect"
            : "server-status";
        context.Items[PublicAotVersionContextKey] = PublicRendererVersion;
        context.Items[PublicAotBackfillContextKey] = "none";
        context.Items[PublicAotStateContextKey] = status switch
        {
            PublicAotRenderStatus.PermanentRedirect => "permanent-redirect",
            PublicAotRenderStatus.NotFound => "not-found",
            PublicAotRenderStatus.Gone => "gone",
            _ => "transient-failure"
        };
        context.Items[PublicAotAssetModeContextKey] = assetMode;
    }

    private async Task<Result<PublicAotNavigationSnapshot>> BuildNavigationSnapshotCoreAsync(
        HttpContext context,
        PublicAotRouteMatch match,
        DateTimeOffset generatedAtUtc,
        CancellationToken cancellationToken)
    {
        if (!_bootstrapProviders.TryGetValue(match.Kind, out IPublicAotBootstrapProvider? provider))
        {
            return Result<PublicAotNavigationSnapshot>.Failure(ErrorCode.Validation, $"public_aot_provider_missing:{match.Kind}");
        }

        Result<PublicPageSnapshot> snapshot = await provider.BuildSnapshotAsync(match, cancellationToken);
        if (snapshot.IsFailure || snapshot.Value is null)
        {
            return Result<PublicAotNavigationSnapshot>.Failure(snapshot.Error);
        }

        PublicPageSnapshot snapshotValue = snapshot.Value;
        if (PublicTagUrlIdentity.IsNameRouteKey(match.RouteKey)
            && snapshotValue is PublicFilterPageSnapshot { FilterId: > 0 } filter)
        {
            string canonicalFilterKey = PublicRouteIdentity.BuildTagIdRouteKey(filter.FilterId);
            string canonicalRouteKey = PublicRouteIdentity.BuildPaginatedRouteKey(
                canonicalFilterKey,
                match.Page);
            string canonicalPath = PublicRouteIdentity.BuildTagPath(filter.FilterId);
            match = match with
            {
                RouteKey = canonicalRouteKey,
                Path = canonicalPath,
                CanonicalPath = canonicalPath
            };
            snapshotValue = filter with
            {
                RouteKey = canonicalRouteKey,
                FilterKey = canonicalFilterKey
            };
        }

        Result<PublicAotShellEntryContract> entry = await entryRenderer.BuildEntryAsync(
            new PublicAotRenderRequest(match, snapshotValue),
            cancellationToken);
        if (entry.IsFailure || entry.Value is null)
        {
            return Result<PublicAotNavigationSnapshot>.Failure(entry.Error);
        }

        PublicAotShellEntryContract renderedEntry = entry.Value;
        if (!PublicAotShellContractRules.TryValidateEntry(renderedEntry, out string normalizedRouteKey, out string normalizedHtml, out string error))
        {
            return Result<PublicAotNavigationSnapshot>.Failure(ErrorCode.Validation, error);
        }

        PublicAotShellEntryContract normalizedEntry = renderedEntry with
        {
            RouteKey = normalizedRouteKey,
            Html = normalizedHtml
        };
        string frontendAssetVersion = assetManifest.GetFrontendAssetVersion(context);
        PublicAotRouteMatch navigationMatch = match with
        {
            RouteKey = normalizedRouteKey
        };
        Result<PublicSeoHeadModel> seoHead = await documentService.BuildSeoHeadModelAsync(
            normalizedEntry,
            cancellationToken);
        if (seoHead.IsFailure || seoHead.Value is null)
        {
            return Result<PublicAotNavigationSnapshot>.Failure(seoHead.Error);
        }

        PublicAotNavigationSnapshot result = PublicAotNavigationSnapshot.Create(
            navigationMatch,
            normalizedEntry,
            seoHead.Value,
            frontendAssetVersion,
            generatedAtUtc);
        return Result<PublicAotNavigationSnapshot>.Success(result);
    }

    private bool ScheduleBackfill(
        HttpContext context,
        PublicAotRouteMatch match,
        string documentCacheKey,
        string pagePrefixKey)
        => backfillScheduler.TrySchedule(new PublicAotBackfillRequest(
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

    public async Task GenerateAndStoreAsync(
        PublicAotBackfillRequest request,
        CancellationToken cancellationToken = default,
        Func<CancellationToken, Task>? beforeCommit = null)
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
            PublicAotSsrFailureClass failureClass = PublicAotSsrRuntimeState.ClassifyFailure(document.Error.Message);
            ssrRuntimeState.RecordBackfillFailure(request, failureClass, document.Error.Message, TimeSpan.Zero);
            logger.LogInformation(
                "Public AOT SSR backfill skipped due to recoverable render failure: {Kind} {RouteKey} {FailureClass} {Message}",
                request.Kind,
                request.RouteKey,
                failureClass,
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
        try
        {
            if (beforeCommit is not null)
            {
                await beforeCommit(cancellationToken).ConfigureAwait(false);
            }

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
            ssrRuntimeState.RecordBackfillSuccess(request, TimeSpan.Zero);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            ssrRuntimeState.RecordBackfillFailure(
                request,
                PublicAotSsrFailureClass.CacheWriteFailure,
                ex.Message,
                TimeSpan.Zero);
            logger.LogWarning(
                ex,
                "public_aot_cache_write_failed {Kind} {RouteKey} {FailureClass}",
                request.Kind,
                request.RouteKey,
                PublicAotSsrFailureClass.CacheWriteFailure);
            throw;
        }
    }

    public async Task<Result> InvalidateAllAsync(CancellationToken cancellationToken = default)
    {
        ssrRuntimeState.ClearAllRouteQuarantines();
        await cache.InvalidateAllAsync(cancellationToken);
        return Result.Success();
    }

    internal static bool IsRenderableCacheEntry(PublicAotCacheEntry? entry, string frontendAssetVersion)
        => IsCompatibleCacheEntry(entry, frontendAssetVersion)
            && entry!.ExpiresAtUtc > DateTimeOffset.UtcNow;

    private static bool IsCompatibleCacheEntry(PublicAotCacheEntry? entry, string frontendAssetVersion)
    {
        if (entry is null)
        {
            return false;
        }

        if (string.IsNullOrWhiteSpace(entry.RendererVersion) || string.IsNullOrWhiteSpace(entry.FrontendAssetVersion))
        {
            return false;
        }

        return string.Equals(entry.RendererVersion, PublicRendererVersion, StringComparison.Ordinal)
            && string.Equals(entry.FrontendAssetVersion, frontendAssetVersion, StringComparison.Ordinal)
            && !entry.GetDocument().Utf8Bytes.IsEmpty;
    }

    private static string ResolveAssetMode(string frontendAssetVersion)
        => string.Equals(frontendAssetVersion, SpaAssetManifestService.DevSourceAssetVersion, StringComparison.Ordinal)
            ? SpaAssetManifestService.DevSourceAssetVersion
            : "prod-manifest";

    private string ResolveVersionedDocumentCacheKey(PublicPageId pageId, string cacheKey, string pagePrefixKey)
    {
        if (!UsesListVersion(pageId))
        {
            return cacheKey;
        }

        long version = invalidationTracker.GetCurrentVersion(cacheKey, pagePrefixKey);
        return string.Concat(cacheKey, ":lv:", version.ToString());
    }

    private static bool UsesListVersion(PublicPageId pageId)
        => pageId is PublicPageId.Home or PublicPageId.Archive or PublicPageId.Filter;

    private async Task<Result<(PublicAotRouteMatch Match, string Html, string RendererVersion)>> BuildBackfillDocumentAsync(
        PublicAotBackfillRequest request,
        CancellationToken cancellationToken)
    {
        PublicAotRouteMatch match = ResolveBackfillMatch(request);
        if (PublicTagUrlIdentity.IsNameRouteKey(match.RouteKey))
        {
            return Result<(PublicAotRouteMatch Match, string Html, string RendererVersion)>.Failure(
                ErrorCode.Validation,
                "public_aot_tag_name_route_noncanonical");
        }

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
            match with
            {
                RouteKey = normalizedRouteKey
            },
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
            request.QueryString)
        {
            Page = PublicRouteIdentity.ParsePageRouteKey(request.RouteKey)
        };
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
