namespace FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;

internal static class ArticleAssetReferenceMigrationDefinitions
{
    internal const string MigrationId = "20260719-post-article-asset-reference-ledger";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Create authoritative article asset references and delayed cleanup queue.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "article_asset_reference",
                    """
                    CREATE TABLE IF NOT EXISTS article_asset_reference (
                        normalized_url varchar(512) NOT NULL,
                        source_kind varchar(16) NOT NULL,
                        source_key varchar(160) NOT NULL,
                        article_id integer NULL,
                        reference_count integer NOT NULL,
                        updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
                        PRIMARY KEY (normalized_url, source_kind, source_key),
                        CONSTRAINT ck_article_asset_reference_count CHECK (reference_count > 0),
                        CONSTRAINT ck_article_asset_reference_kind CHECK (source_kind IN ('article', 'draft', 'revision'))
                    );
                    """),
                new CreateIndexStep(
                    "idx_article_asset_reference_source",
                    """
                    CREATE INDEX IF NOT EXISTS idx_article_asset_reference_source
                    ON article_asset_reference(source_kind, source_key);
                    """),
                new CreateIndexStep(
                    "idx_article_asset_reference_article",
                    """
                    CREATE INDEX IF NOT EXISTS idx_article_asset_reference_article
                    ON article_asset_reference(article_id)
                    WHERE article_id IS NOT NULL;
                    """),
                new EnsureTableStep(
                    "article_asset_cleanup_queue",
                    """
                    CREATE TABLE IF NOT EXISTS article_asset_cleanup_queue (
                        normalized_url varchar(512) PRIMARY KEY,
                        not_before_utc timestamp NOT NULL,
                        attempt_count integer NOT NULL DEFAULT 0,
                        last_error varchar(512) NULL,
                        updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
                        CONSTRAINT ck_article_asset_cleanup_attempt CHECK (attempt_count >= 0)
                    );
                    """),
                new CreateIndexStep(
                    "idx_article_asset_cleanup_due",
                    """
                    CREATE INDEX IF NOT EXISTS idx_article_asset_cleanup_due
                    ON article_asset_cleanup_queue(not_before_utc, normalized_url);
                    """)
            ]);
}
