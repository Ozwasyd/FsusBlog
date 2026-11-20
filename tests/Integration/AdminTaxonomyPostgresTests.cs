using System.Buffers.Binary;
using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Administration;
using FsusBlog.V2.Server.Passkeys;
using FsusBlogV2.Storage;
using Microsoft.AspNetCore.Http;

namespace FsusBlog.V2.Integration.Tests;

public sealed class AdminTaxonomyPostgresTests
{
    [PostgresFact]
    public async Task AdminTaxonomyReportsPublishedAndRetainedRevisionCoordinatesWithIndependentPermission()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var (admin, adminToken, _) = await FixtureSql.AdminAsync(db, ct, "taxonomy-reviewer", 10, [1], [2]);
        var author = Guid.NewGuid();
        var ticket = Secret();
        await Sql("insert into public.blog_user (id,name,enabled,generation) values($1,'taxonomy-fixture-reader',true,1)", author);
        await Sql("insert into public.login_ticket values($1,$2,clock_timestamp()+interval '5 minutes')", Store.TokenDigest(ticket)!, author);
        await Sql("insert into public.category(id,name) select id,'Category '||id from generate_series(1,26) id");
        await Sql("insert into public.tag(id,name) values(1,'Tag primary'),(2,'Tag private'),(3,'Tag historical')");
        await Sql("insert into public.tag_url_name values('OLDER HISTORICAL TAG',3)");

