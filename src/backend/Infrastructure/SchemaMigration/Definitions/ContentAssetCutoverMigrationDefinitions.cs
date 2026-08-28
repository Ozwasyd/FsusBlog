namespace FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;

internal static class ContentAssetCutoverMigrationDefinitions
{
    internal const string PrototypeShapeMigrationId = "20260826-pre-content-asset-uuid-shape";
    internal const string MigrationId = "20260826-post-content-asset-id-cutover";

    internal static ISchemaMigrationDescriptor BuildPrototypeShapeMigration()
        => new SchemaMigrationDescriptor(
            PrototypeShapeMigrationId,
            "Normalize pre-cutover content-asset prototype identities to PostgreSQL uuid before CodeFirst.",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps: [BuildPrototypeShapeStep()]);

    private static RawSqlStep BuildPrototypeShapeStep()
        => new(
            """
            DO $$
            DECLARE foreign_key record;
            DECLARE asset_id_type text;
            BEGIN
                IF to_regclass('public.content_asset') IS NULL THEN
                    IF to_regclass('public.content_asset_reference') IS NOT NULL
                        OR to_regclass('public.content_asset_cleanup_queue') IS NOT NULL THEN
                        RAISE EXCEPTION 'content_asset_cutover_prototype_parent_missing';
                    END IF;
                    RETURN;
                END IF;

                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'content_asset' AND column_name = 'asset_id'
                ) AND NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'content_asset' AND column_name = 'id'
                ) THEN
                    ALTER TABLE content_asset RENAME COLUMN asset_id TO id;
                END IF;

                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'content_asset' AND column_name = 'mime_type'
                ) AND NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'content_asset' AND column_name = 'media_type'
                ) THEN
                    ALTER TABLE content_asset RENAME COLUMN mime_type TO media_type;
                END IF;
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'content_asset' AND column_name = 'size_bytes'
                ) AND NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'content_asset' AND column_name = 'byte_length'
                ) THEN
                    ALTER TABLE content_asset RENAME COLUMN size_bytes TO byte_length;
                END IF;
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'content_asset' AND column_name = 'width_pixels'
                ) AND NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'content_asset' AND column_name = 'width'
                ) THEN
                    ALTER TABLE content_asset RENAME COLUMN width_pixels TO width;
                END IF;
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'content_asset' AND column_name = 'height_pixels'
                ) AND NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'content_asset' AND column_name = 'height'
                ) THEN
                    ALTER TABLE content_asset RENAME COLUMN height_pixels TO height;
                END IF;

                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'content_asset' AND column_name = 'id'
                ) THEN
                    RAISE EXCEPTION 'content_asset_cutover_prototype_id_missing';
                END IF;

                FOR foreign_key IN
                    SELECT child.relname AS table_name, constraint_row.conname AS constraint_name
                    FROM pg_constraint constraint_row
                    JOIN pg_class child ON child.oid = constraint_row.conrelid
                    WHERE constraint_row.contype = 'f'
                      AND constraint_row.confrelid = 'public.content_asset'::regclass
                LOOP
                    EXECUTE format(
                        'ALTER TABLE %I DROP CONSTRAINT %I',
                        foreign_key.table_name,
                        foreign_key.constraint_name);
                END LOOP;

                SELECT udt_name INTO asset_id_type
                FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'content_asset' AND column_name = 'id';
                IF asset_id_type <> 'uuid' THEN
                    IF EXISTS (
                        SELECT 1 FROM content_asset
                        WHERE id IS NULL
                           OR id::text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    ) THEN
                        RAISE EXCEPTION 'content_asset_cutover_invalid_prototype_id';
                    END IF;
                    ALTER TABLE content_asset ALTER COLUMN id TYPE uuid USING id::uuid;
                END IF;

                IF to_regclass('public.content_asset_reference') IS NOT NULL THEN
                    SELECT udt_name INTO asset_id_type
                    FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'content_asset_reference' AND column_name = 'asset_id';
                    IF asset_id_type <> 'uuid' THEN
                        IF EXISTS (
                            SELECT 1 FROM content_asset_reference
                            WHERE asset_id IS NULL
                               OR asset_id::text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                        ) THEN
                            RAISE EXCEPTION 'content_asset_cutover_invalid_prototype_reference_id';
                        END IF;
                        ALTER TABLE content_asset_reference
                            ALTER COLUMN asset_id TYPE uuid USING asset_id::uuid;
                    END IF;
                    ALTER TABLE content_asset_reference
                        ADD CONSTRAINT fk_content_asset_reference_asset
                        FOREIGN KEY (asset_id) REFERENCES content_asset(id) ON DELETE CASCADE;
                END IF;

                IF to_regclass('public.content_asset_cleanup_queue') IS NOT NULL THEN
                    SELECT udt_name INTO asset_id_type
                    FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'content_asset_cleanup_queue' AND column_name = 'asset_id';
                    IF asset_id_type <> 'uuid' THEN
                        IF EXISTS (
                            SELECT 1 FROM content_asset_cleanup_queue
                            WHERE asset_id IS NULL
                               OR asset_id::text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                        ) THEN
                            RAISE EXCEPTION 'content_asset_cutover_invalid_prototype_cleanup_id';
                        END IF;
                        ALTER TABLE content_asset_cleanup_queue
                            ALTER COLUMN asset_id TYPE uuid USING asset_id::uuid;
                    END IF;
                    ALTER TABLE content_asset_cleanup_queue
                        ADD CONSTRAINT fk_content_asset_cleanup_asset
                        FOREIGN KEY (asset_id) REFERENCES content_asset(id) ON DELETE CASCADE;
                END IF;
            END $$;
            """);

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Backfill canonical AssetId metadata and references, then retire every URL-identity asset table.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "content_asset",
                    """
                    CREATE TABLE IF NOT EXISTS content_asset (
                        id uuid PRIMARY KEY,
                        storage_class varchar(16) NOT NULL,
                        storage_key varchar(512) NOT NULL,
                        media_type varchar(127) NOT NULL,
                        extension varchar(16) NOT NULL,
                        byte_length bigint NOT NULL,
                        sha256 varchar(64) NULL,
                        width integer NULL,
                        height integer NULL,
                        owner_admin_principal_id bigint NULL,
                        state varchar(16) NOT NULL,
                        created_at_utc timestamp NOT NULL,
                        updated_at_utc timestamp NOT NULL,
                        CONSTRAINT ck_content_asset_storage_class CHECK (storage_class IN ('public', 'private')),
                        CONSTRAINT ck_content_asset_state CHECK (state IN ('active', 'pending_delete')),
                        CONSTRAINT ck_content_asset_size CHECK (byte_length >= 0),
                        CONSTRAINT ux_content_asset_storage_key UNIQUE (storage_key)
                    );
                    """),
                new EnsureTableStep(
                    "content_asset_reference",
                    """
                    CREATE TABLE IF NOT EXISTS content_asset_reference (
                        asset_id uuid NOT NULL REFERENCES content_asset(id) ON DELETE CASCADE,
                        source_kind varchar(16) NOT NULL,
                        source_key varchar(160) NOT NULL,
                        article_id integer NULL,
                        reference_count integer NOT NULL,
                        alt_text varchar(256) NULL,
                        updated_at_utc timestamp NOT NULL,
                        PRIMARY KEY (asset_id, source_kind, source_key),
                        CONSTRAINT ck_content_asset_reference_kind CHECK (source_kind IN ('article', 'draft', 'revision')),
                        CONSTRAINT ck_content_asset_reference_count CHECK (reference_count > 0)
                    );
                    """),
                new CreateIndexStep(
                    "idx_content_asset_reference_source",
                    "CREATE INDEX IF NOT EXISTS idx_content_asset_reference_source ON content_asset_reference(source_kind, source_key);"),
                new CreateIndexStep(
                    "idx_content_asset_reference_article",
                    "CREATE INDEX IF NOT EXISTS idx_content_asset_reference_article ON content_asset_reference(article_id) WHERE article_id IS NOT NULL;"),
                new EnsureTableStep(
                    "content_asset_cleanup_queue",
                    """
                    CREATE TABLE IF NOT EXISTS content_asset_cleanup_queue (
                        asset_id uuid PRIMARY KEY REFERENCES content_asset(id) ON DELETE CASCADE,
                        not_before_utc timestamp NOT NULL,
                        attempt_count integer NOT NULL DEFAULT 0,
                        last_error varchar(512) NULL,
                        updated_at_utc timestamp NOT NULL,
                        CONSTRAINT ck_content_asset_cleanup_attempt CHECK (attempt_count >= 0)
                    );
                    """),
                new CreateIndexStep(
                    "idx_content_asset_cleanup_due",
                    "CREATE INDEX IF NOT EXISTS idx_content_asset_cleanup_due ON content_asset_cleanup_queue(not_before_utc, asset_id);"),
                new ContentAssetCutoverBackfillStep(),
                new AssertSqlStep(
                    "Canonical content assets and references must be internally consistent before legacy retirement.",
                    """
                    DO $$
                    BEGIN
                        IF EXISTS (
                            SELECT 1 FROM content_asset_reference reference
                            LEFT JOIN content_asset asset ON asset.id = reference.asset_id
                            WHERE asset.id IS NULL
                        ) THEN
                            RAISE EXCEPTION 'content_asset_cutover_orphan_reference';
                        END IF;
                        IF EXISTS (
                            SELECT storage_key FROM content_asset
                            GROUP BY storage_key HAVING COUNT(DISTINCT sha256) > 1
                        ) THEN
                            RAISE EXCEPTION 'content_asset_cutover_storage_hash_conflict';
                        END IF;
                    END $$;
                    """),
                new RawSqlStep(
                    """
                    DO $$
                    DECLARE legacy_table text;
                    BEGIN
                        FOREACH legacy_table IN ARRAY ARRAY[
                            'article_asset_' || 'cleanup_queue',
                            'article_asset_' || 'reference',
                            'asset_library_' || 'article_ref',
                            'asset_library_' || 'item'
                        ]
                        LOOP
                            EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(legacy_table);
                        END LOOP;
                    END $$;
                    """)
            ]);
}
