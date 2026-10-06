using FsusBlog.Migration.Definitions;

namespace FsusBlog.Migration.Catalogs;

internal static class SchemaMigrationCatalog20260915ArticlePropertyDefinitions
{
    internal static SchemaMigrationCatalog Create()
        => new(
            CatalogId: "current-20260915-article-property-definitions",
            StartVersion: new DateOnly(2026, 9, 15),
            EndVersion: new DateOnly(2026, 9, 15),
            GapPolicy: SchemaMigrationGapPolicy.AllowSparseVersions,
            Dependencies:
            [
                new SchemaMigrationCatalogDependency(
                    AdminSessionProjectionMigrationDefinitions.MigrationId,
                    SchemaMigrationPhase.PostCodeFirst)
            ],
            Descriptors:
            [
                ArticlePropertyDefinitionAuthorityMigrationDefinitions.BuildMigration()
            ]);
}
