using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Security;

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
    private readonly IArticleDetailViewProjection? _articleDetailViews;
    private readonly IServiceScopeFactory? _serviceScopeFactory;
    private readonly IHotArticlesCacheVersionProvider? _hotArticlesVersionProvider;
    private readonly IHttpCacheInvalidator? _testHttpCacheInvalidator;
    private readonly BanStateProjection? _banStateProjection;
    private readonly AdminSessionProjection? _adminSessionProjection;
    private readonly IAccountStateProjection? _accountStateProjection;

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
        IRuntimeKeyScope? runtimeKeyScope = null,
        IArticleDetailViewProjection? articleDetailViews = null,
        BanStateProjection? banStateProjection = null,
        AdminSessionProjection? adminSessionProjection = null,
        IAccountStateProjection? accountStateProjection = null,
        IServiceScopeFactory? serviceScopeFactory = null,
        IHotArticlesCacheVersionProvider? hotArticlesVersionProvider = null)
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
        _articleDetailViews = articleDetailViews;
        _banStateProjection = banStateProjection;
        _adminSessionProjection = adminSessionProjection;
        _accountStateProjection = accountStateProjection;
        _serviceScopeFactory = serviceScopeFactory;
        _hotArticlesVersionProvider = hotArticlesVersionProvider;
    }

    internal DistributedInvalidationLocalApplier(
        PolicyShardedCacheL1Store localCache,
        PublicAotFileShellCache publicAotCache,
        PublicAotInvalidationTracker publicAotInvalidationTracker,
        PublicAotSsrRuntimeState publicAotSsrRuntimeState,
        PublicHotReadStore publicHotReadStore,
        PublicHotArtifactUpdateQueue publicHotUpdateQueue,
        IAotSeoConfigSnapshot aotSeoConfigSnapshot,
        CacheInvalidationRuntimeState cacheRuntimeState,
        ILogger<DistributedInvalidationLocalApplier> logger,
        IArticleDetailViewProjection? articleDetailViews = null,
        IHttpCacheInvalidator? httpCacheInvalidator = null,
        BanStateProjection? banStateProjection = null)
        : this(
            new PolicyShardedCacheL1StoreInvalidator(localCache),
            publicAotCache,
            publicAotInvalidationTracker,
            publicAotSsrRuntimeState,
            publicHotReadStore,
            publicHotUpdateQueue,
            aotSeoConfigSnapshot,
            cacheRuntimeState,
            logger,
            articleDetailViews: articleDetailViews,
            banStateProjection: banStateProjection)
    {
        _testHttpCacheInvalidator = httpCacheInvalidator;
    }

    public async Task<DistributedInvalidationLocalApplyResult?> ApplyAsync(
        DistributedInvalidationEvent invalidation,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(invalidation);
        cancellationToken.ThrowIfCancellationRequested();

        if (invalidation.Kind == DistributedInvalidationEventKinds.AdminSessionProjectionMutation)
        {
            return ApplyAdminSessionProjection(invalidation);
        }

        if (invalidation.Kind == DistributedInvalidationEventKinds.AccountStateProjectionMutation)
        {
            return await ApplyAccountStateProjectionAsync(invalidation, cancellationToken).ConfigureAwait(false);
        }

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
        if (invalidation.Kind == DistributedInvalidationEventKinds.PublicHotReadVersionPublished)
        {
            foreach (string artifactKey in invalidation.ArtifactKeys)
            {
                if (DistributedInvalidationTargetResolver.TryParsePublicHotReadVersion(artifactKey, out long version))
                {
                    _hotArticlesVersionProvider?.ObserveHotArticlesVersion(version);
                }
            }
        }
        CacheTag[] httpCacheTags = ResolveHttpCacheTags(invalidation.CacheTags);
        if (httpCacheTags.Length > 0)
        {
            await InvalidateHttpCacheAsync(httpCacheTags).ConfigureAwait(false);
        }
        foreach (DistributedArticleViewProjectionTarget target in plan.ArticleViewProjections)
        {
            _articleDetailViews?.ApplyAuthoritative(target.ArticleId, target.Views, target.Version);
        }
        foreach (DistributedBanStateProjectionTarget target in plan.BanStateProjections)
        {
            BanStateProjection projection = _banStateProjection
                ?? throw new InvalidOperationException("Ban-state projection is unavailable.");
            BanStateProjectionApplyResult applyResult = projection.Apply(new BanStateProjectionUpdate(
                target.AccountSubjectHash,
                target.Status,
                target.ReasonCode,
                target.Generation));
            if (applyResult is BanStateProjectionApplyResult.RejectedInvalid
                or BanStateProjectionApplyResult.FailedClosedConflict
                or BanStateProjectionApplyResult.RejectedOverBudget)
            {
                throw new InvalidDataException($"Ban-state projection event failed closed: {applyResult}.");
            }
        }
        if (invalidation.Kind == DistributedInvalidationEventKinds.BanStateProjection)
        {
            _cacheRuntimeState.Record(
                $"distributed:{invalidation.Kind}",
                $"event:{invalidation.EventId};targets:{plan.BanStateProjections.Count};fullReconcile:false");
            return new DistributedInvalidationLocalApplyResult(
                MemoryInvalidated: true,
                AotMemoryInvalidated: true,
                AotGenerationMarked: true,
                HotSnapshotRetired: true,
                DistributedInvalidationRebuildObligationStatus.Queued,
                DistributedInvalidationLocalApplyStatus.Applied,
                RebuildObligationId: null,
                RebuildGeneration: 1,
                AotGeneration: 0)
            {
                ResolvedTargetCount = plan.ParsedTargetCount
            };
        }
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
                ? await _publicAotInvalidationTracker
                    .MarkPrefixAsync(scopedKey, invalidation.EventId, cancellationToken)
                    .ConfigureAwait(false)
                : await _publicAotInvalidationTracker
                    .MarkKeyAsync(scopedKey, invalidation.EventId, cancellationToken)
                    .ConfigureAwait(false);
            if (!target.IsPrefix
                && PublicAotPageCatalog.TryGet(target.PageId, out PublicAotPageDescriptor descriptor))
            {
                _publicAotSsrRuntimeState.ClearRouteQuarantine(descriptor.Kind, target.RouteKey);
            }
        }

        aotGeneration = invalidation.Kind switch
        {
            DistributedInvalidationEventKinds.ArticleMutation
                or DistributedInvalidationEventKinds.SystemPageMutation
                or DistributedInvalidationEventKinds.TaxonomyMutation
                => await _publicAotInvalidationTracker
                    .MarkSitemapAsync(invalidation.EventId, cancellationToken)
                    .ConfigureAwait(false),
            DistributedInvalidationEventKinds.SeoMutation
                or DistributedInvalidationEventKinds.ComplianceMutation
                => await _publicAotInvalidationTracker
                    .MarkAllAsync(invalidation.EventId, cancellationToken)
                    .ConfigureAwait(false),
            _ => aotGeneration
        };

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

    private async Task<DistributedInvalidationLocalApplyResult> ApplyAccountStateProjectionAsync(
        DistributedInvalidationEvent invalidation,
        CancellationToken cancellationToken)
    {
        IAccountStateProjection projection = _accountStateProjection
            ?? throw new InvalidOperationException("Account-state projection is unavailable.");
        if (invalidation.ArtifactKeys.Count != 1
            || !AccountStateProjectionMutationPublisher.TryParseArtifact(
                invalidation.ArtifactKeys[0],
                out int accountId,
                out long requestedGeneration))
        {
            throw new InvalidDataException("Account-state projection target is invalid.");
        }

        AccountStateReadResult refreshed = await projection
            .RefreshAsync(accountId, cancellationToken: cancellationToken)
            .ConfigureAwait(false);
        long observedGeneration = refreshed.Snapshot?.Generation ?? 0;
        if (refreshed.Outcome is AccountStateReadOutcome.Unknown
            or AccountStateReadOutcome.Conflict
            or AccountStateReadOutcome.SubjectMismatch
            || observedGeneration < requestedGeneration)
        {
            projection.FailClosed(accountId);
            throw new InvalidDataException(
                $"Account-state projection failed to converge to generation {requestedGeneration}.");
        }

        _cacheRuntimeState.Record(
            $"distributed:{invalidation.Kind}",
            $"event:{invalidation.EventId};account:{accountId};generation:{observedGeneration};fullReconcile:false");
        return new DistributedInvalidationLocalApplyResult(
            MemoryInvalidated: true,
            AotMemoryInvalidated: true,
            AotGenerationMarked: true,
            HotSnapshotRetired: true,
            DistributedInvalidationRebuildObligationStatus.Queued,
            DistributedInvalidationLocalApplyStatus.Applied,
            RebuildObligationId: null,
            RebuildGeneration: observedGeneration,
            AotGeneration: 0)
        {
            ResolvedTargetCount = 1
        };
    }

    private DistributedInvalidationLocalApplyResult ApplyAdminSessionProjection(
        DistributedInvalidationEvent invalidation)
    {
        if (_adminSessionProjection is null)
        {
            throw new InvalidOperationException("admin_session_projection_missing");
        }

        long generation = 0;
        foreach (string target in invalidation.ArtifactKeys)
        {
            if (!AdminSessionProjectionEventCodec.TryParse(target, out var session, out var principal))
            {
                _adminSessionProjection.MarkNotReady("distributed-event-invalid");
                throw new InvalidDataException("admin_session_projection_target_invalid");
            }

            AdminSessionProjectionApplyResult applied = session.HasValue
                ? _adminSessionProjection.Apply(session.Value)
                : _adminSessionProjection.Apply(principal!.Value);
            if (!applied.Accepted)
            {
                throw new InvalidOperationException($"admin_session_projection_apply_{applied.Status}");
            }
            generation = Math.Max(generation, session?.Generation ?? principal?.Generation ?? 0);
        }

        return new DistributedInvalidationLocalApplyResult(
            MemoryInvalidated: true,
            AotMemoryInvalidated: true,
            AotGenerationMarked: true,
            HotSnapshotRetired: true,
            DistributedInvalidationRebuildObligationStatus.Queued,
            DistributedInvalidationLocalApplyStatus.Applied,
            RebuildObligationId: null,
            RebuildGeneration: Math.Max(1, generation),
            AotGeneration: 0)
        {
            ResolvedTargetCount = invalidation.ArtifactKeys.Count
        };
    }

    private static CacheTag[] ResolveHttpCacheTags(IReadOnlyList<string> domains)
    {
        var tags = new HashSet<CacheTag>();
        foreach (string domain in domains)
        {
            _ = domain switch
            {
                "article-list" => tags.Add(CacheTag.ArticleList),
                "hot-articles" => tags.Add(CacheTag.HotArticles),
                "stats" => tags.Add(CacheTag.Stats),
                "category" => tags.Add(CacheTag.Category),
                "tag" => tags.Add(CacheTag.Tag),
                "seo" => tags.Add(CacheTag.Seo),
                "system-page" => tags.Add(CacheTag.SystemPage),
                "comments" => tags.Add(CacheTag.Comment),
                _ => false
            };
        }

        return [.. tags.Order()];
    }

    private async Task InvalidateHttpCacheAsync(CacheTag[] tags)
    {
        if (_testHttpCacheInvalidator is not null)
        {
            await _testHttpCacheInvalidator.InvalidateAsync(tags).ConfigureAwait(false);
            return;
        }

        if (_serviceScopeFactory is null)
        {
            return;
        }

        await using AsyncServiceScope scope = _serviceScopeFactory.CreateAsyncScope();
        IHttpCacheInvalidator invalidator = scope.ServiceProvider.GetRequiredService<IHttpCacheInvalidator>();
        await invalidator.InvalidateAsync(tags).ConfigureAwait(false);
    }

    private async Task<DistributedInvalidationLocalApplyResult> ApplyFullReconcileAsync(
        DistributedInvalidationEvent invalidation,
        string reason,
        int parsedTargetCount,
        CancellationToken cancellationToken)
    {
        CacheL1InvalidationReceipt l1Receipt = _localCache.ReconcileAllLocal();
        _publicAotCache.InvalidateDistributedMemoryState();
        long publicAotGeneration = await _publicAotInvalidationTracker
            .MarkAllAsync(invalidation.EventId, cancellationToken)
            .ConfigureAwait(false);
        _publicAotSsrRuntimeState.ClearAllRouteQuarantines();
        _publicHotReadStore.InvalidateDistributedSnapshot(
            reason,
            PublicHotReadInvalidationPolicy.DropToEmpty);
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

    private sealed class PolicyShardedCacheL1StoreInvalidator(PolicyShardedCacheL1Store localStore) : ICacheLocalInvalidator
    {
        public CacheL1InvalidationReceipt InvalidateLocal(IReadOnlyList<CacheKeyIdentity> keys)
            => localStore.InvalidateLocal(keys);

        public CacheL1InvalidationReceipt ReconcileAllLocal()
            => localStore.ReconcileAllLocal();
    }
}
