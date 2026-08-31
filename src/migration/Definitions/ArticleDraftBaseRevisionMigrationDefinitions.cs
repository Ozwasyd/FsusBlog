namespace FsusBlog.Migration.Definitions;

internal static class ArticleDraftBaseRevisionMigrationDefinitions
{
    internal const string MigrationId = "20260720-pre-article-draft-base-revision";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Persist the article revision coordinate captured by delayed server drafts.",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("article_draft", "base_revision_id", "bigint NULL")
            ]);
}
