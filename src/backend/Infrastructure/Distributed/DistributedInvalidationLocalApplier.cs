using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;

using Microsoft.Extensions.DependencyInjection;

namespace FsusBlog.Server.Infrastructure.Distributed;

public sealed class DistributedInvalidationLocalApplier : IDistributedInvalidationLocalApplier
{
    private readonly ICacheLocalInvalidator _localCache;
    private readonly PublicAotFileShellCache _publicAotCache;
    private readonly PublicAotInvalidationTracker _publicAotInvalidationTracker;
    private readonly PublicAotSsrRuntimeState _publicAotSsrRuntimeState;
    private readonly PublicHotReadStore _publicHotReadStore;
    private readonly PublicHotArtifactUpdateQueue _publicHotUpdateQueue;
    private readonly IAotSeoConfigSnapshot _aotSeoConfigSnapshot;
    private readonly CacheInvalidationRuntimeState _cacheRuntimeState;
    private readonly ILogger<DistributedInvalidationLocalApplier> _logger;
    private readonly IRuntimeKeyScope? _runtimeKeyScope;

    [ActivatorUtilitiesConstructor]
    public DistributedInvalidationLocalApplier(
        ICacheLocalInvalidator localCache,
        PublicAotFileShellCache publicAotCache,
        PublicAotInvalidationTracker publicAotInvalidationTracker,
        PublicAotSsrRuntimeState publicAotSsrRuntimeState,
        PublicHotReadStore publicHotReadStore,
        PublicHotArtifactUpdateQueue publicHotUpdateQueue,
        IAotSeoConfigSnapshot aotSeoConfigSnapshot,
        CacheInvalidationRuntimeState cacheRuntimeState,
        ILogger<DistributedInvalidationLocalApplier> logger,
        IRuntimeKeyScope? runtimeKeyScope = null)
    {
        _localCache = localCache;
        _publicAotCache = publicAotCache;
        _publicAotInvalidationTracker = publicAotInvalidationTracker;
        _publicAotSsrRuntimeState = publicAotSsrRuntimeState;
        _publicHotReadStore = publicHotReadStore;
        _publicHotUpdateQueue = publicHotUpdateQueue;
        _aotSeoConfigSnapshot = aotSeoConfigSnapshot;
        _cacheRuntimeState = cacheRuntimeState;
        _logger = logger;
        _runtimeKeyScope = runtimeKeyScope;
    }

    internal DistributedInvalidationLocalApplier(
        CacheLocalStore localCache,
        PublicAotFileShellCache publicAotCache,
        PublicAotInvalidationTracker publicAotInvalidationTracker,
        PublicAotSsrRuntimeState publicAotSsrRuntimeState,
        PublicHotReadStore publicHotReadStore,
        PublicHotArtifactUpdateQueue publicHotUpdateQueue,
        IAotSeoConfigSnapshot aotSeoConfigSnapshot,
        CacheInvalidationRuntimeState cacheRuntimeState,
        ILogger<DistributedInvalidationLocalApplier> logger)
        : this(
            new CacheLocalStoreInvalidator(localCache),
            publicAotCache,
            publicAotInvalidationTracker,
            publicAotSsrRuntimeState,
            publicHotReadStore,
            publicHotUpdateQueue,
            aotSeoConfigSnapshot,
            cacheRuntimeState,
            logger)
    {
    }

