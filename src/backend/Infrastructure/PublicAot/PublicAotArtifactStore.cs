using System.Security.Cryptography;
using System.Text;

using FsusBlog.Core.Cache;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Spa;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Shared.Contracts.Localization;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public interface IPublicAotArtifactStore
{
    PublicAotArtifactLookup CreateLookup(HttpContext context, PublicAotRouteMatch match);

    Task<PublicAotCacheEntry?> TryGetEntryAsync(
        PublicAotArtifactLookup lookup,
        CancellationToken cancellationToken);

    Task RemoveAsync(PublicAotArtifactLookup lookup, CancellationToken cancellationToken);

    bool IsRenderable(PublicAotCacheEntry? entry, PublicAotArtifactLookup lookup);

    bool TryScheduleBackfill(
        HttpContext context,
        PublicAotRouteMatch match,
        PublicAotArtifactLookup lookup);

    bool IsCurrentBackfill(PublicAotBackfillRequest request);

    Task<bool> WriteBackfillAsync(
        PublicAotBackfillRequest request,
        PublicAotBackfillDocument document,
        Func<CancellationToken, Task>? beforeCommit,
        CancellationToken cancellationToken);

    Task InvalidateAllAsync(CancellationToken cancellationToken);
}

public sealed record PublicAotArtifactLookup(
    string DocumentCacheKey,
    string PagePrefixKey,
    string FrontendAssetVersion,
    string AssetMode,
    string ExpectedLocale)
{
    public bool UsesDevelopmentSourceAssets
        => string.Equals(
            FrontendAssetVersion,
            SpaAssetManifestService.DevSourceAssetVersion,
            StringComparison.Ordinal);
}

