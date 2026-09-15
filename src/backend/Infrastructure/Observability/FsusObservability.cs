using System.Collections.Concurrent;
using System.Collections.Frozen;
using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Runtime.CompilerServices;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Infrastructure.Testing;

namespace FsusBlog.Server.Infrastructure.Observability;

public sealed record FsusRouteKindMetadata(string RouteKind);

public sealed record SecurityChallengeV2PerformanceBudgetSnapshot(
    string Status,
    double IssueP99Ms,
    double VerifyP99Ms,
    int PayloadP95Bytes,
    double ClientRenderP95Ms,
    int IssueP99BudgetMs,
    int VerifyP99BudgetMs,
    int PayloadP95BudgetBytes,
    int ClientRenderP95BudgetMs,
    IReadOnlyList<string> Warnings);

public sealed record CacheOperationRuntimeCounter(
    string Operation,
    string Policy,
    string Layer,
    string Result,
    long Count);

public sealed record CacheL1TelemetryRuntimeSnapshot(
    int SeriesCount,
    int SampleRate,
    long ExactHitCount,
    long DurationSampleCount,
    long WeightedDurationSampleCount);

public readonly record struct CachePolicyHitMissRuntimeCounter(long Hits, long Misses);

internal readonly record struct CacheOperationMetricKey(
    string Operation,
    string Policy,
    string Layer,
    string Result);

internal readonly record struct SecurityEventTagCacheKey(string Operation, string Reason, string Result);

public static class FsusObservability
{
    public const string DefaultServiceName = "FsusBlog";
    public const string ServiceVersion = "2.0.0";
    public const string ActivitySourceName = "FsusBlog.Server";
    public const string MeterName = "FsusBlog.Server";

    private static readonly string[] s_allowedCustomAttributeNames =
    [
        "fsus.aot.backfill",
        "fsus.aot.source",
        "fsus.admin.account_list.cursor",
        "fsus.admin.account_list.keyword_type",
        "fsus.admin.account_list.page",
        "fsus.admin.account_list.page_size",
        "fsus.anonymous_nullifier.status",
        "fsus.background.backlog",
        "fsus.background.failed",
        "fsus.background.job",
        "fsus.background.published",
        "fsus.cache.layer",
        "fsus.cache.operation",
        "fsus.cache.policy",
        "fsus.cache.sample_rate",
        "fsus.component",
        "fsus.db.operation",
        "fsus.db.system",
        "fsus.exporter.enabled",
        "fsus.http.status_code",
        "fsus.operation",
        "fsus.passkey.assertion.kind",
        "fsus.result",
        "fsus.route_kind",
        "fsus.security.action",
        "fsus.security.kind",
        "fsus.security.outcome",
        "fsus.security.policy_version",
        "fsus.security.reason",
        "fsus.security.source",
        "fsus.security.task_kind",
        "fsus.search.mode",
        "fsus.notification_stream.operation",
        "fsus.upload.cleanup.signal"
    ];

    private static readonly FrozenSet<string> s_allowedCustomAttributes = s_allowedCustomAttributeNames.ToFrozenSet(StringComparer.Ordinal);

    public static readonly ActivitySource ActivitySource = new(ActivitySourceName, ServiceVersion);

