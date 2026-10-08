namespace FsusBlog.Migration.Definitions;

/// <summary>Defines append-only operation storage; registration remains integration-owner controlled.</summary>
internal static class ArticleVaultOperationMigrationDefinitions
{
    internal const string MigrationId = "20261008-post-article-vault-operation-checkpoints";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Add immutable Article Vault operation identities and exact checkpoint chains.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new RawSqlStep("""
                    CREATE TABLE article_vault_operation_identity (
                        operation_identity varchar(64) PRIMARY KEY,
                        site_identity varchar(128) NOT NULL,
                        vault_identity varchar(128) NOT NULL,
                        device_identity varchar(128) NOT NULL,
                        agent_identity varchar(128) NOT NULL,
                        request_sha256 varchar(64) NOT NULL,
                        idempotency_sha256 varchar(64) NOT NULL,
                        identity_sha256 varchar(64) NOT NULL,
                        identity_json text NOT NULL,
                        UNIQUE (site_identity, vault_identity, device_identity, agent_identity, request_sha256),
                        UNIQUE (site_identity, vault_identity, device_identity, agent_identity, idempotency_sha256),
                        CHECK (operation_identity ~ '^[0-9a-f]{64}$'
                            AND request_sha256 ~ '^[0-9a-f]{64}$'
                            AND idempotency_sha256 ~ '^[0-9a-f]{64}$'
                            AND identity_sha256 ~ '^[0-9a-f]{64}$')
                    );

                    CREATE TABLE article_vault_operation_checkpoint (
                        operation_identity varchar(64) NOT NULL
                            REFERENCES article_vault_operation_identity(operation_identity) ON DELETE RESTRICT,
                        sequence bigint NOT NULL CHECK (sequence >= 0),
                        previous_sha256 varchar(64),
                        content_sha256 varchar(64) NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
                        checkpoint_json text NOT NULL,
                        PRIMARY KEY (operation_identity, sequence),
                        UNIQUE (operation_identity, content_sha256),
                        FOREIGN KEY (operation_identity, previous_sha256)
                            REFERENCES article_vault_operation_checkpoint(operation_identity, content_sha256),
                        CHECK ((sequence = 0 AND previous_sha256 IS NULL)
                            OR (sequence > 0 AND previous_sha256 IS NOT NULL AND previous_sha256 ~ '^[0-9a-f]{64}$'))
                    );

                    CREATE FUNCTION reject_article_vault_operation_history_mutation()
                    RETURNS trigger LANGUAGE plpgsql AS $$
                    BEGIN
                        RAISE EXCEPTION 'article_vault_operation_history_immutable';
                    END;
                    $$;
                    CREATE TRIGGER article_vault_operation_identity_immutable
                        BEFORE UPDATE OR DELETE ON article_vault_operation_identity
                        FOR EACH ROW EXECUTE FUNCTION reject_article_vault_operation_history_mutation();
                    CREATE TRIGGER article_vault_operation_checkpoint_immutable
                        BEFORE UPDATE OR DELETE ON article_vault_operation_checkpoint
                        FOR EACH ROW EXECUTE FUNCTION reject_article_vault_operation_history_mutation();
                    """)
            ]);
}
