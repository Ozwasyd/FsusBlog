using FsusBlog.Migration.Definitions;

namespace FsusBlog.Migration.Catalogs;

internal static class SchemaMigrationCatalog20261011ArticleInbox
{
    internal static SchemaMigrationCatalog Create()
        => new(
            CatalogId: "current-20261011-article-inbox",
            StartVersion: new DateOnly(2026, 10, 11),
            EndVersion: new DateOnly(2026, 10, 11),
            GapPolicy: SchemaMigrationGapPolicy.AllowSparseVersions,
            Dependencies:
            [
                new SchemaMigrationCatalogDependency(
                    ArticleCreateAuthorityMigrationDefinitions.MigrationId,
                    SchemaMigrationPhase.PostCodeFirst)
            ],
            Descriptors: [ArticleInboxLifecycleMigrationDefinitions.BuildMigration()]);
}
