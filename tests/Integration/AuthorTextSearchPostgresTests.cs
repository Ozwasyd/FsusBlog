using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Sessions;

namespace FsusBlog.V2.Integration.Tests;

public sealed class AuthorTextSearchPostgresTests
{
    [PostgresFact]
    public async Task CurrentPrivateIndexIsBoundedReconciledAndNeverReturnsAnotherAuthorsText()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(60));
        var ct = timeout.Token;
        await using var db = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        var store = new Store(db.DataSource);
        var owner = await Login("Full-text owner", true);
        var stranger = await Login("Full-text stranger", true);
        var reader = await Login("Full-text reader", false);
        await using var server = await ServerProcess.Start(db.ConnectionString, ct);
        var prefix = "😀\r\n" + new string('-', 230) + " ";
        var source = prefix + "Cafe\u0301 orbit";
        for (var i = 0; i < 6; i++) await Save(owner, "Unrelated article " + i, "Other material");
        var fragment = await Save(owner, "Caféteria", "orbital movement");
        var across = await Save(owner, "Café", "orbit");
        var primary = await Save(owner, "Tropical Harbor", source);
        var foreign = await Save(stranger, "Private foreign title", source);
        const string phrase = "\"Café orbit\"";

        await Send(phrase, reader, HttpStatusCode.Forbidden);
        await Send(phrase, owner with { Handle = null }, HttpStatusCode.Conflict);
        await Send(phrase, owner with { Handle = stranger.Handle }, HttpStatusCode.Conflict);
        Assert.Equal(0, await IndexedCount(owner.Id));

        var pending = await Search(phrase, owner);
        Assert.False(pending.Ready);
        Assert.False(pending.More);
        Assert.Empty(pending.Rows);
        Assert.Equal(8, await IndexedCount(owner.Id));

        var page = await Search(phrase, owner);
        Assert.True(page.Ready);
        Assert.False(page.More);
        var match = Assert.Single(page.Rows);
        Assert.Equal(primary.Id, match.Id);
        Assert.Equal(primary.Revision, match.Revision);
        Assert.Equal(2, match.Field);
        Assert.Equal("Cafe\u0301", match.Snippet[match.HighlightStart..match.HighlightEnd]);
        Assert.Equal((prefix.Length, prefix.Length + "Cafe\u0301".Length), (match.SourceStart, match.SourceEnd));
        Assert.Equal((Encoding.UTF8.GetByteCount(prefix), Encoding.UTF8.GetByteCount(prefix + "Cafe\u0301")),
            (match.SourceByteStart, match.SourceByteEnd));
        Assert.Equal(SHA256.HashData(Encoding.UTF8.GetBytes(source)), match.SourceDigest);

        Assert.Equal(new[] { primary.Id, across.Id }, (await Search("Café orbit", owner)).Rows.Select(row => row.Id).ToArray());
        Assert.Equal(new[] { primary.Id, across.Id }, (await Search("Café", owner)).Rows.Select(row => row.Id).ToArray());
        Assert.Equal(1, Assert.Single((await Search("Tropical", owner)).Rows).Field);
        Assert.Equal(new[] { primary.Id, across.Id }, (await Search("CAFÉ", owner)).Rows.Select(row => row.Id).ToArray());
        Assert.Equal(fragment.Id, Assert.Single((await Search("orbital", owner)).Rows).Id);
        Assert.Equal(foreign.Id, Assert.Single((await Search(phrase, stranger)).Rows).Id);
        await Send("body:orbit", owner, HttpStatusCode.BadRequest);
        using var anonymous = await server.Client.GetAsync(WireRoutes.PublicArticle.Replace("{id}",
            primary.Id.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal), ct);
        Assert.Equal(HttpStatusCode.NotFound, anonymous.StatusCode);

        var edited = await Change(owner, ArticleAction.Save, new(primary.Id, primary.Revision, Guid.NewGuid(), primary.Title, "updated orbit"));
        Assert.Empty((await Search(phrase, owner)).Rows);
        var changed = Assert.Single((await Search("\"updated orbit\"", owner)).Rows);
        Assert.Equal(edited.Revision, changed.Revision);
        Assert.Equal("updated", changed.Snippet[changed.HighlightStart..changed.HighlightEnd]);
        var deleted = await Change(owner, ArticleAction.Delete, new(edited.Id, edited.Revision, Guid.NewGuid(), "", ""));
        Assert.Empty((await Search("updated", owner)).Rows);
        Assert.Equal(8, await IndexedCount(owner.Id));
        var restored = await Change(owner, ArticleAction.Restore, new(deleted.Id, deleted.Revision, Guid.NewGuid(), "", ""));
        Assert.Equal(restored.Revision, Assert.Single((await Search("updated", owner)).Rows).Revision);

        const string rankedTerm = "harborproof";
        var bodyHits = new List<ArticleState>();
        for (var i = 0; i < 22; i++) bodyHits.Add(await Save(owner, "Rank body " + i, rankedTerm));
        var titleHit = await Save(owner, "Harborproof launch", "blue orbit");
        await using (var connection = await db.DataSource.OpenConnectionAsync(ct))
        await using (var ties = Store.Sql(connection, null,
            "update public.article set updated_at='2025-01-01T00:00:00Z' where id=any($1)", bodyHits.Select(row => row.Id).ToArray()))
            Assert.Equal(22, await ties.ExecuteNonQueryAsync(ct));

        Assert.False((await Ranked(rankedTerm, "", owner)).Ready);
        Assert.False((await Ranked(rankedTerm, "", owner)).Ready);
        var first = await Ranked(rankedTerm, "", owner);
        Assert.True(first.Ready);
        Assert.NotEmpty(first.NextCursor);
        Assert.Equal(new[] { titleHit.Id }.Concat(bodyHits.Take(19).Select(row => row.Id)), first.Rows.Select(row => row.Id));
        Assert.Equal(titleHit.Id, Assert.Single((await Ranked("field.title:harborproof \"blue orbit\"", "", owner)).Rows).Id);
        Assert.Empty((await Ranked("field.markdown-body:harborproof \"blue orbit\"", "", owner)).Rows);
        await SendRanked("field.body:harborproof", "", owner, HttpStatusCode.BadRequest);

        var next = await Ranked(rankedTerm, first.NextCursor, owner);
        Assert.True(next.Ready);
        Assert.Empty(next.NextCursor);
        Assert.Equal(bodyHits.Skip(19).Select(row => row.Id), next.Rows.Select(row => row.Id));
        Assert.Equal(next.Rows.Select(row => row.Id), (await Ranked(rankedTerm, first.NextCursor, owner)).Rows.Select(row => row.Id));
        var forged = (first.NextCursor[0] == 'A' ? 'B' : 'A') + first.NextCursor[1..];
        await SendRanked(rankedTerm, forged, owner, HttpStatusCode.Conflict);
        await SendRanked("HARBORPROOF", first.NextCursor, owner, HttpStatusCode.Conflict);
        await SendRanked(rankedTerm, first.NextCursor, stranger, HttpStatusCode.Conflict);
        await SendRanked(rankedTerm, first.NextCursor, await Session(owner.Id), HttpStatusCode.Conflict);

        // The rank witness includes clock changes at the same source revision, as in scheduled publication.
        await using (var connection = await db.DataSource.OpenConnectionAsync(ct))
        await using (var time = Store.Sql(connection, null,
            "update public.article set updated_at='2025-01-02T00:00:00Z' where id=$1", bodyHits[^1].Id))
            Assert.Equal(1, await time.ExecuteNonQueryAsync(ct));
        await SendRanked(rankedTerm, first.NextCursor, owner, HttpStatusCode.Conflict);
        first = await Ranked(rankedTerm, "", owner);
        Assert.Equal(bodyHits[^1].Id, first.Rows[1].Id);
        await Change(owner, ArticleAction.Save, new(bodyHits[0].Id, bodyHits[0].Revision, Guid.NewGuid(), "New revision", rankedTerm));
        await SendRanked(rankedTerm, first.NextCursor, owner, HttpStatusCode.Conflict);
        await using (var connection = await db.DataSource.OpenConnectionAsync(ct))
        await using (var index = Store.Sql(connection, null,
            "select revision from public.author_text_document where owner_id=$1 and article_id=$2", owner.Id, bodyHits[0].Id))
            Assert.Equal(bodyHits[0].Revision, Assert.IsType<long>(await index.ExecuteScalarAsync(ct)));
        Assert.Equal(restored.Revision, Assert.Single((await Search("updated", owner)).Rows).Revision);

        Task<ArticleState> Save(Actor actor, string title, string body) =>
            Change(actor, ArticleAction.Save, new(0, 0, Guid.NewGuid(), title, body));

        async Task<ArticleState> Change(Actor actor, ArticleAction action, Edit edit) =>
            (await store.WithSession(actor.Token, true, (conn, tx, identity) => Store.Execute(conn, tx, identity, action, edit, ct), ct)).Article;

        async Task<AuthorTextSearchPage> Search(string query, Actor actor) =>
            Wire.DecodeAuthorTextSearchPage(await Send(query, actor, HttpStatusCode.OK));

        async Task<AuthorTextRankedPage> Ranked(string query, string cursor, Actor actor) =>
            Wire.DecodeAuthorTextRankedPage(await SendRanked(query, cursor, actor, HttpStatusCode.OK));

        Task<byte[]> Send(string query, Actor actor, HttpStatusCode expected) =>
            SendFrame(Wire.EncodeAuthorTextSearchQuery(query), actor, expected);

        Task<byte[]> SendRanked(string query, string cursor, Actor actor, HttpStatusCode expected) =>
            SendFrame(Wire.EncodeAuthorTextRankedQuery(new(query, cursor)), actor, expected);

        async Task<byte[]> SendFrame(byte[] frame, Actor actor, HttpStatusCode expected)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, WireRoutes.AuthorTextSearch)
            {
                Content = new ByteArrayContent(frame),
            };
            request.Content.Headers.ContentType = new MediaTypeHeaderValue(Aeds.ContentType);
            request.Headers.Add("Cookie", "fsus-v2-session=" + actor.Token);
            if (actor.Handle is not null) request.Headers.Add(WireHeaders.CurrentSession, actor.Handle);
            using var response = await server.Client.SendAsync(request, ct);
            Assert.Equal(expected, response.StatusCode);
            Assert.True(response.Headers.CacheControl?.NoStore);
            return await response.Content.ReadAsByteArrayAsync(ct);
        }

        async Task<long> IndexedCount(Guid id)
        {
            await using var conn = await db.DataSource.OpenConnectionAsync(ct);
            await using var command = Store.Sql(conn, null, "select count(*) from public.author_text_document where owner_id=$1", id);
            return Assert.IsType<long>(await command.ExecuteScalarAsync(ct));
        }

        async Task<Actor> Login(string name, bool canAuthor)
        {
            var id = Guid.NewGuid();
            await using var conn = await db.DataSource.OpenConnectionAsync(ct);
            await using (var account = Store.Sql(conn, null, """
                insert into public.blog_user(id,name,can_author,enabled,generation) values($1,$2,$3,true,1)
                """, id, name, canAuthor))
                await account.ExecuteNonQueryAsync(ct);
            return await Session(id);
        }

        async Task<Actor> Session(Guid id)
        {
            var key = RandomNumberGenerator.GetBytes(32);
            await using var conn = await db.DataSource.OpenConnectionAsync(ct);
            await using (var ticket = Store.Sql(conn, null, "insert into public.login_ticket values($1,$2,now()+interval '2 minutes')", SHA256.HashData(key), id))
                await ticket.ExecuteNonQueryAsync(ct);
            var token = (await store.SignIn(Convert.ToHexStringLower(key), ct)).Token;
            return new(id, token, SiteSessions.Id(id, Store.TokenDigest(token)!));
        }
    }

    private sealed record Actor(Guid Id, string Token, string? Handle);
}
