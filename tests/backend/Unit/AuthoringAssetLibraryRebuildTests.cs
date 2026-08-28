using System.Reflection;

using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class AuthoringAssetLibraryRebuildTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public void AssetLibraryProjection_HasNoRuntimeDdlOrMarkdownScanner()
    {
        string source = File.ReadAllText(SourcePath<AuthoringAssetLibraryService>());

        Assert.DoesNotContain("CREATE TABLE", source, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("ImageHelper", source, StringComparison.Ordinal);
        Assert.Contains("FROM content_asset asset", source, StringComparison.Ordinal);
        Assert.Contains("LEFT JOIN content_asset_reference", source, StringComparison.Ordinal);
        Assert.Contains("SUM(reference.reference_count)", source, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ListAssetsAsync_ProjectsExactAggregateFromCanonicalLedger()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(ContentAsset),
            typeof(ContentAssetReference),
            typeof(ContentAssetCleanupQueueItem));
        Guid assetId = Guid.NewGuid();
        DateTime updatedAt = DateTime.UtcNow.AddMinutes(-1);
        db.Insertable(new ContentAsset
        {
            AssetId = assetId,
            StorageClass = "public",
            StorageKey = "illustration/aggregate.png",
            MimeType = "image/png",
            Extension = ".png",
            SizeBytes = 24,
            Sha256 = new string('b', 64),
            WidthPixels = 1,
            HeightPixels = 1,
            State = ContentAssetStates.Active,
            CreatedAtUtc = updatedAt,
            UpdatedAtUtc = updatedAt
        }).ExecuteCommand();
        db.Insertable(new[]
        {
            new ContentAssetReference
            {
                AssetId = assetId,
                SourceKind = ContentAssetSourceKinds.Article,
                SourceKey = "42",
                ArticleId = 42,
                ReferenceCount = 2,
                AltText = "hero",
                UpdatedAtUtc = updatedAt
            },
            new ContentAssetReference
            {
                AssetId = assetId,
                SourceKind = ContentAssetSourceKinds.Draft,
                SourceKey = "44:article-42",
                ArticleId = 42,
                ReferenceCount = 1,
                UpdatedAtUtc = updatedAt
            }
        }).ExecuteCommand();

        var service = new AuthoringAssetLibraryService(db);
        AssetLibraryItemResponse item = Assert.Single(await service.ListAssetsAsync());

        Assert.Equal(assetId.ToString("D"), item.Id);
        Assert.Equal("/uploads/illustration/aggregate.png", item.Url);
        Assert.Equal("hero", item.AltText);
        Assert.Equal(42, item.SourceArticleId);
        Assert.Equal(3, item.ReferenceCount);
        Assert.Equal(new string('b', 64), item.Sha256);
    }

    private static string SourcePath<T>()
    {
        string repositoryRoot = Path.GetFullPath(Path.Combine(
            Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location)!,
            "../../../../../"));
        return Path.Combine(
            repositoryRoot,
            "src/backend/Services/Authoring/AuthoringAssetLibraryService.cs");
    }
}
