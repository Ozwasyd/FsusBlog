using FsusBlog.Migration.Definitions;

namespace FsusBlog.Migration.Catalogs;

internal static class SchemaMigrationCatalog20260905ArticleTemplates
{
    internal static SchemaMigrationCatalog Create()
        => new(
            CatalogId: "current-20260905-article-templates",
            StartVersion: new DateOnly(2026, 9, 5),
            EndVersion: new DateOnly(2026, 9, 5),
            GapPolicy: SchemaMigrationGapPolicy.AllowSparseVersions,
            Dependencies:
            [
                new SchemaMigrationCatalogDependency(
                    AuthorSavedViewMigrationDefinitions.MigrationId,
                    SchemaMigrationPhase.PostCodeFirst)
            ],
            Descriptors:
            [
                ArticleTemplateAuthorityMigrationDefinitions.BuildMigration()
            ]);
}
