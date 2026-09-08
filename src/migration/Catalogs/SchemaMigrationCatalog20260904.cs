using FsusBlog.Migration.Definitions;

namespace FsusBlog.Migration.Catalogs;

internal static class SchemaMigrationCatalog20260904
{
    internal static SchemaMigrationCatalog Create()
        => new(
            CatalogId: "current-20260904",
            StartVersion: new DateOnly(2026, 9, 4),
            EndVersion: new DateOnly(2026, 9, 4),
            GapPolicy: SchemaMigrationGapPolicy.AllowSparseVersions,
            Dependencies:
            [
                new SchemaMigrationCatalogDependency(
                    TaxonomyDescriptionMigrationDefinitions.MigrationId,
                    SchemaMigrationPhase.PostCodeFirst)
            ],
            Descriptors:
            [
                AuthorArticlePinMigrationDefinitions.BuildMigration()
            ]);
}
