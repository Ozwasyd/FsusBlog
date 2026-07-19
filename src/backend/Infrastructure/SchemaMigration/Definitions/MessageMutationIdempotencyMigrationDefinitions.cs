namespace FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;

internal static class MessageMutationIdempotencyMigrationDefinitions
{
    internal const string MigrationId = "20260719-post-message-mutation-idempotency";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Add subject-scoped mutation identities and a unique system source coordinate.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("msg_conversation", "clientmutationprincipalkind", "varchar(16) NULL"),
                new EnsureColumnStep("msg_conversation", "clientmutationprincipalid", "bigint NULL"),
                new EnsureColumnStep("msg_conversation", "clientmutationid", "varchar(64) NULL"),
                new EnsureColumnStep("msg_conversation", "mutationrequesthash", "varchar(64) NULL"),
                new EnsureColumnStep("msg_message", "clientmutationprincipalkind", "varchar(16) NULL"),
                new EnsureColumnStep("msg_message", "clientmutationprincipalid", "bigint NULL"),
                new EnsureColumnStep("msg_message", "clientmutationid", "varchar(64) NULL"),
                new EnsureColumnStep("msg_message", "mutationrequesthash", "varchar(64) NULL"),
                new CreateIndexStep(
                    "ux_msg_conversation_client_mutation",
                    "CREATE UNIQUE INDEX IF NOT EXISTS ux_msg_conversation_client_mutation ON msg_conversation(clientmutationprincipalkind, clientmutationprincipalid, clientmutationid) WHERE clientmutationid IS NOT NULL;"),
                new CreateIndexStep(
                    "ux_msg_message_client_mutation",
                    "CREATE UNIQUE INDEX IF NOT EXISTS ux_msg_message_client_mutation ON msg_message(clientmutationprincipalkind, clientmutationprincipalid, clientmutationid) WHERE clientmutationid IS NOT NULL;"),
                new CreateIndexStep(
                    "ux_msg_conversation_source_message",
                    "CREATE UNIQUE INDEX IF NOT EXISTS ux_msg_conversation_source_message ON msg_conversation(sourcemessageid) WHERE sourcemessageid IS NOT NULL;")
            ]);
}
