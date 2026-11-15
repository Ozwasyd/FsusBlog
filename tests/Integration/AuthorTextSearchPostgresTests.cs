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

        Task<ArticleState> Save(Actor actor, string title, string body) =>
            Change(actor, ArticleAction.Save, new(0, 0, Guid.NewGuid(), title, body));

        async Task<ArticleState> Change(Actor actor, ArticleAction action, Edit edit) =>
            (await store.WithSession(actor.Token, true, (conn, tx, identity) => Store.Execute(conn, tx, identity, action, edit, ct), ct)).Article;

        async Task<AuthorTextSearchPage> Search(string query, Actor actor) =>
            Wire.DecodeAuthorTextSearchPage(await Send(query, actor, HttpStatusCode.OK));

        async Task<byte[]> Send(string query, Actor actor, HttpStatusCode expected)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, WireRoutes.AuthorTextSearch)
            {
                Content = new ByteArrayContent(Wire.EncodeAuthorTextSearchQuery(query)),
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
            var key = RandomNumberGenerator.GetBytes(32);
            await using var conn = await db.DataSource.OpenConnectionAsync(ct);
            await using (var account = Store.Sql(conn, null, """
                insert into public.blog_user(id,name,can_author,enabled,generation) values($1,$2,$3,true,1)
                """, id, name, canAuthor))
                await account.ExecuteNonQueryAsync(ct);
            await using (var ticket = Store.Sql(conn, null, "insert into public.login_ticket values($1,$2,now()+interval '2 minutes')", SHA256.HashData(key), id))
                await ticket.ExecuteNonQueryAsync(ct);
            var token = (await store.SignIn(Convert.ToHexStringLower(key), ct)).Token;
            return new(id, token, SiteSessions.Id(id, Store.TokenDigest(token)!));
        }
    }

    private sealed record Actor(Guid Id, string Token, string? Handle);
}