    private static readonly Meter s_meter = new(MeterName, ServiceVersion);
    private static readonly Counter<long> s_operationCounter = s_meter.CreateCounter<long>("fsus.operation.count");
    private static readonly ConcurrentDictionary<CacheOperationMetricKey, CacheOperationMetricState> s_cacheOperationRuntimeCounters = new();
    public const int CacheL1DurationSampleRate = 64;
    private const int SecurityEventTagCacheLimit = 256;
    private static readonly ConcurrentDictionary<string, string> s_routeKindCache = new(StringComparer.Ordinal);
    private static readonly Histogram<double> s_operationDuration = s_meter.CreateHistogram<double>("fsus.operation.duration", "ms");
    private static readonly Counter<long> s_cacheOperationCounter = s_meter.CreateCounter<long>("fsus.cache.operation.count");
    private static readonly Histogram<double> s_cacheL1HitDuration = s_meter.CreateHistogram<double>("fsus.cache.l1.hit.duration", "ms");
    private static readonly CacheL1MetricState?[] s_cacheL1States = CreateCacheL1States();
    private static readonly CachePolicyHitMissMetricState?[] s_cachePolicyHitMissStates = CreateCachePolicyHitMissStates();
    private static long s_cacheL1SampleSequence;
    private static readonly ObservableCounter<long> s_cacheL1HitCounter = s_meter.CreateObservableCounter(
        "fsus.cache.l1.hit.count",
        ObserveCacheL1Hits);
    private static readonly ObservableCounter<long> s_cacheL1DurationSampleCounter = s_meter.CreateObservableCounter(
        "fsus.cache.l1.hit.duration.sample.count",
        ObserveCacheL1DurationSamples);
    private static readonly ObservableCounter<long> s_cacheL1DurationWeightedCounter = s_meter.CreateObservableCounter(
        "fsus.cache.l1.hit.duration.weighted_count",
        ObserveCacheL1DurationWeightedCounts);
    private static readonly Counter<long> s_securityEventCounter = s_meter.CreateCounter<long>("fsus.security.event.count");
    private static readonly Counter<long> s_securityEventTagCacheMissCounter = s_meter.CreateCounter<long>("fsus.observability.tag_cache.miss_count");
    private static readonly Histogram<double> s_securityEventRecordElapsed = s_meter.CreateHistogram<double>("fsus.observability.record_security_event.elapsed", "ms");
    private static readonly Counter<long> s_securityRiskEventCounter = s_meter.CreateCounter<long>("fsus.security.risk.event.count");
    private static readonly Counter<long> s_securityChallengeIssuedCounter = s_meter.CreateCounter<long>("fsus.security.challenge.issued.count");
    private static readonly Counter<long> s_securityChallengeVerifiedCounter = s_meter.CreateCounter<long>("fsus.security.challenge.verified.count");
    private static readonly Counter<long> s_securityChallengeFailedCounter = s_meter.CreateCounter<long>("fsus.security.challenge.failed.count");
    private static readonly Counter<long> s_securityChallengeReplayedCounter = s_meter.CreateCounter<long>("fsus.security.challenge.replayed.count");
    private static readonly Histogram<double> s_securityChallengeSolveDuration = s_meter.CreateHistogram<double>("fsus.security.challenge.solve.duration", "ms");
    private static readonly Counter<long> s_perceptionCharacterV3AllocationCounter = s_meter.CreateCounter<long>("fsus.security.perception_character_v3.allocation.count");
    private static readonly Counter<long> s_perceptionCharacterV3EgressBytes = s_meter.CreateCounter<long>("fsus.security.perception_character_v3.egress.bytes", "By");
    private static readonly Histogram<long> s_perceptionCharacterV3PoolEntries = s_meter.CreateHistogram<long>("fsus.security.perception_character_v3.pool.entries", "{entry}");
    private static readonly Counter<long> s_securityChallengeV2IssuedCounter = s_meter.CreateCounter<long>("fsus.security.challenge.v2.issued.count");
    private static readonly Counter<long> s_securityChallengeV2VerifiedCounter = s_meter.CreateCounter<long>("fsus.security.challenge.v2.verified.count");
    private static readonly Counter<long> s_securityChallengeV2FailedCounter = s_meter.CreateCounter<long>("fsus.security.challenge.v2.failed.count");
    private static readonly Counter<long> s_securityChallengeV2ReplayedCounter = s_meter.CreateCounter<long>("fsus.security.challenge.v2.replayed.count");
    private static readonly Histogram<double> s_securityChallengeV2SolveDuration = s_meter.CreateHistogram<double>("fsus.security.challenge.v2.solve.duration", "ms");
    private static readonly Counter<long> s_challengeVerifyRateLimitedBeforeJson = s_meter.CreateCounter<long>("fsus.security.challenge.verify.rate_limited_before_json");
    private static readonly Histogram<double> s_providerPayloadParseElapsed = s_meter.CreateHistogram<double>("fsus.security.challenge.provider_payload.parse_elapsed_ms", "ms");
    private static readonly Counter<long> s_providerPayloadRejectedBytes = s_meter.CreateCounter<long>("fsus.security.challenge.provider_payload.rejected_bytes", "By");
    private static readonly Histogram<long> s_challengeVerifyAllocationBytes = s_meter.CreateHistogram<long>("fsus.security.challenge.verify.allocation_bytes", "By");
    private static readonly Histogram<double> s_securityChallengeV2PayloadBytes = s_meter.CreateHistogram<double>("fsus.security.challenge.v2.payload.bytes", "By");
    private static readonly Histogram<double> s_securityChallengeV2VerifyDuration = s_meter.CreateHistogram<double>("fsus.security.challenge.v2.verify.duration", "ms");
    private static readonly Counter<long> s_securityChallengeV2TaskKindCounter = s_meter.CreateCounter<long>("fsus.security.challenge.v2.task.kind.count");
    private static readonly Histogram<double> s_securityChallengeV2IssueDuration = s_meter.CreateHistogram<double>("fsus.security.challenge.v2.issue.duration", "ms");
    private static readonly Histogram<double> s_securityChallengeV2ClientRenderDuration = s_meter.CreateHistogram<double>("fsus.security.challenge.v2.client.render.duration", "ms");
    private static readonly Counter<long> s_securityDecisionCounter = s_meter.CreateCounter<long>("fsus.security.decision.count");
    private static readonly Histogram<double> s_securityRiskEventBatchSize = s_meter.CreateHistogram<double>("fsus.security.risk_event.batch_size");
    private static readonly Histogram<double> s_securityRiskEventFlushElapsed = s_meter.CreateHistogram<double>("fsus.security.risk_event.flush_elapsed_ms", "ms");
    private static readonly Counter<long> s_securityRiskEventInsertedRows = s_meter.CreateCounter<long>("fsus.security.risk_event.inserted_rows");
    private static readonly Counter<long> s_securityRiskEventFailedBatches = s_meter.CreateCounter<long>("fsus.security.risk_event.failed_batches");
    private static readonly Counter<long> s_securityRiskEventFallbackSingleInserts = s_meter.CreateCounter<long>("fsus.security.risk_event.fallback_single_inserts");
    private static readonly Histogram<double> s_securityRiskEventQueueDepth = s_meter.CreateHistogram<double>("fsus.security.risk_event.queue_depth");
    private static readonly Counter<long> s_securityRiskEventShedCounter = s_meter.CreateCounter<long>("fsus.security.risk_event.shed.count");
    private static readonly Counter<long> s_securityRiskEventSyncFallbackCounter = s_meter.CreateCounter<long>("fsus.security.risk_event.sync_fallback.count");
    private static readonly Histogram<double> s_riskScoreAtomicUpdateElapsed = s_meter.CreateHistogram<double>("fsus.security.risk_score.atomic_update_elapsed_ms", "ms");
    private static readonly Counter<long> s_riskScoreRedisRoundTrips = s_meter.CreateCounter<long>("fsus.security.risk_score.redis_round_trips");
    private static readonly Counter<long> s_riskScoreConflictAvoided = s_meter.CreateCounter<long>("fsus.security.risk_score.conflict_avoided");
    private static readonly Counter<long> s_publicHotReadRiskProjectionAccess = s_meter.CreateCounter<long>("fsus.security.public_hot_read_risk_projection.access");
    private static readonly Counter<long> s_auditChainTailCacheAccess = s_meter.CreateCounter<long>("fsus.audit.chain_tail.cache_access");
    private static readonly Histogram<double> s_auditChainTailQueryElapsed = s_meter.CreateHistogram<double>("fsus.audit.chain_tail.query_elapsed_ms", "ms");
    private static readonly Histogram<double> s_auditBatchSize = s_meter.CreateHistogram<double>("fsus.audit.batch.size");
    private static readonly Histogram<double> s_auditBatchWriteElapsed = s_meter.CreateHistogram<double>("fsus.audit.batch.write_elapsed_ms", "ms");
    private static readonly Counter<long> s_auditListDbCounter = s_meter.CreateCounter<long>("fsus.audit.list.db_count");
    private static readonly Histogram<double> s_auditListElapsed = s_meter.CreateHistogram<double>("fsus.audit.list.elapsed_ms", "ms");
    private static readonly Counter<long> s_auditSummaryQueryCounter = s_meter.CreateCounter<long>("fsus.audit.summary.query_count");
    private static readonly Histogram<double> s_auditFacetElapsed = s_meter.CreateHistogram<double>("fsus.audit.facet.elapsed_ms", "ms");
    private static readonly Counter<long> s_auditSummaryCacheHitCounter = s_meter.CreateCounter<long>("fsus.audit.summary.cache_hit");
    private static readonly Counter<long> s_adminAuditQueuedCounter = s_meter.CreateCounter<long>("fsus.admin.audit.queued_count");
    private static readonly Counter<long> s_adminAuditDroppedCounter = s_meter.CreateCounter<long>("fsus.admin.audit.dropped_count");
    private static readonly Counter<long> s_adminAuditFallbackWriteCounter = s_meter.CreateCounter<long>("fsus.admin.audit.fallback_write_count");
    private static readonly Histogram<double> s_adminAuditQueueDepth = s_meter.CreateHistogram<double>("fsus.admin.audit.queue_depth");
    private static readonly Histogram<double> s_adminAuditBatchSize = s_meter.CreateHistogram<double>("fsus.admin.audit.batch_size");
    private static readonly Histogram<double> s_adminAuditWriteElapsed = s_meter.CreateHistogram<double>("fsus.admin.audit.write_elapsed_ms", "ms");
    private static readonly Histogram<double> s_cacheOperationDuration = s_meter.CreateHistogram<double>("fsus.cache.operation.duration", "ms");
    private static readonly Histogram<long> s_cacheCoordinationRedisCommands = s_meter.CreateHistogram<long>("fsus.cache.coordination.redis_commands");
    private static readonly Histogram<double> s_cacheCoordinationLocalWait = s_meter.CreateHistogram<double>("fsus.cache.coordination.local_wait", "ms");
    private static readonly Histogram<double> s_cacheCoordinationLeaseWait = s_meter.CreateHistogram<double>("fsus.cache.coordination.lease_wait", "ms");
    private static readonly Histogram<long> s_cacheCoordinationRebuilds = s_meter.CreateHistogram<long>("fsus.cache.coordination.rebuild_count");
    private static readonly Counter<long> s_cacheCoordinationRelease = s_meter.CreateCounter<long>("fsus.cache.coordination.release");
    private static readonly Histogram<long> s_cacheCoordinationActiveEntries = s_meter.CreateHistogram<long>("fsus.cache.coordination.active_entries");
    private static readonly Histogram<double> s_singleFlightWait = s_meter.CreateHistogram<double>("fsus.cache.singleflight.wait", "ms");
    private static readonly Histogram<long> s_singleFlightWaiters = s_meter.CreateHistogram<long>("fsus.cache.singleflight.waiters");
    private static readonly Counter<long> s_singleFlightRejectByCap = s_meter.CreateCounter<long>("fsus.cache.singleflight.reject_by_cap");
    private static readonly Counter<long> s_lastGoodWhileRebuild = s_meter.CreateCounter<long>("fsus.cache.coordination.last_good_while_rebuild");
    private static readonly Histogram<double> s_dbOperationDuration = s_meter.CreateHistogram<double>("fsus.db.operation.duration", "ms");
    private static readonly Histogram<double> s_aotRenderDuration = s_meter.CreateHistogram<double>("fsus.aot.render.duration", "ms");
    private static readonly Histogram<double> s_searchOperationDuration = s_meter.CreateHistogram<double>("fsus.search.operation.duration", "ms");
    private static readonly Histogram<double> s_searchRuntimeSnapshotMemoryBytes = s_meter.CreateHistogram<double>("fsus.search.runtime_snapshot.memory", "By");
    private static readonly Histogram<double> s_backgroundJobDuration = s_meter.CreateHistogram<double>("fsus.background.job.duration", "ms");
    private static readonly Counter<long> s_articleOutboxClaimed = s_meter.CreateCounter<long>("fsus.article_outbox.claimed.count");
    private static readonly Counter<long> s_articleOutboxReclaimed = s_meter.CreateCounter<long>("fsus.article_outbox.reclaimed.count");
    private static readonly Counter<long> s_articleOutboxClaimLost = s_meter.CreateCounter<long>("fsus.article_outbox.claim_lost.count");
    private static readonly Counter<long> s_articleOutboxHeartbeat = s_meter.CreateCounter<long>("fsus.article_outbox.heartbeat.count");
    private static readonly Histogram<long> s_articleOutboxStuckClaims = s_meter.CreateHistogram<long>("fsus.article_outbox.stuck_claims");
    private static readonly Counter<long> s_messageOutboxClaimed = s_meter.CreateCounter<long>("fsus.message_outbox.claimed.count");
    private static readonly Counter<long> s_messageOutboxProcessed = s_meter.CreateCounter<long>("fsus.message_outbox.processed.count");
    private static readonly Counter<long> s_messageOutboxFailed = s_meter.CreateCounter<long>("fsus.message_outbox.failed.count");
    private static readonly Histogram<long> s_messageOutboxBacklog = s_meter.CreateHistogram<long>("fsus.message_outbox.backlog");
    private static readonly Histogram<long> s_messageOutboxFailureBacklog = s_meter.CreateHistogram<long>("fsus.message_outbox.failure_backlog");
    private static readonly Histogram<long> s_messageOutboxPoison = s_meter.CreateHistogram<long>("fsus.message_outbox.poison");
    private static readonly Histogram<long> s_messageOutboxStuckClaims = s_meter.CreateHistogram<long>("fsus.message_outbox.stuck_claims");
    private static readonly Counter<long> s_readAggregateFlushCounter = s_meter.CreateCounter<long>("fsus.read_aggregate.flush.count");
    private static readonly Counter<long> s_hotArticlesDirtyCounter = s_meter.CreateCounter<long>("fsus.cache.hot_articles.dirty.count");
    private static readonly Counter<long> s_hotArticlesFlushCounter = s_meter.CreateCounter<long>("fsus.cache.hot_articles.flush.count");
    private static readonly Counter<long> s_hotArticlesCoalescedCounter = s_meter.CreateCounter<long>("fsus.cache.hot_articles.flush.coalesced_batches");
    private static readonly Counter<long> s_articleHotFrameSeedReads = s_meter.CreateCounter<long>("fsus.cache.article_hot_frame.seed_reads");
    private static readonly Counter<long> s_articleHotFrameWholeBuilds = s_meter.CreateCounter<long>("fsus.cache.article_hot_frame.whole_builds");
    private static readonly Counter<long> s_articleHotFrameDatabaseCommands = s_meter.CreateCounter<long>("fsus.cache.article_hot_frame.db_commands");
    private static readonly Histogram<long> s_articleHotFrameBytes = s_meter.CreateHistogram<long>("fsus.cache.article_hot_frame.bytes", "By");
    private static readonly Counter<long> s_articleHotFrameRedisPublications = s_meter.CreateCounter<long>("fsus.cache.article_hot_frame.redis_publications");
    private static readonly Counter<long> s_articleHotFrameGenerationRetries = s_meter.CreateCounter<long>("fsus.cache.article_hot_frame.generation_retries");
    private static readonly Counter<long> s_statsDirtyCounter = s_meter.CreateCounter<long>("fsus.cache.stats.dirty.count");
    private static readonly Counter<long> s_statsFlushCounter = s_meter.CreateCounter<long>("fsus.cache.stats.flush.count");
    private static long s_hotArticlesVersionValue;
    private static string s_activeSecurityPolicyVersionValue = "unknown";
    private static long s_securityEventTagCacheHits;
    private static long s_securityEventTagCacheMisses;
    private static readonly FrozenDictionary<SecurityRiskReason, string> s_securityRiskReasonNames = Enum
        .GetValues<SecurityRiskReason>()
        .ToFrozenDictionary(static reason => reason, static reason => string.Intern(reason.ToString()));
    private static readonly FrozenSet<string> s_securityEventInternedValues = BuildSecurityEventInternedValues();
    private static readonly ConcurrentDictionary<SecurityEventTagCacheKey, TagList> s_securityEventTagCache = PrewarmSecurityEventTagCache();
    private static readonly ObservableGauge<long> s_hotArticlesVersionGauge = s_meter.CreateObservableGauge(
        "fsus.cache.hot_articles.version",
        static () => Volatile.Read(ref s_hotArticlesVersionValue));
    private static readonly ObservableGauge<long> s_securityPolicyVersionActiveGauge = s_meter.CreateObservableGauge(
        "fsus.security.policy.version.active",
        ObserveActiveSecurityPolicyVersion);
    private static readonly ObservableGauge<double> s_securityEventTagCacheHitRatioGauge = s_meter.CreateObservableGauge(
        "fsus.observability.tag_cache.hit_ratio",
        ObserveSecurityEventTagCacheHitRatio);
    private static readonly Counter<long> s_cacheRemoveManyKeyCounter = s_meter.CreateCounter<long>("fsus.cache.remove_many.keys");
    private static readonly Counter<long> s_cacheRemoveManyRedisBatchCounter = s_meter.CreateCounter<long>("fsus.cache.remove_many.redis_batches");
    private static readonly Histogram<double> s_cacheRemoveManyElapsed = s_meter.CreateHistogram<double>("fsus.cache.remove_many.elapsed_ms", "ms");
    private static readonly Counter<long> s_cacheIncrementManyWithExpiryKeyCount = s_meter.CreateCounter<long>("fsus.cache.increment_many_with_expiry.key_count");
    private static readonly Counter<long> s_cacheIncrementManyWithExpiryAppliedCount = s_meter.CreateCounter<long>("fsus.cache.increment_many_with_expiry.expiry_applied_count");
    private static readonly Histogram<double> s_cacheIncrementManyWithExpiryElapsed = s_meter.CreateHistogram<double>("fsus.cache.increment_many_with_expiry.elapsed_ms", "ms");
    private static readonly Counter<long> s_cacheRemovePrefixManyPrefixCounter = s_meter.CreateCounter<long>("fsus.cache.remove_prefix_many.prefixes");
    private static readonly Counter<long> s_cacheRemovePrefixManyRegistryScanCounter = s_meter.CreateCounter<long>("fsus.cache.remove_prefix_many.registry_scans");
    private static readonly Counter<long> s_cacheRemovePrefixManyDeletedKeyCounter = s_meter.CreateCounter<long>("fsus.cache.remove_prefix_many.deleted_keys");
    private static readonly Histogram<double> s_cacheRemovePrefixManyElapsed = s_meter.CreateHistogram<double>("fsus.cache.remove_prefix_many.elapsed_ms", "ms");
    private static readonly Counter<long> s_publicAotInvalidationScopeCounter = s_meter.CreateCounter<long>("public_aot_invalidation_scope");
    private static readonly Counter<long> s_publicAotInvalidatedKeyCounter = s_meter.CreateCounter<long>("public_aot_invalidated_keys");
    private static readonly Counter<long> s_publicAotDeletedFileCounter = s_meter.CreateCounter<long>("public_aot_deleted_files");
    private static readonly Counter<long> s_publicAotRegistryRemovedMemberCounter = s_meter.CreateCounter<long>("public_aot_registry_removed_members");
    private static readonly Counter<long> s_publicAotRegistryCleanupCounter = s_meter.CreateCounter<long>("public_aot_registry_cleanup_count");
    private static readonly Counter<long> s_publicAotRegistryDeletedKeyCounter = s_meter.CreateCounter<long>("public_aot_registry_deleted_keys");
    private static readonly Counter<long> s_publicAotPublishCounter = s_meter.CreateCounter<long>("public_aot_publish_count");
    private static readonly Histogram<double> s_publicAotInvalidationDuration = s_meter.CreateHistogram<double>("public_aot_invalidation_duration_ms", "ms");
    private static readonly Histogram<double> s_publicAotComposeElapsed = s_meter.CreateHistogram<double>("fsus.aot.compose.elapsed", "ms");
    private static long s_publicAotBootstrapSeoSnapshotHits;
    private static long s_publicAotBootstrapSeoSnapshotMisses;
    private static long s_publicAotCacheCodecHits;
    private static long s_publicAotCacheCodecMisses;
    private static long s_publicAotShellCacheFileHits;
    private static long s_publicAotShellCacheFileMisses;
    private static readonly ObservableGauge<double> s_publicAotBootstrapSeoSnapshotHitRatioGauge = s_meter.CreateObservableGauge(
        "fsus.aot.bootstrap.seo_snapshot.hit_ratio",
        static () => Ratio(s_publicAotBootstrapSeoSnapshotHits, s_publicAotBootstrapSeoSnapshotMisses));
    private static readonly ObservableGauge<double> s_publicAotCacheCodecHitRatioGauge = s_meter.CreateObservableGauge(
        "fsus.aot.cache.codec.hit_ratio",
        static () => Ratio(s_publicAotCacheCodecHits, s_publicAotCacheCodecMisses));
    private static readonly ObservableGauge<double> s_publicAotShellCacheFileHitRatioGauge = s_meter.CreateObservableGauge(
        "fsus.aot.shell_cache.file_hit_ratio",
        static () => Ratio(s_publicAotShellCacheFileHits, s_publicAotShellCacheFileMisses));
    private static readonly Counter<long> s_publicHotDeltaChangedArticleCounter = s_meter.CreateCounter<long>("fsus.public_hot.delta.changed_articles");
    private static readonly Counter<long> s_publicHotDeltaRebuiltListCounter = s_meter.CreateCounter<long>("fsus.public_hot.delta.rebuilt_lists");
    private static readonly Counter<long> s_publicHotDeltaRebuiltTaxonomyCounter = s_meter.CreateCounter<long>("fsus.public_hot.delta.rebuilt_taxonomy");
    private static readonly Histogram<double> s_publicHotDeltaElapsed = s_meter.CreateHistogram<double>("fsus.public_hot.delta.elapsed_ms", "ms");
    private static readonly Histogram<long> s_publicHotResidentBytes = s_meter.CreateHistogram<long>("fsus.public_hot.resident.bytes", "By");
    private static readonly Histogram<long> s_publicHotSnapshotOverlapBytes = s_meter.CreateHistogram<long>("fsus.public_hot.snapshot_overlap.bytes", "By");
    private static readonly Histogram<long> s_publicHotLohEligibleBytes = s_meter.CreateHistogram<long>("fsus.public_hot.loh_eligible.bytes", "By");
    private static readonly Histogram<long> s_publicHotArtifactObjects = s_meter.CreateHistogram<long>("fsus.public_hot.artifact_objects", "{object}");
    private static readonly Histogram<double> s_adminIntegrityCheckElapsed = s_meter.CreateHistogram<double>("fsus.admin.integrity.check_elapsed_ms", "ms");
    private static readonly Counter<long> s_adminIntegrityTotalCount = s_meter.CreateCounter<long>("fsus.admin.integrity.total_count");
    private static readonly Counter<long> s_adminIntegritySampleCount = s_meter.CreateCounter<long>("fsus.admin.integrity.sample_count");
    private static readonly Counter<long> s_adminIntegrityScannedFiles = s_meter.CreateCounter<long>("fsus.admin.integrity.scanned_files");
    private static readonly Counter<long> s_moderationDictionaryScannedContent = s_meter.CreateCounter<long>("fsus.moderation.dictionary.scanned_content_count");
    private static readonly Counter<long> s_moderationDictionaryMatchedTerms = s_meter.CreateCounter<long>("fsus.moderation.dictionary.matched_term_count");
    private static readonly Histogram<double> s_moderationDictionaryMatchElapsed = s_meter.CreateHistogram<double>("fsus.moderation.dictionary.match_elapsed_ms", "ms");
    private static readonly Counter<long> s_moderationDictionaryEvaluatedRegions = s_meter.CreateCounter<long>("fsus.moderation.dictionary.evaluated_region_count");
    private static readonly Counter<long> s_taxonomyFrameCacheAccess = s_meter.CreateCounter<long>("fsus.taxonomy.frame.cache_access");
    private static readonly Histogram<double> s_taxonomyFrameColdMissElapsed = s_meter.CreateHistogram<double>("fsus.taxonomy.frame.cold_miss_elapsed_ms", "ms");
    private static readonly Counter<long> s_taxonomyProjectionUpdateCount = s_meter.CreateCounter<long>("fsus.taxonomy.projection.update_count");
    private static readonly Counter<long> s_taxonomyFrameVersionCounter = s_meter.CreateCounter<long>("fsus.taxonomy.frame.version_bump");
    private static readonly Histogram<double> s_notificationStreamOriginValidationElapsed = s_meter.CreateHistogram<double>("fsus.notification_stream.handshake.origin_validation_elapsed_ms", "ms");
    private static readonly Histogram<double> s_notificationStreamOriginCacheElapsed = s_meter.CreateHistogram<double>("fsus.notification.handshake.origin_cache.elapsed", "ms");
    private static long s_notificationStreamOriginCacheHits;
    private static long s_notificationStreamOriginCacheMisses;
    private static readonly ObservableGauge<double> s_notificationStreamOriginCacheHitRatioGauge = s_meter.CreateObservableGauge(
        "fsus.notification.handshake.origin_cache.hit_ratio",
        static () => Ratio(s_notificationStreamOriginCacheHits, s_notificationStreamOriginCacheMisses));
    private static readonly Counter<long> s_notificationStreamAdmissionAccountStateCache = s_meter.CreateCounter<long>("fsus.notification_stream.admission.account_state_cache");
    private static readonly Counter<long> s_notificationStreamAdmissionDbReadCount = s_meter.CreateCounter<long>("fsus.notification_stream.admission.db_read_count");
    private static readonly Counter<long> s_notificationStreamAdmissionRejectedCount = s_meter.CreateCounter<long>("fsus.notification_stream.admission.rejected_reason_count");
    private static readonly Counter<long> s_loginExpiredSessionCount = s_meter.CreateCounter<long>("fsus.auth.login.expired_session_count");
    private static readonly Counter<long> s_loginLimitEvictedSessionCount = s_meter.CreateCounter<long>("fsus.auth.login.limit_evicted_session_count");
    private static readonly Histogram<double> s_loginTransactionElapsed = s_meter.CreateHistogram<double>("fsus.auth.login.transaction_elapsed_ms", "ms");
    private static readonly Counter<long> s_authRefreshSuccessDbCommandCount = s_meter.CreateCounter<long>("fsus.auth.refresh.success_db_command_count");
    private static readonly Histogram<double> s_authRefreshSuccessElapsed = s_meter.CreateHistogram<double>("fsus.auth.refresh.success_elapsed_ms", "ms");
    private static readonly Counter<long> s_authRefreshReplayDetectedCount = s_meter.CreateCounter<long>("fsus.auth.refresh.replay_detected_count");
    private static readonly Counter<long> s_authRefreshFamilyRevokeCount = s_meter.CreateCounter<long>("fsus.auth.refresh.family_revoke_count");
    private static readonly Counter<long> s_authRefreshFamilyRevokeWindowCount = s_meter.CreateCounter<long>("fsus.auth.refresh.family_revoke_window_count");
    private static readonly Counter<long> s_authRefreshCookieWriteFailedCount = s_meter.CreateCounter<long>("fsus.auth.refresh.cookie_write_failed_count");
    private static readonly Counter<long> s_authRefreshRotationConflictCount = s_meter.CreateCounter<long>("fsus.auth.refresh.rotation_conflict_count");
    private static readonly Counter<long> s_authRefreshDeliveryFailureCount = s_meter.CreateCounter<long>("fsus.auth.refresh.delivery_failure_count");
    private static readonly Counter<long> s_authRefreshDatabaseFailureCount = s_meter.CreateCounter<long>("fsus.auth.refresh.database_failure_count");
    private static readonly Counter<long> s_userSessionValidationCacheCount = s_meter.CreateCounter<long>("fsus.auth.session_validation.cache_count");
    private static readonly Counter<long> s_userSessionDbFallbackCount = s_meter.CreateCounter<long>("fsus.auth.session_validation.db_fallback_count");
    private static readonly Counter<long> s_userSessionDbFallbackExtraQps = s_meter.CreateCounter<long>("fsus.auth.session_validation.db_fallback_extra_qps");
    private static readonly Counter<long> s_userSessionDbFallbackRejected = s_meter.CreateCounter<long>("fsus.auth.session_validation.db_fallback_rejected_count");
    private static readonly UpDownCounter<long> s_userSessionDbFallbackConcurrency = s_meter.CreateUpDownCounter<long>("fsus.auth.session_validation.db_fallback_concurrency");
    private static readonly Histogram<double> s_userSessionDbFallbackElapsed = s_meter.CreateHistogram<double>("fsus.auth.session_validation.db_fallback_elapsed_ms", "ms");
    private static readonly Counter<long> s_userSessionCacheRepairCount = s_meter.CreateCounter<long>("fsus.auth.session_validation.cache_repair_count");
    private static readonly Counter<long> s_accountSnapshotCacheHit = s_meter.CreateCounter<long>("fsus.account_snapshot.cache_hit");
    private static readonly Counter<long> s_accountSnapshotDbReadCount = s_meter.CreateCounter<long>("fsus.account_snapshot.db_read_count");
    private static long s_commentActorResolverPublicHandleHits;
    private static long s_commentActorResolverPublicHandleMisses;
    private static long s_commentActorResolverCredentialLevelHits;
    private static long s_commentActorResolverCredentialLevelMisses;
    private static readonly ObservableGauge<double> s_commentActorResolverPublicHandleHitRatioGauge = s_meter.CreateObservableGauge(
        "fsus.comment.actor_resolver.public_handle_cache.hit_ratio",
        static () => Ratio(s_commentActorResolverPublicHandleHits, s_commentActorResolverPublicHandleMisses));
    private static readonly ObservableGauge<double> s_commentActorResolverCredentialLevelHitRatioGauge = s_meter.CreateObservableGauge(
        "fsus.comment.actor_resolver.credential_level_cache.hit_ratio",
        static () => Ratio(s_commentActorResolverCredentialLevelHits, s_commentActorResolverCredentialLevelMisses));
    private static readonly Counter<long> s_commentActorResolverDbRoundTrips = s_meter.CreateCounter<long>("fsus.comment.actor_resolver.db_round_trips");
    private static readonly Histogram<double> s_authMeElapsed = s_meter.CreateHistogram<double>("fsus.auth.me.elapsed_ms", "ms");
    private static readonly Histogram<double> s_messageCenterListElapsed = s_meter.CreateHistogram<double>("fsus.message.center.list.elapsed", "ms");
    private static readonly Histogram<double> s_messageCenterReplyElapsed = s_meter.CreateHistogram<double>("fsus.message.center.reply.elapsed", "ms");
    private static readonly Counter<long> s_messageCenterStatusCount = s_meter.CreateCounter<long>("fsus.message.center.status.count");
    private static readonly Histogram<double> s_messageCenterFanoutRefreshElapsed = s_meter.CreateHistogram<double>("fsus.message.center.fanout.refresh.elapsed", "ms");
    private static readonly Histogram<double> s_messageCenterFanoutBuildItemElapsed = s_meter.CreateHistogram<double>("fsus.message.center.fanout.build_item.elapsed", "ms");
    private static readonly Histogram<double> s_mfaChallengeStartAccountReadElapsed = s_meter.CreateHistogram<double>("fsus.mfa.challenge_start.account_read_elapsed_ms", "ms");
    private static readonly Counter<long> s_mfaFailureCounterKeyCount = s_meter.CreateCounter<long>("fsus.mfa.failure_counter.key_count");
    private static readonly Counter<long> s_mfaCounterExpiredCount = s_meter.CreateCounter<long>("fsus.mfa.counter_expired.count");
    private static readonly Histogram<double> s_adminAccountListQueryElapsed = s_meter.CreateHistogram<double>("fsus.admin.account_list.query_elapsed_ms", "ms");
    private static readonly Counter<long> s_adminAccountListCountUsed = s_meter.CreateCounter<long>("fsus.admin.account_list.count_used");
    private static readonly Counter<long> s_adminAccountListCountSkipped = s_meter.CreateCounter<long>("fsus.admin.account_list.count_skipped");
    private static readonly Counter<long> s_uploadSessionCleanupScannedSessions = s_meter.CreateCounter<long>("fsus.upload.cleanup.scanned_sessions");
    private static readonly Counter<long> s_uploadSessionCleanupDeletedSessions = s_meter.CreateCounter<long>("fsus.upload.cleanup.deleted_sessions");
    private static readonly Histogram<double> s_uploadSessionCleanupElapsed = s_meter.CreateHistogram<double>("fsus.upload.cleanup.elapsed_ms", "ms");
    private static readonly Counter<long> s_uploadSessionCleanupSignalCount = s_meter.CreateCounter<long>("fsus.upload.cleanup.signal_count");
    private static readonly Histogram<double> s_uploadSessionLockCurrentCount = s_meter.CreateHistogram<double>("fsus.upload.session_lock.current_count");
    private static readonly Counter<long> s_uploadSessionLockStaleScannedCount = s_meter.CreateCounter<long>("fsus.upload.session_lock.stale_scanned_count");
    private static readonly Counter<long> s_uploadSessionLockStaleDisposedCount = s_meter.CreateCounter<long>("fsus.upload.session_lock.stale_disposed_count");
    private static readonly Histogram<double> s_uploadSessionLockCleanupElapsed = s_meter.CreateHistogram<double>("fsus.upload.session_lock.cleanup_elapsed_ms", "ms");
    private static readonly Histogram<double> s_uploadSessionLockAcquireElapsed = s_meter.CreateHistogram<double>("fsus.upload.session_lock.acquire_elapsed_ms", "ms");
    private static readonly Counter<long> s_passkeyAssertionDbCommandCount = s_meter.CreateCounter<long>("fsus.passkey.assertion.db_command_count");
    private static readonly Histogram<double> s_passkeyAssertionElapsed = s_meter.CreateHistogram<double>("fsus.passkey.assertion.elapsed_ms", "ms");
    private static readonly Counter<long> s_passkeySignCountUpdateConflictCount = s_meter.CreateCounter<long>("fsus.passkey.sign_count.update_conflict_count");
    private static readonly Counter<long> s_adminPasskeyAssertionDbCommandCount = s_meter.CreateCounter<long>("fsus.admin.passkey.assertion.db_command_count");
    private static readonly Histogram<double> s_adminPasskeyAssertionElapsed = s_meter.CreateHistogram<double>("fsus.admin.passkey.assertion.elapsed_ms", "ms");
    private static readonly Counter<long> s_adminPasskeySignCountConflictCount = s_meter.CreateCounter<long>("fsus.admin.passkey.sign_count.conflict_count");
    private static readonly Counter<long> s_adminSessionListReturnedCount = s_meter.CreateCounter<long>("fsus.admin.session.list.returned_count");
    private static readonly Histogram<double> s_adminSessionListElapsed = s_meter.CreateHistogram<double>("fsus.admin.session.list.elapsed_ms", "ms");
    private static readonly Counter<long> s_adminSessionRevokeOthersCount = s_meter.CreateCounter<long>("fsus.admin.session.revoke_others.count");
    private static readonly Histogram<double> s_adminSessionRevokeOthersElapsed = s_meter.CreateHistogram<double>("fsus.admin.session.revoke_others.elapsed_ms", "ms");
    private static readonly Counter<long> s_adminSessionValidationCount = s_meter.CreateCounter<long>("fsus.admin.session.validation.count");
    private static readonly Histogram<long> s_adminSessionProjectionEntries = s_meter.CreateHistogram<long>("fsus.admin.session.projection.entries");
    private static readonly Histogram<long> s_adminSessionProjectionBytes = s_meter.CreateHistogram<long>("fsus.admin.session.projection.bytes", "By");
    private static readonly Histogram<long> s_adminSessionProjectionVersionLag = s_meter.CreateHistogram<long>("fsus.admin.session.projection.version_lag");
    private static readonly Counter<long> s_adminSessionTouchSkipped = s_meter.CreateCounter<long>("fsus.admin.session.touch_skipped");
    private static readonly Histogram<double> s_adminSessionTouchElapsed = s_meter.CreateHistogram<double>("fsus.admin.session.touch_elapsed_ms", "ms");
    private static readonly Histogram<double> s_distributionDiagnosticsElapsed = s_meter.CreateHistogram<double>("fsus.distribution.diagnostics.elapsed_ms", "ms");
    private static readonly Counter<long> s_distributionDiagnosticsCacheAccess = s_meter.CreateCounter<long>("fsus.distribution.diagnostics.cache_access");
    private static readonly Counter<long> s_distributionDiagnosticsDbCommandCount = s_meter.CreateCounter<long>("fsus.distribution.diagnostics.db_command_count");
    private static readonly Histogram<double> s_relatedReadingBuildElapsed = s_meter.CreateHistogram<double>("fsus.related_reading.build.elapsed_ms", "ms");
    private static readonly Counter<long> s_relatedReadingBuildCacheAccess = s_meter.CreateCounter<long>("fsus.related_reading.build.cache_access");
    private static readonly Histogram<long> s_relatedReadingFrameBytes = s_meter.CreateHistogram<long>("fsus.related_reading.frame.bytes", "By");
    private static readonly Histogram<long> s_relatedReadingBuildAllocationBytes = s_meter.CreateHistogram<long>("fsus.related_reading.build.allocation_bytes", "By");
    private static readonly Counter<long> s_relatedReadingDbCommandCount = s_meter.CreateCounter<long>("fsus.related_reading.db.command_count");
    private static readonly Histogram<double> s_sitemapBuildElapsed = s_meter.CreateHistogram<double>("fsus.sitemap.build.elapsed_ms", "ms");
    private static readonly Counter<long> s_sitemapBuildCacheAccess = s_meter.CreateCounter<long>("fsus.sitemap.build.cache_access");
    private static readonly Histogram<long> s_sitemapArtifactResidentBytes = s_meter.CreateHistogram<long>("fsus.sitemap.artifact.resident_bytes", "By");
    private static readonly Histogram<long> s_sitemapBuildAllocationBytes = s_meter.CreateHistogram<long>("fsus.sitemap.build.allocation_bytes", "By");
    private static readonly Counter<long> s_readinessSnapshotCacheAccess = s_meter.CreateCounter<long>("fsus.readiness.snapshot.cache_access");
    private static readonly Histogram<double> s_readinessSnapshotFreshCheckElapsed = s_meter.CreateHistogram<double>("fsus.readiness.snapshot.fresh_check_elapsed_ms", "ms");
    private static readonly Counter<long> s_readinessSnapshotDependencyCheckCount = s_meter.CreateCounter<long>("fsus.readiness.snapshot.dependency_check_count");
    private static readonly Histogram<double> s_readinessSnapshotAge = s_meter.CreateHistogram<double>("fsus.readiness.snapshot.age_ms", "ms");
    private static readonly Histogram<double> s_readinessCheckElapsed = s_meter.CreateHistogram<double>("fsus.readiness.check.elapsed", "ms");
    private static readonly Histogram<double> s_readinessPostgresElapsed = s_meter.CreateHistogram<double>("fsus.readiness.postgres.elapsed", "ms");
    private static readonly Histogram<double> s_readinessRedisElapsed = s_meter.CreateHistogram<double>("fsus.readiness.redis.elapsed", "ms");
    private static readonly Histogram<double> s_readinessRiskControlElapsed = s_meter.CreateHistogram<double>("fsus.readiness.risk_control.elapsed", "ms");
    private static readonly Histogram<double> s_readinessRuntimeElapsed = s_meter.CreateHistogram<double>("fsus.readiness.runtime.elapsed", "ms");
    private static readonly Counter<long> s_anonymousNullifierPrecheckCount = s_meter.CreateCounter<long>("fsus.anonymous_nullifier.precheck_count");
    private static readonly Histogram<double> s_anonymousNullifierAtomicIncrementElapsed = s_meter.CreateHistogram<double>("fsus.anonymous_nullifier.atomic_increment_elapsed_ms", "ms");
    private static readonly Counter<long> s_anonymousNullifierScopeLimitRejectedCount = s_meter.CreateCounter<long>("fsus.anonymous_nullifier.scope_limit_rejected_count");
    private static readonly Counter<long> s_anonymousNullifierBlockedRejectedCount = s_meter.CreateCounter<long>("fsus.anonymous_nullifier.blocked_rejected_count");

