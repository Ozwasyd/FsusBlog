namespace FsusBlog.Migration.Definitions;

internal static class MessageAdminQueueMigrationDefinitions
{
    internal static ISchemaMigrationDescriptor BuildAdminQueueStateMigration()
        => new SchemaMigrationDescriptor(
            "20260719-post-message-admin-queue-state",
            "Create the shared administrator message queue read and unread projection.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "msg_admin_queue_state",
                    """
                    CREATE TABLE IF NOT EXISTS msg_admin_queue_state (
                        conversationid bigint PRIMARY KEY,
                        lastreadmessageid bigint NULL,
                        unreadcount integer NOT NULL DEFAULT 0,
                        lastreadat timestamp NULL,
                        version bigint NOT NULL DEFAULT 1,
                        updatedat timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
                        CONSTRAINT fk_msg_admin_queue_conversation
                            FOREIGN KEY (conversationid) REFERENCES msg_conversation(id) ON DELETE CASCADE,
                        CONSTRAINT ck_msg_admin_queue_unread_nonnegative CHECK (unreadcount >= 0),
                        CONSTRAINT ck_msg_admin_queue_version_positive CHECK (version > 0)
                    );
                    """),
                new RawSqlStep(
                    """
                    DO $$
                    BEGIN
                        IF NOT EXISTS (
                            SELECT 1
                            FROM pg_constraint
                            WHERE conrelid = 'msg_admin_queue_state'::regclass
                              AND conname = 'fk_msg_admin_queue_conversation'
                        ) THEN
                            ALTER TABLE msg_admin_queue_state
                            ADD CONSTRAINT fk_msg_admin_queue_conversation
                            FOREIGN KEY (conversationid) REFERENCES msg_conversation(id) ON DELETE CASCADE;
                        END IF;
                        IF NOT EXISTS (
                            SELECT 1
                            FROM pg_constraint
                            WHERE conrelid = 'msg_admin_queue_state'::regclass
                              AND conname = 'ck_msg_admin_queue_unread_nonnegative'
                        ) THEN
                            ALTER TABLE msg_admin_queue_state
                            ADD CONSTRAINT ck_msg_admin_queue_unread_nonnegative CHECK (unreadcount >= 0);
                        END IF;
                        IF NOT EXISTS (
                            SELECT 1
                            FROM pg_constraint
                            WHERE conrelid = 'msg_admin_queue_state'::regclass
                              AND conname = 'ck_msg_admin_queue_version_positive'
                        ) THEN
                            ALTER TABLE msg_admin_queue_state
                            ADD CONSTRAINT ck_msg_admin_queue_version_positive CHECK (version > 0);
                        END IF;
                    END;
                    $$;
                    """),
                new CreateIndexStep(
                    "idx_msg_admin_queue_unread_updated",
                    "CREATE INDEX IF NOT EXISTS idx_msg_admin_queue_unread_updated ON msg_admin_queue_state(unreadcount DESC, updatedat DESC);"),
                new BackfillSqlStep(
                    """
                    INSERT INTO msg_admin_queue_state(
                        conversationid,
                        lastreadmessageid,
                        unreadcount,
                        lastreadat,
                        version,
                        updatedat)
                    SELECT conversation.id,
                           NULL,
                           COUNT(message.id) FILTER (
                               WHERE message.sendertype = 0
                                 AND message.isinternalnote = false)::integer,
                           NULL,
                           1,
                           now() AT TIME ZONE 'utc'
                    FROM msg_conversation conversation
                    LEFT JOIN msg_message message
                      ON message.conversationid = conversation.id
                    GROUP BY conversation.id
                    ON CONFLICT (conversationid) DO NOTHING;
                    """)
            ]);
}
