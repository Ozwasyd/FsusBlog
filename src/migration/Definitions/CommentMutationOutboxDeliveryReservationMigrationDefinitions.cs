namespace FsusBlog.Migration.Definitions;

internal static class CommentMutationOutboxDeliveryReservationMigrationDefinitions
{
    internal const string MigrationId = "20260727-post-comment-mutation-outbox-delivery-reservation";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Fence comment outbox consumer delivery with atomically reserved owner-bound leases.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("comment_mutation_outbox_delivery", "owner_claim_token", "varchar(64) NULL"),
                new EnsureColumnStep("comment_mutation_outbox_delivery", "owner_worker_id", "varchar(128) NULL"),
                new EnsureColumnStep("comment_mutation_outbox_delivery", "lease_generation", "bigint NOT NULL DEFAULT 0"),
                new EnsureColumnStep("comment_mutation_outbox_delivery", "started_at", "timestamp NULL"),
                new EnsureColumnStep("comment_mutation_outbox_delivery", "lease_expires_at", "timestamp NULL"),
                new EnsureColumnStep("comment_mutation_outbox_delivery", "completed_at", "timestamp NULL"),
                new EnsureColumnStep("comment_mutation_outbox_delivery", "result_digest", "varchar(64) NULL"),
                new EnsureColumnStep("comment_mutation_outbox_delivery", "last_failure_kind", "varchar(64) NULL"),
                new RawSqlStep(
                    """
                    UPDATE comment_mutation_outbox_delivery
                    SET status = CASE
                        WHEN status = 'completed' AND result_digest IS NULL THEN 'retryable-failed'
                        WHEN status = 'failed' THEN 'retryable-failed'
                        ELSE status
                    END;
                    ALTER TABLE comment_mutation_outbox_delivery DROP CONSTRAINT IF EXISTS ck_comment_outbox_delivery_status;
                    ALTER TABLE comment_mutation_outbox_delivery ADD CONSTRAINT ck_comment_outbox_delivery_status
                        CHECK (status IN ('pending','processing','completed','retryable-failed','terminal-failed'));
                    """),
                new CreateIndexStep(
                    "idx_comment_outbox_delivery_reservation",
                    "CREATE INDEX IF NOT EXISTS idx_comment_outbox_delivery_reservation ON comment_mutation_outbox_delivery(status, lease_expires_at, outbox_event_id);")
            ]);
}
