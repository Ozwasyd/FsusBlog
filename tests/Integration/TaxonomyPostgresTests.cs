using System.Buffers.Binary;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Integration.Tests;
using FsusBlog.V2.Server;
using Microsoft.Extensions.Logging.Abstractions;
using Npgsql;

public sealed class TaxonomyPostgresTests
{
    [PostgresFact]
    public async Task PublishedRevisionDeterminesCountsFilteredFramesAndCanonicalPages()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        var store = new Store(fixture.DataSource);
        var publications = new Publications(fixture.DataSource, new WebPages("<main><!--fsus-public-content--></main>"), NullLogger<Publications>.Instance);
        var user = Guid.NewGuid();
        var ticket = RandomNumberGenerator.GetBytes(32);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        await Execute("insert into public.blog_user(id,name,can_author,enabled,generation) values($1,'fixture writer',true,true,1)", user);
        await Execute("insert into public.login_ticket(digest,user_id,expires_at) values($1,$2,now()+interval '2 minutes')", SHA256.HashData(ticket), user);
        await Execute("""
            insert into public.category(id,name,description) values(1,'Tech & Robots','<taxonomy description>'),(2,'Empty',null);
            insert into public.tag(id,name,description) values(4,'Café',null);
            insert into public.tag_url_name values('ANCIENNE',4);
            """);
        var actor = await store.SignIn(Convert.ToHexStringLower(ticket), ct);

        var first = await Save("Taxonomy article one");
        var second = await Save("Taxonomy article two");
        var hidden = await Save("private taxonomy item");
        foreach (var row in new[] { first, second, hidden })
            await Execute("insert into public.article_revision_category values($1,$2,1)", row.Id, row.Revision);
        await Execute("insert into public.article_revision_tag values($1,$2,4)", first.Id, first.Revision);
        await Execute("insert into public.article_revision_tag values($1,$2,4)", hidden.Id, hidden.Revision);
        var posted = await Publish(first);
        await Publish(second);

