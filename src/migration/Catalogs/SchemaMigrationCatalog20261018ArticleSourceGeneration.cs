using FsusBlog.Migration.Definitions;

namespace FsusBlog.Migration.Catalogs;

internal static class SchemaMigrationCatalog20261018ArticleSourceGeneration
{
    internal static SchemaMigrationCatalog Create()
        => new(
            CatalogId: "current-20261018-article-source-generation",
            StartVersion: new DateOnly(2026, 10, 18),
            EndVersion: new DateOnly(2026, 10, 18),
            GapPolicy: SchemaMigrationGapPolicy.AllowSparseVersions,
            Dependencies:
            [
                new SchemaMigrationCatalogDependency(
                    ArticlePropertyDefinitionCommandHistoryMigrationDefinitions.MigrationId,
                    SchemaMigrationPhase.PostCodeFirst)
            ],
            Descriptors:
            [
                ArticleSourceGenerationMigrationDefinitions.BuildMigration()
            ]);
}
