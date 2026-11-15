using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Administration;
using FsusBlog.V2.Server.Comments;
using FsusBlog.V2.Server.Passkeys;
using FsusBlogV2.Storage;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Primitives;

namespace FsusBlog.V2.Integration.Tests;

public sealed class AdminCommentQueuePostgresTests
{
    [PostgresFact]
    public async Task ModeratorReadsTrackedPendingCommentsAcrossPagesWithRevocationAndPublicIsolation()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = timeout.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var admin = Guid.NewGuid();
        var owner = Guid.NewGuid();
        var adminToken = Secret();
        var siteTicket = Secret();
        await Execute("insert into public.admin_principal(id,handle,user_handle,enabled,generation) values($1,'moderator',$2,true,1)",
            admin, RandomNumberGenerator.GetBytes(32));
        await Execute("insert into public.admin_passkey_credential values($1,$2,$3,0,false,false)", new byte[] { 1 }, admin, new byte[] { 2 });
        await Execute("insert into public.admin_permission values($1,$2),($1,$3)", admin,
            CurrentSchema.AdminManagePermission, CurrentSchema.AuditReadPermission);
        await Execute("insert into public.admin_session values($1,$2,1,clock_timestamp()+interval '10 minutes')", Store.TokenDigest(adminToken)!, admin);
        await Execute("insert into public.blog_user(id,name,can_author,enabled,generation) values($1,'author',true,true,1)", owner);
        await Execute("insert into public.login_ticket values($1,$2,clock_timestamp()+interval '5 minutes')", Store.TokenDigest(siteTicket)!, owner);
        await Execute("insert into public.comment_public_handle values($1,'Fixture commenter')", owner);

        var store = new Store(fixture.DataSource);
        var (siteToken, _) = await store.SignIn(siteTicket, ct);
        var adminStore = new AdminPasskeyStore(fixture.DataSource, null, new PasskeyConfiguration(new Uri("http://localhost"), "localhost"));
        var publications = new Publications(fixture.DataSource, new WebPages("<!--fsus-public-content-->"), NullLogger<Publications>.Instance);
        var published = await Publish("Public comment fixture");
        var retracted = await Publish("Retracted comment fixture");
        var removed = await Publish("Deleted comment fixture");
        var draft = await ArticleCommand(ArticleAction.Save, 0, 0, "Draft without submissions");

        const string pending = "Pending <strong>literal review content</strong>";
        var genuine = await Submit(published.Id, pending);
        var approved = await Submit(published.Id, "Approved public comment control");
        await Execute("update public.comment set moderation_status=1 where article_id=$1 and id=$2", published.Id, approved.CommentId);
        var acceptedAfterRetraction = await Submit(retracted.Id, "Pending under retracted article");
        var excludedAfterDeletion = await Submit(removed.Id, "Pending under deleted article");
        await ArticleCommand(ArticleAction.Retract, retracted.Id, retracted.Revision, retracted.Title);
        await ArticleCommand(ArticleAction.Delete, removed.Id, removed.Revision, removed.Title);

        await Seed(published.Id, 10_000, 2, deleted: false, tracked: true, "Rejected tracked comment");
        await Seed(published.Id, 10_001, 3, deleted: false, tracked: true, "Hidden tracked comment");
        await Seed(published.Id, 10_002, 0, deleted: true, tracked: true, "Deleted tracked comment");
        await Seed(draft.Id, 10_003, 0, deleted: false, tracked: false, "Untracked pending draft comment");
        await Seed(published.Id, 10_004, 0, deleted: false, tracked: false, "Untracked pending public comment");

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
        await Seed(retracted.Id, allExpected[WireLimits.AdminCommentQueueSize - 1].Comment,
            0, deleted: false, tracked: true, "Pending shared comment coordinate");
        allExpected.Add((allExpected[WireLimits.AdminCommentQueueSize - 1].Comment, retracted.Id));

        await Denied(Rejection.Unauthorized, () => adminStore.CommentQueue(siteToken, QueryCollection.Empty, ct));
        await Denied(Rejection.Forbidden, () => adminStore.CommentQueue(adminToken, QueryCollection.Empty, ct));
        await Execute("insert into public.admin_permission values($1,$2)", admin, CurrentSchema.CommentModeratePermission);
        await Denied(Rejection.Invalid, () => adminStore.CommentQueue(adminToken, new QueryCollection(new Dictionary<string, StringValues>
        {
            ["afterComment"] = "1",
        }), ct));

