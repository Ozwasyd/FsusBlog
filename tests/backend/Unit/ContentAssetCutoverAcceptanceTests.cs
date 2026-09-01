using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Modules.Endpoints.Binary;
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
        string source = ReadSource("src/backend/Infrastructure/SchemaMigration/ContentAssetCutoverBackfill.cs");

        Assert.Contains("missing_file:", source, StringComparison.Ordinal);
        Assert.Contains("hash_conflict:", source, StringComparison.Ordinal);
        Assert.Contains("unrecognized_media:", source, StringComparison.Ordinal);
        Assert.Contains("SHA256.HashData", source, StringComparison.Ordinal);
        Assert.Contains("Directory.EnumerateFiles", source, StringComparison.Ordinal);
        Assert.Contains("ContentAssetSourceKinds.Revision", source, StringComparison.Ordinal);
        Assert.Contains("Path.GetRelativePath", source, StringComparison.Ordinal);
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
        Assert.Contains("Path.GetRelativePath", ReadSource("src/backend/Services/LocalContentAssetStore.cs"), StringComparison.Ordinal);
    }

    [Fact]
    public void RuntimeHasOneLedgerAndNoUrlDeleteIdentity()
    {
        string endpoint = ReadSource("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Files.cs");
        string authoring = ReadSource("src/backend/Services/Authoring/AuthoringAssetLibraryService.cs");
        string fileService = ReadSource("src/backend/Services/FileService.cs");

        Assert.Contains("AssetId.TryParse", endpoint, StringComparison.Ordinal);
        Assert.Contains("IAssetStore assetStore", endpoint, StringComparison.Ordinal);
        Assert.DoesNotContain("Path.", endpoint, StringComparison.Ordinal);
        Assert.DoesNotContain("DeleteImageAsync", fileService, StringComparison.Ordinal);
        Assert.DoesNotContain("CREATE TABLE", authoring, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("ImageHelper", authoring, StringComparison.Ordinal);
        Assert.Contains("content_asset_reference", authoring, StringComparison.Ordinal);
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

    private static string ReadSource(string relativePath)
        => BackendTestPaths.ReadAllTextFromRoot(relativePath);
}
