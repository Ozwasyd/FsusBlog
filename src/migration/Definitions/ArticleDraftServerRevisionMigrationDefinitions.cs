namespace FsusBlog.Migration.Definitions;

internal static class ArticleDraftServerRevisionMigrationDefinitions
{
    internal const string MigrationId = "20260720-pre-article-draft-server-revision";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Add a stable server-owned CAS revision to article drafts.",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("article_draft", "server_revision", "bigint NOT NULL DEFAULT 1")
            ]);
}
