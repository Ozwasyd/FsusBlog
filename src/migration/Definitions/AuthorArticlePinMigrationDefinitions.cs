namespace FsusBlog.Migration.Definitions;

internal static class AuthorArticlePinMigrationDefinitions
{
    internal const string MigrationId = "20260904-post-author-article-pins";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Add the private owner/site-scoped article pin authority, ordering, receipts, and idempotency ledger.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new RawSqlStep("""
                    CREATE TABLE IF NOT EXISTS author_article_pin_collection (
                        owner_admin_principal_id bigint NOT NULL,
                        site_scope varchar(128) NOT NULL,
                        schema_version integer NOT NULL,
                        revision bigint NOT NULL,
                        item_count integer NOT NULL,
                        updated_at_utc timestamp without time zone NOT NULL,
                        content_digest varchar(64) NOT NULL,
                        PRIMARY KEY (owner_admin_principal_id, site_scope),
                        CONSTRAINT fk_author_article_pin_collection_owner
                            FOREIGN KEY (owner_admin_principal_id) REFERENCES admin_principal(id) ON DELETE CASCADE,
                        CONSTRAINT ck_author_article_pin_collection_site CHECK (
                            char_length(site_scope) BETWEEN 1 AND 128
                            AND site_scope = btrim(site_scope)),
                        CONSTRAINT ck_author_article_pin_collection_schema CHECK (schema_version = 1),
                        CONSTRAINT ck_author_article_pin_collection_revision CHECK (revision >= 0),
                        CONSTRAINT ck_author_article_pin_collection_count CHECK (item_count BETWEEN 0 AND 1000),
                        CONSTRAINT ck_author_article_pin_collection_digest CHECK (
                            content_digest ~ '^[0-9a-f]{64}$')
                    );

                    CREATE TABLE IF NOT EXISTS author_article_pin (
                        pin_id uuid NOT NULL,
                        owner_admin_principal_id bigint NOT NULL,
                        site_scope varchar(128) NOT NULL,
                        article_id integer NOT NULL,
                        order_key bigint NOT NULL,
                        created_revision bigint NOT NULL,
                        updated_revision bigint NOT NULL,
                        content_digest varchar(64) NOT NULL,
                        PRIMARY KEY (owner_admin_principal_id, site_scope, article_id),
                        CONSTRAINT uq_author_article_pin_identity UNIQUE (pin_id),
                        CONSTRAINT uq_author_article_pin_order
                            UNIQUE (owner_admin_principal_id, site_scope, order_key)
                            DEFERRABLE INITIALLY DEFERRED,
                        CONSTRAINT fk_author_article_pin_collection
                            FOREIGN KEY (owner_admin_principal_id, site_scope)
                            REFERENCES author_article_pin_collection(owner_admin_principal_id, site_scope)
                            ON DELETE CASCADE,
                        CONSTRAINT ck_author_article_pin_order CHECK (order_key > 0),
                        CONSTRAINT ck_author_article_pin_revision CHECK (
                            created_revision >= 1 AND updated_revision >= created_revision),
                        CONSTRAINT ck_author_article_pin_digest CHECK (
                            content_digest ~ '^[0-9a-f]{64}$')
                    );
                    CREATE INDEX IF NOT EXISTS ix_author_article_pin_order
                        ON author_article_pin(owner_admin_principal_id, site_scope, order_key, pin_id);
                    CREATE INDEX IF NOT EXISTS ix_author_article_pin_article
                        ON author_article_pin(article_id, owner_admin_principal_id, site_scope);

                    CREATE TABLE IF NOT EXISTS author_article_pin_receipt (
                        receipt_id uuid PRIMARY KEY,
                        owner_admin_principal_id bigint NOT NULL,
                        site_scope varchar(128) NOT NULL,
                        request_id uuid NOT NULL,
                        previous_revision bigint NOT NULL,
                        revision bigint NOT NULL,
                        command_kind varchar(16) NOT NULL,
                        status varchar(16) NOT NULL,
                        reason_code varchar(64) NULL,
                        article_ids varchar(704) NOT NULL,
                        after_article_id integer NULL,
                        item_count integer NOT NULL,
                        rebalanced boolean NOT NULL,
                        command_digest varchar(64) NOT NULL,
                        content_digest varchar(64) NOT NULL,
                        created_at_utc timestamp without time zone NOT NULL,
                        CONSTRAINT ck_author_article_pin_receipt_site CHECK (
                            char_length(site_scope) BETWEEN 1 AND 128
                            AND site_scope = btrim(site_scope)),
                        CONSTRAINT ck_author_article_pin_receipt_revisions CHECK (
                            previous_revision >= 0 AND revision >= previous_revision),
                        CONSTRAINT ck_author_article_pin_receipt_command CHECK (
                            command_kind IN ('add', 'remove', 'reorder')),
                        CONSTRAINT ck_author_article_pin_receipt_status CHECK (
                            status IN ('applied', 'noop')),
                        CONSTRAINT ck_author_article_pin_receipt_articles CHECK (
                            article_ids ~ '^[1-9][0-9]*(,[1-9][0-9]*){0,63}$'
                            AND (after_article_id IS NULL OR after_article_id > 0)),
                        CONSTRAINT ck_author_article_pin_receipt_reason CHECK (
                            (status = 'applied' AND reason_code IS NULL)
                            OR (status = 'noop' AND reason_code IN ('already-present', 'not-present', 'order-unchanged'))),
                        CONSTRAINT ck_author_article_pin_receipt_count CHECK (item_count BETWEEN 0 AND 1000),
                        CONSTRAINT ck_author_article_pin_receipt_digests CHECK (
                            command_digest ~ '^[0-9a-f]{64}$'
                            AND content_digest ~ '^[0-9a-f]{64}$')
                    );
                    CREATE INDEX IF NOT EXISTS ix_author_article_pin_receipt_owner
                        ON author_article_pin_receipt(
                            owner_admin_principal_id, site_scope, revision DESC, created_at_utc DESC, receipt_id);

                    CREATE TABLE IF NOT EXISTS author_article_pin_idempotency (
                        owner_admin_principal_id bigint NOT NULL,
                        site_scope varchar(128) NOT NULL,
                        request_id uuid NOT NULL,
                        receipt_id uuid NOT NULL,
                        previous_revision bigint NOT NULL,
                        revision bigint NOT NULL,
                        command_kind varchar(16) NOT NULL,
                        status varchar(16) NOT NULL,
                        reason_code varchar(64) NULL,
                        article_ids varchar(704) NOT NULL,
                        after_article_id integer NULL,
                        item_count integer NOT NULL,
                        rebalanced boolean NOT NULL,
                        command_digest varchar(64) NOT NULL,
                        content_digest varchar(64) NOT NULL,
                        created_at_utc timestamp without time zone NOT NULL,
                        PRIMARY KEY (owner_admin_principal_id, site_scope, request_id),
                        CONSTRAINT fk_author_article_pin_idempotency_receipt
                            FOREIGN KEY (receipt_id) REFERENCES author_article_pin_receipt(receipt_id) ON DELETE RESTRICT,
                        CONSTRAINT ck_author_article_pin_idempotency_revisions CHECK (
                            previous_revision >= 0 AND revision >= previous_revision),
                        CONSTRAINT ck_author_article_pin_idempotency_command CHECK (
                            command_kind IN ('add', 'remove', 'reorder')),
                        CONSTRAINT ck_author_article_pin_idempotency_status CHECK (
                            status IN ('applied', 'noop')),
                        CONSTRAINT ck_author_article_pin_idempotency_articles CHECK (
                            article_ids ~ '^[1-9][0-9]*(,[1-9][0-9]*){0,63}$'
                            AND (after_article_id IS NULL OR after_article_id > 0)),
                        CONSTRAINT ck_author_article_pin_idempotency_reason CHECK (
                            (status = 'applied' AND reason_code IS NULL)
                            OR (status = 'noop' AND reason_code IN ('already-present', 'not-present', 'order-unchanged'))),
                        CONSTRAINT ck_author_article_pin_idempotency_count CHECK (item_count BETWEEN 0 AND 1000),
                        CONSTRAINT ck_author_article_pin_idempotency_digests CHECK (
                            command_digest ~ '^[0-9a-f]{64}$'
                            AND content_digest ~ '^[0-9a-f]{64}$')
                    );
                    CREATE INDEX IF NOT EXISTS ix_author_article_pin_idempotency_created
                        ON author_article_pin_idempotency(created_at_utc, owner_admin_principal_id, site_scope);
                    """)
            ]);
}
