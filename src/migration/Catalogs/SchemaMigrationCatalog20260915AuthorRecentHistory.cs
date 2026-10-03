using FsusBlog.Migration.Definitions;

namespace FsusBlog.Migration.Catalogs;

internal static class SchemaMigrationCatalog20260915AuthorRecentHistory
{
    internal static SchemaMigrationCatalog Create()
        => new(
            CatalogId: "current-20260915-author-recent-history",
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
                AuthorRecentArticleHistoryMigrationDefinitions.BuildMigration()
            ]);
}
