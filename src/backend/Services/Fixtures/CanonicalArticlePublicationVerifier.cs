using System.Data.Common;
using System.Globalization;
using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Services;

using SqlSugar;

namespace FsusBlog.Server.Services.Fixtures;

public sealed record CanonicalArticlePublicationVerificationResult(
    bool IsValid,
    IReadOnlyList<string> Violations)
{
    public void ThrowIfInvalid()
    {
        if (!IsValid)
        {
            throw new InvalidOperationException(
                $"canonical_publication_verification_failed: {string.Join("; ", Violations)}");
        }
    }
}

public static class CanonicalArticlePublicationVerifier
{
    private static readonly JsonSerializerOptions s_jsonOptions = new(JsonSerializerDefaults.Web);

    public static async Task<CanonicalArticlePublicationVerificationResult> VerifyAsync(
        ISqlSugarClient db,
        CanonicalArticlePublicationReceipt receipt,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(db);
        ArgumentNullException.ThrowIfNull(receipt);

        var violations = new List<string>();

        // 1. Validate receipt digest and schema
        if (!string.Equals(receipt.Schema, CanonicalArticlePublicationFixturePort.Schema, StringComparison.Ordinal))
        {
            violations.Add($"receipt_schema_mismatch: expected '{CanonicalArticlePublicationFixturePort.Schema}', got '{receipt.Schema}'");
        }

        string expectedReceiptDigest = CanonicalArticlePublicationFixturePort.ComputeReceiptDigest(
            receipt.WriterContractDigest,
            receipt.ArticleId,
            receipt.RevisionId,
            receipt.PublicationId,
            receipt.RightsSnapshotId,
            receipt.ContentCanonicalHash,
            receipt.PolicyHash,
            receipt.ResponsibilitySnapshotId,
            receipt.OutboxEventId,
            receipt.OutboxPayloadDigest,
            receipt.AuditChainId,
            receipt.AuditRecordHash,
            receipt.ContentDigest);

        if (!string.Equals(expectedReceiptDigest, receipt.ReceiptDigest, StringComparison.Ordinal))
        {
            violations.Add("receipt_digest_tamper_detected");
        }

        if (receipt.AdminPrincipalId <= 0)
        {
            violations.Add("admin_principal_id_invalid");
        }

        // 2. Query Article from DB
        Article? article = await db.Queryable<Article>()
            .Where(a => a.Id == receipt.ArticleId)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);

        if (article is null)
        {
            violations.Add($"article_missing:{receipt.ArticleId}");
        }
        else
        {
            if (article.IsDeleted)
            {
                violations.Add("article_is_deleted");
            }
            if (article.Status != ArticleStatus.Published)
            {
                violations.Add($"article_status_not_published:{(int)article.Status}");
            }
            if (article.CurrentRevisionId != receipt.RevisionId)
            {
                violations.Add($"pointer_current_revision_mismatch: expected {receipt.RevisionId}, got {article.CurrentRevisionId}");
            }
            if (article.CurrentPublicationId != receipt.PublicationId)
            {
                violations.Add($"pointer_current_publication_mismatch: expected {receipt.PublicationId}, got {article.CurrentPublicationId}");
            }
            if (!article.PublishedAt.HasValue)
            {
                violations.Add("article_published_at_null");
            }
        }

