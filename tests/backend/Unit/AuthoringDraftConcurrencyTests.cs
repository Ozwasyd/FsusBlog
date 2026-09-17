using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;

using NSubstitute;

using SqlSugar;
namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class AuthoringDraftConcurrencyTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task SaveDraftAsync_ConcurrentCreateAllowsExactlyOneWriter()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(
            setupDb,
            typeof(ArticleDraft),
            typeof(ContentAssetReference),
            typeof(ContentAssetCleanupQueueItem));
        using SqlSugarClient firstDb = PostgresSqlSugarTestClient.Create(connectionString);
        using SqlSugarClient secondDb = PostgresSqlSugarTestClient.Create(connectionString);
        AuthoringDraftLifecycleService firstService = CreateService(firstDb);
        AuthoringDraftLifecycleService secondService = CreateService(secondDb);
        using var barrier = new Barrier(2);

        object[] outcomes = await Task.WhenAll(
                StartBarrierTaskAsync(barrier, () => CaptureSaveAsync(firstService, CreateRequest("rev-a", "first content"))),
                StartBarrierTaskAsync(barrier, () => CaptureSaveAsync(secondService, CreateRequest("rev-b", "second content"))))
            .WaitAsync(TimeSpan.FromSeconds(30));

        ServerDraftResponse response = Assert.Single(outcomes.OfType<ServerDraftResponse>());
        ServerDraftConflictException conflict = Assert.Single(outcomes.OfType<ServerDraftConflictException>());
        Assert.Equal(1, response.ServerRevision);
        Assert.Equal(1, conflict.Conflict.CurrentServerRevision);
        ArticleDraft draft = Assert.Single(setupDb.Queryable<ArticleDraft>().ToList());
        Assert.Equal(7, draft.OwnerAdminPrincipalId);
        Assert.Equal("race-draft", draft.DraftKey);
        Assert.Contains(draft.ClientRevision, new[] { "rev-a", "rev-b" });
        Assert.Equal(1, draft.ServerRevision);
    }

    [Fact]
    public async Task SaveDraftAsync_StaleAndOutOfOrderWritesDoNotOverwriteLatestDraft()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(ArticleDraft),
            typeof(ContentAssetReference),
            typeof(ContentAssetCleanupQueueItem));
        using SqlSugarClient staleTabDb = PostgresSqlSugarTestClient.Create(connectionString);
        AuthoringDraftLifecycleService service = CreateService(db);
        AuthoringDraftLifecycleService staleTabService = CreateService(staleTabDb);

        ServerDraftResponse first = await service.SaveDraftAsync(7, CreateRequest("rev-a", "first content"), CancellationToken.None);
        ServerDraftResponse second = await service.SaveDraftAsync(
            7,
            CreateRequest("rev-b", "second content", first.ServerRevision),
            CancellationToken.None);
        ServerDraftConflictException conflict = await Assert.ThrowsAsync<ServerDraftConflictException>(() =>
            staleTabService.SaveDraftAsync(
                7,
                CreateRequest("rev-c", "stale content", first.ServerRevision),
                CancellationToken.None));

        ArticleDraft draft = Assert.Single(db.Queryable<ArticleDraft>().ToList());
        Assert.Equal("rev-b", draft.ClientRevision);
        Assert.Equal("second content", draft.MarkdownContent);
        Assert.Equal(2, second.ServerRevision);
        Assert.Equal(2, conflict.Conflict.CurrentServerRevision);
        Assert.Equal(2, draft.ServerRevision);
        Assert.Equal(1, db.Queryable<ArticleDraft>().Count());
    }

    [Fact]
    public async Task SaveDraftAsync_IdenticalRetryReturnsCurrentVersionWithoutIncrementing()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(ArticleDraft),
            typeof(ContentAssetReference),
            typeof(ContentAssetCleanupQueueItem));
        using SqlSugarClient retryDb = PostgresSqlSugarTestClient.Create(connectionString);
        AuthoringDraftLifecycleService service = CreateService(db);
        AuthoringDraftLifecycleService retryService = CreateService(retryDb);

        ServerDraftResponse first = await service.SaveDraftAsync(7, CreateRequest("rev-a", "first content"), CancellationToken.None);
        ServerDraftSaveRequest update = CreateRequest("rev-b", "second content", first.ServerRevision);
        ServerDraftResponse saved = await service.SaveDraftAsync(7, update, CancellationToken.None);
        ServerDraftResponse retried = await retryService.SaveDraftAsync(7, update, CancellationToken.None);

        Assert.Equal(2, saved.ServerRevision);
        Assert.Equal(saved.ServerRevision, retried.ServerRevision);
        Assert.Equal(2, Assert.Single(db.Queryable<ArticleDraft>().ToList()).ServerRevision);
    }

    [Theory]
    [InlineData(null)]
    [InlineData(42)]
    public async Task SaveDraftAsync_NewAndExistingArticleDraftsUseTheSameCasRule(int? articleId)
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(ArticleDraft),
            typeof(ContentAssetReference),
            typeof(ContentAssetCleanupQueueItem));
        AuthoringDraftLifecycleService service = CreateService(db);

        ServerDraftResponse created = await service.SaveDraftAsync(
            7,
            CreateRequest("rev-a", "first content", articleId: articleId),
            CancellationToken.None);
        ServerDraftResponse updated = await service.SaveDraftAsync(
            7,
            CreateRequest("rev-b", "second content", created.ServerRevision, articleId),
            CancellationToken.None);

        Assert.Equal(articleId, created.ArticleId);
        Assert.Equal(articleId, updated.ArticleId);
        Assert.Equal(1, created.ServerRevision);
        Assert.Equal(2, updated.ServerRevision);
    }

    [Fact]
    public async Task SaveDraftAsync_ConcurrentUpdatesAcrossConnectionsAllowExactlyOneWriter()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(
            setupDb,
            typeof(ArticleDraft),
            typeof(ContentAssetReference),
            typeof(ContentAssetCleanupQueueItem));
        ServerDraftResponse created = await CreateService(setupDb).SaveDraftAsync(
            7,
            CreateRequest("rev-initial", "initial content"),
            CancellationToken.None);
        using SqlSugarClient firstDb = PostgresSqlSugarTestClient.Create(connectionString);
        using SqlSugarClient secondDb = PostgresSqlSugarTestClient.Create(connectionString);
        AuthoringDraftLifecycleService firstService = CreateService(firstDb);
        AuthoringDraftLifecycleService secondService = CreateService(secondDb);
        using var barrier = new Barrier(2);

        object[] outcomes = await Task.WhenAll(
                StartBarrierTaskAsync(barrier, () => CaptureSaveAsync(
                    firstService,
                    CreateRequest("rev-a", "first content", created.ServerRevision))),
                StartBarrierTaskAsync(barrier, () => CaptureSaveAsync(
                    secondService,
                    CreateRequest("rev-b", "second content", created.ServerRevision))))
            .WaitAsync(TimeSpan.FromSeconds(30));

        ServerDraftResponse winner = Assert.Single(outcomes.OfType<ServerDraftResponse>());
        ServerDraftConflictException loser = Assert.Single(outcomes.OfType<ServerDraftConflictException>());
        ArticleDraft current = Assert.Single(setupDb.Queryable<ArticleDraft>().ToList());
        Assert.Equal(2, winner.ServerRevision);
        Assert.Equal(2, loser.Conflict.CurrentServerRevision);
        Assert.Equal(2, current.ServerRevision);
        Assert.Equal(winner.ClientRevision, current.ClientRevision);
    }

    [Fact]
    public async Task DiscardDraftAsync_RequiresCurrentServerRevision()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(ArticleDraft),
            typeof(ContentAssetReference),
            typeof(ContentAssetCleanupQueueItem));
        AuthoringDraftLifecycleService service = CreateService(db);

        ServerDraftResponse first = await service.SaveDraftAsync(7, CreateRequest("rev-a", "first content"), CancellationToken.None);
        ServerDraftResponse second = await service.SaveDraftAsync(
            7,
            CreateRequest("rev-b", "second content", first.ServerRevision),
            CancellationToken.None);

        ServerDraftConflictException conflict = await Assert.ThrowsAsync<ServerDraftConflictException>(() =>
            service.DiscardDraftAsync(7, "race-draft", first.ServerRevision, CancellationToken.None));
        Assert.Equal(second.ServerRevision, conflict.Conflict.CurrentServerRevision);
        Assert.Equal(1, db.Queryable<ArticleDraft>().Count());

        Assert.True(await service.DiscardDraftAsync(7, "race-draft", second.ServerRevision, CancellationToken.None));
        Assert.Equal(0, db.Queryable<ArticleDraft>().Count());
    }

    [Fact]
    public async Task SaveAndDiscardDraft_CommitReferenceEdgesAtomically()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(ArticleDraft),
            typeof(ContentAsset),
            typeof(ContentAssetReference),
            typeof(ContentAssetCleanupQueueItem));
        Guid assetId = Guid.NewGuid();
        db.Insertable(new ContentAsset
        {
            AssetId = assetId,
            StorageClass = "public",
            StorageKey = "illustration/draft.png",
            MimeType = "image/png",
            Extension = ".png",
            SizeBytes = 3,
            State = ContentAssetStates.Active,
            CreatedAtUtc = DateTime.UtcNow,
            UpdatedAtUtc = DateTime.UtcNow
        }).ExecuteCommand();
        AuthoringDraftLifecycleService service = CreateService(db);

        ServerDraftResponse saved = await service.SaveDraftAsync(
            7,
            CreateRequest("rev-a", "![draft](/uploads/illustration/draft.png)"),
            CancellationToken.None);

        ContentAssetReference reference = Assert.Single(db.Queryable<ContentAssetReference>().ToList());
        Assert.Equal(assetId, reference.AssetId);
        Assert.Equal(ContentAssetSourceKinds.Draft, reference.SourceKind);
        Assert.Equal("7:race-draft", reference.SourceKey);

        Assert.True(await service.DiscardDraftAsync(
            7,
            "race-draft",
            saved.ServerRevision,
            CancellationToken.None));
        Assert.Empty(db.Queryable<ArticleDraft>().ToList());
        Assert.Empty(db.Queryable<ContentAssetReference>().ToList());
        Assert.Equal(assetId, Assert.Single(db.Queryable<ContentAssetCleanupQueueItem>().ToList()).AssetId);
    }

    [Fact]
    public async Task SaveAndDiscard_ConcurrentAcrossConnectionsHaveOneCasWinner()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(
            setupDb,
            typeof(ArticleDraft),
            typeof(ContentAssetReference),
            typeof(ContentAssetCleanupQueueItem));
        ServerDraftResponse created = await CreateService(setupDb).SaveDraftAsync(
            7,
            CreateRequest("rev-initial", "initial content"),
            CancellationToken.None);
        using SqlSugarClient saveDb = PostgresSqlSugarTestClient.Create(connectionString);
        using SqlSugarClient discardDb = PostgresSqlSugarTestClient.Create(connectionString);
        AuthoringDraftLifecycleService saveService = CreateService(saveDb);
        AuthoringDraftLifecycleService discardService = CreateService(discardDb);
        using var barrier = new Barrier(2);

        object[] outcomes = await Task.WhenAll(
                StartBarrierTaskAsync(barrier, () => CaptureSaveAsync(
                    saveService,
                    CreateRequest("rev-update", "updated content", created.ServerRevision))),
                StartBarrierTaskAsync(barrier, () => CaptureDiscardAsync(
                    discardService,
                    created.ServerRevision)))
            .WaitAsync(TimeSpan.FromSeconds(30));

        Assert.Single(outcomes.OfType<ServerDraftConflictException>());
        ServerDraftResponse? saved = outcomes.OfType<ServerDraftResponse>().SingleOrDefault();
        bool discarded = outcomes.OfType<bool>().SingleOrDefault();
        Assert.NotEqual(saved is not null, discarded);
        if (saved is not null)
        {
            ArticleDraft current = Assert.Single(setupDb.Queryable<ArticleDraft>().ToList());
            Assert.Equal(2, saved.ServerRevision);
            Assert.Equal(2, current.ServerRevision);
        }
        else
        {
            Assert.Empty(setupDb.Queryable<ArticleDraft>().ToList());
        }
    }

    private static ServerDraftSaveRequest CreateRequest(
        string revision,
        string content,
        long? expectedServerRevision = null,
        int? articleId = null)
        => new(
            "race-draft",
            articleId,
            $"Title {revision}",
            content,
            $"Summary {revision}",
            null,
            3,
            [4, 5],
            revision,
            (int)ArticleStatus.Draft,
            null,
            ExpectedServerRevision: expectedServerRevision);

    private static async Task<object> CaptureSaveAsync(
        AuthoringDraftLifecycleService service,
        ServerDraftSaveRequest request)
    {
        try
        {
            return await service.SaveDraftAsync(7, request, CancellationToken.None);
        }
        catch (ServerDraftConflictException exception)
        {
            return exception;
        }
    }

    private static async Task<object> CaptureDiscardAsync(
        AuthoringDraftLifecycleService service,
        long expectedServerRevision)
    {
        try
        {
            return await service.DiscardDraftAsync(
                7,
                "race-draft",
                expectedServerRevision,
                CancellationToken.None);
        }
        catch (ServerDraftConflictException exception)
        {
            return exception;
        }
    }

    private static AuthoringDraftLifecycleService CreateService(SqlSugarClient db)
        => new(
            db,
            Substitute.For<IArticleCoreService>(),
            Substitute.For<IArticlePublicationValidator>(),
            Substitute.For<IAuthoringAuditWriter>());

    private static Task<T> StartBarrierTaskAsync<T>(Barrier barrier, Func<Task<T>> action)
        => Task.Factory.StartNew(
            async () =>
            {
                Assert.True(
                    barrier.SignalAndWait(TimeSpan.FromSeconds(30)),
                    "Timed out waiting for concurrent draft saves.");
                return await action();
            },
            CancellationToken.None,
            TaskCreationOptions.LongRunning,
            TaskScheduler.Default).Unwrap();
}
