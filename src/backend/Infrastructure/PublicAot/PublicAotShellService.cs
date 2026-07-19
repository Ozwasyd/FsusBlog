using System.Net;

using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.Extensions.Hosting;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed class PublicAotShellService(
    IDbConcurrencyGate dbConcurrencyGate,
    IPublicAotDocumentComposition documentComposition,
    IPublicAotArtifactStore artifactStore,
    PublicAotSsrRuntimeState ssrRuntimeState,
    ILogger<PublicAotShellService> logger) : IPublicAotShellService, IPublicAotBackfillGenerator
{
    public const string PublicRendererVersion = PublicAotConstants.RendererVersion;
    public const string PublicAotSourceContextKey = "__fsus_public_aot_source";
    public const string PublicAotVersionContextKey = "__fsus_public_aot_version";
    public const string PublicAotBackfillContextKey = "__fsus_public_aot_backfill";
    public const string PublicAotStateContextKey = "__fsus_public_aot_state";
    public const string PublicAotAssetModeContextKey = "__fsus_public_aot_asset_mode";
    private static readonly Action<ILogger, PublicPageKind, string, Exception?> s_publicAotBackfillQueuedLog =
        LoggerMessage.Define<PublicPageKind, string>(
            LogLevel.Information,
            new EventId(17001, "PublicAotBackfillQueuedLog"),
            "Public AOT cache miss -> retryable cold response (queued): {Kind} {RouteKey}");
    private static readonly Action<ILogger, PublicPageKind, string, Exception?> s_publicAotBackfillDroppedLog =
        LoggerMessage.Define<PublicPageKind, string>(
            LogLevel.Debug,
            new EventId(17002, "PublicAotBackfillDroppedLog"),
            "Public AOT cache miss -> retryable cold response (dropped): {Kind} {RouteKey}");
    private static readonly Action<ILogger, PublicPageKind, string, Exception?> s_publicAotCacheFailedLog =
        LoggerMessage.Define<PublicPageKind, string>(
            LogLevel.Warning,
            new EventId(17003, "PublicAotCacheFailedLog"),
            "Public AOT cache operation failed: {Kind} {RouteKey}");
    public async Task<Result<PublicAotNavigationSnapshot>> BuildNavigationSnapshotAsync(
        HttpContext context,
        PublicAotRouteMatch match,
        CancellationToken cancellationToken = default)
    {
        DateTimeOffset generatedAtUtc = DateTimeOffset.UtcNow;
        return await dbConcurrencyGate.ExecuteAsync(
            "public-aot-navigation-snapshot",
            gateCt => documentComposition.BuildNavigationSnapshotAsync(context, match, generatedAtUtc, gateCt),
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
        PublicAotArtifactLookup lookup = artifactStore.CreateLookup(context, match);
        context.Items[PublicAotAssetModeContextKey] = lookup.AssetMode;
        if (classifyColdMiss && PublicTagUrlIdentity.IsNameRouteKey(match.RouteKey))
        {
            PublicAotRenderOutcome canonicalOutcome = await documentComposition.ClassifyRouteAsync(match, cancellationToken);
            SetClassifiedFailureContext(context, canonicalOutcome.Status, lookup.AssetMode);
            return canonicalOutcome;
        }

        if (classifyColdMiss
            && match.RequiresPaginationRedirect
            && !ShouldPreserveLocalFixtureQuery(context, match))
        {
            PublicAotRenderOutcome canonicalOutcome = PublicAotRenderOutcome.PermanentRedirect(match.CanonicalPathAndQuery);
            SetClassifiedFailureContext(context, canonicalOutcome.Status, lookup.AssetMode);
            return canonicalOutcome;
        }

        if (classifyColdMiss
            && match.RouteKey.StartsWith(
                string.Concat(PublicRouteIdentityRegistry.TagBucket, ":"),
                StringComparison.OrdinalIgnoreCase)
            && !string.Equals(match.Path, match.CanonicalPath, StringComparison.Ordinal))
        {
            PublicAotRenderOutcome canonicalOutcome = PublicAotRenderOutcome.PermanentRedirect(match.CanonicalPathAndQuery);
            SetClassifiedFailureContext(context, canonicalOutcome.Status, lookup.AssetMode);
            return canonicalOutcome;
        }

        if (lookup.UsesDevelopmentSourceAssets)
        {
            if (classifyColdMiss)
            {
                PublicAotRenderOutcome routeOutcome = await documentComposition.ClassifyRouteAsync(match, cancellationToken);
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
            entry = await artifactStore.TryGetEntryAsync(lookup, cancellationToken);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex) when (classifyColdMiss)
        {
            s_publicAotCacheFailedLog(logger, match.Kind, match.RouteKey, ex);
            SetClassifiedFailureContext(context, PublicAotRenderStatus.TransientFailure, lookup.AssetMode);
            return PublicAotRenderOutcome.TransientFailure(
                ErrorDetail.Create(ErrorCode.InfraFailure, "public_aot_cache_read_failed"));
        }
        if (artifactStore.IsRenderable(entry, lookup.FrontendAssetVersion))
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
                await artifactStore.RemoveAsync(lookup, cancellationToken);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex) when (classifyColdMiss)
            {
                s_publicAotCacheFailedLog(logger, match.Kind, match.RouteKey, ex);
                SetClassifiedFailureContext(context, PublicAotRenderStatus.TransientFailure, lookup.AssetMode);
                return PublicAotRenderOutcome.TransientFailure(
                    ErrorDetail.Create(ErrorCode.InfraFailure, "public_aot_cache_remove_failed"));
            }
        }

        if (classifyColdMiss)
        {
            PublicAotRenderOutcome routeOutcome = await documentComposition.ClassifyRouteAsync(match, cancellationToken);
            if (routeOutcome.Status != PublicAotRenderStatus.Success)
            {
                SetClassifiedFailureContext(context, routeOutcome.Status, "none");
                return routeOutcome;
            }
        }

        bool queued = artifactStore.TryScheduleBackfill(context, match, lookup);
        context.Items[PublicAotSourceContextKey] = classifyColdMiss ? "server-status" : "spa-fallback";
        context.Items[PublicAotVersionContextKey] = PublicRendererVersion;
        context.Items[PublicAotBackfillContextKey] = queued ? "queued" : "dropped";
        context.Items[PublicAotStateContextKey] = classifyColdMiss ? "cold-miss" : "fallback";
        if (queued)
        {
            s_publicAotBackfillQueuedLog(logger, match.Kind, match.RouteKey, null);
        }
        else
        {
            s_publicAotBackfillDroppedLog(logger, match.Kind, match.RouteKey, null);
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

    public async Task GenerateAndStoreAsync(
        PublicAotBackfillRequest request,
        CancellationToken cancellationToken = default,
        Func<CancellationToken, Task>? beforeCommit = null)
    {
        Result<PublicAotBackfillDocument> document = await dbConcurrencyGate.ExecuteAsync(
            "public-aot-backfill",
            gateCt => documentComposition.BuildBackfillDocumentAsync(request, gateCt),
            _ =>
            {
                logger.LogWarning("db-gate-timeout public-aot-backfill {Kind} {RouteKey}", request.Kind, request.RouteKey);
                return Task.FromResult(Result<PublicAotBackfillDocument>.Failure(ErrorCode.InfraFailure, "db-gate-timeout"));
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

        PublicAotBackfillDocument backfillDocument = document.Value!;
        if (artifactStore.WasInvalidatedAfter(request))
        {
            logger.LogInformation(
                "Public AOT backfill skipped stale write after invalidation: {Kind} {RouteKey}",
                request.Kind,
                request.RouteKey);
            return;
        }

        try
        {
            await artifactStore.WriteBackfillAsync(
                request,
                backfillDocument,
                beforeCommit,
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
        await artifactStore.InvalidateAllAsync(cancellationToken);
        return Result.Success();
    }
}
