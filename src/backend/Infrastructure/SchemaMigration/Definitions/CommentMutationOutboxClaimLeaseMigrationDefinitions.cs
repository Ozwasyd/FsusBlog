namespace FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;

internal static class CommentMutationOutboxClaimLeaseMigrationDefinitions
{
    internal const string MigrationId = "20260726-post-comment-mutation-outbox-claim-lease";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Add token-bound owner, generation and heartbeat fields to comment mutation outbox claims.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("comment_mutation_outbox", "claimed_by", "varchar(128) NULL"),
                new EnsureColumnStep("comment_mutation_outbox", "lease_generation", "bigint NOT NULL DEFAULT 0"),
                new EnsureColumnStep("comment_mutation_outbox", "last_heartbeat_at", "timestamp NULL"),
                new CreateIndexStep(
                    "idx_comment_mutation_outbox_processing_lease",
                    "CREATE INDEX IF NOT EXISTS idx_comment_mutation_outbox_processing_lease ON comment_mutation_outbox(status, lease_expires_at, id);")
            ]);
}
