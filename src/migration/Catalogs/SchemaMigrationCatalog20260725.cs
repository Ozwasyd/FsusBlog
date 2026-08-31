using FsusBlog.Migration.Definitions;

namespace FsusBlog.Migration.Catalogs;

internal static class SchemaMigrationCatalog20260725
{
    internal static SchemaMigrationCatalog Create()
        => new(
            CatalogId: "current-20260725",
            StartVersion: new DateOnly(2026, 7, 25),
            EndVersion: new DateOnly(2026, 7, 25),
            GapPolicy: SchemaMigrationGapPolicy.AllowSparseVersions,
            Dependencies:
            [
                new SchemaMigrationCatalogDependency(
                    ThemeActivationRuntimeMigrationDefinitions.MigrationId,
                    SchemaMigrationPhase.PostCodeFirst)
            ],
            Descriptors:
            [
                CustomizationMigrationDefinitions.BuildMigration()
            ]);
}
