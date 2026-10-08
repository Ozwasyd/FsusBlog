using FsusBlog.Migration.Definitions;

namespace FsusBlog.Migration.Catalogs;

internal static class SchemaMigrationCatalog20261008ArticlePropertyValues
{
    internal static SchemaMigrationCatalog Create()
        => new(
            CatalogId: "current-20261008-article-property-values",
            StartVersion: new DateOnly(2026, 10, 8),
            EndVersion: new DateOnly(2026, 10, 8),
            GapPolicy: SchemaMigrationGapPolicy.AllowSparseVersions,
            Dependencies:
            [
                new SchemaMigrationCatalogDependency(
                    ArticleCanvasLinkMigrationDefinitions.MigrationId,
                    SchemaMigrationPhase.PostCodeFirst)
            ],
            Descriptors: [ArticlePropertyValueMigrationDefinitions.BuildMigration()]);
}
