using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;

namespace FsusBlog.Server.Infrastructure.Distributed;

public sealed class DistributedInvalidationLocalApplier(
    CacheLocalStore localCache,
    PublicAotFileShellCache publicAotCache,
    PublicAotInvalidationTracker publicAotInvalidationTracker,
    PublicAotSsrRuntimeState publicAotSsrRuntimeState,
    PublicHotReadStore publicHotReadStore,
    PublicHotArtifactUpdateQueue publicHotUpdateQueue,
    IAotSeoConfigSnapshot aotSeoConfigSnapshot,
    CacheInvalidationRuntimeState cacheRuntimeState,
    ILogger<DistributedInvalidationLocalApplier> logger) : IDistributedInvalidationLocalApplier
{
    public Task ApplyAsync(
        DistributedInvalidationEvent invalidation,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(invalidation);
        cancellationToken.ThrowIfCancellationRequested();

        localCache.ClearForDistributedInvalidation();
        publicAotCache.InvalidateDistributedMemoryState();
        publicAotInvalidationTracker.MarkAll();
        publicAotSsrRuntimeState.ClearAllRouteQuarantines();
        publicHotReadStore.InvalidateDistributedSnapshot(invalidation.Kind);
        if (invalidation.Kind is DistributedInvalidationEventKinds.SeoMutation
            or DistributedInvalidationEventKinds.ComplianceMutation)
        {
            aotSeoConfigSnapshot.Invalidate();
        }

        PublicHotArtifactEnqueueResult queued = publicHotUpdateQueue.Enqueue(
            null,
            $"distributed-invalidation:{invalidation.Kind}");
        string detail = string.Join(
            ';',
            $"event:{invalidation.EventId}",
            $"source:{invalidation.SourceNodeId}",
            $"trace:{invalidation.TraceId}",
            $"rebuild:{(queued.Accepted ? "queued" : "degraded")}");
        cacheRuntimeState.Record($"distributed:{invalidation.Kind}", detail);
        logger.LogInformation(
            "distributed-invalidation-local-convergence {EventId} {Kind} {SourceNodeId} {TraceId} {RebuildAccepted}",
            invalidation.EventId,
            invalidation.Kind,
            invalidation.SourceNodeId,
            invalidation.TraceId,
            queued.Accepted);
        return Task.CompletedTask;
    }
}
