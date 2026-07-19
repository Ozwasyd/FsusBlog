namespace FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;

internal static class AccountEnrollmentMigrationDefinitions
{
    internal const string MigrationId = "20260720-pre-atomic-account-enrollment";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Introduce explicit account registration state and isolated first-Passkey enrollment sessions.",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("sys_user", "registration_state", "varchar(24) NOT NULL DEFAULT 'active'"),
                new RawSqlStep("""
                    DO $$
                    BEGIN
                        IF EXISTS (
                            SELECT 1 FROM information_schema.tables
                            WHERE table_schema = 'public' AND table_name = 'sys_user'
                        ) THEN
                            UPDATE sys_user account
                            SET registration_state = CASE
                                WHEN account.status = 2 OR account.deleted_at IS NOT NULL THEN 'closed'
                                WHEN account.status = 1 THEN 'suspended'
                                WHEN EXISTS (
                                    SELECT 1 FROM passkey_credential credential
                                    WHERE credential.account_id = account.id
                                ) THEN 'active'
                                WHEN EXISTS (
                                    SELECT 1 FROM account_recovery_key recovery
                                    WHERE recovery.account_id = account.id
                                      AND recovery.revoked_at IS NULL
                                ) THEN 'active'
                                WHEN EXISTS (
                                    SELECT 1 FROM sys_user_session session
                                    WHERE session.userid = account.id
                                      AND session.revokedat IS NULL
                                      AND session.idleexpiresat > CURRENT_TIMESTAMP
                                      AND session.absoluteexpiresat > CURRENT_TIMESTAMP
                                ) THEN 'active'
                                ELSE 'suspended'
                            END
                            WHERE registration_state = 'active'
                               OR registration_state NOT IN ('provisional', 'active', 'suspended', 'closed');

                            CREATE TABLE IF NOT EXISTS account_enrollment_session (
                                token_hash varchar(64) PRIMARY KEY,
                                account_id integer NOT NULL REFERENCES sys_user(id) ON DELETE CASCADE,
                                state varchar(24) NOT NULL DEFAULT 'pending',
                                passkey_user_handle varchar(128) NOT NULL,
                                registration_challenge_key varchar(64) NULL,
                                completion_request_hash varchar(64) NULL,
                                completion_lease_until timestamp NULL,
                                completed_session_id varchar(64) NULL REFERENCES sys_user_session(sessionid) ON DELETE SET NULL,
                                protected_refresh_token text NULL,
                                created_at timestamp NOT NULL,
                                expires_at timestamp NOT NULL,
                                completed_at timestamp NULL,
                                cancelled_at timestamp NULL,
                                CONSTRAINT ck_account_enrollment_state CHECK (state IN ('pending', 'completing', 'completed', 'cancelled', 'expired'))
                            );
                            CREATE UNIQUE INDEX IF NOT EXISTS ux_account_enrollment_account
                                ON account_enrollment_session(account_id);
                            CREATE INDEX IF NOT EXISTS idx_account_enrollment_expiry
                                ON account_enrollment_session(expires_at);
                            CREATE INDEX IF NOT EXISTS idx_user_registration_state
                                ON sys_user(registration_state);
                        END IF;
                    END $$;
                    """)
            ]);
}
