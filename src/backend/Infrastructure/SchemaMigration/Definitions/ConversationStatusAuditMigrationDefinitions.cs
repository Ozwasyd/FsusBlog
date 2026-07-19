namespace FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;

internal static class ConversationStatusAuditMigrationDefinitions
{
    internal const string MigrationId = "20260719-post-message-status-audit";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Persist append-only conversation status transitions with admin audit context.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "msg_conversation_status_event",
                    """
                    CREATE TABLE IF NOT EXISTS msg_conversation_status_event (
                        id bigint PRIMARY KEY,
                        conversationid bigint NOT NULL,
                        previousstatus integer NOT NULL,
                        currentstatus integer NOT NULL,
                        adminprincipalid bigint NOT NULL,
                        adminsessionauditreference varchar(64) NOT NULL,
                        reason varchar(256) NOT NULL,
                        createdat timestamp NOT NULL,
                        CONSTRAINT fk_msg_conversation_status_event_conversation
                            FOREIGN KEY (conversationid) REFERENCES msg_conversation(id) ON DELETE RESTRICT,
                        CONSTRAINT ck_msg_conversation_status_event_statuses
                            CHECK (previousstatus BETWEEN 0 AND 2 AND currentstatus BETWEEN 0 AND 2),
                        CONSTRAINT ck_msg_conversation_status_event_changed
                            CHECK (previousstatus <> currentstatus),
                        CONSTRAINT ck_msg_conversation_status_event_reason
                            CHECK (length(btrim(reason)) BETWEEN 1 AND 256)
                    );
                    """),
                new CreateIndexStep(
                    "idx_msg_conversation_status_event_conversation_time",
                    "CREATE INDEX IF NOT EXISTS idx_msg_conversation_status_event_conversation_time ON msg_conversation_status_event(conversationid, createdat, id);"),
                new EnsureColumnStep("message_mutation_outbox", "conversationstatus", "integer NULL"),
                new RawSqlStep(
                    """
                    CREATE OR REPLACE FUNCTION fsus_reject_conversation_status_event_mutation()
                    RETURNS trigger
                    LANGUAGE plpgsql
                    AS $$
                    BEGIN
                        RAISE EXCEPTION 'msg_conversation_status_event is append-only';
                    END;
                    $$;

                    DROP TRIGGER IF EXISTS trg_msg_conversation_status_event_append_only ON msg_conversation_status_event;
                    CREATE TRIGGER trg_msg_conversation_status_event_append_only
                    BEFORE UPDATE OR DELETE ON msg_conversation_status_event
                    FOR EACH ROW EXECUTE FUNCTION fsus_reject_conversation_status_event_mutation();
                    """)
            ]);
}
