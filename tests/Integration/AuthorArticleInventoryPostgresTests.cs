public sealed class AuthorArticleInventoryPostgresTests
{
    [PostgresFact]
    public async Task InventoryPagesRevealOnlyCurrentOwnerRowsAndHideDeletedDrafts()
    {
        await using var db = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(45));
        var owner = await Login("inventory-owner", true);
        var other = await Login("inventory-other", true);
        var reader = await Login("inventory-reader", false);
        await using var catalog = await db.DataSource.OpenConnectionAsync(ct);
        await FixtureSql.ExecuteAsync(catalog, null, ct, """
            insert into public.category (id,name) values(41,'Author category');
            insert into public.tag (id,name) values(81,'Author tag');
            """);
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

        using (var shellRequest = new HttpRequestMessage(HttpMethod.Get, "/admin/articles"))
        {
            shellRequest.Headers.Host = ServerProcess.DefaultAdminHost;
            using var shell = await client.SendAsync(shellRequest, ct);
            Assert.Equal(HttpStatusCode.OK, shell.StatusCode);
            Assert.Equal("noindex", Assert.Single(shell.Headers.GetValues("X-Robots-Tag")));
            Assert.DoesNotContain("State Published", await shell.Content.ReadAsStringAsync(ct));
        }
        await Failure(null, "?scope=active", HttpStatusCode.Unauthorized);
        await Failure(reader, "?scope=trash", HttpStatusCode.Unauthorized);
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
        await SiteAedsFixture.ExpectStatus(client, HttpMethod.Get, WireRoutes.Draft.Replace("{id:int}", trash.Id.ToString()),
            null, owner, null, HttpStatusCode.NotFound, ct);
        await db.SignOutAdmin(owner, ct);
        await Failure(owner, "?scope=trash", HttpStatusCode.Unauthorized);

        async Task<string> Login(string name, bool author) => (await db.SignIn(name, ct, author, minutes: 1)).Token;

        async Task<Draft> Write(string token, string route, ArticleCommand command) =>
            Wire.DecodeDraft(await POST(token, route, Wire.EncodeArticleCommand(command)));

        Task<byte[]> POST(string token, string route, byte[] body) =>
            SiteAedsFixture.ExpectStatus(client, HttpMethod.Post, route, body, token, null, HttpStatusCode.OK, ct);

        async Task Failure(string? token, string query, HttpStatusCode expected)
        {
            var frame = await SiteAedsFixture.ExpectPrivate(client, HttpMethod.Get, WireRoutes.AuthorArticles + query,
                null, token, null, expected, ct);
            Aeds.Decode(frame, out var type);
            Assert.Equal(FrameType.ApiError, type);
        }

        async Task<(int Total, int Next, IReadOnlyList<AuthorArticleRow> Rows)> Page(string token, string query)
        {
            var bytes = await SiteAedsFixture.ExpectPrivate(client, HttpMethod.Get, WireRoutes.AuthorArticles + query,
                null, token, null, HttpStatusCode.OK, ct);
            var payload = System.Text.Encoding.UTF8.GetString(bytes);
            Assert.DoesNotContain(sensitive, payload);
            Assert.DoesNotContain(summaryTerm, payload);
            return Decode(bytes);
        }
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
