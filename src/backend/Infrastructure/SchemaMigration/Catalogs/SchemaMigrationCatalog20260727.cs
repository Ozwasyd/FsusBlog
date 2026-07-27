using FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;

namespace FsusBlog.Server.Infrastructure.SchemaMigration.Catalogs;

internal static class SchemaMigrationCatalog20260727
{
    internal static SchemaMigrationCatalog Create()
        => new(
            CatalogId: "current-20260727",
            StartVersion: new DateOnly(2026, 7, 27),
            EndVersion: new DateOnly(2026, 7, 27),
            GapPolicy: SchemaMigrationGapPolicy.AllowSparseVersions,
            Dependencies:
            [
                new SchemaMigrationCatalogDependency(
                    DistributedInvalidationConvergenceObligationMigrationDefinitions.MigrationId,
                    SchemaMigrationPhase.PostCodeFirst)
            ],
            Descriptors: [CommentMutationOutboxDeliveryReservationMigrationDefinitions.BuildMigration()]);
}
