using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Integration.Tests;
using FsusBlog.V2.Contracts;
using Microsoft.Extensions.Logging.Abstractions;
using Npgsql;
using System.Net;

public sealed class PublishingPostgresTests
{
    [PostgresFact]
    public async Task WithdrawingInvalidatesOldHttpRepresentationsAcrossRestart()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable("FSUSBLOG_TEST_DB")!, ct);
        var store = new Store(fixture.DataSource);
        var session = await store.SignIn((await IssueTicket(fixture.DataSource, "http publisher", true, ct)).Token, ct);
        const string marker = "public replacement unique marker";
        int articleId;
        string publishedGeneration;
        await using (var server = await ServerProcess.Start(fixture.ConnectionString, ct))
        {
            var saved = Wire.DecodeDraft(await Write(server.Client, session.Token, WireRoutes.Save,
                new(0, 0, Guid.NewGuid(), "Snapshot <check>", $"## Publication heading\n\n{marker}\n\n[Read source](/archive)"), ct));
            articleId = saved.Id;
            var published = Wire.DecodeDraft(await Write(server.Client, session.Token, WireRoutes.Publish,
                new(articleId, saved.Revision, Guid.NewGuid(), "", ""), ct));
            using var html = await server.Client.GetAsync($"/article/{articleId}", ct);
            var page = await html.Content.ReadAsStringAsync(ct);
            Assert.Equal(HttpStatusCode.OK, html.StatusCode);
            Assert.Contains("<h2>Publication heading</h2>", page);
            Assert.Contains("href=\"/archive\"", page);
            Assert.Contains(marker, page);
            Assert.True(html.Headers.CacheControl?.NoStore);
            publishedGeneration = Assert.Single(html.Headers.GetValues(WireHeaders.SearchIndexGeneration));
            var binary = WireRoutes.PublicArticle.Replace("{id}", articleId.ToString(System.Globalization.CultureInfo.InvariantCulture));
            using var detail = await server.Client.GetAsync(binary, ct);
            Assert.Equal(HttpStatusCode.OK, detail.StatusCode);
            Assert.Equal(publishedGeneration, Assert.Single(detail.Headers.GetValues(WireHeaders.SearchIndexGeneration)));
            _ = Aeds.Decode(await detail.Content.ReadAsByteArrayAsync(ct), FrameType.ArticleDetail).Length;
            await Write(server.Client, session.Token, WireRoutes.Retract,
                new(articleId, published.Revision, Guid.NewGuid(), "", ""), ct);
            await VerifyUnavailable(server.Client, binary);
        }

        await using var restarted = await ServerProcess.Start(fixture.ConnectionString, ct);
        var binaryAfterRestart = WireRoutes.PublicArticle.Replace("{id}", articleId.ToString(System.Globalization.CultureInfo.InvariantCulture));
        await VerifyUnavailable(restarted.Client, binaryAfterRestart);

        async Task VerifyUnavailable(HttpClient client, string binary)
        {
            foreach (var route in new[] { $"/article/{articleId}", binary })
            {
                using var request = new HttpRequestMessage(HttpMethod.Get, route);
                request.Headers.IfNoneMatch.ParseAdd("*");
                using var response = await client.SendAsync(request, ct);
                Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
                Assert.True(response.Headers.CacheControl?.NoStore);
                Assert.DoesNotContain(marker, await response.Content.ReadAsStringAsync(ct));
            }
            using var previous = await client.GetAsync($"{WireRoutes.PublicIndex}?page=1&generation={publishedGeneration}", ct);
            Assert.Equal(HttpStatusCode.Conflict, previous.StatusCode);
            Assert.DoesNotContain(marker, await previous.Content.ReadAsStringAsync(ct));
            using var current = await client.GetAsync(WireRoutes.PublicIndex, ct);
            Assert.Equal(HttpStatusCode.OK, current.StatusCode);
            Assert.NotEqual(publishedGeneration, Assert.Single(current.Headers.GetValues(WireHeaders.SearchIndexGeneration)));
        }
    }

    private static async Task<byte[]> Write(HttpClient client, string token, string route, ArticleCommand command, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, route);
        request.Headers.Add("Cookie", $"fsus-v2-session={token}");
        request.Content = new ByteArrayContent(Wire.EncodeArticleCommand(command));
        request.Content.Headers.ContentType = new("application/octet-stream");
        using var response = await client.SendAsync(request, ct);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await response.Content.ReadAsByteArrayAsync(ct);
    }

    [PostgresFact]
    public async Task AFailedOutboxInsertRollsBackTheDraftAndAllowsAnExactRetry()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable("FSUSBLOG_TEST_DB")!, ct);
        var store = new Store(fixture.DataSource);
        var publications = new Publications(fixture.DataSource, new WebPages("<body><!--fsus-public-content--></body>"), NullLogger<Publications>.Instance);
        await publications.Refresh(ct);
        var session = await store.SignIn((await IssueTicket(fixture.DataSource, "transaction author", true, ct)).Token, ct);
        var command = new Edit(0, 0, Guid.NewGuid(), "Rollback fixture", "The draft must roll back with the event.");

        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        await using (var reject = Store.Sql(db, null, """
            alter table public.blog_outbox add constraint test_reject_save check (kind <> 'save')
            """)) await reject.ExecuteNonQueryAsync(ct);
        var error = await Assert.ThrowsAsync<PostgresException>(() => publications.Command(store, session.Token, ArticleAction.Save, command, ct));
        Assert.Equal("test_reject_save", error.ConstraintName);

        await using (var verify = Store.Sql(db, null, """
            select (select count(*) from public.article) + (select count(*) from public.article_revision)
                + (select count(*) from public.article_command) + (select count(*) from public.blog_outbox)
            """)) Assert.Equal(0L, await verify.ExecuteScalarAsync(ct));

        await using (var removeFault = Store.Sql(db, null, "alter table public.blog_outbox drop constraint test_reject_save"))
            await removeFault.ExecuteNonQueryAsync(ct);
        var saved = await publications.Command(store, session.Token, ArticleAction.Save, command, ct);
        Assert.True(saved.Changed);
        var replay = await publications.Command(store, session.Token, ArticleAction.Save, command, ct);
        Assert.Equal(saved.Article, replay.Article);
        Assert.False(replay.Changed);
        var mismatch = await Assert.ThrowsAsync<BusinessException>(() =>
            publications.Command(store, session.Token, ArticleAction.Save, command with { Body = "different request" }, ct));
        Assert.Equal(Rejection.Conflict, mismatch.Rejection);
    }

    [PostgresFact]
    public async Task ReadOnlyExpiredAndRevokedSessionsCannotCreateArticles()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable("FSUSBLOG_TEST_DB")!, ct);
        var store = new Store(fixture.DataSource);
        var publications = new Publications(fixture.DataSource, new WebPages("<body><!--fsus-public-content--></body>"), NullLogger<Publications>.Instance);
        var edit = new Edit(0, 0, Guid.NewGuid(), "No unauthorized writes", "private");
        var reader = await store.SignIn((await IssueTicket(fixture.DataSource, "reader", false, ct)).Token, ct);
        var author = await store.SignIn((await IssueTicket(fixture.DataSource, "author", true, ct)).Token, ct);

        await AssertDenied(reader.Token, Rejection.Forbidden);
        await AssertDenied(null, Rejection.Unauthorized);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        await using (var revoke = Store.Sql(db, null, "update public.blog_user set generation=generation+1 where id=$1", author.User.Id))
            Assert.Equal(1, await revoke.ExecuteNonQueryAsync(ct));
        await AssertDenied(author.Token, Rejection.Unauthorized);
        await using (var expire = Store.Sql(db, null, "update public.user_session set expires_at=clock_timestamp()-interval '1 second' where user_id=$1", reader.User.Id))
            Assert.Equal(1, await expire.ExecuteNonQueryAsync(ct));
        await AssertDenied(reader.Token, Rejection.Unauthorized);
        await using var count = Store.Sql(db, null, "select count(*) from public.article");
        Assert.Equal(0L, await count.ExecuteScalarAsync(ct));

        async Task AssertDenied(string? session, Rejection expected)
        {
            var denial = await Assert.ThrowsAsync<BusinessException>(() => publications.Command(store, session, ArticleAction.Save, edit, ct));
            Assert.Equal(expected, denial.Rejection);
        }
    }

    [PostgresFact]
    public async Task PublicationOrdinalsArePerArticleAndSurviveWithdrawal()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable("FSUSBLOG_TEST_DB")!, ct);
        var store = new Store(fixture.DataSource);
        var publications = new Publications(fixture.DataSource, new WebPages("<body><!--fsus-public-content--></body>"), NullLogger<Publications>.Instance);
        var session = await store.SignIn((await IssueTicket(fixture.DataSource, "publisher", true, ct)).Token, ct);
        var first = await CreateAndPublish("one");
        var second = await CreateAndPublish("two");
        Assert.NotEqual(first.Publication, second.Publication);
        Assert.Equal(1, first.PublicationNo);
        Assert.Equal(1, second.PublicationNo);

        var withdrawn = await publications.Command(store, session.Token, ArticleAction.Retract,
            new(first.Id, first.Revision, Guid.NewGuid(), "", ""), ct);
        Assert.Null(publications.Snapshot!.Article(first.Id));
        await publications.Command(store, session.Token, ArticleAction.Publish,
            new(first.Id, withdrawn.Article.Revision, Guid.NewGuid(), "", ""), ct);
        var republished = publications.Snapshot!.Article(first.Id)!.Article;
        Assert.Equal(2, republished.PublicationNo);
        Assert.NotEqual(first.Publication, republished.Publication);
        Assert.Equal(second, publications.Snapshot!.Article(second.Id)!.Article);

        async Task<FsusBlog.V2.Contracts.Article> CreateAndPublish(string title)
        {
            var draft = await publications.Command(store, session.Token, ArticleAction.Save,
                new(0, 0, Guid.NewGuid(), title, "Published body"), ct);
            await publications.Command(store, session.Token, ArticleAction.Publish,
                new(draft.Article.Id, draft.Article.Revision, Guid.NewGuid(), "", ""), ct);
            return publications.Snapshot!.Article(draft.Article.Id)!.Article;
        }
    }

    [PostgresFact]
    public async Task PublishAndRetractUseOneAuthorizedDurableRevision()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable("FSUSBLOG_TEST_DB")!, ct);
        var store = new Store(fixture.DataSource);
        var publications = new Publications(fixture.DataSource, new WebPages("<body><!--fsus-public-content--></body>"), NullLogger<Publications>.Instance);
        await publications.Refresh(ct);
        var issue = await IssueTicket(fixture.DataSource, "original owner", true, ct);
        var session = await store.SignIn(issue.Token, ct);
        Assert.Equal(Rejection.Unauthorized, (await Assert.ThrowsAsync<BusinessException>(() => store.SignIn(issue.Token, ct))).Rejection);
        var command = new Edit(0, 0, Guid.NewGuid(), "Saved title", "Saved Markdown body");
        var first = publications.Command(store, session.Token, ArticleAction.Save, command, ct);
        var retry = publications.Command(store, session.Token, ArticleAction.Save, command, ct);
        var saved = (await first).Article;
        Assert.Equal(saved, (await retry).Article);
        Assert.Null(publications.Snapshot!.Article(saved.Id));

        var next = new Edit(saved.Id, saved.Revision, Guid.NewGuid(), "Published title", "Published Markdown body");
        var newDraft = (await publications.Command(store, session.Token, ArticleAction.Save, next, ct)).Article;
        var oldPublication = new Edit(saved.Id, saved.Revision, Guid.NewGuid(), "", "");
        Assert.Equal(Rejection.Conflict, (await Assert.ThrowsAsync<BusinessException>(() =>
            publications.Command(store, session.Token, ArticleAction.Publish, oldPublication, ct))).Rejection);
        var publish = oldPublication with { ExpectedRevision = newDraft.Revision };
        var published = (await publications.Command(store, session.Token, ArticleAction.Publish, publish, ct)).Article;
        Assert.Equal(published.Revision, publications.Snapshot!.Article(saved.Id)!.Article.Revision);

        var outsider = await store.SignIn((await IssueTicket(fixture.DataSource, "other author", true, ct)).Token, ct);
        var retract = new Edit(saved.Id, published.Revision, Guid.NewGuid(), "", "");
        Assert.Equal(Rejection.NotFound, (await Assert.ThrowsAsync<BusinessException>(() =>
            publications.Command(store, outsider.Token, ArticleAction.Retract, retract, ct))).Rejection);
        await publications.Command(store, session.Token, ArticleAction.Retract, retract, ct);
        Assert.Null(publications.Snapshot!.Article(saved.Id));
        await using var connection = await fixture.DataSource.OpenConnectionAsync(ct);
        await using var rows = Store.Sql(connection, null, "select count(*), count(distinct revision) from public.blog_outbox where article_id=$1", saved.Id);
        await using var result = await rows.ExecuteReaderAsync(ct);
        Assert.True(await result.ReadAsync(ct));
        Assert.Equal(4, result.GetInt64(0));
        Assert.Equal(4, result.GetInt64(1));
    }

    private static async Task<(Guid Id, string Token)> IssueTicket(NpgsqlDataSource source, string name, bool author, CancellationToken ct)
    {
        var id = Guid.NewGuid();
        var secret = System.Security.Cryptography.RandomNumberGenerator.GetBytes(32);
        await using var connection = await source.OpenConnectionAsync(ct);
        await using (var user = Store.Sql(connection, null, "insert into public.blog_user(id,name,can_author,enabled,generation) values($1,$2,$3,true,1)", id, name, author))
            await user.ExecuteNonQueryAsync(ct);
        await using (var ticket = Store.Sql(connection, null, "insert into public.login_ticket(digest,user_id,expires_at) values($1,$2,now()+interval '1 minute')",
            System.Security.Cryptography.SHA256.HashData(secret), id)) await ticket.ExecuteNonQueryAsync(ct);
        return (id, Convert.ToHexStringLower(secret));
    }
}
