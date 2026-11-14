using System.Net;
using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Integration.Tests;
using FsusBlog.V2.Server;
using Npgsql;

public sealed class RevisionHistoryPostgresTests
{
    [PostgresFact]
    public async Task OwnerCanCompareAndRestoreExactDraftWithoutMovingPublicCoordinates()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var store = new Store(fixture.DataSource);
        var owner = await SignIn("Revision owner", true);
        var otherSession = await SignIn("Revision owner", true, owner.User.Id);
        var outsider = await SignIn("Revision outsider", true);
        var reader = await SignIn("Revision reader", false);
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);
        var article = await Write(0, 0, "Original private title", "First body, exact \r\n");
        await Execute("insert into public.category(id,name) values(1,'Original category'),(2,'Public category')");
        await Execute("insert into public.tag(id,name) values(4,'Original tag')");
        await Execute("insert into public.article_revision_category values($1,$2,1)", article.Id, article.Revision);
        await Execute("insert into public.article_revision_tag values($1,$2,4)", article.Id, article.Revision);
        var toPublish = await Write(article.Id, article.Revision, "Public title", "Public body");
        await Execute("update public.article_revision_category set category_id=2 where article_id=$1 and revision=$2",
            article.Id, toPublish.Revision);
        var published = Wire.DecodeDraft(await Request(HttpMethod.Post, WireRoutes.Publish, owner.Token,
            Wire.EncodeArticleCommand(new(article.Id, toPublish.Revision, Guid.NewGuid(), "", ""))));
        Assert.Contains("Public body", await server.Client.GetStringAsync($"/article/{article.Id}", ct));

        var current = published;
        for (var index = 0; index < WireLimits.RevisionHistoryPageSize; index++)
            current = await Write(article.Id, current.Revision, $"private revision {index}", $"Private body {index}");
        var otherArticle = await Write(0, 0, "Another owner-visible article", "Never appears in first history.");
        var first = Wire.DecodeRevisionHistory(await Request(HttpMethod.Get, History(current), owner.Token));
        Assert.Equal(current.Revision, first.Revision);
        Assert.Equal(published.Revision, first.PublishedRevision);
        Assert.Equal(WireLimits.RevisionHistoryPageSize, first.Items.Count);
        Assert.Equal(current.Revision, first.Items[0].Revision);
        Assert.All(first.Items, item => Assert.Equal(0, item.SourceRevision));
        var nextPage = $"&cursor={first.NextCursor}";
        var last = Wire.DecodeRevisionHistory(await Request(HttpMethod.Get, History(current) + nextPage, owner.Token));
        Assert.Equal(new long[] { 3, 2, 1 }, last.Items.Select(item => item.Revision));
        Assert.Empty(last.NextCursor);
        await Request(HttpMethod.Get, History(current) + nextPage, otherSession.Token, status: HttpStatusCode.BadRequest);
        await Request(HttpMethod.Get, History(otherArticle) + nextPage, owner.Token, status: HttpStatusCode.BadRequest);
        var firstChar = first.NextCursor[0] == 'A' ? 'B' : 'A';
        await Request(HttpMethod.Get, History(current) + $"&cursor={firstChar}{first.NextCursor[1..]}", owner.Token, status: HttpStatusCode.BadRequest);
        await Request(HttpMethod.Get, History(current), null, status: HttpStatusCode.Unauthorized);
        await Request(HttpMethod.Get, History(current), outsider.Token, status: HttpStatusCode.NotFound);
        await Request(HttpMethod.Get, History(current), reader.Token, status: HttpStatusCode.Forbidden);

        var compare = WireRoutes.DraftRevisionComparison.Replace("{id:int}", current.Id.ToString())
            .Replace("{sourceRevision:long}", article.Revision.ToString()) + $"?revision={current.Revision}";
        var pair = Wire.DecodeRevisionComparison(await Request(HttpMethod.Get, compare, owner.Token));
        Assert.Equal((current.Title, current.Body, article.Title, article.Body), (pair.Title, pair.Body, pair.SourceTitle, pair.SourceBody));
        await Request(HttpMethod.Get, compare, outsider.Token, status: HttpStatusCode.NotFound);
        var input = new DraftRollback(article.Id, current.Revision, article.Revision, Guid.NewGuid(), "Restore the original draft. 📝");
        await Restore(input, outsider.Token, HttpStatusCode.NotFound);

        // A failed enqueue must roll back draft, copied taxonomy, command and provenance together.
        await Execute("alter table public.blog_outbox add constraint test_fail_restore check (kind <> 'draft-rollback')");
        await Restore(input, owner.Token, HttpStatusCode.ServiceUnavailable);
        Assert.Equal(current.Revision, await Scalar<long>("select revision from public.article where id=$1", article.Id));
        Assert.Equal(0L, await Scalar<long>("select count(*) from public.article_rollback"));
        Assert.Equal(0L, await Scalar<long>("select count(*) from public.article_command where command_id=$1", input.IdempotencyKey));
        await Execute("alter table public.blog_outbox drop constraint test_fail_restore");

        // Concurrent retries serialize and produce the same durable receipt.
        var receipts = await Task.WhenAll(Restore(input, owner.Token), Restore(input, owner.Token));
        Assert.Equal(receipts[0], receipts[1]);
        var restored = Wire.DecodeDraft(receipts[0]);
        Assert.Equal((current.Revision + 1, article.Title, article.Body, true),
            (restored.Revision, restored.Title, restored.Body, restored.Published));
        await Restore(input with { Reason = "A different valid reason." }, owner.Token, HttpStatusCode.Conflict);
        await Restore(input with { IdempotencyKey = Guid.NewGuid() }, owner.Token, HttpStatusCode.Conflict);
        await Request(HttpMethod.Get, History(current) + nextPage, owner.Token, status: HttpStatusCode.Conflict);
        await Request(HttpMethod.Get, compare, owner.Token, status: HttpStatusCode.Conflict);
        var restoredHistory = Wire.DecodeRevisionHistory(await Request(HttpMethod.Get, History(restored), owner.Token));
        Assert.Equal(input.SourceRevision, restoredHistory.Items[0].SourceRevision);
        Assert.Equal(input.Reason, restoredHistory.Items[0].Reason);
        Assert.Equal(published.Revision, restoredHistory.PublishedRevision);
        Assert.Equal(published.Revision, await Scalar<long>("select revision from public.article_publication where article_id=$1", article.Id));
        Assert.Equal(1, await Scalar<int>("select category_id from public.article_revision_category where article_id=$1 and revision=$2",
            article.Id, restored.Revision));
        Assert.Equal(4, await Scalar<int>("select tag_id from public.article_revision_tag where article_id=$1 and revision=$2",
            article.Id, restored.Revision));
        Assert.Equal(1L, await Scalar<long>("select count(*) from public.blog_outbox where kind='draft-rollback' and article_id=$1 and revision=$2",
            article.Id, restored.Revision));
        Assert.Equal(owner.User.Id, await Scalar<Guid>("select actor_id from public.article_rollback where article_id=$1 and revision=$2",
            article.Id, restored.Revision));
        var stillPublic = await server.Client.GetStringAsync($"/article/{article.Id}", ct);
        Assert.Contains("Public body", stillPublic);
        Assert.DoesNotContain("First body", stillPublic);
        await Request(HttpMethod.Post, WireRoutes.Publish, owner.Token,
            Wire.EncodeArticleCommand(new(article.Id, restored.Revision, Guid.NewGuid(), "", "")));
        Assert.Contains("First body", await server.Client.GetStringAsync($"/article/{article.Id}", ct));

        async Task<(string Token, FsusBlog.V2.Core.Identity User)> SignIn(string name, bool author, Guid? user = null)
        {
            var id = user ?? Guid.NewGuid();
            if (user is null)
                await Execute("insert into public.blog_user(id,name,can_author,enabled,generation) values($1,$2,$3,true,1)",
                    id, name, author);
            var ticket = RandomNumberGenerator.GetBytes(32);
            await Execute("insert into public.login_ticket values($1,$2,now()+interval '2 minutes')",
                SHA256.HashData(ticket), id);
            return await store.SignIn(Convert.ToHexStringLower(ticket), ct);
        }

        async Task Execute(string sql, params object[] values)
        {
            await using var command = Store.Sql(db, null, sql, values);
            await command.ExecuteNonQueryAsync(ct);
        }

        async Task<T> Scalar<T>(string sql, params object[] values)
        {
            await using var command = Store.Sql(db, null, sql, values);
            return (T)(await command.ExecuteScalarAsync(ct))!;
        }

        string History(Draft draft) => WireRoutes.DraftRevisionHistory.Replace("{id:int}", draft.Id.ToString()) + $"?revision={draft.Revision}";

        async Task<Draft> Write(int id, long revision, string title, string body) =>
            Wire.DecodeDraft(await Request(HttpMethod.Post, WireRoutes.Save, owner.Token,
                Wire.EncodeArticleCommand(new(id, revision, Guid.NewGuid(), title, body))));

        Task<byte[]> Restore(DraftRollback rollback, string token, HttpStatusCode status = HttpStatusCode.OK) =>
            Request(HttpMethod.Post, WireRoutes.DraftRollback, token, Wire.EncodeDraftRollback(rollback), status);

        async Task<byte[]> Request(HttpMethod method, string path, string? token, byte[]? body = null, HttpStatusCode status = HttpStatusCode.OK)
        {
            using var request = new HttpRequestMessage(method, path);
            if (token is not null) request.Headers.Add("Cookie", $"fsus-v2-session={token}");
            if (body is not null)
            {
                request.Content = new ByteArrayContent(body);
                request.Content.Headers.ContentType = new(Aeds.ContentType);
            }
            using var response = await server.Client.SendAsync(request, ct);
            var bytes = await response.Content.ReadAsByteArrayAsync(ct);
            Assert.Equal(status, response.StatusCode);
            Assert.True(response.Headers.CacheControl?.NoStore);
            Assert.Equal(Aeds.ContentType, response.Content.Headers.ContentType?.MediaType);
            return bytes;
        }
    }
}
