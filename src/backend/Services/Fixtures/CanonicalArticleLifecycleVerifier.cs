using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;

using Microsoft.Extensions.Configuration;

using SqlSugar;

namespace FsusBlog.Server.Services.Fixtures;

/// <summary>
/// Independent read-only verifier for the lifecycle fixture receipt.
/// It deliberately does not call the lifecycle writer: the receipt is checked by rebuilding
/// the article timeline from immutable rows, sealed outbox envelopes, and the audit chain.
/// </summary>
public sealed record CanonicalArticleLifecycleVerificationResult(
    bool IsValid,
    IReadOnlyList<string> Violations)
{
    public void ThrowIfInvalid()
    {
        if (!IsValid)
        {
            throw new InvalidOperationException(
                $"canonical_article_lifecycle_verification_failed: {string.Join(';', Violations)}");
        }
    }
}

public static class CanonicalArticleLifecycleVerifier
{
    private static readonly JsonSerializerOptions s_jsonOptions = new(JsonSerializerDefaults.Web);

    public static async Task<CanonicalArticleLifecycleVerificationResult> VerifyAsync(
        ISqlSugarClient db,
        IConfiguration configuration,
        CanonicalArticleLifecycleReceipt receipt,
        CancellationToken cancellationToken = default,
        TimeProvider? timeProvider = null)
    {
        ArgumentNullException.ThrowIfNull(db);
        ArgumentNullException.ThrowIfNull(configuration);
        ArgumentNullException.ThrowIfNull(receipt);

        var violations = new List<string>();
        VerifyReceiptEnvelope(receipt, violations);
        DateTime now = (timeProvider ?? TimeProvider.System).GetUtcNow().UtcDateTime;
        foreach (CanonicalArticleLifecycleOperationReceipt operation in receipt.Operations ?? [])
        {
            if (operation.TransitionedAtUtc > now)
            {
                violations.Add($"operation_ahead_of_business_clock:{operation.TransitionId}");
            }
        }

        Article? article = await db.Queryable<Article>()
            .ClearFilter()
            .Where(item => item.Id == receipt.ArticleId)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);
        if (article is null)
        {
            violations.Add($"article_missing:{receipt.ArticleId}");
            return new CanonicalArticleLifecycleVerificationResult(false, violations.AsReadOnly());
        }

        List<ArticleRevision> revisions = await db.Queryable<ArticleRevision>()
            .ClearFilter()
            .Where(item => item.ArticleId == receipt.ArticleId)
            .OrderBy(item => item.RevisionNo, OrderByType.Asc)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        List<ArticlePublicationRecord> publications = await db.Queryable<ArticlePublicationRecord>()
            .ClearFilter()
            .Where(item => item.ArticleId == receipt.ArticleId)
            .OrderBy(item => item.PublicationNo, OrderByType.Asc)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        List<ArticleRevisionContentBlock> contentBlocks = await db.Queryable<ArticleRevisionContentBlock>()
            .ClearFilter()
            .Where(item => revisions.Select(revision => revision.ContentBlockId).Contains(item.Id))
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        List<ArticleRightsSnapshot> rightsSnapshots = await db.Queryable<ArticleRightsSnapshot>()
            .ClearFilter()
            .Where(item => item.ArticleId == receipt.ArticleId)
            .OrderBy(item => item.Id, OrderByType.Asc)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        List<ArticleResponsibilitySnapshot> responsibilitySnapshots = await db.Queryable<ArticleResponsibilitySnapshot>()
            .ClearFilter()
            .Where(item => item.ArticleId == receipt.ArticleId)
            .OrderBy(item => item.Id, OrderByType.Asc)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        List<ArticleMutationOutboxEvent> outboxEvents = await db.Queryable<ArticleMutationOutboxEvent>()
            .ClearFilter()
            .Where(item => item.AggregateId == receipt.ArticleId)
            .OrderBy(item => item.Id, OrderByType.Asc)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        string articleIdText = receipt.ArticleId.ToString(CultureInfo.InvariantCulture);
        List<AuditLog> auditLogs = await db.Queryable<AuditLog>()
            .ClearFilter()
            .Where(item => item.TargetType == "article-canonical-lifecycle"
                        && item.TargetId == articleIdText)
            .OrderBy(item => item.Id, OrderByType.Asc)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        VerifyArticleCoordinates(article, receipt, violations);
        VerifyRevisionTimeline(receipt, revisions, contentBlocks, rightsSnapshots, responsibilitySnapshots, violations);
        VerifyPublicationTimeline(receipt, revisions, publications, violations);
        VerifyOperations(receipt, revisions, publications, rightsSnapshots, responsibilitySnapshots, outboxEvents, violations);
        VerifyOutbox(receipt, outboxEvents, violations);
        VerifyAudit(receipt, auditLogs, configuration, violations);

