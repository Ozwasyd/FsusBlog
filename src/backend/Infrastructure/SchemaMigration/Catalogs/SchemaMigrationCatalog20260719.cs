using FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;

namespace FsusBlog.Server.Infrastructure.SchemaMigration.Catalogs;

internal static class SchemaMigrationCatalog20260719
{
    internal static SchemaMigrationCatalog Create()
        => new(
            CatalogId: "current-20260719",
            StartVersion: new DateOnly(2026, 7, 19),
            EndVersion: new DateOnly(2026, 7, 19),
            GapPolicy: SchemaMigrationGapPolicy.AllowSparseVersions,
            Dependencies:
            [
                new SchemaMigrationCatalogDependency(
                    "20260716-post-comment-author-mode-retirement",
                    SchemaMigrationPhase.PostCodeFirst)
            ],
            Descriptors:
            [
                CommentModerationEventMigrationDefinitions.BuildCommentModerationEventMigration()
            ]);
}
