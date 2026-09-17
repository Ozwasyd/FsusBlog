namespace FsusBlog.Migration.Definitions;

internal static class UserSessionMetadataMinimizationMigrationDefinitions
{
    internal const string MigrationId = "20260720-pre-user-session-metadata-minimization";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Replace raw user-session device metadata with coarse labels and rotating account-scoped pseudonyms.",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("sys_user_session", "device_signal_hash", "varchar(64) NULL"),
                new EnsureColumnStep("sys_user_session", "device_signal_epoch", "integer NULL"),
                new EnsureColumnStep("sys_user_session", "network_signal_hash", "varchar(64) NULL"),
                new EnsureColumnStep("sys_user_session", "network_signal_epoch", "integer NULL"),
                new EnsureColumnStep("sys_user_session", "browser_family", "varchar(24) NULL DEFAULT 'Unknown'"),
                new EnsureColumnStep("sys_user_session", "os_family", "varchar(24) NULL DEFAULT 'Unknown'"),
                new EnsureColumnStep("sys_user_session", "form_factor", "varchar(16) NULL DEFAULT 'Unknown'"),
                new RawSqlStep(
                    """
                    DO $$
                    BEGIN
                    IF to_regclass('sys_user_session') IS NULL THEN
                        RETURN;
                    END IF;

                        IF EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_schema = 'public'
                              AND table_name = 'sys_user_session'
                              AND column_name = 'useragent'
                        ) THEN
                            UPDATE sys_user_session
                            SET browser_family = CASE
                                    WHEN useragent ILIKE '%Edg/%' OR useragent ILIKE '%EdgiOS/%' OR useragent ILIKE '%EdgA/%' THEN 'Edge'
                                    WHEN useragent ILIKE '%Firefox/%' OR useragent ILIKE '%FxiOS/%' THEN 'Firefox'
                                    WHEN useragent ILIKE '%Chrome/%' OR useragent ILIKE '%CriOS/%' THEN 'Chrome'
                                    WHEN useragent ILIKE '%Safari/%' THEN 'Safari'
                                    WHEN NULLIF(BTRIM(useragent), '') IS NULL THEN 'Unknown'
                                    ELSE 'Browser'
                                END,
                                os_family = CASE
                                    WHEN useragent ILIKE '%Android%' THEN 'Android'
                                    WHEN useragent ILIKE '%iPhone%' OR useragent ILIKE '%iPad%' THEN 'iOS'
                                    WHEN useragent ILIKE '%Windows%' THEN 'Windows'
                                    WHEN useragent ILIKE '%CrOS%' THEN 'ChromeOS'
                                    WHEN useragent ILIKE '%Mac OS%' OR useragent ILIKE '%Macintosh%' THEN 'macOS'
                                    WHEN useragent ILIKE '%Linux%' THEN 'Linux'
                                    WHEN NULLIF(BTRIM(useragent), '') IS NULL THEN 'Unknown'
                                    ELSE 'Other'
                                END,
                                form_factor = CASE
                                    WHEN useragent ILIKE '%iPad%' OR useragent ILIKE '%Tablet%' THEN 'Tablet'
                                    WHEN useragent ILIKE '%iPhone%' OR useragent ILIKE '%Mobile%' THEN 'Mobile'
                                    WHEN NULLIF(BTRIM(useragent), '') IS NULL THEN 'Unknown'
                                    ELSE 'Desktop'
                                END;
                            UPDATE sys_user_session SET useragent = NULL WHERE useragent IS NOT NULL;
                        END IF;

                        IF EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_schema = 'public'
                              AND table_name = 'sys_user_session'
                              AND column_name = 'devicefingerprint'
                        ) THEN
                            UPDATE sys_user_session SET devicefingerprint = NULL WHERE devicefingerprint IS NOT NULL;
                        END IF;

                        IF EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_schema = 'public'
                              AND table_name = 'sys_user_session'
                              AND column_name = 'lastip'
                        ) THEN
                            UPDATE sys_user_session SET lastip = NULL WHERE lastip IS NOT NULL;
                        END IF;

                        UPDATE sys_user_session
                        SET browser_family = COALESCE(NULLIF(BTRIM(browser_family), ''), 'Unknown'),
                            os_family = COALESCE(NULLIF(BTRIM(os_family), ''), 'Unknown'),
                            form_factor = COALESCE(NULLIF(BTRIM(form_factor), ''), 'Unknown');
                        ALTER TABLE sys_user_session ALTER COLUMN browser_family SET DEFAULT 'Unknown';
                        ALTER TABLE sys_user_session ALTER COLUMN browser_family SET NOT NULL;
                        ALTER TABLE sys_user_session ALTER COLUMN os_family SET DEFAULT 'Unknown';
                        ALTER TABLE sys_user_session ALTER COLUMN os_family SET NOT NULL;
                        ALTER TABLE sys_user_session ALTER COLUMN form_factor SET DEFAULT 'Unknown';
                        ALTER TABLE sys_user_session ALTER COLUMN form_factor SET NOT NULL;
                    END $$;
                    """)
            ]);
}
