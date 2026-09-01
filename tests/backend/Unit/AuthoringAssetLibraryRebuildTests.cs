using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.DependencyInjection;

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
    public void CanonicalProjection_IsAnUnactivatedIndependentQueryOwner()
    {
        string source = File.ReadAllText(ProjectionSourcePath());
        string bootstrap = BackendTestPaths.ReadAllTextFromRoot(
            "src/backend/Infrastructure/Bootstrap/RuntimeDomainServiceCollectionExtensions.cs");
        string productionService = File.ReadAllText(SourcePath<AuthoringAssetLibraryService>());

        Assert.Contains("FROM content_asset asset", source, StringComparison.Ordinal);
        Assert.Contains("content_asset_reference", source, StringComparison.Ordinal);
        Assert.DoesNotContain("asset_library_item", source, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("asset_library_article_ref", source, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("CREATE TABLE", source, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("ImageHelper", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Markdown", source, StringComparison.OrdinalIgnoreCase);
        var candidateServices = new ServiceCollection();
        candidateServices.AddContentAssetLibraryProjectionCandidate();
        ServiceDescriptor candidate = Assert.Single(
            candidateServices,
            static descriptor => descriptor.ServiceType == typeof(ContentAssetLibraryProjectionReader));

        Assert.Equal(ServiceLifetime.Scoped, candidate.Lifetime);
        Assert.DoesNotContain(nameof(ContentAssetLibraryProjectionReader), bootstrap, StringComparison.Ordinal);
        Assert.DoesNotContain(nameof(ContentAssetLibraryProjectionCandidateWiring.AddContentAssetLibraryProjectionCandidate), bootstrap, StringComparison.Ordinal);
        Assert.DoesNotContain(nameof(ContentAssetLibraryProjectionReader), productionService, StringComparison.Ordinal);
        Assert.Empty(typeof(ContentAssetLibraryProjectionReader).GetInterfaces());
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

    [Fact]
    public async Task CanonicalProjection_AggregatesAllSourcesAndProjectsMetadataAndState()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        DateTime updatedAt = DateTime.UtcNow.AddMinutes(-2);
        AssetId active = SeedAsset(
            db,
            Guid.Parse("00000000-0000-0000-0000-000000000001"),
            "illustration/active.png",
            ContentAssetStates.Active,
            updatedAt,
            ownerAdminPrincipalId: 17);
        AssetId pending = SeedAsset(
            db,
            Guid.Parse("00000000-0000-0000-0000-000000000002"),
            "illustration/pending.webp",
            ContentAssetStates.PendingDelete,
            updatedAt.AddMinutes(1),
            ownerAdminPrincipalId: null,
            mediaType: "image/webp",
            extension: ".webp");
        db.Insertable(new[]
        {
            Reference(active, ContentAssetSourceKinds.Article, "42", 2, "zeta", articleId: 42),
            Reference(active, ContentAssetSourceKinds.Draft, "17:article-42", 3, "alpha", articleId: 42),
            Reference(active, ContentAssetSourceKinds.Revision, "1001", 4, null, articleId: 42)
        }).ExecuteCommand();

        var reader = new ContentAssetLibraryProjectionReader(db);
        ContentAssetLibraryProjectionPage activePage = await reader.ListAsync(new(
            State: ContentAssetStates.Active,
            MediaType: " IMAGE/PNG ",
            OwnerAdminPrincipalId: 17,
            Referenced: true));
        ContentAssetLibraryProjectionItem item = Assert.Single(activePage.Items);

        Assert.Equal(active, item.AssetId);
        Assert.Equal("illustration/active.png", item.StorageKey.Value);
        Assert.Equal("/uploads/illustration/active.png", item.PublicUrl);
        Assert.Equal("public", item.StorageClass);
        Assert.Equal("image/png", item.MediaType);
        Assert.Equal(".png", item.Extension);
        Assert.Equal(24, item.ByteLength);
        Assert.Equal(new string('b', 64), item.Sha256);
        Assert.Equal(1, item.Width);
        Assert.Equal(1, item.Height);
        Assert.Equal(17, item.OwnerAdminPrincipalId);
        Assert.Equal(ContentAssetStates.Active, item.State);
        Assert.Equal(9, item.ReferenceCount);
        Assert.Equal(3, item.SourceCount);
        Assert.Equal("alpha", item.AltText);

        ContentAssetLibraryProjectionDetail detail = await GetRequiredAsync(reader, active);
        Assert.Equal(item, detail.Asset);
        Assert.Equal(
            [ContentAssetSourceKinds.Article, ContentAssetSourceKinds.Draft, ContentAssetSourceKinds.Revision],
            detail.Sources.Select(static source => source.SourceKind).ToArray());
        Assert.Equal([2, 3, 4], detail.Sources.Select(static source => source.ReferenceCount).ToArray());
        Assert.All(detail.Sources, static source => Assert.Equal(42, source.ArticleId));

        ContentAssetLibraryProjectionPage pendingPage = await reader.ListAsync(new(
            State: ContentAssetStates.PendingDelete,
            Referenced: false));
        Assert.Equal(pending, Assert.Single(pendingPage.Items).AssetId);
        Assert.Null(await reader.GetAsync(AssetId.New()));
    }

    [Fact]
    public async Task CanonicalProjection_PaginationFiltersAndSortsByAssetIdentityTieBreaker()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        DateTime timestamp = DateTime.UtcNow.AddMinutes(-1);
        AssetId[] assets = [.. Enumerable.Range(1, 6).Select(index => SeedAsset(
            db,
            Guid.Parse($"00000000-0000-0000-0000-{index:000000000000}"),
            $"illustration/{index}.png",
            index == 6 ? ContentAssetStates.PendingDelete : ContentAssetStates.Active,
            timestamp,
            ownerAdminPrincipalId: index <= 5 ? 17 : null))];
        db.Insertable(new[]
        {
            Reference(assets[0], ContentAssetSourceKinds.Article, "41", 5, null, 41),
            Reference(assets[1], ContentAssetSourceKinds.Article, "42", 5, null, 42),
            Reference(assets[2], ContentAssetSourceKinds.Article, "43", 2, null, 43)
        }).ExecuteCommand();
        var reader = new ContentAssetLibraryProjectionReader(db);

        ContentAssetLibraryProjectionPage first = await reader.ListAsync(new(
            Offset: 0,
            Limit: 2,
            State: ContentAssetStates.Active,
            MediaType: "image/png",
            OwnerAdminPrincipalId: 17));
        ContentAssetLibraryProjectionPage second = await reader.ListAsync(new(
            Offset: 2,
            Limit: 2,
            State: ContentAssetStates.Active,
            MediaType: "image/png",
            OwnerAdminPrincipalId: 17));

        Assert.True(first.HasMore);
        Assert.True(second.HasMore);
        Assert.Equal(
            assets.Take(4),
            first.Items.Concat(second.Items).Select(static item => item.AssetId));

        ContentAssetLibraryProjectionPage referenced = await reader.ListAsync(new(
            Referenced: true,
            Sort: ContentAssetLibraryProjectionSort.ReferenceCountDescending));
        Assert.Equal(
            [assets[0], assets[1], assets[2]],
            referenced.Items.Select(static item => item.AssetId).ToArray());
        ContentAssetLibraryProjectionPage orphaned = await reader.ListAsync(new(Referenced: false));
        Assert.Equal(3, orphaned.Items.Count);
        Assert.False(orphaned.HasMore);
    }

    [Fact]
    public async Task CanonicalProjection_ObservesCommittedReferenceSetWithoutPartialTransactions()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        AssetId assetId;
        using (SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString))
        {
            CreateTables(setupDb);
            assetId = SeedAsset(
                setupDb,
                Guid.Parse("00000000-0000-0000-0000-000000000099"),
                "illustration/transaction.png",
                ContentAssetStates.Active,
                DateTime.UtcNow,
                ownerAdminPrincipalId: 17);
            setupDb.Insertable(Reference(
                assetId,
                ContentAssetSourceKinds.Article,
                "42",
                1,
                null,
                42)).ExecuteCommand();
        }

        using SqlSugarClient writerDb = PostgresSqlSugarTestClient.Create(connectionString);
        using SqlSugarClient readerDb = PostgresSqlSugarTestClient.Create(connectionString);
        var projection = new ContentAssetLibraryProjectionReader(readerDb);
        await writerDb.Ado.BeginTranAsync();
        bool committed = false;
        try
        {
            writerDb.Deleteable<ContentAssetReference>()
                .Where(reference => reference.AssetId == assetId.Value)
                .ExecuteCommand();
            writerDb.Insertable(new[]
            {
                Reference(assetId, ContentAssetSourceKinds.Draft, "17:article-42", 4, null, 42),
                Reference(assetId, ContentAssetSourceKinds.Revision, "1001", 5, null, 42)
            }).ExecuteCommand();

            ContentAssetLibraryProjectionDetail beforeCommit = await GetRequiredAsync(projection, assetId);
            Assert.Equal(1, beforeCommit.Asset.ReferenceCount);
            Assert.Single(beforeCommit.Sources);

            await writerDb.Ado.CommitTranAsync();
            committed = true;
        }
        finally
        {
            if (!committed)
            {
                writerDb.Ado.RollbackTran();
            }
        }

        ContentAssetLibraryProjectionDetail afterCommit = await GetRequiredAsync(projection, assetId);
        Assert.Equal(9, afterCommit.Asset.ReferenceCount);
        Assert.Equal(2, afterCommit.Sources.Count);

        await writerDb.Ado.BeginTranAsync();
        writerDb.Deleteable<ContentAssetReference>()
            .Where(reference => reference.AssetId == assetId.Value)
            .ExecuteCommand();
        ContentAssetLibraryProjectionDetail duringRollback = await GetRequiredAsync(projection, assetId);
        Assert.Equal(9, duringRollback.Asset.ReferenceCount);
        writerDb.Ado.RollbackTran();
        Assert.Equal(9, (await GetRequiredAsync(projection, assetId)).Asset.ReferenceCount);
    }

    [Fact]
    public async Task CanonicalProjection_QueryCountIsConstantAtLargePageBoundary()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        DateTime timestamp = DateTime.UtcNow;
        ContentAsset[] assets = [.. Enumerable.Range(1, 250).Select(index => NewAsset(
            Guid.NewGuid(),
            $"illustration/bulk-{index}.png",
            ContentAssetStates.Active,
            timestamp.AddSeconds(-index),
            ownerAdminPrincipalId: 17))];
        db.Insertable(assets).ExecuteCommand();
        db.Insertable(assets.Select((asset, index) => Reference(
            AssetId.FromGuid(asset.AssetId),
            ContentAssetSourceKinds.Article,
            (index + 1).ToString(System.Globalization.CultureInfo.InvariantCulture),
            1,
            null,
            index + 1)).ToArray()).ExecuteCommand();
        var statements = new List<string>();
        db.Aop.OnLogExecuting = (sql, _) => statements.Add(sql);
        var reader = new ContentAssetLibraryProjectionReader(db);

        ContentAssetLibraryProjectionPage page = await reader.ListAsync(new(Limit: 100));
        Assert.Equal(100, page.Items.Count);
        Assert.True(page.HasMore);
        Assert.Single(statements);
        Assert.DoesNotContain("CREATE TABLE", statements[0], StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("asset_library_item", statements[0], StringComparison.OrdinalIgnoreCase);

        statements.Clear();
        ContentAssetLibraryProjectionDetail detail = await GetRequiredAsync(reader, page.Items[0].AssetId);
        Assert.Single(detail.Sources);
        Assert.Single(statements);
    }

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        CreateTables(db);
        return db;
    }

    private static async Task<ContentAssetLibraryProjectionDetail> GetRequiredAsync(
        ContentAssetLibraryProjectionReader reader,
        AssetId assetId)
    {
        ContentAssetLibraryProjectionDetail? detail = await reader.GetAsync(assetId);
        Assert.NotNull(detail);
        return detail!;
    }

    private static void CreateTables(SqlSugarClient db)
        => PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(ContentAsset),
            typeof(ContentAssetReference),
            typeof(ContentAssetCleanupQueueItem));

    private static AssetId SeedAsset(
        SqlSugarClient db,
        Guid assetId,
        string storageKey,
        string state,
        DateTime updatedAt,
        long? ownerAdminPrincipalId,
        string mediaType = "image/png",
        string extension = ".png")
    {
        db.Insertable(NewAsset(
            assetId,
            storageKey,
            state,
            updatedAt,
            ownerAdminPrincipalId,
            mediaType,
            extension)).ExecuteCommand();
        return AssetId.FromGuid(assetId);
    }

    private static ContentAsset NewAsset(
        Guid assetId,
        string storageKey,
        string state,
        DateTime updatedAt,
        long? ownerAdminPrincipalId,
        string mediaType = "image/png",
        string extension = ".png")
        => new()
        {
            AssetId = assetId,
            StorageClass = "public",
            StorageKey = storageKey,
            MimeType = mediaType,
            Extension = extension,
            SizeBytes = 24,
            Sha256 = new string('b', 64),
            WidthPixels = 1,
            HeightPixels = 1,
            OwnerAdminPrincipalId = ownerAdminPrincipalId,
            State = state,
            CreatedAtUtc = updatedAt.AddHours(-1),
            UpdatedAtUtc = updatedAt
        };

    private static ContentAssetReference Reference(
        AssetId assetId,
        string sourceKind,
        string sourceKey,
        int referenceCount,
        string? altText,
        int? articleId)
        => new()
        {
            AssetId = assetId.Value,
            SourceKind = sourceKind,
            SourceKey = sourceKey,
            ArticleId = articleId,
            ReferenceCount = referenceCount,
            AltText = altText,
            UpdatedAtUtc = DateTime.UtcNow
        };

    private static string SourcePath<T>()
        => BackendTestPaths.FromRoot(
            "src", "backend", "Services", "Authoring", "AuthoringAssetLibraryService.cs");

    private static string ProjectionSourcePath()
        => BackendTestPaths.FromRoot(
            "src", "backend", "Services", "Authoring", "ContentAssetLibraryProjectionReader.cs");
}
