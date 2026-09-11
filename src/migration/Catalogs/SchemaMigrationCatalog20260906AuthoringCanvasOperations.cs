using FsusBlog.Migration.Definitions;

namespace FsusBlog.Migration.Catalogs;

internal static class SchemaMigrationCatalog20260906AuthoringCanvasOperations
{
    internal static SchemaMigrationCatalog Create()
        => new(
            CatalogId: "current-20260906-authoring-canvas-operations",
            StartVersion: new DateOnly(2026, 9, 6),
            EndVersion: new DateOnly(2026, 9, 6),
            GapPolicy: SchemaMigrationGapPolicy.AllowSparseVersions,
            Dependencies:
            [
                new SchemaMigrationCatalogDependency(
                    TaxonomyDescriptionMigrationDefinitions.MigrationId,
                    SchemaMigrationPhase.PostCodeFirst)
            ],
            Descriptors:
            [
                AuthoringCanvasOperationJournalMigrationDefinitions.BuildMigration()
            ]);
}
