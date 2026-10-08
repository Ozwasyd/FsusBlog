namespace FsusBlog.Migration.Definitions;

internal static class ArticlePropertyValueMigrationDefinitions
{
    internal const string MigrationId = "20261008-post-article-property-value-snapshots";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Add typed article property facts and immutable article-owned snapshot bindings.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new RawSqlStep("""
                    CREATE TABLE IF NOT EXISTS article_property_value_factset (
                        factset_id uuid PRIMARY KEY,
                        schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
                        owner_user_key bigint NOT NULL CHECK (owner_user_key >= 0),
                        site_scope varchar(128) NOT NULL CHECK (site_scope = 'primary-site'),
                        article_id integer NOT NULL CHECK (article_id > 0),
                        property_revision bigint NOT NULL CHECK (property_revision > 0),
                        value_count integer NOT NULL CHECK (value_count BETWEEN 0 AND 1000),
                        content_digest varchar(64) NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
                        UNIQUE (owner_user_key, site_scope, article_id, property_revision)
                    );
                    CREATE TABLE IF NOT EXISTS article_property_value_entry (
                        factset_id uuid NOT NULL REFERENCES article_property_value_factset(factset_id),
                        definition_id uuid NOT NULL,
                        definition_schema_revision bigint NOT NULL CHECK (definition_schema_revision > 0),
                        definition_digest varchar(64) NOT NULL CHECK (definition_digest ~ '^[0-9a-f]{64}$'),
                        value_type smallint NOT NULL CHECK (value_type BETWEEN 0 AND 7),
                        presence smallint NOT NULL CHECK (presence BETWEEN 0 AND 2),
                        default_applied boolean NOT NULL,
                        value_digest varchar(64) NOT NULL CHECK (value_digest ~ '^[0-9a-f]{64}$'),
                        text_value text NULL,
                        number_value numeric NULL,
                        boolean_value boolean NULL,
                        date_utc_ticks bigint NULL CHECK (date_utc_ticks BETWEEN 0 AND 3155378975999999999),
                        single_option_id uuid NULL,
                        PRIMARY KEY (factset_id, definition_id),
                        CHECK (NOT default_applied OR presence <> 0),
                        CHECK (
                            (presence <> 2 AND text_value IS NULL AND number_value IS NULL
                                AND boolean_value IS NULL AND date_utc_ticks IS NULL AND single_option_id IS NULL)
                            OR (presence = 2 AND (
                                (value_type IN (0, 7) AND text_value IS NOT NULL AND number_value IS NULL
                                    AND boolean_value IS NULL AND date_utc_ticks IS NULL AND single_option_id IS NULL)
                                OR (value_type = 1 AND text_value IS NULL AND number_value IS NOT NULL
                                    AND boolean_value IS NULL AND date_utc_ticks IS NULL AND single_option_id IS NULL)
                                OR (value_type = 2 AND text_value IS NULL AND number_value IS NULL
                                    AND boolean_value IS NOT NULL AND date_utc_ticks IS NULL AND single_option_id IS NULL)
                                OR (value_type = 3 AND text_value IS NULL AND number_value IS NULL
                                    AND boolean_value IS NULL AND date_utc_ticks IS NOT NULL AND single_option_id IS NULL)
                                OR (value_type = 4 AND text_value IS NULL AND number_value IS NULL
                                    AND boolean_value IS NULL AND date_utc_ticks IS NULL AND single_option_id IS NOT NULL)
                                OR (value_type IN (5, 6) AND text_value IS NULL AND number_value IS NULL
                                    AND boolean_value IS NULL AND date_utc_ticks IS NULL AND single_option_id IS NULL)
                            ))
                        )
                    );
                    CREATE TABLE IF NOT EXISTS article_property_value_option (
                        factset_id uuid NOT NULL,
                        definition_id uuid NOT NULL,
                        position integer NOT NULL CHECK (position BETWEEN 0 AND 999),
                        option_id uuid NOT NULL,
                        PRIMARY KEY (factset_id, definition_id, position),
                        UNIQUE (factset_id, definition_id, option_id),
                        FOREIGN KEY (factset_id, definition_id)
                            REFERENCES article_property_value_entry(factset_id, definition_id)
                    );
                    CREATE TABLE IF NOT EXISTS article_property_value_reference (
                        factset_id uuid NOT NULL,
                        definition_id uuid NOT NULL,
                        position integer NOT NULL CHECK (position BETWEEN 0 AND 999),
                        target_article_id bigint NOT NULL CHECK (target_article_id > 0),
                        PRIMARY KEY (factset_id, definition_id, position),
                        UNIQUE (factset_id, definition_id, target_article_id),
                        FOREIGN KEY (factset_id, definition_id)
                            REFERENCES article_property_value_entry(factset_id, definition_id)
                    );
                    CREATE INDEX IF NOT EXISTS ix_article_property_value_target
                        ON article_property_value_reference(target_article_id, factset_id);
                    CREATE TABLE IF NOT EXISTS article_property_value_snapshot (
                        snapshot_id uuid PRIMARY KEY,
                        schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
                        factset_id uuid NOT NULL REFERENCES article_property_value_factset(factset_id),
                        article_revision_id bigint NOT NULL CHECK (article_revision_id > 0),
                        draft_id bigint NULL CHECK (draft_id > 0),
                        draft_server_revision bigint NULL CHECK (draft_server_revision > 0),
                        publication_id bigint NULL CHECK (publication_id > 0),
                        content_digest varchar(64) NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
                        audit_reference uuid NOT NULL,
                        audit_chain_id varchar(32) NOT NULL,
                        audit_record_hash varchar(64) NOT NULL CHECK (audit_record_hash ~ '^[0-9a-f]{64}$'),
                        CHECK ((draft_id IS NULL) = (draft_server_revision IS NULL)),
                        CHECK (draft_id IS NULL OR publication_id IS NULL)
                    );
                    CREATE UNIQUE INDEX IF NOT EXISTS ux_article_property_value_snapshot_coordinates
                        ON article_property_value_snapshot(factset_id, article_revision_id,
                            COALESCE(draft_id, 0), COALESCE(draft_server_revision, 0), COALESCE(publication_id, 0));
                    CREATE INDEX IF NOT EXISTS ix_article_property_value_revision
                        ON article_property_value_snapshot(article_revision_id, factset_id);
                    CREATE TABLE IF NOT EXISTS article_property_value_head (
                        owner_user_key bigint NOT NULL CHECK (owner_user_key >= 0),
                        site_scope varchar(128) NOT NULL CHECK (site_scope = 'primary-site'),
                        article_id integer NOT NULL CHECK (article_id > 0),
                        property_revision bigint NOT NULL CHECK (property_revision > 0),
                        snapshot_id uuid NOT NULL REFERENCES article_property_value_snapshot(snapshot_id),
                        PRIMARY KEY (owner_user_key, site_scope, article_id)
                    );
                    CREATE TABLE IF NOT EXISTS article_property_value_receipt (
                        receipt_id uuid PRIMARY KEY,
                        actor_admin_principal_id bigint NOT NULL CHECK (actor_admin_principal_id > 0),
                        request_id uuid NOT NULL,
                        owner_user_key bigint NOT NULL CHECK (owner_user_key >= 0),
                        site_scope varchar(128) NOT NULL CHECK (site_scope = 'primary-site'),
                        article_id integer NOT NULL CHECK (article_id > 0),
                        expected_article_revision_id bigint NOT NULL CHECK (expected_article_revision_id > 0),
                        before_property_revision bigint NOT NULL CHECK (before_property_revision >= 0),
                        after_property_revision bigint NOT NULL CHECK (after_property_revision = before_property_revision + 1),
                        before_snapshot_id uuid NULL REFERENCES article_property_value_snapshot(snapshot_id),
                        after_snapshot_id uuid NOT NULL REFERENCES article_property_value_snapshot(snapshot_id),
                        command_kind smallint NOT NULL CHECK (command_kind BETWEEN 0 AND 1),
                        command_digest varchar(64) NOT NULL CHECK (command_digest ~ '^[0-9a-f]{64}$'),
                        content_digest varchar(64) NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
                        audit_reference uuid NOT NULL,
                        audit_chain_id varchar(32) NOT NULL,
                        audit_record_hash varchar(64) NOT NULL CHECK (audit_record_hash ~ '^[0-9a-f]{64}$'),
                        occurred_at_utc timestamp without time zone NOT NULL,
                        UNIQUE (actor_admin_principal_id, request_id)
                    );
                    """)
            ]);
}
