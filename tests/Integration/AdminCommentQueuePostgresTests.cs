using Microsoft.Extensions.Primitives;

namespace FsusBlog.V2.Integration.Tests;

public sealed class AdminCommentQueuePostgresTests
{
    [PostgresFact]
    public async Task ModeratorReadsTrackedPendingCommentsAcrossPagesWithRevocationAndPublicIsolation()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var (admin, adminToken, _) = await fixture.AdminAsync("moderator", 10, [1], [2], ct);
        var (owner, siteToken, _) = await fixture.SignInSiteUser("author", ct, minutes: 5);
        await fixture.Exec("insert into public.comment_public_handle values($1,'Fixture commenter')", owner);

        var store = new Store(fixture.DataSource);
        var (_, authorToken, _) = await fixture.SignIn("comment-queue-author", ct);
        var adminStore = new AdminCommentQueueStore(new AdminSessionGate(fixture.DataSource, null));
        var publications = PublicationFixture.Project(fixture.DataSource);
        var published = await Publish("Public comment fixture");
        var retracted = await Publish("Retracted comment fixture");
        var removed = await Publish("Deleted comment fixture");
        var draft = await ArticleCommand(ArticleAction.Save, 0, 0, "Draft without submissions");

        const string pending = "Pending <strong>literal review content</strong>";
        var genuine = await Submit(published.Id, pending);
        var approved = await Submit(published.Id, "Approved public comment control");
        await fixture.Exec("update public.comment set moderation_status=1 where article_id=$1 and id=$2", published.Id, approved.CommentId);
        var acceptedAfterRetraction = await Submit(retracted.Id, "Pending under retracted article");
        var excludedAfterDeletion = await Submit(removed.Id, "Pending under deleted article");
        await ArticleCommand(ArticleAction.Retract, retracted.Id, retracted.Revision, retracted.Title);
        await ArticleCommand(ArticleAction.Delete, removed.Id, removed.Revision, removed.Title);

        foreach (var (artId, cid, status, del, tracked, body) in new[]
        {
            (published.Id, 10_000L, (short)2, false, true, "Rejected tracked comment"),
            (published.Id, 10_001L, (short)3, false, true, "Hidden tracked comment"),
            (published.Id, 10_002L, (short)0, true, true, "Deleted tracked comment"),
            (draft.Id, 10_003L, (short)0, false, false, "Untracked pending draft comment"),
            (published.Id, 10_004L, (short)0, false, false, "Untracked pending public comment"),
        })
            await Seed(artId, cid, status, del, tracked, body);

        var allExpected = new List<(long Comment, int Article)>
        {
            (genuine.CommentId, published.Id),
            (acceptedAfterRetraction.CommentId, retracted.Id),
        };
        for (var offset = 0; offset < WireLimits.AdminCommentQueueSize; offset++)
        {
            var comment = 20_000L + offset;
            await Seed(published.Id, comment, 0, deleted: false, tracked: true, $"Pending page fixture {offset}");
            allExpected.Add((comment, published.Id));
        }
        var sharedComment = allExpected[WireLimits.AdminCommentQueueSize - 1].Comment;
        await Seed(retracted.Id, sharedComment, 0, deleted: false, tracked: true, "Pending shared comment coordinate");
        allExpected.Add((sharedComment, retracted.Id));

        await Denied(Rejection.Unauthorized, () => adminStore.CommentQueue(siteToken, QueryCollection.Empty, ct));
        await Denied(Rejection.Invalid, () => adminStore.CommentQueue(adminToken,
            new QueryCollection(new Dictionary<string, StringValues> { ["afterComment"] = "1" }), ct));

