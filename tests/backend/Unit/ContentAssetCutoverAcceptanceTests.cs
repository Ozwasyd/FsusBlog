using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ContentAssetCutoverAcceptanceTests
{
    [Fact]
    public void Migration_IsSingleTransactionalBackfillBeforeLegacyRetirement()
    {
        ISchemaMigrationDescriptor migration = ContentAssetCutoverMigrationDefinitions.BuildMigration();

        Assert.True(migration.Transactional);
        Assert.Contains(migration.Steps, static step => step is ContentAssetCutoverBackfillStep);
        int backfill = migration.Steps.ToList().FindIndex(static step => step is ContentAssetCutoverBackfillStep);
        int retirement = migration.Steps.ToList().FindLastIndex(static step => step is RawSqlStep);
        Assert.True(backfill >= 0 && retirement > backfill);
        Assert.Contains("DROP TABLE IF EXISTS", migration.Steps[retirement].Fingerprint, StringComparison.Ordinal);
    }

    [Fact]
    public void Backfill_IsFailClosedAndVerifiesPhysicalMetadata()
    {
        ISchemaMigrationDescriptor migration = ContentAssetCutoverMigrationDefinitions.BuildMigration();
        ContentAssetCutoverBackfillStep backfill = Assert.IsType<ContentAssetCutoverBackfillStep>(
            Assert.Single(migration.Steps, static step => step is ContentAssetCutoverBackfillStep));

        Assert.Equal("ContentAssetCutoverBackfill", backfill.Kind);
        Assert.Equal("asset-id-v1:files+article+draft+revision:fail-closed", backfill.Fingerprint);
        Assert.Null(backfill.BuildCommand(PostgresSchemaDdlProvider.Instance));
    }

    [Fact]
    public void CanonicalSchemaUsesPostgreSqlUuidIdentityAndPreCodeFirstPrototypeConversion()
    {
        ISchemaMigrationDescriptor shape = ContentAssetCutoverMigrationDefinitions.BuildPrototypeShapeMigration();
        ISchemaMigrationDescriptor cutover = ContentAssetCutoverMigrationDefinitions.BuildMigration();
        string shapeSql = Assert.IsType<RawSqlStep>(Assert.Single(shape.Steps)).Fingerprint;
        string cutoverSql = string.Join('\n', cutover.Steps.Select(static step => step.Fingerprint));

        Assert.Equal(SchemaMigrationPhase.PreCodeFirst, shape.Phase);
        Assert.Contains("RENAME COLUMN asset_id TO id", shapeSql, StringComparison.Ordinal);
        Assert.Contains("ALTER COLUMN id TYPE uuid", shapeSql, StringComparison.Ordinal);
        Assert.Contains("id uuid PRIMARY KEY", cutoverSql, StringComparison.Ordinal);
        Assert.Contains("asset_id uuid NOT NULL REFERENCES content_asset(id)", cutoverSql, StringComparison.Ordinal);
        Assert.Equal(typeof(Guid), typeof(FsusBlog.Server.Entities.ContentAsset).GetProperty("AssetId")!.PropertyType);
        string root = Path.Combine(Path.GetTempPath(), $"fsusblog-asset-store-{Guid.NewGuid():N}");
        Assert.True(LocalContentAssetStore.TryResolveStoragePath(root, "illustration/hero.png", out string resolved));
        Assert.StartsWith(Path.GetFullPath(root), resolved, StringComparison.Ordinal);
        Assert.False(LocalContentAssetStore.TryResolveStoragePath(root, "../outside.png", out _));
    }

    [Fact]
    public void RuntimeHasOneLedgerAndNoUrlDeleteIdentity()
    {
        System.Reflection.MethodInfo handler = typeof(BinaryEndpoints).GetMethod(
            "HandleFileDeleteAsync",
            System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic)!;
        Assert.Contains(handler.GetParameters(), static parameter => parameter.ParameterType == typeof(IAssetStore));
        Assert.DoesNotContain(
            typeof(FileService).GetMethods(),
            static method => string.Equals(method.Name, "DeleteImageAsync", StringComparison.Ordinal));
        Assert.Contains(typeof(AuthoringAssetLibraryService).GetInterfaces(), static type => type == typeof(IAuthoringAssetQuery));
        Assert.Contains(typeof(AuthoringAssetLibraryService).GetInterfaces(), static type => type == typeof(IAuthoringAssetCommands));
        Assert.True(AssetId.TryParse("3f3b2e7a-1d2e-4f8a-9c5b-6a7b8c9d0e1f", out _));
        Assert.False(AssetId.TryParse("/uploads/illustration/hero.png", out _));
    }

    [Fact]
    public void DeleteInterface_IsStronglyTypedAssetId()
    {
        System.Reflection.MethodInfo method = Assert.Single(typeof(IAssetStore).GetMethods());
        Assert.Equal(typeof(AssetId), method.GetParameters()[0].ParameterType);
        Assert.DoesNotContain(
            typeof(BinaryEndpoints).GetMethods(System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic),
            static method => method.Name.Contains("NormalizeImageDelete", StringComparison.Ordinal));
        Assert.NotNull(typeof(AuthoringAssetLibraryService));
    }
}
