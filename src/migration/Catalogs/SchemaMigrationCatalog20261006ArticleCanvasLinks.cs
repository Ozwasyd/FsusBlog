using FsusBlog.Migration.Definitions;

namespace FsusBlog.Migration.Catalogs;

internal static class SchemaMigrationCatalog20261006ArticleCanvasLinks
{
    internal static SchemaMigrationCatalog Create()
        => new(
            CatalogId: "current-20261006-article-canvas-links",
            StartVersion: new DateOnly(2026, 10, 6),
            EndVersion: new DateOnly(2026, 10, 6),
            GapPolicy: SchemaMigrationGapPolicy.AllowSparseVersions,
            Dependencies:
            [
                new SchemaMigrationCatalogDependency(
                    ArticlePropertyDefinitionCommandHistoryMigrationDefinitions.MigrationId,
                    SchemaMigrationPhase.PostCodeFirst)
            ],
            Descriptors: [ArticleCanvasLinkMigrationDefinitions.BuildMigration()]);
}
