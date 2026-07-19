using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;

namespace FsusBlog.Server.Infrastructure.Operations;

internal static class PublicArticleProjectionAdminActions
{
    internal const string Status = "public-article-projection-backfill-status";
    internal const string Pause = "public-article-projection-backfill-pause";
    internal const string Resume = "public-article-projection-backfill-resume";
}

public interface IAdminArtifactOperations
{
    Task<AdminCacheActionResponse> RunCacheActionAsync(
        AdminCacheActionRequest request,
        CancellationToken cancellationToken);
}

internal sealed class AdminArtifactOperations(
    ISearchIndexService searchIndexService,
    PublicHotArtifactUpdateQueue publicHotArtifactUpdateQueue,
    IPublicAotInvalidationService publicAotInvalidationService,
    IArticleDetailAedsArtifactMaintenanceService articleDetailAedsMaintenance,
    ICacheInvalidationDispatcher cacheInvalidationDispatcher) : IAdminArtifactOperations
{
    public async Task<AdminCacheActionResponse> RunCacheActionAsync(
        AdminCacheActionRequest request,
        CancellationToken cancellationToken)
    {
        string action = NormalizeAction(request.Action);
        switch (action)
        {
            case "search-rebuild":
                await searchIndexService.BuildIndexAsync([]);
                return ActionResult(action, "ok", "search index rebuild completed");
            case "public-hot-rebuild":
            case "aot-rebuild":
                if (request.ArticleId is > 0)
                {
                    await publicAotInvalidationService.InvalidateArticleMutationAsync(
                        request.ArticleId,
                        null,
                        null,
                        cancellationToken);
                }
                else
                {
                    await publicAotInvalidationService.InvalidateAllAsync(cancellationToken);
                }

                bool queued = publicHotArtifactUpdateQueue.TryEnqueue(request.ArticleId, "admin-cache-action");
                return ActionResult(
                    action,
                    queued ? "queued" : "degraded",
                    queued ? "public hot/AOT rebuild queued" : "AOT invalidated; public hot rebuild queue rejected");
            case "output-cache-clear":
                await Task.WhenAll(
                    cacheInvalidationDispatcher.InvalidateArticleMutationAsync(request.ArticleId, cancellationToken),
                    cacheInvalidationDispatcher.InvalidateSeoAsync(cancellationToken));
                return ActionResult(action, "ok", "output/cache tags invalidated");
            case "recompute-article-rights":
                {
                    ArticleDetailAedsArtifactMaintenanceResult result =
                        await articleDetailAedsMaintenance.RecomputeArticleRightsAsync(cancellationToken);
                    return ActionResult(action, result.Failed == 0 ? "ok" : "degraded", result.ToDetail());
                }
            case "rebuild-article-detail-aeds-v3":
                {
                    bool all = request.ArticleId is not > 0;
                    ArticleDetailAedsArtifactMaintenanceResult result =
                        await articleDetailAedsMaintenance.RebuildArticleDetailAedsV3Async(
                            all,
                            request.ArticleId,
                            cancellationToken);
                    return ActionResult(action, result.Failed == 0 ? "ok" : "degraded", result.ToDetail());
                }
            case PublicArticleProjectionAdminActions.Status:
                {
                    PublicArticleProjectionBackfillState state =
                        await articleDetailAedsMaintenance.GetPublicProjectionBackfillStateAsync(cancellationToken);
                    return ActionResult(
                        action,
                        state.State,
                        $"lastArticleId={state.LastArticleId}, ratePerSecond={state.RatePerSecond}, rebuilt={state.RebuiltCount}, failed={state.FailedCount}, updatedAt={state.UpdatedAtUtc:O}");
                }
            case PublicArticleProjectionAdminActions.Pause:
                await articleDetailAedsMaintenance.PausePublicProjectionBackfillAsync(cancellationToken);
                return ActionResult(action, "paused", "public article projection backfill paused at the durable watermark");
            case PublicArticleProjectionAdminActions.Resume:
                {
                    ArticleDetailAedsArtifactMaintenanceResult result =
                        await articleDetailAedsMaintenance.ResumePublicProjectionBackfillAsync(cancellationToken);
                    return ActionResult(action, result.Failed == 0 ? "ok" : "degraded", result.ToDetail());
                }
            case "sitemap-feed-refresh":
                await cacheInvalidationDispatcher.InvalidateSeoAsync(cancellationToken);
                return ActionResult(action, "ok", "feed/sitemap cache invalidated");
            default:
                return ActionResult(
                    action,
                    "unsupported",
                    "supported actions: search-rebuild, aot-rebuild, public-hot-rebuild, output-cache-clear, recompute-article-rights, rebuild-article-detail-aeds-v3, public-article-projection-backfill-status, public-article-projection-backfill-pause, public-article-projection-backfill-resume, sitemap-feed-refresh");
        }
    }

    private static AdminCacheActionResponse ActionResult(string action, string status, string detail)
        => new(action, status, detail, DateTimeOffset.UtcNow);

    private static string NormalizeAction(string? action)
        => TextHelpers.LowerTrimmed(action) ?? "unknown";
}
