using FsusBlog.Migration.Definitions;

namespace FsusBlog.Migration.Catalogs;

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