    public async Task<DistributedInvalidationLocalApplyResult?> ApplyAsync(
        DistributedInvalidationEvent invalidation,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(invalidation);
        cancellationToken.ThrowIfCancellationRequested();

        DistributedInvalidationTargetPlan plan;
        try
        {
            plan = DistributedInvalidationTargetResolver.Resolve(invalidation);
        }
        catch (InvalidDataException ex)
        {
            return await ApplyFullReconcileAsync(
                    invalidation,
                    $"invalid-payload:{ex.Message}",
                    parsedTargetCount: 0,
                    cancellationToken)
                .ConfigureAwait(false);
        }

        if (!plan.IsExact)
        {
            return await ApplyFullReconcileAsync(
                    invalidation,
                    plan.FullReconcileReason ?? "distributed-target-resolution-failed",
                    plan.ParsedTargetCount,
                    cancellationToken)
                .ConfigureAwait(false);
        }

        CacheL1InvalidationReceipt l1Receipt = _localCache.InvalidateLocal(plan.CacheKeys);
        cancellationToken.ThrowIfCancellationRequested();

        string[] aotCacheKeys = plan.AotTargets
            .Select(target => ScopeAotKey(target.CacheKey))
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        _ = await _publicAotCache
            .ApplyDistributedInvalidationAsync(aotCacheKeys, cancellationToken)
            .ConfigureAwait(false);
        int aotRouteCount = plan.AotTargets.Count;
        long aotGeneration = _publicAotInvalidationTracker.Snapshot().CurrentVersion;
        foreach (DistributedInvalidationAotTarget target in plan.AotTargets)
        {
            string scopedKey = ScopeAotKey(target.CacheKey);
            aotGeneration = target.IsPrefix
                ? _publicAotInvalidationTracker.MarkPrefix(scopedKey, invalidation.EventId)
                : _publicAotInvalidationTracker.MarkKey(scopedKey, invalidation.EventId);
            if (!target.IsPrefix
                && PublicAotPageCatalog.TryGet(target.PageId, out PublicAotPageDescriptor descriptor))
            {
                _publicAotSsrRuntimeState.ClearRouteQuarantine(descriptor.Kind, target.RouteKey);
            }
        }

        if (invalidation.Kind is DistributedInvalidationEventKinds.SeoMutation
            or DistributedInvalidationEventKinds.ComplianceMutation)
        {
            _aotSeoConfigSnapshot.Invalidate();
        }

        int hotReadFragmentCount = _publicHotReadStore.ApplyDistributedFragments(plan.HotReadFragments);
        PublicHotArtifactEnqueueResult queued = await _publicHotUpdateQueue
            .EnqueueDistributedFragmentsAsync(
                plan.HotReadFragments,
                $"distributed-invalidation:{invalidation.Kind}:{invalidation.EventId}",
                cancellationToken)
            .ConfigureAwait(false);
        DistributedInvalidationRebuildObligationStatus rebuildStatus = MapRebuildStatus(queued, cancellationToken);
        DistributedInvalidationLocalApplyStatus localStatus = MapLocalStatus(rebuildStatus);
        string detail = string.Join(
            ';',
            $"event:{invalidation.EventId}",
            $"source:{invalidation.SourceNodeId}",
            $"trace:{invalidation.TraceId}",
            $"targets:{plan.ParsedTargetCount}",
            $"l1Policies:{l1Receipt.ByPolicy.Count}",
            $"l1Entries:{l1Receipt.EntryCount}",
            $"l1Bytes:{l1Receipt.Bytes}",
            $"aotRoutes:{aotRouteCount}",
            $"hotFragments:{hotReadFragmentCount}",
            "fullReconcile:false",
            $"rebuild:{rebuildStatus}",
            $"obligation:{queued.ObligationId ?? "none"}",
            $"generation:{queued.DeliveryGeneration}");
        _cacheRuntimeState.Record($"distributed:{invalidation.Kind}", detail);
        _logger.LogInformation(
            "distributed-invalidation-local-convergence {EventId} {Kind} {SourceNodeId} {TraceId} {L1Entries} {AotRoutes} {HotFragments} {RebuildStatus}",
            invalidation.EventId,
            invalidation.Kind,
            invalidation.SourceNodeId,
            invalidation.TraceId,
            l1Receipt.EntryCount,
            aotRouteCount,
            hotReadFragmentCount,
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
            aotGeneration)
        {
            ResolvedTargetCount = plan.ParsedTargetCount,
            L1InvalidatedPolicyCount = l1Receipt.ByPolicy.Count,
            L1InvalidatedEntryCount = l1Receipt.EntryCount,
            L1InvalidatedBytes = l1Receipt.Bytes,
            AotRouteCount = aotRouteCount,
            HotReadFragmentCount = hotReadFragmentCount,
            FullReconcile = false
        };
    }