    public static IReadOnlyList<string> CustomAttributeNames => s_allowedCustomAttributeNames;

    internal const int SecurityChallengeV2IssueP99BudgetMs = 100;
    internal const int SecurityChallengeV2VerifyP99BudgetMs = 32;
    internal const int SecurityChallengeV2PayloadP95BudgetBytes = 6200;
    internal const int SecurityChallengeV2ClientRenderP95BudgetMs = 55;
    private const int SecurityChallengeV2SampleLimit = 512;
    private static readonly SlidingWindow<double> s_securityChallengeV2IssueSamples = new(SecurityChallengeV2SampleLimit);
    private static readonly SlidingWindow<double> s_securityChallengeV2VerifySamples = new(SecurityChallengeV2SampleLimit);
    private static readonly SlidingWindow<int> s_securityChallengeV2PayloadSamples = new(SecurityChallengeV2SampleLimit);
    private static readonly SlidingWindow<double> s_securityChallengeV2ClientRenderSamples = new(SecurityChallengeV2SampleLimit);

    public static bool IsAllowedCustomAttribute(string name)
        => s_allowedCustomAttributes.Contains(name);

    public static Activity? StartActivity(string name, string component, ActivityKind kind = ActivityKind.Internal)
    {
        if (!ActivitySource.HasListeners())
        {
            return null;
        }

        Activity? activity = ActivitySource.StartActivity(name, kind);
        SetTag(activity, "fsus.component", component);
        SetTag(activity, "fsus.operation", name);
        return activity;
    }

    public static void SetTag(Activity? activity, string key, object? value)
    {
        if (activity is null || value is null || !IsAllowedCustomAttribute(key))
        {
            return;
        }

        activity.SetTag(key, value);
    }

    public static string ClassifyRoute(PathString path)
    {
        string value = path.Value ?? string.Empty;
        return s_routeKindCache.GetOrAdd(value, ClassifyRouteCore);
    }

