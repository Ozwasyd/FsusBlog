namespace FsusBlog.Migration.Definitions;

internal static class ArticleTemplateAuthorityMigrationDefinitions
{
    internal const string MigrationId = "20260905-post-article-template-authority";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Add the exact-one article template authority: scoped definitions, immutable versions, receipts, audit binding, idempotency, and usage ledger.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new RawSqlStep("""
                    CREATE TABLE IF NOT EXISTS article_template_scope (
                        scope_kind smallint NOT NULL,
                        owner_admin_principal_id bigint NOT NULL,
                        revision bigint NOT NULL,
                        PRIMARY KEY (scope_kind, owner_admin_principal_id),
                        CONSTRAINT ck_article_template_scope_kind CHECK (scope_kind IN (0, 1)),
                        CONSTRAINT ck_article_template_scope_owner CHECK (
                            (scope_kind = 0 AND owner_admin_principal_id > 0)
                            OR (scope_kind = 1 AND owner_admin_principal_id = 0)),
                        CONSTRAINT ck_article_template_scope_revision CHECK (revision >= 0)
                    );

                    CREATE TABLE IF NOT EXISTS article_template_definition (
                        schema_version integer NOT NULL,
                        template_id uuid NOT NULL,
                        scope_kind smallint NOT NULL,
                        owner_admin_principal_id bigint NOT NULL,
                        name varchar(128) NOT NULL,
                        name_key varchar(256) NOT NULL,
                        description varchar(1024) NULL,
                        status smallint NOT NULL,
                        revision bigint NOT NULL,
                        current_version_id uuid NOT NULL,
                        current_version_number integer NOT NULL,
                        created_at_utc timestamp without time zone NOT NULL,
                        updated_at_utc timestamp without time zone NOT NULL,
                        content_digest varchar(64) NOT NULL,
                        PRIMARY KEY (template_id),
                        CONSTRAINT fk_article_template_definition_scope
                            FOREIGN KEY (scope_kind, owner_admin_principal_id)
                            REFERENCES article_template_scope(scope_kind, owner_admin_principal_id)
                            ON DELETE RESTRICT,
                        CONSTRAINT ck_article_template_definition_schema CHECK (schema_version = 1),
                        CONSTRAINT ck_article_template_definition_scope_kind CHECK (scope_kind IN (0, 1)),
                        CONSTRAINT ck_article_template_definition_owner CHECK (
                            (scope_kind = 0 AND owner_admin_principal_id > 0)
                            OR (scope_kind = 1 AND owner_admin_principal_id = 0)),
                        CONSTRAINT ck_article_template_definition_name CHECK (
                            char_length(name) BETWEEN 1 AND 128
                            AND char_length(name_key) BETWEEN 1 AND 256),
                        CONSTRAINT ck_article_template_definition_description CHECK (
                            description IS NULL OR char_length(description) BETWEEN 1 AND 1024),
                        CONSTRAINT ck_article_template_definition_status CHECK (status IN (0, 1, 2)),
                        CONSTRAINT ck_article_template_definition_revision CHECK (revision >= 1),
                        CONSTRAINT ck_article_template_definition_current_version CHECK (
                            current_version_number BETWEEN 1 AND 1000),
                        CONSTRAINT ck_article_template_definition_timeline CHECK (
                            created_at_utc <= updated_at_utc),
                        CONSTRAINT ck_article_template_definition_digest CHECK (
                            content_digest ~ '^[0-9a-f]{64}$')
                    );
                    CREATE UNIQUE INDEX IF NOT EXISTS ux_article_template_definition_live_name
                        ON article_template_definition(scope_kind, owner_admin_principal_id, name_key)
                        WHERE status <> 2;
                    CREATE INDEX IF NOT EXISTS ix_article_template_definition_page
                        ON article_template_definition(
                            scope_kind, owner_admin_principal_id, name_key, template_id)
                        WHERE status <> 2;

                    CREATE TABLE IF NOT EXISTS article_template_version (
                        schema_version integer NOT NULL,
                        template_id uuid NOT NULL,
                        version_id uuid NOT NULL,
                        version_number integer NOT NULL,
                        created_by_admin_principal_id bigint NOT NULL,
                        created_at_utc timestamp without time zone NOT NULL,
                        source_bytes bytea NOT NULL,
                        variable_count integer NOT NULL,
                        title_placeholder varchar(512) NULL,
                        summary_placeholder varchar(512) NULL,
                        category_id integer NULL,
                        rights_profile_id uuid NULL,
                        rights_profile_revision bigint NULL,
                        responsibility_profile_id uuid NULL,
                        responsibility_profile_revision bigint NULL,
                        prepublish_profile_id uuid NULL,
                        prepublish_profile_revision bigint NULL,
                        defaults_digest varchar(64) NOT NULL,
                        content_digest varchar(64) NOT NULL,
                        PRIMARY KEY (version_id),
                        CONSTRAINT ux_article_template_version_number
                            UNIQUE (template_id, version_number),
                        CONSTRAINT fk_article_template_version_definition
                            FOREIGN KEY (template_id) REFERENCES article_template_definition(template_id)
                            ON DELETE RESTRICT,
                        CONSTRAINT ck_article_template_version_schema CHECK (schema_version = 1),
                        CONSTRAINT ck_article_template_version_number CHECK (
                            version_number BETWEEN 1 AND 1000),
                        CONSTRAINT ck_article_template_version_creator CHECK (
                            created_by_admin_principal_id > 0),
                        CONSTRAINT ck_article_template_version_source CHECK (
                            octet_length(source_bytes) <= 262144),
                        CONSTRAINT ck_article_template_version_variables CHECK (
                            variable_count BETWEEN 0 AND 64),
                        CONSTRAINT ck_article_template_version_placeholders CHECK (
                            (title_placeholder IS NULL OR char_length(title_placeholder) BETWEEN 1 AND 512)
                            AND (summary_placeholder IS NULL OR char_length(summary_placeholder) BETWEEN 1 AND 512)),
                        CONSTRAINT ck_article_template_version_category CHECK (
                            category_id IS NULL OR category_id > 0),
                        CONSTRAINT ck_article_template_version_rights_profile CHECK (
                            (rights_profile_id IS NULL) = (rights_profile_revision IS NULL)
                            AND (rights_profile_revision IS NULL OR rights_profile_revision > 0)),
                        CONSTRAINT ck_article_template_version_responsibility_profile CHECK (
                            (responsibility_profile_id IS NULL) = (responsibility_profile_revision IS NULL)
                            AND (responsibility_profile_revision IS NULL OR responsibility_profile_revision > 0)),
                        CONSTRAINT ck_article_template_version_prepublish_profile CHECK (
                            (prepublish_profile_id IS NULL) = (prepublish_profile_revision IS NULL)
                            AND (prepublish_profile_revision IS NULL OR prepublish_profile_revision > 0)),
                        CONSTRAINT ck_article_template_version_digests CHECK (
                            defaults_digest ~ '^[0-9a-f]{64}$'
                            AND content_digest ~ '^[0-9a-f]{64}$')
                    );
                    CREATE INDEX IF NOT EXISTS ix_article_template_version_template
                        ON article_template_version(template_id, version_number DESC);

                    CREATE TABLE IF NOT EXISTS article_template_version_tag (
                        version_id uuid NOT NULL,
                        tag_index integer NOT NULL,
                        tag_id integer NOT NULL,
                        PRIMARY KEY (version_id, tag_index),
                        CONSTRAINT ux_article_template_version_tag UNIQUE (version_id, tag_id),
                        CONSTRAINT fk_article_template_version_tag
                            FOREIGN KEY (version_id) REFERENCES article_template_version(version_id)
                            ON DELETE RESTRICT,
                        CONSTRAINT ck_article_template_version_tag_index CHECK (tag_index BETWEEN 0 AND 63),
                        CONSTRAINT ck_article_template_version_tag_id CHECK (tag_id > 0)
                    );

                    CREATE TABLE IF NOT EXISTS article_template_version_asset (
                        version_id uuid NOT NULL,
                        asset_index integer NOT NULL,
                        asset_id uuid NOT NULL,
                        PRIMARY KEY (version_id, asset_index),
                        CONSTRAINT ux_article_template_version_asset UNIQUE (version_id, asset_id),
                        CONSTRAINT fk_article_template_version_asset
                            FOREIGN KEY (version_id) REFERENCES article_template_version(version_id)
                            ON DELETE RESTRICT,
                        CONSTRAINT ck_article_template_version_asset_index CHECK (asset_index BETWEEN 0 AND 63)
                    );

                    CREATE TABLE IF NOT EXISTS article_template_version_property_default (
                        version_id uuid NOT NULL,
                        property_index integer NOT NULL,
                        definition_id uuid NOT NULL,
                        value_kind smallint NOT NULL,
                        canonical_value varchar(2048) NULL,
                        PRIMARY KEY (version_id, property_index),
                        CONSTRAINT ux_article_template_version_property UNIQUE (version_id, definition_id),
                        CONSTRAINT fk_article_template_version_property
                            FOREIGN KEY (version_id) REFERENCES article_template_version(version_id)
                            ON DELETE RESTRICT,
                        CONSTRAINT ck_article_template_version_property_index CHECK (
                            property_index BETWEEN 0 AND 63),
                        CONSTRAINT ck_article_template_version_property_kind CHECK (
                            value_kind BETWEEN 0 AND 7),
                        CONSTRAINT ck_article_template_version_property_value CHECK (
                            canonical_value IS NULL OR char_length(canonical_value) BETWEEN 1 AND 2048)
                    );

                    CREATE TABLE IF NOT EXISTS article_template_version_property_option (
                        version_id uuid NOT NULL,
                        property_index integer NOT NULL,
                        option_index integer NOT NULL,
                        option_id uuid NOT NULL,
                        PRIMARY KEY (version_id, property_index, option_index),
                        CONSTRAINT ux_article_template_version_property_option UNIQUE (
                            version_id, property_index, option_id),
                        CONSTRAINT fk_article_template_version_property_option
                            FOREIGN KEY (version_id, property_index)
                            REFERENCES article_template_version_property_default(version_id, property_index)
                            ON DELETE RESTRICT,
                        CONSTRAINT ck_article_template_version_property_option_index CHECK (
                            option_index BETWEEN 0 AND 63)
                    );

                    CREATE TABLE IF NOT EXISTS article_template_receipt (
                        receipt_id uuid NOT NULL,
                        request_id uuid NOT NULL,
                        actor_admin_principal_id bigint NOT NULL,
                        command_kind varchar(32) NOT NULL,
                        command_digest varchar(64) NOT NULL,
                        template_id uuid NOT NULL,
                        version_id uuid NULL,
                        version_number integer NULL,
                        scope_kind smallint NOT NULL,
                        owner_admin_principal_id bigint NOT NULL,
                        previous_scope_revision bigint NOT NULL,
                        scope_revision bigint NOT NULL,
                        previous_template_revision bigint NOT NULL,
                        template_revision bigint NOT NULL,
                        permission smallint NOT NULL,
                        permission_digest varchar(64) NOT NULL,
                        defaults_digest varchar(64) NOT NULL,
                        status smallint NOT NULL,
                        definition_digest varchar(64) NOT NULL,
                        version_digest varchar(64) NOT NULL,
                        delete_disposition smallint NOT NULL,
                        occurred_at_utc timestamp without time zone NOT NULL,
                        audit_reference uuid NOT NULL,
                        audit_digest varchar(64) NOT NULL,
                        content_digest varchar(64) NOT NULL,
                        PRIMARY KEY (receipt_id),
                        CONSTRAINT ux_article_template_receipt_revision
                            UNIQUE (template_id, template_revision),
                        CONSTRAINT ux_article_template_receipt_audit UNIQUE (audit_reference),
                        CONSTRAINT fk_article_template_receipt_definition
                            FOREIGN KEY (template_id) REFERENCES article_template_definition(template_id)
                            ON DELETE RESTRICT,
                        CONSTRAINT fk_article_template_receipt_version
                            FOREIGN KEY (version_id) REFERENCES article_template_version(version_id)
                            ON DELETE RESTRICT,
                        CONSTRAINT ck_article_template_receipt_actor CHECK (actor_admin_principal_id > 0),
                        CONSTRAINT ck_article_template_receipt_command CHECK (
                            command_kind IN ('create', 'new-version', 'rename', 'retire', 'delete')),
                        CONSTRAINT ck_article_template_receipt_scope_kind CHECK (scope_kind IN (0, 1)),
                        CONSTRAINT ck_article_template_receipt_scope_revisions CHECK (
                            previous_scope_revision >= 0
                            AND scope_revision = previous_scope_revision + 1),
                        CONSTRAINT ck_article_template_receipt_template_revisions CHECK (
                            previous_template_revision >= 0
                            AND template_revision = previous_template_revision + 1),
                        CONSTRAINT ck_article_template_receipt_permission CHECK (permission BETWEEN 0 AND 2),
                        CONSTRAINT ck_article_template_receipt_status CHECK (status IN (0, 1, 2)),
                        CONSTRAINT ck_article_template_receipt_disposition CHECK (
                            delete_disposition IN (0, 1)),
                        CONSTRAINT ck_article_template_receipt_version_binding CHECK (
                            (version_id IS NULL) = (version_number IS NULL)
                            AND (version_number IS NULL OR version_number BETWEEN 1 AND 1000)),
                        CONSTRAINT ck_article_template_receipt_digests CHECK (
                            command_digest ~ '^[0-9a-f]{64}$'
                            AND permission_digest ~ '^[0-9a-f]{64}$'
                            AND defaults_digest ~ '^[0-9a-f]{64}$'
                            AND definition_digest ~ '^[0-9a-f]{64}$'
                            AND (version_digest = '' OR version_digest ~ '^[0-9a-f]{64}$')
                            AND audit_digest ~ '^[0-9a-f]{64}$'
                            AND content_digest ~ '^[0-9a-f]{64}$')
                    );
                    CREATE INDEX IF NOT EXISTS ix_article_template_receipt_template
                        ON article_template_receipt(template_id, template_revision, receipt_id);

                    CREATE TABLE IF NOT EXISTS article_template_idempotency (
                        actor_admin_principal_id bigint NOT NULL,
                        request_id uuid NOT NULL,
                        command_digest varchar(64) NOT NULL,
                        receipt_id uuid NOT NULL,
                        created_at_utc timestamp without time zone NOT NULL,
                        PRIMARY KEY (actor_admin_principal_id, request_id),
                        CONSTRAINT fk_article_template_idempotency_receipt
                            FOREIGN KEY (receipt_id) REFERENCES article_template_receipt(receipt_id)
                            ON DELETE RESTRICT,
                        CONSTRAINT ck_article_template_idempotency_actor CHECK (
                            actor_admin_principal_id > 0),
                        CONSTRAINT ck_article_template_idempotency_digest CHECK (
                            command_digest ~ '^[0-9a-f]{64}$')
                    );
                    CREATE INDEX IF NOT EXISTS ix_article_template_idempotency_receipt
                        ON article_template_idempotency(receipt_id);

                    CREATE TABLE IF NOT EXISTS article_template_version_usage (
                        template_id uuid NOT NULL,
                        version_id uuid NOT NULL,
                        article_id integer NOT NULL,
                        created_by_admin_principal_id bigint NOT NULL,
                        created_at_utc timestamp without time zone NOT NULL,
                        PRIMARY KEY (version_id, article_id),
                        CONSTRAINT ux_article_template_version_usage_article UNIQUE (article_id),
                        CONSTRAINT fk_article_template_version_usage_version
                            FOREIGN KEY (version_id) REFERENCES article_template_version(version_id)
                            ON DELETE RESTRICT,
                        CONSTRAINT fk_article_template_version_usage_template
                            FOREIGN KEY (template_id) REFERENCES article_template_definition(template_id)
                            ON DELETE RESTRICT,
                        CONSTRAINT ck_article_template_version_usage_article CHECK (article_id > 0),
                        CONSTRAINT ck_article_template_version_usage_actor CHECK (
                            created_by_admin_principal_id > 0)
                    );
                    CREATE INDEX IF NOT EXISTS ix_article_template_version_usage_template
                        ON article_template_version_usage(template_id);

                    CREATE OR REPLACE FUNCTION article_template_immutable_guard()
                    RETURNS trigger AS $$
                    BEGIN
                        RAISE EXCEPTION 'article_template_immutable_row';
                    END;
                    $$ LANGUAGE plpgsql;

                    DROP TRIGGER IF EXISTS trg_article_template_version_immutable
                        ON article_template_version;
                    CREATE TRIGGER trg_article_template_version_immutable
                        BEFORE UPDATE OR DELETE ON article_template_version
                        FOR EACH ROW EXECUTE FUNCTION article_template_immutable_guard();
                    DROP TRIGGER IF EXISTS trg_article_template_version_tag_immutable
                        ON article_template_version_tag;
                    CREATE TRIGGER trg_article_template_version_tag_immutable
                        BEFORE UPDATE OR DELETE ON article_template_version_tag
                        FOR EACH ROW EXECUTE FUNCTION article_template_immutable_guard();
                    DROP TRIGGER IF EXISTS trg_article_template_version_asset_immutable
                        ON article_template_version_asset;
                    CREATE TRIGGER trg_article_template_version_asset_immutable
                        BEFORE UPDATE OR DELETE ON article_template_version_asset
                        FOR EACH ROW EXECUTE FUNCTION article_template_immutable_guard();
                    DROP TRIGGER IF EXISTS trg_article_template_version_property_immutable
                        ON article_template_version_property_default;
                    CREATE TRIGGER trg_article_template_version_property_immutable
                        BEFORE UPDATE OR DELETE ON article_template_version_property_default
                        FOR EACH ROW EXECUTE FUNCTION article_template_immutable_guard();
                    DROP TRIGGER IF EXISTS trg_article_template_version_property_option_immutable
                        ON article_template_version_property_option;
                    CREATE TRIGGER trg_article_template_version_property_option_immutable
                        BEFORE UPDATE OR DELETE ON article_template_version_property_option
                        FOR EACH ROW EXECUTE FUNCTION article_template_immutable_guard();
                    DROP TRIGGER IF EXISTS trg_article_template_version_usage_immutable
                        ON article_template_version_usage;
                    CREATE TRIGGER trg_article_template_version_usage_immutable
                        BEFORE UPDATE OR DELETE ON article_template_version_usage
                        FOR EACH ROW EXECUTE FUNCTION article_template_immutable_guard();
                    DROP TRIGGER IF EXISTS trg_article_template_receipt_immutable
                        ON article_template_receipt;
                    CREATE TRIGGER trg_article_template_receipt_immutable
                        BEFORE UPDATE OR DELETE ON article_template_receipt
                        FOR EACH ROW EXECUTE FUNCTION article_template_immutable_guard();
                    DROP TRIGGER IF EXISTS trg_article_template_idempotency_immutable
                        ON article_template_idempotency;
                    CREATE TRIGGER trg_article_template_idempotency_immutable
                        BEFORE UPDATE OR DELETE ON article_template_idempotency
                        FOR EACH ROW EXECUTE FUNCTION article_template_immutable_guard();
                    """)
            ]);
}
