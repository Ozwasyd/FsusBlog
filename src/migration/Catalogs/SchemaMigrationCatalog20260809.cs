using FsusBlog.Migration.Definitions;

namespace FsusBlog.Migration.Catalogs;

internal static class SchemaMigrationCatalog20260809
{
    internal static SchemaMigrationCatalog Create()
        => new(
            CatalogId: "current-20260809",
            StartVersion: new DateOnly(2026, 8, 9),
            EndVersion: new DateOnly(2026, 8, 9),
            GapPolicy: SchemaMigrationGapPolicy.AllowSparseVersions,
            Dependencies:
            [
                new SchemaMigrationCatalogDependency(
                    UserLocalePreferenceMigrationDefinitions.MigrationId,
                    SchemaMigrationPhase.PostCodeFirst)
            ],
            Descriptors:
            [
                DistributedInvalidationFullReconcileMigrationDefinitions.BuildMigration()
            ]);
}
