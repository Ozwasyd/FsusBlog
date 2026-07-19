using FsusBlog.Core.Services.Abstractions;
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
    public async Task SaveDraftAsync_ConcurrentSameOwnerAndKeyKeepsSingleDraft()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(setupDb, typeof(ArticleDraft));
        using SqlSugarClient firstDb = PostgresSqlSugarTestClient.Create(connectionString);
        using SqlSugarClient secondDb = PostgresSqlSugarTestClient.Create(connectionString);
        AuthoringDraftLifecycleService firstService = CreateService(firstDb);
        AuthoringDraftLifecycleService secondService = CreateService(secondDb);
        using var barrier = new Barrier(2);

        ServerDraftResponse[] responses = await Task.WhenAll(
                StartBarrierTaskAsync(barrier, () => firstService.SaveDraftAsync(7, CreateRequest("rev-a", "first content"), CancellationToken.None)),
                StartBarrierTaskAsync(barrier, () => secondService.SaveDraftAsync(7, CreateRequest("rev-b", "second content"), CancellationToken.None)))
            .WaitAsync(TimeSpan.FromSeconds(30));

        Assert.Equal(2, responses.Length);
        ArticleDraft draft = Assert.Single(setupDb.Queryable<ArticleDraft>().ToList());
        Assert.Equal(7, draft.OwnerAdminPrincipalId);
        Assert.Equal("race-draft", draft.DraftKey);
        Assert.Contains(draft.ClientRevision, new[] { "rev-a", "rev-b" });
    }

    [Fact]
    public async Task SaveDraftAsync_OnConflictMergesLatestDraftFields()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(ArticleDraft));
        AuthoringDraftLifecycleService service = CreateService(db);

        await service.SaveDraftAsync(7, CreateRequest("rev-a", "first content"), CancellationToken.None);
        ServerDraftResponse response = await service.SaveDraftAsync(7, CreateRequest("rev-b", "second content"), CancellationToken.None);

        ArticleDraft draft = Assert.Single(db.Queryable<ArticleDraft>().ToList());
        Assert.Equal("rev-b", draft.ClientRevision);
        Assert.Equal("second content", draft.MarkdownContent);
        Assert.Equal("rev-b", response.ClientRevision);
        Assert.Equal(1, db.Queryable<ArticleDraft>().Count());
    }

    private static ServerDraftSaveRequest CreateRequest(string revision, string content)
        => new(
            "race-draft",
            null,
            $"Title {revision}",
            content,
            $"Summary {revision}",
            "/uploads/cover.webp",
            3,
            [4, 5],
            revision,
            (int)ArticleStatus.Draft,
            null);

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
