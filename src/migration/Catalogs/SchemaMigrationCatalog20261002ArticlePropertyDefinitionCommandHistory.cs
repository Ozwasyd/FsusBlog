using FsusBlog.Migration.Definitions;

namespace FsusBlog.Migration.Catalogs;

internal static class SchemaMigrationCatalog20261002ArticlePropertyDefinitionCommandHistory
{
    internal static SchemaMigrationCatalog Create()
        => new(
            CatalogId: "current-20261002-article-property-definition-command-history",
            StartVersion: new DateOnly(2026, 10, 2),
            EndVersion: new DateOnly(2026, 10, 2),
            GapPolicy: SchemaMigrationGapPolicy.AllowSparseVersions,
            Dependencies:
            [
                new SchemaMigrationCatalogDependency(
                    ArticlePropertyDefinitionAuthorityMigrationDefinitions.MigrationId,
                    SchemaMigrationPhase.PostCodeFirst),
                new SchemaMigrationCatalogDependency(
                    AuthorRecentArticleHistoryMigrationDefinitions.MigrationId,
                    SchemaMigrationPhase.PostCodeFirst)
            ],
            Descriptors:
            [
                ArticlePropertyDefinitionCommandHistoryMigrationDefinitions.BuildMigration()
            ]);
}
