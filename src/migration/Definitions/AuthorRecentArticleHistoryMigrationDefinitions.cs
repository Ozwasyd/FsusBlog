namespace FsusBlog.Migration.Definitions;

internal static class AuthorRecentArticleHistoryMigrationDefinitions
{
    internal const string MigrationId = "20260915-post-author-recent-history";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Add the closed owner/site-scoped server recent article history authority, receipts, audit and outbox ledger.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new RawSqlStep("""
                    CREATE TABLE IF NOT EXISTS author_recent_history_collection (
                        owner_admin_principal_id bigint NOT NULL,
                        site_scope varchar(128) NOT NULL,
                        schema_version integer NOT NULL,
                        revision bigint NOT NULL,
                        item_count integer NOT NULL,
                        changed_at_utc timestamp without time zone NOT NULL,
                        content_digest varchar(64) NOT NULL,
                        PRIMARY KEY (owner_admin_principal_id, site_scope),
                        CONSTRAINT fk_author_recent_history_collection_owner
                            FOREIGN KEY (owner_admin_principal_id) REFERENCES admin_principal(id) ON DELETE CASCADE,
                        CONSTRAINT ck_author_recent_history_collection_site CHECK (
                            char_length(site_scope) BETWEEN 1 AND 128
                            AND site_scope = btrim(site_scope)),
                        CONSTRAINT ck_author_recent_history_collection_schema CHECK (schema_version = 1),
                        CONSTRAINT ck_author_recent_history_collection_revision CHECK (revision >= 0),
                        CONSTRAINT ck_author_recent_history_collection_count CHECK (item_count BETWEEN 0 AND 1000),
                        CONSTRAINT ck_author_recent_history_collection_digest CHECK (
                            content_digest ~ '^[0-9a-f]{64}$')
                    );

                    CREATE TABLE IF NOT EXISTS author_recent_history_entry (
                        owner_admin_principal_id bigint NOT NULL,
                        site_scope varchar(128) NOT NULL,
                        article_id integer NOT NULL,
                        server_revision bigint NOT NULL,
                        last_opened_at_utc timestamp without time zone NULL,
                        last_edited_at_utc timestamp without time zone NULL,
                        last_activated_at_utc timestamp without time zone NULL,
                        last_command varchar(16) NOT NULL,
                        entry_revision bigint NOT NULL,
                        content_digest varchar(64) NOT NULL,
                        PRIMARY KEY (owner_admin_principal_id, site_scope, article_id),
                        CONSTRAINT fk_author_recent_history_entry_collection
                            FOREIGN KEY (owner_admin_principal_id, site_scope)
                            REFERENCES author_recent_history_collection(owner_admin_principal_id, site_scope)
                            ON DELETE CASCADE,
                        CONSTRAINT ck_author_recent_history_entry_article CHECK (article_id > 0),
                        CONSTRAINT ck_author_recent_history_entry_server_revision CHECK (server_revision > 0),
                        CONSTRAINT ck_author_recent_history_entry_revision CHECK (entry_revision > 0),
                        CONSTRAINT ck_author_recent_history_entry_fact CHECK (
                            last_opened_at_utc IS NOT NULL
                            OR last_edited_at_utc IS NOT NULL
                            OR last_activated_at_utc IS NOT NULL),
                        CONSTRAINT ck_author_recent_history_entry_command CHECK (
                            last_command IN ('open', 'edit', 'activate')),
                        CONSTRAINT ck_author_recent_history_entry_digest CHECK (
                            content_digest ~ '^[0-9a-f]{64}$')
                    );
                    CREATE INDEX IF NOT EXISTS ix_author_recent_history_entry_order
                        ON author_recent_history_entry(
                            owner_admin_principal_id, site_scope,
                            GREATEST(last_opened_at_utc, last_edited_at_utc, last_activated_at_utc) DESC,
                            article_id DESC);

                    CREATE TABLE IF NOT EXISTS author_recent_history_receipt (
                        receipt_id uuid PRIMARY KEY,
                        owner_admin_principal_id bigint NOT NULL,
                        site_scope varchar(128) NOT NULL,
                        request_id uuid NOT NULL,
                        article_id integer NOT NULL,
                        server_revision bigint NOT NULL,
                        previous_revision bigint NOT NULL,
                        revision bigint NOT NULL,
                        command_kind varchar(16) NOT NULL,
                        status varchar(16) NOT NULL,
                        accepted_at_utc timestamp without time zone NOT NULL,
                        last_opened_at_utc timestamp without time zone NULL,
                        last_edited_at_utc timestamp without time zone NULL,
                        last_activated_at_utc timestamp without time zone NULL,
                        projection_reference varchar(256) NOT NULL,
                        cache_reference varchar(256) NOT NULL,
                        audit_reference varchar(256) NOT NULL,
                        outbox_reference varchar(256) NOT NULL,
                        command_digest varchar(64) NOT NULL,
                        content_digest varchar(64) NOT NULL,
                        receipt_digest varchar(64) NOT NULL,
                        CONSTRAINT uq_author_recent_history_receipt_request
                            UNIQUE (owner_admin_principal_id, site_scope, request_id),
                        CONSTRAINT ck_author_recent_history_receipt_site CHECK (
                            char_length(site_scope) BETWEEN 1 AND 128
                            AND site_scope = btrim(site_scope)),
                        CONSTRAINT ck_author_recent_history_receipt_article CHECK (article_id > 0),
                        CONSTRAINT ck_author_recent_history_receipt_server_revision CHECK (server_revision > 0),
                        CONSTRAINT ck_author_recent_history_receipt_revisions CHECK (
                            previous_revision >= 0 AND revision = previous_revision + 1),
                        CONSTRAINT ck_author_recent_history_receipt_command CHECK (
                            command_kind IN ('open', 'edit', 'activate')),
                        CONSTRAINT ck_author_recent_history_receipt_status CHECK (status = 'applied'),
                        CONSTRAINT ck_author_recent_history_receipt_command_timestamp CHECK (
                            (command_kind = 'open' AND last_opened_at_utc IS NOT NULL)
                            OR (command_kind = 'edit' AND last_edited_at_utc IS NOT NULL)
                            OR (command_kind = 'activate' AND last_activated_at_utc IS NOT NULL)),
                        CONSTRAINT ck_author_recent_history_receipt_references CHECK (
                            char_length(projection_reference) BETWEEN 1 AND 256
                            AND char_length(cache_reference) BETWEEN 1 AND 256
                            AND char_length(audit_reference) BETWEEN 1 AND 256
                            AND char_length(outbox_reference) BETWEEN 1 AND 256),
                        CONSTRAINT ck_author_recent_history_receipt_digests CHECK (
                            command_digest ~ '^[0-9a-f]{64}$'
                            AND content_digest ~ '^[0-9a-f]{64}$'
                            AND receipt_digest ~ '^[0-9a-f]{64}$')
                    );
                    CREATE INDEX IF NOT EXISTS ix_author_recent_history_receipt_revision
                        ON author_recent_history_receipt(
                            owner_admin_principal_id, site_scope, revision, receipt_id);

                    CREATE TABLE IF NOT EXISTS author_recent_history_idempotency (
                        owner_admin_principal_id bigint NOT NULL,
                        site_scope varchar(128) NOT NULL,
                        request_id uuid NOT NULL,
                        receipt_id uuid NOT NULL,
                        command_digest varchar(64) NOT NULL,
                        created_at_utc timestamp without time zone NOT NULL,
                        PRIMARY KEY (owner_admin_principal_id, site_scope, request_id),
                        CONSTRAINT fk_author_recent_history_idempotency_receipt
                            FOREIGN KEY (receipt_id) REFERENCES author_recent_history_receipt(receipt_id)
                            ON DELETE RESTRICT,
                        CONSTRAINT ck_author_recent_history_idempotency_digest CHECK (
                            command_digest ~ '^[0-9a-f]{64}$')
                    );
                    CREATE INDEX IF NOT EXISTS ix_author_recent_history_idempotency_created
                        ON author_recent_history_idempotency(created_at_utc);

                    CREATE TABLE IF NOT EXISTS author_recent_history_outbox (
                        outbox_reference varchar(256) PRIMARY KEY,
                        owner_admin_principal_id bigint NOT NULL,
                        site_scope varchar(128) NOT NULL,
                        receipt_id uuid NOT NULL,
                        request_id uuid NOT NULL,
                        revision bigint NOT NULL,
                        payload_digest varchar(64) NOT NULL,
                        status varchar(16) NOT NULL,
                        created_at_utc timestamp without time zone NOT NULL,
                        CONSTRAINT fk_author_recent_history_outbox_receipt
                            FOREIGN KEY (receipt_id) REFERENCES author_recent_history_receipt(receipt_id)
                            ON DELETE RESTRICT,
                        CONSTRAINT ck_author_recent_history_outbox_revision CHECK (revision > 0),
                        CONSTRAINT ck_author_recent_history_outbox_digest CHECK (
                            payload_digest ~ '^[0-9a-f]{64}$'),
                        CONSTRAINT ck_author_recent_history_outbox_status CHECK (status = 'committed')
                    );
                    CREATE UNIQUE INDEX IF NOT EXISTS ux_author_recent_history_outbox_receipt
                        ON author_recent_history_outbox(receipt_id);

                    CREATE TABLE IF NOT EXISTS author_recent_history_audit (
                        audit_reference varchar(256) PRIMARY KEY,
                        owner_admin_principal_id bigint NOT NULL,
                        site_scope varchar(128) NOT NULL,
                        receipt_id uuid NOT NULL,
                        request_id uuid NOT NULL,
                        article_id integer NOT NULL,
                        server_revision bigint NOT NULL,
                        command_kind varchar(16) NOT NULL,
                        command_digest varchar(64) NOT NULL,
                        content_digest varchar(64) NOT NULL,
                        occurred_at_utc timestamp without time zone NOT NULL,
                        CONSTRAINT fk_author_recent_history_audit_receipt
                            FOREIGN KEY (receipt_id) REFERENCES author_recent_history_receipt(receipt_id)
                            ON DELETE RESTRICT,
                        CONSTRAINT ck_author_recent_history_audit_article CHECK (article_id > 0),
                        CONSTRAINT ck_author_recent_history_audit_server_revision CHECK (server_revision > 0),
                        CONSTRAINT ck_author_recent_history_audit_command CHECK (
                            command_kind IN ('open', 'edit', 'activate')),
                        CONSTRAINT ck_author_recent_history_audit_digests CHECK (
                            command_digest ~ '^[0-9a-f]{64}$'
                            AND content_digest ~ '^[0-9a-f]{64}$')
                    );
                    CREATE UNIQUE INDEX IF NOT EXISTS ux_author_recent_history_audit_receipt
                        ON author_recent_history_audit(receipt_id);
                    """)
            ]);
}