        var store = new Store(fixture.DataSource);
        var token = (await store.SignIn(ticket, ct)).Token;
        var (_, authorToken, _) = await fixture.SignIn("taxonomy-fixture-writer", ct);
        var publications = PublicationFixture.Project(fixture.DataSource);
        var published = await Publish(await Draft("Public article", 1, 1));
        var alternate = await Assign(published, 2, 2);
        await Schedule(alternate);
        await Draft("Draft marker stays private", 1, 1);
        var retracted = await Publish(await Draft("Retracted article", 1, 1));
        await Change(ArticleAction.Retract, retracted.Id, retracted.Revision);
        var deleted = await Draft("Deleted draft", 1, 1);
        await Change(ArticleAction.Delete, deleted.Id, deleted.Revision);
        var historical = await Draft("Historical only on category 1", 1, 3);
        await Assign(historical, 2, 2);
        var mainPublication = await Publish(await Draft("Entirely public on category 1", 1, 1));
        await Schedule(mainPublication);

        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct, new Dictionary<string, string>
        {
            ["FSUSBLOG_ADMIN_ORIGIN"] = "http://localhost", ["FSUSBLOG_ADMIN_RP_ID"] = "localhost"
        });
        await Get(WireRoutes.AdminCategories, HttpStatusCode.NotFound, adminToken, adminHost: false);
        await Get(WireRoutes.AdminCategories, HttpStatusCode.Unauthorized, token, siteCookie: true);
        var categoryDependencies = WireRoutes.AdminCategories + "?dependency=";
        var tagDependencies = WireRoutes.AdminTags + "?dependency=";
        await Get(categoryDependencies + "1", HttpStatusCode.NotFound, adminToken, adminHost: false);
        await Get(categoryDependencies + "1", HttpStatusCode.Unauthorized, token, siteCookie: true);
        await Get(WireRoutes.AdminCategories + "?after=1&after=2", HttpStatusCode.BadRequest, adminToken);
        await Get(WireRoutes.AdminCategories + "?after=%2B1", HttpStatusCode.BadRequest, adminToken);
        foreach (var invalid in new[] { "0", "%2B1", "2147483648", "1&after=1", "1&dependency=2" })
            await Get(categoryDependencies + invalid, HttpStatusCode.BadRequest, adminToken);
        await Get(tagDependencies + "999", HttpStatusCode.NotFound, adminToken);

        var page = Decode(await Get(WireRoutes.AdminCategories, HttpStatusCode.OK, adminToken));
        Assert.Equal(24, page.NextId);
        Assert.Equal(Enumerable.Range(1, 24), page.Items.Select(item => item.Id));
        Assert.Equal(new AdminTaxonomyItem(1, "Category 1", 2, 1, 1, 1, 1, 6), page.Items[0]);
        Assert.Equal(new AdminTaxonomyItem(2, "Category 2", 0, 1, 1, 0, 0, 2), page.Items[1]);
        var tail = Decode(await Get(WireRoutes.AdminCategories + "?after=24", HttpStatusCode.OK, adminToken));
        Assert.Equal(0, tail.NextId);
        Assert.Equal([25, 26], tail.Items.Select(item => item.Id));
        Assert.Empty(Decode(await Get(WireRoutes.AdminCategories + "?after=26", HttpStatusCode.OK, adminToken)).Items);
        var tags = Decode(await Get(WireRoutes.AdminTags, HttpStatusCode.OK, adminToken));
        Assert.Equal(new AdminTaxonomyItem(1, "Tag primary", 2, 1, 1, 1, 1, 5), tags.Items[0]);
        Assert.Equal(new AdminTaxonomyItem(3, "Tag historical", 0, 0, 0, 0, 0, 1), tags.Items[2]);
        Assert.Equal(new AdminTaxonomyDependencies(1, 4, 2, 0), await Dependencies(categoryDependencies + "1"));
        Assert.Equal(new AdminTaxonomyDependencies(26, 0, 0, 0), await Dependencies(categoryDependencies + "26"));
        Assert.Equal(new AdminTaxonomyDependencies(1, 4, 1, 0), await Dependencies(tagDependencies + "1"));
        Assert.Equal(new AdminTaxonomyDependencies(3, 0, 1, 1), await Dependencies(tagDependencies + "3"));

        // This deliberately held projection instance cannot combine a newer durable public write with older released counts.
        var direct = new AdminTaxonomyStore(new AdminSessionGate(fixture.DataSource, null));
        await Sql("insert into public.blog_outbox(article_id,revision,kind) values($1,$2,'publish')", published.Id, published.Revision);
        await Assert.ThrowsAsync<PublicUnavailableException>(() => direct.Taxonomy(adminToken, false, QueryCollection.Empty, publications, ct));
        await Sql("update public.admin_principal set generation=generation+1 where id=$1", admin);
        await Get(WireRoutes.AdminTags, HttpStatusCode.Unauthorized, adminToken);
        await Get(tagDependencies + "3", HttpStatusCode.Unauthorized, adminToken);

        async Task<AdminTaxonomyDependencies> Dependencies(string path)
        {
            var frame = await Get(path, HttpStatusCode.OK, adminToken);
            var data = Aeds.Decode(frame, FrameType.AdminTaxonomyDependencies);
            Assert.Equal(16, data.Length);
            return new(BinaryPrimitives.ReadInt32LittleEndian(data),
                BinaryPrimitives.ReadInt32LittleEndian(data[4..]), BinaryPrimitives.ReadInt32LittleEndian(data[8..]),
                BinaryPrimitives.ReadInt32LittleEndian(data[12..]));
        }

        Task<ArticleState> Publish(ArticleState draft) => Change(ArticleAction.Publish, draft.Id, draft.Revision);

        async Task<ArticleState> Draft(string title, int category, int tag) =>
            await Assign(await Change(ArticleAction.Save, 0, 0, title), category, tag);

        async Task<ArticleState> Assign(ArticleState draft, int category, int tag)
        {
            var assigned = await store.WithSession(authorToken, true, (conn, tx, actor) => Store.AssignTaxonomy(conn, tx, actor,
                new TaxonomyAssignment(draft.Id, draft.Revision, Guid.NewGuid(), category, [tag]), ct), ct);
            return draft with { Revision = assigned.Revision };
        }

        async Task<ArticleState> Schedule(ArticleState draft)
        {
            var scheduled = await store.WithSession(authorToken, true, (conn, tx, actor) => Store.Schedule(conn, tx, actor,
                new(draft.Id, draft.Revision, Guid.NewGuid(), DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeMilliseconds()), ct), ct);
            return draft with { Revision = scheduled.Revision };
        }

        async Task<ArticleState> Change(ArticleAction action, int id, long revision, string title = "") =>
            (await publications.Command(store, authorToken, action, new(id, revision, Guid.NewGuid(), title,
                action == ArticleAction.Save ? "Taxonomy fixtures retain article content" : ""), ct)).Article;

        Task Sql(string sql, params object[] args) =>
            FixtureSql.ExecuteAsync(db, null, ct, sql, args);

        async Task<byte[]> Get(string path, HttpStatusCode expected, string secret, bool adminHost = true, bool siteCookie = false)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, path);
            if (adminHost) request.Headers.Host = "localhost";
            request.Headers.Add("Cookie", $"{(siteCookie ? "fsus-v2-session" : "fsus-v2-admin-session")}={secret}");
            using var response = await server.Client.SendAsync(request, ct);
            Assert.Equal(expected, response.StatusCode);
            Assert.True(response.Headers.CacheControl?.NoStore);
            var bytes = await response.Content.ReadAsByteArrayAsync(ct);
            if (response.IsSuccessStatusCode)
                Assert.False(bytes.AsSpan().IndexOf("Draft marker stays private"u8) >= 0);
            return bytes;
        }
    }

    private static string Secret() => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));

    private static AdminTaxonomyPage Decode(byte[] frame)
    {
        using var stream = new MemoryStream(Aeds.Decode(frame, FrameType.AdminTaxonomyPage).ToArray());
        using var read = new BinaryReader(stream);
        var next = read.ReadInt32();
        var count = read.ReadInt32();
        var items = new List<AdminTaxonomyItem>(count);
        for (var index = 0; index < count; index++)
        {
            var id = read.ReadInt32();
            var name = Encoding.UTF8.GetString(read.ReadBytes(read.ReadInt32()));
            items.Add(new(id, name, read.ReadInt32(), read.ReadInt32(), read.ReadInt32(), read.ReadInt32(), read.ReadInt32(), read.ReadInt32()));
        }
        Assert.Equal(stream.Length, stream.Position);
        return new(next, items);
    }
}
