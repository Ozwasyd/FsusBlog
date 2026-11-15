using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Sessions;

namespace FsusBlog.V2.Integration.Tests;

public sealed class AuthorTextPropertyTextPostgresTests
{
    [PostgresFact]
    public async Task PhraseSearchUsesOnlySavedTextAndRejectsAChangedOffPageSource()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = timeout.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        var store = new Store(fixture.DataSource);
        var owner = await Login("Property text author");
        var stranger = await Login("Property text stranger");
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);
        var revisions = new Dictionary<int, long>();

        var selected = await Create(owner, "research", PropertyFieldKind.Text);
        selected = await EnableText(owner, selected, true);
        var other = await Create(owner, "notes", PropertyFieldKind.Text);
        other = await EnableText(owner, other, true);
        var flag = await Create(owner, "visible", PropertyFieldKind.Boolean);
        flag = Advance(owner, flag, await Send(WireRoutes.PropertyFilterability,
            Wire.EncodePropertyFilterabilityCommand(new(flag.Id, Guid.NewGuid(), owner.SchemaRevision, flag.Revision, true)), owner));
        var foreignField = await Create(stranger, "research", PropertyFieldKind.Text, selected.Id);
        foreignField = await EnableText(stranger, foreignField, true);

        const string prefix = "🙂 ";
        const string canonical = prefix + "Café orbit";
        const string input = prefix + "Cafe\u0301 orbit";
        const string phrase = "\"CAFÉ orbit\"";
        var cohort = new List<ArticleState>();
        for (var i = 0; i <= WireLimits.AuthorTextSearchRows; i++)
        {
            var article = await Save(owner, $"Property article {i}", "Independent body");
            cohort.Add(article);
            await Put(owner, article, selected, new PropertyFieldValue.Text(input));
        }
        await Put(owner, cohort[0], flag, new PropertyFieldValue.Boolean(true));
        var unrelated = await Save(owner, "Café orbit in the title", "Café orbit in the body");
        await Put(owner, unrelated, selected, new PropertyFieldValue.Text("Café distant orbit"));
        await Put(owner, unrelated, other, new PropertyFieldValue.Text(input));
        var foreign = await Save(stranger, "Foreign property article", "Independent body");
        await Put(stranger, foreign, foreignField, new PropertyFieldValue.Text(input));

        var query = Query(owner, selected, phrase);
        var pending = await Read(query, owner);
        Assert.False(pending.Ready);
        Assert.Empty(pending.Rows);
        Assert.Empty(pending.NextCursor);
        var first = await Ready(query, owner);
        Assert.Equal(cohort.Count, first.Total);
        Assert.Equal(new[] { cohort.Count, 0, 0, 0 }, first.StateCounts);
        Assert.Equal(WireLimits.AuthorTextSearchRows, first.Rows.Count);
        Assert.NotEmpty(first.NextCursor);
        var continuation = query with { Search = query.Search with { Cursor = first.NextCursor } };
        var second = await Read(continuation, owner);
        Assert.True(second.Ready);
        Assert.Equal(first.Total, second.Total);
        Assert.Empty(second.NextCursor);
        var last = Assert.Single(second.Rows);
        var rows = first.Rows.Append(last).ToArray();
        Assert.Equal(cohort.Select(article => article.Id).Order(), rows.Select(row => row.Id).Order());
        foreach (var row in rows)
        {
            Assert.Equal(5, row.Field);
            Assert.Equal("Café", row.Snippet[row.HighlightStart..row.HighlightEnd]);
            Assert.Equal((prefix.Length, prefix.Length + "Café".Length), (row.SourceStart, row.SourceEnd));
            Assert.Equal((Encoding.UTF8.GetByteCount(prefix), Encoding.UTF8.GetByteCount(prefix + "Café")),
                (row.SourceByteStart, row.SourceByteEnd));
            Assert.Equal(SHA256.HashData(Encoding.UTF8.GetBytes(canonical)), row.SourceDigest);
        }

        var filtered = query with
        {
            Search = query.Search with
            {
                Query = $"field.property:{phrase} status:draft",
                Conditions = [new(flag.Id, flag.Revision, PropertyComparison.Equal, new PropertyFieldValue.Boolean(true))],
            },
        };
        var filteredPage = await Ready(filtered, owner);
        Assert.Equal(1, filteredPage.Total);
        Assert.Equal(cohort[0].Id, Assert.Single(filteredPage.Rows).Id);
        Assert.Equal(unrelated.Id, Assert.Single((await Ready(Query(owner, other, phrase), owner)).Rows).Id);
        Assert.Equal(foreign.Id, Assert.Single((await Ready(Query(stranger, foreignField, phrase), stranger)).Rows).Id);
        await Reject(Query(owner, selected, "field.title:café"), owner, HttpStatusCode.BadRequest);
        await Reject(Query(owner, flag, phrase), owner, HttpStatusCode.NotFound);
        await Reject(continuation with { DefinitionId = other.Id, DefinitionRevision = other.Revision }, owner, HttpStatusCode.Conflict);

        var edited = Assert.Single(cohort, article => article.Id == last.Id);
        await Put(owner, edited, selected, new PropertyFieldValue.Text("Independently replaced"));
        await Reject(continuation, owner, HttpStatusCode.Conflict);
        var refreshed = await Ready(query, owner);
        Assert.Equal(cohort.Count - 1, refreshed.Total);
        Assert.DoesNotContain(refreshed.Rows, row => row.Id == last.Id);
        Assert.Empty(refreshed.NextCursor);

        selected = await EnableText(owner, selected, false);
        await Reject(Query(owner, selected, phrase), owner, HttpStatusCode.NotFound);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        await using var count = Store.Sql(db, null, "select count(*) from public.author_text_document where owner_id=$1", owner.Id);
        Assert.Equal(0L, Assert.IsType<long>(await count.ExecuteScalarAsync(ct)));

        static AuthorTextPropertyTextQuery Query(Actor actor, Field field, string text) =>
            new(new(text, "", null, null, actor.SchemaRevision, []), field.Id, field.Revision);

        async Task<AuthorTextFacetedPage> Ready(AuthorTextPropertyTextQuery request, Actor actor)
        {
            for (var i = 0; i < 8; i++)
            {
                var page = await Read(request, actor);
                if (page.Ready) return page;
                Assert.Empty(page.Rows);
                Assert.Empty(page.NextCursor);
            }
            throw new InvalidOperationException("The fixture property index did not finish within eight requests.");
        }

        async Task<AuthorTextFacetedPage> Read(AuthorTextPropertyTextQuery request, Actor actor) =>
            Wire.DecodeAuthorTextPropertyTextPage(await Send(WireRoutes.AuthorTextSearch, Wire.EncodeAuthorTextPropertyTextQuery(request), actor));

        Task<byte[]> Reject(AuthorTextPropertyTextQuery request, Actor actor, HttpStatusCode status) =>
            Send(WireRoutes.AuthorTextSearch, Wire.EncodeAuthorTextPropertyTextQuery(request), actor, status);

        async Task<byte[]> Send(string route, byte[] data, Actor actor, HttpStatusCode status = HttpStatusCode.OK)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, route) { Content = new ByteArrayContent(data) };
            request.Content.Headers.ContentType = new MediaTypeHeaderValue(Aeds.ContentType);
            request.Headers.Add("Cookie", $"fsus-v2-session={actor.Token}");
            request.Headers.Add(WireHeaders.CurrentSession, actor.Handle);
            using var response = await server.Client.SendAsync(request, ct);
            Assert.Equal(status, response.StatusCode);
            Assert.True(response.Headers.CacheControl?.NoStore);
            return await response.Content.ReadAsByteArrayAsync(ct);
        }

        async Task<Actor> Login(string name)
        {
            var id = Guid.NewGuid();
            var key = RandomNumberGenerator.GetBytes(32);
            await using var conn = await fixture.DataSource.OpenConnectionAsync(ct);
            await using (var user = Store.Sql(conn, null, "insert into public.blog_user(id,name,can_author,enabled,generation) values($1,$2,true,true,1)", id, name))
                await user.ExecuteNonQueryAsync(ct);
            await using (var ticket = Store.Sql(conn, null, "insert into public.login_ticket(digest,user_id,expires_at) values($1,$2,now()+interval '2 minutes')",
                SHA256.HashData(key), id))
                await ticket.ExecuteNonQueryAsync(ct);
            var token = (await store.SignIn(Convert.ToHexStringLower(key), ct)).Token;
            return new(id, token, SiteSessions.Id(id, Store.TokenDigest(token)!));
        }

        async Task<Field> Create(Actor actor, string key, PropertyFieldKind kind, Guid? id = null)
        {
            var field = new Field(id ?? Guid.NewGuid(), 0);
            var data = Wire.EncodePropertySchemaInput(new(new(1, field.Id, Guid.NewGuid(), actor.SchemaRevision, 0, key, key), kind, []));
            return Advance(actor, field, await Send(WireRoutes.PropertySchemaCommand, data, actor));
        }

        async Task<Field> EnableText(Actor actor, Field field, bool enabled)
        {
            var flags = Wire.EncodePropertyDefinitionProjectionCommand(new(field.Id, Guid.NewGuid(), actor.SchemaRevision, field.Revision, enabled, false));
            return Advance(actor, field, await Send(WireRoutes.PropertySchemaCommand, flags, actor));
        }

        async Task Put(Actor actor, ArticleState article, Field field, PropertyFieldValue value)
        {
            var prior = revisions.GetValueOrDefault(article.Id);
            var data = Wire.EncodePropertyValueInput(new(article.Id, article.Revision, actor.SchemaRevision, prior, field.Id, field.Revision, Guid.NewGuid(), value));
            var receipt = Wire.DecodePropertyCommandReceipt(await Send(WireRoutes.PropertyValueCommand, data, actor));
            Assert.Equal(new PropertyCommandReceipt(field.Id, actor.SchemaRevision, prior + 1), receipt);
            revisions[article.Id] = receipt.Revision;
        }

        async Task<ArticleState> Save(Actor actor, string title, string body) =>
            (await store.WithSession(actor.Token, true, (conn, tx, identity) =>
                Store.Execute(conn, tx, identity, ArticleAction.Save, new(0, 0, Guid.NewGuid(), title, body), ct), ct)).Article;
    }

    private static Field Advance(Actor actor, Field field, byte[] data)
    {
        var receipt = Wire.DecodePropertyCommandReceipt(data);
        Assert.Equal(new PropertyCommandReceipt(field.Id, actor.SchemaRevision + 1, field.Revision + 1), receipt);
        actor.SchemaRevision = receipt.SchemaRevision;
        return field with { Revision = receipt.Revision };
    }

    private sealed record Field(Guid Id, long Revision);
    private sealed record Actor(Guid Id, string Token, string Handle)
    {
        internal long SchemaRevision { get; set; }
    }
}
