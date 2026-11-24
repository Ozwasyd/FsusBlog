public sealed class TaxonomyPostgresTests
{
    [PostgresFact]
    public async Task PublishedRevisionDeterminesCountsFilteredFramesAndCanonicalPages()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var store = new Store(fixture.DataSource);
        var publications = PublicationFixture.Project(fixture.DataSource);
        var actor = await fixture.SignIn("fixture writer", ct);
        await fixture.Exec("""
            insert into public.category(id,name,description) values(1,'Tech & Robots','<taxonomy description>'),(2,'Empty',null);
            insert into public.tag(id,name,description) values(4,'Café',null);
            insert into public.tag_url_name values('ANCIENNE',4);
            """);

        var first = await Save("Taxonomy article one");
        var second = await Save("Taxonomy article two");
        var hidden = await Save("private taxonomy item");
        foreach (var row in new[] { first, second, hidden })
            await fixture.Exec("insert into public.article_revision_category values($1,$2,1)", row.Id, row.Revision);
        await fixture.Exec("insert into public.article_revision_tag values($1,$2,4)", first.Id, first.Revision);
        await fixture.Exec("insert into public.article_revision_tag values($1,$2,4)", hidden.Id, hidden.Revision);
        var posted = await Publish(first);
        await Publish(second);

        // A later private draft must not change the public links or their generation.
        var draft = (await publications.Command(store, actor.Token, ArticleAction.Save,
            new(first.Id, posted.Revision, Guid.NewGuid(), "private rewrite", "draft content"), ct)).Article;
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);
        var client = server.Client;
        var assignment = new TaxonomyAssignment(first.Id, draft.Revision, Guid.NewGuid(), 2, []);
        var changed = (await Assign(assignment, actor.Token))!;
        Assert.Equal((draft.Revision + 1, 2), (changed.Revision, changed.CategoryId));
        Assert.Empty(changed.TagIds);
        Assert.Equal(changed.Revision, (await Assign(assignment, actor.Token))!.Revision);
        var readOnlyAdmin = await fixture.SignIn("read-only admin", ct, canAuthor: false);
        foreach (var (cmd, tok, status) in new[]
        {
            (assignment with { CategoryId = 1 }, (string?)actor.Token, Conflict),
            (assignment with { IdempotencyKey = Guid.NewGuid() }, actor.Token, Conflict),
            (assignment with { ExpectedRevision = changed.Revision, IdempotencyKey = Guid.NewGuid(), CategoryId = 99 }, actor.Token, BadRequest),
            (assignment, null, Unauthorized),
            (assignment with { ExpectedRevision = changed.Revision, IdempotencyKey = Guid.NewGuid() }, readOnlyAdmin.Token, Unauthorized),
            (assignment with { Id = 999_999, ExpectedRevision = changed.Revision, IdempotencyKey = Guid.NewGuid() }, actor.Token, NotFound),
        })
            await Assign(cmd, tok, status);
        await SiteAedsFixture.SendStatus(client, HttpMethod.Get, $"/api/v2/authoring/draft/{first.Id}/taxonomy.aeds?revision={draft.Revision}",
            null, actor.Token, null, Conflict, ct);
        var observedTax = Wire.DecodeDraftTaxonomy(await SiteAedsFixture.ExpectStatus(client, HttpMethod.Get,
            $"/api/v2/authoring/draft/{first.Id}/taxonomy.aeds?revision={changed.Revision}", null, actor.Token, null, OK, ct));
        Assert.Equal((changed.Revision, changed.CategoryId), (observedTax.Revision, observedTax.CategoryId));
        var observedDraft = Wire.DecodeDraft(await SiteAedsFixture.ExpectStatus(client, HttpMethod.Get,
            $"/api/v2/authoring/draft/{first.Id}.aeds", null, actor.Token, null, OK, ct));
        Assert.Equal((draft.Title, draft.Body, changed.Revision), (observedDraft.Title, observedDraft.Body, observedDraft.Revision));
        Assert.Equal(new[] { (1, 2), (2, 0) }, ReadCounts(await GetFrame(WireRoutes.CategoryList, FrameType.CategoryList)));
        Assert.Equal(new[] { (4, 1) }, ReadCounts(await GetFrame(WireRoutes.TagList, FrameType.TagList)));
        var exact = await GetFrame("/api/binary/tag/4.aeds", FrameType.TaxonomyExactMetadata);
        Assert.Equal((4, "Café"), (ReadInt(exact, 0), Encoding.UTF8.GetString(exact, 8, ReadInt(exact, 4))));
        Assert.Equal(exact, await GetFrame("/api/binary/tag/by-name.aeds?name=ancienne", FrameType.TaxonomyExactMetadata));
        Assert.Equal(exact, await GetFrame("/api/binary/tag/by-name.aeds?name=cafe%CC%81", FrameType.TaxonomyExactMetadata));

        foreach (var name in new[] { "ancienne", "cafe%CC%81" })
        {
            using var redirect = Expect(MovedPermanently, await client.GetAsync($"/tag/{name}?q=1", ct));
            Assert.Equal("/tag/4?q=1", redirect.Headers.Location?.OriginalString);
        }
        await CheckStatusAsync(NotFound, client.GetAsync("/tag/unknown-name", ct));
        var body = await OkString(client.GetAsync("/category/1", ct), ct);
        foreach (var present in new[] { "Tech &amp; Robots", "&lt;taxonomy description&gt;", "Taxonomy article one" }) Assert.Contains(present, body);
        Assert.DoesNotContain("private", body);
        using var headRequest = new HttpRequestMessage(HttpMethod.Head, "/tag/4");
        Assert.Empty(await OkBytes(client.SendAsync(headRequest, ct), ct));

        var categoryPage = await GetFrame("/api/binary/article/list/category/1/1/1.aeds", FrameType.ArticleList);
        Assert.Equal(2, ReadInt(categoryPage, WireLayouts.ArticleListTotalOffset));
        var cursor = Encoding.ASCII.GetString(categoryPage, WireLayouts.ArticleListCursorOffset,
            ReadInt(categoryPage, WireLayouts.ArticleListCursorLengthOffset));
        Assert.NotEmpty(cursor);
        var tagPage = await GetFrame("/api/binary/article/list/tag/4/1/10.aeds", FrameType.ArticleList);
        var records = WireLayouts.ArticleListCursorOffset + 12 + ReadInt(tagPage, WireLayouts.ArticleListCursorOffset + 8);
        Assert.Equal((first.Id, 1, 1, 4), (ReadInt(tagPage, records + WireLayouts.ArticleIdOffset),
            ReadInt(tagPage, records + WireLayouts.ArticleCategoryIdOffset),
            ReadInt(tagPage, records + WireLayouts.ArticleListTagCountOffset),
            ReadInt(tagPage, records + WireLayouts.ArticleListRecordSizeCurrent)));
        await GetFrame($"/api/binary/article/list/tag/4/2/1.aeds?cursor={cursor}", FrameType.ApiError, BadRequest);
        await GetFrame($"/api/binary/article/list/category/1/2/1.aeds?cursor={cursor}", FrameType.ArticleList);

        await SiteAedsFixture.SendStatus(client, HttpMethod.Post, WireRoutes.Retract,
            Wire.EncodeArticleCommand(new(first.Id, changed.Revision, Guid.NewGuid(), "", "")), actor.Token, null, OK, ct);
        Assert.Equal(new[] { (4, 0) }, ReadCounts(await GetFrame(WireRoutes.TagList, FrameType.TagList)));
        Assert.Equal(new[] { (1, 1), (2, 0) }, ReadCounts(await GetFrame(WireRoutes.CategoryList, FrameType.CategoryList)));
        await GetFrame($"/api/binary/article/list/category/1/2/1.aeds?cursor={cursor}", FrameType.ApiError, BadRequest);
        var remaining = await GetFrame("/api/binary/article/list/category/1/1/10.aeds", FrameType.ArticleList);
        var remainingRecords = WireLayouts.ArticleListCursorOffset + 12 + ReadInt(remaining, WireLayouts.ArticleListCursorOffset + 8);
        Assert.Equal((1, second.Id), (ReadInt(remaining, WireLayouts.ArticleListTotalOffset), ReadInt(remaining, remainingRecords + WireLayouts.ArticleIdOffset)));
        Assert.Equal(0, ReadInt(await GetFrame("/api/binary/article/list/tag/4/1/10.aeds", FrameType.ArticleList), WireLayouts.ArticleListTotalOffset));
        Assert.DoesNotContain("Taxonomy article one", await client.GetStringAsync("/category/1", ct));
        Assert.DoesNotContain("Taxonomy article one", await client.GetStringAsync("/tag/4", ct));

        async Task<ArticleState> Save(string title) => (await publications.Command(store, actor.Token, ArticleAction.Save,
            new(0, 0, Guid.NewGuid(), title, "article body"), ct)).Article;
        async Task<ArticleState> Publish(ArticleState row) => (await publications.Command(store, actor.Token, ArticleAction.Publish,
            new(row.Id, row.Revision, Guid.NewGuid(), "", ""), ct)).Article;

        async Task<byte[]> GetFrame(string path, FrameType expected, HttpStatusCode status = OK)
        {
            using var packet = Expect(status, await client.GetAsync(path, ct));
            Assert.Equal("application/octet-stream", packet.Content.Headers.ContentType?.MediaType);
            Assert.True(packet.Headers.CacheControl?.NoStore);
            return Aeds.Decode(await packet.Content.ReadAsByteArrayAsync(ct), expected).ToArray();
        }

        async Task<DraftTaxonomy?> Assign(TaxonomyAssignment value, string? token, HttpStatusCode status = OK)
        {
            var bytes = await SiteAedsFixture.ExpectStatus(client, HttpMethod.Post, WireRoutes.TaxonomyAssignment,
                Wire.EncodeTaxonomyAssignment(value), token, null, status, ct);
            return status == OK ? Wire.DecodeDraftTaxonomy(bytes) : null;
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
