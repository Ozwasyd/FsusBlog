using FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;

namespace FsusBlog.Server.Infrastructure.SchemaMigration.Catalogs;

internal static class SchemaMigrationCatalog20260720
{
    internal static SchemaMigrationCatalog Create()
        => new(
            CatalogId: "current-20260720",
            StartVersion: new DateOnly(2026, 7, 20),
            EndVersion: new DateOnly(2026, 7, 20),
            GapPolicy: SchemaMigrationGapPolicy.AllowSparseVersions,
            Dependencies:
            [
                new SchemaMigrationCatalogDependency(
                    "20260719-pre-article-publication-coordinates",
                    SchemaMigrationPhase.PreCodeFirst),
                new SchemaMigrationCatalogDependency(
                    UserSessionMultiDeviceMigrationDefinitions.MigrationId,
                    SchemaMigrationPhase.PostCodeFirst)
            ],
            Descriptors:
            [
                AccountEnrollmentMigrationDefinitions.BuildMigration(),
                PasskeySignalMigrationDefinitions.BuildMigration(),
                UserSessionAuthenticationContextMigrationDefinitions.BuildMigration(),
                RefreshTokenLineageMigrationDefinitions.BuildMigration(),
                CommentMutationIdempotencyMigrationDefinitions.BuildMigration(),
                CommentMutationOutboxMigrationDefinitions.BuildMigration(),
                ScheduledPublishIndexMigrationDefinitions.BuildMigration()
            ]);
}
