using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;

namespace FsusBlog.V2.Integration.Tests;

public sealed class PropertyQueryPostgresTests
{
    [PostgresFact]
    public async Task ExactOwnedFiltersRejectDisabledFieldsAndKeepDistinctValueStates()
    {
        using var stop = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = stop.Token;
        await using var db = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        var store = new Store(db.DataSource);
        var owner = await SignIn("First owner");
        var outsider = await SignIn("Second owner");
        await using var server = await ServerProcess.Start(db.ConnectionString, ct);
        var primary = await Article("Match", owner);
        var empty = await Article("Empty", owner);
        var missing = await Article("Missing", owner);
        var foreign = await Article("Other owner", outsider);
        var target = await Article("Reference target", owner);
        target = (await store.WithSession(owner, true, (c, t, a) => Store.Execute(c, t, a, ArticleAction.Publish,
            new(target.Id, target.Revision, Guid.NewGuid(), "", ""), ct), ct)).Article;
        var options = new[] { new PropertyFieldOption(Guid.NewGuid(), "Red"), new PropertyFieldOption(Guid.NewGuid(), "Blue") };
        long schema = 0;
        var definitions = new[]
        {
            (PropertyFieldKind.Text, (PropertyFieldValue)new PropertyFieldValue.Text(""), (PropertyFieldValue)new PropertyFieldValue.Null()),
            (PropertyFieldKind.Number, new PropertyFieldValue.Number(9007199254740993.1234567m), new PropertyFieldValue.Number(0)),
            (PropertyFieldKind.Boolean, new PropertyFieldValue.Boolean(false), new PropertyFieldValue.Boolean(true)),
            (PropertyFieldKind.Date, new PropertyFieldValue.Date(DateTimeOffset.FromUnixTimeMilliseconds(1794669740123)), new PropertyFieldValue.Null()),
            (PropertyFieldKind.SingleSelect, new PropertyFieldValue.SingleSelect(options[0].Id), new PropertyFieldValue.SingleSelect(options[1].Id)),
            (PropertyFieldKind.MultiSelect, new PropertyFieldValue.MultiSelect([]), new PropertyFieldValue.MultiSelect([options[0].Id])),
            (PropertyFieldKind.ArticleReference, new PropertyFieldValue.ArticleReference([target.Id]), new PropertyFieldValue.Null()),
            (PropertyFieldKind.Url, new PropertyFieldValue.Url("https://example.net/guide"), new PropertyFieldValue.Null()),
        };
        var fields = new List<Guid>();
        foreach (var (kind, _, _) in definitions)
        {
            var id = Guid.NewGuid();
            var choice = kind is PropertyFieldKind.SingleSelect or PropertyFieldKind.MultiSelect;
            await Send(WireRoutes.PropertySchemaCommand, Wire.EncodePropertySchemaInput(new(
                new(1, id, Guid.NewGuid(), schema++, 0, $"property-{fields.Count}", $"Field {fields.Count}"), kind, choice ? options : [])), owner);
            fields.Add(id);
        }
        var disabled = new PropertyArticleQuery(schema, fields[0], 1, new PropertyFieldValue.Missing(), "");
        await Send(WireRoutes.PropertyArticleQuery, Wire.EncodePropertyArticleQuery(disabled), owner, HttpStatusCode.NotFound);
        var outsiderFrame = Wire.EncodePropertyArticleQuery(disabled);
        await Send(WireRoutes.PropertyArticleQuery, outsiderFrame, null, HttpStatusCode.Unauthorized);
        await Send(WireRoutes.PropertyArticleQuery, outsiderFrame, outsider, HttpStatusCode.Conflict);

        for (var i = 0; i < fields.Count; i++)
        {
            await Put(primary, fields[i], definitions[i].Item2, i, 1);
            await Put(empty, fields[i], definitions[i].Item3, i, 1);
        }
        for (var i = 0; i < fields.Count; i++)
        {
            var toggle = Wire.EncodePropertyFilterabilityCommand(new(fields[i], Guid.NewGuid(), schema++, 1, true));
            var first = await Send(WireRoutes.PropertyFilterability, toggle, owner);
            Assert.Equal(first, await Send(WireRoutes.PropertyFilterability, toggle, owner));
        }
        var catalog = Wire.DecodePropertyFilterCatalog(await Send(WireRoutes.PropertyFilterCatalog, null, owner));
        Assert.Equal(schema, catalog.SchemaRevision);
        Assert.All(catalog.Fields, field => Assert.True(field.Enabled && !field.Deprecated));
        for (var i = 0; i < fields.Count; i++)
        {
            Assert.Equal(primary.Id, Assert.Single((await Filter(i, definitions[i].Item2)).Rows).Id);
            Assert.Contains((await Filter(i, new PropertyFieldValue.Missing())).Rows, row => row.Id == missing.Id);
            Assert.DoesNotContain((await Filter(i, new PropertyFieldValue.Missing())).Rows, row => row.Id == foreign.Id);
        }
        Assert.Equal(empty.Id, Assert.Single((await Filter(0, new PropertyFieldValue.Null())).Rows).Id);
        Assert.Empty((await Filter(1, new PropertyFieldValue.Number(9007199254740993.1234568m))).Rows);
        await Filter(1, new PropertyFieldValue.Text("0"), HttpStatusCode.BadRequest);

        for (var i = 0; i < WireLimits.PropertyPageSize; i++)
        {
            var article = await Article($"Number page {i}", owner);
            await Put(article, fields[1], definitions[1].Item2, 0, 2);
        }
        var firstPage = await Filter(1, definitions[1].Item2);
        Assert.Equal(WireLimits.PropertyPageSize, firstPage.Rows.Count);
        Assert.NotEmpty(firstPage.NextCursor);
        Assert.Equal(primary.Id, Assert.Single((await Filter(1, definitions[1].Item2, cursor: firstPage.NextCursor)).Rows).Id);
        await Filter(1, new PropertyFieldValue.Number(0), HttpStatusCode.BadRequest, firstPage.NextCursor);
        await Filter(1, definitions[1].Item2, HttpStatusCode.BadRequest,
            (firstPage.NextCursor[0] == 'A' ? "B" : "A") + firstPage.NextCursor[1..]);

        await store.WithSession(owner, true, (c, t, a) => Store.Execute(c, t, a, ArticleAction.Retract,
            new(target.Id, target.Revision, Guid.NewGuid(), "", ""), ct), ct);
        await Filter(6, definitions[6].Item2, HttpStatusCode.NotFound);
        await Send(WireRoutes.PropertyFilterability, Wire.EncodePropertyFilterabilityCommand(new(fields[1], Guid.NewGuid(), schema, 2, false)), owner);
        await Filter(1, definitions[1].Item2, HttpStatusCode.Conflict, firstPage.NextCursor);
        schema++;
        await Send(WireRoutes.PropertyArticleQuery, Wire.EncodePropertyArticleQuery(new(schema, fields[1], 3,
            new PropertyFieldValue.Missing(), "")), owner, HttpStatusCode.NotFound);

        async Task<PropertyArticlePage> Filter(int index, PropertyFieldValue value, HttpStatusCode status = HttpStatusCode.OK, string cursor = "")
        {
            var packet = await Send(WireRoutes.PropertyArticleQuery, Wire.EncodePropertyArticleQuery(new(schema, fields[index], 2, value, cursor)), owner, status);
            return status == HttpStatusCode.OK ? Wire.DecodePropertyArticlePage(packet) : new("", []);
        }
        Task<byte[]> Put(ArticleState article, Guid field, PropertyFieldValue value, long version, long definition) =>
            Send(WireRoutes.PropertyValueCommand, Wire.EncodePropertyValueInput(new(article.Id, article.Revision, schema, version,
                field, definition, Guid.NewGuid(), value)), owner);
        async Task<ArticleState> Article(string title, string token) => (await store.WithSession(token, true, (c, t, a) =>
            Store.Execute(c, t, a, ArticleAction.Save, new(0, 0, Guid.NewGuid(), title, "Private"), ct), ct)).Article;
        async Task<string> SignIn(string name)
        {
            var id = Guid.NewGuid();
            var key = RandomNumberGenerator.GetBytes(32);
            await using var conn = await db.DataSource.OpenConnectionAsync(ct);
            await using (var create = Store.Sql(conn, null, "insert into public.blog_user values($1,$2,true,true,1)", id, name))
                await create.ExecuteNonQueryAsync(ct);
            await using var ticket = Store.Sql(conn, null, "insert into public.login_ticket values($1,$2,now()+interval '2 minutes')", SHA256.HashData(key), id);
            await ticket.ExecuteNonQueryAsync(ct);
            return (await store.SignIn(Convert.ToHexStringLower(key), ct)).Token;
        }
        async Task<byte[]> Send(string route, byte[]? packet, string? session, HttpStatusCode status = HttpStatusCode.OK)
        {
            using var request = new HttpRequestMessage(packet is null ? HttpMethod.Get : HttpMethod.Post, route);
            if (packet is not null)
            {
                request.Content = new ByteArrayContent(packet);
                request.Content.Headers.ContentType = new MediaTypeHeaderValue(Aeds.ContentType);
            }
            if (session is not null) request.Headers.Add("Cookie", $"fsus-v2-session={session}");
            using var result = await server.Client.SendAsync(request, ct);
            Assert.Equal(status, result.StatusCode);
            Assert.True(result.Headers.CacheControl?.NoStore);
            return await result.Content.ReadAsByteArrayAsync(ct);
        }
    }
}
