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
    public async Task<DistributedInvalidationLocalApplyResult?> ApplyAsync(
        DistributedInvalidationEvent invalidation,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(invalidation);
        cancellationToken.ThrowIfCancellationRequested();

        localCache.ClearForDistributedInvalidation();
        publicAotCache.InvalidateDistributedMemoryState();
        long publicAotGeneration =
            publicAotInvalidationTracker.MarkAll(invalidation.EventId);
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
        DistributedInvalidationRebuildObligationStatus rebuildStatus = queued.Status switch
        {
            PublicHotArtifactDeliveryStatus.Accepted => DistributedInvalidationRebuildObligationStatus.Queued,
            PublicHotArtifactDeliveryStatus.PersistedDirty or PublicHotArtifactDeliveryStatus.Coalesced
                when queued.DeliveryGeneration > 0 && !string.IsNullOrWhiteSpace(queued.ObligationId)
                => DistributedInvalidationRebuildObligationStatus.Durable,
            PublicHotArtifactDeliveryStatus.Closed when queued.DeliveryGeneration > 0
                && !string.IsNullOrWhiteSpace(queued.ObligationId)
                => DistributedInvalidationRebuildObligationStatus.Durable,
            PublicHotArtifactDeliveryStatus.Closed => DistributedInvalidationRebuildObligationStatus.Rejected,
            PublicHotArtifactDeliveryStatus.Cancelled =>
                throw new OperationCanceledException("distributed public-hot delivery cancelled", cancellationToken),
            PublicHotArtifactDeliveryStatus.Failed => DistributedInvalidationRebuildObligationStatus.Failed,
            _ => throw new InvalidOperationException("distributed public-hot delivery status is unknown")
        };
        DistributedInvalidationLocalApplyStatus localStatus = rebuildStatus switch
        {
            DistributedInvalidationRebuildObligationStatus.Durable or DistributedInvalidationRebuildObligationStatus.Queued
                => DistributedInvalidationLocalApplyStatus.Applied,
            DistributedInvalidationRebuildObligationStatus.Rejected => DistributedInvalidationLocalApplyStatus.DegradedRetryable,
            DistributedInvalidationRebuildObligationStatus.Failed => DistributedInvalidationLocalApplyStatus.FailedTerminal,
            _ => throw new InvalidOperationException("distributed public-hot rebuild obligation is unknown")
        };
        string detail = string.Join(
            ';',
            $"event:{invalidation.EventId}",
            $"source:{invalidation.SourceNodeId}",
            $"trace:{invalidation.TraceId}",
            $"publicAotGeneration:{publicAotGeneration}",
            $"rebuild:{rebuildStatus}",
            $"obligation:{queued.ObligationId ?? "none"}",
            $"generation:{queued.DeliveryGeneration}");
        cacheRuntimeState.Record($"distributed:{invalidation.Kind}", detail);
        logger.LogInformation(
            "distributed-invalidation-local-convergence {EventId} {Kind} {SourceNodeId} {TraceId} {RebuildStatus}",
            invalidation.EventId,
            invalidation.Kind,
            invalidation.SourceNodeId,
            invalidation.TraceId,
            rebuildStatus);
        return new DistributedInvalidationLocalApplyResult(
            MemoryInvalidated: true,
            AotMemoryInvalidated: true,
            AotGenerationMarked: true,
            HotSnapshotRetired: true,
            rebuildStatus,
            localStatus,
            queued.ObligationId,
            queued.DeliveryGeneration,
            publicAotGeneration);
    }
}
