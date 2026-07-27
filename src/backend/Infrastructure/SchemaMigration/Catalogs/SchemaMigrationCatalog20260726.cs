using FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;

namespace FsusBlog.Server.Infrastructure.SchemaMigration.Catalogs;

internal static class SchemaMigrationCatalog20260726
{
    internal static SchemaMigrationCatalog Create()
        => new(
            CatalogId: "current-20260726",
            StartVersion: new DateOnly(2026, 7, 26),
            EndVersion: new DateOnly(2026, 7, 26),
            GapPolicy: SchemaMigrationGapPolicy.AllowSparseVersions,
            Dependencies: [new SchemaMigrationCatalogDependency(CustomizationMigrationDefinitions.MigrationId, SchemaMigrationPhase.PostCodeFirst)],
            Descriptors:
            [
                CommentMutationOutboxClaimLeaseMigrationDefinitions.BuildMigration(),
                DistributedInvalidationConvergenceObligationMigrationDefinitions.BuildMigration()
            ]);
}
