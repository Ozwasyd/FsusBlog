using FsusBlog.Migration;

namespace FsusBlog.Migration.Definitions;

internal static class AuthoringAndIntegrityMigrationDefinitions
{
    private const string LegacyAuthoringWorkspaceTablesChecksum = "6D43EB5F292169C39F022C7EE5F81591DBD28B3F89F83BB42FE75764B3E1DD77";

    internal static ISchemaMigrationDescriptor BuildAuthorAnalyticsRollupMigration()
        => new SchemaMigrationDescriptor(
            "20260629-post-author-analytics-rollups",
            "Create rollup tables for author analytics dashboard reads.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
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
                new EnsureTableStep(
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
                new EnsureTableStep(
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
                new EnsureTableStep(
                    "author_rum_page_type_stats",
                    """
                    CREATE TABLE IF NOT EXISTS author_rum_page_type_stats (
                        page_type varchar(32) PRIMARY KEY,
                        event_count integer NOT NULL DEFAULT 0,
                        updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
                    );
                    """),
                new EnsureTableStep(
                    "author_rum_aot_source_stats",
                    """
                    CREATE TABLE IF NOT EXISTS author_rum_aot_source_stats (
                        aot_source varchar(32) PRIMARY KEY,
                        event_count integer NOT NULL DEFAULT 0,
                        updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
                    );
                    """),
                new EnsureTableStep(
                    "author_aot_stats",
                    """
                    CREATE TABLE IF NOT EXISTS author_aot_stats (
                        metric_kind varchar(32) PRIMARY KEY,
                        event_count bigint NOT NULL DEFAULT 0,
                        updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
                    );
                    """),
                new BackfillSqlStep(
                    """
                    INSERT INTO author_daily_read_stats(stat_date, total_reads, article_reads, completed_article_reads, dwell_ms_total, updated_at_utc)
                    SELECT
                        createtime::date,
                        COUNT(1)::bigint,
                        COUNT(*) FILTER (WHERE event_type = 'article_read')::bigint,
                        COUNT(*) FILTER (WHERE event_type = 'article_read' AND dwell_ms >= 30000)::bigint,
                        COALESCE(SUM(GREATEST(dwell_ms, 0)), 0)::bigint,
                        now() AT TIME ZONE 'utc'
                    FROM sys_visit_log
                    WHERE event_type IN ('article_read', 'site_read')
                    GROUP BY createtime::date
                    ON CONFLICT (stat_date) DO UPDATE
                    SET total_reads = EXCLUDED.total_reads,
                        article_reads = EXCLUDED.article_reads,
                        completed_article_reads = EXCLUDED.completed_article_reads,
                        dwell_ms_total = EXCLUDED.dwell_ms_total,
                        updated_at_utc = EXCLUDED.updated_at_utc;
                    """),
                new BackfillSqlStep(
                    """
                    INSERT INTO author_route_stats(metric_kind, label, event_count, updated_at_utc)
                    SELECT
                        CASE
                            WHEN lower(route_key) LIKE 'search:%' THEN 'search_keyword'
                            WHEN lower(route_key) LIKE 'not-found:%' THEN 'not_found_path'
                            ELSE 'source_route'
                        END,
                        CASE
                            WHEN lower(route_key) LIKE 'search:%' THEN btrim(substr(route_key, 8))
                            WHEN lower(route_key) LIKE 'not-found:%' THEN btrim(substr(route_key, 11))
                            WHEN lower(route_key) = 'home' THEN '/'
                            WHEN lower(route_key) = 'about' THEN '/about'
                            WHEN lower(route_key) = 'archive' THEN '/archive'
                            WHEN lower(route_key) = 'search' THEN '/search'
                            WHEN lower(route_key) LIKE 'article:%' THEN '/article/' || substr(route_key, 9)
                            WHEN lower(route_key) LIKE 'category:%' THEN '/category/' || substr(route_key, 10)
                            WHEN lower(route_key) LIKE 'tag:%' THEN '/tag/' || substr(route_key, 5)
                            WHEN lower(route_key) LIKE 'tag-name:%' THEN '/tag/' || substr(route_key, 10)
                            ELSE btrim(route_key)
                        END,
                        COUNT(1)::integer,
                        now() AT TIME ZONE 'utc'
                    FROM sys_visit_log
                    WHERE route_key IS NOT NULL
                      AND btrim(route_key) <> ''
                      AND event_type IN ('article_read', 'site_read')
                    GROUP BY 1, 2
                    ON CONFLICT (metric_kind, label) DO UPDATE
                    SET event_count = EXCLUDED.event_count,
                        updated_at_utc = EXCLUDED.updated_at_utc;
                    """),
                new BackfillSqlStep(
                    """
                    INSERT INTO author_rum_stats(name, event_count, p75, average, updated_at_utc)
                    SELECT
                        name,
                        COUNT(1)::integer,
                        COALESCE(percentile_disc(0.75) WITHIN GROUP (ORDER BY value), 0)::double precision,
                        COALESCE(AVG(value), 0)::double precision,
                        now() AT TIME ZONE 'utc'
                    FROM frontend_rum_metric
                    WHERE value IS NOT NULL
                    GROUP BY name
                    ON CONFLICT (name) DO UPDATE
                    SET event_count = EXCLUDED.event_count,
                        p75 = EXCLUDED.p75,
                        average = EXCLUDED.average,
                        updated_at_utc = EXCLUDED.updated_at_utc;
                    """),
                new BackfillSqlStep(
                    """
                    INSERT INTO author_rum_page_type_stats(page_type, event_count, updated_at_utc)
                    SELECT page_type, COUNT(1)::integer, now() AT TIME ZONE 'utc'
                    FROM frontend_rum_metric
                    GROUP BY page_type
                    ON CONFLICT (page_type) DO UPDATE
                    SET event_count = EXCLUDED.event_count,
                        updated_at_utc = EXCLUDED.updated_at_utc;
                    """),
                new BackfillSqlStep(
                    """
                    INSERT INTO author_rum_aot_source_stats(aot_source, event_count, updated_at_utc)
                    SELECT aot_source, COUNT(1)::integer, now() AT TIME ZONE 'utc'
                    FROM frontend_rum_metric
                    GROUP BY aot_source
                    ON CONFLICT (aot_source) DO UPDATE
                    SET event_count = EXCLUDED.event_count,
                        updated_at_utc = EXCLUDED.updated_at_utc;
                    """),
                new BackfillSqlStep(
                    """
                    INSERT INTO author_aot_stats(metric_kind, event_count, updated_at_utc)
                    SELECT
                        'miss',
                        COUNT(*) FILTER (WHERE event_info ILIKE '%Public AOT cache miss%')::bigint,
                        now() AT TIME ZONE 'utc'
                    FROM sys_audit_log
                    WHERE source = 'public_aot'
                    ON CONFLICT (metric_kind) DO UPDATE
                    SET event_count = EXCLUDED.event_count,
                        updated_at_utc = EXCLUDED.updated_at_utc;
                    """)
            ]);

    internal static ISchemaMigrationDescriptor BuildVisitLogAnonymousAttributionFinalizeMigration()
        => new SchemaMigrationDescriptor(
            "20260621-post-visit-log-anonymous-attribution-finalize",
            "Drop legacy account binding columns from human-read visit logs.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new DropColumnStep("sys_visit_log", "userid", DestructiveMigrationProofs.For("20260621-post-visit-log-anonymous-attribution-finalize")),
                new DropColumnStep("sys_visit_log", "user_id", DestructiveMigrationProofs.For("20260621-post-visit-log-anonymous-attribution-finalize"))
            ]);

