namespace FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;

internal static class ArticleTimeSemanticsMigrationDefinitions
{
    internal const string MigrationId = "20260720-pre-article-time-semantics";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Separate article metadata, first/last publication, and public revision timestamps.",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("article", "metadata_updated_at", "timestamp NULL"),
                new EnsureColumnStep("article", "last_published_at", "timestamp NULL"),
                new EnsureColumnStep("article", "public_updated_at", "timestamp NULL"),
                new BackfillSqlStep(
                    """
                    UPDATE article article
                    SET metadata_updated_at = COALESCE(
                            (
                                SELECT revision.created_at
                                FROM article_revision revision
                                WHERE revision.id = article.current_revision_id
                            ),
                            article.createtime),
                        published_at = COALESCE(
                            (
                                SELECT MIN(publication.published_at)
                                FROM article_publication publication
                                WHERE publication.article_id = article.id
                            ),
                            article.published_at),
                        last_published_at = COALESCE(
                            (
                                SELECT MAX(publication.published_at)
                                FROM article_publication publication
                                WHERE publication.article_id = article.id
                            ),
                            article.published_at),
                        public_updated_at = CASE
                            WHEN article.status = 2 AND article.current_publication_id IS NOT NULL THEN
                                COALESCE(
                                    (
                                        SELECT publication.created_at
                                        FROM article_publication publication
                                        WHERE publication.id = article.current_publication_id
                                    ),
                                    article.published_at,
                                    article.createtime)
                            ELSE NULL
                        END;
                    """),
                new RawSqlStep(
                    """
                    ALTER TABLE article
                        ALTER COLUMN metadata_updated_at SET DEFAULT (now() AT TIME ZONE 'utc'),
                        ALTER COLUMN metadata_updated_at SET NOT NULL;
                    """),
                new AssertSqlStep(
                    "Article timestamps retain first/last publication order and a deterministic metadata clock.",
                    """
                    DO $$
                    BEGIN
                    IF EXISTS (
                        SELECT 1
                        FROM article
                        WHERE metadata_updated_at IS NULL
                           OR (published_at IS NOT NULL AND last_published_at IS NULL)
                           OR (published_at IS NOT NULL AND last_published_at < published_at)
                           OR (public_updated_at IS NOT NULL AND published_at IS NOT NULL AND public_updated_at < published_at)
                    ) THEN
                        RAISE EXCEPTION 'Article time semantics backfill is inconsistent.';
                    END IF;
                    END $$;
                    """)
            ]);
}
