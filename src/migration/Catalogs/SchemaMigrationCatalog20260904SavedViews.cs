using FsusBlog.Migration.Definitions;

namespace FsusBlog.Migration.Catalogs;

internal static class SchemaMigrationCatalog20260904SavedViews
{
    internal static SchemaMigrationCatalog Create()
        => new(
            CatalogId: "current-20260904-saved-views",
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
                AuthorSavedViewMigrationDefinitions.BuildMigration()
            ]);
}
