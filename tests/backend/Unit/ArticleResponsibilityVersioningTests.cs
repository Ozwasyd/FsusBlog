using System.Text.Json;

using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Tests.TestInfrastructure;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class ArticleResponsibilityVersioningTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task SaveAsync_AppendsVersionsAdvancesExplicitPublicationAndWritesExactOutbox()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (int articleId, long revisionId, long initialPublicationId) = SeedPublishedArticle(db);
        var clock = new MutableTimeProvider(new DateTimeOffset(2026, 7, 20, 8, 0, 0, TimeSpan.Zero));
        var service = new ArticleResponsibilityAuthoringService(db, clock);

        ArticleResponsibilitySaveResponse first = Assert.IsType<ArticleResponsibilitySaveResponse>(
            await service.SaveAsync(articleId, revisionId, Draft(expectedVersion: 0, "first")));
        clock.Advance(TimeSpan.FromMinutes(5));
        ArticleResponsibilitySaveResponse second = Assert.IsType<ArticleResponsibilitySaveResponse>(
            await service.SaveAsync(articleId, revisionId, Draft(expectedVersion: 1, "second")));

        Assert.True(first.Saved);
        Assert.True(second.Saved);
        Assert.False(first.VersionConflict);
        Assert.Equal(1, first.ResponsibilityVersion);
        Assert.Equal(2, second.ResponsibilityVersion);
        Assert.Null(first.PreviousSnapshotId);
        Assert.Equal(first.ResponsibilitySnapshotId, second.PreviousSnapshotId);

        List<ArticleResponsibilitySnapshot> snapshots = await db.Queryable<ArticleResponsibilitySnapshot>()
            .Where(item => item.ArticleRevisionId == revisionId)
            .OrderBy(item => item.ResponsibilityVersion, OrderByType.Asc)
            .ToListAsync();
        Assert.Collection(
            snapshots,
            item =>
            {
                Assert.Equal(1, item.ResponsibilityVersion);
                Assert.Null(item.PreviousSnapshotId);
                Assert.Equal("first", item.UpdateSummary);
            },
            item =>
            {
                Assert.Equal(2, item.ResponsibilityVersion);
                Assert.Equal(snapshots[0].Id, item.PreviousSnapshotId);
                Assert.Equal("second", item.UpdateSummary);
            });

        Article current = Assert.IsType<Article>(await db.Queryable<Article>().InSingleAsync(articleId));
        Assert.NotEqual(initialPublicationId, current.CurrentPublicationId);
        Assert.Equal(clock.GetUtcNow().UtcDateTime, current.PublicUpdatedAt);
        Assert.Equal(current.PublishedAt, current.LastPublishedAt);
        ArticlePublicationRecord currentPublication = Assert.IsType<ArticlePublicationRecord>(
            await db.Queryable<ArticlePublicationRecord>().InSingleAsync(current.CurrentPublicationId!.Value));
        Assert.Equal(revisionId, currentPublication.ArticleRevisionId);
        Assert.Equal(snapshots[1].Id, currentPublication.ResponsibilitySnapshotId);
        Assert.Equal(3, currentPublication.PublicationNo);

        List<ArticleMutationOutboxEvent> events = await db.Queryable<ArticleMutationOutboxEvent>()
            .Where(item => item.AggregateId == articleId && item.EventType == "responsibility-updated")
            .OrderBy(item => item.Id, OrderByType.Asc)
            .ToListAsync();
        Assert.Equal(2, events.Count);
        Assert.Equal(snapshots[0].Id, events[0].ResponsibilitySnapshotId);
        Assert.Equal(snapshots[1].Id, events[1].ResponsibilitySnapshotId);
        Assert.Equal(currentPublication.Id, events[1].ArticlePublicationId);
        Assert.Equal(2, (await db.Queryable<ArticleSourceGeneration>().SingleAsync()).SourceGeneration);
        Assert.Equal(events.Select(item => item.EventId), await db.Queryable<ArticleSourceMutation>()
            .OrderBy(item => item.SourceGeneration).Select(item => item.EventId).ToListAsync());
        using JsonDocument payload = JsonDocument.Parse(events[1].PayloadJson);
        Assert.Equal(2, payload.RootElement.GetProperty("responsibilityVersion").GetInt32());
        Assert.Equal(snapshots[1].Id, payload.RootElement.GetProperty("responsibilitySnapshotId").GetInt64());
    }

    [Fact]
    public async Task SaveAsync_StaleExpectedVersionDoesNotAppendOrAdvancePublication()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (int articleId, long revisionId, _) = SeedPublishedArticle(db);
        var service = new ArticleResponsibilityAuthoringService(db);
        ArticleResponsibilitySaveResponse first = Assert.IsType<ArticleResponsibilitySaveResponse>(
            await service.SaveAsync(articleId, revisionId, Draft(expectedVersion: 0, "first")));
        long currentPublicationId = (await db.Queryable<Article>().InSingleAsync(articleId))!.CurrentPublicationId!.Value;

        ArticleResponsibilitySaveResponse conflict = Assert.IsType<ArticleResponsibilitySaveResponse>(
            await service.SaveAsync(articleId, revisionId, Draft(expectedVersion: 0, "stale")));

        Assert.False(conflict.Saved);
        Assert.True(conflict.VersionConflict);
        Assert.Equal(1, conflict.ResponsibilityVersion);
        Assert.Equal(first.ResponsibilitySnapshotId, conflict.ResponsibilitySnapshotId);
        Assert.Equal(1, await db.Queryable<ArticleResponsibilitySnapshot>().CountAsync());
        Assert.Equal(1, await db.Queryable<ArticleMutationOutboxEvent>().CountAsync());
        Assert.Equal(currentPublicationId, (await db.Queryable<Article>().InSingleAsync(articleId))!.CurrentPublicationId);
    }

    [Fact]
    public async Task SaveAsync_OutboxProducerFailureRollsBackSnapshotPublicationAndPointer()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (int articleId, long revisionId, long initialPublicationId) = SeedPublishedArticle(db);
        await db.Ado.ExecuteCommandAsync(
            """
            ALTER TABLE article_mutation_outbox
            ADD CONSTRAINT reject_responsibility_outbox
            CHECK (event_type <> 'responsibility-updated');
            """);
        var service = new ArticleResponsibilityAuthoringService(db);

        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => service.SaveAsync(articleId, revisionId, Draft(expectedVersion: 0, "must rollback")));

        Assert.Contains("not saved atomically", error.Message, StringComparison.Ordinal);
        Assert.Equal(0, await db.Queryable<ArticleResponsibilitySnapshot>().CountAsync());
        Assert.Equal(0, await db.Queryable<ArticleMutationOutboxEvent>().CountAsync());
        Assert.Equal(0, await db.Queryable<ArticleSourceGeneration>().CountAsync());
        Assert.Equal(0, await db.Queryable<ArticleSourceMutation>().CountAsync());
        Assert.Equal(1, await db.Queryable<ArticlePublicationRecord>().CountAsync());
        Article current = Assert.IsType<Article>(await db.Queryable<Article>().InSingleAsync(articleId));
        Assert.Equal(initialPublicationId, current.CurrentPublicationId);
        Assert.Null((await db.Queryable<ArticlePublicationRecord>().InSingleAsync(initialPublicationId))!.ResponsibilitySnapshotId);
    }

    [Fact]
    public async Task GetHistoryAsync_ReturnsEveryVersionNewestFirstForExactRevision()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (int articleId, long revisionId, _) = SeedPublishedArticle(db);
        var service = new ArticleResponsibilityAuthoringService(db);
        await service.SaveAsync(articleId, revisionId, Draft(expectedVersion: 0, "first"));
        await service.SaveAsync(articleId, revisionId, Draft(expectedVersion: 1, "second"));

        IReadOnlyList<ArticleResponsibilityVersionResponse> history = Assert.IsAssignableFrom<IReadOnlyList<ArticleResponsibilityVersionResponse>>(
            await service.GetHistoryAsync(articleId, revisionId));

        Assert.Equal([2, 1], history.Select(item => item.ResponsibilityVersion));
        Assert.Equal("second", history[0].UpdateSummary);
        Assert.Equal(history[1].Id, history[0].PreviousSnapshotId);
        Assert.Null(await service.GetHistoryAsync(articleId, revisionId + 99));
    }

    [Fact]
    public async Task SaveAsync_ConcurrentSameExpectedVersionHasOneWinnerAndOneConflict()
    {
        using SqlSugarClient setupDb = await CreateDatabaseAsync();
        (int articleId, long revisionId, _) = SeedPublishedArticle(setupDb);
        string connectionString = setupDb.CurrentConnectionConfig.ConnectionString;
        using SqlSugarClient firstDb = PostgresSqlSugarTestClient.Create(connectionString);
        using SqlSugarClient secondDb = PostgresSqlSugarTestClient.Create(connectionString);
        var firstService = new ArticleResponsibilityAuthoringService(firstDb);
        var secondService = new ArticleResponsibilityAuthoringService(secondDb);

        ArticleResponsibilitySaveResponse?[] results = await Task.WhenAll(
            firstService.SaveAsync(articleId, revisionId, Draft(expectedVersion: 0, "first contender")),
            secondService.SaveAsync(articleId, revisionId, Draft(expectedVersion: 0, "second contender")));

        Assert.Single(results, result => result is { Saved: true, VersionConflict: false });
        Assert.Single(results, result => result is { Saved: false, VersionConflict: true, ResponsibilityVersion: 1 });
        Assert.Equal(1, await setupDb.Queryable<ArticleResponsibilitySnapshot>().CountAsync());
        Assert.Equal(1, await setupDb.Queryable<ArticleMutationOutboxEvent>().CountAsync());
        Assert.Equal(2, await setupDb.Queryable<ArticlePublicationRecord>().CountAsync());
    }

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(Article),
            typeof(ArticleRevision),
            typeof(ArticleRevisionContentBlock),
            typeof(ArticleRightsSnapshot),
            typeof(ArticleResponsibilitySnapshot),
            typeof(ArticlePublicationRecord),
            typeof(ArticleMutationOutboxEvent));
        return db;
    }

    private static (int ArticleId, long RevisionId, long PublicationId) SeedPublishedArticle(SqlSugarClient db)
    {
        DateTime publishedAt = DateTime.UtcNow.AddMinutes(-5);
        int articleId = db.Insertable(new Article
        {
            Title = "Responsibility versioning",
            CategoryId = 1,
            Status = ArticleStatus.Published,
            PublishedAt = publishedAt,
            LastPublishedAt = publishedAt,
            PublicUpdatedAt = publishedAt,
            MetadataUpdatedAt = publishedAt,
            CreateTime = publishedAt,
            IsDeleted = false
        }).ExecuteReturnIdentity();
        long revisionId = db.Insertable(new ArticleRevision
        {
            ArticleId = articleId,
            RevisionNo = 1,
            Title = "Responsibility versioning",
            CategoryId = 1,
            MarkdownContent = "body",
            DiffSummary = "initial",
            CreatedAt = publishedAt
        }).ExecuteReturnBigIdentity();
        long rightsSnapshotId = db.Insertable(new ArticleRightsSnapshot
        {
            ArticleId = articleId,
            ArticleRevisionId = revisionId,
            RevisionNo = 1,
            ArticleRightsPolicyId = 1,
            CreatedAt = publishedAt
        }).ExecuteReturnBigIdentity();
        long publicationId = db.Insertable(new ArticlePublicationRecord
        {
            ArticleId = articleId,
            PublicationNo = 1,
            ArticleRevisionId = revisionId,
            RevisionNo = 1,
            RightsSnapshotId = rightsSnapshotId,
            ResponsibilitySnapshotId = null,
            TransitionKind = "initial",
            PublishedAt = publishedAt,
            CreatedAt = publishedAt
        }).ExecuteReturnBigIdentity();
        db.Updateable<Article>()
            .SetColumns(item => item.CurrentRevisionId == revisionId)
            .SetColumns(item => item.CurrentPublicationId == publicationId)
            .Where(item => item.Id == articleId)
            .ExecuteCommand();
        return (articleId, revisionId, publicationId);
    }

    private sealed class MutableTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        private DateTimeOffset _utcNow = utcNow;

        public override DateTimeOffset GetUtcNow() => _utcNow;

        public void Advance(TimeSpan duration) => _utcNow = _utcNow.Add(duration);
    }

    private static ArticleResponsibilityDraft Draft(int expectedVersion, string summary)
        => new(
            InheritSiteAuthor: false,
            Authors: [new ArticleResponsiblePerson("Alice", "https://example.test/alice")],
            Reviewer: null,
            Sources: [new ArticleEvidenceSource("Spec", "https://example.test/spec", "primary", null, null, null)],
            UpdateSummary: summary,
            UpdateReason: "source changed",
            EffectiveAt: DateTime.UtcNow,
            ConclusionImpact: "clarified",
            Methodology: "review",
            Applicability: "public",
            Limitations: "none",
            ResponsiblePersonConfirmed: true,
            ContainsStrongClaims: false,
            IsSubstantiveUpdate: false,
            RequiresMethodsDisclosure: false,
            ExpectedVersion: expectedVersion);
}
