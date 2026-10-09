namespace FsusBlog.Migration.Definitions;

internal static class ArticleCanvasLinkMigrationDefinitions
{
    internal const string MigrationId = "20261006-post-article-canvas-link-history";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Add article-owned Canvas link receipts and revision-only undo history.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new RawSqlStep("""
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
                    CREATE INDEX IF NOT EXISTS ix_article_canvas_link_source
                        ON article_canvas_link_journal(owner_admin_principal_id, site_scope, source_article_id, created_at_utc, journal_id);

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
                    """)
            ]);
}
