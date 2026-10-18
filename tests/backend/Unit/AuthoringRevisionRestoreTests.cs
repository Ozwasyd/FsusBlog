using System.Reflection;

using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

using NSubstitute;

using SqlSugar;
namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class AuthoringRevisionRestoreTests(PostgresSchemaMigrationFixture fixture)
{
    private static readonly MethodInfo s_restoreImportedRevisions = typeof(AuthoringContentTransferService)
        .GetMethod("RestoreImportedRevisionsAsync", BindingFlags.Instance | BindingFlags.NonPublic)
        ?? throw new InvalidOperationException("RestoreImportedRevisionsAsync should exist.");

    [Fact]
    public async Task RestoreImportedRevisionsAsync_RollsBackDeleteWhenInsertFails()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        CreateTables(db);
        SeedArticle(db, 42);
        SeedRevision(db, 42, revisionNo: 1, title: "Original");
        InstallFailingImportedRevisionTrigger(db);
        AuthoringContentTransferService service = CreateService(db);

        await Assert.ThrowsAnyAsync<Exception>(() => InvokeRestoreImportedRevisionsAsync(service, 42, CreateMetadata()));

        List<ArticleRevision> revisions = await db.Queryable<ArticleRevision>()
            .Where(revision => revision.ArticleId == 42)
            .OrderBy(revision => revision.RevisionNo)
            .ToListAsync();
        ArticleRevision revision = Assert.Single(revisions);
        Assert.Equal(1, revision.RevisionNo);
        Assert.Equal("Original", revision.Title);
    }

    [Fact]
    public async Task ImportArticleAsync_DeclaresCreateSideRightsPreserve()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        var core = Substitute.For<IArticleCoreService>();
        CreateArticleCommand captured = default;
        core.CreateAsync(Arg.Do<CreateArticleCommand>(command => captured = command), Arg.Any<CancellationToken>())
            .Returns(Result<int>.Success(77));
        AuthoringContentTransferService service = CreateService(db, core);

        ContentImportResponse result = await service.ImportArticleAsync(new ContentImportRequest(
            "---\ntitle: Imported\ncategoryId: 1\n---\n\n# body",
            Publish: false,
            PreserveRevisions: false));

        Assert.Equal(77, result.ArticleId);
        Assert.Null(captured.Article.Rights);
        Assert.Equal(ArticleRightsMutationMode.Preserve, captured.Article.RightsMutation);
    }

    [Fact]
    public async Task ImportArticleAsync_ForwardsCallerCancellationToTheOriginalCreateOwner()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        using var caller = new CancellationTokenSource();
        var core = Substitute.For<IArticleCoreService>();
        core.CreateAsync(Arg.Any<CreateArticleCommand>(), Arg.Any<CancellationToken>())
            .Returns(Result<int>.Success(77));

        ContentImportResponse result = await CreateService(db, core).ImportArticleAsync(
            new ContentImportRequest("---\ntitle: Imported\ncategoryId: 1\n---\n\n# body",
                Publish: false, PreserveRevisions: false), caller.Token);

        Assert.Equal(77, result.ArticleId);
        await core.Received(1).CreateAsync(Arg.Any<CreateArticleCommand>(), caller.Token);
    }

    [Fact]
    public async Task ImportArticleAsync_PreCanceledCallerDoesNotInvokeCreateOrInitializeSource()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        using var caller = new CancellationTokenSource();
        caller.Cancel();
        var core = Substitute.For<IArticleCoreService>();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => CreateService(db, core).ImportArticleAsync(
            new ContentImportRequest("---\ntitle: Imported\n---\n\n# body", Publish: false), caller.Token));

        await core.DidNotReceive().CreateAsync(Arg.Any<CreateArticleCommand>(), Arg.Any<CancellationToken>());
        Assert.Null(await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        Assert.Equal(0, await db.Ado.GetIntAsync("SELECT COUNT(*) FROM pg_tables WHERE schemaname = 'public';"));
    }

    private static Task<int> InvokeRestoreImportedRevisionsAsync(
        AuthoringContentTransferService service,
        int articleId,
        ContentExportMetadataResponse metadata)
        => (Task<int>)s_restoreImportedRevisions.Invoke(service, [articleId, metadata, CancellationToken.None])!;

    private static ContentExportMetadataResponse CreateMetadata()
        => new(
            SourceArticleId: 42,
            CategoryId: 1,
            TagIds: [],
            Status: ArticleStatus.Published,
            ScheduledPublishAt: null,
            CoverImageUrl: null,
            RevisionCount: 1,
            Revisions:
            [
                new ContentRevisionExportResponse(
                    2,
                    "Imported",
                    "# Imported",
                    null,
                    null,
                    1,
                    [],
                    "imported",
                    DateTime.UtcNow)
            ]);

    private static void CreateTables(SqlSugarClient db)
        => PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(Article),
            typeof(ArticleRevision),
            typeof(ArticleRevisionContentBlock));

    private static void SeedArticle(SqlSugarClient db, int articleId)
        => db.Ado.ExecuteCommand(
            """
            INSERT INTO article
                (id, title, categoryid, views, createtime, metadata_updated_at, isdeleted, status, published_at, scheduled_publish_at)
            VALUES
                (@Id, @Title, 1, 0, @PublishedAt, @PublishedAt, false, @Status, @PublishedAt, NULL);
            """,
            new SugarParameter("@Id", articleId),
            new SugarParameter("@Title", $"Article {articleId}"),
            new SugarParameter("@Status", (int)ArticleStatus.Published),
            new SugarParameter("@PublishedAt", DateTime.UtcNow.AddMinutes(-1)));

    private static void SeedRevision(SqlSugarClient db, int articleId, int revisionNo, string title)
        => db.Insertable(new ArticleRevision
        {
            ArticleId = articleId,
            RevisionNo = revisionNo,
            Title = title,
            MarkdownContent = "# Original",
            CategoryId = 1,
            DiffSummary = "original",
            CreatedByAdminPrincipalId = 1,
            CreatedAt = DateTime.UtcNow.AddMinutes(-5)
        }).ExecuteCommand();

    private static void InstallFailingImportedRevisionTrigger(SqlSugarClient db)
        => db.Ado.ExecuteCommand(
            """
            CREATE OR REPLACE FUNCTION fail_imported_revision_insert()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $$
            BEGIN
                IF NEW.article_id = 42 AND NEW.revision_no = 2 THEN
                    RAISE EXCEPTION 'unit imported revision insert failure';
                END IF;

                RETURN NEW;
            END;
            $$;

            CREATE TRIGGER fail_imported_revision_insert
            BEFORE INSERT ON article_revision
            FOR EACH ROW
            EXECUTE FUNCTION fail_imported_revision_insert();
            """);

    private static AuthoringContentTransferService CreateService(
        SqlSugarClient db,
        IArticleCoreService? articleCoreService = null)
        => new(
            db,
            articleCoreService ?? Substitute.For<IArticleCoreService>(),
            new ConfigurationBuilder().Build(),
            Substitute.For<IAuthoringPrepublishPolicy>(),
            Substitute.For<IAuthoringAuditWriter>(),
            Substitute.For<ILogger<AuthoringContentTransferService>>());
}
