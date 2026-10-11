namespace FsusBlog.Migration.Definitions;

internal static class ArticleInboxLifecycleMigrationDefinitions
{
    internal const string MigrationId = "20261011-post-article-inbox-editable-source";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Add nullable exact editable lifecycle provenance without guessing or rewriting historical drafts.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new RawSqlStep("""
                    ALTER TABLE article ADD COLUMN IF NOT EXISTS previous_editable_status integer NULL;
                    """)
            ]);
}