    private async Task<DistributedInvalidationLocalApplyResult> ApplyFullReconcileAsync(
        DistributedInvalidationEvent invalidation,
        string reason,
        int parsedTargetCount,
        CancellationToken cancellationToken)
    {
        CacheL1InvalidationReceipt l1Receipt = _localCache.ReconcileAllLocal();
        _publicAotCache.InvalidateDistributedMemoryState();
        long publicAotGeneration = _publicAotInvalidationTracker.MarkAll(invalidation.EventId);
        _publicAotSsrRuntimeState.ClearAllRouteQuarantines();
        _publicHotReadStore.InvalidateDistributedSnapshot(reason);
        PublicHotArtifactEnqueueResult queued = await _publicHotUpdateQueue.EnqueueAsync(
                PublicHotArtifactDeliveryClass.FullRebuildMarker,
                null,
                $"distributed-full-reconcile:{reason}",
                cancellationToken: cancellationToken)
            .ConfigureAwait(false);
        _cacheRuntimeState.Record(
            "distributed_full_reconcile",
            $"event:{invalidation.EventId};kind:{invalidation.Kind};reason:{reason}");
        _logger.LogError(
            "distributed-invalidation-full-reconcile {EventId} {Kind} {Reason}",
            invalidation.EventId,
            invalidation.Kind,
            reason);
        return new DistributedInvalidationLocalApplyResult(
            MemoryInvalidated: true,
            AotMemoryInvalidated: true,
            AotGenerationMarked: true,
            HotSnapshotRetired: true,
            MapRebuildStatus(queued, cancellationToken),
            DistributedInvalidationLocalApplyStatus.FailedTerminal,
            queued.ObligationId,
            queued.DeliveryGeneration,
            publicAotGeneration)
        {
            ResolvedTargetCount = parsedTargetCount,
            L1InvalidatedPolicyCount = l1Receipt.ByPolicy.Count,
            L1InvalidatedEntryCount = l1Receipt.EntryCount,
            L1InvalidatedBytes = l1Receipt.Bytes,
            AotRouteCount = 0,
            HotReadFragmentCount = 0,
            FullReconcile = true,
            FullReconcileReason = reason
        };
    }

    private string ScopeAotKey(string key)
        => _runtimeKeyScope?.PrefixKey(key) ?? key;

    private static DistributedInvalidationRebuildObligationStatus MapRebuildStatus(
        PublicHotArtifactEnqueueResult queued,
        CancellationToken cancellationToken)
        => queued.Status switch
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
                throw new OperationCanceledException("distributed public-hot fragment delivery cancelled", cancellationToken),
            PublicHotArtifactDeliveryStatus.Failed => DistributedInvalidationRebuildObligationStatus.Failed,
            _ => throw new InvalidOperationException("distributed public-hot fragment delivery status is unknown")
        };

    private static DistributedInvalidationLocalApplyStatus MapLocalStatus(
        DistributedInvalidationRebuildObligationStatus rebuildStatus)
        => rebuildStatus switch
        {
            DistributedInvalidationRebuildObligationStatus.Durable or DistributedInvalidationRebuildObligationStatus.Queued
                => DistributedInvalidationLocalApplyStatus.Applied,
            DistributedInvalidationRebuildObligationStatus.Rejected => DistributedInvalidationLocalApplyStatus.DegradedRetryable,
            DistributedInvalidationRebuildObligationStatus.Failed => DistributedInvalidationLocalApplyStatus.FailedTerminal,
            _ => throw new InvalidOperationException("distributed public-hot fragment obligation is unknown")
        };

    private sealed class CacheLocalStoreInvalidator(CacheLocalStore localStore) : ICacheLocalInvalidator
    {
        public CacheL1InvalidationReceipt InvalidateLocal(IReadOnlyList<CacheKeyIdentity> keys)
            => localStore.InvalidateLocal(keys);

        public CacheL1InvalidationReceipt ReconcileAllLocal()
            => localStore.ReconcileAllLocal();
    }
}