        // A later private draft must not change the public links or their generation.
        var draft = (await publications.Command(store, actor.Token, ArticleAction.Save,
            new(first.Id, posted.Revision, Guid.NewGuid(), "private rewrite", "draft content"), ct)).Article;
        await Execute("update public.article_revision_category set category_id=2 where article_id=$1 and revision=$2", first.Id, draft.Revision);
        await Execute("delete from public.article_revision_tag where article_id=$1 and revision=$2", first.Id, draft.Revision);

        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);
        var client = server.Client;
        Assert.Equal(new[] { (1, 2), (2, 0) }, ReadCounts(await GetFrame(WireRoutes.CategoryList, FrameType.CategoryList)));
        Assert.Equal(new[] { (4, 1) }, ReadCounts(await GetFrame(WireRoutes.TagList, FrameType.TagList)));
        var exact = await GetFrame("/api/binary/tag/4.aeds", FrameType.TaxonomyExactMetadata);
        Assert.Equal(4, ReadInt(exact, 0));
        Assert.Equal("Café", Encoding.UTF8.GetString(exact, 8, ReadInt(exact, 4)));
        Assert.Equal(exact, await GetFrame("/api/binary/tag/by-name.aeds?name=ancienne", FrameType.TaxonomyExactMetadata));
        Assert.Equal(exact, await GetFrame("/api/binary/tag/by-name.aeds?name=cafe%CC%81", FrameType.TaxonomyExactMetadata));

        foreach (var name in new[] { "ancienne", "cafe%CC%81" })
        {
            using var redirect = await client.GetAsync($"/tag/{name}?q=1", ct);
            Assert.Equal(HttpStatusCode.MovedPermanently, redirect.StatusCode);
            Assert.Equal("/tag/4?q=1", redirect.Headers.Location?.OriginalString);
        }
        using var missing = await client.GetAsync("/tag/unknown-name", ct);
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
        using var html = await client.GetAsync("/category/1", ct);
        Assert.Equal(HttpStatusCode.OK, html.StatusCode);
        var body = await html.Content.ReadAsStringAsync(ct);
        Assert.Contains("Tech &amp; Robots", body);
        Assert.Contains("&lt;taxonomy description&gt;", body);
        Assert.Contains("Taxonomy article one", body);
        Assert.DoesNotContain("private", body);
        using var headRequest = new HttpRequestMessage(HttpMethod.Head, "/tag/4");
        using var head = await client.SendAsync(headRequest, ct);
        Assert.Equal(HttpStatusCode.OK, head.StatusCode);
        Assert.Empty(await head.Content.ReadAsByteArrayAsync(ct));

        var categoryPage = await GetFrame("/api/binary/article/list/category/1/1/1.aeds", FrameType.ArticleList);
        Assert.Equal(2, ReadInt(categoryPage, WireLayouts.ArticleListTotalOffset));
        var cursor = Encoding.ASCII.GetString(categoryPage, WireLayouts.ArticleListCursorOffset,
            ReadInt(categoryPage, WireLayouts.ArticleListCursorLengthOffset));
        Assert.NotEmpty(cursor);
        var tagPage = await GetFrame("/api/binary/article/list/tag/4/1/10.aeds", FrameType.ArticleList);
        var records = WireLayouts.ArticleListCursorOffset + 12 + ReadInt(tagPage, WireLayouts.ArticleListCursorOffset + 8);
        Assert.Equal(first.Id, ReadInt(tagPage, records + WireLayouts.ArticleIdOffset));
        Assert.Equal(1, ReadInt(tagPage, records + WireLayouts.ArticleCategoryIdOffset));
        Assert.Equal(1, ReadInt(tagPage, records + WireLayouts.ArticleListTagCountOffset));
        Assert.Equal(4, ReadInt(tagPage, records + WireLayouts.ArticleListRecordSizeCurrent));
        await GetFrame($"/api/binary/article/list/tag/4/2/1.aeds?cursor={cursor}", FrameType.ApiError, HttpStatusCode.BadRequest);
        await GetFrame($"/api/binary/article/list/category/1/2/1.aeds?cursor={cursor}", FrameType.ArticleList);

        using var retract = new HttpRequestMessage(HttpMethod.Post, WireRoutes.Retract);
        retract.Headers.Add("Cookie", $"fsus-v2-session={actor.Token}");
        retract.Content = new ByteArrayContent(Wire.EncodeArticleCommand(new(first.Id, draft.Revision, Guid.NewGuid(), "", "")));
        retract.Content.Headers.ContentType = new("application/octet-stream");
        using var response = await client.SendAsync(retract, ct);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(new[] { (4, 0) }, ReadCounts(await GetFrame(WireRoutes.TagList, FrameType.TagList)));
        Assert.Equal(new[] { (1, 1), (2, 0) }, ReadCounts(await GetFrame(WireRoutes.CategoryList, FrameType.CategoryList)));
        await GetFrame($"/api/binary/article/list/category/1/2/1.aeds?cursor={cursor}", FrameType.ApiError, HttpStatusCode.BadRequest);

        async Task Execute(string sql, params object[] values)
        {
            await using var command = Store.Sql(db, null, sql, values);
            await command.ExecuteNonQueryAsync(ct);
        }

        async Task<ArticleState> Save(string title) => (await publications.Command(store, actor.Token, ArticleAction.Save,
            new(0, 0, Guid.NewGuid(), title, "article body"), ct)).Article;

        async Task<ArticleState> Publish(ArticleState row) => (await publications.Command(store, actor.Token, ArticleAction.Publish,
            new(row.Id, row.Revision, Guid.NewGuid(), "", ""), ct)).Article;

        async Task<byte[]> GetFrame(string path, FrameType expected, HttpStatusCode status = HttpStatusCode.OK)
        {
            using var packet = await client.GetAsync(path, ct);
            Assert.Equal(status, packet.StatusCode);
            Assert.Equal("application/octet-stream", packet.Content.Headers.ContentType?.MediaType);
            return Aeds.Decode(await packet.Content.ReadAsByteArrayAsync(ct), expected).ToArray();
        }
    }

    private static (int Id, int Count)[] ReadCounts(byte[] payload)
    {
        var records = 8 + ReadInt(payload, 4);
        return Enumerable.Range(0, ReadInt(payload, 0)).Select(index =>
            (ReadInt(payload, records + index * 16), ReadInt(payload, records + index * 16 + 4))).ToArray();
    }

    private static int ReadInt(byte[] data, int offset) => BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(offset));
}
