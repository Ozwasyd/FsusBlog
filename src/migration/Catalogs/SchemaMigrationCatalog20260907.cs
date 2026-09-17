using FsusBlog.Migration.Definitions;

namespace FsusBlog.Migration.Catalogs;

internal static class SchemaMigrationCatalog20260907
{
    internal static SchemaMigrationCatalog Create()
        => new(
            CatalogId: "current-20260907-article-vault-execution",
            StartVersion: new DateOnly(2026, 9, 7),
            EndVersion: new DateOnly(2026, 9, 7),
            GapPolicy: SchemaMigrationGapPolicy.AllowSparseVersions,
            Dependencies:
            [
                new SchemaMigrationCatalogDependency(
                    AuthoringCanvasOperationJournalMigrationDefinitions.MigrationId,
                    SchemaMigrationPhase.PostCodeFirst)
            ],
            Descriptors:
            [
                ArticleVaultExecutionMigrationDefinitions.BuildMigration()
            ]);
}