        var page = await adminStore.CommentQueue(adminToken, QueryCollection.Empty, ct);
        Assert.True(page.HasMore);
        Assert.Equal(WireLimits.AdminCommentQueueSize, page.Comments.Count);
        var realComment = Assert.Single(page.Comments, item => item.CommentId == genuine.CommentId && item.ArticleId == published.Id);
        Assert.Equal(pending, realComment.Body);
        Assert.Equal("Fixture commenter", realComment.DisplayName);
        Assert.True(realComment.CreatedAt > 0);
        Assert.DoesNotContain(page.Comments, item => item.CommentId == excludedAfterDeletion.CommentId && item.ArticleId == removed.Id);
        var encodedQueue = Wire.EncodeAdminCommentQueue(page);
        Aeds.Decode(encodedQueue, out var frameType);
        Assert.Equal(FrameType.AdminCommentQueue, frameType);
        Assert.True(encodedQueue.AsSpan().IndexOf(Encoding.UTF8.GetBytes(pending)) >= 0);

        var last = page.Comments[^1];
        var finalPage = await adminStore.CommentQueue(adminToken, new QueryCollection(new Dictionary<string, StringValues>
        {
            ["afterComment"] = last.CommentId.ToString(CultureInfo.InvariantCulture),
            ["afterArticle"] = last.ArticleId.ToString(CultureInfo.InvariantCulture),
        }), ct);
        Assert.False(finalPage.HasMore);
        Assert.Equal(last.CommentId, finalPage.Comments[0].CommentId);
        Assert.Equal(retracted.Id, finalPage.Comments[0].ArticleId);
        Assert.Equal(allExpected.Order(), page.Comments.Concat(finalPage.Comments).Select(item => (item.CommentId, item.ArticleId)));

        var publicFrame = await new CommentReadStore(fixture.DataSource).Roots(published.Id, null, 50, ct);
        Aeds.Decode(publicFrame, out var publicType);
        Assert.Equal(FrameType.CommentTreeRootCursor, publicType);
        Assert.True(publicFrame.AsSpan().IndexOf("Approved public comment control"u8) >= 0);
        Assert.True(publicFrame.AsSpan().IndexOf(Encoding.UTF8.GetBytes(pending)) < 0);
        await Execute("update public.admin_principal set generation=generation+1,generation_changed_at=clock_timestamp() where id=$1", admin);
        await Denied(Rejection.Unauthorized, () => adminStore.CommentQueue(adminToken, QueryCollection.Empty, ct));

        async Task<ArticleState> ArticleCommand(ArticleAction action, int id, long revision, string title)
        {
            var edit = action == ArticleAction.Save
                ? new Edit(id, revision, Guid.NewGuid(), title, "Moderation fixture article body")
                : new Edit(id, revision, Guid.NewGuid(), "", "");
            var (article, _) = await publications.Command(store, siteToken, action,
                edit, ct);
            return article;
        }

        async Task<ArticleState> Publish(string title)
        {
            var article = await ArticleCommand(ArticleAction.Save, 0, 0, title);
            var publishedArticle = await ArticleCommand(ArticleAction.Publish, article.Id, article.Revision, title);
            await Execute("insert into public.comment_public_write values($1)", article.Id);
            return publishedArticle;
        }

        async Task<PublicCommentSubmissionResult> Submit(int article, string content)
        {
            await using var select = Store.Sql(db, null, "select publication_id from public.article_publication where article_id=$1", article);
            var publication = (long)(await select.ExecuteScalarAsync(ct))!;
            return await store.WithSession(siteToken, false,
                (connection, tx, actor) => CommentWriteStore.Submit(connection, tx, actor,
                    new PublicCommentSubmission(article, publication, Guid.NewGuid(), true, "Fixture commenter", content), ct), ct);
        }

        async Task Seed(int article, long comment, short status, bool deleted, bool tracked, string body)
        {
            await Execute("""
                insert into public.comment(article_id,id,root_id,depth,moderation_status,deleted,body,author_mode,display_name,display_language,created_at)
                values($1,$2,$2,0,$3,$4,$5,3,'Fixture commenter','en',clock_timestamp())
                """, article, comment, status, deleted, body);
            if (tracked)
                await Execute("insert into public.comment_submit_command values($1,$2,$3,$4,$5)", owner, Guid.NewGuid(),
                    SHA256.HashData(Encoding.UTF8.GetBytes(body)), article, comment);
        }

        Task Execute(string sql, params object[] arguments) =>
            FixtureSql.ExecuteAsync(db, null, ct, sql, arguments);
    }

    private static string Secret() => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));

    private static async Task Denied(Rejection expected, Func<Task> action) =>
        Assert.Equal(expected, (await Assert.ThrowsAsync<BusinessException>(action)).Rejection);
}
