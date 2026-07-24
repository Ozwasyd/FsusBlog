using FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;

namespace FsusBlog.Server.Infrastructure.SchemaMigration.Catalogs;

internal static class SchemaMigrationCatalog20260724
{
    internal static SchemaMigrationCatalog Create()
        => new(
            CatalogId: "current-20260724",
            StartVersion: new DateOnly(2026, 7, 24),
            EndVersion: new DateOnly(2026, 7, 24),
            GapPolicy: SchemaMigrationGapPolicy.AllowSparseVersions,
            Dependencies:
            [
                new SchemaMigrationCatalogDependency(
                    ScheduledPublishIndexMigrationDefinitions.MigrationId,
                    SchemaMigrationPhase.PostCodeFirst)
            ],
            Descriptors:
            [
                PluginRegistryMigrationDefinitions.BuildMigration(),
                ThemeRegistryMigrationDefinitions.BuildMigration(),
                ThemeActivationRuntimeMigrationDefinitions.BuildMigration()
            ]);
}
