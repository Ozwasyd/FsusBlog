using System.Net;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Integration.Tests;
using FsusBlog.V2.Server;
using Npgsql;

public sealed class AuthorArticleInventoryPostgresTests
{
    [PostgresFact]
    public async Task InventoryPagesRevealOnlyCurrentOwnerRowsAndHideDeletedDrafts()
    {
        await using var db = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(45));
        var store = new Store(db.DataSource);
        var owner = await Login("inventory-owner", true);
        var other = await Login("inventory-other", true);
        var reader = await Login("inventory-reader", false);
        await using var catalog = await db.DataSource.OpenConnectionAsync(ct);
        await using (var insert = Store.Sql(catalog, null, """
            insert into public.category (id,name) values(41,'Author category');
            insert into public.tag (id,name) values(81,'Author tag');
            """)) await insert.ExecuteNonQueryAsync(ct);
        await using var server = await ServerProcess.Start(db.ConnectionString, ct);
        var client = server.Client;
        const string sensitive = "BODY_MUST_NOT_BE_IN_THE_LIST";
        const string summaryTerm = "SummaryTerm";
        var published = await Write(owner, WireRoutes.Save, new(0, 0, Guid.NewGuid(), "State Published", sensitive));
        var sent = await POST(owner, WireRoutes.TaxonomyAssignment,
            Wire.EncodeTaxonomyAssignment(new(published.Id, published.Revision, Guid.NewGuid(), 41, [81])));
        var tagged = Wire.DecodeDraftTaxonomy(sent);
        await Write(owner, WireRoutes.Publish, new(tagged.Id, tagged.Revision, Guid.NewGuid(), "", ""));
        var hidden = await Write(owner, WireRoutes.Save, new(0, 0, Guid.NewGuid(), "State Retracted", sensitive));
        var ever = await Write(owner, WireRoutes.Publish, new(hidden.Id, hidden.Revision, Guid.NewGuid(), "", ""));
        await Write(owner, WireRoutes.Retract, new(ever.Id, ever.Revision, Guid.NewGuid(), "", ""));
        var trash = await Write(owner, WireRoutes.Save, new(0, 0, Guid.NewGuid(), "Owner Trash", $"{summaryTerm} {sensitive}"));
        await POST(owner, WireRoutes.Delete, Wire.EncodeArticleCommand(new(trash.Id, trash.Revision, Guid.NewGuid(), "", "")));
        var otherDraft = await Write(other, WireRoutes.Save, new(0, 0, Guid.NewGuid(), "Other Private", $"{summaryTerm} {sensitive}"));
        await POST(other, WireRoutes.Delete, Wire.EncodeArticleCommand(new(otherDraft.Id, otherDraft.Revision, Guid.NewGuid(), "", "")));
        var prefix = string.Concat(Enumerable.Repeat("😀", 200 - summaryTerm.Length));
        var summaryOnly = await Write(owner, WireRoutes.Save, new(0, 0, Guid.NewGuid(), "Inventory source 0", $"{prefix}{summaryTerm}{sensitive}"));
        var beyondSummary = await Write(owner, WireRoutes.Save, new(0, 0, Guid.NewGuid(), "Inventory source 1", $"{prefix}a{summaryTerm}{sensitive}"));
        for (var i = 2; i < 21; i++) await Write(owner, WireRoutes.Save, new(0, 0, Guid.NewGuid(), $"Inventory source {i}", sensitive));
        var scheduled = await Write(owner, WireRoutes.Save, new(0, 0, Guid.NewGuid(), "State Scheduled", sensitive));
        var due = DateTimeOffset.UtcNow.AddHours(2).ToUnixTimeMilliseconds();
        await POST(owner, WireRoutes.DraftScheduleCommand, Wire.EncodeArticleScheduleCommand(new(scheduled.Id, scheduled.Revision, Guid.NewGuid(), due)));