        var page = await adminStore.CommentQueue(adminToken, QueryCollection.Empty, ct);
        Assert.Equal((true, WireLimits.AdminCommentQueueSize), (page.HasMore, page.Comments.Count));
        var realComment = Assert.Single(page.Comments, item => item.CommentId == genuine.CommentId && item.ArticleId == published.Id);
        Assert.Equal((pending, "Fixture commenter"), (realComment.Body, realComment.DisplayName));
        Assert.True(realComment.CreatedAt > 0);
        Assert.DoesNotContain(page.Comments, item => item.CommentId == excludedAfterDeletion.CommentId && item.ArticleId == removed.Id);
        var encodedQueue = Wire.EncodeAdminCommentQueue(page);
        Aeds.Decode(encodedQueue, FrameType.AdminCommentQueue);
        Assert.True(encodedQueue.AsSpan().IndexOf(Encoding.UTF8.GetBytes(pending)) >= 0);

        var last = page.Comments[^1];
        var finalPage = await adminStore.CommentQueue(adminToken, new QueryCollection(new Dictionary<string, StringValues>
        {
            ["afterComment"] = last.CommentId.ToString(CultureInfo.InvariantCulture),
            ["afterArticle"] = last.ArticleId.ToString(CultureInfo.InvariantCulture),
        }), ct);
        Assert.Equal((false, last.CommentId, retracted.Id),
            (finalPage.HasMore, finalPage.Comments[0].CommentId, finalPage.Comments[0].ArticleId));
        Assert.Equal(allExpected.Order(), page.Comments.Concat(finalPage.Comments).Select(item => (item.CommentId, item.ArticleId)));

        var publicFrame = await new CommentReadStore(fixture.DataSource).Roots(published.Id, null, 50, ct);
        Aeds.Decode(publicFrame, FrameType.CommentTreeRootCursor);
        Assert.True(publicFrame.AsSpan().IndexOf("Approved public comment control"u8) >= 0);
        Assert.True(publicFrame.AsSpan().IndexOf(Encoding.UTF8.GetBytes(pending)) < 0);
        await fixture.Exec("update public.admin_principal set generation=generation+1,generation_changed_at=clock_timestamp() where id=$1", admin);
        await Denied(Rejection.Unauthorized, () => adminStore.CommentQueue(adminToken, QueryCollection.Empty, ct));

        async Task<ArticleState> ArticleCommand(ArticleAction action, int id, long revision, string title) =>
            (await publications.Command(store, authorToken, action,
                new(id, revision, Guid.NewGuid(), action == ArticleAction.Save ? title : "", action == ArticleAction.Save ? "Moderation fixture article body" : ""), ct)).Article;

        async Task<ArticleState> Publish(string title)
        {
            var article = await ArticleCommand(ArticleAction.Save, 0, 0, title);
            var publishedArticle = await ArticleCommand(ArticleAction.Publish, article.Id, article.Revision, title);
            await fixture.Exec("insert into public.comment_public_write values($1)", article.Id);
            return publishedArticle;
        }

        async Task<PublicCommentSubmissionResult> Submit(int article, string content)
        {
            var publication = await fixture.Scalar<long>("select publication_id from public.article_publication where article_id=$1", article);
            return await store.WithSession(siteToken, false,
                (connection, tx, actor) => CommentWriteStore.Submit(connection, tx, actor,
                    new PublicCommentSubmission(article, publication, Guid.NewGuid(), true, "Fixture commenter", content), ct), ct);
        }

        async Task Seed(int article, long comment, short status, bool deleted, bool tracked, string body)
        {
            await fixture.Exec("""
                insert into public.comment(article_id,id,root_id,depth,moderation_status,deleted,body,author_mode,display_name,display_language,created_at)
                values($1,$2,$2,0,$3,$4,$5,3,'Fixture commenter','en',clock_timestamp())
                """, article, comment, status, deleted, body);
            if (tracked)
                await fixture.Exec("insert into public.comment_submit_command values($1,$2,$3,$4,$5)", owner, Guid.NewGuid(),
                    SHA256.HashData(Encoding.UTF8.GetBytes(body)), article, comment);
        }
    }
}
