namespace FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;

internal static class MessageUnreadAuthorityMigrationDefinitions
{
    internal const string MigrationId = "20260719-post-message-unread-authority";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Constrain message read cursors and make unread counters repairable projections.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new BackfillSqlStep(
                    """
                    UPDATE msg_participant_state state
                    SET lastreadmessageid = NULL,
                        lastreadat = NULL
                    WHERE state.lastreadmessageid IS NOT NULL
                      AND NOT EXISTS (
                          SELECT 1
                          FROM msg_message message
                          WHERE message.conversationid = state.conversationid
                            AND message.id = state.lastreadmessageid
                            AND message.isinternalnote = false
                      );

                    UPDATE msg_participant_state state
                    SET unreadcount = (
                            SELECT COUNT(*)::integer
                            FROM msg_message message
                            WHERE message.conversationid = state.conversationid
                              AND message.id > COALESCE(state.lastreadmessageid, 0)
                              AND message.isinternalnote = false
                              AND NOT (
                                  message.sendertype = 0
                                  AND message.senderaccountid = state.accountid
                              )
                        ),
                        updatedat = now() AT TIME ZONE 'utc';

                    UPDATE msg_admin_queue_state state
                    SET lastreadmessageid = NULL,
                        lastreadat = NULL
                    WHERE state.lastreadmessageid IS NOT NULL
                      AND NOT EXISTS (
                          SELECT 1
                          FROM msg_message message
                          WHERE message.conversationid = state.conversationid
                            AND message.id = state.lastreadmessageid
                            AND message.isinternalnote = false
                      );

                    UPDATE msg_admin_queue_state state
                    SET unreadcount = (
                            SELECT COUNT(*)::integer
                            FROM msg_message message
                            WHERE message.conversationid = state.conversationid
                              AND message.id > COALESCE(state.lastreadmessageid, 0)
                              AND message.sendertype = 0
                              AND message.isinternalnote = false
                        ),
                        version = GREATEST(state.version, 1),
                        updatedat = now() AT TIME ZONE 'utc';
                    """),
                new RawSqlStep(
                    """
                    DO $$
                    BEGIN
                        IF NOT EXISTS (
                            SELECT 1
                            FROM pg_constraint
                            WHERE conrelid = 'msg_participant_state'::regclass
                              AND conname = 'ck_msg_participant_unread_nonnegative'
                        ) THEN
                            ALTER TABLE msg_participant_state
                            ADD CONSTRAINT ck_msg_participant_unread_nonnegative CHECK (unreadcount >= 0);
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
                    END;
                    $$;

                    CREATE OR REPLACE FUNCTION fsus_validate_message_read_projection()
                    RETURNS trigger
                    LANGUAGE plpgsql
                    AS $$
                    BEGIN
                        IF NEW.unreadcount < 0 THEN
                            RAISE EXCEPTION 'message unread projection cannot be negative'
                                USING ERRCODE = 'check_violation';
                        END IF;

                        IF TG_OP = 'UPDATE'
                           AND OLD.lastreadmessageid IS NOT NULL
                           AND (NEW.lastreadmessageid IS NULL OR NEW.lastreadmessageid < OLD.lastreadmessageid)
                           AND COALESCE(current_setting('fsus.message_unread_repair', true), '') <> 'on' THEN
                            RAISE EXCEPTION 'message read cursor cannot move backwards'
                                USING ERRCODE = 'check_violation';
                        END IF;

                        IF NEW.lastreadmessageid IS NOT NULL
                           AND NOT EXISTS (
                               SELECT 1
                               FROM msg_message message
                               WHERE message.conversationid = NEW.conversationid
                                 AND message.id = NEW.lastreadmessageid
                                 AND message.isinternalnote = false
                           ) THEN
                            RAISE EXCEPTION 'message read cursor must reference a visible message in the same conversation'
                                USING ERRCODE = 'foreign_key_violation';
                        END IF;

                        RETURN NEW;
                    END;
                    $$;

                    DROP TRIGGER IF EXISTS trg_msg_participant_read_projection ON msg_participant_state;
                    CREATE TRIGGER trg_msg_participant_read_projection
                    BEFORE INSERT OR UPDATE OF lastreadmessageid, unreadcount ON msg_participant_state
                    FOR EACH ROW EXECUTE FUNCTION fsus_validate_message_read_projection();

                    DROP TRIGGER IF EXISTS trg_msg_admin_queue_read_projection ON msg_admin_queue_state;
                    CREATE TRIGGER trg_msg_admin_queue_read_projection
                    BEFORE INSERT OR UPDATE OF lastreadmessageid, unreadcount ON msg_admin_queue_state
                    FOR EACH ROW EXECUTE FUNCTION fsus_validate_message_read_projection();
                    """)
            ]);
}