        using (var shell = await client.GetAsync("/user/manage/article/list", ct))
        {
            Assert.Equal(HttpStatusCode.OK, shell.StatusCode);
            Assert.Equal("noindex, nofollow", Assert.Single(shell.Headers.GetValues("X-Robots-Tag")));
            Assert.DoesNotContain("State Published", await shell.Content.ReadAsStringAsync(ct));
        }
        await Failure(null, "?scope=active", HttpStatusCode.Unauthorized);
        await Failure(reader, "?scope=trash", HttpStatusCode.Forbidden);
        await Failure(owner, "?scope=trash&state=published", HttpStatusCode.BadRequest);
        await Failure(owner, "?category=0", HttpStatusCode.BadRequest);
        await Failure(owner, "?before=1&before=2", HttpStatusCode.BadRequest);
        await Failure(owner, "?keyword=%00", HttpStatusCode.BadRequest);
        await Failure(owner, "?match=full-text", HttpStatusCode.BadRequest);
        await Failure(owner, "?match=title&match=title-summary", HttpStatusCode.BadRequest);
        var first = await Page(owner, "?scope=active");
        Assert.Equal(24, first.Total);
        Assert.Equal(20, first.Rows.Count);
        Assert.Equal(first.Rows[^1].Id, first.Next);
        var second = await Page(owner, $"?scope=active&before={first.Next}");
        Assert.Equal(24, second.Total);
        Assert.Equal(0, second.Next);
        Assert.Equal(4, second.Rows.Count);
        Assert.DoesNotContain(second.Rows, row => first.Rows.Any(previous => previous.Id == row.Id));
        var filter = Assert.Single((await Page(owner, "?scope=active&keyword=STATE%20PUB&category=41&tag=81&state=published")).Rows);
        Assert.Equal(published.Id, filter.Id);
        Assert.Equal(41, filter.Category?.Id);
        Assert.Equal(81, Assert.Single(filter.Tags).Id);
        Assert.Empty((await Page(owner, "?keyword=%25")).Rows);
        const string bySummary = "match=title-summary&keyword=summaryterm";
        Assert.Empty((await Page(owner, "?keyword=summaryterm")).Rows);
        Assert.Empty((await Page(owner, "?match=title&keyword=summaryterm")).Rows);
        Assert.Equal(summaryOnly.Id, Assert.Single((await Page(owner, $"?{bySummary}&state=draft")).Rows).Id);
        Assert.Empty((await Page(owner, $"?{bySummary}&article={beyondSummary.Id}")).Rows);
        Assert.Equal(trash.Id, Assert.Single((await Page(owner, $"?scope=trash&{bySummary}")).Rows).Id);
        Assert.Equal(otherDraft.Id, Assert.Single((await Page(other, $"?scope=trash&{bySummary}")).Rows).Id);
        Assert.Empty((await Page(other, $"?{bySummary}&article={summaryOnly.Id}")).Rows);
        Assert.Equal(AuthorArticleState.Retracted, Assert.Single((await Page(owner, "?state=retracted")).Rows).State);
        Assert.Equal(due, Assert.Single((await Page(owner, "?state=scheduled")).Rows).ScheduledUnixMs);
        Assert.Equal(trash.Id, Assert.Single((await Page(owner, "?scope=trash")).Rows).Id);
        Assert.Equal(otherDraft.Id, Assert.Single((await Page(other, "?scope=trash")).Rows).Id);
        Assert.Empty((await Page(other, "?scope=active")).Rows);
        Assert.Empty((await Page(other, $"?scope=trash&before={first.Next}&keyword=Owner")).Rows);
        using var draftRequest = SiteAedsFixture.Request(HttpMethod.Get, WireRoutes.Draft.Replace("{id:int}", trash.Id.ToString()),
            frame: null, owner, handle: null);
        using var deleted = await client.SendAsync(draftRequest, ct);
        Assert.Equal(HttpStatusCode.NotFound, deleted.StatusCode);
        await store.SignOut(owner, ct);
        await Failure(owner, "?scope=trash", HttpStatusCode.Unauthorized);

        async Task<string> Login(string name, bool author) => (await db.SignIn(name, ct, author, minutes: 1)).Token;

        async Task<Draft> Write(string token, string route, ArticleCommand command) =>
            Wire.DecodeDraft(await POST(token, route, Wire.EncodeArticleCommand(command)));

        async Task<byte[]> POST(string token, string route, byte[] body)
        {
            using var message = SiteAedsFixture.Request(HttpMethod.Post, route, body, token, handle: null);
            using var response = await client.SendAsync(message, ct);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            return await response.Content.ReadAsByteArrayAsync(ct);
        }

        async Task Failure(string? token, string query, HttpStatusCode expected)
        {
            using var response = await GET(token, query);
            Assert.Equal(expected, response.StatusCode);
            Assert.True(response.Headers.CacheControl!.NoStore);
            Assert.Equal(FrameType.ApiError, ReadFrameType(await response.Content.ReadAsByteArrayAsync(ct)));
        }

        async Task<(int Total, int Next, IReadOnlyList<AuthorArticleRow> Rows)> Page(string token, string query)
        {
            using var response = await GET(token, query);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.True(response.Headers.CacheControl!.NoStore);
            var bytes = await response.Content.ReadAsByteArrayAsync(ct);
            var payload = System.Text.Encoding.UTF8.GetString(bytes);
            Assert.DoesNotContain(sensitive, payload);
            Assert.DoesNotContain(summaryTerm, payload);
            return Decode(bytes);
        }

        Task<HttpResponseMessage> GET(string? token, string query) =>
            SiteAedsFixture.Send(client, HttpMethod.Get, WireRoutes.AuthorArticles + query, null, token, null, ct);
    }

    private static FrameType ReadFrameType(byte[] bytes)
    {
        Aeds.Decode(bytes, out var type);
        return type;
    }

    private static (int, int, IReadOnlyList<AuthorArticleRow>) Decode(byte[] frame)
    {
        using var buffer = new MemoryStream(Aeds.Decode(frame, FrameType.AuthorArticlePage).ToArray());
        using var read = new BinaryReader(buffer);
        var total = read.ReadInt32();
        var next = read.ReadInt32();
        var count = read.ReadInt32();
        var rows = new List<AuthorArticleRow>();
        while (rows.Count < count)
        {
            var id = read.ReadInt32(); var revision = read.ReadInt64(); var title = Text();
            var state = (AuthorArticleState)read.ReadInt32(); var modified = read.ReadInt64(); var scheduled = read.ReadInt64();
            var categoryId = read.ReadInt32(); var category = categoryId == 0 ? null : new TaxonomyName(categoryId, Text());
            var tagCount = read.ReadInt32();
            var tags = Enumerable.Range(0, tagCount).Select(_ => new TaxonomyName(read.ReadInt32(), Text())).ToArray();
            rows.Add(new(id, revision, title, state, modified, scheduled, category, tags));
        }
        Assert.Equal(buffer.Length, buffer.Position);
        return (total, next, rows);

        string Text() => System.Text.Encoding.UTF8.GetString(read.ReadBytes(read.ReadInt32()));
    }
}
