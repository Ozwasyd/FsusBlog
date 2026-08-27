using FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;

namespace FsusBlog.Server.Infrastructure.SchemaMigration.Catalogs;

internal static class SchemaMigrationCatalog20260826
{
    internal static SchemaMigrationCatalog Create()
        => new(
            CatalogId: "current-20260826",
            StartVersion: new DateOnly(2026, 8, 26),
            EndVersion: new DateOnly(2026, 8, 26),
            GapPolicy: SchemaMigrationGapPolicy.AllowSparseVersions,
            Dependencies:
            [
                new SchemaMigrationCatalogDependency(
                    "20260720-pre-user-session-refresh-lineage",
                    SchemaMigrationPhase.PreCodeFirst),
                new SchemaMigrationCatalogDependency(
                    DistributedInvalidationFullReconcileMigrationDefinitions.MigrationId,
                    SchemaMigrationPhase.PostCodeFirst)
            ],
            Descriptors:
            [
                ContentAssetCutoverMigrationDefinitions.BuildPrototypeShapeMigration(),
                ContentAssetCutoverMigrationDefinitions.BuildMigration()
            ]);
}
