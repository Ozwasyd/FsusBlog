using FsusBlog.Migration.Definitions;

namespace FsusBlog.Migration.Catalogs;

internal static class SchemaMigrationCatalog20260913BanStateProjection
{
    internal static SchemaMigrationCatalog Create()
        => new(
            CatalogId: "current-20260913-ban-state-projection",
            StartVersion: new DateOnly(2026, 9, 13),
            EndVersion: new DateOnly(2026, 9, 13),
            GapPolicy: SchemaMigrationGapPolicy.AllowSparseVersions,
            Dependencies:
            [
                new SchemaMigrationCatalogDependency(
                    ContentAssetCutoverMigrationDefinitions.PrototypeShapeMigrationId,
                    SchemaMigrationPhase.PreCodeFirst),
                new SchemaMigrationCatalogDependency(
                    ArticleCreateAuthorityMigrationDefinitions.MigrationId,
                    SchemaMigrationPhase.PostCodeFirst)
            ],
            Descriptors:
            [
                BanStateProjectionMigrationDefinitions.BuildMigration(),
                AdminSessionProjectionMigrationDefinitions.BuildMigration()
            ]);
}
