using System.Collections.Concurrent;
using System.Collections.Frozen;
using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Runtime.CompilerServices;

using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Security;

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

    private static readonly string[] AllowedCustomAttributeNames =
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

    private static readonly FrozenSet<string> AllowedCustomAttributes = AllowedCustomAttributeNames.ToFrozenSet(StringComparer.Ordinal);

    public static readonly ActivitySource ActivitySource = new(ActivitySourceName, ServiceVersion);

    private static readonly Meter Meter = new(MeterName, ServiceVersion);
    private static readonly Counter<long> OperationCounter = Meter.CreateCounter<long>("fsus.operation.count");
    private static readonly ConcurrentDictionary<CacheOperationMetricKey, CacheOperationMetricState> CacheOperationRuntimeCounters = new();
    public const string CacheL1CounterMode = "striped";
    private const int SecurityEventTagCacheLimit = 256;
    private static readonly ConcurrentDictionary<string, string> RouteKindCache = new(StringComparer.Ordinal);
    private static readonly Histogram<double> OperationDuration = Meter.CreateHistogram<double>("fsus.operation.duration", "ms");
    private static readonly Counter<long> CacheOperationCounter = Meter.CreateCounter<long>("fsus.cache.operation.count");
    private static readonly Counter<long> SecurityEventCounter = Meter.CreateCounter<long>("fsus.security.event.count");
    private static readonly Counter<long> SecurityEventTagCacheMissCounter = Meter.CreateCounter<long>("fsus.observability.tag_cache.miss_count");
    private static readonly Histogram<double> SecurityEventRecordElapsed = Meter.CreateHistogram<double>("fsus.observability.record_security_event.elapsed", "ms");
    private static readonly Counter<long> SecurityRiskEventCounter = Meter.CreateCounter<long>("fsus.security.risk.event.count");
    private static readonly Counter<long> SecurityChallengeIssuedCounter = Meter.CreateCounter<long>("fsus.security.challenge.issued.count");
    private static readonly Counter<long> SecurityChallengeVerifiedCounter = Meter.CreateCounter<long>("fsus.security.challenge.verified.count");
    private static readonly Counter<long> SecurityChallengeFailedCounter = Meter.CreateCounter<long>("fsus.security.challenge.failed.count");
    private static readonly Counter<long> SecurityChallengeReplayedCounter = Meter.CreateCounter<long>("fsus.security.challenge.replayed.count");
    private static readonly Histogram<double> SecurityChallengeSolveDuration = Meter.CreateHistogram<double>("fsus.security.challenge.solve.duration", "ms");
    private static readonly Counter<long> SecurityChallengeV2IssuedCounter = Meter.CreateCounter<long>("fsus.security.challenge.v2.issued.count");
    private static readonly Counter<long> SecurityChallengeV2VerifiedCounter = Meter.CreateCounter<long>("fsus.security.challenge.v2.verified.count");
    private static readonly Counter<long> SecurityChallengeV2FailedCounter = Meter.CreateCounter<long>("fsus.security.challenge.v2.failed.count");
    private static readonly Counter<long> SecurityChallengeV2ReplayedCounter = Meter.CreateCounter<long>("fsus.security.challenge.v2.replayed.count");
    private static readonly Histogram<double> SecurityChallengeV2SolveDuration = Meter.CreateHistogram<double>("fsus.security.challenge.v2.solve.duration", "ms");
    private static readonly Counter<long> ChallengeVerifyRateLimitedBeforeJson = Meter.CreateCounter<long>("fsus.security.challenge.verify.rate_limited_before_json");
    private static readonly Histogram<double> ProviderPayloadParseElapsed = Meter.CreateHistogram<double>("fsus.security.challenge.provider_payload.parse_elapsed_ms", "ms");
    private static readonly Counter<long> ProviderPayloadRejectedBytes = Meter.CreateCounter<long>("fsus.security.challenge.provider_payload.rejected_bytes", "By");
    private static readonly Histogram<long> ChallengeVerifyAllocationBytes = Meter.CreateHistogram<long>("fsus.security.challenge.verify.allocation_bytes", "By");
    private static readonly Histogram<double> SecurityChallengeV2PayloadBytes = Meter.CreateHistogram<double>("fsus.security.challenge.v2.payload.bytes", "By");
    private static readonly Histogram<double> SecurityChallengeV2VerifyDuration = Meter.CreateHistogram<double>("fsus.security.challenge.v2.verify.duration", "ms");
    private static readonly Counter<long> SecurityChallengeV2TaskKindCounter = Meter.CreateCounter<long>("fsus.security.challenge.v2.task.kind.count");
    private static readonly Histogram<double> SecurityChallengeV2IssueDuration = Meter.CreateHistogram<double>("fsus.security.challenge.v2.issue.duration", "ms");
    private static readonly Histogram<double> SecurityChallengeV2ClientRenderDuration = Meter.CreateHistogram<double>("fsus.security.challenge.v2.client.render.duration", "ms");
    private static readonly Counter<long> SecurityDecisionCounter = Meter.CreateCounter<long>("fsus.security.decision.count");
    private static readonly Histogram<double> SecurityRiskEventBatchSize = Meter.CreateHistogram<double>("fsus.security.risk_event.batch_size");
    private static readonly Histogram<double> SecurityRiskEventFlushElapsed = Meter.CreateHistogram<double>("fsus.security.risk_event.flush_elapsed_ms", "ms");
    private static readonly Counter<long> SecurityRiskEventInsertedRows = Meter.CreateCounter<long>("fsus.security.risk_event.inserted_rows");
    private static readonly Counter<long> SecurityRiskEventFailedBatches = Meter.CreateCounter<long>("fsus.security.risk_event.failed_batches");
    private static readonly Counter<long> SecurityRiskEventFallbackSingleInserts = Meter.CreateCounter<long>("fsus.security.risk_event.fallback_single_inserts");
    private static readonly Histogram<double> RiskScoreAtomicUpdateElapsed = Meter.CreateHistogram<double>("fsus.security.risk_score.atomic_update_elapsed_ms", "ms");
    private static readonly Counter<long> RiskScoreRedisRoundTrips = Meter.CreateCounter<long>("fsus.security.risk_score.redis_round_trips");
    private static readonly Counter<long> RiskScoreConflictAvoided = Meter.CreateCounter<long>("fsus.security.risk_score.conflict_avoided");
    private static readonly Counter<long> ZeroRiskCacheHit = Meter.CreateCounter<long>("fsus.security.risk_score.zero_cache_hit");
    private static readonly Counter<long> AuditChainTailCacheAccess = Meter.CreateCounter<long>("fsus.audit.chain_tail.cache_access");
    private static readonly Histogram<double> AuditChainTailQueryElapsed = Meter.CreateHistogram<double>("fsus.audit.chain_tail.query_elapsed_ms", "ms");
    private static readonly Histogram<double> AuditBatchSize = Meter.CreateHistogram<double>("fsus.audit.batch.size");
    private static readonly Histogram<double> AuditBatchWriteElapsed = Meter.CreateHistogram<double>("fsus.audit.batch.write_elapsed_ms", "ms");
    private static readonly Counter<long> AuditListDbCounter = Meter.CreateCounter<long>("fsus.audit.list.db_count");
    private static readonly Histogram<double> AuditListElapsed = Meter.CreateHistogram<double>("fsus.audit.list.elapsed_ms", "ms");
    private static readonly Counter<long> AuditSummaryQueryCounter = Meter.CreateCounter<long>("fsus.audit.summary.query_count");
    private static readonly Histogram<double> AuditFacetElapsed = Meter.CreateHistogram<double>("fsus.audit.facet.elapsed_ms", "ms");
    private static readonly Counter<long> AuditSummaryCacheHitCounter = Meter.CreateCounter<long>("fsus.audit.summary.cache_hit");
    private static readonly Counter<long> AdminAuditQueuedCounter = Meter.CreateCounter<long>("fsus.admin.audit.queued_count");
    private static readonly Counter<long> AdminAuditDroppedCounter = Meter.CreateCounter<long>("fsus.admin.audit.dropped_count");
    private static readonly Counter<long> AdminAuditFallbackWriteCounter = Meter.CreateCounter<long>("fsus.admin.audit.fallback_write_count");
    private static readonly Histogram<double> AdminAuditQueueDepth = Meter.CreateHistogram<double>("fsus.admin.audit.queue_depth");
    private static readonly Histogram<double> AdminAuditBatchSize = Meter.CreateHistogram<double>("fsus.admin.audit.batch_size");
    private static readonly Histogram<double> AdminAuditWriteElapsed = Meter.CreateHistogram<double>("fsus.admin.audit.write_elapsed_ms", "ms");
    private static readonly Histogram<double> CacheOperationDuration = Meter.CreateHistogram<double>("fsus.cache.operation.duration", "ms");
    private static readonly Histogram<double> DbOperationDuration = Meter.CreateHistogram<double>("fsus.db.operation.duration", "ms");
    private static readonly Histogram<double> AotRenderDuration = Meter.CreateHistogram<double>("fsus.aot.render.duration", "ms");
    private static readonly Histogram<double> SearchOperationDuration = Meter.CreateHistogram<double>("fsus.search.operation.duration", "ms");
    private static readonly Histogram<double> SearchRuntimeSnapshotMemoryBytes = Meter.CreateHistogram<double>("fsus.search.runtime_snapshot.memory", "By");
    private static readonly Histogram<double> BackgroundJobDuration = Meter.CreateHistogram<double>("fsus.background.job.duration", "ms");
    private static readonly Counter<long> ArticleOutboxClaimed = Meter.CreateCounter<long>("fsus.article_outbox.claimed.count");
    private static readonly Counter<long> ArticleOutboxReclaimed = Meter.CreateCounter<long>("fsus.article_outbox.reclaimed.count");
    private static readonly Counter<long> ArticleOutboxClaimLost = Meter.CreateCounter<long>("fsus.article_outbox.claim_lost.count");
    private static readonly Counter<long> ArticleOutboxHeartbeat = Meter.CreateCounter<long>("fsus.article_outbox.heartbeat.count");
    private static readonly Histogram<long> ArticleOutboxStuckClaims = Meter.CreateHistogram<long>("fsus.article_outbox.stuck_claims");
    private static readonly Counter<long> ReadAggregateFlushCounter = Meter.CreateCounter<long>("fsus.read_aggregate.flush.count");
    private static readonly Counter<long> HotArticlesDirtyCounter = Meter.CreateCounter<long>("fsus.cache.hot_articles.dirty.count");
    private static readonly Counter<long> HotArticlesFlushCounter = Meter.CreateCounter<long>("fsus.cache.hot_articles.flush.count");
    private static readonly Counter<long> HotArticlesCoalescedCounter = Meter.CreateCounter<long>("fsus.cache.hot_articles.flush.coalesced_batches");
    private static readonly Counter<long> StatsDirtyCounter = Meter.CreateCounter<long>("fsus.cache.stats.dirty.count");
    private static readonly Counter<long> StatsFlushCounter = Meter.CreateCounter<long>("fsus.cache.stats.flush.count");
    private static long HotArticlesVersionValue;
    private static string ActiveSecurityPolicyVersionValue = "unknown";
    private static long SecurityEventTagCacheHits;
    private static long SecurityEventTagCacheMisses;
    private static readonly FrozenDictionary<SecurityRiskReason, string> SecurityRiskReasonNames = Enum
        .GetValues<SecurityRiskReason>()
        .ToFrozenDictionary(static reason => reason, static reason => string.Intern(reason.ToString()));
    private static readonly FrozenSet<string> SecurityEventInternedValues = BuildSecurityEventInternedValues();
    private static readonly ConcurrentDictionary<SecurityEventTagCacheKey, TagList> SecurityEventTagCache = PrewarmSecurityEventTagCache();
    private static readonly ObservableGauge<long> HotArticlesVersionGauge = Meter.CreateObservableGauge(
        "fsus.cache.hot_articles.version",
        static () => Volatile.Read(ref HotArticlesVersionValue));
    private static readonly ObservableGauge<long> SecurityPolicyVersionActiveGauge = Meter.CreateObservableGauge(
        "fsus.security.policy.version.active",
        ObserveActiveSecurityPolicyVersion);
    private static readonly ObservableGauge<double> SecurityEventTagCacheHitRatioGauge = Meter.CreateObservableGauge(
        "fsus.observability.tag_cache.hit_ratio",
        ObserveSecurityEventTagCacheHitRatio);
    private static readonly Counter<long> CacheRemoveManyKeyCounter = Meter.CreateCounter<long>("fsus.cache.remove_many.keys");
    private static readonly Counter<long> CacheRemoveManyRedisBatchCounter = Meter.CreateCounter<long>("fsus.cache.remove_many.redis_batches");
    private static readonly Histogram<double> CacheRemoveManyElapsed = Meter.CreateHistogram<double>("fsus.cache.remove_many.elapsed_ms", "ms");
    private static readonly Counter<long> CacheIncrementManyWithExpiryKeyCount = Meter.CreateCounter<long>("fsus.cache.increment_many_with_expiry.key_count");
    private static readonly Counter<long> CacheIncrementManyWithExpiryAppliedCount = Meter.CreateCounter<long>("fsus.cache.increment_many_with_expiry.expiry_applied_count");
    private static readonly Histogram<double> CacheIncrementManyWithExpiryElapsed = Meter.CreateHistogram<double>("fsus.cache.increment_many_with_expiry.elapsed_ms", "ms");
    private static readonly Counter<long> CacheRemovePrefixManyPrefixCounter = Meter.CreateCounter<long>("fsus.cache.remove_prefix_many.prefixes");
    private static readonly Counter<long> CacheRemovePrefixManyRegistryScanCounter = Meter.CreateCounter<long>("fsus.cache.remove_prefix_many.registry_scans");
    private static readonly Counter<long> CacheRemovePrefixManyDeletedKeyCounter = Meter.CreateCounter<long>("fsus.cache.remove_prefix_many.deleted_keys");
    private static readonly Histogram<double> CacheRemovePrefixManyElapsed = Meter.CreateHistogram<double>("fsus.cache.remove_prefix_many.elapsed_ms", "ms");
    private static readonly Counter<long> PublicAotInvalidationScopeCounter = Meter.CreateCounter<long>("public_aot_invalidation_scope");
    private static readonly Counter<long> PublicAotInvalidatedKeyCounter = Meter.CreateCounter<long>("public_aot_invalidated_keys");
    private static readonly Counter<long> PublicAotDeletedFileCounter = Meter.CreateCounter<long>("public_aot_deleted_files");
    private static readonly Counter<long> PublicAotRegistryRemovedMemberCounter = Meter.CreateCounter<long>("public_aot_registry_removed_members");
    private static readonly Counter<long> PublicAotRegistryCleanupCounter = Meter.CreateCounter<long>("public_aot_registry_cleanup_count");
    private static readonly Counter<long> PublicAotRegistryDeletedKeyCounter = Meter.CreateCounter<long>("public_aot_registry_deleted_keys");
    private static readonly Counter<long> PublicAotPublishCounter = Meter.CreateCounter<long>("public_aot_publish_count");
    private static readonly Histogram<double> PublicAotInvalidationDuration = Meter.CreateHistogram<double>("public_aot_invalidation_duration_ms", "ms");
    private static readonly Histogram<double> PublicAotComposeElapsed = Meter.CreateHistogram<double>("fsus.aot.compose.elapsed", "ms");
    private static long PublicAotBootstrapSeoSnapshotHits;
    private static long PublicAotBootstrapSeoSnapshotMisses;
    private static long PublicAotCacheCodecHits;
    private static long PublicAotCacheCodecMisses;
    private static long PublicAotShellCacheFileHits;
    private static long PublicAotShellCacheFileMisses;
    private static readonly ObservableGauge<double> PublicAotBootstrapSeoSnapshotHitRatioGauge = Meter.CreateObservableGauge(
        "fsus.aot.bootstrap.seo_snapshot.hit_ratio",
        static () => Ratio(PublicAotBootstrapSeoSnapshotHits, PublicAotBootstrapSeoSnapshotMisses));
    private static readonly ObservableGauge<double> PublicAotCacheCodecHitRatioGauge = Meter.CreateObservableGauge(
        "fsus.aot.cache.codec.hit_ratio",
        static () => Ratio(PublicAotCacheCodecHits, PublicAotCacheCodecMisses));
    private static readonly ObservableGauge<double> PublicAotShellCacheFileHitRatioGauge = Meter.CreateObservableGauge(
        "fsus.aot.shell_cache.file_hit_ratio",
        static () => Ratio(PublicAotShellCacheFileHits, PublicAotShellCacheFileMisses));
    private static readonly Counter<long> PublicHotDeltaChangedArticleCounter = Meter.CreateCounter<long>("fsus.public_hot.delta.changed_articles");
    private static readonly Counter<long> PublicHotDeltaRebuiltListCounter = Meter.CreateCounter<long>("fsus.public_hot.delta.rebuilt_lists");
    private static readonly Counter<long> PublicHotDeltaRebuiltTaxonomyCounter = Meter.CreateCounter<long>("fsus.public_hot.delta.rebuilt_taxonomy");
    private static readonly Histogram<double> PublicHotDeltaElapsed = Meter.CreateHistogram<double>("fsus.public_hot.delta.elapsed_ms", "ms");
    private static readonly Histogram<long> PublicHotResidentBytes = Meter.CreateHistogram<long>("fsus.public_hot.resident.bytes", "By");
    private static readonly Histogram<long> PublicHotSnapshotOverlapBytes = Meter.CreateHistogram<long>("fsus.public_hot.snapshot_overlap.bytes", "By");
    private static readonly Histogram<long> PublicHotLohEligibleBytes = Meter.CreateHistogram<long>("fsus.public_hot.loh_eligible.bytes", "By");
    private static readonly Histogram<long> PublicHotArtifactObjects = Meter.CreateHistogram<long>("fsus.public_hot.artifact_objects", "{object}");
    private static readonly Histogram<double> AdminIntegrityCheckElapsed = Meter.CreateHistogram<double>("fsus.admin.integrity.check_elapsed_ms", "ms");
    private static readonly Counter<long> AdminIntegrityTotalCount = Meter.CreateCounter<long>("fsus.admin.integrity.total_count");
    private static readonly Counter<long> AdminIntegritySampleCount = Meter.CreateCounter<long>("fsus.admin.integrity.sample_count");
    private static readonly Counter<long> AdminIntegrityScannedFiles = Meter.CreateCounter<long>("fsus.admin.integrity.scanned_files");
    private static readonly Counter<long> ModerationDictionaryScannedContent = Meter.CreateCounter<long>("fsus.moderation.dictionary.scanned_content_count");
    private static readonly Counter<long> ModerationDictionaryMatchedTerms = Meter.CreateCounter<long>("fsus.moderation.dictionary.matched_term_count");
    private static readonly Histogram<double> ModerationDictionaryMatchElapsed = Meter.CreateHistogram<double>("fsus.moderation.dictionary.match_elapsed_ms", "ms");
    private static readonly Counter<long> ModerationDictionaryEvaluatedRegions = Meter.CreateCounter<long>("fsus.moderation.dictionary.evaluated_region_count");
    private static readonly Counter<long> TaxonomyFrameCacheAccess = Meter.CreateCounter<long>("fsus.taxonomy.frame.cache_access");
    private static readonly Histogram<double> TaxonomyFrameColdMissElapsed = Meter.CreateHistogram<double>("fsus.taxonomy.frame.cold_miss_elapsed_ms", "ms");
    private static readonly Counter<long> TaxonomyProjectionUpdateCount = Meter.CreateCounter<long>("fsus.taxonomy.projection.update_count");
    private static readonly Counter<long> TaxonomyFrameVersionCounter = Meter.CreateCounter<long>("fsus.taxonomy.frame.version_bump");
    private static readonly Histogram<double> NotificationStreamOriginValidationElapsed = Meter.CreateHistogram<double>("fsus.notification_stream.handshake.origin_validation_elapsed_ms", "ms");
    private static readonly Histogram<double> NotificationStreamOriginCacheElapsed = Meter.CreateHistogram<double>("fsus.notification.handshake.origin_cache.elapsed", "ms");
    private static long NotificationStreamOriginCacheHits;
    private static long NotificationStreamOriginCacheMisses;
    private static readonly ObservableGauge<double> NotificationStreamOriginCacheHitRatioGauge = Meter.CreateObservableGauge(
        "fsus.notification.handshake.origin_cache.hit_ratio",
        static () => Ratio(NotificationStreamOriginCacheHits, NotificationStreamOriginCacheMisses));
    private static readonly Counter<long> NotificationStreamAdmissionAccountStateCache = Meter.CreateCounter<long>("fsus.notification_stream.admission.account_state_cache");
    private static readonly Counter<long> NotificationStreamAdmissionDbReadCount = Meter.CreateCounter<long>("fsus.notification_stream.admission.db_read_count");
    private static readonly Counter<long> NotificationStreamAdmissionRejectedCount = Meter.CreateCounter<long>("fsus.notification_stream.admission.rejected_reason_count");
    private static readonly Counter<long> LoginReplacedSessionCount = Meter.CreateCounter<long>("fsus.auth.login.replaced_session_count");
    private static readonly Histogram<double> LoginTransactionElapsed = Meter.CreateHistogram<double>("fsus.auth.login.transaction_elapsed_ms", "ms");
    private static readonly Counter<long> LoginSessionRevokeCommandCount = Meter.CreateCounter<long>("fsus.auth.login.session_revoke_command_count");
    private static readonly Counter<long> AuthRefreshSuccessDbCommandCount = Meter.CreateCounter<long>("fsus.auth.refresh.success_db_command_count");
    private static readonly Histogram<double> AuthRefreshSuccessElapsed = Meter.CreateHistogram<double>("fsus.auth.refresh.success_elapsed_ms", "ms");
    private static readonly Counter<long> AuthRefreshReplayDetectedCount = Meter.CreateCounter<long>("fsus.auth.refresh.replay_detected_count");
    private static readonly Counter<long> AuthRefreshFamilyRevokeCount = Meter.CreateCounter<long>("fsus.auth.refresh.family_revoke_count");
    private static readonly Counter<long> AuthRefreshFamilyRevokeWindowCount = Meter.CreateCounter<long>("fsus.auth.refresh.family_revoke_window_count");
    private static readonly Counter<long> AuthRefreshCookieWriteFailedCount = Meter.CreateCounter<long>("fsus.auth.refresh.cookie_write_failed_count");
    private static readonly Counter<long> AccountSnapshotCacheHit = Meter.CreateCounter<long>("fsus.account_snapshot.cache_hit");
    private static readonly Counter<long> AccountSnapshotDbReadCount = Meter.CreateCounter<long>("fsus.account_snapshot.db_read_count");
    private static long CommentActorResolverPublicHandleHits;
    private static long CommentActorResolverPublicHandleMisses;
    private static long CommentActorResolverCredentialLevelHits;
    private static long CommentActorResolverCredentialLevelMisses;
    private static readonly ObservableGauge<double> CommentActorResolverPublicHandleHitRatioGauge = Meter.CreateObservableGauge(
        "fsus.comment.actor_resolver.public_handle_cache.hit_ratio",
        static () => Ratio(CommentActorResolverPublicHandleHits, CommentActorResolverPublicHandleMisses));
    private static readonly ObservableGauge<double> CommentActorResolverCredentialLevelHitRatioGauge = Meter.CreateObservableGauge(
        "fsus.comment.actor_resolver.credential_level_cache.hit_ratio",
        static () => Ratio(CommentActorResolverCredentialLevelHits, CommentActorResolverCredentialLevelMisses));
    private static readonly Counter<long> CommentActorResolverDbRoundTrips = Meter.CreateCounter<long>("fsus.comment.actor_resolver.db_round_trips");
    private static readonly Histogram<double> AuthMeElapsed = Meter.CreateHistogram<double>("fsus.auth.me.elapsed_ms", "ms");
    private static readonly Histogram<double> MessageCenterListElapsed = Meter.CreateHistogram<double>("fsus.message.center.list.elapsed", "ms");
    private static readonly Histogram<double> MessageCenterReplyElapsed = Meter.CreateHistogram<double>("fsus.message.center.reply.elapsed", "ms");
    private static readonly Histogram<double> MessageCenterFanoutRefreshElapsed = Meter.CreateHistogram<double>("fsus.message.center.fanout.refresh.elapsed", "ms");
    private static readonly Histogram<double> MessageCenterFanoutBuildItemElapsed = Meter.CreateHistogram<double>("fsus.message.center.fanout.build_item.elapsed", "ms");
    private static readonly Histogram<double> MfaChallengeStartAccountReadElapsed = Meter.CreateHistogram<double>("fsus.mfa.challenge_start.account_read_elapsed_ms", "ms");
    private static readonly Counter<long> MfaFailureCounterKeyCount = Meter.CreateCounter<long>("fsus.mfa.failure_counter.key_count");
    private static readonly Counter<long> MfaCounterExpiredCount = Meter.CreateCounter<long>("fsus.mfa.counter_expired.count");
    private static readonly Histogram<double> AdminAccountListQueryElapsed = Meter.CreateHistogram<double>("fsus.admin.account_list.query_elapsed_ms", "ms");
    private static readonly Counter<long> AdminAccountListCountUsed = Meter.CreateCounter<long>("fsus.admin.account_list.count_used");
    private static readonly Counter<long> AdminAccountListCountSkipped = Meter.CreateCounter<long>("fsus.admin.account_list.count_skipped");
    private static readonly Counter<long> UploadSessionCleanupScannedSessions = Meter.CreateCounter<long>("fsus.upload.cleanup.scanned_sessions");
    private static readonly Counter<long> UploadSessionCleanupDeletedSessions = Meter.CreateCounter<long>("fsus.upload.cleanup.deleted_sessions");
    private static readonly Histogram<double> UploadSessionCleanupElapsed = Meter.CreateHistogram<double>("fsus.upload.cleanup.elapsed_ms", "ms");
    private static readonly Counter<long> UploadSessionCleanupSignalCount = Meter.CreateCounter<long>("fsus.upload.cleanup.signal_count");
    private static readonly Histogram<double> UploadSessionLockCurrentCount = Meter.CreateHistogram<double>("fsus.upload.session_lock.current_count");
    private static readonly Counter<long> UploadSessionLockStaleScannedCount = Meter.CreateCounter<long>("fsus.upload.session_lock.stale_scanned_count");
    private static readonly Counter<long> UploadSessionLockStaleDisposedCount = Meter.CreateCounter<long>("fsus.upload.session_lock.stale_disposed_count");
    private static readonly Histogram<double> UploadSessionLockCleanupElapsed = Meter.CreateHistogram<double>("fsus.upload.session_lock.cleanup_elapsed_ms", "ms");
    private static readonly Histogram<double> UploadSessionLockAcquireElapsed = Meter.CreateHistogram<double>("fsus.upload.session_lock.acquire_elapsed_ms", "ms");
    private static readonly Counter<long> PasskeyAssertionDbCommandCount = Meter.CreateCounter<long>("fsus.passkey.assertion.db_command_count");
    private static readonly Histogram<double> PasskeyAssertionElapsed = Meter.CreateHistogram<double>("fsus.passkey.assertion.elapsed_ms", "ms");
    private static readonly Counter<long> PasskeySignCountUpdateConflictCount = Meter.CreateCounter<long>("fsus.passkey.sign_count.update_conflict_count");
    private static readonly Counter<long> AdminPasskeyAssertionDbCommandCount = Meter.CreateCounter<long>("fsus.admin.passkey.assertion.db_command_count");
    private static readonly Histogram<double> AdminPasskeyAssertionElapsed = Meter.CreateHistogram<double>("fsus.admin.passkey.assertion.elapsed_ms", "ms");
    private static readonly Counter<long> AdminPasskeySignCountConflictCount = Meter.CreateCounter<long>("fsus.admin.passkey.sign_count.conflict_count");
    private static readonly Counter<long> AdminSessionListReturnedCount = Meter.CreateCounter<long>("fsus.admin.session.list.returned_count");
    private static readonly Histogram<double> AdminSessionListElapsed = Meter.CreateHistogram<double>("fsus.admin.session.list.elapsed_ms", "ms");
    private static readonly Counter<long> AdminSessionRevokeOthersCount = Meter.CreateCounter<long>("fsus.admin.session.revoke_others.count");
    private static readonly Histogram<double> AdminSessionRevokeOthersElapsed = Meter.CreateHistogram<double>("fsus.admin.session.revoke_others.elapsed_ms", "ms");
    private static readonly Counter<long> AdminSessionValidationDbReadCount = Meter.CreateCounter<long>("fsus.admin.session.validation.db_read_count");
    private static readonly Counter<long> AdminSessionValidationCacheHit = Meter.CreateCounter<long>("fsus.admin.session.validation.cache_hit");
    private static readonly Counter<long> AdminSessionTouchSkipped = Meter.CreateCounter<long>("fsus.admin.session.touch_skipped");
    private static readonly Histogram<double> AdminSessionTouchElapsed = Meter.CreateHistogram<double>("fsus.admin.session.touch_elapsed_ms", "ms");
    private static readonly Histogram<double> DistributionDiagnosticsElapsed = Meter.CreateHistogram<double>("fsus.distribution.diagnostics.elapsed_ms", "ms");
    private static readonly Counter<long> DistributionDiagnosticsCacheAccess = Meter.CreateCounter<long>("fsus.distribution.diagnostics.cache_access");
    private static readonly Counter<long> DistributionDiagnosticsDbCommandCount = Meter.CreateCounter<long>("fsus.distribution.diagnostics.db_command_count");
    private static readonly Histogram<double> RelatedReadingBuildElapsed = Meter.CreateHistogram<double>("fsus.related_reading.build.elapsed_ms", "ms");
    private static readonly Counter<long> RelatedReadingBuildCacheAccess = Meter.CreateCounter<long>("fsus.related_reading.build.cache_access");
    private static readonly Histogram<double> SitemapBuildElapsed = Meter.CreateHistogram<double>("fsus.sitemap.build.elapsed_ms", "ms");
    private static readonly Counter<long> SitemapBuildCacheAccess = Meter.CreateCounter<long>("fsus.sitemap.build.cache_access");
    private static readonly Counter<long> ReadinessSnapshotCacheAccess = Meter.CreateCounter<long>("fsus.readiness.snapshot.cache_access");
    private static readonly Histogram<double> ReadinessSnapshotFreshCheckElapsed = Meter.CreateHistogram<double>("fsus.readiness.snapshot.fresh_check_elapsed_ms", "ms");
    private static readonly Counter<long> ReadinessSnapshotDependencyCheckCount = Meter.CreateCounter<long>("fsus.readiness.snapshot.dependency_check_count");
    private static readonly Histogram<double> ReadinessSnapshotAge = Meter.CreateHistogram<double>("fsus.readiness.snapshot.age_ms", "ms");
    private static readonly Histogram<double> ReadinessCheckElapsed = Meter.CreateHistogram<double>("fsus.readiness.check.elapsed", "ms");
    private static readonly Histogram<double> ReadinessPostgresElapsed = Meter.CreateHistogram<double>("fsus.readiness.postgres.elapsed", "ms");
    private static readonly Histogram<double> ReadinessRedisElapsed = Meter.CreateHistogram<double>("fsus.readiness.redis.elapsed", "ms");
    private static readonly Histogram<double> ReadinessRiskControlElapsed = Meter.CreateHistogram<double>("fsus.readiness.risk_control.elapsed", "ms");
    private static readonly Histogram<double> ReadinessRuntimeElapsed = Meter.CreateHistogram<double>("fsus.readiness.runtime.elapsed", "ms");
    private static readonly Counter<long> AnonymousNullifierPrecheckCount = Meter.CreateCounter<long>("fsus.anonymous_nullifier.precheck_count");
    private static readonly Histogram<double> AnonymousNullifierAtomicIncrementElapsed = Meter.CreateHistogram<double>("fsus.anonymous_nullifier.atomic_increment_elapsed_ms", "ms");
    private static readonly Counter<long> AnonymousNullifierScopeLimitRejectedCount = Meter.CreateCounter<long>("fsus.anonymous_nullifier.scope_limit_rejected_count");
    private static readonly Counter<long> AnonymousNullifierBlockedRejectedCount = Meter.CreateCounter<long>("fsus.anonymous_nullifier.blocked_rejected_count");

    public static IReadOnlyList<string> CustomAttributeNames => AllowedCustomAttributeNames;

    internal const int SecurityChallengeV2IssueP99BudgetMs = 100;
    internal const int SecurityChallengeV2VerifyP99BudgetMs = 32;
    internal const int SecurityChallengeV2PayloadP95BudgetBytes = 6200;
    internal const int SecurityChallengeV2ClientRenderP95BudgetMs = 55;
    private const int SecurityChallengeV2SampleLimit = 512;
    private static readonly SlidingWindow<double> SecurityChallengeV2IssueSamples = new(SecurityChallengeV2SampleLimit);
    private static readonly SlidingWindow<double> SecurityChallengeV2VerifySamples = new(SecurityChallengeV2SampleLimit);
    private static readonly SlidingWindow<int> SecurityChallengeV2PayloadSamples = new(SecurityChallengeV2SampleLimit);
    private static readonly SlidingWindow<double> SecurityChallengeV2ClientRenderSamples = new(SecurityChallengeV2SampleLimit);

    public static bool IsAllowedCustomAttribute(string name)
        => AllowedCustomAttributes.Contains(name);

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
        return RouteKindCache.GetOrAdd(value, ClassifyRouteCore);
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
        OperationCounter.Add(1, tags);
        OperationDuration.Record(duration.TotalMilliseconds, tags);
    }

    public static void RecordHttpRequest(string routeKind, int statusCode, TimeSpan duration)
    {
        TagList tags = CreateBaseTags("http", "request", statusCode < 500 ? "ok" : "error");
        tags.Add("fsus.route_kind", routeKind);
        tags.Add("fsus.http.status_code", statusCode);
        OperationCounter.Add(1, tags);
        OperationDuration.Record(duration.TotalMilliseconds, tags);
    }

    public static void RecordCacheOperation(string operation, string policyId, string layer, string result, TimeSpan duration)
    {
        var key = new CacheOperationMetricKey(operation, policyId, layer, result);
        CacheOperationMetricState state = CacheOperationRuntimeCounters.GetOrAdd(
            key,
            static metricKey => new CacheOperationMetricState(metricKey));
        state.Record();
        CacheOperationCounter.Add(1, state.Tags);
        CacheOperationDuration.Record(duration.TotalMilliseconds, state.Tags);
    }

    public static IReadOnlyList<CacheOperationRuntimeCounter> GetCacheOperationCounters()
    {
        var counters = new List<CacheOperationRuntimeCounter>(CacheOperationRuntimeCounters.Count);
        foreach ((CacheOperationMetricKey key, CacheOperationMetricState state) in CacheOperationRuntimeCounters)
        {
            counters.Add(new CacheOperationRuntimeCounter(key.Operation, key.Policy, key.Layer, key.Result, state.Count));
        }

        return counters;
    }

    private sealed class CacheOperationMetricState
    {
        private const int StripeCount = 32;
        private readonly long[]? _stripes;
        private long _exactCount;

        public CacheOperationMetricState(CacheOperationMetricKey key)
        {
            TagList tags = CreateBaseTags("cache", key.Operation, key.Result);
            tags.Add("fsus.cache.operation", key.Operation);
            tags.Add("fsus.cache.policy", key.Policy);
            tags.Add("fsus.cache.layer", key.Layer);
            Tags = tags;
            if (string.Equals(key.Layer, "l1", StringComparison.Ordinal)
                && (string.Equals(key.Result, "hit", StringComparison.Ordinal)
                    || string.Equals(key.Result, "hit_negative", StringComparison.Ordinal)))
            {
                _stripes = new long[StripeCount];
            }
        }

        public TagList Tags
        {
            get;
        }

        public long Count
        {
            get
            {
                if (_stripes is null)
                {
                    return Volatile.Read(ref _exactCount);
                }

                long total = 0;
                for (int i = 0; i < _stripes.Length; i++)
                {
                    total += Volatile.Read(ref _stripes[i]);
                }

                return total;
            }
        }

        public void Record()
        {
            if (_stripes is null)
            {
                Interlocked.Increment(ref _exactCount);
                return;
            }

            int stripe = Environment.CurrentManagedThreadId & (StripeCount - 1);
            Interlocked.Increment(ref _stripes[stripe]);
        }
    }

    public static void RecordSecurityEvent(string operation, string reason, string result)
    {
        long startedAt = Stopwatch.GetTimestamp();
        TryRecord(() =>
        {
            SecurityEventTagCacheKey cacheKey = CreateSecurityEventTagCacheKey(operation, reason, result);
            if (SecurityEventTagCache.TryGetValue(cacheKey, out TagList cachedTags))
            {
                Interlocked.Increment(ref SecurityEventTagCacheHits);
                SecurityEventCounter.Add(1, cachedTags);
                return;
            }

            Interlocked.Increment(ref SecurityEventTagCacheMisses);
            SecurityEventTagCacheMissCounter.Add(1);
            TagList tags = CreateSecurityEventTags(cacheKey.Operation, cacheKey.Reason, cacheKey.Result);
            if (SecurityEventTagCache.Count < SecurityEventTagCacheLimit)
            {
                SecurityEventTagCache.TryAdd(cacheKey, tags);
            }

            SecurityEventCounter.Add(1, tags);
        });
        TryRecord(() => SecurityEventRecordElapsed.Record(Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds));
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
            SecurityRiskEventCounter.Add(1, tags);
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
            SecurityRiskEventBatchSize.Record(Math.Max(0, batchSize));
            SecurityRiskEventFlushElapsed.Record(flushElapsed.TotalMilliseconds);
            SecurityRiskEventInsertedRows.Add(Math.Max(0, insertedRows));
            SecurityRiskEventFailedBatches.Add(Math.Max(0, failedBatches));
            SecurityRiskEventFallbackSingleInserts.Add(Math.Max(0, fallbackSingleInserts));
        });
    }

    public static void RecordRiskScoreAtomicUpdate(
        TimeSpan riskScoreAtomicUpdateElapsed,
        long riskScoreRedisRoundTrips,
        long riskScoreConflictAvoided)
    {
        TryRecord(() =>
        {
            RiskScoreAtomicUpdateElapsed.Record(riskScoreAtomicUpdateElapsed.TotalMilliseconds);
            RiskScoreRedisRoundTrips.Add(Math.Max(0, riskScoreRedisRoundTrips));
            RiskScoreConflictAvoided.Add(Math.Max(0, riskScoreConflictAvoided));
        });
    }

    public static void RecordZeroRiskCacheHit(bool zeroRiskCacheHit)
    {
        TryRecord(() =>
        {
            if (zeroRiskCacheHit)
            {
                ZeroRiskCacheHit.Add(1);
            }
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
            AdminAuditQueuedCounter.Add(Math.Max(0, adminAuditQueuedCount));
            AdminAuditDroppedCounter.Add(Math.Max(0, adminAuditDroppedCount));
            AdminAuditFallbackWriteCounter.Add(Math.Max(0, adminAuditFallbackWriteCount));
            AdminAuditQueueDepth.Record(Math.Max(0, queueDepth));
        });
    }

    public static void RecordAdminAuditBatch(long adminAuditBatchSize, TimeSpan adminAuditWriteElapsed)
    {
        TryRecord(() =>
        {
            AdminAuditBatchSize.Record(Math.Max(0, adminAuditBatchSize));
            AdminAuditWriteElapsed.Record(adminAuditWriteElapsed.TotalMilliseconds);
        });
    }

    public static void RecordAuditChainTailCache(bool hit)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("audit", "chain_tail_cache", hit ? "hit" : "miss");
            AuditChainTailCacheAccess.Add(1, tags);
        });
    }

    public static void RecordAuditChainTailQuery(TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("audit", "chain_tail_query", "ok");
            AuditChainTailQueryElapsed.Record(elapsed.TotalMilliseconds, tags);
        });
    }

    public static void RecordAuditBatchWrite(long batchSize, TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("audit", "batch_write", "ok");
            AuditBatchSize.Record(Math.Max(0, batchSize), tags);
            AuditBatchWriteElapsed.Record(elapsed.TotalMilliseconds, tags);
        });
    }

    public static void RecordAuditList(long auditListDbCount, TimeSpan auditListElapsed)
    {
        TryRecord(() =>
        {
            AuditListDbCounter.Add(Math.Max(0, auditListDbCount));
            AuditListElapsed.Record(auditListElapsed.TotalMilliseconds);
        });
    }

    public static void RecordAuditSummary(long auditSummaryQueryCount, TimeSpan auditFacetElapsed)
    {
        TryRecord(() =>
        {
            AuditSummaryQueryCounter.Add(Math.Max(0, auditSummaryQueryCount));
            AuditFacetElapsed.Record(auditFacetElapsed.TotalMilliseconds);
        });
    }

    public static void RecordAuditFacet(string facet, TimeSpan auditFacetElapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("audit", "facet", NormalizeTelemetryValue(facet, "unknown"));
            AuditFacetElapsed.Record(auditFacetElapsed.TotalMilliseconds, tags);
        });
    }

    public static void RecordAuditSummaryCacheHit(bool auditSummaryCacheHit)
    {
        TryRecord(() =>
        {
            if (auditSummaryCacheHit)
            {
                AuditSummaryCacheHitCounter.Add(1);
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
            SecurityDecisionCounter.Add(1, tags);
        });
    }

    public static void RecordSecurityPolicyVersion(string? policyVersion)
    {
        string normalized = NormalizeTelemetryValue(policyVersion, "unknown");
        if (!string.Equals(normalized, "unknown", StringComparison.Ordinal))
        {
            Volatile.Write(ref ActiveSecurityPolicyVersionValue, normalized);
        }
    }

    public static void RecordSecurityChallengeIssued(string kind, string action, string policyVersion)
    {
        TryRecord(() =>
        {
            TagList tags = CreateSecurityChallengeTags("challenge_issue", "issued", kind, action, policyVersion);
            SecurityChallengeIssuedCounter.Add(1, tags);
        });
    }

    public static void RecordChallengeVerifyRateLimitedBeforeJson()
    {
        TryRecord(() => ChallengeVerifyRateLimitedBeforeJson.Add(1));
    }

    public static void RecordProviderPayloadParse(TimeSpan providerPayloadParseElapsed)
    {
        TryRecord(() => ProviderPayloadParseElapsed.Record(providerPayloadParseElapsed.TotalMilliseconds));
    }

    public static void RecordProviderPayloadRejectedBytes(long providerPayloadRejectedBytes)
    {
        TryRecord(() => ProviderPayloadRejectedBytes.Add(Math.Max(0, providerPayloadRejectedBytes)));
    }

    public static void RecordChallengeVerifyAllocationBytes(long challengeVerifyAllocationBytes)
    {
        TryRecord(() => ChallengeVerifyAllocationBytes.Record(Math.Max(0, challengeVerifyAllocationBytes)));
    }

    public static void RecordSecurityChallengeVerified(string kind, string action, string policyVersion, TimeSpan? solveDuration = null)
    {
        TryRecord(() =>
        {
            TagList tags = CreateSecurityChallengeTags("challenge_verify", "verified", kind, action, policyVersion);
            SecurityChallengeVerifiedCounter.Add(1, tags);
            if (solveDuration is { } duration && duration >= TimeSpan.Zero)
            {
                SecurityChallengeSolveDuration.Record(duration.TotalMilliseconds, tags);
            }
        });
    }

    public static void RecordSecurityChallengeFailed(string kind, string action, string reason, string policyVersion)
    {
        TryRecord(() =>
        {
            TagList tags = CreateSecurityChallengeTags("challenge_verify", "failed", kind, action, policyVersion);
            tags.Add("fsus.security.reason", NormalizeTelemetryValue(reason, "failed"));
            SecurityChallengeFailedCounter.Add(1, tags);
        });
    }

    public static void RecordSecurityChallengeReplayed(string kind, string action, string reason, string policyVersion)
    {
        TryRecord(() =>
        {
            TagList tags = CreateSecurityChallengeTags("challenge_verify", "replayed", kind, action, policyVersion);
            tags.Add("fsus.security.reason", NormalizeTelemetryValue(reason, "replayed"));
            SecurityChallengeReplayedCounter.Add(1, tags);
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
            SecurityChallengeV2IssuedCounter.Add(1, tags);
            SecurityChallengeV2TaskKindCounter.Add(1, tags);
            RecordNonNegativeHistogram(SecurityChallengeV2PayloadBytes, payloadBytes, tags);
            RecordNonNegativeHistogram(SecurityChallengeV2IssueDuration, issueDuration.TotalMilliseconds, tags);
            AddBoundedSample(SecurityChallengeV2PayloadSamples, payloadBytes);
            AddBoundedSample(SecurityChallengeV2IssueSamples, issueDuration.TotalMilliseconds);
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
            SecurityChallengeV2VerifiedCounter.Add(1, tags);
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
            SecurityChallengeV2FailedCounter.Add(1, tags);
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
            SecurityChallengeV2ReplayedCounter.Add(1, tags);
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
            RecordNonNegativeHistogram(SecurityChallengeV2ClientRenderDuration, renderDuration.TotalMilliseconds, tags);
            AddBoundedSample(SecurityChallengeV2ClientRenderSamples, renderDuration.TotalMilliseconds);
        });
    }

    public static SecurityChallengeV2PerformanceBudgetSnapshot CreateSecurityChallengeV2PerformanceBudgetSnapshot()
    {
        double issueP99 = Percentile(SecurityChallengeV2IssueSamples.Snapshot(), 0.99);
        double verifyP99 = Percentile(SecurityChallengeV2VerifySamples.Snapshot(), 0.99);
        int payloadP95 = Percentile(SecurityChallengeV2PayloadSamples.Snapshot(), 0.95);
        double clientRenderP95 = Percentile(SecurityChallengeV2ClientRenderSamples.Snapshot(), 0.95);
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
        SecurityChallengeV2IssueSamples.Clear();
        SecurityChallengeV2VerifySamples.Clear();
        SecurityChallengeV2PayloadSamples.Clear();
        SecurityChallengeV2ClientRenderSamples.Clear();
    }

    public static void RecordDbOperation(string operation, string result, TimeSpan duration)
    {
        TagList tags = CreateBaseTags("db", operation, result);
        tags.Add("fsus.db.system", "postgresql");
        tags.Add("fsus.db.operation", operation);
        DbOperationDuration.Record(duration.TotalMilliseconds, tags);
    }

    public static void RecordAotRender(string source, string backfill, string result, TimeSpan duration)
    {
        TagList tags = CreateBaseTags("public_aot", "render", result);
        tags.Add("fsus.aot.source", source);
        tags.Add("fsus.aot.backfill", backfill);
        AotRenderDuration.Record(duration.TotalMilliseconds, tags);
    }

    public static void RecordSearchOperation(string mode, string result, TimeSpan duration)
    {
        TagList tags = CreateBaseTags("search", mode, result);
        tags.Add("fsus.search.mode", mode);
        SearchOperationDuration.Record(duration.TotalMilliseconds, tags);
    }

    public static void RecordSearchRuntimeSnapshotMemory(long estimatedBytes, string source)
    {
        TagList tags = CreateBaseTags("search", "runtime_snapshot_memory", "ok");
        tags.Add("fsus.search.source", source);
        RecordNonNegativeHistogram(SearchRuntimeSnapshotMemoryBytes, estimatedBytes, tags);
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

        BackgroundJobDuration.Record(duration.TotalMilliseconds, tags);
    }

    public static void RecordArticleOutboxClaim(long claimed, long reclaimed)
        => TryRecord(() =>
        {
            if (claimed > 0)
            {
                ArticleOutboxClaimed.Add(claimed);
            }

            if (reclaimed > 0)
            {
                ArticleOutboxReclaimed.Add(reclaimed);
            }
        });

    public static void RecordArticleOutboxClaimLost()
        => TryRecord(() => ArticleOutboxClaimLost.Add(1));

    public static void RecordArticleOutboxHeartbeat(string result, long renewed)
        => TryRecord(() =>
        {
            TagList tags = CreateBaseTags("article_outbox", "heartbeat", result);
            ArticleOutboxHeartbeat.Add(Math.Max(1, renewed), tags);
        });

    public static void RecordArticleOutboxStuckClaims(long count)
        => TryRecord(() => ArticleOutboxStuckClaims.Record(Math.Max(0, count)));

    public static void RecordReadAggregateFlush(long count)
    {
        if (count > 0)
        {
            ReadAggregateFlushCounter.Add(count);
        }
    }

    public static void RecordHotStatsInvalidation(string kind, string operation, string reason, long count)
    {
        long value = Math.Max(1, count);
        if (string.Equals(kind, "hot_articles", StringComparison.Ordinal))
        {
            if (string.Equals(operation, "dirty", StringComparison.Ordinal))
            {
                HotArticlesDirtyCounter.Add(value);
                return;
            }

            HotArticlesFlushCounter.Add(1);
            HotArticlesCoalescedCounter.Add(value);
            return;
        }

        if (string.Equals(operation, "dirty", StringComparison.Ordinal))
        {
            StatsDirtyCounter.Add(value);
            return;
        }

        StatsFlushCounter.Add(1);
    }

    public static void RecordHotArticlesVersion(long version)
    {
        if (version > 0)
        {
            Volatile.Write(ref HotArticlesVersionValue, version);
        }
    }

    public static void RecordCacheRemoveMany(long keys, long redisBatches, TimeSpan elapsed)
    {
        CacheRemoveManyKeyCounter.Add(Math.Max(0, keys));
        CacheRemoveManyRedisBatchCounter.Add(Math.Max(0, redisBatches));
        CacheRemoveManyElapsed.Record(elapsed.TotalMilliseconds);
    }

    public static void RecordCacheRemovePrefixMany(long prefixes, long registryScans, long deletedKeys, TimeSpan elapsed)
    {
        CacheRemovePrefixManyPrefixCounter.Add(Math.Max(0, prefixes));
        CacheRemovePrefixManyRegistryScanCounter.Add(Math.Max(0, registryScans));
        CacheRemovePrefixManyDeletedKeyCounter.Add(Math.Max(0, deletedKeys));
        CacheRemovePrefixManyElapsed.Record(elapsed.TotalMilliseconds);
    }

    public static void RecordIncrementManyWithExpiry(string policyId, long keyCount, long expiryAppliedCount, TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("cache", "increment_many_with_expiry", "ok");
            tags.Add("fsus.cache.policy", NormalizeTelemetryValue(policyId, "unknown"));
            CacheIncrementManyWithExpiryKeyCount.Add(Math.Max(0, keyCount), tags);
            CacheIncrementManyWithExpiryAppliedCount.Add(Math.Max(0, expiryAppliedCount), tags);
            CacheIncrementManyWithExpiryElapsed.Record(Math.Max(0d, elapsed.TotalMilliseconds), tags);
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
        PublicAotInvalidationScopeCounter.Add(Math.Max(0, scopes));
        PublicAotInvalidatedKeyCounter.Add(Math.Max(0, invalidatedKeys));
        PublicAotDeletedFileCounter.Add(Math.Max(0, deletedFiles));
        PublicAotRegistryRemovedMemberCounter.Add(Math.Max(0, registryRemovedMembers));
        PublicAotPublishCounter.Add(Math.Max(0, publishCount));
        PublicAotInvalidationDuration.Record(elapsed.TotalMilliseconds);
        if (!string.IsNullOrWhiteSpace(registryCleanupStatus))
        {
            TagList tags = CreateBaseTags("public_aot", "registry_cleanup", registryCleanupStatus);
            PublicAotRegistryCleanupCounter.Add(1, tags);
            PublicAotRegistryDeletedKeyCounter.Add(Math.Max(0, registryDeletedKeys), tags);
        }
    }

    public static void RecordPublicAotCompose(string operation, TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("public_aot", NormalizeTelemetryValue(operation, "compose"), "ok");
            PublicAotComposeElapsed.Record(Math.Max(0, elapsed.TotalMilliseconds), tags);
        });
    }

    public static void RecordPublicAotBootstrapSeoSnapshot(bool cacheHit)
    {
        if (cacheHit)
        {
            Interlocked.Increment(ref PublicAotBootstrapSeoSnapshotHits);
            return;
        }

        Interlocked.Increment(ref PublicAotBootstrapSeoSnapshotMisses);
    }

    public static void RecordPublicAotCacheCodecAccess(bool cacheHit)
    {
        if (cacheHit)
        {
            Interlocked.Increment(ref PublicAotCacheCodecHits);
            return;
        }

        Interlocked.Increment(ref PublicAotCacheCodecMisses);
    }

    public static void RecordPublicAotShellCacheFileAccess(bool cacheHit)
    {
        if (cacheHit)
        {
            Interlocked.Increment(ref PublicAotShellCacheFileHits);
            return;
        }

        Interlocked.Increment(ref PublicAotShellCacheFileMisses);
    }

    public static void RecordPublicHotDelta(
        long changedArticles,
        long rebuiltListFrames,
        long rebuiltTaxonomyFrames,
        TimeSpan elapsed)
    {
        PublicHotDeltaChangedArticleCounter.Add(Math.Max(0, changedArticles));
        PublicHotDeltaRebuiltListCounter.Add(Math.Max(0, rebuiltListFrames));
        PublicHotDeltaRebuiltTaxonomyCounter.Add(Math.Max(0, rebuiltTaxonomyFrames));
        PublicHotDeltaElapsed.Record(elapsed.TotalMilliseconds);
    }

    public static void RecordPublicHotResidency(
        PublicHotReadResidentBreakdown residency,
        long snapshotOverlapBytes)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("public-hot-read", "snapshot_publish", "ok");
            PublicHotResidentBytes.Record(residency.TotalBytes, tags);
            PublicHotSnapshotOverlapBytes.Record(Math.Max(0, snapshotOverlapBytes), tags);
            PublicHotLohEligibleBytes.Record(residency.LohEligibleArrayBytes, tags);
            PublicHotArtifactObjects.Record(residency.ObjectCount, tags);
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
            AdminIntegrityCheckElapsed.Record(elapsed.TotalMilliseconds, tags);
            AdminIntegrityTotalCount.Add(Math.Max(0, totalCount), tags);
            AdminIntegritySampleCount.Add(Math.Max(0, sampleCount), tags);
            AdminIntegrityScannedFiles.Add(Math.Max(0, scannedFileCount), tags);
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
            ModerationDictionaryScannedContent.Add(Math.Max(0, scannedContentCount), tags);
            ModerationDictionaryMatchedTerms.Add(Math.Max(0, matchedTermCount), tags);
            ModerationDictionaryMatchElapsed.Record(elapsed.TotalMilliseconds, tags);
            ModerationDictionaryEvaluatedRegions.Add(Math.Max(0, evaluatedRegionCount), tags);
        });
    }

    public static void RecordTaxonomyFrameCache(string frame, bool hit)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("taxonomy-frame", NormalizeTelemetryValue(frame, "unknown"), hit ? "hit" : "miss");
            TaxonomyFrameCacheAccess.Add(1, tags);
        });
    }

    public static void RecordTaxonomyFrameColdMiss(string frame, TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("taxonomy-frame", NormalizeTelemetryValue(frame, "unknown"), "miss");
            TaxonomyFrameColdMissElapsed.Record(elapsed.TotalMilliseconds, tags);
        });
    }

    public static void RecordTaxonomyProjectionUpdate(long updatedRows, long frameVersion, TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("taxonomy-projection", frameVersion > 0 ? "changed" : "unchanged", "ok");
            TaxonomyProjectionUpdateCount.Add(Math.Max(0, updatedRows), tags);
            TaxonomyFrameColdMissElapsed.Record(elapsed.TotalMilliseconds, tags);
        });
    }

    public static void RecordTaxonomyFrameVersion(long version, string reason)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("taxonomy-frame", NormalizeTelemetryValue(reason, "unknown"), "version");
            TaxonomyFrameVersionCounter.Add(version > 0 ? 1 : 0, tags);
        });
    }

    public static void RecordNotificationStreamOriginValidation(string stage, bool accepted, TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("notification-stream", NormalizeTelemetryValue(stage, "origin"), accepted ? "accepted" : "rejected");
            NotificationStreamOriginValidationElapsed.Record(elapsed.TotalMilliseconds, tags);
        });
    }

    public static void RecordNotificationStreamOriginCacheAccess(TimeSpan elapsed)
    {
        Interlocked.Increment(ref NotificationStreamOriginCacheHits);
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("notification-stream", "origin-cache", "hit");
            NotificationStreamOriginCacheElapsed.Record(Math.Max(0, elapsed.TotalMilliseconds), tags);
        });
    }

    public static void RecordNotificationStreamOriginCacheRebuild(TimeSpan elapsed)
    {
        Interlocked.Increment(ref NotificationStreamOriginCacheMisses);
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("notification-stream", "origin-cache", "miss");
            NotificationStreamOriginCacheElapsed.Record(Math.Max(0, elapsed.TotalMilliseconds), tags);
        });
    }

    public static void RecordNotificationStreamAdmissionAccountState(bool hit, bool loadedFromDb)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("notification-stream", "account_state", hit ? "hit" : "miss");
            NotificationStreamAdmissionAccountStateCache.Add(1, tags);
            if (loadedFromDb)
            {
                NotificationStreamAdmissionDbReadCount.Add(1, tags);
            }
        });
    }

    public static void RecordNotificationStreamAdmissionRejected(string reason)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("notification-stream", NormalizeTelemetryValue(reason, "unknown"), "rejected");
            NotificationStreamAdmissionRejectedCount.Add(1, tags);
        });
    }

    public static void RecordLoginSessionReplacement(long replacedSessionCount, long sessionRevokeCommandCount, TimeSpan transactionElapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("auth-login", "session-replacement", "ok");
            LoginReplacedSessionCount.Add(Math.Max(0, replacedSessionCount), tags);
            LoginSessionRevokeCommandCount.Add(Math.Max(0, sessionRevokeCommandCount), tags);
            LoginTransactionElapsed.Record(transactionElapsed.TotalMilliseconds, tags);
        });
    }

    public static void RecordAuthRefreshSuccess(long dbCommandCount, TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("auth-refresh", "refresh", "success");
            AuthRefreshSuccessDbCommandCount.Add(Math.Max(0, dbCommandCount), tags);
            AuthRefreshSuccessElapsed.Record(elapsed.TotalMilliseconds, tags);
        });
    }

    public static void RecordAuthRefreshReplayDetected()
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("auth-refresh", "refresh", "replay_detected");
            AuthRefreshReplayDetectedCount.Add(1, tags);
        });
    }

    public static void RecordAuthRefreshFamilyRevoke(int revokedSessionCount)
    {
        TryRecord(() =>
        {
            bool hit = revokedSessionCount > 0;
            TagList tags = CreateBaseTags("auth-refresh", "family-revoke", hit ? "hit" : "miss");
            AuthRefreshFamilyRevokeCount.Add(Math.Max(0, revokedSessionCount), tags);
            if (hit)
            {
                AuthRefreshFamilyRevokeWindowCount.Add(1, tags);
            }
        });
    }

    public static void RecordAuthRefreshCookieWriteFailed(string reason)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("auth-refresh", reason, "cookie_write_failed");
            AuthRefreshCookieWriteFailedCount.Add(1, tags);
        });
    }

    public static void RecordAccountSnapshotCacheHit(bool hit)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("account-snapshot", "cache", hit ? "hit" : "miss");
            AccountSnapshotCacheHit.Add(hit ? 1 : 0, tags);
        });
    }

    public static void RecordAccountSnapshotDbReadCount()
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("account-snapshot", "db_read", "ok");
            AccountSnapshotDbReadCount.Add(1, tags);
        });
    }

    public static void RecordCommentActorResolverPublicHandleCache(bool hit)
    {
        if (hit)
        {
            Interlocked.Increment(ref CommentActorResolverPublicHandleHits);
            return;
        }

        Interlocked.Increment(ref CommentActorResolverPublicHandleMisses);
    }

    public static void RecordCommentActorResolverCredentialLevelCache(bool hit)
    {
        if (hit)
        {
            Interlocked.Increment(ref CommentActorResolverCredentialLevelHits);
            return;
        }

        Interlocked.Increment(ref CommentActorResolverCredentialLevelMisses);
    }

    public static void RecordCommentActorResolverDbRoundTrip(string projection)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("comment-actor", NormalizeTelemetryValue(projection, "account"), "db");
            CommentActorResolverDbRoundTrips.Add(1, tags);
        });
    }

    public static void RecordMessageCenterList(string phase, TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("message-center", NormalizeTelemetryValue(phase, "list"), "ok");
            MessageCenterListElapsed.Record(Math.Max(0, elapsed.TotalMilliseconds), tags);
        });
    }

    public static void RecordMessageCenterReply(string phase, TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("message-center", NormalizeTelemetryValue(phase, "reply"), "ok");
            MessageCenterReplyElapsed.Record(Math.Max(0, elapsed.TotalMilliseconds), tags);
        });
    }

    public static void RecordMessageCenterFanoutRefresh(TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("message-center", "fanout-refresh", "ok");
            MessageCenterFanoutRefreshElapsed.Record(Math.Max(0, elapsed.TotalMilliseconds), tags);
        });
    }

    public static void RecordMessageCenterFanoutBuildItem(TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("message-center", "fanout-build-item", "ok");
            MessageCenterFanoutBuildItemElapsed.Record(Math.Max(0, elapsed.TotalMilliseconds), tags);
        });
    }

    public static void RecordAuthMe(TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("auth", "me", "ok");
            AuthMeElapsed.Record(Math.Max(0d, elapsed.TotalMilliseconds), tags);
        });
    }

    public static void RecordMfaChallengeStartAccountRead(TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("mfa", "challenge_start_account_read", "ok");
            MfaChallengeStartAccountReadElapsed.Record(Math.Max(0d, elapsed.TotalMilliseconds), tags);
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

            AdminAccountListQueryElapsed.Record(elapsed.TotalMilliseconds, tags);
            if (totalCountUsed)
            {
                AdminAccountListCountUsed.Add(1, tags);
                return;
            }

            AdminAccountListCountSkipped.Add(1, tags);
        });
    }

    public static void RecordUploadSessionCleanup(long scannedSessions, long deletedSessions, TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("upload-session-cleanup", "scan", "ok");
            UploadSessionCleanupScannedSessions.Add(Math.Max(0, scannedSessions), tags);
            UploadSessionCleanupDeletedSessions.Add(Math.Max(0, deletedSessions), tags);
            UploadSessionCleanupElapsed.Record(elapsed.TotalMilliseconds, tags);
        });
    }

    public static void RecordUploadSessionCleanupSignal(string result)
    {
        TryRecord(() =>
        {
            string normalized = NormalizeTelemetryValue(result, "unknown");
            TagList tags = CreateBaseTags("upload-session-cleanup", "signal", normalized);
            tags.Add("fsus.upload.cleanup.signal", normalized);
            UploadSessionCleanupSignalCount.Add(1, tags);
        });
    }

    public static void RecordUploadSessionLockAcquire(long currentLockCount, TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("upload-session-lock", "acquire", "ok");
            UploadSessionLockCurrentCount.Record(Math.Max(0, currentLockCount), tags);
            UploadSessionLockAcquireElapsed.Record(elapsed.TotalMilliseconds, tags);
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
            UploadSessionLockCurrentCount.Record(Math.Max(0, currentLockCount), tags);
            UploadSessionLockStaleScannedCount.Add(Math.Max(0, scannedLockCount), tags);
            UploadSessionLockStaleDisposedCount.Add(Math.Max(0, disposedLockCount), tags);
            UploadSessionLockCleanupElapsed.Record(elapsed.TotalMilliseconds, tags);
        });
    }

    public static void RecordPasskeyAssertion(string kind, long dbCommandCount, TimeSpan elapsed, string result)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("passkey", "assertion", NormalizeTelemetryValue(result, "unknown"));
            tags.Add("fsus.passkey.assertion.kind", NormalizeTelemetryValue(kind, "unknown"));
            PasskeyAssertionDbCommandCount.Add(Math.Max(0, dbCommandCount), tags);
            PasskeyAssertionElapsed.Record(elapsed.TotalMilliseconds, tags);
        });
    }

    public static void RecordPasskeySignCountConflict(string kind)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("passkey", "sign_count_update", "conflict");
            tags.Add("fsus.passkey.assertion.kind", NormalizeTelemetryValue(kind, "unknown"));
            PasskeySignCountUpdateConflictCount.Add(1, tags);
        });
    }

    public static void RecordAdminPasskeyAssertion(string kind, long dbCommandCount, TimeSpan elapsed, string result)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("admin-passkey", "assertion", NormalizeTelemetryValue(result, "unknown"));
            tags.Add("fsus.admin.passkey.assertion.kind", NormalizeTelemetryValue(kind, "unknown"));
            AdminPasskeyAssertionDbCommandCount.Add(Math.Max(0, dbCommandCount), tags);
            AdminPasskeyAssertionElapsed.Record(elapsed.TotalMilliseconds, tags);
        });
    }

    public static void RecordAdminPasskeySignCountConflict(string kind)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("admin-passkey", "sign_count_update", "conflict");
            tags.Add("fsus.admin.passkey.assertion.kind", NormalizeTelemetryValue(kind, "unknown"));
            AdminPasskeySignCountConflictCount.Add(1, tags);
        });
    }

    public static void RecordAdminSessionList(long returnedCount, TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("admin-session", "list", "ok");
            AdminSessionListReturnedCount.Add(Math.Max(0, returnedCount), tags);
            AdminSessionListElapsed.Record(elapsed.TotalMilliseconds, tags);
        });
    }

    public static void RecordAdminSessionRevokeOthers(long revokedCount, TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("admin-session", "revoke_others", "ok");
            AdminSessionRevokeOthersCount.Add(Math.Max(0, revokedCount), tags);
            AdminSessionRevokeOthersElapsed.Record(elapsed.TotalMilliseconds, tags);
        });
    }

    public static void RecordAdminSessionValidationDbRead()
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("admin-session", "validation", "db_read");
            AdminSessionValidationDbReadCount.Add(1, tags);
        });
    }

    public static void RecordAdminSessionValidationCacheHit()
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("admin-session", "validation", "cache_hit");
            AdminSessionValidationCacheHit.Add(1, tags);
        });
    }

    public static void RecordMfaFailureCounterKeys(long keyCount)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("mfa", "failure_counter", "ok");
            MfaFailureCounterKeyCount.Add(Math.Max(0, keyCount), tags);
        });
    }

    public static void RecordMfaCounterExpired(long count)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("mfa", "failure_counter", "expiry_applied");
            MfaCounterExpiredCount.Add(Math.Max(0, count), tags);
        });
    }

    public static void RecordAdminSessionTouchSkipped()
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("admin-session", "touch", "skipped");
            AdminSessionTouchSkipped.Add(1, tags);
        });
    }

    public static void RecordAdminSessionTouch(bool updated, TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("admin-session", "touch", updated ? "updated" : "conflict");
            AdminSessionTouchElapsed.Record(elapsed.TotalMilliseconds, tags);
        });
    }

    public static void RecordDistributionDiagnostics(bool cacheHit, long dbCommandCount, TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("distribution", "diagnostics", cacheHit ? "hit" : "miss");
            DistributionDiagnosticsElapsed.Record(elapsed.TotalMilliseconds, tags);
            DistributionDiagnosticsCacheAccess.Add(1, tags);
            DistributionDiagnosticsDbCommandCount.Add(Math.Max(0, dbCommandCount), tags);
        });
    }

    public static void RecordRelatedReadingBuild(bool cacheHit, TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("related-reading", "build", cacheHit ? "hit" : "miss");
            RelatedReadingBuildElapsed.Record(elapsed.TotalMilliseconds, tags);
            RelatedReadingBuildCacheAccess.Add(1, tags);
        });
    }

    public static void RecordSitemapBuild(bool cacheHit, TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("sitemap", "build", cacheHit ? "hit" : "miss");
            SitemapBuildElapsed.Record(elapsed.TotalMilliseconds, tags);
            SitemapBuildCacheAccess.Add(1, tags);
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
            ReadinessSnapshotCacheAccess.Add(1, tags);
            ReadinessSnapshotFreshCheckElapsed.Record(freshCheckElapsed.TotalMilliseconds, tags);
            ReadinessSnapshotDependencyCheckCount.Add(Math.Max(0, dependencyCheckCount), tags);
            ReadinessSnapshotAge.Record(Math.Max(0, snapshotAge.TotalMilliseconds), tags);
        });
    }

    public static void RecordReadinessCheckElapsed(string check, TimeSpan elapsed)
    {
        TryRecord(() =>
        {
            string normalized = NormalizeTelemetryValue(check, "unknown");
            TagList tags = CreateBaseTags("readiness", normalized, "ok");
            double elapsedMs = Math.Max(0, elapsed.TotalMilliseconds);
            ReadinessCheckElapsed.Record(elapsedMs, tags);
            switch (normalized)
            {
                case "postgres":
                    ReadinessPostgresElapsed.Record(elapsedMs, tags);
                    break;
                case "redis":
                    ReadinessRedisElapsed.Record(elapsedMs, tags);
                    break;
                case "risk_control":
                    ReadinessRiskControlElapsed.Record(elapsedMs, tags);
                    break;
                case "runtime":
                    ReadinessRuntimeElapsed.Record(elapsedMs, tags);
                    break;
            }
        });
    }

    public static void RecordAnonymousNullifierPrecheck()
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("anonymous-nullifier", "precheck", "ok");
            AnonymousNullifierPrecheckCount.Add(1, tags);
        });
    }

    public static void RecordAnonymousNullifierAtomicIncrement(TimeSpan elapsed, string status)
    {
        TryRecord(() =>
        {
            string normalizedStatus = NormalizeTelemetryValue(status, "unknown");
            TagList tags = CreateBaseTags("anonymous-nullifier", "atomic_increment", normalizedStatus);
            tags.Add("fsus.anonymous_nullifier.status", normalizedStatus);
            RecordNonNegativeHistogram(AnonymousNullifierAtomicIncrementElapsed, elapsed.TotalMilliseconds, tags);
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
                AnonymousNullifierBlockedRejectedCount.Add(1, tags);
                return;
            }

            if (string.Equals(normalizedStatus, "scope_limit_exceeded", StringComparison.Ordinal))
            {
                AnonymousNullifierScopeLimitRejectedCount.Add(1, tags);
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

        foreach (string reason in SecurityRiskReasonNames.Values)
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
        foreach (string reason in SecurityRiskReasonNames.Values)
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
        => SecurityEventInternedValues.Contains(value)
            ? string.Intern(value)
            : value;

    private static TagList CreateSecurityEventTags(string operation, string reason, string result)
    {
        TagList tags = CreateBaseTags("security", operation, result);
        tags.Add("fsus.security.reason", reason);
        return tags;
    }

    private static string ResolveSecurityRiskReasonName(SecurityRiskReason reason)
        => SecurityRiskReasonNames.TryGetValue(reason, out string? name)
            ? name
            : string.Intern(reason.ToString());

    private static double ObserveSecurityEventTagCacheHitRatio()
    {
        long hits = Volatile.Read(ref SecurityEventTagCacheHits);
        long misses = Volatile.Read(ref SecurityEventTagCacheMisses);
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
        RecordNonNegativeHistogram(SecurityChallengeV2PayloadBytes, payloadBytes, tags);
        RecordNonNegativeHistogram(SecurityChallengeV2VerifyDuration, verifyDuration.TotalMilliseconds, tags);
        AddBoundedSample(SecurityChallengeV2PayloadSamples, payloadBytes);
        AddBoundedSample(SecurityChallengeV2VerifySamples, verifyDuration.TotalMilliseconds);
        if (solveDuration is { } duration)
        {
            RecordNonNegativeHistogram(SecurityChallengeV2SolveDuration, duration.TotalMilliseconds, tags);
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
        tags.Add("fsus.security.policy_version", Volatile.Read(ref ActiveSecurityPolicyVersionValue));
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
