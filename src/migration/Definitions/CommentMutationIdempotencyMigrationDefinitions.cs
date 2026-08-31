namespace FsusBlog.Migration.Definitions;

internal static class CommentMutationIdempotencyMigrationDefinitions
{
    internal const string MigrationId = "20260720-post-comment-mutation-idempotency";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Add account and anonymous-ticket scoped comment mutation identities.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("comment", "client_mutation_account_id", "integer NULL"),
                new EnsureColumnStep("comment", "client_mutation_id", "varchar(36) NULL"),
                new EnsureColumnStep("comment", "anonymous_ticket_hash", "varchar(64) NULL"),
                new EnsureColumnStep("comment", "mutation_request_hash", "varchar(64) NULL"),
                new EnsureColumnStep("comment", "mutation_expires_at_utc", "timestamp without time zone NULL"),
                new CreateIndexStep(
                    "ux_comment_client_mutation",
                    "CREATE UNIQUE INDEX IF NOT EXISTS ux_comment_client_mutation ON comment(client_mutation_account_id, client_mutation_id) WHERE client_mutation_account_id IS NOT NULL AND client_mutation_id IS NOT NULL;"),
                new CreateIndexStep(
                    "ux_comment_anonymous_ticket",
                    "CREATE UNIQUE INDEX IF NOT EXISTS ux_comment_anonymous_ticket ON comment(anonymous_ticket_hash) WHERE anonymous_ticket_hash IS NOT NULL;")
            ]);
}
