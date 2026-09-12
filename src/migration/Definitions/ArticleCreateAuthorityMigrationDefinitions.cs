namespace FsusBlog.Migration.Definitions;

internal static class ArticleCreateAuthorityMigrationDefinitions
{
    internal const string MigrationId = "20260908-post-article-create-authority";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Add the canonical article create authority ledger: exact-once request records and immutable create receipts bound to audit and outbox coordinates.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new RawSqlStep("""
                    CREATE TABLE IF NOT EXISTS article_create_request (
                        request_id uuid NOT NULL,
                        owner_admin_principal_id bigint NOT NULL,
                        request_digest varchar(64) NOT NULL,
                        receipt_id uuid NOT NULL,
                        created_at_utc timestamp without time zone NOT NULL,
                        PRIMARY KEY (owner_admin_principal_id, request_id),
                        CONSTRAINT ck_article_create_request_owner CHECK (owner_admin_principal_id > 0),
                        CONSTRAINT ck_article_create_request_digest CHECK (
                            request_digest ~ '^[0-9a-f]{64}$')
                    );

                    CREATE TABLE IF NOT EXISTS article_create_receipt (
                        receipt_id uuid NOT NULL,
                        request_id uuid NOT NULL,
                        owner_admin_principal_id bigint NOT NULL,
                        create_mode varchar(16) NOT NULL,
                        template_id uuid NULL,
                        template_version_id uuid NULL,
                        template_version_number integer NULL,
                        plan_digest varchar(64) NULL,
                        article_id integer NOT NULL,
                        draft_id bigint NOT NULL,
                        draft_server_revision bigint NOT NULL,
                        revision_id bigint NOT NULL,
                        revision_no integer NOT NULL,
                        outbox_event_id varchar(36) NOT NULL,
                        audit_reference uuid NOT NULL,
                        audit_digest varchar(64) NOT NULL,
                        source_digest varchar(64) NOT NULL,
                        defaults_digest varchar(64) NULL,
                        reference_digest varchar(64) NULL,
                        status varchar(16) NOT NULL,
                        content_digest varchar(64) NOT NULL,
                        occurred_at_utc timestamp without time zone NOT NULL,
                        PRIMARY KEY (receipt_id),
                        CONSTRAINT fk_article_create_receipt_request
                            FOREIGN KEY (owner_admin_principal_id, request_id)
                            REFERENCES article_create_request(owner_admin_principal_id, request_id)
                            ON DELETE RESTRICT,
                        CONSTRAINT ck_article_create_receipt_mode CHECK (
                            create_mode IN ('blank', 'template')),
                        CONSTRAINT ck_article_create_receipt_template_set CHECK (
                            (create_mode = 'template'
                                AND template_id IS NOT NULL
                                AND template_version_id IS NOT NULL
                                AND template_version_number IS NOT NULL
                                AND plan_digest IS NOT NULL
                                AND defaults_digest IS NOT NULL
                                AND reference_digest IS NOT NULL)
                            OR (create_mode = 'blank'
                                AND template_id IS NULL
                                AND template_version_id IS NULL
                                AND template_version_number IS NULL
                                AND plan_digest IS NULL
                                AND defaults_digest IS NULL
                                AND reference_digest IS NULL)),
                        CONSTRAINT ck_article_create_receipt_draft_only CHECK (status = 'draft'),
                        CONSTRAINT ck_article_create_receipt_identity CHECK (
                            article_id > 0 AND draft_id > 0 AND revision_id > 0
                            AND revision_no = 1 AND draft_server_revision >= 1),
                        CONSTRAINT ck_article_create_receipt_digests CHECK (
                            plan_digest IS NULL OR plan_digest ~ '^[0-9a-f]{64}$')
                    );
                    CREATE INDEX IF NOT EXISTS ix_article_create_receipt_owner
                        ON article_create_receipt(owner_admin_principal_id, occurred_at_utc);
                    CREATE INDEX IF NOT EXISTS ix_article_create_receipt_template
                        ON article_create_receipt(template_id, template_version_id)
                        WHERE template_id IS NOT NULL;

                    CREATE OR REPLACE FUNCTION article_create_immutable_guard()
                    RETURNS trigger AS $$
                    BEGIN
                        RAISE EXCEPTION 'article_create_immutable_row';
                    END;
                    $$ LANGUAGE plpgsql;

                    DROP TRIGGER IF EXISTS trg_article_create_request_immutable
                        ON article_create_request;
                    CREATE TRIGGER trg_article_create_request_immutable
                        BEFORE UPDATE OR DELETE ON article_create_request
                        FOR EACH ROW EXECUTE FUNCTION article_create_immutable_guard();
                    DROP TRIGGER IF EXISTS trg_article_create_receipt_immutable
                        ON article_create_receipt;
                    CREATE TRIGGER trg_article_create_receipt_immutable
                        BEFORE UPDATE OR DELETE ON article_create_receipt
                        FOR EACH ROW EXECUTE FUNCTION article_create_immutable_guard();
                    """)
            ]);
}