    private static string ClassifyRouteCore(string value)
    {
        if (value.StartsWith("/api/binary", StringComparison.OrdinalIgnoreCase))
        {
            return "binary";
        }

        if (value.StartsWith("/api/notifications/stream", StringComparison.OrdinalIgnoreCase))
        {
            return "notification-stream";
        }

        if (value.StartsWith("/api/", StringComparison.OrdinalIgnoreCase))
        {
            return "api";
        }

        if (value.StartsWith("/health/", StringComparison.OrdinalIgnoreCase))
        {
            return "health";
        }

        if (value.StartsWith("/search/", StringComparison.OrdinalIgnoreCase)
            || value.StartsWith("/assets/", StringComparison.OrdinalIgnoreCase)
            || value.StartsWith("/uploads/", StringComparison.OrdinalIgnoreCase)
            || value.EndsWith(".js", StringComparison.OrdinalIgnoreCase)
            || value.EndsWith(".css", StringComparison.OrdinalIgnoreCase)
            || value.EndsWith(".wasm", StringComparison.OrdinalIgnoreCase))
        {
            return "static";
        }

        return "public";
    }

    public static string ResolveRouteKind(HttpContext context)
    {
        string? routeKind = context.GetEndpoint()?.Metadata.GetMetadata<FsusRouteKindMetadata>()?.RouteKind;
        return string.IsNullOrWhiteSpace(routeKind)
            ? ClassifyRoute(context.Request.Path)
            : routeKind;
    }

    public static void RecordOperation(string component, string operation, string result, TimeSpan duration)
    {
        TagList tags = CreateBaseTags(component, operation, result);
        s_operationCounter.Add(1, tags);
        s_operationDuration.Record(duration.TotalMilliseconds, tags);
    }

    public static void RecordArticleDetailArtifactMemoryHit(TimeSpan duration)
    {
        RuntimeCacheEvidenceObservation.Current?.MarkLayerSource("l1-frame");
        RecordOperation("public_read_artifact", "article_detail_aeds", "hit_memory", duration);
    }

    public static void RecordHttpRequest(string routeKind, int statusCode, TimeSpan duration)
    {
        TagList tags = CreateBaseTags("http", "request", statusCode < 500 ? "ok" : "error");
        tags.Add("fsus.route_kind", routeKind);
        tags.Add("fsus.http.status_code", statusCode);
        s_operationCounter.Add(1, tags);
        s_operationDuration.Record(duration.TotalMilliseconds, tags);
    }

    public static void RecordCacheOperation(string operation, string policyId, string layer, string result, TimeSpan duration)
    {
        if (string.Equals(result, "hit", StringComparison.OrdinalIgnoreCase))
        {
            RuntimeCacheEvidenceObservation.Current?.MarkLayerSource(
                layer.ToLowerInvariant() switch
                {
                    "l1" => "l1-object",
                    "l2" => "redis",
                    _ => layer
                });
        }
        var key = new CacheOperationMetricKey(operation, policyId, layer, result);
        CacheOperationMetricState state = s_cacheOperationRuntimeCounters.GetOrAdd(
            key,
            static metricKey => new CacheOperationMetricState(metricKey));
        state.Record();
        RecordCachePolicyHitMiss(policyId, result);
        s_cacheOperationCounter.Add(1, state.Tags);
        s_cacheOperationDuration.Record(duration.TotalMilliseconds, state.Tags);
    }

    public static CacheL1HitObservation BeginCacheL1Hit(CachePolicyId policyId, CacheL1Operation operation)
    {
        _ = ResolveCacheL1State(policyId, operation, negative: false);
        bool sampled = CacheL1SamplingGate.ShouldSample(
            ref s_cacheL1SampleSequence,
            CacheL1DurationSampleRate);
        return sampled
            ? new CacheL1HitObservation(true, Stopwatch.GetTimestamp())
            : default;
    }

    public static void RecordCacheL1Hit(
        CachePolicyId policyId,
        CacheL1Operation operation,
        bool negative,
        CacheL1HitObservation observation)
    {
        RuntimeCacheEvidenceObservation.Current?.MarkLayerSource(
            operation == CacheL1Operation.OwnedFrame ? "l1-frame" : "l1-object");
        CacheL1MetricState state = ResolveCacheL1State(policyId, operation, negative);
        state.IncrementCount();
        CachePolicyHitMissMetricState policyState = ResolveCachePolicyHitMissState(policyId);
        policyState.IncrementHit();
        if (observation.Sampled)
        {
            state.Duration.Record(Stopwatch.GetElapsedTime(observation.StartedAt).TotalMilliseconds, state.Tags);
            state.IncrementSampleCount();
        }
    }

    internal static void RecordCacheCoordination(string policy, long redisCommands, TimeSpan localWait, TimeSpan leaseWait, int rebuilds, string releaseOutcome, int? activeEntries)
    {
        var tags = new TagList { { "fsus.cache.policy", policy } };
        s_cacheCoordinationRedisCommands.Record(redisCommands, tags);
        s_cacheCoordinationLocalWait.Record(localWait.TotalMilliseconds, tags);
        s_cacheCoordinationLeaseWait.Record(leaseWait.TotalMilliseconds, tags);
        s_cacheCoordinationRebuilds.Record(rebuilds, tags);
        if (activeEntries.HasValue)
        {
            s_cacheCoordinationActiveEntries.Record(activeEntries.Value, tags);
        }
        tags.Add("fsus.cache.release.outcome", releaseOutcome);
        s_cacheCoordinationRelease.Add(1, tags);
    }

    internal static void RecordSingleFlightWait(string policy, TimeSpan wait, int waiterCount)
    {
        var tags = new TagList { { "fsus.cache.policy", policy } };
        s_singleFlightWait.Record(wait.TotalMilliseconds, tags);
        s_singleFlightWaiters.Record(waiterCount, tags);
    }

    internal static void RecordSingleFlightWaiterCount(string policy, int waiterCount)
    {
        var tags = new TagList { { "fsus.cache.policy", policy } };
        s_singleFlightWaiters.Record(waiterCount, tags);
    }

    internal static void RecordSingleFlightReject(string policy, string reason)
    {
        var tags = new TagList
        {
            { "fsus.cache.policy", policy },
            { "fsus.result", reason }
        };
        s_singleFlightRejectByCap.Add(1, tags);
    }

    internal static void RecordLastGoodWhileRebuild(string policy)
    {
        var tags = new TagList { { "fsus.cache.policy", policy } };
        s_lastGoodWhileRebuild.Add(1, tags);
    }

    public static IReadOnlyList<CacheOperationRuntimeCounter> GetCacheOperationCounters()
    {
        var counters = new List<CacheOperationRuntimeCounter>(s_cacheOperationRuntimeCounters.Count + s_cacheL1States.Length);
        foreach ((CacheOperationMetricKey key, CacheOperationMetricState state) in s_cacheOperationRuntimeCounters)
        {
            counters.Add(new CacheOperationRuntimeCounter(key.Operation, key.Policy, key.Layer, key.Result, state.Count));
        }

        foreach (CacheL1MetricState? state in s_cacheL1States)
        {
            if (state is not null)
            {
                counters.Add(new CacheOperationRuntimeCounter(state.Operation, state.Policy, "l1", state.Result, state.Count));
            }
        }

        return counters;
    }

    public static CacheL1TelemetryRuntimeSnapshot GetCacheL1TelemetrySnapshot()
    {
        long exactCount = 0;
        long sampleCount = 0;
        int seriesCount = 0;
        foreach (CacheL1MetricState? state in s_cacheL1States)
        {
            if (state is null)
            {
                continue;
            }

            seriesCount++;
            exactCount += state.Count;
            sampleCount += state.SampleCount;
        }

        return new CacheL1TelemetryRuntimeSnapshot(
            seriesCount,
            CacheL1DurationSampleRate,
            exactCount,
            sampleCount,
            sampleCount * CacheL1DurationSampleRate);
    }

    public static CachePolicyHitMissRuntimeCounter GetCachePolicyHitMissCounter(CachePolicyId policyId)
    {
        CachePolicyHitMissMetricState state = ResolveCachePolicyHitMissState(policyId);
        return new CachePolicyHitMissRuntimeCounter(
            state.Hits,
            state.Misses);
    }

    private static CacheL1MetricState?[] CreateCacheL1States()
    {
        int policySlots = Enum.GetValues<CachePolicyId>().Max(static value => (int)value) + 1;
        var states = new CacheL1MetricState?[policySlots * 8];
        string[] operations = ["get", "get_raw", "get_raw_readonly", "get_owned_frame"];
        foreach (CachePolicyId policyId in Enum.GetValues<CachePolicyId>())
        {
            for (int operation = 0; operation < operations.Length; operation++)
            {
                states[CacheL1StateIndex(policyId, (CacheL1Operation)operation, negative: false)] =
                    new CacheL1MetricState(operations[operation], CachePolicyTelemetry.Name(policyId), "hit");
                states[CacheL1StateIndex(policyId, (CacheL1Operation)operation, negative: true)] =
                    new CacheL1MetricState(operations[operation], CachePolicyTelemetry.Name(policyId), "hit_negative");
            }
        }
        return states;
    }

    private static CachePolicyHitMissMetricState?[] CreateCachePolicyHitMissStates()
    {
        int policySlots = Enum.GetValues<CachePolicyId>().Max(static value => (int)value) + 1;
        var states = new CachePolicyHitMissMetricState?[policySlots];
        foreach (CachePolicyId policyId in Enum.GetValues<CachePolicyId>())
        {
            states[(int)policyId] = new CachePolicyHitMissMetricState();
        }

        return states;
    }

    private static void RecordCachePolicyHitMiss(string policy, string result)
    {
        if (!CachePolicyTelemetry.TryParse(policy, out CachePolicyId policyId))
        {
            return;
        }

        CachePolicyHitMissMetricState state = ResolveCachePolicyHitMissState(policyId);
        if (result.Contains("hit", StringComparison.OrdinalIgnoreCase))
        {
            state.IncrementHit();
        }
        else if (result.Contains("miss", StringComparison.OrdinalIgnoreCase))
        {
            state.IncrementMiss();
        }
    }

    private static CachePolicyHitMissMetricState ResolveCachePolicyHitMissState(CachePolicyId policyId)
    {
        int index = (int)policyId;
        if ((uint)index >= (uint)s_cachePolicyHitMissStates.Length
            || s_cachePolicyHitMissStates[index] is not { } state)
        {
            throw new InvalidOperationException($"cache_policy_metric_not_prebound:{policyId}");
        }

        return state;
    }

    private static CacheL1MetricState ResolveCacheL1State(CachePolicyId policyId, CacheL1Operation operation, bool negative)
    {
        int index = CacheL1StateIndex(policyId, operation, negative);
        if ((uint)index >= (uint)s_cacheL1States.Length || s_cacheL1States[index] is not { } state)
        {
            throw new InvalidOperationException($"cache_l1_metric_not_prebound:{policyId}:{operation}");
        }
        return state;
    }

    private static int CacheL1StateIndex(CachePolicyId policyId, CacheL1Operation operation, bool negative)
        => checked(((int)policyId * 8) + ((int)operation * 2) + (negative ? 1 : 0));

    private static IEnumerable<Measurement<long>> ObserveCacheL1Hits()
    {
        foreach (CacheL1MetricState? state in s_cacheL1States)
        {
            if (state is not null)
            {
                yield return new Measurement<long>(state.Count, state.Tags);
            }
        }
    }

    private static IEnumerable<Measurement<long>> ObserveCacheL1DurationSamples()
    {
        foreach (CacheL1MetricState? state in s_cacheL1States)
        {
            if (state is not null)
            {
                yield return new Measurement<long>(state.SampleCount, state.Tags);
            }
        }
    }

    private static IEnumerable<Measurement<long>> ObserveCacheL1DurationWeightedCounts()
    {
        foreach (CacheL1MetricState? state in s_cacheL1States)
        {
            if (state is not null)
            {
                yield return new Measurement<long>(
                    state.SampleCount * CacheL1DurationSampleRate,
                    state.Tags);
            }
        }
    }

    private sealed class CacheL1MetricState
    {
        public CacheL1MetricState(string operation, string policy, string result)
        {
            Operation = operation;
            Policy = policy;
            Result = result;
            var tags = CreateBaseTags("cache", operation, result);
            tags.Add("fsus.cache.operation", operation);
            tags.Add("fsus.cache.policy", policy);
            tags.Add("fsus.cache.layer", "l1");
            tags.Add("fsus.cache.sample_rate", CacheL1DurationSampleRate);
            Tags = tags;
            Duration = s_cacheL1HitDuration;
        }

        public string Operation
        {
            get;
        }

        public string Policy
        {
            get;
        }

        public string Result
        {
            get;
        }

        public TagList Tags
        {
            get;
        }

        public Histogram<double> Duration
        {
            get;
        }

        private readonly FixedShardedCounter _count = new();
        private readonly FixedShardedCounter _sampleCount = new();

        public long Count => _count.Read();

        public long SampleCount => _sampleCount.Read();

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        public void IncrementCount() => _count.Increment();

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        public void IncrementSampleCount() => _sampleCount.Increment();
    }

    private sealed class CachePolicyHitMissMetricState
    {
        private readonly FixedShardedCounter _hits = new();
        private readonly FixedShardedCounter _misses = new();

        public long Hits => _hits.Read();

        public long Misses => _misses.Read();

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        public void IncrementHit() => _hits.Increment();

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        public void IncrementMiss() => _misses.Increment();
    }

    private sealed class FixedShardedCounter
    {
        private const int ShardCount = 64;
        private readonly long[] _shards = new long[ShardCount];

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        public void Increment()
        {
            int shard = Environment.CurrentManagedThreadId & (ShardCount - 1);
            Interlocked.Increment(ref _shards[shard]);
        }

        public long Read()
        {
            long total = 0;
            for (int index = 0; index < _shards.Length; index++)
            {
                total += Volatile.Read(ref _shards[index]);
            }

            return total;
        }
    }

    private sealed class CacheOperationMetricState
    {
        private long _exactCount;

        public CacheOperationMetricState(CacheOperationMetricKey key)
        {
            TagList tags = CreateBaseTags("cache", key.Operation, key.Result);
            tags.Add("fsus.cache.operation", key.Operation);
            tags.Add("fsus.cache.policy", key.Policy);
            tags.Add("fsus.cache.layer", key.Layer);
            Tags = tags;
        }

        public TagList Tags
        {
            get;
        }

        public long Count
        {
            get
            {
                return Volatile.Read(ref _exactCount);
            }
        }

        public void Record()
        {
            Interlocked.Increment(ref _exactCount);
        }
    }

    public static void RecordSecurityEvent(string operation, string reason, string result)
    {
        long startedAt = Stopwatch.GetTimestamp();
        TryRecord(() =>
        {
            SecurityEventTagCacheKey cacheKey = CreateSecurityEventTagCacheKey(operation, reason, result);
            if (s_securityEventTagCache.TryGetValue(cacheKey, out TagList cachedTags))
            {
                Interlocked.Increment(ref s_securityEventTagCacheHits);
                s_securityEventCounter.Add(1, cachedTags);
                return;
            }

            Interlocked.Increment(ref s_securityEventTagCacheMisses);
            s_securityEventTagCacheMissCounter.Add(1);
            TagList tags = CreateSecurityEventTags(cacheKey.Operation, cacheKey.Reason, cacheKey.Result);
            if (s_securityEventTagCache.Count < SecurityEventTagCacheLimit)
            {
                s_securityEventTagCache.TryAdd(cacheKey, tags);
            }

            s_securityEventCounter.Add(1, tags);
        });
        TryRecord(() => s_securityEventRecordElapsed.Record(Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds));
    }