        // 3. Query ArticleRevision from DB
        ArticleRevision? revision = await db.Queryable<ArticleRevision>()
            .Where(r => r.Id == receipt.RevisionId)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);

        if (revision is null)
        {
            violations.Add($"revision_missing:{receipt.RevisionId}");
        }
        else
        {
            if (revision.ArticleId != receipt.ArticleId)
            {
                violations.Add($"revision_article_id_mismatch: expected {receipt.ArticleId}, got {revision.ArticleId}");
            }
            if (revision.RevisionNo != receipt.RevisionNo)
            {
                violations.Add($"revision_no_mismatch: expected {receipt.RevisionNo}, got {revision.RevisionNo}");
            }
            if (revision.CreatedByAdminPrincipalId != receipt.AdminPrincipalId)
            {
                violations.Add($"revision_admin_principal_mismatch: expected {receipt.AdminPrincipalId}, got {revision.CreatedByAdminPrincipalId}");
            }
            if (revision.CreatedByAdminPrincipalId <= 0)
            {
                violations.Add("revision_admin_principal_zero_or_negative");
            }
        }

        // 4. Query ArticlePublication from DB
        ArticlePublicationRecord? publication = await db.Queryable<ArticlePublicationRecord>()
            .Where(p => p.Id == receipt.PublicationId)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);

        if (publication is null)
        {
            violations.Add($"publication_missing:{receipt.PublicationId}");
        }
        else
        {
            if (publication.ArticleId != receipt.ArticleId)
            {
                violations.Add($"publication_article_id_mismatch: expected {receipt.ArticleId}, got {publication.ArticleId}");
            }
            if (publication.PublicationNo != receipt.PublicationNo)
            {
                violations.Add($"publication_no_mismatch: expected {receipt.PublicationNo}, got {publication.PublicationNo}");
            }
            if (publication.ArticleRevisionId != receipt.RevisionId)
            {
                violations.Add($"publication_revision_id_mismatch: expected {receipt.RevisionId}, got {publication.ArticleRevisionId}");
            }
            if (publication.RightsSnapshotId != receipt.RightsSnapshotId)
            {
                violations.Add($"publication_rights_snapshot_id_mismatch: expected {receipt.RightsSnapshotId}, got {publication.RightsSnapshotId}");
            }
            if (publication.ResponsibilitySnapshotId != receipt.ResponsibilitySnapshotId)
            {
                violations.Add($"publication_responsibility_snapshot_id_mismatch: expected {receipt.ResponsibilitySnapshotId}, got {publication.ResponsibilitySnapshotId}");
            }
        }

        // 5. Query ArticleRightsSnapshot from DB
        ArticleRightsSnapshot? rights = await db.Queryable<ArticleRightsSnapshot>()
            .Where(r => r.Id == receipt.RightsSnapshotId)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);

        if (rights is null)
        {
            violations.Add($"rights_snapshot_missing:{receipt.RightsSnapshotId}");
        }
        else
        {
            if (rights.ArticleId != receipt.ArticleId)
            {
                violations.Add($"rights_article_id_mismatch: expected {receipt.ArticleId}, got {rights.ArticleId}");
            }
            if (rights.ArticleRevisionId != receipt.RevisionId)
            {
                violations.Add($"rights_revision_id_mismatch: expected {receipt.RevisionId}, got {rights.ArticleRevisionId}");
            }
            if (!string.Equals(rights.ContentCanonicalHash, receipt.ContentCanonicalHash, StringComparison.Ordinal))
            {
                violations.Add($"rights_content_canonical_hash_mismatch: expected {receipt.ContentCanonicalHash}, got {rights.ContentCanonicalHash}");
            }
            if (!string.Equals(rights.PolicyHash, receipt.PolicyHash, StringComparison.Ordinal))
            {
                violations.Add($"rights_policy_hash_mismatch: expected {receipt.PolicyHash}, got {rights.PolicyHash}");
            }
            if (rights.ContentCanonicalHash.Contains("recompute", StringComparison.OrdinalIgnoreCase)
                || rights.PolicyHash.Contains("recompute", StringComparison.OrdinalIgnoreCase))
            {
                violations.Add("rights_sentinel_detected");
            }
        }

        // 6. Query ArticleResponsibilitySnapshot from DB
        ArticleResponsibilitySnapshot? resp = await db.Queryable<ArticleResponsibilitySnapshot>()
            .Where(r => r.Id == receipt.ResponsibilitySnapshotId)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);

        if (resp is null)
        {
            violations.Add($"responsibility_snapshot_missing:{receipt.ResponsibilitySnapshotId}");
        }
        else
        {
            if (resp.ArticleId != receipt.ArticleId)
            {
                violations.Add($"responsibility_article_id_mismatch: expected {receipt.ArticleId}, got {resp.ArticleId}");
            }
            if (resp.ArticleRevisionId != receipt.RevisionId)
            {
                violations.Add($"responsibility_revision_id_mismatch: expected {receipt.RevisionId}, got {resp.ArticleRevisionId}");
            }
            if (resp.ResponsibilityVersion != receipt.ResponsibilityVersion)
            {
                violations.Add($"responsibility_version_mismatch: expected {receipt.ResponsibilityVersion}, got {resp.ResponsibilityVersion}");
            }
        }

        // 7. Query Outbox Event from DB
        ArticleMutationOutboxEvent? outbox = await db.Queryable<ArticleMutationOutboxEvent>()
            .Where(o => o.EventId == receipt.OutboxEventId)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);

        if (outbox is null)
        {
            violations.Add($"outbox_missing:{receipt.OutboxEventId}");
        }
        else
        {
            if (outbox.AggregateId != receipt.ArticleId)
            {
                violations.Add($"outbox_aggregate_id_mismatch: expected {receipt.ArticleId}, got {outbox.AggregateId}");
            }
            if (outbox.ArticleRevisionId != receipt.RevisionId)
            {
                violations.Add($"outbox_revision_id_mismatch: expected {receipt.RevisionId}, got {outbox.ArticleRevisionId}");
            }
            if (outbox.ArticlePublicationId != receipt.PublicationId)
            {
                violations.Add($"outbox_publication_id_mismatch: expected {receipt.PublicationId}, got {outbox.ArticlePublicationId}");
            }
            if (outbox.RightsSnapshotId != receipt.RightsSnapshotId)
            {
                violations.Add($"outbox_rights_snapshot_id_mismatch: expected {receipt.RightsSnapshotId}, got {outbox.RightsSnapshotId}");
            }
            if (outbox.ResponsibilitySnapshotId != receipt.ResponsibilitySnapshotId)
            {
                violations.Add($"outbox_responsibility_snapshot_id_mismatch: expected {receipt.ResponsibilitySnapshotId}, got {outbox.ResponsibilitySnapshotId}");
            }

            string actualPayloadDigest = CanonicalArticlePublicationFixturePort.ComputeOutboxPayloadDigest(outbox.PayloadJson);
            if (!string.Equals(actualPayloadDigest, receipt.OutboxPayloadDigest, StringComparison.Ordinal))
            {
                violations.Add($"outbox_payload_digest_mismatch: expected {receipt.OutboxPayloadDigest}, got {actualPayloadDigest}");
            }

            // Verify payload JSON sealed coordinates
            try
            {
                using var payloadDoc = JsonDocument.Parse(outbox.PayloadJson);
                var root = payloadDoc.RootElement;
                if (root.TryGetProperty("articleRevisionId", out var pRevId) && pRevId.GetInt64() != receipt.RevisionId)
                {
                    violations.Add($"outbox_payload_revision_id_drift: expected {receipt.RevisionId}, got {pRevId.GetInt64()}");
                }
                if (root.TryGetProperty("releaseId", out var pPubId) && pPubId.GetInt64() != receipt.PublicationId)
                {
                    violations.Add($"outbox_payload_release_id_drift: expected {receipt.PublicationId}, got {pPubId.GetInt64()}");
                }
                if (root.TryGetProperty("rightsSnapshotId", out var pRightsId) && pRightsId.GetInt64() != receipt.RightsSnapshotId)
                {
                    violations.Add($"outbox_payload_rights_snapshot_id_drift: expected {receipt.RightsSnapshotId}, got {pRightsId.GetInt64()}");
                }
                if (root.TryGetProperty("responsibilitySnapshotId", out var pRespId) && pRespId.GetInt64() != receipt.ResponsibilitySnapshotId)
                {
                    violations.Add($"outbox_payload_responsibility_snapshot_id_drift: expected {receipt.ResponsibilitySnapshotId}, got {pRespId.GetInt64()}");
                }
            }
            catch (JsonException ex)
            {
                violations.Add($"outbox_payload_json_invalid: {ex.Message}");
            }
        }

        // 8. Query Audit Log from DB
        using (System.Data.IDataReader? reader = await db.Ado.GetDataReaderAsync(
            """
            SELECT chain_id, record_hash, outcome, actor_id
            FROM sys_audit_log
            WHERE target_type = 'article-canonical-publication'
              AND target_id = @TargetId
            ORDER BY id DESC
            LIMIT 1;
            """,
            new SugarParameter("@TargetId", receipt.ArticleId.ToString(CultureInfo.InvariantCulture)))
            .ConfigureAwait(false))
        {
            if (reader is null || !reader.Read())
            {
                violations.Add($"audit_log_missing:{receipt.ArticleId}");
            }
            else
            {
                string chainId = reader.GetString(0);
                string recordHash = reader.GetString(1);
                string outcome = reader.GetString(2);
                string actorId = reader.GetString(3);

                if (!string.Equals(chainId, receipt.AuditChainId, StringComparison.Ordinal))
                {
                    violations.Add($"audit_chain_id_mismatch: expected {receipt.AuditChainId}, got {chainId}");
                }
                if (!string.Equals(recordHash, receipt.AuditRecordHash, StringComparison.Ordinal))
                {
                    violations.Add($"audit_record_hash_mismatch: expected {receipt.AuditRecordHash}, got {recordHash}");
                }
                if (!string.Equals(outcome, "success", StringComparison.OrdinalIgnoreCase))
                {
                    violations.Add($"audit_outcome_not_success:{outcome}");
                }
                if (!string.Equals(actorId, receipt.AdminPrincipalId.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal))
                {
                    violations.Add($"audit_actor_id_mismatch: expected {receipt.AdminPrincipalId}, got {actorId}");
                }
            }
        }

        // 9. Verify Content Digest
        ArticleBody? body = await db.Queryable<ArticleBody>()
            .Where(b => b.ArticleId == receipt.ArticleId)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);

        if (body is null)
        {
            violations.Add($"article_body_missing:{receipt.ArticleId}");
        }
        else
        {
            string actualContentDigest = CanonicalArticlePublicationFixturePort.ComputeContentDigest(body.MarkdownContent);
            if (!string.Equals(actualContentDigest, receipt.ContentDigest, StringComparison.Ordinal))
            {
                violations.Add($"content_digest_mismatch: expected {receipt.ContentDigest}, got {actualContentDigest}");
            }
        }

        // 10. Required edges check
        var expectedEdges = ArticleMutationReplayEdges.Required.Order(StringComparer.Ordinal).ToArray();
        if (!expectedEdges.SequenceEqual(receipt.RequiredEdges, StringComparer.Ordinal))
        {
            violations.Add("required_edges_mismatch");
        }

        return new CanonicalArticlePublicationVerificationResult(
            violations.Count == 0,
            violations.AsReadOnly());
    }
}