    internal static ISchemaMigrationDescriptor BuildVisitLogIpAnonymizationMigration()
        => new SchemaMigrationDescriptor(
            "20260621-post-visit-log-ip-anonymization",
            "Replace raw visit log IP persistence with server-peppered anonymous hashes.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("sys_visit_log", "ip_hash", "VARCHAR(64) NOT NULL DEFAULT ''"),
                new DropColumnStep("sys_visit_log", "ip", DestructiveMigrationProofs.For("20260621-post-visit-log-ip-anonymization"))
            ]);

    internal static ISchemaMigrationDescriptor BuildVisitLogIpPseudonymEpochCompatMigration()
        => new SchemaMigrationDescriptor(
            "20260715-pre-visit-log-ip-pseudonym-epoch",
            "Erase stable legacy visit-log hashes and add purpose-bound metadata before CodeFirst narrows the hash column.",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("sys_visit_log", "ip_hash_key_epoch", "integer NOT NULL DEFAULT 0"),
                new EnsureColumnStep("sys_visit_log", "ip_hash_window_utc", "integer NOT NULL DEFAULT 0"),
                new RawSqlStep("""
                    DO $$
                    BEGIN
                        IF EXISTS (
                            SELECT 1 FROM information_schema.tables
                            WHERE table_schema = 'public' AND table_name = 'sys_visit_log'
                        ) THEN
                            DELETE FROM sys_visit_log
                            WHERE ip_hash_key_epoch <= 0
                               OR ip_hash_window_utc <= 0
                               OR char_length(ip_hash) <> 32;

                            ALTER TABLE sys_visit_log
                            ALTER COLUMN ip_hash TYPE varchar(32);
                        END IF;
                    END $$;
                    """),
                new CreateIndexStep(
                    "idx_visit_ip_pseudonym",
                    "CREATE INDEX IF NOT EXISTS idx_visit_ip_pseudonym ON sys_visit_log(ip_hash_key_epoch, ip_hash_window_utc, ip_hash);")
            ]);

    internal static ISchemaMigrationDescriptor BuildAuthoringAdminPrincipalAttributionMigration()
        => new SchemaMigrationDescriptor(
            "20260621-pre-authoring-admin-principal-attribution",
            "Rename authoring draft and revision attribution columns to independent admin principal semantics.",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps:
            [
                new DropIndexStep("idx_article_draft_owner_key"),
                new RenameColumnStep("article_draft", "owner_user_id", "owner_admin_principal_id"),
                new RenameColumnStep("article_revision", "created_by_user_id", "created_by_admin_principal_id"),
                new EnsureColumnStep("article_draft", "owner_admin_principal_id", "bigint NOT NULL DEFAULT 0"),
                new EnsureColumnStep("article_revision", "created_by_admin_principal_id", "bigint NOT NULL DEFAULT 0"),
                new CopyColumnToColumnStep(
                    "article_draft",
                    "owner_user_id",
                    "owner_admin_principal_id",
                    TargetSqlExpression: null,
                    PredicateSql: "owner_admin_principal_id = 0"),
                new CopyColumnToColumnStep(
                    "article_revision",
                    "created_by_user_id",
                    "created_by_admin_principal_id",
                    TargetSqlExpression: null,
                    PredicateSql: "created_by_admin_principal_id = 0"),
                new DropColumnStep("article_draft", "owner_user_id", DestructiveMigrationProofs.For("20260621-pre-authoring-admin-principal-attribution")),
                new DropColumnStep("article_revision", "created_by_user_id", DestructiveMigrationProofs.For("20260621-pre-authoring-admin-principal-attribution")),
                new CreateIndexStep(
                    "idx_article_draft_admin_principal_key",
                    "CREATE UNIQUE INDEX IF NOT EXISTS idx_article_draft_admin_principal_key ON article_draft(owner_admin_principal_id, draft_key);")
            ]);

    internal static ISchemaMigrationDescriptor BuildSingleAuthorArticleLifecycleMigration()
        => new SchemaMigrationDescriptor(
            "20260518-pre-single-author-article-lifecycle",
            "Add article lifecycle state for draft, scheduled, published, archived, and deleted flows.",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("article", "status", "integer NOT NULL DEFAULT 2"),
                new EnsureColumnStep("article", "scheduled_publish_at", "timestamp NULL"),
                new EnsureColumnStep("article", "published_at", "timestamp NULL"),
                new EnsureColumnStep("article", "archived_at", "timestamp NULL"),
                new EnsureColumnStep("article", "deleted_at", "timestamp NULL"),
                new BackfillSqlStep("""
                    DO $$
                    BEGIN
                        IF EXISTS (
                            SELECT 1 FROM information_schema.tables
                            WHERE table_schema = 'public' AND table_name = 'article'
                        ) THEN
                            UPDATE article
                            SET status = CASE WHEN isdeleted THEN 4 ELSE 2 END,
                                published_at = COALESCE(published_at, createtime),
                                deleted_at = CASE WHEN isdeleted AND deleted_at IS NULL THEN now() ELSE deleted_at END
                            WHERE status IS NULL
                               OR published_at IS NULL
                               OR (isdeleted AND deleted_at IS NULL);
                        END IF;
                    END $$;
                    """),
                new CreateIndexStep(
                    "idx_article_public_state_time",
                    "CREATE INDEX IF NOT EXISTS idx_article_public_state_time ON article(status, isdeleted, published_at DESC, createtime DESC);"),
                new CreateIndexStep(
                    "idx_article_scheduled_publish",
                    "CREATE INDEX IF NOT EXISTS idx_article_scheduled_publish ON article(status, scheduled_publish_at) WHERE status = 1;")
            ]);

    internal static ISchemaMigrationDescriptor BuildSingleAuthorArticleLifecycleIndexMigration()
        => new SchemaMigrationDescriptor(
            "20260518-post-single-author-article-lifecycle-indexes",
            "Ensure article lifecycle indexes exist after CodeFirst creates fresh article tables.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new CreateIndexStep(
                    "idx_article_public_state_time",
                    "CREATE INDEX IF NOT EXISTS idx_article_public_state_time ON article(status, isdeleted, published_at DESC, createtime DESC);"),
                new CreateIndexStep(
                    "idx_article_scheduled_publish",
                    "CREATE INDEX IF NOT EXISTS idx_article_scheduled_publish ON article(status, scheduled_publish_at) WHERE status = 1;")
            ]);

    internal static ISchemaMigrationDescriptor BuildPublicArticleListKeysetIndexMigration()
        => new SchemaMigrationDescriptor(
            "20260628-post-public-article-list-keyset-indexes",
            "Ensure public article list keyset pagination and tag filters use covering indexes.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new CreateIndexStep(
                    "idx_article_public_status_deleted_publish_schedule_time_id",
                    "CREATE INDEX IF NOT EXISTS idx_article_public_status_deleted_publish_schedule_time_id ON article(status, isdeleted, published_at, scheduled_publish_at, createtime DESC, id DESC);"),
                new CreateIndexStep(
                    "idx_article_public_category_status_deleted_time_id",
                    "CREATE INDEX IF NOT EXISTS idx_article_public_category_status_deleted_time_id ON article(categoryid, status, isdeleted, createtime DESC, id DESC);"),
                new CreateIndexStep(
                    "idx_article_tag_tagid_articleid",
                    "CREATE INDEX IF NOT EXISTS idx_article_tag_tagid_articleid ON article_tag(tagid, articleid);")
            ]);

    internal static ISchemaMigrationDescriptor BuildArticleMutationOutboxEdgeMigration()
        => new SchemaMigrationDescriptor(
            "20260618-post-article-mutation-outbox-edge",
            "Create edge-level replay state for article mutation outbox events.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "article_mutation_outbox_edge",
                    """
                    CREATE TABLE IF NOT EXISTS article_mutation_outbox_edge (
                        id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                        outbox_event_id bigint NOT NULL,
                        edge_name varchar(64) NOT NULL,
                        status varchar(24) NOT NULL DEFAULT 'pending',
                        attempt_count integer NOT NULL DEFAULT 0,
                        last_error varchar(1024) NULL,
                        updated_at timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
                    );
                    """),
                new CreateIndexStep(
                    "ux_article_mutation_outbox_edge_event_name",
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS ux_article_mutation_outbox_edge_event_name
                    ON article_mutation_outbox_edge(outbox_event_id, edge_name);
                    """),
                new CreateIndexStep(
                    "idx_article_mutation_outbox_edge_status",
                    """
                    CREATE INDEX IF NOT EXISTS idx_article_mutation_outbox_edge_status
                    ON article_mutation_outbox_edge(status, updated_at DESC);
                    """)
            ]);

    internal static ISchemaMigrationDescriptor BuildArticleMutationOutboxClaimLeaseMigration()
        => new SchemaMigrationDescriptor(
            "20260715-post-article-mutation-outbox-claim-lease",
            "Add tokenized claim leases and deterministic edge delivery keys to article mutation outbox replay.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("article_mutation_outbox", "claim_token", "varchar(64) NULL"),
                new EnsureColumnStep("article_mutation_outbox", "claimed_by", "varchar(128) NULL"),
                new EnsureColumnStep("article_mutation_outbox", "claimed_at", "timestamp NULL"),
                new EnsureColumnStep("article_mutation_outbox", "heartbeat_at", "timestamp NULL"),
                new EnsureColumnStep("article_mutation_outbox", "claim_expires_at", "timestamp NULL"),
                new EnsureColumnStep("article_mutation_outbox_edge", "delivery_key", "varchar(64) NULL"),
                new CreateIndexStep(
                    "idx_article_mutation_outbox_claim",
                    "CREATE INDEX IF NOT EXISTS idx_article_mutation_outbox_claim ON article_mutation_outbox(status, claim_expires_at, id);")
            ]);

    internal static ISchemaMigrationDescriptor BuildActiveReleaseFenceDurableWitnessMigration()
        => new SchemaMigrationDescriptor(
            "20260715-post-active-release-fence-durable-witness",
            "Create the durable PostgreSQL witness for the active release generation fence.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
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
                    """)
            ]);

    internal static ISchemaMigrationDescriptor BuildActiveReleaseFencedCommitLedgerMigration()
        => new SchemaMigrationDescriptor(
            "20260715-post-active-release-fenced-commit-ledger",
            "Create the durable transaction-enlistment ledger for active release fenced commits.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
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
                    """),
                new CreateIndexStep(
                    "idx_sys_fenced_commit_enlisted",
                    """
                    CREATE INDEX IF NOT EXISTS idx_sys_fenced_commit_enlisted
                    ON sys_fenced_commit(enlisted_at_utc DESC, commit_token);
                    """),
                new CreateIndexStep(
                    "idx_sys_fenced_commit_generation_time",
                    """
                    CREATE INDEX IF NOT EXISTS idx_sys_fenced_commit_generation_time
                    ON sys_fenced_commit(generation, enlisted_at_utc DESC);
                    """)
            ]);

    internal static ISchemaMigrationDescriptor BuildAssetLibraryArticleRefMigration()
        => new SchemaMigrationDescriptor(
            "20260629-post-asset-library-article-ref",
            "Create article-scoped asset reference projection for targeted reindex.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "asset_library_article_ref",
                    """
                    CREATE TABLE IF NOT EXISTS asset_library_article_ref (
                        url varchar(512) NOT NULL,
                        article_id integer NOT NULL,
                        alt_text varchar(256) NULL,
                        reference_count integer NOT NULL DEFAULT 0,
                        updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
                        PRIMARY KEY (url, article_id)
                    );
                    """),
                new CreateIndexStep(
                    "idx_asset_library_article_ref_article",
                    """
                    CREATE INDEX IF NOT EXISTS idx_asset_library_article_ref_article
                    ON asset_library_article_ref(article_id);
                    """)
            ]);

    internal static ISchemaMigrationDescriptor BuildAuthoringWorkspaceTablesMigration()
        => new SchemaMigrationDescriptor(
            "20260518-post-authoring-workspace-tables",
            "Create durable authoring tables for server drafts, revisions, assets, and site subscriptions.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "article_draft",
                    """
                    CREATE TABLE IF NOT EXISTS article_draft (
                        id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                        owner_admin_principal_id bigint NOT NULL,
                        article_id integer NULL,
                        draft_key varchar(96) NOT NULL,
                        title varchar(256) NOT NULL DEFAULT '',
                        summary varchar(512) NULL,
                        cover_image_url varchar(512) NULL,
                        categoryid integer NOT NULL DEFAULT 0,
                        tag_ids text NOT NULL DEFAULT '',
                        markdown_content text NOT NULL DEFAULT '',
                        client_revision varchar(64) NULL,
                        updated_at timestamp NOT NULL DEFAULT now(),
                        created_at timestamp NOT NULL DEFAULT now()
                    );
                    """),
                new CreateIndexStep(
                    "idx_article_draft_admin_principal_key",
                    "CREATE UNIQUE INDEX IF NOT EXISTS idx_article_draft_admin_principal_key ON article_draft(owner_admin_principal_id, draft_key);"),
                new EnsureTableStep(
                    "article_revision",
                    """
                    CREATE TABLE IF NOT EXISTS article_revision (
                        id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                        article_id integer NOT NULL,
                        revision_no integer NOT NULL,
                        title varchar(256) NOT NULL DEFAULT '',
                        summary varchar(512) NULL,
                        cover_image_url varchar(512) NULL,
                        categoryid integer NOT NULL DEFAULT 0,
                        tag_ids text NOT NULL DEFAULT '',
                        markdown_content text NOT NULL DEFAULT '',
                        diff_summary varchar(512) NOT NULL DEFAULT '',
                        created_by_admin_principal_id bigint NOT NULL DEFAULT 0,
                        created_at timestamp NOT NULL DEFAULT now()
                    );
                    """),
                new CreateIndexStep(
                    "idx_article_revision_article_time",
                    "CREATE INDEX IF NOT EXISTS idx_article_revision_article_time ON article_revision(article_id, created_at DESC);"),
                new CreateIndexStep(
                    "ux_article_revision_article_revision_no",
                    "CREATE UNIQUE INDEX IF NOT EXISTS ux_article_revision_article_revision_no ON article_revision(article_id, revision_no);"),
                new EnsureTableStep(
                    "asset_library_item",
                    """
                    CREATE TABLE IF NOT EXISTS asset_library_item (
                        id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                        url varchar(512) NOT NULL,
                        alt_text varchar(256) NULL,
                        source_article_id integer NULL,
                        width integer NULL,
                        height integer NULL,
                        sha256 varchar(64) NULL,
                        reference_count integer NOT NULL DEFAULT 0,
                        created_at timestamp NOT NULL DEFAULT now(),
                        updated_at timestamp NOT NULL DEFAULT now()
                    );
                    """),
                new CreateIndexStep(
                    "idx_asset_library_hash",
                    "CREATE INDEX IF NOT EXISTS idx_asset_library_hash ON asset_library_item(sha256);"),
                new EnsureTableStep(
                    "site_subscription",
                    """
                    CREATE TABLE IF NOT EXISTS site_subscription (
                        id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                        email_hash varchar(64) NOT NULL,
                        hash_version varchar(16) NOT NULL DEFAULT 'hmac-v1',
                        channel varchar(32) NOT NULL DEFAULT 'rss',
                        is_enabled boolean NOT NULL DEFAULT true,
                        created_at timestamp NOT NULL DEFAULT now(),
                        unsubscribed_at timestamp NULL
                    );
                    """),
                new EnsureColumnStep("site_subscription", "hash_version", "varchar(16) NOT NULL DEFAULT 'hmac-v1'"),
                new CreateIndexStep(
                    "idx_site_subscription_email",
                    "CREATE UNIQUE INDEX IF NOT EXISTS idx_site_subscription_email ON site_subscription(email_hash);")
            ],
            CompatibleChecksums: [LegacyAuthoringWorkspaceTablesChecksum]);

    internal static ISchemaMigrationDescriptor BuildSiteSubscriptionHmacFinalizeMigration()
        => new SchemaMigrationDescriptor(
            "20260709-post-site-subscription-hmac-finalize",
            "Finalize site subscription HMAC identifiers and disable legacy SHA-256 rows.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new RawSqlStep("""
                    ALTER TABLE IF EXISTS site_subscription
                    ALTER COLUMN hash_version SET DEFAULT 'hmac-v1';
                    """),
                new RawSqlStep("""
                    DO $$
                    BEGIN
                        IF EXISTS (
                            SELECT 1 FROM information_schema.tables
                            WHERE table_schema = 'public'
                              AND table_name = 'site_subscription'
                        ) THEN
                            UPDATE site_subscription
                            SET hash_version = 'hmac-v1',
                                is_enabled = false,
                                unsubscribed_at = COALESCE(unsubscribed_at, now())
                            WHERE hash_version = 'sha256-legacy';
                        END IF;
                    END $$;
                    """),
                new AssertSqlStep(
                    "Legacy site subscription SHA-256 hash rows should be finalized.",
                    """
                    DO $$
                    DECLARE
                        legacy_count integer := 0;
                    BEGIN
                        IF EXISTS (
                            SELECT 1 FROM information_schema.tables
                            WHERE table_schema = 'public'
                              AND table_name = 'site_subscription'
                        ) THEN
                            SELECT COUNT(*) INTO legacy_count
                            FROM site_subscription
                            WHERE hash_version = 'sha256-legacy';

                            IF legacy_count <> 0 THEN
                                RAISE EXCEPTION 'Legacy site_subscription hash_version rows remain: %', legacy_count;
                            END IF;
                        END IF;
                    END $$;
                    """)
            ]);

    internal static ISchemaMigrationDescriptor BuildClearLegacyPublicArtifactsMigration()
        => new SchemaMigrationDescriptor(
            "20260709-post-clear-legacy-public-artifacts",
            "Clear legacy ArticleDetail AEDS files after Rights V3 cutover.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: false,
            Steps:
            [
                new ClearLegacyPublicArtifactsStep()
            ]);

    internal static ISchemaMigrationDescriptor BuildCommentModerationMigration()
        => new SchemaMigrationDescriptor(
            "20260518-pre-comment-moderation",
            "Add comment moderation state, reason, actor, and timestamp.",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("comment", "moderation_status", "integer NOT NULL DEFAULT 1"),
                new EnsureColumnStep("comment", "moderation_reason", "varchar(256) NULL"),
                new EnsureColumnStep("comment", "moderated_by_admin_principal_id", "bigint NULL"),
                new EnsureColumnStep("comment", "moderated_at", "timestamp NULL"),
                new CreateIndexStep(
                    "idx_comment_moderation_status_time",
                    "CREATE INDEX IF NOT EXISTS idx_comment_moderation_status_time ON comment(moderation_status, create_time DESC);")
            ]);

    internal static ISchemaMigrationDescriptor BuildCommentModerationAdminPrincipalAttributionMigration()
        => new SchemaMigrationDescriptor(
            "20260621-pre-comment-moderation-admin-principal-attribution",
            "Move comment moderation attribution from legacy user id to admin principal id.",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps:
            [
                new RenameColumnStep("comment", "moderated_by_user_id", "moderated_by_admin_principal_id"),
                new EnsureColumnStep("comment", "moderated_by_admin_principal_id", "bigint NULL"),
                new CopyColumnToColumnStep(
                    "comment",
                    "moderated_by_user_id",
                    "moderated_by_admin_principal_id",
                    TargetSqlExpression: null,
                    PredicateSql: "moderated_by_admin_principal_id IS NULL"),
                new DropColumnStep("comment", "moderated_by_user_id", DestructiveMigrationProofs.For("20260621-pre-comment-moderation-admin-principal-attribution"))
            ]);

    internal static ISchemaMigrationDescriptor BuildArticleRevisionAtomicRevisionNoMigration()
        => new SchemaMigrationDescriptor(
            "20260625-post-article-revision-atomic-revision-no",
            "Enforce per-article unique revision numbers before atomic revision allocation.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new CreateIndexStep(
                    "ux_article_revision_article_revision_no",
                    "CREATE UNIQUE INDEX IF NOT EXISTS ux_article_revision_article_revision_no ON article_revision(article_id, revision_no);")
            ]);

    internal static ISchemaMigrationDescriptor BuildArticlePublishProofMigration()
        => new SchemaMigrationDescriptor(
            "20260704-post-article-publish-proof",
            "Create durable publish proof records for signed article revision artifacts.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "article_publish_proof",
                    """
                    CREATE TABLE IF NOT EXISTS article_publish_proof (
                        id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                        proof_version integer NOT NULL DEFAULT 1,
                        signature_payload_version integer NOT NULL DEFAULT 1,
                        article_id integer NOT NULL,
                        article_revision_id bigint NOT NULL,
                        revision_no integer NOT NULL,
                        idempotency_key varchar(128) NOT NULL,
                        canonical_hash varchar(71) NOT NULL,
                        aot_hash varchar(71) NOT NULL,
                        article_detail_aeds_hash varchar(71) NOT NULL,
                        public_hot_read_hash varchar(71) NOT NULL,
                        asset_manifest_hash varchar(71) NOT NULL,
                        feed_hash varchar(71) NOT NULL,
                        published_at timestamp NOT NULL,
                        proof_status varchar(24) NOT NULL DEFAULT 'pending',
                        signing_key_id varchar(128) NULL,
                        signing_key_version integer NULL,
                        signing_algorithm varchar(32) NULL,
                        signature varchar(256) NULL,
                        failure_code varchar(64) NULL,
                        failure_detail varchar(512) NULL,
                        created_at timestamp NOT NULL DEFAULT now(),
                        updated_at timestamp NOT NULL DEFAULT now(),
                        superseded_at timestamp NULL
                    );
                    """),
                new CreateIndexStep(
                    "ux_article_publish_proof_idempotency",
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS ux_article_publish_proof_idempotency
                    ON article_publish_proof(idempotency_key);
                    """),
                new CreateIndexStep(
                    "idx_article_publish_proof_article_revision",
                    """
                    CREATE INDEX IF NOT EXISTS idx_article_publish_proof_article_revision
                    ON article_publish_proof(article_id, article_revision_id);
                    """),
                new CreateIndexStep(
                    "idx_article_publish_proof_status_time",
                    """
                    CREATE INDEX IF NOT EXISTS idx_article_publish_proof_status_time
                    ON article_publish_proof(proof_status, published_at DESC);
                    """)
            ]);

    internal static ISchemaMigrationDescriptor BuildArticleRightsV3SchemaMigration()
        => new SchemaMigrationDescriptor(
            "20260704-post-article-rights-v3-schema",
            "Create Rights V3 policy, snapshot, and proof tables with legacy article backfill seeds.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "article_rights_policy",
                    """
                    CREATE TABLE IF NOT EXISTS article_rights_policy (
                        id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                        article_id integer NOT NULL,
                        enabled boolean NOT NULL DEFAULT true,
                        license_type varchar(48) NOT NULL DEFAULT 'all-rights-reserved',
                        copyright_holder varchar(256) NULL,
                        copyright_year integer NULL,
                        rights_statement text NULL,
                        attribution_template text NULL,
                        copy_policy varchar(48) NOT NULL DEFAULT 'append-attribution',
                        max_excerpt_chars integer NOT NULL DEFAULT 300,
                        allow_code_copy boolean NOT NULL DEFAULT true,
                        show_public_badge boolean NOT NULL DEFAULT true,
                        proof_binding_enabled boolean NOT NULL DEFAULT true,
                        created_at timestamp NOT NULL DEFAULT now(),
                        updated_at timestamp NOT NULL DEFAULT now()
                    );
                    """),
                new EnsureTableStep(
                    "article_rights_snapshot",
                    """
                    CREATE TABLE IF NOT EXISTS article_rights_snapshot (
                        id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                        article_id integer NOT NULL,
                        article_revision_id bigint NOT NULL,
                        revision_no integer NOT NULL,
                        article_rights_policy_id bigint NOT NULL,
                        enabled boolean NOT NULL DEFAULT true,
                        license_type varchar(48) NOT NULL DEFAULT 'all-rights-reserved',
                        copyright_holder varchar(256) NULL,
                        copyright_year integer NULL,
                        rights_statement text NULL,
                        attribution_template text NULL,
                        copy_policy varchar(48) NOT NULL DEFAULT 'append-attribution',
                        max_excerpt_chars integer NOT NULL DEFAULT 300,
                        allow_code_copy boolean NOT NULL DEFAULT true,
                        show_public_badge boolean NOT NULL DEFAULT true,
                        proof_binding_enabled boolean NOT NULL DEFAULT true,
                        canonical_url varchar(512) NULL,
                        policy_hash varchar(96) NOT NULL DEFAULT 'rights-v3:policy-hash:recompute',
                        content_canonical_hash varchar(96) NOT NULL DEFAULT 'rights-v3:content-hash:recompute',
                        created_at timestamp NOT NULL DEFAULT now()
                    );
                    """),
                new EnsureTableStep(
                    "article_rights_proof",
                    """
                    CREATE TABLE IF NOT EXISTS article_rights_proof (
                        id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                        proof_version integer NOT NULL DEFAULT 1,
                        signature_payload_version integer NOT NULL DEFAULT 1,
                        article_id integer NOT NULL,
                        article_revision_id bigint NOT NULL,
                        revision_no integer NOT NULL,
                        article_rights_snapshot_id bigint NOT NULL,
                        publish_proof_id bigint NULL,
                        idempotency_key varchar(160) NOT NULL,
                        rights_policy_hash varchar(96) NOT NULL,
                        content_canonical_hash varchar(96) NOT NULL,
                        proof_status varchar(24) NOT NULL DEFAULT 'pending',
                        signing_key_id varchar(128) NULL,
                        signing_key_version integer NULL,
                        signing_algorithm varchar(32) NULL,
                        signature varchar(256) NULL,
                        failure_code varchar(64) NULL,
                        failure_detail varchar(512) NULL,
                        transparency_log_entry_id bigint NULL,
                        transparency_log_entry_hash varchar(64) NULL,
                        created_at timestamp NOT NULL DEFAULT now(),
                        updated_at timestamp NOT NULL DEFAULT now()
                    );
                    """),
                new CreateIndexStep(
                    "ux_article_rights_policy_article",
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS ux_article_rights_policy_article
                    ON article_rights_policy(article_id);
                    """),
                new CreateIndexStep(
                    "ux_article_rights_snapshot_article_revision",
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS ux_article_rights_snapshot_article_revision
                    ON article_rights_snapshot(article_id, article_revision_id);
                    """),
                new CreateIndexStep(
                    "idx_article_rights_snapshot_policy",
                    """
                    CREATE INDEX IF NOT EXISTS idx_article_rights_snapshot_policy
                    ON article_rights_snapshot(article_rights_policy_id);
                    """),
                new CreateIndexStep(
                    "idx_article_rights_snapshot_hash",
                    """
                    CREATE INDEX IF NOT EXISTS idx_article_rights_snapshot_hash
                    ON article_rights_snapshot(policy_hash);
                    """),
                new CreateIndexStep(
                    "ux_article_rights_proof_idempotency",
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS ux_article_rights_proof_idempotency
                    ON article_rights_proof(idempotency_key);
                    """),
                new CreateIndexStep(
                    "idx_article_rights_proof_article_revision",
                    """
                    CREATE INDEX IF NOT EXISTS idx_article_rights_proof_article_revision
                    ON article_rights_proof(article_id, article_revision_id);
                    """),
                new CreateIndexStep(
                    "idx_article_rights_proof_snapshot",
                    """
                    CREATE INDEX IF NOT EXISTS idx_article_rights_proof_snapshot
                    ON article_rights_proof(article_rights_snapshot_id);
                    """),
                new CreateIndexStep(
                    "idx_article_rights_proof_status_time",
                    """
                    CREATE INDEX IF NOT EXISTS idx_article_rights_proof_status_time
                    ON article_rights_proof(proof_status, created_at DESC);
                    """),
                new RawSqlStep("""
                    INSERT INTO article_rights_policy (
                        article_id,
                        enabled,
                        license_type,
                        copy_policy,
                        max_excerpt_chars,
                        allow_code_copy,
                        show_public_badge,
                        proof_binding_enabled,
                        created_at,
                        updated_at
                    )
                    SELECT
                        a.id,
                        true,
                        'all-rights-reserved',
                        'append-attribution',
                        300,
                        true,
                        true,
                        true,
                        now(),
                        now()
                    FROM article a
                    WHERE NOT EXISTS (
                        SELECT 1
                        FROM article_rights_policy existing
                        WHERE existing.article_id = a.id
                    );
                    """),
                new RawSqlStep("""
                    INSERT INTO article_rights_snapshot (
                        article_id,
                        article_revision_id,
                        revision_no,
                        article_rights_policy_id,
                        enabled,
                        license_type,
                        copyright_holder,
                        copyright_year,
                        rights_statement,
                        attribution_template,
                        copy_policy,
                        max_excerpt_chars,
                        allow_code_copy,
                        show_public_badge,
                        proof_binding_enabled,
                        policy_hash,
                        content_canonical_hash,
                        created_at
                    )
                    SELECT
                        latest.article_id,
                        latest.id,
                        latest.revision_no,
                        policy.id,
                        policy.enabled,
                        policy.license_type,
                        policy.copyright_holder,
                        policy.copyright_year,
                        policy.rights_statement,
                        policy.attribution_template,
                        policy.copy_policy,
                        policy.max_excerpt_chars,
                        policy.allow_code_copy,
                        policy.show_public_badge,
                        policy.proof_binding_enabled,
                        'rights-v3:policy-hash:recompute',
                        'rights-v3:content-hash:recompute',
                        now()
                    FROM (
                        SELECT DISTINCT ON (article_id)
                            id,
                            article_id,
                            revision_no,
                            created_at
                        FROM article_revision
                        ORDER BY article_id, revision_no DESC, created_at DESC, id DESC
                    ) latest
                    JOIN article_rights_policy policy
                      ON policy.article_id = latest.article_id
                    WHERE NOT EXISTS (
                        SELECT 1
                        FROM article_rights_snapshot existing
                        WHERE existing.article_id = latest.article_id
                          AND existing.article_revision_id = latest.id
                    );
                    """)
            ]);

    internal static ISchemaMigrationDescriptor BuildIntegrityTransparencyLogMigration()
        => new SchemaMigrationDescriptor(
            "20260704-post-integrity-transparency-log",
            "Create local append-only transparency log for publish proof history.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "integrity_transparency_log",
                    """
                    CREATE TABLE IF NOT EXISTS integrity_transparency_log (
                        id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                        seq bigint NOT NULL,
                        entry_type varchar(32) NOT NULL,
                        proof_id bigint NULL,
                        article_id integer NULL,
                        article_revision_id bigint NULL,
                        revision_no integer NULL,
                        entry_payload_hash varchar(64) NOT NULL,
                        prev_entry_hash varchar(64) NOT NULL,
                        entry_hash varchar(64) NOT NULL,
                        created_at timestamp NOT NULL DEFAULT now(),
                        signing_key_id varchar(128) NULL,
                        signature varchar(256) NULL
                    );
                    """),
                new EnsureColumnStep("article_publish_proof", "transparency_log_entry_id", "bigint NULL"),
                new EnsureColumnStep("article_publish_proof", "transparency_log_entry_hash", "varchar(64) NULL"),
                new CreateIndexStep(
                    "ux_integrity_transparency_log_seq",
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS ux_integrity_transparency_log_seq
                    ON integrity_transparency_log(seq);
                    """),
                new CreateIndexStep(
                    "ux_integrity_transparency_log_entry_hash",
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS ux_integrity_transparency_log_entry_hash
                    ON integrity_transparency_log(entry_hash);
                    """),
                new CreateIndexStep(
                    "ux_integrity_transparency_log_proof_entry",
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS ux_integrity_transparency_log_proof_entry
                    ON integrity_transparency_log(entry_type, proof_id);
                    """),
                new CreateIndexStep(
                    "idx_integrity_transparency_log_article_revision",
                    """
                    CREATE INDEX IF NOT EXISTS idx_integrity_transparency_log_article_revision
                    ON integrity_transparency_log(article_id, article_revision_id);
                    """),
                new CreateIndexStep(
                    "idx_integrity_transparency_log_created_at",
                    """
                    CREATE INDEX IF NOT EXISTS idx_integrity_transparency_log_created_at
                    ON integrity_transparency_log(created_at DESC);
                    """),
                new CreateIndexStep(
                    "idx_article_publish_proof_transparency_log",
                    """
                    CREATE INDEX IF NOT EXISTS idx_article_publish_proof_transparency_log
                    ON article_publish_proof(transparency_log_entry_id);
                    """)
            ]);

    internal static ISchemaMigrationDescriptor BuildIntegrityMerkleCheckpointMigration()
        => new SchemaMigrationDescriptor(
            "20260704-post-integrity-merkle-checkpoint",
            "Create signed Merkle checkpoints for transparency log inclusion proofs.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "integrity_merkle_checkpoint",
                    """
                    CREATE TABLE IF NOT EXISTS integrity_merkle_checkpoint (
                        id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                        checkpoint_kind varchar(24) NOT NULL,
                        scope_key varchar(64) NOT NULL,
                        from_seq bigint NOT NULL,
                        to_seq bigint NOT NULL,
                        entry_count integer NOT NULL,
                        root_hash varchar(64) NOT NULL,
                        log_head_seq bigint NOT NULL,
                        log_head_hash varchar(64) NOT NULL,
                        manifest_hash varchar(64) NOT NULL,
                        manifest_json text NOT NULL,
                        signing_key_id varchar(128) NOT NULL,
                        signing_algorithm varchar(32) NOT NULL,
                        signature varchar(256) NOT NULL,
                        created_at timestamp NOT NULL DEFAULT now()
                    );
                    """),
                new CreateIndexStep(
                    "ux_integrity_merkle_checkpoint_kind_scope",
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS ux_integrity_merkle_checkpoint_kind_scope
                    ON integrity_merkle_checkpoint(checkpoint_kind, scope_key);
                    """),
                new CreateIndexStep(
                    "idx_integrity_merkle_checkpoint_log_head",
                    """
                    CREATE INDEX IF NOT EXISTS idx_integrity_merkle_checkpoint_log_head
                    ON integrity_merkle_checkpoint(log_head_seq DESC, log_head_hash);
                    """),
                new CreateIndexStep(
                    "idx_integrity_merkle_checkpoint_root_hash",
                    """
                    CREATE INDEX IF NOT EXISTS idx_integrity_merkle_checkpoint_root_hash
                    ON integrity_merkle_checkpoint(root_hash);
                    """),
                new CreateIndexStep(
                    "idx_integrity_merkle_checkpoint_created_at",
                    """
                    CREATE INDEX IF NOT EXISTS idx_integrity_merkle_checkpoint_created_at
                    ON integrity_merkle_checkpoint(created_at DESC);
                    """)
            ]);

    internal static ISchemaMigrationDescriptor BuildAuthoringDraftLifecycleMigration()
        => new SchemaMigrationDescriptor(
            "20260518-post-authoring-draft-lifecycle",
            "Persist article lifecycle fields in durable authoring drafts.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("article_draft", "status", "integer NOT NULL DEFAULT 2"),
                new EnsureColumnStep("article_draft", "scheduled_publish_at", "timestamp NULL")
            ]);

    internal static ISchemaMigrationDescriptor BuildAuthoringAdminPrincipalAttributionIndexMigration()
        => new SchemaMigrationDescriptor(
            "20260621-post-authoring-admin-principal-attribution-indexes",
            "Ensure authoring draft admin-principal index exists after CodeFirst creates fresh tables.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new CreateIndexStep(
                    "idx_article_draft_admin_principal_key",
                    "CREATE UNIQUE INDEX IF NOT EXISTS idx_article_draft_admin_principal_key ON article_draft(owner_admin_principal_id, draft_key);")
            ]);

    internal static ISchemaMigrationDescriptor BuildCommentModerationIndexMigration()
        => new SchemaMigrationDescriptor(
            "20260518-post-comment-moderation-indexes",
            "Ensure comment moderation indexes exist after CodeFirst creates fresh comment tables.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new CreateIndexStep(
                    "idx_comment_moderation_status_time",
                    "CREATE INDEX IF NOT EXISTS idx_comment_moderation_status_time ON comment(moderation_status, create_time DESC);")
            ]);

    internal static ISchemaMigrationDescriptor BuildCommentRegionComplianceMigration()
        => new SchemaMigrationDescriptor(
            "20260610-post-comment-region-compliance",
            "Create region-aware comment compliance storage and lookup indexes.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "comment_region_compliance",
                    """
                    CREATE TABLE IF NOT EXISTS comment_region_compliance (
                        id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                        comment_id bigint NOT NULL,
                        submit_region varchar(64) NOT NULL,
                        submit_region_confidence double precision NOT NULL DEFAULT 0,
                        region_provider varchar(64) NOT NULL DEFAULT 'unknown',
                        submit_ip_hash varchar(64) NULL,
                        policy_version varchar(64) NOT NULL,
                        can_publish boolean NOT NULL,
                        requires_manual_review boolean NOT NULL DEFAULT false,
                        hide_until_reviewed boolean NOT NULL DEFAULT false,
                        blocked_regions text NOT NULL DEFAULT '',
                        risk_labels text NOT NULL DEFAULT '',
                        decision_reason varchar(256) NULL,
                        rule_hits_json text NULL,
                        created_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
                        updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
                    );
                    """),
                new CreateIndexStep(
                    "idx_comment_region_compliance_comment",
                    "CREATE INDEX IF NOT EXISTS idx_comment_region_compliance_comment ON comment_region_compliance(comment_id);"),
                new CreateIndexStep(
                    "idx_comment_region_compliance_submit_region",
                    "CREATE INDEX IF NOT EXISTS idx_comment_region_compliance_submit_region ON comment_region_compliance(submit_region, created_at_utc DESC);"),
                new CreateIndexStep(
                    "idx_comment_region_compliance_policy",
                    "CREATE INDEX IF NOT EXISTS idx_comment_region_compliance_policy ON comment_region_compliance(policy_version, created_at_utc DESC);")
            ]);

    internal static ISchemaMigrationDescriptor BuildCommentBlockedRegionLookupMigration()
        => new SchemaMigrationDescriptor(
            "20260628-post-comment-blocked-region-lookup",
            "Create indexable per-region comment visibility lookup rows.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "comment_blocked_region",
                    """
                    CREATE TABLE IF NOT EXISTS comment_blocked_region (
                        comment_id bigint NOT NULL,
                        region_code varchar(64) NOT NULL,
                        PRIMARY KEY(comment_id, region_code)
                    );
                    """),
                new CreateIndexStep(
                    "idx_comment_blocked_region_region_comment",
                    "CREATE INDEX IF NOT EXISTS idx_comment_blocked_region_region_comment ON comment_blocked_region(region_code, comment_id);"),
                new BackfillSqlStep(
                    """
                    INSERT INTO comment_blocked_region(comment_id, region_code)
                    SELECT DISTINCT crc.comment_id, upper(trim(region_code)) AS region_code
                    FROM comment_region_compliance crc
                    CROSS JOIN LATERAL regexp_split_to_table(trim(both ',' from crc.blocked_regions), ',') AS region_code
                    WHERE crc.blocked_regions <> ''
                      AND trim(region_code) <> ''
                    ON CONFLICT (comment_id, region_code) DO NOTHING;
                    """)
            ]);

    internal static ISchemaMigrationDescriptor BuildCommentModerationSignalMigration()
        => new SchemaMigrationDescriptor(
            "20260610-post-comment-moderation-signal",
            "Create optional anti-spam model signal storage for comment moderation.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "comment_moderation_signal",
                    """
                    CREATE TABLE IF NOT EXISTS comment_moderation_signal (
                        id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                        comment_id bigint NOT NULL,
                        provider varchar(64) NOT NULL,
                        model varchar(128) NOT NULL,
                        contract_version varchar(64) NOT NULL,
                        label varchar(64) NOT NULL,
                        severity varchar(32) NOT NULL,
                        confidence double precision NOT NULL DEFAULT 0,
                        primary_reason varchar(128) NULL,
                        needs_second_round boolean NOT NULL DEFAULT false,
                        risk_categories text NULL,
                        evidence_json text NULL,
                        raw_reason text NULL,
                        latency_ms integer NOT NULL DEFAULT 0,
                        status varchar(32) NOT NULL DEFAULT 'ok',
                        error_code varchar(64) NULL,
                        threshold_profile varchar(128) NULL,
                        metadata_json text NULL,
                        created_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
                    );
                    """),
                new CreateIndexStep(
                    "idx_comment_moderation_signal_comment_id",
                    "CREATE INDEX IF NOT EXISTS idx_comment_moderation_signal_comment_id ON comment_moderation_signal(comment_id);"),
                new CreateIndexStep(
                    "idx_comment_moderation_signal_provider_time",
                    "CREATE INDEX IF NOT EXISTS idx_comment_moderation_signal_provider_time ON comment_moderation_signal(provider, created_at_utc DESC);"),
                new CreateIndexStep(
                    "idx_comment_moderation_signal_label_confidence",
                    "CREATE INDEX IF NOT EXISTS idx_comment_moderation_signal_label_confidence ON comment_moderation_signal(label, confidence DESC);"),
                new CreateIndexStep(
                    "idx_comment_moderation_signal_second_round",
                    "CREATE INDEX IF NOT EXISTS idx_comment_moderation_signal_second_round ON comment_moderation_signal(needs_second_round, created_at_utc DESC);")
            ]);

    internal static ISchemaMigrationDescriptor BuildCommentModerationSignalLatestIndexMigration()
        => new SchemaMigrationDescriptor(
            "20260629-post-comment-moderation-signal-latest-index",
            "Index moderation signals for latest-per-comment queue lookups.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new CreateIndexStep(
                    "idx_comment_moderation_signal_comment_created",
                    "CREATE INDEX IF NOT EXISTS idx_comment_moderation_signal_comment_created ON comment_moderation_signal(comment_id, created_at_utc DESC, id DESC);")
            ]);

    internal static ISchemaMigrationDescriptor BuildCommentPublicHotPathIndexMigration()
        => new SchemaMigrationDescriptor(
            "20260603-post-comment-public-hot-path-indexes",
            "Add partial indexes for public approved comment roots, replies, reply counts, and recent stats.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new CreateIndexStep(
                    "idx_comment_public_roots",
                    """
                    CREATE INDEX IF NOT EXISTS idx_comment_public_roots
                    ON comment(article_id, id DESC)
                    WHERE parent_id IS NULL AND moderation_status = 1 AND is_deleted = false;
                    """),
                new CreateIndexStep(
                    "idx_comment_public_replies",
                    """
                    CREATE INDEX IF NOT EXISTS idx_comment_public_replies
                    ON comment(article_id, root_id, id ASC)
                    WHERE parent_id IS NOT NULL AND moderation_status = 1 AND is_deleted = false;
                    """),
                new CreateIndexStep(
                    "idx_comment_public_reply_count",
                    """
                    CREATE INDEX IF NOT EXISTS idx_comment_public_reply_count
                    ON comment(article_id, root_id)
                    WHERE parent_id IS NOT NULL AND moderation_status = 1 AND is_deleted = false;
                    """),
                new CreateIndexStep(
                    "idx_comment_public_create_time_desc",
                    """
                    CREATE INDEX IF NOT EXISTS idx_comment_public_create_time_desc
                    ON comment(create_time DESC)
                    WHERE moderation_status = 1 AND is_deleted = false;
                    """)
            ]);
}
