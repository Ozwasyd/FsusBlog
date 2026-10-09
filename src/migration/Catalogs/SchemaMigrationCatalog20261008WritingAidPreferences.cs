using FsusBlog.Migration.Definitions;

namespace FsusBlog.Migration.Catalogs;

internal static class SchemaMigrationCatalog20261008WritingAidPreferences
{
    internal static SchemaMigrationCatalog Create()
        => new(
            CatalogId: "current-20261008-writing-aid-preferences",
            StartVersion: new DateOnly(2026, 10, 8),
            EndVersion: new DateOnly(2026, 10, 8),
            GapPolicy: SchemaMigrationGapPolicy.AllowSparseVersions,
            Dependencies: [],
            Descriptors: [WritingAidPreferenceMigrationDefinitions.BuildMigration()]);
}
