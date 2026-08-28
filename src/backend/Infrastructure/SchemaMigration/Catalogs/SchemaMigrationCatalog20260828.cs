using FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;

namespace FsusBlog.Server.Infrastructure.SchemaMigration.Catalogs;

internal static class SchemaMigrationCatalog20260828
{
    internal static SchemaMigrationCatalog Create()
        => new(
            CatalogId: "current-20260828",
            StartVersion: new DateOnly(2026, 8, 28),
            EndVersion: new DateOnly(2026, 8, 28),
            GapPolicy: SchemaMigrationGapPolicy.AllowSparseVersions,
            Dependencies:
            [
                new SchemaMigrationCatalogDependency(
                    "20260720-pre-user-session-refresh-lineage",
                    SchemaMigrationPhase.PreCodeFirst),
                new SchemaMigrationCatalogDependency(
                    ContentAssetCutoverMigrationDefinitions.MigrationId,
                    SchemaMigrationPhase.PostCodeFirst)
            ],
            Descriptors:
            [
                AuthoringCanvasDocumentMigrationDefinitions.BuildMigration()
            ]);
}
