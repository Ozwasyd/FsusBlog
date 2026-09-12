namespace FsusBlog.Migration.Definitions;

internal static class ArticleVaultExecutionMigrationDefinitions
{
    internal const string MigrationId = "20260907-post-article-vault-execution";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Add sealed Article Vault execution bundles, atomic group receipts and terminal results.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new RawSqlStep("""
                    CREATE TABLE IF NOT EXISTS article_vault_execution_bundle (
                        plan_reference varchar(256) PRIMARY KEY,
                        plan_sha256 varchar(64) NOT NULL,
                        site_identity varchar(128) NOT NULL,
                        vault_identity varchar(128) NOT NULL,
                        idempotency_key varchar(64) NOT NULL,
                        bundle_json text NOT NULL,
                        content_sha256 varchar(64) NOT NULL,
                        expires_at_utc timestamp without time zone NOT NULL,
                        created_at_utc timestamp without time zone NOT NULL,
                        CONSTRAINT uq_article_vault_execution_plan UNIQUE (site_identity, vault_identity, plan_sha256),
                        CONSTRAINT ck_article_vault_execution_identity CHECK (
                            char_length(site_identity) BETWEEN 3 AND 128
                            AND char_length(vault_identity) BETWEEN 3 AND 128),
                        CONSTRAINT ck_article_vault_execution_digests CHECK (
                            plan_sha256 ~ '^[0-9a-f]{64}$'
                            AND idempotency_key ~ '^[0-9a-f]{64}$'
                            AND content_sha256 ~ '^[0-9a-f]{64}$'),
                        CONSTRAINT ck_article_vault_execution_window CHECK (expires_at_utc > created_at_utc)
                    );
                    CREATE INDEX IF NOT EXISTS ix_article_vault_execution_expiry
                        ON article_vault_execution_bundle(expires_at_utc, plan_reference);

                    CREATE TABLE IF NOT EXISTS article_vault_group_result (
                        idempotency_sha256 varchar(64) PRIMARY KEY,
                        site_identity varchar(128) NOT NULL,
                        vault_identity varchar(128) NOT NULL,
                        plan_sha256 varchar(64) NOT NULL,
                        group_identity varchar(128) NOT NULL,
                        receipt_json text NOT NULL,
                        content_sha256 varchar(64) NOT NULL,
                        created_at_utc timestamp without time zone NOT NULL,
                        CONSTRAINT uq_article_vault_group_result UNIQUE (
                            site_identity, vault_identity, plan_sha256, group_identity),
                        CONSTRAINT fk_article_vault_group_plan
                            FOREIGN KEY (site_identity, vault_identity, plan_sha256)
                            REFERENCES article_vault_execution_bundle(site_identity, vault_identity, plan_sha256)
                            ON DELETE RESTRICT,
                        CONSTRAINT ck_article_vault_group_digests CHECK (
                            idempotency_sha256 ~ '^[0-9a-f]{64}$'
                            AND plan_sha256 ~ '^[0-9a-f]{64}$'
                            AND content_sha256 ~ '^[0-9a-f]{64}$')
                    );

                    CREATE TABLE IF NOT EXISTS article_vault_execution_result (
                        result_reference varchar(256) PRIMARY KEY,
                        site_identity varchar(128) NOT NULL,
                        vault_identity varchar(128) NOT NULL,
                        plan_sha256 varchar(64) NOT NULL,
                        result_json text NOT NULL,
                        content_sha256 varchar(64) NOT NULL,
                        created_at_utc timestamp without time zone NOT NULL,
                        CONSTRAINT uq_article_vault_execution_result UNIQUE (
                            site_identity, vault_identity, plan_sha256),
                        CONSTRAINT fk_article_vault_result_plan
                            FOREIGN KEY (site_identity, vault_identity, plan_sha256)
                            REFERENCES article_vault_execution_bundle(site_identity, vault_identity, plan_sha256)
                            ON DELETE RESTRICT,
                        CONSTRAINT ck_article_vault_result_digests CHECK (
                            plan_sha256 ~ '^[0-9a-f]{64}$'
                            AND content_sha256 ~ '^[0-9a-f]{64}$')
                    );
                    """)
            ]);
}
