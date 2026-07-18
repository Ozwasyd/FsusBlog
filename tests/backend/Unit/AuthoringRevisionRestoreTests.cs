using System.Reflection;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
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
    private static readonly MethodInfo s_restoreImportedRevisions = typeof(AuthoringWorkflowService)
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
        AuthoringWorkflowService service = CreateService(db);

        await Assert.ThrowsAnyAsync<Exception>(() => InvokeRestoreImportedRevisionsAsync(service, 42, CreateMetadata()));

        List<ArticleRevision> revisions = await db.Queryable<ArticleRevision>()
            .Where(revision => revision.ArticleId == 42)
            .OrderBy(revision => revision.RevisionNo)
            .ToListAsync();
        ArticleRevision revision = Assert.Single(revisions);
        Assert.Equal(1, revision.RevisionNo);
        Assert.Equal("Original", revision.Title);
    }

    private static Task<int> InvokeRestoreImportedRevisionsAsync(
        AuthoringWorkflowService service,
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
            typeof(ArticleRevision));

    private static void SeedArticle(SqlSugarClient db, int articleId)
        => db.Ado.ExecuteCommand(
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
}
