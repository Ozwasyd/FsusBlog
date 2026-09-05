using FsusBlog.Migration.Definitions;

namespace FsusBlog.Migration.Catalogs;

internal static class SchemaMigrationCatalog20260728
{
    internal static SchemaMigrationCatalog Create()
        => new(
            CatalogId: "current-20260728",
            StartVersion: new DateOnly(2026, 7, 28),
            EndVersion: new DateOnly(2026, 7, 28),
            GapPolicy: SchemaMigrationGapPolicy.AllowSparseVersions,
            Dependencies:
            [
                new SchemaMigrationCatalogDependency(
                    DistributedInvalidationDeliveryLedgerMigrationDefinitions.MigrationId,
                    SchemaMigrationPhase.PostCodeFirst)
            ],
            Descriptors:
            [
                UserLocalePreferenceMigrationDefinitions.BuildMigration()
            ]);
}
