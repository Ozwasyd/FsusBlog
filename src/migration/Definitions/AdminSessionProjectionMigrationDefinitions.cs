namespace FsusBlog.Migration.Definitions;

internal static class AdminSessionProjectionMigrationDefinitions
{
    internal const string MigrationId = "20260913-post-admin-session-validation-projection";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Add explicit monotonic validation versions for durable admin session projection convergence.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new RawSqlStep("""
                    ALTER TABLE admin_principal
                        ADD COLUMN IF NOT EXISTS validationversion bigint NOT NULL DEFAULT 1;
                    ALTER TABLE admin_session
                        ADD COLUMN IF NOT EXISTS validationversion bigint NOT NULL DEFAULT 1;

                    ALTER TABLE admin_principal
                        DROP CONSTRAINT IF EXISTS ck_admin_principal_validation_version;
                    ALTER TABLE admin_principal
                        ADD CONSTRAINT ck_admin_principal_validation_version
                        CHECK (validationversion > 0);

                    ALTER TABLE admin_session
                        DROP CONSTRAINT IF EXISTS ck_admin_session_validation_version;
                    ALTER TABLE admin_session
                        ADD CONSTRAINT ck_admin_session_validation_version
                        CHECK (validationversion > 0);

                    CREATE INDEX IF NOT EXISTS idx_admin_session_projection_cold_start
                        ON admin_session(sessionid, idleexpiresatutc, absoluteexpiresatutc);
                    """)
            ]);
}
