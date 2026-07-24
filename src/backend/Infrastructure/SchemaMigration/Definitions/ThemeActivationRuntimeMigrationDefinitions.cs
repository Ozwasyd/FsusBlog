namespace FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;

internal static class ThemeActivationRuntimeMigrationDefinitions
{
    internal const string MigrationId = "20260724-post-theme-runtime";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Add rollback-safe theme activation versions, durable history and machine-readable evidence.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("theme_activation", "activation_id", "varchar(36) NULL"),
                new EnsureColumnStep("theme_activation", "asset_version", "varchar(64) NULL"),
                new EnsureColumnStep("theme_activation", "config_version", "bigint NULL"),
                new EnsureTableStep("theme_activation_history", """
                    CREATE TABLE IF NOT EXISTS theme_activation_history (
                        id varchar(36) PRIMARY KEY,
                        scope varchar(160) NOT NULL,
                        theme_id varchar(128) NULL,
                        previous_theme_id varchar(128) NULL,
                        asset_version varchar(64) NULL,
                        previous_asset_version varchar(64) NULL,
                        config_version bigint NULL,
                        previous_config_version bigint NULL,
                        mode varchar(16) NULL,
                        previous_mode varchar(16) NULL,
                        status varchar(32) NOT NULL,
                        started_at_utc timestamp without time zone NOT NULL,
                        completed_at_utc timestamp without time zone NOT NULL,
                        failure_reason varchar(1000) NULL,
                        activated_by varchar(160) NOT NULL,
                        evidence_json jsonb NOT NULL,
                        CONSTRAINT ck_theme_activation_history_scope CHECK (
                            scope IN ('site-wide', 'public', 'admin', 'console')
                            OR scope ~ '^user-preview:[1-9][0-9]*$'
                        ),
                        CONSTRAINT ck_theme_activation_history_status CHECK (
                            status IN ('applied', 'rejected', 'rolled_back', 'reset_to_default')
                        ),
                        CONSTRAINT ck_theme_activation_history_mode CHECK (
                            mode IS NULL OR mode IN ('auto', 'light', 'dark')
                        ),
                        CONSTRAINT ck_theme_activation_history_previous_mode CHECK (
                            previous_mode IS NULL OR previous_mode IN ('auto', 'light', 'dark')
                        ),
                        CONSTRAINT ck_theme_activation_history_config_version CHECK (
                            config_version IS NULL OR config_version > 0
                        ),
                        CONSTRAINT ck_theme_activation_history_previous_config_version CHECK (
                            previous_config_version IS NULL OR previous_config_version > 0
                        )
                    );
                    """),
                new CreateIndexStep(
                    "idx_theme_activation_history_scope_started",
                    """
                    CREATE INDEX IF NOT EXISTS idx_theme_activation_history_scope_started
                    ON theme_activation_history(scope, started_at_utc DESC, id DESC);
                    """)
            ]);
}
