namespace FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;

internal static class UserSessionModeMigrationDefinitions
{
    internal const string MigrationId = "20260720-pre-user-session-mode-authority";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Persist authoritative normal, restricted, and revoked user-session modes.",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("sys_user_session", "session_mode", "integer NULL DEFAULT 0"),
                new RawSqlStep(
                    """
                    DO $$
                    BEGIN
                    IF to_regclass('sys_user_session') IS NOT NULL
                       AND to_regclass('sys_user') IS NOT NULL THEN
                    EXECUTE $migration$
                        UPDATE sys_user_session session
                        SET session_mode = CASE
                            WHEN session.revokedat IS NOT NULL THEN 2
                            WHEN account.status = 1 THEN 1
                            ELSE 0
                        END
                        FROM sys_user account
                        WHERE account.id = session.userid
                    $migration$;
                    END IF;
                    END $$;
                    """)
            ]);
}
