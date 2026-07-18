using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using NSubstitute;
using SqlSugar;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;
namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class AuthoringAssetLibraryRebuildTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task ReindexAssetsAsync_ConcurrentRebuildKeepsSingleAssetRow()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(setupDb);
        SeedArticleWithBody(setupDb, 42, "![Active](/uploads/illustration/active.png)");
        using SqlSugarClient firstDb = PostgresSqlSugarTestClient.Create(connectionString);
        using SqlSugarClient secondDb = PostgresSqlSugarTestClient.Create(connectionString);
        AuthoringWorkflowService firstService = CreateService(firstDb);
        AuthoringWorkflowService secondService = CreateService(secondDb);
        using var barrier = new Barrier(2);

        await Task.WhenAll(
                StartBarrierTaskAsync(barrier, () => firstService.ReindexAssetsAsync(42, CancellationToken.None)),
                StartBarrierTaskAsync(barrier, () => secondService.ReindexAssetsAsync(42, CancellationToken.None)))
            .WaitAsync(TimeSpan.FromSeconds(30));

        AssetLibraryItem item = Assert.Single(setupDb.Queryable<AssetLibraryItem>()
            .Where(asset => asset.Url == "/uploads/illustration/active.png")
            .ToList());
        Assert.Equal(1, item.ReferenceCount);
    }

    [Fact]
    public async Task ReindexAssetsAsync_RollsBackWhenRebuildFailsMidway()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        CreateTables(db);
        SeedArticleWithBody(db, 42, "![Active](/uploads/illustration/active.png)");
        SeedAsset(db, "/uploads/illustration/orphan.png", referenceCount: 7);
        InstallFailingActiveAssetInsertTrigger(db);
        AuthoringWorkflowService service = CreateService(db);

        await Assert.ThrowsAnyAsync<Exception>(() => service.ReindexAssetsAsync(42, CancellationToken.None));

        AssetLibraryItem orphan = db.Queryable<AssetLibraryItem>()
            .First(asset => asset.Url == "/uploads/illustration/orphan.png");
        Assert.False(db.Queryable<AssetLibraryItem>().Any(asset => asset.Url == "/uploads/illustration/active.png"));
        Assert.Equal(7, orphan.ReferenceCount);
        Assert.Equal(
            0,
            db.Ado.GetInt("SELECT COUNT(1) FROM asset_library_article_ref WHERE url = '/uploads/illustration/active.png';"));
    }

    private static void CreateTables(SqlSugarClient db)
    {
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(Article),
            typeof(ArticleBody),
            typeof(AssetLibraryItem));
        db.Ado.ExecuteCommand(
            """
            CREATE TABLE IF NOT EXISTS asset_library_article_ref (
                url varchar(512) NOT NULL,
                article_id integer NOT NULL,
                alt_text varchar(256) NULL,
                reference_count integer NOT NULL DEFAULT 0,
                updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
                PRIMARY KEY (url, article_id)
            );
            """);
    }

    private static void SeedArticleWithBody(SqlSugarClient db, int articleId, string markdown)
    {
        db.Ado.ExecuteCommand(
            """
            INSERT INTO article
                (id, title, categoryid, views, createtime, isdeleted, status, published_at, scheduled_publish_at)
            VALUES
                (@Id, @Title, 1, 0, @PublishedAt, false, @Status, @PublishedAt, NULL);
            """,
            new SugarParameter("@Id", articleId),
            new SugarParameter("@Title", $"Article {articleId}"),
            new SugarParameter("@Status", (int)ArticleStatus.Published),
            new SugarParameter("@PublishedAt", DateTime.UtcNow.AddMinutes(-1)));
        db.Insertable(new ArticleBody
        {
            ArticleId = articleId,
            MarkdownContent = markdown,
            UpdatedAt = DateTime.UtcNow
        }).ExecuteCommand();
    }

    private static void SeedAsset(SqlSugarClient db, string url, int referenceCount)
        => db.Insertable(new AssetLibraryItem
        {
            Url = url,
            Sha256 = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(url))),
            ReferenceCount = referenceCount,
            CreatedAt = DateTime.UtcNow.AddMinutes(-5),
            UpdatedAt = DateTime.UtcNow.AddMinutes(-5)
        }).ExecuteCommand();

    private static void InstallFailingActiveAssetInsertTrigger(SqlSugarClient db)
        => db.Ado.ExecuteCommand(
            """
            CREATE OR REPLACE FUNCTION fail_active_asset_insert()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $$
            BEGIN
                IF NEW.url = '/uploads/illustration/active.png' THEN
                    RAISE EXCEPTION 'unit active asset insert failure';
                END IF;

                RETURN NEW;
            END;
            $$;

            CREATE TRIGGER fail_active_asset_insert
            BEFORE INSERT ON asset_library_item
            FOR EACH ROW
            EXECUTE FUNCTION fail_active_asset_insert();
            """);

    private static AuthoringWorkflowService CreateService(SqlSugarClient db)
    {
        var contentFilter = Substitute.For<IContentFilterService>();
        contentFilter.ValidateContent(Arg.Any<string>())
            .Returns(new ContentValidationResult(true, string.Empty, string.Empty));
        return new AuthoringWorkflowService(
            db,
            Substitute.For<IArticleService>(),
            contentFilter,
            Substitute.For<IBlacklistService>(),
            Substitute.For<ICacheInvalidationDispatcher>(),
            Substitute.For<IMessageRealtimePublisher>(),
            Substitute.For<IMessageCommandService>(),
            new AuditLogChannel(),
            new ConfigurationBuilder().Build(),
            Substitute.For<ILogger<AuthoringWorkflowService>>());
    }

    private static Task<T> StartBarrierTaskAsync<T>(Barrier barrier, Func<Task<T>> action)
        => Task.Factory.StartNew(
            async () =>
            {
                Assert.True(
                    barrier.SignalAndWait(TimeSpan.FromSeconds(30)),
                    "Timed out waiting for concurrent asset rebuilds.");
                return await action();
            },
            CancellationToken.None,
            TaskCreationOptions.LongRunning,
            TaskScheduler.Default).Unwrap();
}
