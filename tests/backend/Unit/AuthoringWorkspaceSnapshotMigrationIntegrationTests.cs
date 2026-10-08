using FsusBlog.Migration;
using FsusBlog.Migration.Catalogs;
using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class AuthoringWorkspaceSnapshotMigrationIntegrationTests
{
    [Fact]
    public void MigrationAndRequiredRuntimeRecipe_PreserveExactPersistenceOffer()
    {
        ISchemaMigrationDescriptor descriptor = AuthoringWorkspaceSnapshotMigrationDefinitions.BuildMigration();
        Assert.Equal(SchemaMigrationPhase.PostCodeFirst, descriptor.Phase);
        Assert.True(descriptor.Transactional);
        string sql = Assert.IsType<RawSqlStep>(Assert.Single(descriptor.Steps)).Sql;
        CurrentSchemaRuntimeRollupTable runtime = Assert.Single(CurrentSchemaRuntimeRollupTables.Tables,
            static table => table.TableName == "authoring_workspace_snapshot");
        Assert.Equal(Normalize(sql), Normalize(runtime.CreateSql));
        Assert.Equal(Normalize(AuthoringWorkspaceSnapshotPostgresPersistence.SchemaSql),
            Normalize(sql.Replace("CREATE TABLE IF NOT EXISTS ", "CREATE TABLE ", StringComparison.Ordinal)));
        Assert.Null(runtime.AdditionalSql);
    }

    [Fact]
    public void SameDayManifest_ComposesPropertyAndWorkspaceWithoutCatalogOverlap()
    {
        SchemaMigrationManifest manifest = SchemaMigrationManifest.Current;
        SchemaMigrationCatalog catalog = Assert.Single(manifest.Catalogs,
            static candidate => candidate.StartVersion == new DateOnly(2026, 10, 8));
        Assert.Equal("current-20261008-authoring", catalog.CatalogId);
        Assert.Equal(new DateOnly(2026, 10, 8), catalog.EndVersion);
        Assert.Equal(new[] { ArticlePropertyValueMigrationDefinitions.MigrationId, AuthoringWorkspaceSnapshotMigrationDefinitions.MigrationId },
            catalog.Descriptors.Select(static descriptor => descriptor.MigrationId));
        SchemaMigrationCatalogDependency dependency = Assert.Single(catalog.Dependencies);
        Assert.Equal(ArticleCanvasLinkMigrationDefinitions.MigrationId, dependency.MigrationId);
        Assert.Equal(SchemaMigrationPhase.PostCodeFirst, dependency.Phase);
        Assert.Single(manifest.Descriptors, static descriptor => descriptor.MigrationId == AuthoringWorkspaceSnapshotMigrationDefinitions.MigrationId);
        Assert.Single(manifest.Descriptors, static descriptor => descriptor.MigrationId == ArticlePropertyValueMigrationDefinitions.MigrationId);
    }

    [Fact]
    public void SnapshotDdl_IsExplicitAdditiveExpandWithoutDestructiveAdmission()
    {
        OnlineSchemaMigrationMetadata metadata = new OnlineSchemaMigrationCatalog().GetMetadata()[
            AuthoringWorkspaceSnapshotMigrationDefinitions.MigrationId];
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, metadata.Phase);
        Assert.False(metadata.RequiresExclusiveMode);
        Assert.False(metadata.Destructive);
        Assert.False(metadata.LegacyBootstrapOnly);
        Assert.Equal(OnlineSchemaMigrationRollbackMode.CompatibleCode, metadata.RollbackMode);
        Assert.Equal(OnlineSchemaMigrationLockRisk.Low, metadata.EstimatedLockRisk);
        Assert.Contains("authoring_workspace_snapshot_owner_site_default", metadata.Validators);
        Assert.Contains("authoring_workspace_snapshot_canonical_cas", metadata.Validators);
        Assert.Contains("authoring_workspace_snapshot_bounded_bytes", metadata.Validators);
    }

    private static string Normalize(string sql)
        => string.Join('\n', sql.Split('\n').Select(static line => line.Trim()).Where(static line => line.Length > 0));
}
