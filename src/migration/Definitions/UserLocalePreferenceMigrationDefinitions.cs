namespace FsusBlog.Migration.Definitions;

internal static class UserLocalePreferenceMigrationDefinitions
{
    internal const string MigrationId = "20260728-post-user-locale-preference";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Add the independent, revisioned account locale preference table.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new RawSqlStep("""
                    CREATE TABLE IF NOT EXISTS user_locale_preference (
                        account_id integer PRIMARY KEY,
                        mode varchar(8) NOT NULL,
                        fixed_locale varchar(16) NULL,
                        revision bigint NOT NULL,
                        updated_at timestamp without time zone NOT NULL
                    );

                    DO $$
                    BEGIN
                        IF NOT EXISTS (
                            SELECT 1
                            FROM pg_constraint
                            WHERE conname = 'fk_user_locale_preference_account'
                              AND conrelid = 'user_locale_preference'::regclass
                        ) THEN
                            ALTER TABLE user_locale_preference
                            ADD CONSTRAINT fk_user_locale_preference_account
                            FOREIGN KEY (account_id) REFERENCES sys_user(id) ON DELETE CASCADE;
                        END IF;
                        IF NOT EXISTS (
                            SELECT 1
                            FROM pg_constraint
                            WHERE conname = 'ck_user_locale_preference_mode'
                              AND conrelid = 'user_locale_preference'::regclass
                        ) THEN
                            ALTER TABLE user_locale_preference
                            ADD CONSTRAINT ck_user_locale_preference_mode
                            CHECK (
                                (mode = 'auto' AND fixed_locale IS NULL)
                                OR (
                                    mode = 'fixed'
                                    AND fixed_locale IN (
                                        'zh-CN', 'en-US', 'zh-Hant', 'ja-JP', 'ko-KR',
                                        'es-419', 'fr-FR', 'de-DE', 'pt-BR', 'ru-RU')
                                )
                            );
                        END IF;
                        IF NOT EXISTS (
                            SELECT 1
                            FROM pg_constraint
                            WHERE conname = 'ck_user_locale_preference_revision'
                              AND conrelid = 'user_locale_preference'::regclass
                        ) THEN
                            ALTER TABLE user_locale_preference
                            ADD CONSTRAINT ck_user_locale_preference_revision
                            CHECK (revision > 0);
                        END IF;
                    END $$;
                    """)
            ]);
}
