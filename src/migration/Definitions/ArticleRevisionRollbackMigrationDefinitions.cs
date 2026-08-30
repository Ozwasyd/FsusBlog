namespace FsusBlog.Migration.Definitions;

internal static class ArticleRevisionRollbackMigrationDefinitions
{
    internal const string MigrationId = "20260720-pre-article-revision-rollback-package";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Add immutable rollback provenance to article revisions.",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("article_revision", "rollback_source_revision_id", "bigint NULL"),
                new EnsureColumnStep("article_revision", "rollback_reason", "varchar(500) NULL"),
                new CreateIndexStep(
                    "idx_article_revision_rollback_source",
                    """
                    CREATE INDEX IF NOT EXISTS idx_article_revision_rollback_source
                    ON article_revision(article_id, rollback_source_revision_id)
                    WHERE rollback_source_revision_id IS NOT NULL;
                    """)
            ]);
}
