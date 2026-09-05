namespace FsusBlog.Migration.Definitions;

internal static class AuthorSavedViewMigrationDefinitions
{
    internal const string MigrationId = "20260904-post-author-saved-view";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Add the private closed author saved-view authority and audit ledgers.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new RawSqlStep("""
                    CREATE TABLE IF NOT EXISTS author_saved_view_collection (
                        owner_admin_principal_id bigint NOT NULL,
                        site_scope varchar(128) NOT NULL,
                        revision bigint NOT NULL,
                        default_view_id uuid NULL,
                        active_view_count integer NOT NULL,
                        last_command_digest varchar(64) NOT NULL,
                        content_digest varchar(64) NOT NULL,
                        PRIMARY KEY (owner_admin_principal_id, site_scope),
                        CONSTRAINT fk_author_saved_view_collection_owner
                            FOREIGN KEY (owner_admin_principal_id) REFERENCES admin_principal(id) ON DELETE CASCADE,
                        CONSTRAINT ck_author_saved_view_collection_revision CHECK (revision >= 0),
                        CONSTRAINT ck_author_saved_view_collection_count CHECK (active_view_count BETWEEN 0 AND 1000),
                        CONSTRAINT ck_author_saved_view_collection_digests CHECK (
                            last_command_digest ~ '^[0-9a-f]{64}$'
                            AND content_digest ~ '^[0-9a-f]{64}$')
                    );

                    CREATE TABLE IF NOT EXISTS author_saved_view (
                        id uuid PRIMARY KEY,
                        owner_admin_principal_id bigint NOT NULL,
                        site_scope varchar(128) NOT NULL,
                        schema_version integer NOT NULL,
                        revision bigint NOT NULL,
                        name varchar(128) NOT NULL,
                        name_key varchar(256) NOT NULL,
                        query_digest varchar(64) NOT NULL,
                        dependency_digest varchar(64) NOT NULL,
                        sort_field_kind smallint NOT NULL,
                        sort_field_identity varchar(128) NOT NULL,
                        sort_direction smallint NOT NULL,
                        sort_null_placement smallint NOT NULL,
                        sort_collation varchar(32) NOT NULL,
                        sort_timezone_id varchar(64) NULL,
                        stable_tie_breaker varchar(128) NOT NULL,
                        page_size integer NOT NULL,
                        pinned boolean NOT NULL,
                        order_key bigint NOT NULL,
                        lifecycle_state smallint NOT NULL,
                        created_at_utc timestamp without time zone NOT NULL,
                        updated_at_utc timestamp without time zone NOT NULL,
                        content_digest varchar(64) NOT NULL,
                        CONSTRAINT fk_author_saved_view_collection
                            FOREIGN KEY (owner_admin_principal_id, site_scope)
                            REFERENCES author_saved_view_collection(owner_admin_principal_id, site_scope)
                            ON DELETE CASCADE,
                        CONSTRAINT ck_author_saved_view_schema CHECK (schema_version = 1),
                        CONSTRAINT ck_author_saved_view_revision CHECK (revision >= 1),
                        CONSTRAINT ck_author_saved_view_name CHECK (char_length(name) BETWEEN 1 AND 128),
                        CONSTRAINT ck_author_saved_view_sort_kind CHECK (sort_field_kind BETWEEN 0 AND 7),
                        CONSTRAINT ck_author_saved_view_sort_direction CHECK (sort_direction IN (0, 1)),
                        CONSTRAINT ck_author_saved_view_sort_null CHECK (sort_null_placement IN (0, 1)),
                        CONSTRAINT ck_author_saved_view_page_size CHECK (page_size BETWEEN 1 AND 100),
                        CONSTRAINT ck_author_saved_view_order CHECK (
                            (pinned AND lifecycle_state = 0 AND order_key > 0)
                            OR (NOT pinned AND order_key = 0)),
                        CONSTRAINT ck_author_saved_view_lifecycle CHECK (lifecycle_state IN (0, 1)),
                        CONSTRAINT ck_author_saved_view_digests CHECK (
                            query_digest ~ '^[0-9a-f]{64}$'
                            AND dependency_digest ~ '^[0-9a-f]{64}$'
                            AND content_digest ~ '^[0-9a-f]{64}$')
                    );
                    CREATE UNIQUE INDEX IF NOT EXISTS ux_author_saved_view_active_name
                        ON author_saved_view(owner_admin_principal_id, site_scope, name_key)
                        WHERE lifecycle_state = 0;
                    CREATE INDEX IF NOT EXISTS ix_author_saved_view_page
                        ON author_saved_view(
                            owner_admin_principal_id, site_scope, lifecycle_state, pinned DESC, order_key, id);

                    CREATE TABLE IF NOT EXISTS author_saved_view_condition (
                        view_id uuid NOT NULL,
                        condition_index smallint NOT NULL,
                        field_kind smallint NOT NULL,
                        field_identity varchar(128) NOT NULL,
                        operator_id varchar(128) NOT NULL,
                        timezone_id varchar(64) NULL,
                        PRIMARY KEY (view_id, condition_index),
                        CONSTRAINT fk_author_saved_view_condition
                            FOREIGN KEY (view_id) REFERENCES author_saved_view(id) ON DELETE CASCADE,
                        CONSTRAINT ck_author_saved_view_condition_index CHECK (condition_index BETWEEN 0 AND 63),
                        CONSTRAINT ck_author_saved_view_condition_kind CHECK (field_kind BETWEEN 0 AND 7)
                    );

                    CREATE TABLE IF NOT EXISTS author_saved_view_condition_value (
                        view_id uuid NOT NULL,
                        condition_index smallint NOT NULL,
                        value_index smallint NOT NULL,
                        value varchar(512) NOT NULL,
                        PRIMARY KEY (view_id, condition_index, value_index),
                        CONSTRAINT fk_author_saved_view_condition_value
                            FOREIGN KEY (view_id, condition_index)
                            REFERENCES author_saved_view_condition(view_id, condition_index) ON DELETE CASCADE,
                        CONSTRAINT ck_author_saved_view_condition_value_index CHECK (value_index BETWEEN 0 AND 63),
                        CONSTRAINT ck_author_saved_view_condition_value CHECK (char_length(value) BETWEEN 1 AND 512)
                    );

                    CREATE TABLE IF NOT EXISTS author_saved_view_projection (
                        view_id uuid NOT NULL,
                        projection_index smallint NOT NULL,
                        field_kind smallint NOT NULL,
                        field_identity varchar(128) NOT NULL,
                        PRIMARY KEY (view_id, projection_index),
                        CONSTRAINT fk_author_saved_view_projection
                            FOREIGN KEY (view_id) REFERENCES author_saved_view(id) ON DELETE CASCADE,
                        CONSTRAINT ck_author_saved_view_projection_index CHECK (projection_index BETWEEN 0 AND 31),
                        CONSTRAINT ck_author_saved_view_projection_kind CHECK (field_kind BETWEEN 0 AND 7)
                    );

                    CREATE TABLE IF NOT EXISTS author_saved_view_receipt (
                        receipt_id uuid PRIMARY KEY,
                        request_id uuid NOT NULL,
                        owner_admin_principal_id bigint NOT NULL,
                        site_scope varchar(128) NOT NULL,
                        view_id uuid NOT NULL,
                        command_kind varchar(32) NOT NULL,
                        command_digest varchar(64) NOT NULL,
                        view_revision bigint NOT NULL,
                        collection_revision bigint NOT NULL,
                        query_digest varchar(64) NOT NULL,
                        dependency_digest varchar(64) NOT NULL,
                        pinned boolean NOT NULL,
                        default_view_id uuid NULL,
                        order_key bigint NOT NULL,
                        lifecycle_state smallint NOT NULL,
                        reason_code varchar(64) NOT NULL,
                        content_digest varchar(64) NOT NULL,
                        occurred_at_utc timestamp without time zone NOT NULL,
                        CONSTRAINT ck_author_saved_view_receipt_revisions CHECK (
                            view_revision >= 0 AND collection_revision >= 1),
                        CONSTRAINT ck_author_saved_view_receipt_lifecycle CHECK (lifecycle_state IN (0, 1)),
                        CONSTRAINT ck_author_saved_view_receipt_digests CHECK (
                            command_digest ~ '^[0-9a-f]{64}$'
                            AND (query_digest = '' OR query_digest ~ '^[0-9a-f]{64}$')
                            AND (dependency_digest = '' OR dependency_digest ~ '^[0-9a-f]{64}$')
                            AND content_digest ~ '^[0-9a-f]{64}$')
                    );
                    CREATE INDEX IF NOT EXISTS ix_author_saved_view_receipt_owner
                        ON author_saved_view_receipt(
                            owner_admin_principal_id, site_scope, collection_revision DESC, occurred_at_utc DESC);

                    CREATE TABLE IF NOT EXISTS author_saved_view_idempotency (
                        owner_admin_principal_id bigint NOT NULL,
                        site_scope varchar(128) NOT NULL,
                        request_id uuid NOT NULL,
                        receipt_id uuid NOT NULL,
                        command_digest varchar(64) NOT NULL,
                        created_at_utc timestamp without time zone NOT NULL,
                        PRIMARY KEY (owner_admin_principal_id, site_scope, request_id),
                        CONSTRAINT fk_author_saved_view_idempotency_receipt
                            FOREIGN KEY (receipt_id) REFERENCES author_saved_view_receipt(receipt_id) ON DELETE RESTRICT,
                        CONSTRAINT ck_author_saved_view_idempotency_digest CHECK (
                            command_digest ~ '^[0-9a-f]{64}$')
                    );

                    DO $$
                    BEGIN
                        IF NOT EXISTS (
                            SELECT 1 FROM pg_constraint
                            WHERE conname = 'fk_author_saved_view_collection_default') THEN
                            ALTER TABLE author_saved_view_collection
                                ADD CONSTRAINT fk_author_saved_view_collection_default
                                FOREIGN KEY (default_view_id) REFERENCES author_saved_view(id)
                                ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
                        END IF;
                    END $$;
                    """)
            ]);
}
