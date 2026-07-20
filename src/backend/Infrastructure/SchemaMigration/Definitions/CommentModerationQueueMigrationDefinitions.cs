namespace FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;

internal static class CommentModerationQueueMigrationDefinitions
{
    internal const string MigrationId = "20260720-post-comment-moderation-queue-lease";

    internal const string RollbackSql = """
        DROP INDEX CONCURRENTLY IF EXISTS idx_comment_moderation_queue_pending;
        DROP INDEX CONCURRENTLY IF EXISTS idx_comment_author_appeal_pending_queue;
        DROP INDEX CONCURRENTLY IF EXISTS idx_comment_moderation_claim_owner;
        DROP INDEX CONCURRENTLY IF EXISTS idx_comment_moderation_claim_lease;
        -- Keep comment_moderation_queue_claim during the N-1 compatibility window.
        -- It may be dropped only after the old release can no longer be restored.
        """;

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Add the moderation claim lease authority and the evidence-backed pending queue index.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: false,
            Steps:
            [
                new EnsureTableStep("comment_moderation_queue_claim", """
                    CREATE TABLE IF NOT EXISTS comment_moderation_queue_claim (
                        comment_id bigint PRIMARY KEY REFERENCES comment(id) ON DELETE CASCADE,
                        owner_admin_principal_id bigint NOT NULL,
                        claim_token_hash varchar(64) NOT NULL,
                        state varchar(16) NOT NULL,
                        claimed_at_utc timestamp without time zone NOT NULL,
                        lease_expires_at_utc timestamp without time zone NOT NULL,
                        renewed_at_utc timestamp without time zone NULL,
                        released_at_utc timestamp without time zone NULL,
                        process_sla_due_at_utc timestamp without time zone NOT NULL,
                        note varchar(1000) NULL,
                        escalation_status varchar(24) NOT NULL,
                        claim_generation integer NOT NULL,
                        CONSTRAINT ck_comment_moderation_claim_state
                            CHECK (state IN ('active','released','completed','expired')),
                        CONSTRAINT ck_comment_moderation_claim_escalation
                            CHECK (escalation_status IN ('none','watch','escalated')),
                        CONSTRAINT ck_comment_moderation_claim_generation CHECK (claim_generation > 0),
                        CONSTRAINT ck_comment_moderation_claim_token_hash
                            CHECK (claim_token_hash ~ '^[0-9a-f]{64}$')
                    );
                    """),
                new RawSqlStep("""
                    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_comment_moderation_claim_lease
                    ON comment_moderation_queue_claim(state, lease_expires_at_utc, comment_id);
                    """),
                new RawSqlStep("""
                    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_comment_moderation_claim_owner
                    ON comment_moderation_queue_claim(owner_admin_principal_id, state, lease_expires_at_utc);
                    """),
                new RawSqlStep("""
                    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_comment_moderation_queue_pending
                    ON comment(create_time, id)
                    WHERE is_deleted = false
                      AND (moderation_status = 0
                           OR moderation_reason = 'model_policy:model_risk_borderline_review');
                    """),
                new RawSqlStep("""
                    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_comment_author_appeal_pending_queue
                    ON comment_author_appeal(status, created_at_utc, comment_id)
                    WHERE status = 'pending';
                    """)
            ]);
}
