using SqlSugar;

namespace FsusBlog.Server.Infrastructure.SchemaMigration;

internal sealed record CurrentSchemaRuntimeRollupTable(
    string TableName,
    string CreateSql,
    IReadOnlyList<string>? AdditionalSql = null);

// PostCodeFirst runtime tables that production already has from migration steps.
// The Server cannot reference the migration assembly, so this catalog owns the
// same CREATE TABLE / INDEX SQL and the verifier requires the tables instead of
// leaving them on the optional extra allowlist. Entries are ordered so foreign
// key parents materialize before dependents.
internal static class CurrentSchemaRuntimeRollupTables
{
    internal static IReadOnlyList<CurrentSchemaRuntimeRollupTable> Tables
    {
        get;
    } =
    [
        .. ArticlePropertyValueRuntimeTables.Tables,
        .. AuthoringWorkspaceSnapshotRuntimeTables.Tables,
        new(
            "daily_read_stats",
            """
            CREATE TABLE IF NOT EXISTS daily_read_stats (
                stat_date date PRIMARY KEY,
                total_reads bigint NOT NULL DEFAULT 0,
                human_verified_reads bigint NOT NULL DEFAULT 0,
                unique_viewer_estimate bigint NOT NULL DEFAULT 0,
                updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
            );
            """),
        new(
            "region_read_stats",
            """
            CREATE TABLE IF NOT EXISTS region_read_stats (
                region varchar(128) PRIMARY KEY,
                read_count bigint NOT NULL DEFAULT 0,
                updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
            );
            """),
        new(
            "event_type_read_stats",
            """
            CREATE TABLE IF NOT EXISTS event_type_read_stats (
                event_type varchar(32) PRIMARY KEY,
                read_count bigint NOT NULL DEFAULT 0,
                updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
            );
            """),
        new(
            "author_daily_read_stats",
            """
            CREATE TABLE IF NOT EXISTS author_daily_read_stats (
                stat_date date PRIMARY KEY,
                total_reads bigint NOT NULL DEFAULT 0,
                article_reads bigint NOT NULL DEFAULT 0,
                completed_article_reads bigint NOT NULL DEFAULT 0,
                dwell_ms_total bigint NOT NULL DEFAULT 0,
                updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
            );
            """),
        new(
            "author_route_stats",
            """
            CREATE TABLE IF NOT EXISTS author_route_stats (
                metric_kind varchar(32) NOT NULL,
                label varchar(128) NOT NULL,
                event_count integer NOT NULL DEFAULT 0,
                updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
                PRIMARY KEY (metric_kind, label)
            );
            """),
        new(
            "author_rum_stats",
            """
            CREATE TABLE IF NOT EXISTS author_rum_stats (
                name varchar(64) PRIMARY KEY,
                event_count integer NOT NULL DEFAULT 0,
                p75 double precision NOT NULL DEFAULT 0,
                average double precision NOT NULL DEFAULT 0,
                updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
            );
            """),
        new(
            "author_rum_page_type_stats",
            """
            CREATE TABLE IF NOT EXISTS author_rum_page_type_stats (
                page_type varchar(32) PRIMARY KEY,
                event_count integer NOT NULL DEFAULT 0,
                updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
            );
            """),
        new(
            "author_rum_aot_source_stats",
            """
            CREATE TABLE IF NOT EXISTS author_rum_aot_source_stats (
                aot_source varchar(32) PRIMARY KEY,
                event_count integer NOT NULL DEFAULT 0,
                updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
            );
            """),
        new(
            "author_aot_stats",
            """
            CREATE TABLE IF NOT EXISTS author_aot_stats (
                metric_kind varchar(32) PRIMARY KEY,
                event_count bigint NOT NULL DEFAULT 0,
                updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
            );
            """),
        new(
            "sys_deployment_fence",
            """
            CREATE TABLE IF NOT EXISTS sys_deployment_fence (
                id smallint PRIMARY KEY,
                release_id varchar(96) NOT NULL,
                slot varchar(24) NOT NULL,
                generation bigint NOT NULL,
                image_digest varchar(160) NOT NULL,
                status varchar(24) NOT NULL,
                activated_at_utc timestamp NULL,
                revoked_at_utc timestamp NULL,
                updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
                CONSTRAINT ck_sys_deployment_fence_singleton CHECK (id = 1),
                CONSTRAINT ck_sys_deployment_fence_generation CHECK (generation > 0),
                CONSTRAINT ck_sys_deployment_fence_status CHECK (status IN ('active', 'revoked'))
            );
            """),
        new(
            "sys_fenced_commit",
            """
            CREATE TABLE IF NOT EXISTS sys_fenced_commit (
                commit_token varchar(32) PRIMARY KEY,
                operation_scope varchar(96) NOT NULL,
                mutation_key varchar(192) NOT NULL,
                release_id varchar(96) NOT NULL,
                slot varchar(24) NOT NULL,
                generation bigint NOT NULL,
                image_digest varchar(160) NOT NULL,
                process_instance_id varchar(192) NOT NULL,
                enlisted_at_utc timestamp NOT NULL DEFAULT (clock_timestamp() AT TIME ZONE 'utc'),
                CONSTRAINT ck_sys_fenced_commit_generation CHECK (generation > 0)
            );
            """,
            AdditionalSql:
            [
                """
                CREATE INDEX IF NOT EXISTS idx_sys_fenced_commit_enlisted
                ON sys_fenced_commit(enlisted_at_utc DESC, commit_token);
                """,
                """
                CREATE INDEX IF NOT EXISTS idx_sys_fenced_commit_generation_time
                ON sys_fenced_commit(generation, enlisted_at_utc DESC);
                """,
            ]),
        new(
            "public_article_projection",
            """
            CREATE TABLE IF NOT EXISTS public_article_projection (
                article_id integer PRIMARY KEY,
                version bigint NOT NULL,
                visible boolean NOT NULL,
                aeds_payload bytea NULL,
                etag varchar(68) NULL,
                content_hash varchar(64) NULL,
                unavailable_reason varchar(96) NULL,
                updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
                projection_schema_version integer NOT NULL DEFAULT 1,
                CONSTRAINT ck_public_article_projection_payload
                    CHECK (
                        (visible = true AND aeds_payload IS NOT NULL AND etag IS NOT NULL AND content_hash IS NOT NULL)
                        OR
                        (visible = false AND aeds_payload IS NULL AND etag IS NULL AND content_hash IS NULL)
                    )
            );
            """,
            AdditionalSql:
            [
                """
                CREATE SEQUENCE IF NOT EXISTS public_article_projection_version_seq AS bigint;
                """,
                """
                CREATE INDEX IF NOT EXISTS idx_public_article_projection_visible_id ON public_article_projection(article_id) WHERE visible = true;
                """,
                """
                CREATE INDEX IF NOT EXISTS idx_public_article_projection_updated ON public_article_projection(updated_at_utc, article_id);
                """,
                """
                INSERT INTO public_article_projection_backfill(scope, state, last_article_id, rate_per_second)
                VALUES (
                    'global',
                    'paused',
                    0,
                    GREATEST(1, LEAST(1000, current_setting('max_connections')::integer / 8)))
                ON CONFLICT (scope) DO NOTHING;
                """,
                """
                CREATE INDEX IF NOT EXISTS idx_public_article_projection_shadow_article_time ON public_article_projection_shadow_mismatch(article_id, observed_at_utc DESC);
                """,
            ]),
        new(
            "public_article_projection_backfill",
            """
            CREATE TABLE IF NOT EXISTS public_article_projection_backfill (
                scope varchar(32) PRIMARY KEY,
                state varchar(16) NOT NULL DEFAULT 'paused',
                last_article_id integer NOT NULL DEFAULT 0,
                rate_per_second integer NOT NULL DEFAULT GREATEST(
                    1,
                    LEAST(1000, current_setting('max_connections')::integer / 8)),
                rebuilt_count bigint NOT NULL DEFAULT 0,
                failed_count bigint NOT NULL DEFAULT 0,
                updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
                CONSTRAINT ck_public_article_projection_backfill_state
                    CHECK (state IN ('paused', 'running', 'completed')),
                CONSTRAINT ck_public_article_projection_backfill_rate
                    CHECK (rate_per_second BETWEEN 1 AND 1000)
            );
            """),
        new(
            "public_article_projection_shadow_mismatch",
            """
            CREATE TABLE IF NOT EXISTS public_article_projection_shadow_mismatch (
                id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                article_id integer NOT NULL,
                expected_hash varchar(64) NOT NULL,
                actual_hash varchar(64) NULL,
                projection_version bigint NULL,
                reason varchar(96) NOT NULL,
                observed_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
            );
            """),
        new(
            "plugin_registry",
            """
            CREATE TABLE IF NOT EXISTS plugin_registry (
                id varchar(128) PRIMARY KEY,
                name varchar(128) NOT NULL,
                plugin_version varchar(64) NOT NULL,
                runtime_type varchar(32) NOT NULL,
                manifest_json jsonb NOT NULL,
                install_state integer NOT NULL,
                enabled boolean NOT NULL,
                package_bytes bytea NOT NULL,
                package_sha256 bytea NOT NULL,
                installed_at_utc timestamp NOT NULL,
                updated_at_utc timestamp NOT NULL,
                version bigint NOT NULL,
                CONSTRAINT ck_plugin_registry_id
                    CHECK (id ~ '^[a-z0-9]+([.-][a-z0-9]+){2,}$'),
                CONSTRAINT ck_plugin_registry_install_state
                    CHECK (install_state BETWEEN 0 AND 6),
                CONSTRAINT ck_plugin_registry_enabled_state
                    CHECK ((enabled AND install_state = 2) OR (NOT enabled AND install_state <> 2)),
                CONSTRAINT ck_plugin_registry_sha256
                    CHECK (octet_length(package_sha256) = 32),
                CONSTRAINT ck_plugin_registry_version
                    CHECK (version > 0),
                CONSTRAINT ck_plugin_registry_uninstalled_package
                    CHECK (install_state <> 6 OR octet_length(package_bytes) = 0)
            );
            """,
            AdditionalSql:
            [
                """
                CREATE INDEX IF NOT EXISTS idx_plugin_registry_runtime_state ON plugin_registry(runtime_type, install_state, id);
                """,
                """
                CREATE INDEX IF NOT EXISTS idx_plugin_registry_updated ON plugin_registry(updated_at_utc, id);
                """,
            ]),
        new(
            "article_create_request",
            """
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
            """,
            AdditionalSql:
            [
                """
                CREATE INDEX IF NOT EXISTS ix_article_create_receipt_owner
                    ON article_create_receipt(owner_admin_principal_id, occurred_at_utc);
                """,
                """
                CREATE INDEX IF NOT EXISTS ix_article_create_receipt_template
                    ON article_create_receipt(template_id, template_version_id)
                    WHERE template_id IS NOT NULL;
                """,
                """
                CREATE OR REPLACE FUNCTION article_create_immutable_guard()
                RETURNS trigger AS $$
                BEGIN
                    RAISE EXCEPTION 'article_create_immutable_row';
                END;
                $$ LANGUAGE plpgsql;
                """,
                """
                DROP TRIGGER IF EXISTS trg_article_create_request_immutable
                    ON article_create_request;
                """,
                """
                CREATE TRIGGER trg_article_create_request_immutable
                    BEFORE UPDATE OR DELETE ON article_create_request
                    FOR EACH ROW EXECUTE FUNCTION article_create_immutable_guard();
                """,
                """
                DROP TRIGGER IF EXISTS trg_article_create_receipt_immutable
                    ON article_create_receipt;
                """,
                """
                CREATE TRIGGER trg_article_create_receipt_immutable
                    BEFORE UPDATE OR DELETE ON article_create_receipt
                    FOR EACH ROW EXECUTE FUNCTION article_create_immutable_guard();
                """,
            ]),
        new(
            "article_create_receipt",
            """
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
                    create_mode IN ('blank', 'template', 'inbox')),
                CONSTRAINT ck_article_create_receipt_template_set CHECK (
                    (create_mode = 'template'
                        AND template_id IS NOT NULL
                        AND template_version_id IS NOT NULL
                        AND template_version_number IS NOT NULL
                        AND plan_digest IS NOT NULL
                        AND defaults_digest IS NOT NULL
                        AND reference_digest IS NOT NULL)
                    OR (create_mode IN ('blank', 'inbox')
                        AND template_id IS NULL
                        AND template_version_id IS NULL
                        AND template_version_number IS NULL
                        AND plan_digest IS NULL
                        AND defaults_digest IS NULL
                        AND reference_digest IS NULL)),
                CONSTRAINT ck_article_create_receipt_draft_only CHECK (
                    (create_mode IN ('blank', 'template') AND status = 'draft')
                    OR (create_mode = 'inbox' AND status = 'inbox')),
                CONSTRAINT ck_article_create_receipt_identity CHECK (
                    article_id > 0 AND draft_id > 0 AND revision_id > 0
                    AND revision_no = 1 AND draft_server_revision >= 1),
                CONSTRAINT ck_article_create_receipt_digests CHECK (
                    plan_digest IS NULL OR plan_digest ~ '^[0-9a-f]{64}$')
            );
            """),
        new(
            "article_template_scope",
            """
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
            """,
            AdditionalSql:
            [
                """
                CREATE UNIQUE INDEX IF NOT EXISTS ux_article_template_definition_live_name
                    ON article_template_definition(scope_kind, owner_admin_principal_id, name_key)
                    WHERE status <> 2;
                """,
                """
                CREATE INDEX IF NOT EXISTS ix_article_template_definition_page
                    ON article_template_definition(
                        scope_kind, owner_admin_principal_id, name_key, template_id)
                    WHERE status <> 2;
                """,
                """
                CREATE INDEX IF NOT EXISTS ix_article_template_version_template
                    ON article_template_version(template_id, version_number DESC);
                """,
                """
                CREATE INDEX IF NOT EXISTS ix_article_template_receipt_template
                    ON article_template_receipt(template_id, template_revision, receipt_id);
                """,
                """
                CREATE INDEX IF NOT EXISTS ix_article_template_idempotency_receipt
                    ON article_template_idempotency(receipt_id);
                """,
                """
                CREATE INDEX IF NOT EXISTS ix_article_template_version_usage_template
                    ON article_template_version_usage(template_id);
                """,
                """
                CREATE OR REPLACE FUNCTION article_template_immutable_guard()
                RETURNS trigger AS $$
                BEGIN
                    RAISE EXCEPTION 'article_template_immutable_row';
                END;
                $$ LANGUAGE plpgsql;
                """,
                """
                DROP TRIGGER IF EXISTS trg_article_template_version_immutable
                    ON article_template_version;
                """,
                """
                CREATE TRIGGER trg_article_template_version_immutable
                    BEFORE UPDATE OR DELETE ON article_template_version
                    FOR EACH ROW EXECUTE FUNCTION article_template_immutable_guard();
                """,
                """
                DROP TRIGGER IF EXISTS trg_article_template_version_tag_immutable
                    ON article_template_version_tag;
                """,
                """
                CREATE TRIGGER trg_article_template_version_tag_immutable
                    BEFORE UPDATE OR DELETE ON article_template_version_tag
                    FOR EACH ROW EXECUTE FUNCTION article_template_immutable_guard();
                """,
                """
                DROP TRIGGER IF EXISTS trg_article_template_version_asset_immutable
                    ON article_template_version_asset;
                """,
                """
                CREATE TRIGGER trg_article_template_version_asset_immutable
                    BEFORE UPDATE OR DELETE ON article_template_version_asset
                    FOR EACH ROW EXECUTE FUNCTION article_template_immutable_guard();
                """,
                """
                DROP TRIGGER IF EXISTS trg_article_template_version_property_immutable
                    ON article_template_version_property_default;
                """,
                """
                CREATE TRIGGER trg_article_template_version_property_immutable
                    BEFORE UPDATE OR DELETE ON article_template_version_property_default
                    FOR EACH ROW EXECUTE FUNCTION article_template_immutable_guard();
                """,
                """
                DROP TRIGGER IF EXISTS trg_article_template_version_property_option_immutable
                    ON article_template_version_property_option;
                """,
                """
                CREATE TRIGGER trg_article_template_version_property_option_immutable
                    BEFORE UPDATE OR DELETE ON article_template_version_property_option
                    FOR EACH ROW EXECUTE FUNCTION article_template_immutable_guard();
                """,
                """
                DROP TRIGGER IF EXISTS trg_article_template_version_usage_immutable
                    ON article_template_version_usage;
                """,
                """
                CREATE TRIGGER trg_article_template_version_usage_immutable
                    BEFORE UPDATE OR DELETE ON article_template_version_usage
                    FOR EACH ROW EXECUTE FUNCTION article_template_immutable_guard();
                """,
                """
                DROP TRIGGER IF EXISTS trg_article_template_receipt_immutable
                    ON article_template_receipt;
                """,
                """
                CREATE TRIGGER trg_article_template_receipt_immutable
                    BEFORE UPDATE OR DELETE ON article_template_receipt
                    FOR EACH ROW EXECUTE FUNCTION article_template_immutable_guard();
                """,
                """
                DROP TRIGGER IF EXISTS trg_article_template_idempotency_immutable
                    ON article_template_idempotency;
                """,
                """
                CREATE TRIGGER trg_article_template_idempotency_immutable
                    BEFORE UPDATE OR DELETE ON article_template_idempotency
                    FOR EACH ROW EXECUTE FUNCTION article_template_immutable_guard();
                """,
            ]),
        new(
            "article_template_definition",
            """
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
            """),
        new(
            "article_template_version",
            """
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
            """),
        new(
            "article_template_version_tag",
            """
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
            """),
        new(
            "article_template_version_asset",
            """
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
            """),
        new(
            "article_template_version_property_default",
            """
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
            """),
        new(
            "article_template_version_property_option",
            """
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
            """),
        new(
            "article_template_receipt",
            """
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
            """),
        new(
            "article_template_idempotency",
            """
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
            """),
        new(
            "article_template_version_usage",
            """
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
            """),
        new(
            "author_article_pin_collection",
            """
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
            """,
            AdditionalSql:
            [
                """
                CREATE INDEX IF NOT EXISTS ix_author_article_pin_order
                    ON author_article_pin(owner_admin_principal_id, site_scope, order_key, pin_id);
                """,
                """
                CREATE INDEX IF NOT EXISTS ix_author_article_pin_article
                    ON author_article_pin(article_id, owner_admin_principal_id, site_scope);
                """,
                """
                CREATE INDEX IF NOT EXISTS ix_author_article_pin_receipt_owner
                    ON author_article_pin_receipt(
                        owner_admin_principal_id, site_scope, revision DESC, created_at_utc DESC, receipt_id);
                """,
                """
                CREATE INDEX IF NOT EXISTS ix_author_article_pin_idempotency_created
                    ON author_article_pin_idempotency(created_at_utc, owner_admin_principal_id, site_scope);
                """,
            ]),
        new(
            "author_article_pin",
            """
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
            """),
        new(
            "author_article_pin_receipt",
            """
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
            """),
        new(
            "author_article_pin_idempotency",
            """
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
            """),
        new(
            "author_recent_history_collection",
            """
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
            """),
        new(
            "author_recent_history_entry",
            """
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
            """,
            AdditionalSql:
            [
                """
                CREATE INDEX IF NOT EXISTS ix_author_recent_history_entry_order
                    ON author_recent_history_entry(
                        owner_admin_principal_id, site_scope,
                        GREATEST(last_opened_at_utc, last_edited_at_utc, last_activated_at_utc) DESC,
                        article_id DESC);
                """
            ]),
        new(
            "author_recent_history_receipt",
            """
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
            """,
            AdditionalSql:
            [
                """
                CREATE INDEX IF NOT EXISTS ix_author_recent_history_receipt_revision
                    ON author_recent_history_receipt(
                        owner_admin_principal_id, site_scope, revision, receipt_id);
                """
            ]),
        new(
            "author_recent_history_idempotency",
            """
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
            """,
            AdditionalSql:
            [
                """
                CREATE INDEX IF NOT EXISTS ix_author_recent_history_idempotency_created
                    ON author_recent_history_idempotency(created_at_utc);
                """
            ]),
        new(
            "author_recent_history_outbox",
            """
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
            """,
            AdditionalSql:
            [
                """
                CREATE UNIQUE INDEX IF NOT EXISTS ux_author_recent_history_outbox_receipt
                    ON author_recent_history_outbox(receipt_id);
                """
            ]),
        new(
            "author_recent_history_audit",
            """
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
            """,
            AdditionalSql:
            [
                """
                CREATE UNIQUE INDEX IF NOT EXISTS ux_author_recent_history_audit_receipt
                    ON author_recent_history_audit(receipt_id);
                """
            ]),
        new(
            "author_saved_view_collection",
            """
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
            """,
            AdditionalSql:
            [
                """
                CREATE UNIQUE INDEX IF NOT EXISTS ux_author_saved_view_active_name
                    ON author_saved_view(owner_admin_principal_id, site_scope, name_key)
                    WHERE lifecycle_state = 0;
                """,
                """
                CREATE INDEX IF NOT EXISTS ix_author_saved_view_page
                    ON author_saved_view(
                        owner_admin_principal_id, site_scope, lifecycle_state, pinned DESC, order_key, id);
                """,
                """
                CREATE UNIQUE INDEX IF NOT EXISTS ux_author_saved_view_receipt_revision
                    ON author_saved_view_receipt(
                        owner_admin_principal_id, site_scope, collection_revision);
                """,
                """
                CREATE INDEX IF NOT EXISTS ix_author_saved_view_receipt_owner
                    ON author_saved_view_receipt(
                        owner_admin_principal_id, site_scope, collection_revision DESC, occurred_at_utc DESC);
                """,
                """
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
                """,
            ]),
        new(
            "author_saved_view",
            """
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
            """),
        new(
            "author_saved_view_condition",
            """
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
            """),
        new(
            "author_saved_view_condition_value",
            """
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
            """),
        new(
            "author_saved_view_projection",
            """
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
            """),
        new(
            "author_saved_view_receipt",
            """
            CREATE TABLE IF NOT EXISTS author_saved_view_receipt (
                receipt_id uuid PRIMARY KEY,
                request_id uuid NOT NULL,
                owner_admin_principal_id bigint NOT NULL,
                site_scope varchar(128) NOT NULL,
                view_id uuid NOT NULL,
                command_kind varchar(32) NOT NULL,
                command_digest varchar(64) NOT NULL,
                view_revision bigint NOT NULL,
                previous_collection_revision bigint NOT NULL,
                collection_revision bigint NOT NULL,
                query_digest varchar(64) NOT NULL,
                dependency_digest varchar(64) NOT NULL,
                pinned boolean NOT NULL,
                previous_default_view_id uuid NULL,
                default_view_id uuid NULL,
                previous_active_view_count integer NOT NULL,
                active_view_count integer NOT NULL,
                order_key bigint NOT NULL,
                lifecycle_state smallint NOT NULL,
                default_transition smallint NOT NULL,
                change_count integer NOT NULL,
                changes_digest varchar(64) NOT NULL,
                reason_code varchar(64) NOT NULL,
                content_digest varchar(64) NOT NULL,
                occurred_at_utc timestamp without time zone NOT NULL,
                CONSTRAINT ck_author_saved_view_receipt_revisions CHECK (
                    view_revision >= 0
                    AND previous_collection_revision >= 0
                    AND collection_revision = previous_collection_revision + 1),
                CONSTRAINT ck_author_saved_view_receipt_counts CHECK (
                    previous_active_view_count BETWEEN 0 AND 1000
                    AND active_view_count BETWEEN 0 AND 1000
                    AND change_count BETWEEN 0 AND 1000),
                CONSTRAINT ck_author_saved_view_receipt_lifecycle CHECK (lifecycle_state IN (0, 1)),
                CONSTRAINT ck_author_saved_view_receipt_default_transition CHECK (
                    default_transition BETWEEN 0 AND 3),
                CONSTRAINT ck_author_saved_view_receipt_digests CHECK (
                    command_digest ~ '^[0-9a-f]{64}$'
                    AND (query_digest = '' OR query_digest ~ '^[0-9a-f]{64}$')
                    AND (dependency_digest = '' OR dependency_digest ~ '^[0-9a-f]{64}$')
                    AND changes_digest ~ '^[0-9a-f]{64}$'
                    AND content_digest ~ '^[0-9a-f]{64}$')
            );
            """),
        new(
            "author_saved_view_receipt_change",
            """
            CREATE TABLE IF NOT EXISTS author_saved_view_receipt_change (
                receipt_id uuid NOT NULL,
                change_index integer NOT NULL,
                view_id uuid NOT NULL,
                change_kind smallint NOT NULL,
                before_revision bigint NULL,
                before_name varchar(128) NULL,
                before_query_digest varchar(64) NULL,
                before_dependency_digest varchar(64) NULL,
                before_pinned boolean NULL,
                before_order_key bigint NULL,
                before_lifecycle_state smallint NULL,
                before_content_digest varchar(64) NULL,
                after_revision bigint NOT NULL,
                after_name varchar(128) NOT NULL,
                after_query_digest varchar(64) NOT NULL,
                after_dependency_digest varchar(64) NOT NULL,
                after_pinned boolean NOT NULL,
                after_order_key bigint NOT NULL,
                after_lifecycle_state smallint NOT NULL,
                after_content_digest varchar(64) NOT NULL,
                content_digest varchar(64) NOT NULL,
                PRIMARY KEY (receipt_id, change_index),
                CONSTRAINT ux_author_saved_view_receipt_change_view UNIQUE (receipt_id, view_id),
                CONSTRAINT fk_author_saved_view_receipt_change_receipt
                    FOREIGN KEY (receipt_id) REFERENCES author_saved_view_receipt(receipt_id)
                    ON DELETE RESTRICT,
                CONSTRAINT ck_author_saved_view_receipt_change_index CHECK (
                    change_index BETWEEN 0 AND 999),
                CONSTRAINT ck_author_saved_view_receipt_change_kind CHECK (change_kind BETWEEN 0 AND 2),
                CONSTRAINT ck_author_saved_view_receipt_change_before CHECK (
                    (change_kind = 0
                        AND before_revision IS NULL
                        AND before_name IS NULL
                        AND before_query_digest IS NULL
                        AND before_dependency_digest IS NULL
                        AND before_pinned IS NULL
                        AND before_order_key IS NULL
                        AND before_lifecycle_state IS NULL
                        AND before_content_digest IS NULL
                        AND after_revision = 1)
                    OR (change_kind IN (1, 2)
                        AND before_revision >= 1
                        AND before_name IS NOT NULL
                        AND before_query_digest IS NOT NULL
                        AND before_dependency_digest IS NOT NULL
                        AND before_pinned IS NOT NULL
                        AND before_order_key IS NOT NULL
                        AND before_lifecycle_state IS NOT NULL
                        AND before_content_digest IS NOT NULL
                        AND after_revision = before_revision + 1)),
                CONSTRAINT ck_author_saved_view_receipt_change_before_order CHECK (
                    before_revision IS NULL
                    OR (before_pinned AND before_lifecycle_state = 0 AND before_order_key > 0)
                    OR (NOT before_pinned AND before_order_key = 0)),
                CONSTRAINT ck_author_saved_view_receipt_change_after_order CHECK (
                    (after_pinned AND after_lifecycle_state = 0 AND after_order_key > 0)
                    OR (NOT after_pinned AND after_order_key = 0)),
                CONSTRAINT ck_author_saved_view_receipt_change_lifecycle CHECK (
                    (before_lifecycle_state IS NULL OR before_lifecycle_state IN (0, 1))
                    AND after_lifecycle_state IN (0, 1)),
                CONSTRAINT ck_author_saved_view_receipt_change_digests CHECK (
                    (before_query_digest IS NULL OR before_query_digest ~ '^[0-9a-f]{64}$')
                    AND (before_dependency_digest IS NULL OR before_dependency_digest ~ '^[0-9a-f]{64}$')
                    AND (before_content_digest IS NULL OR before_content_digest ~ '^[0-9a-f]{64}$')
                    AND after_query_digest ~ '^[0-9a-f]{64}$'
                    AND after_dependency_digest ~ '^[0-9a-f]{64}$'
                    AND after_content_digest ~ '^[0-9a-f]{64}$'
                    AND content_digest ~ '^[0-9a-f]{64}$')
            );
            """),
        new(
            "author_saved_view_idempotency",
            """
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
            """),
        new(
            "authoring_canvas_document",
            """
            CREATE TABLE IF NOT EXISTS authoring_canvas_document (
                id uuid PRIMARY KEY,
                owner_admin_principal_id bigint NOT NULL,
                site_scope varchar(128) NOT NULL,
                schema_version integer NOT NULL,
                revision bigint NOT NULL,
                title varchar(128) NOT NULL,
                viewport_x double precision NOT NULL,
                viewport_y double precision NOT NULL,
                viewport_zoom double precision NOT NULL,
                node_count integer NOT NULL,
                edge_count integer NOT NULL,
                created_at_utc timestamp without time zone NOT NULL,
                updated_at_utc timestamp without time zone NOT NULL,
                content_digest varchar(64) NOT NULL,
                CONSTRAINT fk_authoring_canvas_document_owner
                    FOREIGN KEY (owner_admin_principal_id) REFERENCES admin_principal(id) ON DELETE CASCADE,
                CONSTRAINT ck_authoring_canvas_document_schema CHECK (schema_version = 1),
                CONSTRAINT ck_authoring_canvas_document_revision CHECK (revision >= 1),
                CONSTRAINT ck_authoring_canvas_document_title CHECK (char_length(title) BETWEEN 1 AND 128),
                CONSTRAINT ck_authoring_canvas_document_viewport CHECK (
                    viewport_x BETWEEN -10000000 AND 10000000
                    AND viewport_y BETWEEN -10000000 AND 10000000
                    AND viewport_zoom BETWEEN 0.1 AND 4),
                CONSTRAINT ck_authoring_canvas_document_counts CHECK (
                    node_count BETWEEN 0 AND 10000
                    AND edge_count BETWEEN 0 AND 10000),
                CONSTRAINT ck_authoring_canvas_document_digest CHECK (
                    content_digest ~ '^[0-9a-f]{64}$')
            );
            """,
            AdditionalSql:
            [
                """
                CREATE INDEX IF NOT EXISTS ix_authoring_canvas_document_owner
                    ON authoring_canvas_document(owner_admin_principal_id, site_scope, updated_at_utc DESC, id);
                """,
                """
                CREATE INDEX IF NOT EXISTS ix_authoring_canvas_node_page
                    ON authoring_canvas_node(canvas_id, node_order, node_id);
                """,
                """
                CREATE INDEX IF NOT EXISTS ix_authoring_canvas_frame_member_order
                    ON authoring_canvas_frame_member(canvas_id, frame_node_id, member_order, member_node_id);
                """,
                """
                CREATE INDEX IF NOT EXISTS ix_authoring_canvas_edge_page
                    ON authoring_canvas_edge(canvas_id, edge_order, edge_id);
                """,
                """
                CREATE INDEX IF NOT EXISTS ix_authoring_canvas_edge_source
                    ON authoring_canvas_edge(canvas_id, source_node_id);
                """,
                """
                CREATE INDEX IF NOT EXISTS ix_authoring_canvas_edge_target
                    ON authoring_canvas_edge(canvas_id, target_node_id);
                """,
                """
                CREATE INDEX IF NOT EXISTS ix_authoring_canvas_receipt_document
                    ON authoring_canvas_receipt(
                        canvas_id, owner_admin_principal_id, site_scope, revision DESC, created_at_utc DESC);
                """,
                """
                CREATE INDEX IF NOT EXISTS ix_authoring_canvas_idempotency_created
                    ON authoring_canvas_idempotency(created_at_utc, canvas_id);
                """,
            ]),
        new(
            "authoring_canvas_node",
            """
            CREATE TABLE IF NOT EXISTS authoring_canvas_node (
                canvas_id uuid NOT NULL,
                node_id uuid NOT NULL,
                node_type varchar(32) NOT NULL,
                node_order integer NOT NULL,
                position_x double precision NOT NULL,
                position_y double precision NOT NULL,
                width double precision NOT NULL,
                height double precision NOT NULL,
                target_article_id integer NULL,
                target_heading_identity varchar(128) NULL,
                target_block_identity varchar(128) NULL,
                pinned_target_revision bigint NULL,
                display_projection_ref varchar(128) NULL,
                reference_state varchar(32) NULL,
                note_source varchar(8192) NULL,
                frame_label varchar(128) NULL,
                content_digest varchar(64) NOT NULL,
                PRIMARY KEY (canvas_id, node_id),
                CONSTRAINT fk_authoring_canvas_node_document
                    FOREIGN KEY (canvas_id) REFERENCES authoring_canvas_document(id) ON DELETE CASCADE,
                CONSTRAINT ck_authoring_canvas_node_type CHECK (
                    node_type IN (
                        'article-reference',
                        'heading-reference',
                        'block-reference',
                        'plain-text-note',
                        'group-frame')),
                CONSTRAINT ck_authoring_canvas_node_order CHECK (node_order >= 0),
                CONSTRAINT ck_authoring_canvas_node_geometry CHECK (
                    position_x BETWEEN -10000000 AND 10000000
                    AND position_y BETWEEN -10000000 AND 10000000
                    AND width BETWEEN 24 AND 4096
                    AND height BETWEEN 24 AND 4096),
                CONSTRAINT ck_authoring_canvas_node_reference_shape CHECK (
                    (node_type = 'article-reference'
                        AND target_article_id > 0
                        AND target_heading_identity IS NULL
                        AND target_block_identity IS NULL
                        AND reference_state IS NOT NULL
                        AND note_source IS NULL
                        AND frame_label IS NULL)
                    OR (node_type = 'heading-reference'
                        AND target_article_id > 0
                        AND target_heading_identity IS NOT NULL
                        AND target_block_identity IS NULL
                        AND reference_state IS NOT NULL
                        AND note_source IS NULL
                        AND frame_label IS NULL)
                    OR (node_type = 'block-reference'
                        AND target_article_id > 0
                        AND target_heading_identity IS NULL
                        AND target_block_identity IS NOT NULL
                        AND reference_state IS NOT NULL
                        AND note_source IS NULL
                        AND frame_label IS NULL)
                    OR (node_type = 'plain-text-note'
                        AND target_article_id IS NULL
                        AND target_heading_identity IS NULL
                        AND target_block_identity IS NULL
                        AND pinned_target_revision IS NULL
                        AND display_projection_ref IS NULL
                        AND reference_state IS NULL
                        AND note_source IS NOT NULL
                        AND frame_label IS NULL)
                    OR (node_type = 'group-frame'
                        AND target_article_id IS NULL
                        AND target_heading_identity IS NULL
                        AND target_block_identity IS NULL
                        AND pinned_target_revision IS NULL
                        AND display_projection_ref IS NULL
                        AND reference_state IS NULL
                        AND note_source IS NULL
                        AND frame_label IS NOT NULL)),
                CONSTRAINT ck_authoring_canvas_node_reference_state CHECK (
                    reference_state IS NULL OR reference_state IN (
                        'unresolved', 'current', 'pinned', 'stale', 'missing', 'permission-denied')),
                CONSTRAINT ck_authoring_canvas_node_digest CHECK (
                    content_digest ~ '^[0-9a-f]{64}$')
            );
            """),
        new(
            "authoring_canvas_frame_member",
            """
            CREATE TABLE IF NOT EXISTS authoring_canvas_frame_member (
                canvas_id uuid NOT NULL,
                frame_node_id uuid NOT NULL,
                member_node_id uuid NOT NULL,
                member_order integer NOT NULL,
                PRIMARY KEY (canvas_id, frame_node_id, member_node_id),
                CONSTRAINT fk_authoring_canvas_frame_member_frame
                    FOREIGN KEY (canvas_id, frame_node_id)
                    REFERENCES authoring_canvas_node(canvas_id, node_id) ON DELETE CASCADE,
                CONSTRAINT fk_authoring_canvas_frame_member_node
                    FOREIGN KEY (canvas_id, member_node_id)
                    REFERENCES authoring_canvas_node(canvas_id, node_id) ON DELETE CASCADE,
                CONSTRAINT ck_authoring_canvas_frame_member_order CHECK (member_order >= 0),
                CONSTRAINT ck_authoring_canvas_frame_member_self CHECK (frame_node_id <> member_node_id)
            );
            """),
        new(
            "authoring_canvas_edge",
            """
            CREATE TABLE IF NOT EXISTS authoring_canvas_edge (
                canvas_id uuid NOT NULL,
                edge_id uuid NOT NULL,
                edge_type varchar(32) NOT NULL,
                edge_order integer NOT NULL,
                source_node_id uuid NOT NULL,
                target_node_id uuid NOT NULL,
                label varchar(128) NULL,
                content_digest varchar(64) NOT NULL,
                PRIMARY KEY (canvas_id, edge_id),
                CONSTRAINT fk_authoring_canvas_edge_document
                    FOREIGN KEY (canvas_id) REFERENCES authoring_canvas_document(id) ON DELETE CASCADE,
                CONSTRAINT fk_authoring_canvas_edge_source
                    FOREIGN KEY (canvas_id, source_node_id)
                    REFERENCES authoring_canvas_node(canvas_id, node_id) ON DELETE CASCADE,
                CONSTRAINT fk_authoring_canvas_edge_target
                    FOREIGN KEY (canvas_id, target_node_id)
                    REFERENCES authoring_canvas_node(canvas_id, node_id) ON DELETE CASCADE,
                CONSTRAINT ck_authoring_canvas_edge_type CHECK (
                    edge_type IN ('visual-only', 'explicit-reference-note')),
                CONSTRAINT ck_authoring_canvas_edge_order CHECK (edge_order >= 0),
                CONSTRAINT ck_authoring_canvas_edge_digest CHECK (
                    content_digest ~ '^[0-9a-f]{64}$')
            );
            """),
        new(
            "authoring_canvas_receipt",
            """
            CREATE TABLE IF NOT EXISTS authoring_canvas_receipt (
                receipt_id uuid PRIMARY KEY,
                canvas_id uuid NOT NULL,
                owner_admin_principal_id bigint NOT NULL,
                site_scope varchar(128) NOT NULL,
                revision bigint NOT NULL,
                command_kind varchar(32) NOT NULL,
                node_count integer NOT NULL,
                edge_count integer NOT NULL,
                status varchar(16) NOT NULL,
                reason_code varchar(64) NULL,
                command_digest varchar(64) NOT NULL,
                content_digest varchar(64) NOT NULL,
                created_at_utc timestamp without time zone NOT NULL,
                CONSTRAINT ck_authoring_canvas_receipt_revision CHECK (revision >= 1),
                CONSTRAINT ck_authoring_canvas_receipt_counts CHECK (
                    node_count BETWEEN 0 AND 10000
                    AND edge_count BETWEEN 0 AND 10000),
                CONSTRAINT ck_authoring_canvas_receipt_status CHECK (
                    status IN ('applied', 'rejected')),
                CONSTRAINT ck_authoring_canvas_receipt_digests CHECK (
                    command_digest ~ '^[0-9a-f]{64}$'
                    AND content_digest ~ '^[0-9a-f]{64}$')
            );
            """),
        new(
            "authoring_canvas_idempotency",
            """
            CREATE TABLE IF NOT EXISTS authoring_canvas_idempotency (
                canvas_id uuid NOT NULL,
                owner_admin_principal_id bigint NOT NULL,
                site_scope varchar(128) NOT NULL,
                request_id uuid NOT NULL,
                receipt_id uuid NOT NULL,
                revision bigint NOT NULL,
                command_kind varchar(32) NOT NULL,
                node_count integer NOT NULL,
                edge_count integer NOT NULL,
                command_digest varchar(64) NOT NULL,
                content_digest varchar(64) NOT NULL,
                created_at_utc timestamp without time zone NOT NULL,
                PRIMARY KEY (canvas_id, owner_admin_principal_id, site_scope, request_id),
                CONSTRAINT fk_authoring_canvas_idempotency_receipt
                    FOREIGN KEY (receipt_id) REFERENCES authoring_canvas_receipt(receipt_id) ON DELETE RESTRICT,
                CONSTRAINT ck_authoring_canvas_idempotency_revision CHECK (revision >= 1),
                CONSTRAINT ck_authoring_canvas_idempotency_counts CHECK (
                    node_count BETWEEN 0 AND 10000
                    AND edge_count BETWEEN 0 AND 10000),
                CONSTRAINT ck_authoring_canvas_idempotency_digests CHECK (
                    command_digest ~ '^[0-9a-f]{64}$'
                    AND content_digest ~ '^[0-9a-f]{64}$')
            );
            """),
        new(
            "customization_profile",
            """
            CREATE TABLE IF NOT EXISTS customization_profile (
                id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                user_id integer NOT NULL,
                name varchar(256) NOT NULL,
                created_at_utc timestamp NOT NULL,
                updated_at_utc timestamp NOT NULL
            );
            """,
            AdditionalSql:
            [
                """
                CREATE INDEX IF NOT EXISTS idx_customization_profile_user ON customization_profile(user_id, id);
                """,
                """
                CREATE INDEX IF NOT EXISTS idx_customization_version_profile ON customization_version(profile_id, version);
                """,
                """
                CREATE INDEX IF NOT EXISTS idx_customization_change_set_profile ON customization_change_set(profile_id, id);
                """,
            ]),
        new(
            "customization_version",
            """
            CREATE TABLE IF NOT EXISTS customization_version (
                id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                profile_id bigint NOT NULL,
                version integer NOT NULL,
                payload jsonb NOT NULL,
                created_at_utc timestamp NOT NULL,
                CONSTRAINT fk_customization_version_profile
                    FOREIGN KEY (profile_id) REFERENCES customization_profile(id) ON DELETE CASCADE,
                CONSTRAINT ux_customization_version_profile_version
                    UNIQUE(profile_id, version),
                CONSTRAINT ck_customization_version_positive
                    CHECK (version > 0)
            );
            """),
        new(
            "customization_draft",
            """
            CREATE TABLE IF NOT EXISTS customization_draft (
                id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                profile_id bigint NOT NULL,
                version_id bigint,
                payload jsonb NOT NULL DEFAULT '{}',
                etag varchar(64) NOT NULL,
                updated_at_utc timestamp NOT NULL,
                CONSTRAINT fk_customization_draft_profile
                    FOREIGN KEY (profile_id) REFERENCES customization_profile(id) ON DELETE CASCADE,
                CONSTRAINT fk_customization_draft_version
                    FOREIGN KEY (version_id) REFERENCES customization_version(id) ON DELETE SET NULL,
                CONSTRAINT ux_customization_draft_profile
                    UNIQUE(profile_id)
            );
            """),
        new(
            "customization_change_set",
            """
            CREATE TABLE IF NOT EXISTS customization_change_set (
                id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                profile_id bigint NOT NULL,
                from_version_id bigint NOT NULL,
                to_version_id bigint NOT NULL,
                changes jsonb NOT NULL,
                created_at_utc timestamp NOT NULL,
                CONSTRAINT fk_customization_change_set_profile
                    FOREIGN KEY (profile_id) REFERENCES customization_profile(id) ON DELETE CASCADE,
                CONSTRAINT fk_customization_change_set_from_version
                    FOREIGN KEY (from_version_id) REFERENCES customization_version(id) ON DELETE CASCADE,
                CONSTRAINT fk_customization_change_set_to_version
                    FOREIGN KEY (to_version_id) REFERENCES customization_version(id) ON DELETE CASCADE,
                CONSTRAINT ck_customization_change_set_version_order
                    CHECK (from_version_id <> to_version_id)
            );
            """),
        new(
            "theme_activation_history",
            """
            CREATE TABLE IF NOT EXISTS theme_activation_history (
                id varchar(36) PRIMARY KEY,
                scope varchar(160) NOT NULL,
                theme_id varchar(128) NULL,
                previous_theme_id varchar(128) NULL,
                asset_version varchar(64) NULL,
                previous_asset_version varchar(64) NULL,
                config_version bigint NULL,
                previous_config_version bigint NULL,
                mode varchar(16) NULL,
                previous_mode varchar(16) NULL,
                status varchar(32) NOT NULL,
                started_at_utc timestamp without time zone NOT NULL,
                completed_at_utc timestamp without time zone NOT NULL,
                failure_reason varchar(1000) NULL,
                activated_by varchar(160) NOT NULL,
                evidence_json jsonb NOT NULL,
                CONSTRAINT ck_theme_activation_history_scope CHECK (
                    scope IN ('site-wide', 'public', 'admin', 'console')
                    OR scope ~ '^user-preview:[1-9][0-9]*$'
                ),
                CONSTRAINT ck_theme_activation_history_status CHECK (
                    status IN ('applied', 'rejected', 'rolled_back', 'reset_to_default')
                ),
                CONSTRAINT ck_theme_activation_history_mode CHECK (
                    mode IS NULL OR mode IN ('auto', 'light', 'dark')
                ),
                CONSTRAINT ck_theme_activation_history_previous_mode CHECK (
                    previous_mode IS NULL OR previous_mode IN ('auto', 'light', 'dark')
                ),
                CONSTRAINT ck_theme_activation_history_config_version CHECK (
                    config_version IS NULL OR config_version > 0
                ),
                CONSTRAINT ck_theme_activation_history_previous_config_version CHECK (
                    previous_config_version IS NULL OR previous_config_version > 0
                )
            );
            """,
            AdditionalSql:
            [
                """
                ALTER TABLE theme_activation ADD COLUMN IF NOT EXISTS activation_id varchar(36) NULL;
                """,
                """
                ALTER TABLE theme_activation ADD COLUMN IF NOT EXISTS asset_version varchar(64) NULL;
                """,
                """
                ALTER TABLE theme_activation ADD COLUMN IF NOT EXISTS config_version bigint NULL;
                """,
                """
                CREATE INDEX IF NOT EXISTS idx_theme_activation_history_scope_started
                ON theme_activation_history(scope, started_at_utc DESC, id DESC);
                """,
            ]),
        new(
            "theme_registry",
            """
            CREATE TABLE IF NOT EXISTS theme_registry (
                id varchar(128) PRIMARY KEY,
                name varchar(120) NOT NULL,
                version varchar(64) NOT NULL,
                manifest_json jsonb NOT NULL,
                config_schema_json jsonb NOT NULL,
                package_hash varchar(64) NOT NULL,
                package_location varchar(1024) NOT NULL,
                install_state varchar(24) NOT NULL,
                enabled boolean NOT NULL DEFAULT FALSE,
                installed_at_utc timestamp without time zone NOT NULL,
                updated_at_utc timestamp without time zone NOT NULL,
                CONSTRAINT ck_theme_registry_install_state CHECK (install_state IN (
                    'discovered',
                    'validated',
                    'installed',
                    'enabled',
                    'disabled',
                    'failed',
                    'rolled_back',
                    'uninstalled'
                )),
                CONSTRAINT ck_theme_registry_enabled_state CHECK (
                    (enabled AND install_state = 'enabled')
                    OR (NOT enabled AND install_state <> 'enabled')
                )
            );
            """,
            AdditionalSql:
            [
                """
                CREATE INDEX IF NOT EXISTS idx_theme_asset_content_hash ON theme_asset(content_hash);
                """,
                """
                CREATE INDEX IF NOT EXISTS idx_theme_registry_enabled ON theme_registry(enabled, id);
                """,
            ]),
        new(
            "theme_config",
            """
            CREATE TABLE IF NOT EXISTS theme_config (
                theme_id varchar(128) PRIMARY KEY REFERENCES theme_registry(id) ON DELETE CASCADE,
                config_json jsonb NOT NULL,
                version bigint NOT NULL,
                updated_at_utc timestamp without time zone NOT NULL,
                CONSTRAINT ck_theme_config_version CHECK (version > 0)
            );
            """),
        new(
            "theme_activation",
            """
            CREATE TABLE IF NOT EXISTS theme_activation (
                scope varchar(160) PRIMARY KEY,
                active_theme_id varchar(128) NOT NULL REFERENCES theme_registry(id) ON DELETE RESTRICT,
                mode varchar(16) NOT NULL,
                updated_at_utc timestamp without time zone NOT NULL,
                CONSTRAINT ck_theme_activation_scope CHECK (
                    scope IN ('site-wide', 'public', 'admin', 'console')
                    OR scope ~ '^user-preview:[1-9][0-9]*$'
                ),
                CONSTRAINT ck_theme_activation_mode CHECK (mode IN ('auto', 'light', 'dark'))
            );
            """),
        new(
            "theme_asset",
            """
            CREATE TABLE IF NOT EXISTS theme_asset (
                id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                theme_id varchar(128) NOT NULL REFERENCES theme_registry(id) ON DELETE CASCADE,
                asset_key varchar(64) NOT NULL,
                content_hash varchar(64) NOT NULL,
                path varchar(512) NOT NULL,
                size_bytes bigint NOT NULL,
                CONSTRAINT ux_theme_asset_key UNIQUE(theme_id, asset_key),
                CONSTRAINT ck_theme_asset_size CHECK (size_bytes > 0)
            );
            """),
        new(
            "article_property_definition_owner",
            """
            CREATE TABLE IF NOT EXISTS article_property_definition_owner (
                owner_user_id bigint NOT NULL,
                site_scope varchar(128) NOT NULL,
                revision bigint NOT NULL DEFAULT 0,
                PRIMARY KEY (owner_user_id, site_scope),
                CONSTRAINT ck_article_property_owner_user CHECK (owner_user_id >= 0),
                CONSTRAINT ck_article_property_owner_scope CHECK (char_length(site_scope) BETWEEN 1 AND 128),
                CONSTRAINT ck_article_property_owner_revision CHECK (revision >= 0)
            );
            """,
            AdditionalSql:
            [
                """
                CREATE UNIQUE INDEX IF NOT EXISTS ux_article_property_definition_live_key
                    ON article_property_definition(owner_user_id, site_scope, machine_key)
                    WHERE status <> 2;
                """,
                """
                CREATE INDEX IF NOT EXISTS ix_article_property_definition_page
                    ON article_property_definition(owner_user_id, site_scope, machine_key, definition_id)
                    WHERE status <> 2;
                """,
                """
                CREATE UNIQUE INDEX IF NOT EXISTS ux_article_property_receipt_revision
                    ON article_property_definition_receipt(definition_id, schema_revision);
                """,
                """
                CREATE INDEX IF NOT EXISTS ix_article_property_receipt_owner
                    ON article_property_definition_receipt(owner_user_id, site_scope, owner_revision);
                """,
            ]),
        new(
            "article_property_definition",
            """
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
                default_option_ids varchar(37000) NOT NULL DEFAULT '',
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
            """),
        new(
            "article_property_definition_display_name",
            """
            CREATE TABLE IF NOT EXISTS article_property_definition_display_name (
                definition_id uuid NOT NULL,
                locale varchar(32) NOT NULL,
                value varchar(256) NOT NULL,
                PRIMARY KEY (definition_id, locale),
                CONSTRAINT fk_article_property_display_name_definition
                    FOREIGN KEY (definition_id) REFERENCES article_property_definition(definition_id)
                    ON DELETE RESTRICT
            );
            """),
        new(
            "article_property_definition_option",
            """
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
            """),
        new(
            "article_property_definition_option_label",
            """
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
            """),
        new(
            "article_property_definition_receipt",
            """
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
            """),
        new(
            "article_property_definition_obligation",
            """
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
            """),
        new(
            "article_property_definition_idempotency",
            """
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
            """),
        new(
            "article_property_definition_history",
            """
            CREATE TABLE IF NOT EXISTS article_property_definition_history (
                owner_user_id bigint NOT NULL,
                site_scope varchar(128) NOT NULL,
                history_version integer NOT NULL,
                genesis_digest varchar(64) NOT NULL,
                revision bigint NOT NULL,
                head_digest varchar(64) NOT NULL,
                PRIMARY KEY (owner_user_id, site_scope),
                CONSTRAINT fk_article_property_history_owner
                    FOREIGN KEY (owner_user_id, site_scope)
                    REFERENCES article_property_definition_owner(owner_user_id, site_scope)
                    ON DELETE RESTRICT,
                CONSTRAINT ck_article_property_history_version CHECK (history_version = 1),
                CONSTRAINT ck_article_property_history_revision CHECK (revision >= 0),
                CONSTRAINT ck_article_property_history_digests CHECK (
                    genesis_digest ~ '^[0-9a-f]{64}$'
                    AND head_digest ~ '^[0-9a-f]{64}$')
            );
            """),
        new(
            "article_property_definition_command",
            """
            CREATE TABLE IF NOT EXISTS article_property_definition_command (
                owner_user_id bigint NOT NULL,
                site_scope varchar(128) NOT NULL,
                sequence bigint NOT NULL,
                history_version integer NOT NULL,
                command_kind varchar(32) NOT NULL,
                definition_id uuid NOT NULL,
                receipt_id uuid NOT NULL,
                actor_admin_principal_id bigint NOT NULL,
                request_id uuid NOT NULL,
                command_payload bytea NOT NULL,
                affected_value_count bigint NULL,
                previous_digest varchar(64) NOT NULL,
                content_digest varchar(64) NOT NULL,
                PRIMARY KEY (owner_user_id, site_scope, sequence),
                CONSTRAINT fk_article_property_command_history
                    FOREIGN KEY (owner_user_id, site_scope)
                    REFERENCES article_property_definition_history(owner_user_id, site_scope)
                    ON DELETE RESTRICT,
                CONSTRAINT fk_article_property_command_receipt
                    FOREIGN KEY (receipt_id)
                    REFERENCES article_property_definition_receipt(receipt_id)
                    ON DELETE RESTRICT,
                CONSTRAINT ux_article_property_command_receipt UNIQUE (receipt_id),
                CONSTRAINT ux_article_property_command_request UNIQUE (actor_admin_principal_id, request_id),
                CONSTRAINT ck_article_property_command_version CHECK (history_version = 1),
                CONSTRAINT ck_article_property_command_sequence CHECK (sequence >= 1),
                CONSTRAINT ck_article_property_command_kind CHECK (
                    command_kind IN ('create', 'change-settings', 'rename', 'deprecate', 'delete')),
                CONSTRAINT ck_article_property_command_actor CHECK (actor_admin_principal_id > 0),
                CONSTRAINT ck_article_property_command_payload CHECK (
                    octet_length(command_payload) BETWEEN 1 AND 1048576),
                CONSTRAINT ck_article_property_command_affected CHECK (
                    affected_value_count IS NULL OR affected_value_count >= 0),
                CONSTRAINT ck_article_property_command_digests CHECK (
                    previous_digest ~ '^[0-9a-f]{64}$'
                    AND content_digest ~ '^[0-9a-f]{64}$')
            );
            """),
        new(
            "article_canvas_link_journal",
            """
            CREATE TABLE IF NOT EXISTS article_canvas_link_journal (
                journal_id uuid PRIMARY KEY,
                owner_admin_principal_id bigint NOT NULL,
                site_scope varchar(128) NOT NULL,
                source_article_id integer NOT NULL,
                request_id uuid NOT NULL,
                mode smallint NOT NULL,
                target_journal_id uuid NULL REFERENCES article_canvas_link_journal(journal_id),
                parent_journal_id uuid NULL REFERENCES article_canvas_link_journal(journal_id),
                previous_article_revision bigint NOT NULL,
                article_revision bigint NOT NULL,
                original_before_revision bigint NOT NULL,
                original_after_revision bigint NOT NULL,
                canvas_id uuid NOT NULL,
                canvas_revision bigint NOT NULL,
                canvas_content_digest varchar(64) NOT NULL,
                edge_id uuid NOT NULL,
                target_article_id integer NOT NULL,
                target_revision bigint NOT NULL,
                undo_depth integer NOT NULL,
                redo_depth integer NOT NULL,
                request_digest varchar(64) NOT NULL,
                receipt_digest varchar(64) NOT NULL,
                created_at_utc timestamp without time zone NOT NULL,
                CONSTRAINT ux_article_canvas_link_request UNIQUE (owner_admin_principal_id, site_scope, request_id),
                CONSTRAINT ck_article_canvas_link_principal CHECK (owner_admin_principal_id > 0),
                CONSTRAINT ck_article_canvas_link_scope CHECK (site_scope = 'primary-site'),
                CONSTRAINT ck_article_canvas_link_mode CHECK (mode BETWEEN 0 AND 2),
                CONSTRAINT ck_article_canvas_link_revisions CHECK (
                    previous_article_revision > 0 AND article_revision > 0
                    AND previous_article_revision <> article_revision
                    AND original_before_revision > 0 AND original_after_revision > 0),
                CONSTRAINT ck_article_canvas_link_depth CHECK (undo_depth BETWEEN 0 AND 100 AND redo_depth BETWEEN 0 AND 100),
                CONSTRAINT ck_article_canvas_link_digest CHECK (
                    request_digest ~ '^[0-9a-f]{64}$' AND receipt_digest ~ '^[0-9a-f]{64}$'
                    AND canvas_content_digest ~ '^[0-9a-f]{64}$'),
                CONSTRAINT ck_article_canvas_link_target CHECK (source_article_id > 0 AND target_article_id > 0
                    AND canvas_revision > 0 AND target_revision > 0),
                CONSTRAINT ck_article_canvas_link_history_target CHECK ((mode = 0) = (target_journal_id IS NULL))
            );
            """,
            AdditionalSql: [
                """
                CREATE INDEX IF NOT EXISTS ix_article_canvas_link_source
                    ON article_canvas_link_journal(owner_admin_principal_id, site_scope, source_article_id, created_at_utc, journal_id);
                """
            ]),
        new(
            "article_canvas_link_history",
            """
            CREATE TABLE IF NOT EXISTS article_canvas_link_history (
                owner_admin_principal_id bigint NOT NULL REFERENCES admin_principal(id) ON DELETE CASCADE,
                site_scope varchar(128) NOT NULL,
                source_article_id integer NOT NULL,
                article_revision bigint NOT NULL,
                last_journal_id uuid NOT NULL REFERENCES article_canvas_link_journal(journal_id),
                undo_entries uuid[] NOT NULL,
                redo_entries uuid[] NOT NULL,
                history_digest varchar(64) NOT NULL,
                PRIMARY KEY (owner_admin_principal_id, site_scope, source_article_id),
                CONSTRAINT ck_article_canvas_link_history_revision CHECK (article_revision > 0 AND source_article_id > 0),
                CONSTRAINT ck_article_canvas_link_history_scope CHECK (site_scope = 'primary-site'),
                CONSTRAINT ck_article_canvas_link_history_bounds CHECK (cardinality(undo_entries) <= 100 AND cardinality(redo_entries) <= 100),
                CONSTRAINT ck_article_canvas_link_history_digest CHECK (history_digest ~ '^[0-9a-f]{64}$')
            );
            """),
    ];

    internal static IReadOnlyList<string> TableNames
    {
        get;
    } =
        Tables.Select(static table => table.TableName).ToArray();

    internal static async Task ApplyEnsureTableStepsAsync(
        ISqlSugarClient db,
        CancellationToken cancellationToken)
    {
        foreach (CurrentSchemaRuntimeRollupTable table in Tables)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await db.Ado.ExecuteCommandAsync(table.CreateSql).ConfigureAwait(false);
        }
        foreach (CurrentSchemaRuntimeRollupTable table in Tables)
        {
            if (table.AdditionalSql is not { } additional)
            {
                continue;
            }
            foreach (string sql in additional)
            {
                cancellationToken.ThrowIfCancellationRequested();
                await db.Ado.ExecuteCommandAsync(sql).ConfigureAwait(false);
            }
        }
    }
}
