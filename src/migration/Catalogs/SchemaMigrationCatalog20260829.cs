using FsusBlog.Migration.Definitions;

namespace FsusBlog.Migration.Catalogs;

internal static class SchemaMigrationCatalog20260829
{
    internal static SchemaMigrationCatalog Create()
        => new(
            CatalogId: "current-20260829",
            StartVersion: new DateOnly(2026, 8, 29),
            EndVersion: new DateOnly(2026, 8, 29),
            GapPolicy: SchemaMigrationGapPolicy.AllowSparseVersions,
            Dependencies:
            [
                new SchemaMigrationCatalogDependency(
                    AuthoringCanvasDocumentMigrationDefinitions.MigrationId,
                    SchemaMigrationPhase.PostCodeFirst)
            ],
            Descriptors:
            [
                TaxonomyDescriptionMigrationDefinitions.BuildMigration()
            ]);
}
