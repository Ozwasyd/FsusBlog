namespace FsusBlog.Migration.Definitions;

/// <summary>Defines immutable proposal storage; canonical migration/DI registration remains root-owned.</summary>
internal static class ArticleVaultResolutionProposalMigrationDefinitions
{
    internal const string MigrationId = "20261008-post-article-vault-resolution-proposals";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Retain immutable resolution proposals without granting execution or recovery admission.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new RawSqlStep("""
                    CREATE TABLE article_vault_resolution_proposal (
                        resolution_operation_identity varchar(128) PRIMARY KEY,
                        content_sha256 varchar(64) NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
                        original_plan_reference varchar(256) NOT NULL
                            REFERENCES article_vault_execution_bundle(plan_reference) ON DELETE RESTRICT,
                        original_plan_sha256 varchar(64) NOT NULL CHECK (original_plan_sha256 ~ '^[0-9a-f]{64}$'),
                        site_identity varchar(128) NOT NULL,
                        vault_identity varchar(128) NOT NULL,
                        proposal_bytes bytea NOT NULL CHECK (octet_length(proposal_bytes) BETWEEN 1 AND 1048576),
                        stored_at_utc timestamp without time zone NOT NULL,
                        FOREIGN KEY (site_identity, vault_identity, original_plan_sha256)
                            REFERENCES article_vault_execution_bundle(site_identity, vault_identity, plan_sha256)
                            ON DELETE RESTRICT
                    );
                    CREATE FUNCTION reject_article_vault_resolution_proposal_mutation()
                    RETURNS trigger LANGUAGE plpgsql AS $$
                    BEGIN
                        RAISE EXCEPTION 'article_vault_resolution_proposal_immutable';
                    END;
                    $$;
                    CREATE TRIGGER article_vault_resolution_proposal_immutable
                        BEFORE UPDATE OR DELETE ON article_vault_resolution_proposal
                        FOR EACH ROW EXECUTE FUNCTION reject_article_vault_resolution_proposal_mutation();
                    CREATE TRIGGER article_vault_resolution_proposal_no_truncate
                        BEFORE TRUNCATE ON article_vault_resolution_proposal
                        FOR EACH STATEMENT EXECUTE FUNCTION reject_article_vault_resolution_proposal_mutation();
                    """)
            ]);
}
