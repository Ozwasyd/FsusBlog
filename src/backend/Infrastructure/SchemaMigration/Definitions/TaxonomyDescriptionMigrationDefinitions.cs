namespace FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;

internal static class TaxonomyDescriptionMigrationDefinitions
{
    internal const string MigrationId = "20260829-post-taxonomy-descriptions";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Add optional plain-text descriptions to category and tag taxonomy records.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("category", "description", "varchar(500) NULL"),
                new EnsureColumnStep("tag", "description", "varchar(500) NULL")
            ]);
}
