namespace FsusBlog.Migration.Definitions;

internal static class MessagePrivacyRetentionMigrationDefinitions
{
    internal const string MigrationId = "20260719-post-message-unread-privacy-retention";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Replace raw admin message session IDs with audit references and add content-retention state.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("msg_conversation", "createdbyadminsessionauditreference", "varchar(64) NULL"),
                new EnsureColumnStep("msg_conversation", "contentredactedat", "timestamp NULL"),
                new EnsureColumnStep("msg_conversation", "contentredactionreason", "varchar(32) NULL"),
                new EnsureColumnStep("msg_message", "senderadminsessionauditreference", "varchar(64) NULL"),
                new EnsureColumnStep("msg_message", "contentredactedat", "timestamp NULL"),
                new EnsureColumnStep("msg_message", "contentredactionreason", "varchar(32) NULL"),
                new RawSqlStep(
                    """
                    UPDATE msg_conversation
                    SET createdbyadminsessionauditreference =
                            COALESCE(
                                createdbyadminsessionauditreference,
                                'legacy-conversation-' || replace(gen_random_uuid()::text, '-', '')),
                        createdbyadminsessionid = NULL
                    WHERE createdbyadminsessionid IS NOT NULL
                       OR (createdbyadminprincipalid IS NOT NULL
                           AND createdbyadminsessionauditreference IS NULL);

                    UPDATE msg_message
                    SET senderadminsessionauditreference =
                            COALESCE(
                                senderadminsessionauditreference,
                                'legacy-message-' || replace(gen_random_uuid()::text, '-', '')),
                        senderadminsessionid = NULL
                    WHERE senderadminsessionid IS NOT NULL
                       OR (senderadminprincipalid IS NOT NULL
                           AND senderadminsessionauditreference IS NULL);

                    DROP TRIGGER IF EXISTS trg_msg_conversation_status_event_append_only
                        ON msg_conversation_status_event;
                    UPDATE msg_conversation_status_event
                    SET adminsessionauditreference =
                        'legacy-status-' || replace(gen_random_uuid()::text, '-', '')
                    WHERE adminsessionauditreference NOT LIKE 'legacy-status-%';
                    CREATE TRIGGER trg_msg_conversation_status_event_append_only
                    BEFORE UPDATE OR DELETE ON msg_conversation_status_event
                    FOR EACH ROW EXECUTE FUNCTION fsus_reject_conversation_status_event_mutation();

                    DO $$
                    BEGIN
                        IF NOT EXISTS (
                            SELECT 1 FROM pg_constraint
                            WHERE conname = 'ck_msg_conversation_admin_audit_reference'
                        ) THEN
                            ALTER TABLE msg_conversation
                            ADD CONSTRAINT ck_msg_conversation_admin_audit_reference
                            CHECK (createdbyadminprincipalid IS NULL OR createdbyadminsessionauditreference IS NOT NULL);
                        END IF;
                        IF NOT EXISTS (
                            SELECT 1 FROM pg_constraint
                            WHERE conname = 'ck_msg_message_admin_audit_reference'
                        ) THEN
                            ALTER TABLE msg_message
                            ADD CONSTRAINT ck_msg_message_admin_audit_reference
                            CHECK (senderadminprincipalid IS NULL OR senderadminsessionauditreference IS NOT NULL);
                        END IF;
                        IF NOT EXISTS (
                            SELECT 1 FROM pg_constraint
                            WHERE conname = 'ck_msg_conversation_raw_admin_session_empty'
                        ) THEN
                            ALTER TABLE msg_conversation
                            ADD CONSTRAINT ck_msg_conversation_raw_admin_session_empty
                            CHECK (createdbyadminsessionid IS NULL);
                        END IF;
                        IF NOT EXISTS (
                            SELECT 1 FROM pg_constraint
                            WHERE conname = 'ck_msg_message_raw_admin_session_empty'
                        ) THEN
                            ALTER TABLE msg_message
                            ADD CONSTRAINT ck_msg_message_raw_admin_session_empty
                            CHECK (senderadminsessionid IS NULL);
                        END IF;
                    END $$;
                    """)
            ]);
}