    public static void RecordSecurityEvent(string operation, SecurityRiskReason reason, string result)
        => RecordSecurityEvent(operation, ResolveSecurityRiskReasonName(reason), result);

    public static void RecordRateLimiterRiskSample()
        => RecordSecurityEvent("rate_limiter_risk", "rate_limited", "sampled");

    public static void RecordRateLimiterRiskDrop()
        => RecordSecurityEvent("rate_limiter_risk", "rate_limited", "dropped");

    public static void RecordSecurityRiskEvent(string source, string reason, string action, string result)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("security", "risk_event", NormalizeTelemetryValue(result, "received"));
            tags.Add("fsus.security.source", NormalizeTelemetryValue(source, "unknown"));
            tags.Add("fsus.security.reason", NormalizeTelemetryValue(reason, "unknown"));
            tags.Add("fsus.security.action", NormalizeTelemetryValue(action, "unknown"));
            s_securityRiskEventCounter.Add(1, tags);
        });
    }

    public static void RecordSecurityRiskEventBatch(
        long batchSize,
        TimeSpan flushElapsed,
        long insertedRows,
        long failedBatches,
        long fallbackSingleInserts)
    {
        TryRecord(() =>
        {
            s_securityRiskEventBatchSize.Record(Math.Max(0, batchSize));
            s_securityRiskEventFlushElapsed.Record(flushElapsed.TotalMilliseconds);
            s_securityRiskEventInsertedRows.Add(Math.Max(0, insertedRows));
            s_securityRiskEventFailedBatches.Add(Math.Max(0, failedBatches));
            s_securityRiskEventFallbackSingleInserts.Add(Math.Max(0, fallbackSingleInserts));
        });
    }

    public static void RecordSecurityRiskQueueAdmission(long queueDepth, long shedCount, long syncFallbackCount)
    {
        TryRecord(() =>
        {
            s_securityRiskEventQueueDepth.Record(Math.Max(0, queueDepth));
            if (shedCount > 0)
            {
                s_securityRiskEventShedCounter.Add(shedCount);
            }

            if (syncFallbackCount > 0)
            {
                s_securityRiskEventSyncFallbackCounter.Add(syncFallbackCount);
            }
        });
    }

    public static void RecordRiskScoreAtomicUpdate(
        TimeSpan riskScoreAtomicUpdateElapsed,
        long riskScoreRedisRoundTrips,
        long riskScoreConflictAvoided)
    {
        TryRecord(() =>
        {
            s_riskScoreAtomicUpdateElapsed.Record(riskScoreAtomicUpdateElapsed.TotalMilliseconds);
            s_riskScoreRedisRoundTrips.Add(Math.Max(0, riskScoreRedisRoundTrips));
            s_riskScoreConflictAvoided.Add(Math.Max(0, riskScoreConflictAvoided));
        });
    }

    public static void RecordPublicHotReadRiskProjection(string source)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags(
                "security",
                "public_hot_read_risk_projection",
                NormalizeTelemetryValue(source, "unknown-policy-action"));
            s_publicHotReadRiskProjectionAccess.Add(1, tags);
        });
    }

    public static void RecordAdminAuditQueue(
        long adminAuditQueuedCount,
        long adminAuditDroppedCount,
        long adminAuditFallbackWriteCount,
        long queueDepth)
    {
        TryRecord(() =>
        {
            s_adminAuditQueuedCounter.Add(Math.Max(0, adminAuditQueuedCount));
            s_adminAuditDroppedCounter.Add(Math.Max(0, adminAuditDroppedCount));
            s_adminAuditFallbackWriteCounter.Add(Math.Max(0, adminAuditFallbackWriteCount));
            s_adminAuditQueueDepth.Record(Math.Max(0, queueDepth));
        });
    }

    public static void RecordAdminAuditBatch(long adminAuditBatchSize, TimeSpan adminAuditWriteElapsed)
    {
        TryRecord(() =>
        {
            s_adminAuditBatchSize.Record(Math.Max(0, adminAuditBatchSize));
            s_adminAuditWriteElapsed.Record(adminAuditWriteElapsed.TotalMilliseconds);
        });
    }

    public static void RecordAuditChainTailCache(bool hit)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("audit", "chain_tail_cache", hit ? "hit" : "miss");
            s_auditChainTailCacheAccess.Add(1, tags);
        });
    }

    public static void RecordAuditChainTailQuery(TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("audit", "chain_tail_query", "ok");
            s_auditChainTailQueryElapsed.Record(elapsed.TotalMilliseconds, tags);
        });
    }

    public static void RecordAuditBatchWrite(long batchSize, TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("audit", "batch_write", "ok");
            s_auditBatchSize.Record(Math.Max(0, batchSize), tags);
            s_auditBatchWriteElapsed.Record(elapsed.TotalMilliseconds, tags);
        });
    }

    public static void RecordAuditList(long auditListDbCount, TimeSpan auditListElapsed)
    {
        TryRecord(() =>
        {
            s_auditListDbCounter.Add(Math.Max(0, auditListDbCount));
            s_auditListElapsed.Record(auditListElapsed.TotalMilliseconds);
        });
    }

    public static void RecordAuditSummary(long auditSummaryQueryCount, TimeSpan auditFacetElapsed)
    {
        TryRecord(() =>
        {
            s_auditSummaryQueryCounter.Add(Math.Max(0, auditSummaryQueryCount));
            s_auditFacetElapsed.Record(auditFacetElapsed.TotalMilliseconds);
        });
    }

    public static void RecordAuditFacet(string facet, TimeSpan auditFacetElapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("audit", "facet", NormalizeTelemetryValue(facet, "unknown"));
            s_auditFacetElapsed.Record(auditFacetElapsed.TotalMilliseconds, tags);
        });
    }

    public static void RecordAuditSummaryCacheHit(bool auditSummaryCacheHit)
    {
        TryRecord(() =>
        {
            if (auditSummaryCacheHit)
            {
                s_auditSummaryCacheHitCounter.Add(1);
            }
        });
    }

    public static void RecordSecurityDecision(RiskDecision decision)
    {
        ArgumentNullException.ThrowIfNull(decision);

        RecordSecurityPolicyVersion(decision.PolicyVersion);
        TryRecord(() =>
        {
            string outcome = NormalizeTelemetryValue(decision.Kind.ToString(), "unknown").ToLowerInvariant();
            TagList tags = CreateBaseTags("security", "risk_decision", outcome);
            tags.Add("fsus.security.action", NormalizeTelemetryValue(decision.ActionName, "unknown"));
            tags.Add("fsus.security.outcome", outcome);
            tags.Add("fsus.security.policy_version", NormalizeTelemetryValue(decision.PolicyVersion, "unknown"));
            s_securityDecisionCounter.Add(1, tags);
        });
    }

    public static void RecordSecurityPolicyVersion(string? policyVersion)
    {
        string normalized = NormalizeTelemetryValue(policyVersion, "unknown");
        if (!string.Equals(normalized, "unknown", StringComparison.Ordinal))
        {
            Volatile.Write(ref s_activeSecurityPolicyVersionValue, normalized);
        }
    }

    public static void RecordSecurityChallengeIssued(string kind, string action, string policyVersion)
    {
        TryRecord(() =>
        {
            TagList tags = CreateSecurityChallengeTags("challenge_issue", "issued", kind, action, policyVersion);
            s_securityChallengeIssuedCounter.Add(1, tags);
        });
    }

    public static void RecordPerceptionCharacterV3Allocation(
        string disposition,
        string watermark,
        string actionClass,
        string representation,
        long exactArtifactBytes)
    {
        TryRecord(() =>
        {
            var tags = new TagList
            {
                { "fsus.security.disposition", NormalizeTelemetryValue(disposition, "unavailable") },
                { "fsus.security.watermark", NormalizeTelemetryValue(watermark, "unknown") },
                { "fsus.security.action_class", NormalizeTelemetryValue(actionClass, "other") },
                { "fsus.security.representation", NormalizeTelemetryValue(representation, "unknown") }
            };
            s_perceptionCharacterV3AllocationCounter.Add(1, tags);
            if (exactArtifactBytes > 0)
                s_perceptionCharacterV3EgressBytes.Add(exactArtifactBytes, tags);
        });
    }

    public static void RecordPerceptionCharacterV3Inventory(
        long visualReady,
        long audioReady,
        long visualLeased,
        long audioLeased,
        string poolState,
        string watermark)
    {
        TryRecord(() =>
        {
            foreach ((string representation, long ready, long leased) in new[]
            {
                ("visual", visualReady, visualLeased),
                ("audio", audioReady, audioLeased)
            })
            {
                foreach ((string inventoryState, long value) in new[]
                {
                    ("ready", ready),
                    ("leased_burned", leased)
                })
                {
                    var tags = new TagList
                    {
                        { "fsus.security.representation", representation },
                        { "fsus.security.pool_state", NormalizeTelemetryValue(poolState, "unavailable") },
                        { "fsus.security.watermark", NormalizeTelemetryValue(watermark, "unknown") },
                        { "fsus.security.inventory_state", inventoryState }
                    };
                    s_perceptionCharacterV3PoolEntries.Record(Math.Max(0, value), tags);
                }
            }
        });
    }

    public static void RecordChallengeVerifyRateLimitedBeforeJson()
    {
        TryRecord(() => s_challengeVerifyRateLimitedBeforeJson.Add(1));
    }

    public static void RecordProviderPayloadParse(TimeSpan providerPayloadParseElapsed)
    {
        TryRecord(() => s_providerPayloadParseElapsed.Record(providerPayloadParseElapsed.TotalMilliseconds));
    }

    public static void RecordProviderPayloadRejectedBytes(long providerPayloadRejectedBytes)
    {
        TryRecord(() => s_providerPayloadRejectedBytes.Add(Math.Max(0, providerPayloadRejectedBytes)));
    }

    public static void RecordChallengeVerifyAllocationBytes(long challengeVerifyAllocationBytes)
    {
        TryRecord(() => s_challengeVerifyAllocationBytes.Record(Math.Max(0, challengeVerifyAllocationBytes)));
    }

    public static void RecordSecurityChallengeVerified(string kind, string action, string policyVersion, TimeSpan? solveDuration = null)
    {
        TryRecord(() =>
        {
            TagList tags = CreateSecurityChallengeTags("challenge_verify", "verified", kind, action, policyVersion);
            s_securityChallengeVerifiedCounter.Add(1, tags);
            if (solveDuration is { } duration && duration >= TimeSpan.Zero)
            {
                s_securityChallengeSolveDuration.Record(duration.TotalMilliseconds, tags);
            }
        });
    }

    public static void RecordSecurityChallengeFailed(string kind, string action, string reason, string policyVersion)
    {
        TryRecord(() =>
        {
            TagList tags = CreateSecurityChallengeTags("challenge_verify", "failed", kind, action, policyVersion);
            tags.Add("fsus.security.reason", NormalizeTelemetryValue(reason, "failed"));
            s_securityChallengeFailedCounter.Add(1, tags);
        });
    }

    public static void RecordSecurityChallengeReplayed(string kind, string action, string reason, string policyVersion)
    {
        TryRecord(() =>
        {
            TagList tags = CreateSecurityChallengeTags("challenge_verify", "replayed", kind, action, policyVersion);
            tags.Add("fsus.security.reason", NormalizeTelemetryValue(reason, "replayed"));
            s_securityChallengeReplayedCounter.Add(1, tags);
        });
    }

    public static void RecordSecurityChallengeV2Issued(
        string kind,
        string action,
        string policyVersion,
        string taskKind,
        int payloadBytes,
        TimeSpan issueDuration)
    {
        TryRecord(() =>
        {
            TagList tags = CreateSecurityChallengeV2Tags("challenge_v2_issue", "issued", kind, action, policyVersion, taskKind);
            s_securityChallengeV2IssuedCounter.Add(1, tags);
            s_securityChallengeV2TaskKindCounter.Add(1, tags);
            RecordNonNegativeHistogram(s_securityChallengeV2PayloadBytes, payloadBytes, tags);
            RecordNonNegativeHistogram(s_securityChallengeV2IssueDuration, issueDuration.TotalMilliseconds, tags);
            AddBoundedSample(s_securityChallengeV2PayloadSamples, payloadBytes);
            AddBoundedSample(s_securityChallengeV2IssueSamples, issueDuration.TotalMilliseconds);
        });
    }

    public static void RecordSecurityChallengeV2Verified(
        string kind,
        string action,
        string policyVersion,
        string taskKind,
        int payloadBytes,
        TimeSpan verifyDuration,
        TimeSpan? solveDuration)
    {
        TryRecord(() =>
        {
            TagList tags = CreateSecurityChallengeV2Tags("challenge_v2_verify", "verified", kind, action, policyVersion, taskKind);
            s_securityChallengeV2VerifiedCounter.Add(1, tags);
            RecordSecurityChallengeV2VerifyMeasurements(tags, payloadBytes, verifyDuration, solveDuration);
        });
    }

    public static void RecordSecurityChallengeV2Failed(
        string kind,
        string action,
        string reason,
        string policyVersion,
        string taskKind,
        int payloadBytes,
        TimeSpan verifyDuration,
        TimeSpan? solveDuration)
    {
        TryRecord(() =>
        {
            TagList tags = CreateSecurityChallengeV2Tags("challenge_v2_verify", "failed", kind, action, policyVersion, taskKind);
            tags.Add("fsus.security.reason", NormalizeTelemetryValue(reason, "failed"));
            s_securityChallengeV2FailedCounter.Add(1, tags);
            RecordSecurityChallengeV2VerifyMeasurements(tags, payloadBytes, verifyDuration, solveDuration);
        });
    }

    public static void RecordSecurityChallengeV2Replayed(
        string kind,
        string action,
        string reason,
        string policyVersion,
        string taskKind,
        int payloadBytes,
        TimeSpan verifyDuration,
        TimeSpan? solveDuration)
    {
        TryRecord(() =>
        {
            TagList tags = CreateSecurityChallengeV2Tags("challenge_v2_verify", "replayed", kind, action, policyVersion, taskKind);
            tags.Add("fsus.security.reason", NormalizeTelemetryValue(reason, "replayed"));
            s_securityChallengeV2ReplayedCounter.Add(1, tags);
            RecordSecurityChallengeV2VerifyMeasurements(tags, payloadBytes, verifyDuration, solveDuration);
        });
    }

    public static void RecordSecurityChallengeV2ClientRender(string taskKind, TimeSpan renderDuration)
    {
        TryRecord(() =>
        {
            TagList tags = CreateSecurityChallengeV2Tags(
                "challenge_v2_client_render",
                "ok",
                "perception",
                "client-render",
                "unknown",
                taskKind);
            RecordNonNegativeHistogram(s_securityChallengeV2ClientRenderDuration, renderDuration.TotalMilliseconds, tags);
            AddBoundedSample(s_securityChallengeV2ClientRenderSamples, renderDuration.TotalMilliseconds);
        });
    }

    public static SecurityChallengeV2PerformanceBudgetSnapshot CreateSecurityChallengeV2PerformanceBudgetSnapshot()
    {
        double issueP99 = Percentile(s_securityChallengeV2IssueSamples.Snapshot(), 0.99);
        double verifyP99 = Percentile(s_securityChallengeV2VerifySamples.Snapshot(), 0.99);
        int payloadP95 = Percentile(s_securityChallengeV2PayloadSamples.Snapshot(), 0.95);
        double clientRenderP95 = Percentile(s_securityChallengeV2ClientRenderSamples.Snapshot(), 0.95);
        List<string> warnings = [];

        if (issueP99 > SecurityChallengeV2IssueP99BudgetMs)
        {
            warnings.Add("issue_p99_budget_exceeded");
        }

        if (verifyP99 > SecurityChallengeV2VerifyP99BudgetMs)
        {
            warnings.Add("verify_p99_budget_exceeded");
        }

        if (payloadP95 > SecurityChallengeV2PayloadP95BudgetBytes)
        {
            warnings.Add("payload_p95_budget_exceeded");
        }

        if (clientRenderP95 > SecurityChallengeV2ClientRenderP95BudgetMs)
        {
            warnings.Add("client_render_p95_budget_exceeded");
        }

        return new SecurityChallengeV2PerformanceBudgetSnapshot(
            warnings.Count == 0 ? "ok" : "warning",
            Math.Round(issueP99, 2, MidpointRounding.AwayFromZero),
            Math.Round(verifyP99, 2, MidpointRounding.AwayFromZero),
            payloadP95,
            Math.Round(clientRenderP95, 2, MidpointRounding.AwayFromZero),
            SecurityChallengeV2IssueP99BudgetMs,
            SecurityChallengeV2VerifyP99BudgetMs,
            SecurityChallengeV2PayloadP95BudgetBytes,
            SecurityChallengeV2ClientRenderP95BudgetMs,
            warnings);
    }

    internal static void ResetSecurityChallengeV2RuntimeMetricsForTests()
    {
        s_securityChallengeV2IssueSamples.Clear();
        s_securityChallengeV2VerifySamples.Clear();
        s_securityChallengeV2PayloadSamples.Clear();
        s_securityChallengeV2ClientRenderSamples.Clear();
    }

    public static void RecordDbOperation(string operation, string result, TimeSpan duration)
    {
        TagList tags = CreateBaseTags("db", operation, result);
        tags.Add("fsus.db.system", "postgresql");
        tags.Add("fsus.db.operation", operation);
        s_dbOperationDuration.Record(duration.TotalMilliseconds, tags);
    }

    public static void RecordAotRender(string source, string backfill, string result, TimeSpan duration)
    {
        TagList tags = CreateBaseTags("public_aot", "render", result);
        tags.Add("fsus.aot.source", source);
        tags.Add("fsus.aot.backfill", backfill);
        s_aotRenderDuration.Record(duration.TotalMilliseconds, tags);
    }

    public static void RecordSearchOperation(string mode, string result, TimeSpan duration)
    {
        TagList tags = CreateBaseTags("search", mode, result);
        tags.Add("fsus.search.mode", mode);
        s_searchOperationDuration.Record(duration.TotalMilliseconds, tags);
    }

    public static void RecordSearchRuntimeSnapshotMemory(long estimatedBytes, string source)
    {
        TagList tags = CreateBaseTags("search", "runtime_snapshot_memory", "ok");
        tags.Add("fsus.search.source", source);
        RecordNonNegativeHistogram(s_searchRuntimeSnapshotMemoryBytes, estimatedBytes, tags);
    }

    public static void RecordBackgroundJob(string job, string result, TimeSpan duration, int? published = null, int? failed = null, int? backlog = null)
    {
        TagList tags = CreateBaseTags("background", job, result);
        tags.Add("fsus.background.job", job);
        if (published.HasValue)
        {
            tags.Add("fsus.background.published", published.Value);
        }

        if (failed.HasValue)
        {
            tags.Add("fsus.background.failed", failed.Value);
        }

        if (backlog.HasValue)
        {
            tags.Add("fsus.background.backlog", backlog.Value);
        }

        s_backgroundJobDuration.Record(duration.TotalMilliseconds, tags);
    }

    public static void RecordArticleOutboxClaim(long claimed, long reclaimed)
        => TryRecord(() =>
        {
            if (claimed > 0)
            {
                s_articleOutboxClaimed.Add(claimed);
            }

            if (reclaimed > 0)
            {
                s_articleOutboxReclaimed.Add(reclaimed);
            }
        });

    public static void RecordArticleOutboxClaimLost()
        => TryRecord(() => s_articleOutboxClaimLost.Add(1));

    public static void RecordArticleOutboxHeartbeat(string result, long renewed)
        => TryRecord(() =>
        {
            TagList tags = CreateBaseTags("article_outbox", "heartbeat", result);
            s_articleOutboxHeartbeat.Add(Math.Max(1, renewed), tags);
        });

    public static void RecordArticleOutboxStuckClaims(long count)
        => TryRecord(() => s_articleOutboxStuckClaims.Record(Math.Max(0, count)));

    public static void RecordReadAggregateFlush(long count)
    {
        if (count > 0)
        {
            s_readAggregateFlushCounter.Add(count);
        }
    }

    public static void RecordMessageOutboxBatch(long claimed, long processed, long failed)
    {
        s_messageOutboxClaimed.Add(claimed);
        s_messageOutboxProcessed.Add(processed);
        s_messageOutboxFailed.Add(failed);
    }

    public static void RecordMessageOutboxState(long backlog, long failed, long poison, long stuck)
    {
        s_messageOutboxBacklog.Record(backlog);
        s_messageOutboxFailureBacklog.Record(failed);
        s_messageOutboxPoison.Record(poison);
        s_messageOutboxStuckClaims.Record(stuck);
    }

    public static void RecordHotStatsInvalidation(string kind, string operation, string reason, long count)
    {
        long value = Math.Max(1, count);
        if (string.Equals(kind, "hot_articles", StringComparison.Ordinal))
        {
            if (string.Equals(operation, "dirty", StringComparison.Ordinal))
            {
                s_hotArticlesDirtyCounter.Add(value);
                return;
            }

            s_hotArticlesFlushCounter.Add(1);
            s_hotArticlesCoalescedCounter.Add(value);
            return;
        }

        if (string.Equals(operation, "dirty", StringComparison.Ordinal))
        {
            s_statsDirtyCounter.Add(value);
            return;
        }

        s_statsFlushCounter.Add(1);
    }

    public static void RecordHotArticlesVersion(long version)
    {
        if (version > 0)
        {
            Volatile.Write(ref s_hotArticlesVersionValue, version);
        }
    }

    public static void RecordArticleHotFrameSeed(string frameType, string layer)
    {
        TagList tags = default;
        tags.Add("fsus.aeds.frame_type", frameType);
        tags.Add("fsus.cache.seed.layer", layer);
        s_articleHotFrameSeedReads.Add(1, tags);
    }

    public static void RecordArticleHotFrameWholeBuild(string frameType)
    {
        TagList tags = default;
        tags.Add("fsus.aeds.frame_type", frameType);
        s_articleHotFrameWholeBuilds.Add(1, tags);
    }

    public static void RecordArticleHotFrameCacheHit(string frameType, string identity)
    {
        RuntimeCacheEvidenceObservation.Current?.MarkLayerSource("l1-frame");
        RuntimeCacheEvidenceObservation.Current?.RecordCacheEvent(
            ArticleHotFrameEvidenceFamily(frameType),
            identity,
            "hit");
    }

    public static void RecordArticleHotFrameDatabaseCommand(string frameType)
    {
        TagList tags = default;
        tags.Add("fsus.aeds.frame_type", frameType);
        s_articleHotFrameDatabaseCommands.Add(1, tags);
    }

    public static void RecordArticleHotFrameBytes(string frameType, long bytes)
    {
        TagList tags = default;
        tags.Add("fsus.aeds.frame_type", frameType);
        s_articleHotFrameBytes.Record(Math.Max(0, bytes), tags);
    }

    public static void RecordArticleHotFrameRedisPublication(string frameType)
    {
        TagList tags = default;
        tags.Add("fsus.aeds.frame_type", frameType);
        s_articleHotFrameRedisPublications.Add(1, tags);
    }

    public static void RecordArticleHotFramePublished(
        string frameType,
        string identity)
    {
        RuntimeCacheEvidenceObservation.Current?.MarkLayerSource("database");
        RuntimeCacheEvidenceObservation.Current?.RecordCacheEvent(
            ArticleHotFrameEvidenceFamily(frameType),
            identity,
            "published");
    }

    public static void RecordArticleHotFrameGenerationRetry(string frameType)
    {
        TagList tags = default;
        tags.Add("fsus.aeds.frame_type", frameType);
        s_articleHotFrameGenerationRetries.Add(1, tags);
    }

    private static string ArticleHotFrameEvidenceFamily(string frameType)
        => string.Equals(frameType, "featured", StringComparison.Ordinal)
            ? "article-featured-frame"
            : "article-hot-frame";

    public static void RecordCacheRemoveMany(long keys, long redisBatches, TimeSpan elapsed)
    {
        s_cacheRemoveManyKeyCounter.Add(Math.Max(0, keys));
        s_cacheRemoveManyRedisBatchCounter.Add(Math.Max(0, redisBatches));
        s_cacheRemoveManyElapsed.Record(elapsed.TotalMilliseconds);
    }

    public static void RecordCacheRemovePrefixMany(long prefixes, long registryScans, long deletedKeys, TimeSpan elapsed)
    {
        s_cacheRemovePrefixManyPrefixCounter.Add(Math.Max(0, prefixes));
        s_cacheRemovePrefixManyRegistryScanCounter.Add(Math.Max(0, registryScans));
        s_cacheRemovePrefixManyDeletedKeyCounter.Add(Math.Max(0, deletedKeys));
        s_cacheRemovePrefixManyElapsed.Record(elapsed.TotalMilliseconds);
    }

    public static void RecordIncrementManyWithExpiry(string policyId, long keyCount, long expiryAppliedCount, TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("cache", "increment_many_with_expiry", "ok");
            tags.Add("fsus.cache.policy", NormalizeTelemetryValue(policyId, "unknown"));
            s_cacheIncrementManyWithExpiryKeyCount.Add(Math.Max(0, keyCount), tags);
            s_cacheIncrementManyWithExpiryAppliedCount.Add(Math.Max(0, expiryAppliedCount), tags);
            s_cacheIncrementManyWithExpiryElapsed.Record(Math.Max(0d, elapsed.TotalMilliseconds), tags);
        });
    }

    public static void RecordPublicAotInvalidation(
        long scopes,
        long invalidatedKeys,
        long deletedFiles,
        long registryRemovedMembers,
        long publishCount,
        TimeSpan elapsed,
        string? registryCleanupStatus = null,
        long registryDeletedKeys = 0)
    {
        s_publicAotInvalidationScopeCounter.Add(Math.Max(0, scopes));
        s_publicAotInvalidatedKeyCounter.Add(Math.Max(0, invalidatedKeys));
        s_publicAotDeletedFileCounter.Add(Math.Max(0, deletedFiles));
        s_publicAotRegistryRemovedMemberCounter.Add(Math.Max(0, registryRemovedMembers));
        s_publicAotPublishCounter.Add(Math.Max(0, publishCount));
        s_publicAotInvalidationDuration.Record(elapsed.TotalMilliseconds);
        if (!string.IsNullOrWhiteSpace(registryCleanupStatus))
        {
            TagList tags = CreateBaseTags("public_aot", "registry_cleanup", registryCleanupStatus);
            s_publicAotRegistryCleanupCounter.Add(1, tags);
            s_publicAotRegistryDeletedKeyCounter.Add(Math.Max(0, registryDeletedKeys), tags);
        }
    }

    public static void RecordPublicAotCompose(string operation, TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("public_aot", NormalizeTelemetryValue(operation, "compose"), "ok");
            s_publicAotComposeElapsed.Record(Math.Max(0, elapsed.TotalMilliseconds), tags);
        });
    }

    public static void RecordPublicAotBootstrapSeoSnapshot(bool cacheHit)
    {
        if (cacheHit)
        {
            Interlocked.Increment(ref s_publicAotBootstrapSeoSnapshotHits);
            return;
        }

        Interlocked.Increment(ref s_publicAotBootstrapSeoSnapshotMisses);
    }

    public static void RecordPublicAotCacheCodecAccess(bool cacheHit)
    {
        if (cacheHit)
        {
            Interlocked.Increment(ref s_publicAotCacheCodecHits);
            return;
        }

        Interlocked.Increment(ref s_publicAotCacheCodecMisses);
    }

    public static void RecordPublicAotShellCacheFileAccess(bool cacheHit)
    {
        if (cacheHit)
        {
            Interlocked.Increment(ref s_publicAotShellCacheFileHits);
            return;
        }

        Interlocked.Increment(ref s_publicAotShellCacheFileMisses);
    }

    public static void RecordPublicHotDelta(
        long changedArticles,
        long rebuiltListFrames,
        long rebuiltTaxonomyFrames,
        TimeSpan elapsed)
    {
        s_publicHotDeltaChangedArticleCounter.Add(Math.Max(0, changedArticles));
        s_publicHotDeltaRebuiltListCounter.Add(Math.Max(0, rebuiltListFrames));
        s_publicHotDeltaRebuiltTaxonomyCounter.Add(Math.Max(0, rebuiltTaxonomyFrames));
        s_publicHotDeltaElapsed.Record(elapsed.TotalMilliseconds);
    }

    public static void RecordPublicHotResidency(
        PublicHotReadResidentBreakdown residency,
        long snapshotOverlapBytes)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("public-hot-read", "snapshot_publish", "ok");
            s_publicHotResidentBytes.Record(residency.TotalBytes, tags);
            s_publicHotSnapshotOverlapBytes.Record(Math.Max(0, snapshotOverlapBytes), tags);
            s_publicHotLohEligibleBytes.Record(residency.LohEligibleArrayBytes, tags);
            s_publicHotArtifactObjects.Record(residency.ObjectCount, tags);
        });
    }

    public static void RecordAdminIntegrityCheck(
        string code,
        TimeSpan elapsed,
        long totalCount,
        long sampleCount,
        long scannedFileCount)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("admin-integrity", NormalizeTelemetryValue(code, "unknown"), totalCount == 0 ? "ok" : "issue");
            s_adminIntegrityCheckElapsed.Record(elapsed.TotalMilliseconds, tags);
            s_adminIntegrityTotalCount.Add(Math.Max(0, totalCount), tags);
            s_adminIntegritySampleCount.Add(Math.Max(0, sampleCount), tags);
            s_adminIntegrityScannedFiles.Add(Math.Max(0, scannedFileCount), tags);
        });
    }

    public static void RecordRegionModerationDictionaryMatch(
        long scannedContentCount,
        long matchedTermCount,
        TimeSpan elapsed,
        long evaluatedRegionCount)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("moderation", "region_dictionary_match", "ok");
            s_moderationDictionaryScannedContent.Add(Math.Max(0, scannedContentCount), tags);
            s_moderationDictionaryMatchedTerms.Add(Math.Max(0, matchedTermCount), tags);
            s_moderationDictionaryMatchElapsed.Record(elapsed.TotalMilliseconds, tags);
            s_moderationDictionaryEvaluatedRegions.Add(Math.Max(0, evaluatedRegionCount), tags);
        });
    }

    public static void RecordTaxonomyFrameCache(string frame, bool hit)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("taxonomy-frame", NormalizeTelemetryValue(frame, "unknown"), hit ? "hit" : "miss");
            s_taxonomyFrameCacheAccess.Add(1, tags);
        });
    }

    public static void RecordTaxonomyFrameColdMiss(string frame, TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("taxonomy-frame", NormalizeTelemetryValue(frame, "unknown"), "miss");
            s_taxonomyFrameColdMissElapsed.Record(elapsed.TotalMilliseconds, tags);
        });
    }

    public static void RecordTaxonomyProjectionUpdate(long updatedRows, long frameVersion, TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("taxonomy-projection", frameVersion > 0 ? "changed" : "unchanged", "ok");
            s_taxonomyProjectionUpdateCount.Add(Math.Max(0, updatedRows), tags);
            s_taxonomyFrameColdMissElapsed.Record(elapsed.TotalMilliseconds, tags);
        });
    }

    public static void RecordTaxonomyFrameVersion(long version, string reason)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("taxonomy-frame", NormalizeTelemetryValue(reason, "unknown"), "version");
            s_taxonomyFrameVersionCounter.Add(version > 0 ? 1 : 0, tags);
        });
    }

    public static void RecordNotificationStreamOriginValidation(string stage, bool accepted, TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("notification-stream", NormalizeTelemetryValue(stage, "origin"), accepted ? "accepted" : "rejected");
            s_notificationStreamOriginValidationElapsed.Record(elapsed.TotalMilliseconds, tags);
        });
    }

    public static void RecordNotificationStreamOriginCacheAccess(TimeSpan elapsed)
    {
        Interlocked.Increment(ref s_notificationStreamOriginCacheHits);
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("notification-stream", "origin-cache", "hit");
            s_notificationStreamOriginCacheElapsed.Record(Math.Max(0, elapsed.TotalMilliseconds), tags);
        });
    }

    public static void RecordNotificationStreamOriginCacheRebuild(TimeSpan elapsed)
    {
        Interlocked.Increment(ref s_notificationStreamOriginCacheMisses);
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("notification-stream", "origin-cache", "miss");
            s_notificationStreamOriginCacheElapsed.Record(Math.Max(0, elapsed.TotalMilliseconds), tags);
        });
    }

    public static void RecordNotificationStreamAdmissionAccountState(bool hit, bool loadedFromDb)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("notification-stream", "account_state", hit ? "hit" : "miss");
            s_notificationStreamAdmissionAccountStateCache.Add(1, tags);
            if (loadedFromDb)
            {
                s_notificationStreamAdmissionDbReadCount.Add(1, tags);
            }
        });
    }

    public static void RecordNotificationStreamAdmissionRejected(string reason)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("notification-stream", NormalizeTelemetryValue(reason, "unknown"), "rejected");
            s_notificationStreamAdmissionRejectedCount.Add(1, tags);
        });
    }

    public static void RecordLoginSessionAdmission(long expiredSessionCount, long limitEvictedSessionCount, TimeSpan transactionElapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("auth-login", "session-admission", "ok");
            s_loginExpiredSessionCount.Add(Math.Max(0, expiredSessionCount), tags);
            s_loginLimitEvictedSessionCount.Add(Math.Max(0, limitEvictedSessionCount), tags);
            s_loginTransactionElapsed.Record(transactionElapsed.TotalMilliseconds, tags);
        });
    }

    public static void RecordAuthRefreshSuccess(long dbCommandCount, TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("auth-refresh", "refresh", "success");
            s_authRefreshSuccessDbCommandCount.Add(Math.Max(0, dbCommandCount), tags);
            s_authRefreshSuccessElapsed.Record(elapsed.TotalMilliseconds, tags);
        });
    }

    public static void RecordUserSessionValidationCache(string result)
    {
        TryRecord(() => s_userSessionValidationCacheCount.Add(
            1,
            CreateBaseTags("auth-session-validation", "cache", NormalizeTelemetryValue(result, "unknown"))));
    }

    public static void RecordUserSessionDbFallback(string result, bool causedByCacheError, TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("auth-session-validation", "db-fallback", NormalizeTelemetryValue(result, "unknown"));
            s_userSessionDbFallbackCount.Add(1, tags);
            if (causedByCacheError)
            {
                s_userSessionDbFallbackExtraQps.Add(1, tags);
            }
            s_userSessionDbFallbackElapsed.Record(Math.Max(0, elapsed.TotalMilliseconds), tags);
        });
    }

    public static void RecordUserSessionDbFallbackRejected()
        => TryRecord(() => s_userSessionDbFallbackRejected.Add(
            1,
            CreateBaseTags("auth-session-validation", "db-fallback", "budget_rejected")));

    public static void RecordUserSessionDbFallbackConcurrency(long delta)
        => TryRecord(() => s_userSessionDbFallbackConcurrency.Add(
            delta,
            CreateBaseTags("auth-session-validation", "db-fallback", "active")));

    public static void RecordUserSessionCacheRepair(string result)
        => TryRecord(() => s_userSessionCacheRepairCount.Add(
            1,
            CreateBaseTags("auth-session-validation", "cache-repair", NormalizeTelemetryValue(result, "unknown"))));

    public static void RecordAuthRefreshReplayDetected()
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("auth-refresh", "refresh", "replay_detected");
            s_authRefreshReplayDetectedCount.Add(1, tags);
        });
    }

    public static void RecordAuthRefreshFamilyRevoke(int revokedSessionCount)
    {
        TryRecord(() =>
        {
            bool hit = revokedSessionCount > 0;
            TagList tags = CreateBaseTags("auth-refresh", "family-revoke", hit ? "hit" : "miss");
            s_authRefreshFamilyRevokeCount.Add(Math.Max(0, revokedSessionCount), tags);
            if (hit)
            {
                s_authRefreshFamilyRevokeWindowCount.Add(1, tags);
            }
        });
    }

    public static void RecordAuthRefreshCookieWriteFailed(string reason)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("auth-refresh", reason, "cookie_write_failed");
            s_authRefreshCookieWriteFailedCount.Add(1, tags);
        });
    }

    public static void RecordAuthRefreshRotationConflict()
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("auth-refresh", "cas", "rotation_conflict");
            s_authRefreshRotationConflictCount.Add(1, tags);
        });
    }

    public static void RecordAuthRefreshDeliveryFailure(string reason)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("auth-refresh", NormalizeTelemetryValue(reason, "unknown"), "delivery_failure");
            s_authRefreshDeliveryFailureCount.Add(1, tags);
        });
    }

    public static void RecordAuthRefreshDatabaseFailure(string operation)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("auth-refresh", NormalizeTelemetryValue(operation, "unknown"), "database_failure");
            s_authRefreshDatabaseFailureCount.Add(1, tags);
        });
    }

    public static void RecordAccountSnapshotCacheHit(bool hit)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("account-snapshot", "cache", hit ? "hit" : "miss");
            s_accountSnapshotCacheHit.Add(hit ? 1 : 0, tags);
        });
    }

    public static void RecordAccountSnapshotDbReadCount()
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("account-snapshot", "db_read", "ok");
            s_accountSnapshotDbReadCount.Add(1, tags);
        });
    }

    public static void RecordCommentActorResolverPublicHandleCache(bool hit)
    {
        if (hit)
        {
            Interlocked.Increment(ref s_commentActorResolverPublicHandleHits);
            return;
        }

        Interlocked.Increment(ref s_commentActorResolverPublicHandleMisses);
    }

    public static void RecordCommentActorResolverCredentialLevelCache(bool hit)
    {
        if (hit)
        {
            Interlocked.Increment(ref s_commentActorResolverCredentialLevelHits);
            return;
        }

        Interlocked.Increment(ref s_commentActorResolverCredentialLevelMisses);
    }

    public static void RecordCommentActorResolverDbRoundTrip(string projection)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("comment-actor", NormalizeTelemetryValue(projection, "account"), "db");
            s_commentActorResolverDbRoundTrips.Add(1, tags);
        });
    }

    public static void RecordMessageCenterList(string phase, TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("message-center", NormalizeTelemetryValue(phase, "list"), "ok");
            s_messageCenterListElapsed.Record(Math.Max(0, elapsed.TotalMilliseconds), tags);
        });
    }

    public static void RecordMessageCenterReply(string phase, TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("message-center", NormalizeTelemetryValue(phase, "reply"), "ok");
            s_messageCenterReplyElapsed.Record(Math.Max(0, elapsed.TotalMilliseconds), tags);
        });
    }

    public static void RecordMessageCenterStatus(string previousStatus, string currentStatus, string outcome)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("message-center", "status", NormalizeTelemetryValue(outcome, "unknown"));
            tags.Add("fsus.message.previous_status", NormalizeTelemetryValue(previousStatus, "unknown"));
            tags.Add("fsus.message.current_status", NormalizeTelemetryValue(currentStatus, "unknown"));
            s_messageCenterStatusCount.Add(1, tags);
        });
    }

    public static void RecordMessageCenterFanoutRefresh(TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("message-center", "fanout-refresh", "ok");
            s_messageCenterFanoutRefreshElapsed.Record(Math.Max(0, elapsed.TotalMilliseconds), tags);
        });
    }

    public static void RecordMessageCenterFanoutBuildItem(TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("message-center", "fanout-build-item", "ok");
            s_messageCenterFanoutBuildItemElapsed.Record(Math.Max(0, elapsed.TotalMilliseconds), tags);
        });
    }

    public static void RecordAuthMe(TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("auth", "me", "ok");
            s_authMeElapsed.Record(Math.Max(0d, elapsed.TotalMilliseconds), tags);
        });
    }

    public static void RecordMfaChallengeStartAccountRead(TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("mfa", "challenge_start_account_read", "ok");
            s_mfaChallengeStartAccountReadElapsed.Record(Math.Max(0d, elapsed.TotalMilliseconds), tags);
        });
    }

    public static void RecordAdminAccountListQuery(
        string keywordType,
        int page,
        int pageSize,
        bool cursor,
        bool totalCountUsed,
        TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            string result = totalCountUsed ? "count_used" : "count_skipped";
            TagList tags = CreateBaseTags("admin-account-list", "query", result);
            tags.Add("fsus.admin.account_list.keyword_type", NormalizeTelemetryValue(keywordType, "none"));
            tags.Add("fsus.admin.account_list.page", Math.Max(1, page));
            tags.Add("fsus.admin.account_list.page_size", Math.Max(1, pageSize));
            tags.Add("fsus.admin.account_list.cursor", cursor);

            s_adminAccountListQueryElapsed.Record(elapsed.TotalMilliseconds, tags);
            if (totalCountUsed)
            {
                s_adminAccountListCountUsed.Add(1, tags);
                return;
            }

            s_adminAccountListCountSkipped.Add(1, tags);
        });
    }

    public static void RecordUploadSessionCleanup(long scannedSessions, long deletedSessions, TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("upload-session-cleanup", "scan", "ok");
            s_uploadSessionCleanupScannedSessions.Add(Math.Max(0, scannedSessions), tags);
            s_uploadSessionCleanupDeletedSessions.Add(Math.Max(0, deletedSessions), tags);
            s_uploadSessionCleanupElapsed.Record(elapsed.TotalMilliseconds, tags);
        });
    }

    public static void RecordUploadSessionCleanupSignal(string result)
    {
        TryRecord(() =>
        {
            string normalized = NormalizeTelemetryValue(result, "unknown");
            TagList tags = CreateBaseTags("upload-session-cleanup", "signal", normalized);
            tags.Add("fsus.upload.cleanup.signal", normalized);
            s_uploadSessionCleanupSignalCount.Add(1, tags);
        });
    }

    public static void RecordUploadSessionLockAcquire(long currentLockCount, TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("upload-session-lock", "acquire", "ok");
            s_uploadSessionLockCurrentCount.Record(Math.Max(0, currentLockCount), tags);
            s_uploadSessionLockAcquireElapsed.Record(elapsed.TotalMilliseconds, tags);
        });
    }

    public static void RecordUploadSessionLockCleanup(
        long currentLockCount,
        long scannedLockCount,
        long disposedLockCount,
        TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("upload-session-lock", "cleanup", "ok");
            s_uploadSessionLockCurrentCount.Record(Math.Max(0, currentLockCount), tags);
            s_uploadSessionLockStaleScannedCount.Add(Math.Max(0, scannedLockCount), tags);
            s_uploadSessionLockStaleDisposedCount.Add(Math.Max(0, disposedLockCount), tags);
            s_uploadSessionLockCleanupElapsed.Record(elapsed.TotalMilliseconds, tags);
        });
    }

    public static void RecordPasskeyAssertion(string kind, long dbCommandCount, TimeSpan elapsed, string result)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("passkey", "assertion", NormalizeTelemetryValue(result, "unknown"));
            tags.Add("fsus.passkey.assertion.kind", NormalizeTelemetryValue(kind, "unknown"));
            s_passkeyAssertionDbCommandCount.Add(Math.Max(0, dbCommandCount), tags);
            s_passkeyAssertionElapsed.Record(elapsed.TotalMilliseconds, tags);
        });
    }

    public static void RecordPasskeySignCountConflict(string kind)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("passkey", "sign_count_update", "conflict");
            tags.Add("fsus.passkey.assertion.kind", NormalizeTelemetryValue(kind, "unknown"));
            s_passkeySignCountUpdateConflictCount.Add(1, tags);
        });
    }

    public static void RecordAdminPasskeyAssertion(string kind, long dbCommandCount, TimeSpan elapsed, string result)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("admin-passkey", "assertion", NormalizeTelemetryValue(result, "unknown"));
            tags.Add("fsus.admin.passkey.assertion.kind", NormalizeTelemetryValue(kind, "unknown"));
            s_adminPasskeyAssertionDbCommandCount.Add(Math.Max(0, dbCommandCount), tags);
            s_adminPasskeyAssertionElapsed.Record(elapsed.TotalMilliseconds, tags);
        });
    }

    public static void RecordAdminPasskeySignCountConflict(string kind)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("admin-passkey", "sign_count_update", "conflict");
            tags.Add("fsus.admin.passkey.assertion.kind", NormalizeTelemetryValue(kind, "unknown"));
            s_adminPasskeySignCountConflictCount.Add(1, tags);
        });
    }

    public static void RecordAdminSessionList(long returnedCount, TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("admin-session", "list", "ok");
            s_adminSessionListReturnedCount.Add(Math.Max(0, returnedCount), tags);
            s_adminSessionListElapsed.Record(elapsed.TotalMilliseconds, tags);
        });
    }

    public static void RecordAdminSessionRevokeOthers(long revokedCount, TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("admin-session", "revoke_others", "ok");
            s_adminSessionRevokeOthersCount.Add(Math.Max(0, revokedCount), tags);
            s_adminSessionRevokeOthersElapsed.Record(elapsed.TotalMilliseconds, tags);
        });
    }

    public static void RecordAdminSessionProjectionValidation(
        string source,
        bool valid,
        long entries,
        long residentBytes,
        long versionLag)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("admin-session", "validation", valid ? "valid" : "invalid");
            tags.Add("fsus.validation.source", source);
            s_adminSessionValidationCount.Add(1, tags);
            s_adminSessionProjectionEntries.Record(Math.Max(0, entries), tags);
            s_adminSessionProjectionBytes.Record(Math.Max(0, residentBytes), tags);
            s_adminSessionProjectionVersionLag.Record(Math.Max(0, versionLag), tags);
        });
    }

    public static void RecordMfaFailureCounterKeys(long keyCount)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("mfa", "failure_counter", "ok");
            s_mfaFailureCounterKeyCount.Add(Math.Max(0, keyCount), tags);
        });
    }

    public static void RecordMfaCounterExpired(long count)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("mfa", "failure_counter", "expiry_applied");
            s_mfaCounterExpiredCount.Add(Math.Max(0, count), tags);
        });
    }

    public static void RecordAdminSessionTouchSkipped()
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("admin-session", "touch", "skipped");
            s_adminSessionTouchSkipped.Add(1, tags);
        });
    }

    public static void RecordAdminSessionTouch(bool updated, TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("admin-session", "touch", updated ? "updated" : "conflict");
            s_adminSessionTouchElapsed.Record(elapsed.TotalMilliseconds, tags);
        });
    }

    public static void RecordDistributionDiagnostics(bool cacheHit, long dbCommandCount, TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("distribution", "diagnostics", cacheHit ? "hit" : "miss");
            s_distributionDiagnosticsElapsed.Record(elapsed.TotalMilliseconds, tags);
            s_distributionDiagnosticsCacheAccess.Add(1, tags);
            s_distributionDiagnosticsDbCommandCount.Add(Math.Max(0, dbCommandCount), tags);
        });
    }

    public static void RecordRelatedReadingBuild(
        bool cacheHit,
        bool negative,
        long frameBytes,
        long allocationBytes,
        long dbCommandCount,
        TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            string result = negative
                ? cacheHit ? "hit_negative" : "miss_negative"
                : cacheHit ? "hit" : "miss";
            TagList tags = CreateBaseTags("related-reading", "build", result);
            s_relatedReadingBuildElapsed.Record(elapsed.TotalMilliseconds, tags);
            s_relatedReadingBuildCacheAccess.Add(1, tags);
            s_relatedReadingFrameBytes.Record(Math.Max(0, frameBytes), tags);
            s_relatedReadingBuildAllocationBytes.Record(Math.Max(0, allocationBytes), tags);
            s_relatedReadingDbCommandCount.Add(Math.Max(0, dbCommandCount), tags);
        });
    }

    public static void RecordSitemapBuild(
        bool cacheHit,
        long residentBytes,
        long allocationBytes,
        TimeSpan elapsed)
    {
        RuntimeCacheEvidenceObservation.Current?.MarkLayerSource(
            cacheHit ? "l1-object" : "database");
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("sitemap", "build", cacheHit ? "hit" : "miss");
            s_sitemapBuildElapsed.Record(elapsed.TotalMilliseconds, tags);
            s_sitemapBuildCacheAccess.Add(1, tags);
            s_sitemapArtifactResidentBytes.Record(Math.Max(0, residentBytes), tags);
            s_sitemapBuildAllocationBytes.Record(Math.Max(0, allocationBytes), tags);
        });
    }

    public static void RecordReadinessSnapshot(
        bool cacheHit,
        TimeSpan freshCheckElapsed,
        long dependencyCheckCount,
        TimeSpan snapshotAge)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("readiness", "snapshot", cacheHit ? "hit" : "miss");
            s_readinessSnapshotCacheAccess.Add(1, tags);
            s_readinessSnapshotFreshCheckElapsed.Record(freshCheckElapsed.TotalMilliseconds, tags);
            s_readinessSnapshotDependencyCheckCount.Add(Math.Max(0, dependencyCheckCount), tags);
            s_readinessSnapshotAge.Record(Math.Max(0, snapshotAge.TotalMilliseconds), tags);
        });
    }

    public static void RecordReadinessCheckElapsed(string check, TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            string normalized = NormalizeTelemetryValue(check, "unknown");
            TagList tags = CreateBaseTags("readiness", normalized, "ok");
            double elapsedMs = Math.Max(0, elapsed.TotalMilliseconds);
            s_readinessCheckElapsed.Record(elapsedMs, tags);
            switch (normalized)
            {
                case "postgres":
                    s_readinessPostgresElapsed.Record(elapsedMs, tags);
                    break;
                case "redis":
                    s_readinessRedisElapsed.Record(elapsedMs, tags);
                    break;
                case "risk_control":
                    s_readinessRiskControlElapsed.Record(elapsedMs, tags);
                    break;
                case "runtime":
                    s_readinessRuntimeElapsed.Record(elapsedMs, tags);
                    break;
            }
        });
    }

    public static void RecordAnonymousNullifierPrecheck()
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("anonymous-nullifier", "precheck", "ok");
            s_anonymousNullifierPrecheckCount.Add(1, tags);
        });
    }

    public static void RecordAnonymousNullifierAtomicIncrement(TimeSpan elapsed, string status)
    {
        TryRecord(() =>
        {
            string normalizedStatus = NormalizeTelemetryValue(status, "unknown");
            TagList tags = CreateBaseTags("anonymous-nullifier", "atomic_increment", normalizedStatus);
            tags.Add("fsus.anonymous_nullifier.status", normalizedStatus);
            RecordNonNegativeHistogram(s_anonymousNullifierAtomicIncrementElapsed, elapsed.TotalMilliseconds, tags);
        });
    }

    public static void RecordAnonymousNullifierRejected(string status)
    {
        TryRecord(() =>
        {
            string normalizedStatus = NormalizeTelemetryValue(status, "unknown");
            TagList tags = CreateBaseTags("anonymous-nullifier", "reject", normalizedStatus);
            tags.Add("fsus.anonymous_nullifier.status", normalizedStatus);
            if (string.Equals(normalizedStatus, "blocked", StringComparison.Ordinal))
            {
                s_anonymousNullifierBlockedRejectedCount.Add(1, tags);
                return;
            }

            if (string.Equals(normalizedStatus, "scope_limit_exceeded", StringComparison.Ordinal))
            {
                s_anonymousNullifierScopeLimitRejectedCount.Add(1, tags);
            }
        });
    }

    public static TimeSpan GetElapsed(long startTimestamp)
        => Stopwatch.GetElapsedTime(startTimestamp);

    private static double Ratio(long hitsField, long missesField)
    {
        long hits = Volatile.Read(ref hitsField);
        long misses = Volatile.Read(ref missesField);
        long total = hits + misses;
        return total == 0 ? 1 : Math.Round((double)hits / total, 4, MidpointRounding.AwayFromZero);
    }

    private static ConcurrentDictionary<SecurityEventTagCacheKey, TagList> PrewarmSecurityEventTagCache()
    {
        var cache = new ConcurrentDictionary<SecurityEventTagCacheKey, TagList>();
        string[] shieldReasons =
        [
            "ua_missing",
            "fake_crawler",
            "verified_crawler",
            "crawler_verification_disabled",
            "social_preview_scope_denied",
            "social_preview",
            "unknown_bot",
            "blocked_user_agent",
            "illegal_path",
            "read_only_mode"
        ];

        foreach (string reason in shieldReasons)
        {
            AddSecurityEventTagCacheEntry(cache, "shield_reject", reason, "rejected");
            AddSecurityEventTagCacheEntry(cache, "shield_reject", reason, "aborted");
            AddSecurityEventTagCacheEntry(cache, "shield_observe", reason, "observed");
            AddSecurityEventTagCacheEntry(cache, "security_risk", reason, "write_failed");
        }

        foreach (string reason in s_securityRiskReasonNames.Values)
        {
            AddSecurityEventTagCacheEntry(cache, "security_risk", reason, "risk_added");
            AddSecurityEventTagCacheEntry(cache, "security_risk", reason, "shield_rejected");
            AddSecurityEventTagCacheEntry(cache, "security_risk", reason, "shield_observed");
            AddSecurityEventTagCacheEntry(cache, "security_risk", reason, "persist_failed");
        }

        AddSecurityEventTagCacheEntry(cache, "rate_limiter_risk", "rate_limited", "sampled");
        AddSecurityEventTagCacheEntry(cache, "rate_limiter_risk", "rate_limited", "dropped");
        AddSecurityEventTagCacheEntry(cache, "rate_limited", "rate_limited", "rejected");
        AddSecurityEventTagCacheEntry(cache, "security_risk", "aggregate", "fallback_failed");
        return cache;
    }

    private static FrozenSet<string> BuildSecurityEventInternedValues()
    {
        HashSet<string> values = new(StringComparer.Ordinal)
        {
            "aggregate",
            "aborted",
            "dropped",
            "fallback_failed",
            "blocked_user_agent",
            "crawler_verification_disabled",
            "fake_crawler",
            "illegal_path",
            "persist_failed",
            "received",
            "shed",
            "rate_limited",
            "rate_limiter_risk",
            "rejected",
            "read_only_mode",
            "sampled",
            "security_risk",
            "shield_observe",
            "shield_observed",
            "shield_reject",
            "shield_rejected",
            "social_preview",
            "social_preview_scope_denied",
            "ua_missing",
            "unknown_bot",
            "verified_crawler",
            "write_failed"
        };
        foreach (string reason in s_securityRiskReasonNames.Values)
        {
            values.Add(reason);
        }

        foreach (string value in values.ToArray())
        {
            values.Add(string.Intern(value));
        }

        return values.ToFrozenSet(StringComparer.Ordinal);
    }

    private static void AddSecurityEventTagCacheEntry(
        ConcurrentDictionary<SecurityEventTagCacheKey, TagList> cache,
        string operation,
        string reason,
        string result)
    {
        if (cache.Count >= SecurityEventTagCacheLimit)
        {
            return;
        }

        SecurityEventTagCacheKey key = CreateSecurityEventTagCacheKey(operation, reason, result);
        cache.TryAdd(key, CreateSecurityEventTags(key.Operation, key.Reason, key.Result));
    }

    private static SecurityEventTagCacheKey CreateSecurityEventTagCacheKey(string operation, string reason, string result)
        => new(
            InternSecurityEventValue(NormalizeTelemetryValue(operation, "unknown")),
            InternSecurityEventValue(NormalizeTelemetryValue(reason, "unknown")),
            InternSecurityEventValue(NormalizeTelemetryValue(result, "unknown")));

    private static string InternSecurityEventValue(string value)
        => s_securityEventInternedValues.Contains(value)
            ? string.Intern(value)
            : value;

    private static TagList CreateSecurityEventTags(string operation, string reason, string result)
    {
        TagList tags = CreateBaseTags("security", operation, result);
        tags.Add("fsus.security.reason", reason);
        return tags;
    }

    private static string ResolveSecurityRiskReasonName(SecurityRiskReason reason)
        => s_securityRiskReasonNames.TryGetValue(reason, out string? name)
            ? name
            : string.Intern(reason.ToString());

    private static double ObserveSecurityEventTagCacheHitRatio()
    {
        long hits = Volatile.Read(ref s_securityEventTagCacheHits);
        long misses = Volatile.Read(ref s_securityEventTagCacheMisses);
        long total = hits + misses;
        return total == 0 ? 1 : Math.Round((double)hits / total, 4, MidpointRounding.AwayFromZero);
    }

    private static TagList CreateBaseTags(string component, string operation, string result)
    {
        TagList tags = [];
        tags.Add("fsus.component", component);
        tags.Add("fsus.operation", operation);
        tags.Add("fsus.result", result);
        return tags;
    }

    private static TagList CreateSecurityChallengeTags(
        string operation,
        string result,
        string kind,
        string action,
        string policyVersion)
    {
        RecordSecurityPolicyVersion(policyVersion);
        TagList tags = CreateBaseTags("security", operation, result);
        tags.Add("fsus.security.kind", NormalizeTelemetryValue(kind, "unknown"));
        tags.Add("fsus.security.action", NormalizeTelemetryValue(action, "unknown"));
        tags.Add("fsus.security.outcome", result);
        tags.Add("fsus.security.policy_version", NormalizeTelemetryValue(policyVersion, "unknown"));
        return tags;
    }

    private static TagList CreateSecurityChallengeV2Tags(
        string operation,
        string result,
        string kind,
        string action,
        string policyVersion,
        string taskKind)
    {
        TagList tags = CreateSecurityChallengeTags(operation, result, kind, action, policyVersion);
        tags.Add("fsus.security.task_kind", NormalizeTelemetryValue(taskKind, "unknown"));
        return tags;
    }

    private static void RecordSecurityChallengeV2VerifyMeasurements(
        TagList tags,
        int payloadBytes,
        TimeSpan verifyDuration,
        TimeSpan? solveDuration)
    {
        RecordNonNegativeHistogram(s_securityChallengeV2PayloadBytes, payloadBytes, tags);
        RecordNonNegativeHistogram(s_securityChallengeV2VerifyDuration, verifyDuration.TotalMilliseconds, tags);
        AddBoundedSample(s_securityChallengeV2PayloadSamples, payloadBytes);
        AddBoundedSample(s_securityChallengeV2VerifySamples, verifyDuration.TotalMilliseconds);
        if (solveDuration is { } duration)
        {
            RecordNonNegativeHistogram(s_securityChallengeV2SolveDuration, duration.TotalMilliseconds, tags);
        }
    }

    private static void RecordNonNegativeHistogram(Histogram<double> histogram, double value, TagList tags)
    {
        if (double.IsFinite(value) && value >= 0)
        {
            histogram.Record(value, tags);
        }
    }

    private static void AddBoundedSample(SlidingWindow<double> window, double value)
    {
        if (!double.IsFinite(value) || value < 0)
        {
            return;
        }

        window.Add(value);
    }

    private static void AddBoundedSample(SlidingWindow<int> window, int value)
    {
        if (value < 0)
        {
            return;
        }

        window.Add(value);
    }

    private static double Percentile(double[] values, double percentile)
    {
        if (values.Length == 0)
        {
            return 0;
        }

        Array.Sort(values);
        int index = PercentileIndex(values.Length, percentile);
        return values[index];
    }

    private static int Percentile(int[] values, double percentile)
    {
        if (values.Length == 0)
        {
            return 0;
        }

        Array.Sort(values);
        int index = PercentileIndex(values.Length, percentile);
        return values[index];
    }

    private static int PercentileIndex(int count, double percentile)
        => Math.Clamp((int)Math.Ceiling(count * Math.Clamp(percentile, 0d, 1d)) - 1, 0, count - 1);

    private static Measurement<long> ObserveActiveSecurityPolicyVersion()
    {
        TagList tags = CreateBaseTags("security", "risk_policy", "active");
        tags.Add("fsus.security.policy_version", Volatile.Read(ref s_activeSecurityPolicyVersionValue));
        return new Measurement<long>(1, tags);
    }

    private static string NormalizeTelemetryValue(string? value, string fallback)
    {
        string normalized = (value ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            return fallback;
        }

        return normalized.Length <= 96 ? normalized : normalized[..96];
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static void TryRecord(Action record)
    {
        try
        {
            record();
        }
        catch
        {
            // Telemetry listeners/exporters must not affect RiskControl decisions.
        }
    }

    private sealed class SlidingWindow<T>
    {
        private readonly T[] _buffer;
        private int _writeIndex;
        private int _count;

        public SlidingWindow(int capacity)
        {
            ArgumentOutOfRangeException.ThrowIfNegativeOrZero(capacity);
            _buffer = new T[capacity];
        }

        public void Add(T value)
        {
            int index = Interlocked.Increment(ref _writeIndex) - 1;
            _buffer[index % _buffer.Length] = value;

            while (true)
            {
                int count = Volatile.Read(ref _count);
                if (count >= _buffer.Length)
                {
                    return;
                }

                if (Interlocked.CompareExchange(ref _count, count + 1, count) == count)
                {
                    return;
                }
            }
        }

        public T[] Snapshot()
        {
            int count = Math.Min(Volatile.Read(ref _count), _buffer.Length);
            if (count == 0)
            {
                return [];
            }

            int writeIndex = Volatile.Read(ref _writeIndex);
            int start = Math.Max(0, writeIndex - count);
            var snapshot = new T[count];
            for (int i = 0; i < count; i++)
            {
                snapshot[i] = _buffer[(start + i) % _buffer.Length];
            }

            return snapshot;
        }

        public void Clear()
        {
            Array.Clear(_buffer);
            Volatile.Write(ref _writeIndex, 0);
            Volatile.Write(ref _count, 0);
        }
    }
}
