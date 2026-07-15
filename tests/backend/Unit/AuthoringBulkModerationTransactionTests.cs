using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using NSubstitute;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class AuthoringBulkModerationTransactionTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task ModerateCommentsAsync_RollsBackAllRowsWhenOneUpdateFails()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        CreateTables(db);
        SeedArticle(db, 42);
        SeedPendingComment(db, 100, 42);
        SeedPendingComment(db, 101, 42);
        InstallFailingSecondModerationTrigger(db);
        var dispatcher = new RecordingInvalidationDispatcher(db);
        AuthoringWorkflowService service = CreateService(db, dispatcher);

        await Assert.ThrowsAnyAsync<Exception>(() => service.ModerateCommentsAsync(
            7,
            new CommentModerationBulkRequest(["100", "101"], CommentModerationStatus.Hidden, "policy"),
            CancellationToken.None));

        List<CommentModerationStatus> statuses = await db.Queryable<Comment>()
            .Where(comment => comment.Id == 100 || comment.Id == 101)
            .OrderBy(comment => comment.Id)
            .Select(comment => comment.ModerationStatus)
            .ToListAsync();
        Assert.Equal([CommentModerationStatus.Pending, CommentModerationStatus.Pending], statuses);
        Assert.Empty(dispatcher.PendingCountsAtInvalidation);
    }

    [Fact]
    public async Task ModerateCommentsAsync_FiresSideEffectsAfterAllRowsAreCommitted()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        CreateTables(db);
        SeedArticle(db, 42);
        SeedPendingComment(db, 100, 42);
        SeedPendingComment(db, 101, 42);
        var dispatcher = new RecordingInvalidationDispatcher(db);
        AuthoringWorkflowService service = CreateService(db, dispatcher);

        CommentModerationBulkResponse response = await service.ModerateCommentsAsync(
            7,
            new CommentModerationBulkRequest(["100", "101"], CommentModerationStatus.Hidden, "policy"),
            CancellationToken.None);

        Assert.Equal(2, response.Updated);
        Assert.Equal([0, 0], dispatcher.PendingCountsAtInvalidation);
    }

    private static void CreateTables(SqlSugarClient db)
        => PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(Article),
            typeof(Comment),
            typeof(CommentRegionCompliance));

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

    private static void SeedPendingComment(SqlSugarClient db, long commentId, int articleId)
        => db.Insertable(new Comment
        {
            Id = commentId,
            ArticleId = articleId,
            Content = $"pending {commentId}",
            AuthorMode = CommentAuthorModes.LegacyServerVisiblePseudonymous,
            AnonymousDisplayName = "Anonymous",
            CreateTime = DateTime.UtcNow.AddMinutes(-1),
            IsDeleted = false,
            ModerationStatus = CommentModerationStatus.Pending,
            Depth = 0
        }).ExecuteCommand();

    private static void InstallFailingSecondModerationTrigger(SqlSugarClient db)
        => db.Ado.ExecuteCommand(
            """
            CREATE OR REPLACE FUNCTION fail_second_comment_moderation()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $$
            BEGIN
                IF OLD.id = 101 AND NEW.moderation_status = 3 THEN
                    RAISE EXCEPTION 'unit second comment moderation failure';
                END IF;

                RETURN NEW;
            END;
            $$;

            CREATE TRIGGER fail_second_comment_moderation
            BEFORE UPDATE ON comment
            FOR EACH ROW
            EXECUTE FUNCTION fail_second_comment_moderation();
            """);

    private static AuthoringWorkflowService CreateService(SqlSugarClient db, ICacheInvalidationDispatcher dispatcher)
    {
        var contentFilter = Substitute.For<IContentFilterService>();
        contentFilter.ValidateContent(Arg.Any<string>())
            .Returns(new ContentValidationResult(true, string.Empty, string.Empty));
        return new AuthoringWorkflowService(
            db,
            Substitute.For<IArticleService>(),
            contentFilter,
            Substitute.For<IBlacklistService>(),
            dispatcher,
            Substitute.For<IMessageRealtimePublisher>(),
            Substitute.For<IMessageCommandService>(),
            new AuditLogChannel(),
            new ConfigurationBuilder().Build(),
            Substitute.For<ILogger<AuthoringWorkflowService>>());
    }

    private sealed class RecordingInvalidationDispatcher(SqlSugarClient db) : ICacheInvalidationDispatcher
    {
        public List<int> PendingCountsAtInvalidation { get; } = [];

        public Task InvalidateCommentMutationAsync(CommentCacheInvalidationScope? scope = null, CancellationToken cancellationToken = default)
        {
            PendingCountsAtInvalidation.Add(db.Queryable<Comment>()
                .Count(comment => comment.ModerationStatus == CommentModerationStatus.Pending && !comment.IsDeleted));
            return Task.CompletedTask;
        }

        public Task InvalidateArticleMutationAsync(int? articleId = null, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateSeoAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateComplianceAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateSystemPageAsync(string slug, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateCategoryTagAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateCommentPolicyAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateStatsAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateArticleViewAsync(int articleId, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateHotArticlesAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
    }
}