        return new CanonicalArticleLifecycleVerificationResult(
            violations.Count == 0,
            violations.AsReadOnly());
    }

    private static void VerifyReceiptEnvelope(
        CanonicalArticleLifecycleReceipt receipt,
        List<string> violations)
    {
        if (!string.Equals(receipt.Schema, CanonicalArticleLifecycleFixturePort.Schema, StringComparison.Ordinal))
        {
            violations.Add("receipt_schema_mismatch");
        }
        if (receipt.ArticleId <= 0 || receipt.AdminPrincipalId <= 0)
        {
            violations.Add("receipt_identity_invalid");
        }
        if (!string.Equals(
                receipt.WriterContractDigest,
                CanonicalArticleLifecycleFixturePort.CurrentWriterContractDigest,
                StringComparison.Ordinal))
        {
            violations.Add("writer_contract_digest_mismatch");
        }
        if (string.IsNullOrWhiteSpace(receipt.TemporalContextDigest)
            || receipt.TemporalContextDigest.Contains("recompute", StringComparison.OrdinalIgnoreCase))
        {
            violations.Add("temporal_context_digest_invalid");
        }
        if (string.IsNullOrWhiteSpace(receipt.ContentDigest)
            || receipt.ContentDigest.Contains("recompute", StringComparison.OrdinalIgnoreCase))
        {
            violations.Add("content_digest_invalid");
        }
        if (string.IsNullOrWhiteSpace(receipt.RevisionTimelineDigest)
            || receipt.RevisionTimelineDigest.Contains("recompute", StringComparison.OrdinalIgnoreCase))
        {
            violations.Add("revision_timeline_digest_invalid");
        }
        if (receipt.Operations is null || receipt.Operations.Count == 0)
        {
            violations.Add("operations_missing");
        }
        if (receipt.RevisionIds is null || receipt.RevisionIds.Count == 0)
        {
            violations.Add("revision_coordinates_missing");
        }
        if (receipt.RevisionIds is not null
            && receipt.RevisionIds.Distinct().Count() != receipt.RevisionIds.Count)
        {
            violations.Add("revision_coordinates_not_unique");
        }
        if (receipt.PublicationIds is null)
        {
            violations.Add("publication_coordinates_missing");
        }
        else if (receipt.PublicationIds.Distinct().Count() != receipt.PublicationIds.Count)
        {
            violations.Add("publication_coordinates_not_unique");
        }

        string expectedDigest = CanonicalArticleLifecycleFixturePort.ComputeReceiptDigest(
            receipt.WriterContractDigest,
            receipt.TemporalContextDigest,
            receipt.RunId,
            receipt.Namespace,
            receipt.ProfileId,
            receipt.SemanticRole,
            receipt.Variant,
            receipt.AdminPrincipalId,
            receipt.ArticleId,
            receipt.Operations ?? [],
            receipt.RevisionIds ?? [],
            receipt.PublicationIds ?? [],
            receipt.CurrentRevisionId,
            receipt.CurrentPublicationId,
            receipt.CurrentStatus,
            receipt.IsDeleted,
            receipt.ContentDigest,
            receipt.RevisionTimelineDigest);
        if (!string.Equals(expectedDigest, receipt.ReceiptDigest, StringComparison.Ordinal))
        {
            violations.Add("receipt_digest_tamper_detected");
        }
    }

    private static void VerifyArticleCoordinates(
        Article article,
        CanonicalArticleLifecycleReceipt receipt,
        List<string> violations)
    {
        if (article.CurrentRevisionId != receipt.CurrentRevisionId)
        {
            violations.Add("current_revision_pointer_mismatch");
        }
        if (article.CurrentPublicationId != receipt.CurrentPublicationId)
        {
            violations.Add("current_publication_pointer_mismatch");
        }
        if (article.Status != receipt.CurrentStatus)
        {
            violations.Add("current_status_mismatch");
        }
        if (article.IsDeleted != receipt.IsDeleted)
        {
            violations.Add("current_deleted_flag_mismatch");
        }
        if (receipt.CurrentRevisionId <= 0)
        {
            violations.Add("current_revision_missing");
        }
        CanonicalArticleLifecycleOperationReceipt? last = receipt.Operations?.LastOrDefault();
        if (last?.Operation == "scheduled-update"
            || last?.Operation == "create" && last.AfterStatus == ArticleStatus.Scheduled)
        {
            DateTime? storedDueAt = article.PendingPublicationAt ?? article.ScheduledPublishAt;
            if (last.ScheduledPublishAt is null || storedDueAt != last.ScheduledPublishAt)
            {
                violations.Add("pending_schedule_time_mismatch");
            }
            if (last.AfterPublicationId != article.CurrentPublicationId
                || last.BeforePublicationId != last.AfterPublicationId)
            {
                violations.Add("pending_schedule_publication_changed");
            }
        }
        if (last?.Operation == "scheduled-publish"
            && (article.PendingPublicationAt.HasValue || article.ScheduledPublishAt.HasValue))
        {
            violations.Add("published_schedule_still_pending");
        }
    }

    private static void VerifyRevisionTimeline(
        CanonicalArticleLifecycleReceipt receipt,
        IReadOnlyList<ArticleRevision> revisions,
        IReadOnlyList<ArticleRevisionContentBlock> contentBlocks,
        IReadOnlyList<ArticleRightsSnapshot> rightsSnapshots,
        IReadOnlyList<ArticleResponsibilitySnapshot> responsibilitySnapshots,
        List<string> violations)
    {
        long[] actualRevisionIds = revisions.Select(item => item.Id).ToArray();
        if (!actualRevisionIds.SequenceEqual(receipt.RevisionIds ?? [], EqualityComparer<long>.Default))
        {
            violations.Add("revision_coordinate_timeline_mismatch");
        }
        for (int index = 0; index < revisions.Count; index++)
        {
            ArticleRevision revision = revisions[index];
            if (revision.RevisionNo != index + 1)
            {
                violations.Add($"revision_no_not_contiguous:{revision.Id}");
            }
            if (revision.CreatedByAdminPrincipalId != receipt.AdminPrincipalId)
            {
                violations.Add($"revision_admin_mismatch:{revision.Id}");
            }
            if (revision.ContentBlockId <= 0)
            {
                violations.Add($"revision_content_block_missing:{revision.Id}");
            }
            ArticleRevisionContentBlock? block = contentBlocks.FirstOrDefault(item => item.Id == revision.ContentBlockId);
            if (block is null)
            {
                violations.Add($"revision_content_block_unresolved:{revision.Id}");
            }
            else
            {
                string digest = ComputeDigest(block.MarkdownContent);
                if (!string.Equals(digest, $"sha256:{block.ContentHash}", StringComparison.OrdinalIgnoreCase)
                    && !string.Equals(digest, block.ContentHash, StringComparison.OrdinalIgnoreCase))
                {
                    violations.Add($"revision_content_block_hash_mismatch:{revision.Id}");
                }
            }
            if (!rightsSnapshots.Any(item => item.ArticleRevisionId == revision.Id))
            {
                violations.Add($"rights_snapshot_missing_for_revision:{revision.Id}");
            }
            if (!responsibilitySnapshots.Any(item => item.ArticleRevisionId == revision.Id))
            {
                violations.Add($"responsibility_snapshot_missing_for_revision:{revision.Id}");
            }
        }

        foreach (ArticleRightsSnapshot snapshot in rightsSnapshots)
        {
            if (snapshot.ArticleRevisionId <= 0
                || snapshot.RevisionNo <= 0
                || snapshot.Id <= 0
                || string.IsNullOrWhiteSpace(snapshot.PolicyHash)
                || string.IsNullOrWhiteSpace(snapshot.ContentCanonicalHash)
                || snapshot.PolicyHash.Contains("recompute", StringComparison.OrdinalIgnoreCase)
                || snapshot.ContentCanonicalHash.Contains("recompute", StringComparison.OrdinalIgnoreCase))
            {
                violations.Add($"rights_snapshot_invalid:{snapshot.Id}");
            }
        }
        foreach (ArticleResponsibilitySnapshot snapshot in responsibilitySnapshots)
        {
            if (snapshot.ArticleRevisionId <= 0
                || snapshot.RevisionNo <= 0
                || snapshot.Id <= 0
                || snapshot.ResponsibilityVersion <= 0)
            {
                violations.Add($"responsibility_snapshot_invalid:{snapshot.Id}");
            }
        }

        string actualTimelineDigest = ComputeRevisionTimelineDigest(revisions, contentBlocks);
        if (!string.Equals(actualTimelineDigest, receipt.RevisionTimelineDigest, StringComparison.Ordinal))
        {
            violations.Add("revision_timeline_digest_mismatch");
        }
    }

    private static void VerifyPublicationTimeline(
        CanonicalArticleLifecycleReceipt receipt,
        IReadOnlyList<ArticleRevision> revisions,
        IReadOnlyList<ArticlePublicationRecord> publications,
        List<string> violations)
    {
        long[] actualPublicationIds = publications.Select(item => item.Id).ToArray();
        if (!actualPublicationIds.SequenceEqual(receipt.PublicationIds ?? [], EqualityComparer<long>.Default))
        {
            violations.Add("publication_coordinate_timeline_mismatch");
        }
        for (int index = 0; index < publications.Count; index++)
        {
            ArticlePublicationRecord publication = publications[index];
            if (publication.PublicationNo != index + 1)
            {
                violations.Add($"publication_no_not_contiguous:{publication.Id}");
            }
            if (publication.ArticleRevisionId <= 0
                || publication.RevisionNo <= 0
                || !revisions.Any(item => item.Id == publication.ArticleRevisionId && item.RevisionNo == publication.RevisionNo))
            {
                violations.Add($"publication_revision_unresolved:{publication.Id}");
            }
            if (publication.RightsSnapshotId <= 0)
            {
                violations.Add($"publication_rights_missing:{publication.Id}");
            }
            if (publication.ResponsibilitySnapshotId is <= 0)
            {
                violations.Add($"publication_responsibility_invalid:{publication.Id}");
            }
        }
    }

    private static void VerifyOperations(
        CanonicalArticleLifecycleReceipt receipt,
        IReadOnlyList<ArticleRevision> revisions,
        IReadOnlyList<ArticlePublicationRecord> publications,
        IReadOnlyList<ArticleRightsSnapshot> rightsSnapshots,
        IReadOnlyList<ArticleResponsibilitySnapshot> responsibilitySnapshots,
        IReadOnlyList<ArticleMutationOutboxEvent> outboxEvents,
        List<string> violations)
    {
        var transitionIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (CanonicalArticleLifecycleOperationReceipt operation in receipt.Operations ?? [])
        {
            if (!transitionIds.Add(operation.TransitionId))
            {
                violations.Add($"transition_id_reused:{operation.TransitionId}");
            }
            if (operation.AfterRevisionId <= 0
                || !revisions.Any(item => item.Id == operation.AfterRevisionId && item.RevisionNo == operation.AfterRevisionNo))
            {
                violations.Add($"operation_after_revision_unresolved:{operation.TransitionId}");
            }
            if (operation.RightsSnapshotId is not > 0
                || !rightsSnapshots.Any(item => item.Id == operation.RightsSnapshotId.Value
                                             && item.ArticleRevisionId == operation.AfterRevisionId))
            {
                violations.Add($"operation_rights_coordinate_unresolved:{operation.TransitionId}:expected={operation.RightsSnapshotId}:revision={operation.AfterRevisionId}:actual={string.Join('|', rightsSnapshots.Select(item => $"{item.Id}:{item.ArticleRevisionId}"))}");
            }
            if (operation.ResponsibilitySnapshotId is not > 0
                || !responsibilitySnapshots.Any(item => item.Id == operation.ResponsibilitySnapshotId.Value
                                                     && item.ArticleRevisionId == operation.AfterRevisionId))
            {
                violations.Add($"operation_responsibility_coordinate_unresolved:{operation.TransitionId}:expected={operation.ResponsibilitySnapshotId}:revision={operation.AfterRevisionId}:actual={string.Join('|', responsibilitySnapshots.Select(item => $"{item.Id}:{item.ArticleRevisionId}"))}");
            }
            if (!outboxEvents.Any(item => string.Equals(item.EventId, operation.OutboxEventId, StringComparison.Ordinal)
                                       && item.AggregateId == receipt.ArticleId))
            {
                violations.Add($"operation_outbox_missing:{operation.TransitionId}");
            }
            if (string.IsNullOrWhiteSpace(operation.AuditChainId)
                || string.IsNullOrWhiteSpace(operation.AuditRecordHash))
            {
                violations.Add($"operation_audit_coordinate_missing:{operation.TransitionId}");
            }

            bool preservesRevision = operation.Operation is "delete" or "scheduled-publish";
            if (!string.Equals(operation.Operation, "create", StringComparison.Ordinal)
                && operation.BeforeRevisionId is null)
            {
                violations.Add($"operation_before_revision_missing:{operation.TransitionId}");
            }
            if (!preservesRevision
                && !string.Equals(operation.Operation, "create", StringComparison.Ordinal)
                && operation.BeforeRevisionId == operation.AfterRevisionId)
            {
                violations.Add($"mutable_transition_reused_revision:{operation.TransitionId}");
            }
            if (string.Equals(operation.Operation, "restore", StringComparison.Ordinal)
                && (operation.BeforeRevisionId == operation.AfterRevisionId
                    || operation.BeforePublicationId == operation.AfterPublicationId))
            {
                violations.Add($"restore_reused_historical_coordinate:{operation.TransitionId}");
            }
            if (string.Equals(operation.Operation, "rollback", StringComparison.Ordinal)
                && (operation.RollbackSourceRevisionId is null
                    || operation.RollbackSourceRevisionId == operation.AfterRevisionId
                    || operation.BeforeRevisionId == operation.AfterRevisionId))
            {
                violations.Add($"rollback_history_coordinate_invalid:{operation.TransitionId}");
            }
            bool publicationIsFresh = operation.AfterPublicationId is not null
                && (operation.BeforePublicationId != operation.AfterPublicationId
                    || operation.Operation is "create" or "restore" or "rollback" or "scheduled-publish");
            if (operation.AfterPublicationId is not null
                && !publications.Any(item => item.Id == operation.AfterPublicationId
                                          && item.PublicationNo == operation.AfterPublicationNo
                                          && item.ArticleId == receipt.ArticleId
                                          && (!publicationIsFresh || item.ArticleRevisionId == operation.AfterRevisionId)))
            {
                violations.Add($"operation_after_publication_unresolved:{operation.TransitionId}");
            }
            if (operation.BeforePublicationId is not null
                && operation.Operation is not ("create" or "restore" or "rollback")
                && !publications.Any(item => item.Id == operation.BeforePublicationId
                                          && item.PublicationNo == operation.BeforePublicationNo))
            {
                violations.Add($"operation_before_publication_unresolved:{operation.TransitionId}");
            }
            if (operation.ContentDigest.Contains("recompute", StringComparison.OrdinalIgnoreCase))
            {
                violations.Add($"operation_content_digest_sentinel:{operation.TransitionId}");
            }
            if (operation.TransitionedAtUtc.Kind == DateTimeKind.Local)
            {
                violations.Add($"operation_timestamp_not_utc:{operation.TransitionId}");
            }
            if (operation.ScheduledPublishAt is DateTime scheduledAt)
            {
                if (scheduledAt.Kind == DateTimeKind.Local)
                {
                    violations.Add($"operation_schedule_timestamp_not_utc:{operation.TransitionId}");
                }
                if (string.Equals(operation.Operation, "scheduled-update", StringComparison.Ordinal)
                    && scheduledAt <= operation.TransitionedAtUtc)
                {
                    violations.Add($"scheduled_update_not_future:{operation.TransitionId}");
                }
                if (string.Equals(operation.Operation, "scheduled-publish", StringComparison.Ordinal)
                    && operation.TransitionedAtUtc < scheduledAt)
                {
                    violations.Add($"scheduled_publish_before_due:{operation.TransitionId}");
                }
            }
            if (string.Equals(operation.Operation, "scheduled-update", StringComparison.Ordinal)
                && operation.BeforePublicationId.HasValue
                && operation.BeforePublicationId != operation.AfterPublicationId)
            {
                violations.Add($"scheduled_update_changed_publication_early:{operation.TransitionId}");
            }
            if (string.Equals(operation.Operation, "scheduled-publish", StringComparison.Ordinal)
                && operation.BeforePublicationId == operation.AfterPublicationId)
            {
                violations.Add($"scheduled_publish_reused_old_publication:{operation.TransitionId}");
            }
        }
    }

    private static void VerifyOutbox(
        CanonicalArticleLifecycleReceipt receipt,
        IReadOnlyList<ArticleMutationOutboxEvent> outboxEvents,
        List<string> violations)
    {
        foreach (CanonicalArticleLifecycleOperationReceipt operation in receipt.Operations ?? [])
        {
            ArticleMutationOutboxEvent? outbox = outboxEvents.FirstOrDefault(item =>
                string.Equals(item.EventId, operation.OutboxEventId, StringComparison.Ordinal));
            if (outbox is null)
            {
                continue;
            }
            if (outbox.ArticleRevisionId != operation.AfterRevisionId
                || outbox.RevisionNo != operation.AfterRevisionNo
                || outbox.RightsSnapshotId != operation.RightsSnapshotId
                || outbox.ResponsibilitySnapshotId != operation.ResponsibilitySnapshotId
                || outbox.ResponsibilityVersion != operation.ResponsibilityVersion
                || outbox.ArticlePublicationId != operation.AfterPublicationId
                || outbox.PublicationNo != operation.AfterPublicationNo)
            {
                violations.Add($"outbox_coordinate_mismatch:{operation.TransitionId}");
            }
            string payloadDigest = CanonicalArticleLifecycleFixturePort.ComputeOutboxPayloadDigest(outbox.PayloadJson);
            if (!string.Equals(payloadDigest, operation.OutboxPayloadDigest, StringComparison.Ordinal))
            {
                violations.Add($"outbox_payload_digest_mismatch:{operation.TransitionId}");
            }
            try
            {
                ArticleMutationOutboxEnvelope envelope = ArticleMutationOutboxEnvelopeCodec.Read(outbox);
                if (envelope.ArticleId != receipt.ArticleId
                    || envelope.Version.RevisionId != operation.AfterRevisionId
                    || envelope.Version.RevisionNo != operation.AfterRevisionNo
                    || envelope.Version.PublicationId != operation.AfterPublicationId
                    || envelope.Version.PublicationNo != operation.AfterPublicationNo
                    || envelope.Version.RightsSnapshotId != operation.RightsSnapshotId
                    || envelope.Version.ResponsibilitySnapshotId != operation.ResponsibilitySnapshotId)
                {
                    violations.Add($"outbox_envelope_coordinate_mismatch:{operation.TransitionId}");
                }
                if (envelope.OccurredAt.Kind == DateTimeKind.Local)
                {
                    violations.Add($"outbox_timestamp_not_utc:{operation.TransitionId}");
                }
                if (envelope.OccurredAt != operation.TransitionedAtUtc)
                {
                    violations.Add($"outbox_timestamp_mismatch:{operation.TransitionId}");
                }
            }
            catch (Exception exception) when (exception is InvalidOperationException or JsonException)
            {
                violations.Add($"outbox_envelope_invalid:{operation.TransitionId}");
            }
            try
            {
                using JsonDocument document = JsonDocument.Parse(outbox.PayloadJson);
                JsonElement root = document.RootElement;
                if (root.TryGetProperty("articleRevisionId", out JsonElement revision)
                    && revision.GetInt64() != operation.AfterRevisionId)
                {
                    violations.Add($"outbox_payload_revision_mismatch:{operation.TransitionId}");
                }
                if (root.TryGetProperty("releaseId", out JsonElement publication)
                    && publication.ValueKind != JsonValueKind.Null
                    && publication.GetInt64() != operation.AfterPublicationId)
                {
                    violations.Add($"outbox_payload_publication_mismatch:{operation.TransitionId}");
                }
            }
            catch (JsonException)
            {
                // The envelope check above records the invalid payload.
            }
        }
    }

    private static void VerifyAudit(
        CanonicalArticleLifecycleReceipt receipt,
        IReadOnlyList<AuditLog> auditLogs,
        IConfiguration configuration,
        List<string> violations)
    {
        byte[]? tamperKey = AuditTamperEvidence.ResolveKey(configuration);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (CanonicalArticleLifecycleOperationReceipt operation in receipt.Operations ?? [])
        {
            AuditLog? audit = auditLogs.FirstOrDefault(item =>
                string.Equals(item.ChainId, operation.AuditChainId, StringComparison.Ordinal)
                && string.Equals(item.RecordHash, operation.AuditRecordHash, StringComparison.Ordinal));
            if (audit is null)
            {
                violations.Add($"audit_missing:{operation.TransitionId}");
                continue;
            }
            if (!seen.Add($"{audit.ChainId}:{audit.RecordHash}"))
            {
                violations.Add($"audit_coordinate_reused:{operation.TransitionId}");
            }
            if (!string.Equals(audit.ActorId, receipt.AdminPrincipalId.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal)
                || !string.Equals(audit.Outcome, "success", StringComparison.OrdinalIgnoreCase)
                || !string.Equals(audit.TargetId, receipt.ArticleId.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal))
            {
                violations.Add($"audit_actor_or_target_mismatch:{operation.TransitionId}");
            }
            if (audit.OccurredAtUtc != operation.TransitionedAtUtc)
            {
                violations.Add($"audit_timestamp_mismatch:{operation.TransitionId}");
            }
            if (tamperKey is not null && !AuditTamperEvidence.Verify(audit, tamperKey))
            {
                violations.Add($"audit_tamper_evidence_invalid:{operation.TransitionId}");
            }
            if (string.IsNullOrWhiteSpace(audit.PrevHash) && audit.Id > 0)
            {
                // The first row in a chain is allowed to have no predecessor; later rows must
                // be linked.  The exact predecessor check is done against the ordered rows.
                AuditLog? predecessor = auditLogs
                    .Where(item => item.ChainId == audit.ChainId && item.Id < audit.Id)
                    .OrderByDescending(item => item.Id)
                    .FirstOrDefault();
                if (predecessor is not null)
                {
                    violations.Add($"audit_prev_hash_missing:{operation.TransitionId}");
                }
            }
        }
    }

    private static string ComputeDigest(string value)
        => "sha256:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    private static string ComputeRevisionTimelineDigest(
        IReadOnlyList<ArticleRevision> revisions,
        IReadOnlyList<ArticleRevisionContentBlock> contentBlocks)
    {
        Dictionary<long, ArticleRevisionContentBlock> blocks = contentBlocks
            .ToDictionary(item => item.Id);
        var rows = revisions
            .OrderBy(item => item.RevisionNo)
            .ThenBy(item => item.Id)
            .Select(item =>
            {
                blocks.TryGetValue(item.ContentBlockId, out ArticleRevisionContentBlock? block);
                return new
                {
                    item.Id,
                    item.ArticleId,
                    item.RevisionNo,
                    item.Title,
                    item.Summary,
                    item.CoverImageUrl,
                    item.CategoryId,
                    item.TagIds,
                    item.ContentBlockId,
                    item.MarkdownContent,
                    item.DiffSummary,
                    item.CreatedByAdminPrincipalId,
                    item.RollbackSourceRevisionId,
                    item.RollbackReason,
                    item.CreatedAt,
                    ContentHash = block?.ContentHash,
                    Content = block?.MarkdownContent
                };
            })
            .ToArray();
        return ComputeDigest(JsonSerializer.Serialize(rows));
    }
}
