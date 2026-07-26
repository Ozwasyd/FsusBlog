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
    public async Task ApplyAsync(
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

        PublicHotArtifactEnqueueResult queued = await publicHotUpdateQueue.EnqueueAsync(
                PublicHotArtifactDeliveryClass.FullRebuildMarker,
                null,
                $"distributed-invalidation:{invalidation.Kind}",
                cancellationToken: cancellationToken)
            .ConfigureAwait(false);
        string rebuild = queued.Status switch
        {
            PublicHotArtifactDeliveryStatus.Accepted => "accepted",
            PublicHotArtifactDeliveryStatus.PersistedDirty => "persisted-dirty",
            PublicHotArtifactDeliveryStatus.Coalesced => "coalesced",
            PublicHotArtifactDeliveryStatus.Cancelled =>
                throw new OperationCanceledException("distributed public-hot delivery cancelled", cancellationToken),
            PublicHotArtifactDeliveryStatus.Closed =>
                throw new InvalidOperationException("distributed public-hot delivery channel closed"),
            PublicHotArtifactDeliveryStatus.Failed =>
                throw new InvalidOperationException("distributed public-hot delivery persistence failed"),
            _ => throw new InvalidOperationException("distributed public-hot delivery status is unknown")
        };
        string detail = string.Join(
            ';',
            $"event:{invalidation.EventId}",
            $"source:{invalidation.SourceNodeId}",
            $"trace:{invalidation.TraceId}",
            $"rebuild:{rebuild}");
        cacheRuntimeState.Record($"distributed:{invalidation.Kind}", detail);
        logger.LogInformation(
            "distributed-invalidation-local-convergence {EventId} {Kind} {SourceNodeId} {TraceId} {RebuildStatus}",
            invalidation.EventId,
            invalidation.Kind,
            invalidation.SourceNodeId,
            invalidation.TraceId,
            rebuild);
    }
}
