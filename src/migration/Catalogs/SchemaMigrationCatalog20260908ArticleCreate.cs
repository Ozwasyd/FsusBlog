using FsusBlog.Migration.Definitions;

namespace FsusBlog.Migration.Catalogs;

internal static class SchemaMigrationCatalog20260908ArticleCreate
{
    internal static SchemaMigrationCatalog Create()
        => new(
            CatalogId: "current-20260908-article-create",
            StartVersion: new DateOnly(2026, 9, 8),
            EndVersion: new DateOnly(2026, 9, 8),
            GapPolicy: SchemaMigrationGapPolicy.AllowSparseVersions,
            Dependencies:
            [
                new SchemaMigrationCatalogDependency(
                    ArticleVaultExecutionMigrationDefinitions.MigrationId,
                    SchemaMigrationPhase.PostCodeFirst)
            ],
            Descriptors:
            [
                ArticleCreateAuthorityMigrationDefinitions.BuildMigration()
            ]);
}
