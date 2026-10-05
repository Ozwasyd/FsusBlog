namespace FsusBlog.Migration.Definitions;

internal static class ArticlePropertyDefinitionAuthorityMigrationDefinitions
{
    internal const string MigrationId = "20260915-post-article-property-definition-authority";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Add the exact-one article PropertyDefinition authority with closed typed schema facts, options, policies, CAS receipts and idempotency.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new RawSqlStep("""
                    CREATE TABLE IF NOT EXISTS article_property_definition_owner (
                        owner_user_id bigint NOT NULL,
                        site_scope varchar(128) NOT NULL,
                        revision bigint NOT NULL DEFAULT 0,
                        PRIMARY KEY (owner_user_id, site_scope),
                        CONSTRAINT ck_article_property_owner_user CHECK (owner_user_id >= 0),
                        CONSTRAINT ck_article_property_owner_scope CHECK (char_length(site_scope) BETWEEN 1 AND 128),
                        CONSTRAINT ck_article_property_owner_revision CHECK (revision >= 0)
                    );

                    CREATE TABLE IF NOT EXISTS article_property_definition (
                        schema_version integer NOT NULL,
                        definition_id uuid NOT NULL,
                        owner_user_id bigint NOT NULL,
                        site_scope varchar(128) NOT NULL,
                        machine_key varchar(64) NOT NULL,
                        value_type smallint NOT NULL,
                        cardinality smallint NOT NULL,
                        required boolean NOT NULL,
                        missing_behavior smallint NOT NULL,
                        null_behavior smallint NOT NULL,
                        empty_behavior smallint NOT NULL,
                        default_kind smallint NOT NULL,
                        default_scalar varchar(16384) NULL,
                        default_option_ids varchar(32768) NOT NULL DEFAULT '',
                        default_article_ids varchar(32768) NOT NULL DEFAULT '',
                        min_length integer NULL,
                        max_length integer NULL,
                        min_number numeric NULL,
                        max_number numeric NULL,
                        min_date_utc_ticks bigint NULL CHECK (min_date_utc_ticks BETWEEN 0 AND 3155378975999999999),
                        max_date_utc_ticks bigint NULL CHECK (max_date_utc_ticks BETWEEN 0 AND 3155378975999999999),
                        min_items integer NULL,
                        max_items integer NULL,
                        reference_cardinality smallint NULL,
                        reference_permission smallint NULL,
                        allow_cross_site boolean NULL,
                        allow_deleted boolean NULL,
                        allow_archived boolean NULL,
                        allow_self_reference boolean NULL,
                        allow_cycles boolean NULL,
                        url_allowed_schemes varchar(128) NOT NULL DEFAULT '',
                        url_allow_relative boolean NULL,
                        url_allow_absolute boolean NULL,
                        url_max_length integer NULL,
                        url_normalization smallint NULL,
                        search_eligible boolean NOT NULL,
                        filterable boolean NOT NULL,
                        sortable boolean NOT NULL,
                        display_placement smallint NOT NULL,
                        visibility_scope smallint NOT NULL,
                        status smallint NOT NULL,
                        schema_revision bigint NOT NULL,
                        created_at_utc timestamp without time zone NOT NULL,
                        updated_at_utc timestamp without time zone NOT NULL,
                        content_digest varchar(64) NOT NULL,
                        PRIMARY KEY (definition_id),
                        CONSTRAINT fk_article_property_definition_owner
                            FOREIGN KEY (owner_user_id, site_scope)
                            REFERENCES article_property_definition_owner(owner_user_id, site_scope)
                            ON DELETE RESTRICT,
                        CONSTRAINT ck_article_property_definition_schema CHECK (schema_version = 1),
                        CONSTRAINT ck_article_property_definition_owner CHECK (owner_user_id >= 0),
                        CONSTRAINT ck_article_property_definition_key CHECK (char_length(machine_key) BETWEEN 1 AND 64),
                        CONSTRAINT ck_article_property_definition_type CHECK (value_type BETWEEN 0 AND 7),
                        CONSTRAINT ck_article_property_definition_cardinality CHECK (cardinality BETWEEN 0 AND 1),
                        CONSTRAINT ck_article_property_definition_status CHECK (status BETWEEN 0 AND 2),
                        CONSTRAINT ck_article_property_definition_revision CHECK (schema_revision >= 1),
                        CONSTRAINT ck_article_property_definition_digest CHECK (content_digest ~ '^[0-9a-f]{64}$')
                    );
                    CREATE UNIQUE INDEX IF NOT EXISTS ux_article_property_definition_live_key
                        ON article_property_definition(owner_user_id, site_scope, machine_key)
                        WHERE status <> 2;
                    CREATE INDEX IF NOT EXISTS ix_article_property_definition_page
                        ON article_property_definition(owner_user_id, site_scope, machine_key, definition_id)
                        WHERE status <> 2;

                    CREATE TABLE IF NOT EXISTS article_property_definition_display_name (
                        definition_id uuid NOT NULL,
                        locale varchar(32) NOT NULL,
                        value varchar(256) NOT NULL,
                        PRIMARY KEY (definition_id, locale),
                        CONSTRAINT fk_article_property_display_name_definition
                            FOREIGN KEY (definition_id) REFERENCES article_property_definition(definition_id)
                            ON DELETE RESTRICT
                    );

                    CREATE TABLE IF NOT EXISTS article_property_definition_option (
                        definition_id uuid NOT NULL,
                        option_id uuid NOT NULL,
                        label varchar(256) NOT NULL,
                        option_order integer NOT NULL,
                        status smallint NOT NULL,
                        PRIMARY KEY (definition_id, option_id),
                        CONSTRAINT fk_article_property_option_definition
                            FOREIGN KEY (definition_id) REFERENCES article_property_definition(definition_id)
                            ON DELETE RESTRICT,
                        CONSTRAINT ck_article_property_option_order CHECK (option_order >= 0),
                        CONSTRAINT ck_article_property_option_status CHECK (status BETWEEN 0 AND 2),
                        CONSTRAINT ux_article_property_option_order UNIQUE (definition_id, option_order)
                    );

                    CREATE TABLE IF NOT EXISTS article_property_definition_option_label (
                        definition_id uuid NOT NULL,
                        option_id uuid NOT NULL,
                        locale varchar(32) NOT NULL,
                        value varchar(256) NOT NULL,
                        PRIMARY KEY (definition_id, option_id, locale),
                        CONSTRAINT fk_article_property_option_label_option
                            FOREIGN KEY (definition_id, option_id)
                            REFERENCES article_property_definition_option(definition_id, option_id)
                            ON DELETE RESTRICT
                    );

                    CREATE TABLE IF NOT EXISTS article_property_definition_receipt (
                        receipt_id uuid PRIMARY KEY,
                        request_id uuid NOT NULL,
                        actor_admin_principal_id bigint NOT NULL,
                        owner_user_id bigint NOT NULL,
                        site_scope varchar(128) NOT NULL,
                        command_kind varchar(32) NOT NULL,
                        command_digest varchar(64) NOT NULL,
                        definition_id uuid NOT NULL,
                        previous_owner_revision bigint NOT NULL,
                        owner_revision bigint NOT NULL,
                        previous_schema_revision bigint NOT NULL,
                        schema_revision bigint NOT NULL,
                        status smallint NOT NULL,
                        before_definition_digest varchar(64) NOT NULL,
                        after_definition_digest varchar(64) NOT NULL,
                        constraint_digest varchar(64) NOT NULL,
                        options_digest varchar(64) NOT NULL,
                        policy_digest varchar(64) NOT NULL,
                        flags_digest varchar(64) NOT NULL,
                        audit_reference uuid NOT NULL,
                        audit_digest varchar(64) NOT NULL,
                        content_digest varchar(64) NOT NULL,
                        occurred_at_utc timestamp without time zone NOT NULL,
                        CONSTRAINT fk_article_property_receipt_definition
                            FOREIGN KEY (definition_id) REFERENCES article_property_definition(definition_id)
                            ON DELETE RESTRICT,
                        CONSTRAINT ck_article_property_receipt_revision CHECK (
                            owner_revision = previous_owner_revision + 1
                            AND schema_revision = previous_schema_revision + 1),
                        CONSTRAINT ck_article_property_receipt_digest CHECK (
                            command_digest ~ '^[0-9a-f]{64}$'
                            AND content_digest ~ '^[0-9a-f]{64}$')
                    );
                    CREATE UNIQUE INDEX IF NOT EXISTS ux_article_property_receipt_revision
                        ON article_property_definition_receipt(definition_id, schema_revision);
                    CREATE INDEX IF NOT EXISTS ix_article_property_receipt_owner
                        ON article_property_definition_receipt(owner_user_id, site_scope, owner_revision);

                    CREATE TABLE IF NOT EXISTS article_property_definition_obligation (
                        receipt_id uuid NOT NULL,
                        obligation_index integer NOT NULL,
                        kind varchar(96) NOT NULL,
                        affected_value_count bigint NULL,
                        requires_reconciliation boolean NOT NULL,
                        reason_code varchar(128) NOT NULL,
                        PRIMARY KEY (receipt_id, obligation_index),
                        CONSTRAINT fk_article_property_obligation_receipt
                            FOREIGN KEY (receipt_id) REFERENCES article_property_definition_receipt(receipt_id)
                            ON DELETE RESTRICT,
                        CONSTRAINT ck_article_property_obligation_index CHECK (obligation_index >= 0),
                        CONSTRAINT ck_article_property_obligation_count CHECK (affected_value_count IS NULL OR affected_value_count >= 0)
                    );

                    CREATE TABLE IF NOT EXISTS article_property_definition_idempotency (
                        actor_admin_principal_id bigint NOT NULL,
                        request_id uuid NOT NULL,
                        command_digest varchar(64) NOT NULL,
                        receipt_id uuid NOT NULL,
                        created_at_utc timestamp without time zone NOT NULL,
                        PRIMARY KEY (actor_admin_principal_id, request_id),
                        CONSTRAINT fk_article_property_idempotency_receipt
                            FOREIGN KEY (receipt_id) REFERENCES article_property_definition_receipt(receipt_id)
                            ON DELETE RESTRICT,
                        CONSTRAINT ck_article_property_idempotency_digest CHECK (command_digest ~ '^[0-9a-f]{64}$')
                    );
                    """)
            ]);
}
