namespace FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;

internal static class UserSessionAuthenticationContextMigrationDefinitions
{
    internal const string MigrationId = "20260720-pre-user-session-authentication-context";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Add refresh-stable authentication provenance, step-up audit, and cookie duration policy to user sessions.",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("sys_user_session", "authentication_method", "varchar(24) NULL"),
                new EnsureColumnStep("sys_user_session", "authentication_strength", "varchar(24) NULL"),
                new EnsureColumnStep("sys_user_session", "authenticated_at_utc", "timestamp NULL"),
                new EnsureColumnStep("sys_user_session", "authenticated_credential_row_id", "integer NULL"),
                new EnsureColumnStep("sys_user_session", "last_step_up_at_utc", "timestamp NULL"),
                new EnsureColumnStep("sys_user_session", "last_step_up_method", "varchar(24) NULL"),
                new EnsureColumnStep("sys_user_session", "duration_policy", "varchar(24) NULL"),
                new EnsureColumnStep("sys_user_session", "mfaverified", "boolean NOT NULL DEFAULT false"),
                new RawSqlStep(
                    """
                    DO $$
                    BEGIN
                    IF to_regclass('sys_user_session') IS NOT NULL THEN
                    EXECUTE $migration$
                        UPDATE sys_user_session
                        SET authentication_method = COALESCE(authentication_method, 'other'),
                            authentication_strength = COALESCE(
                                authentication_strength,
                                CASE WHEN COALESCE(mfaverified, false) THEN 'legacy_verified' ELSE 'legacy_unverified' END),
                            authenticated_at_utc = COALESCE(authenticated_at_utc, createdat, now() AT TIME ZONE 'utc'),
                            duration_policy = COALESCE(
                                duration_policy,
                                CASE WHEN COALESCE(rememberme, false) THEN 'persistent_30d' ELSE 'browser_session' END)
                        WHERE authentication_method IS NULL
                           OR authentication_strength IS NULL
                           OR authenticated_at_utc IS NULL
                           OR duration_policy IS NULL;

                        ALTER TABLE sys_user_session ALTER COLUMN authentication_method SET DEFAULT 'other';
                        ALTER TABLE sys_user_session ALTER COLUMN authentication_method SET NOT NULL;
                        ALTER TABLE sys_user_session ALTER COLUMN authentication_strength SET DEFAULT 'legacy_unverified';
                        ALTER TABLE sys_user_session ALTER COLUMN authentication_strength SET NOT NULL;
                        ALTER TABLE sys_user_session ALTER COLUMN authenticated_at_utc SET DEFAULT (now() AT TIME ZONE 'utc');
                        ALTER TABLE sys_user_session ALTER COLUMN authenticated_at_utc SET NOT NULL;
                        ALTER TABLE sys_user_session ALTER COLUMN duration_policy SET DEFAULT 'browser_session';
                        ALTER TABLE sys_user_session ALTER COLUMN duration_policy SET NOT NULL
                    $migration$;
                    END IF;
                    END $$;
                    """)
            ]);
}