internal sealed class PublicAotArtifactStore(
    IPublicAotShellCache cache,
    IPublicAotCacheWriter cacheWriter,
    IPublicAotBackfillScheduler backfillScheduler,
    ISpaAssetManifestService assetManifest,
    IRuntimeKeyScope runtimeKeyScope,
    PublicAotInvalidationTracker invalidationTracker) : IPublicAotArtifactStore
{
    public PublicAotArtifactLookup CreateLookup(HttpContext context, PublicAotRouteMatch match)
    {
        string invalidationKey = runtimeKeyScope.PrefixKey(
            CacheKeyBuilder.PublicAotDocument(match.PageId, match.RouteKey));
        string baseDocumentCacheKey = runtimeKeyScope.PrefixKey(
            CacheKeyBuilder.PublicAotDocument(
                match.PageId,
                match.RouteKey,
                match.LocaleResolution.Locale.Code));
        string pagePrefixKey = runtimeKeyScope.PrefixKey(
            CacheKeyBuilder.PublicAotDocument(match.PageId, string.Empty));
        string documentCacheKey = ResolveVersionedDocumentCacheKey(
            match.PageId,
            baseDocumentCacheKey,
            invalidationKey,
            pagePrefixKey);
        string frontendAssetVersion = assetManifest.GetFrontendAssetVersion(context);
        return new PublicAotArtifactLookup(
            documentCacheKey,
            pagePrefixKey,
            frontendAssetVersion,
            ResolveAssetMode(frontendAssetVersion),
            match.LocaleResolution.Locale.Code);
    }

    public Task<PublicAotCacheEntry?> TryGetEntryAsync(
        PublicAotArtifactLookup lookup,
        CancellationToken cancellationToken)
        => cache.TryGetEntryAsync(
            lookup.DocumentCacheKey,
            lookup.FrontendAssetVersion,
            cancellationToken);

    public Task RemoveAsync(PublicAotArtifactLookup lookup, CancellationToken cancellationToken)
        => cache.RemoveAsync(lookup.DocumentCacheKey, cancellationToken);

    public bool IsRenderable(PublicAotCacheEntry? entry, PublicAotArtifactLookup lookup)
        => IsRenderableCacheEntry(entry, lookup.FrontendAssetVersion)
            && string.Equals(entry!.Locale, lookup.ExpectedLocale, StringComparison.Ordinal);

    public bool TryScheduleBackfill(
        HttpContext context,
        PublicAotRouteMatch match,
        PublicAotArtifactLookup lookup)
        => backfillScheduler.TrySchedule(new PublicAotBackfillRequest(
            match.Kind,
            match.RouteKey,
            match.Path,
            match.QueryString,
            lookup.DocumentCacheKey)
        {
            InvalidationKey = runtimeKeyScope.PrefixKey(
                CacheKeyBuilder.PublicAotDocument(match.PageId, match.RouteKey)),
            PagePrefixKey = lookup.PagePrefixKey,
            ScheduledInvalidationVersion = invalidationTracker.GetCurrentVersion(
                runtimeKeyScope.PrefixKey(CacheKeyBuilder.PublicAotDocument(match.PageId, match.RouteKey)),
                lookup.PagePrefixKey),
            TestSessionId = ResolveTestSessionId(context),
            FrontendAssetVersion = lookup.FrontendAssetVersion,
            Locale = match.LocaleResolution.Locale.Code
        });

    public bool IsCurrentBackfill(PublicAotBackfillRequest request)
        => !string.IsNullOrWhiteSpace(request.FrontendAssetVersion)
            && string.Equals(
                request.FrontendAssetVersion,
                assetManifest.GetFrontendAssetVersion(),
                StringComparison.Ordinal)
            && invalidationTracker.GetCurrentVersion(request) == request.ScheduledInvalidationVersion;

    public async Task<bool> WriteBackfillAsync(
        PublicAotBackfillRequest request,
        PublicAotBackfillDocument document,
        Func<CancellationToken, Task>? beforeCommit,
        CancellationToken cancellationToken)
    {
        var commitRequest = new PublicAotBackfillCommitRequest(
            request.CacheKey,
            request.PagePrefixKey,
            request.ScheduledInvalidationVersion,
            request.FrontendAssetVersion,
            document.RendererVersion,
            Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(document.Html))));
        if (beforeCommit is not null)
        {
            await beforeCommit(cancellationToken).ConfigureAwait(false);
        }

        return await invalidationTracker.WithPublicationLockAsync(
            request.PagePrefixKey,
            async () =>
            {
                if (!IsCurrentBackfill(request))
                {
                    return false;
                }

                await cacheWriter.WriteAsync(
                    request.CacheKey,
                    document.Match.PageId,
                    document.Match.RouteKey,
                    document.RendererVersion,
                    request.FrontendAssetVersion,
                    request.Locale,
                    document.Html,
                    PublicAotWriteSource.ServerSsrBackfill,
                    document.RenderTimestampUtc,
                    TimeSpan.FromDays(30),
                    cancellationToken).ConfigureAwait(false);
                long publishedInvalidationVersion = invalidationTracker.GetCurrentVersion(request);
                invalidationTracker.RecordCommitReceipt(new PublicAotBackfillCommitReceipt(
                    commitRequest.CacheKey,
                    commitRequest.PagePrefixKey,
                    commitRequest.ScheduledInvalidationVersion,
                    publishedInvalidationVersion,
                    publishedInvalidationVersion,
                    commitRequest.FrontendAssetVersion,
                    commitRequest.RendererVersion,
                    commitRequest.PayloadDigest,
                    commitRequest.PayloadDigest,
                    commitRequest.PayloadDigest));
                return true;
            },
            cancellationToken).ConfigureAwait(false);
    }

    public Task InvalidateAllAsync(CancellationToken cancellationToken)
        => invalidationTracker.WithGlobalInvalidationLockAsync(async () =>
        {
            invalidationTracker.MarkAll();
            await cache.InvalidateAllAsync(cancellationToken).ConfigureAwait(false);
        }, cancellationToken);

    internal static bool IsRenderableCacheEntry(PublicAotCacheEntry? entry, string frontendAssetVersion)
        => IsCompatibleCacheEntry(entry, frontendAssetVersion)
            && entry!.ExpiresAtUtc > DateTimeOffset.UtcNow;

    private static bool IsCompatibleCacheEntry(PublicAotCacheEntry? entry, string frontendAssetVersion)
    {
        if (entry is null)
        {
            return false;
        }

        if (string.IsNullOrWhiteSpace(entry.RendererVersion)
            || string.IsNullOrWhiteSpace(entry.FrontendAssetVersion))
        {
            return false;
        }

        return string.Equals(entry.RendererVersion, PublicAotConstants.RendererVersion, StringComparison.Ordinal)
            && string.Equals(entry.FrontendAssetVersion, frontendAssetVersion, StringComparison.Ordinal)
            && FsusBlog.Shared.Contracts.Localization.LocaleCatalog.TryParse(
                entry.Locale,
                out FsusBlog.Shared.Contracts.Localization.LocaleDescriptor cacheLocale)
            && string.Equals(entry.Locale, cacheLocale.Code, StringComparison.Ordinal)
            && !entry.GetDocument().Utf8Bytes.IsEmpty;
    }

    private static string ResolveAssetMode(string frontendAssetVersion)
        => string.Equals(frontendAssetVersion, SpaAssetManifestService.DevSourceAssetVersion, StringComparison.Ordinal)
            ? SpaAssetManifestService.DevSourceAssetVersion
            : "prod-manifest";

    private string ResolveVersionedDocumentCacheKey(
        PublicPageId pageId,
        string cacheKey,
        string invalidationKey,
        string pagePrefixKey)
    {
        long version = invalidationTracker.GetCurrentVersion(invalidationKey, pagePrefixKey);
        return string.Concat(cacheKey, ":iv:", version.ToString());
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

public sealed record PublicAotBackfillCommitRequest(
    string CacheKey,
    string PagePrefixKey,
    long ScheduledInvalidationVersion,
    string FrontendAssetVersion,
    string RendererVersion,
    string PayloadDigest);
