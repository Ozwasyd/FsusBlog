namespace FsusBlog.V2.Integration.Tests;

public sealed class AdminTaxonomyPostgresTests
{
    [PostgresFact]
    public async Task AdminTaxonomyReportsPublishedAndRetainedRevisionCoordinatesWithIndependentPermission()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var (admin, adminToken, _) = await fixture.AdminAsync("taxonomy-reviewer", 10, [1], [2], ct);
        var (_, token, _) = await fixture.SignInSiteUser("taxonomy-fixture-reader", ct, minutes: 5);
        await fixture.Exec("""
            insert into public.category(id,name) select id,'Category '||id from generate_series(1,26) id;
            insert into public.tag(id,name) values(1,'Tag primary'),(2,'Tag private'),(3,'Tag historical');
            insert into public.tag_url_name values('OLDER HISTORICAL TAG',3);
            """);

        var store = new Store(fixture.DataSource);
        var (_, authorToken, _) = await fixture.SignIn("taxonomy-fixture-writer", ct);
        var publications = PublicationFixture.Project(fixture.DataSource);
        var published = await Publish(await Draft("Public article", 1, 1));
        await Schedule(await Assign(published, 2, 2));
        await Draft("Draft marker stays private", 1, 1);
        var retracted = await Publish(await Draft("Retracted article", 1, 1));
        await Change(ArticleAction.Retract, retracted.Id, retracted.Revision);
        var deleted = await Draft("Deleted draft", 1, 1);
        await Change(ArticleAction.Delete, deleted.Id, deleted.Revision);
        await Assign(await Draft("Historical only on category 1", 1, 3), 2, 2);
        await Schedule(await Publish(await Draft("Entirely public on category 1", 1, 1)));

        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct, new Dictionary<string, string>
        {
            ["FSUSBLOG_ADMIN_ORIGIN"] = "http://localhost", ["FSUSBLOG_ADMIN_RP_ID"] = "localhost"
        });
        var categoryDependencies = WireRoutes.AdminCategories + "?dependency=";
        var tagDependencies = WireRoutes.AdminTags + "?dependency=";
        foreach (var path in new[] { WireRoutes.AdminCategories, categoryDependencies + "1" })
        {
            await Get(path, NotFound, adminToken, adminHost: false);
            await Get(path, Unauthorized, token, siteCookie: true);
        }
        foreach (var bad in new[] { "?after=1&after=2", "?after=%2B1", "?dependency=0", "?dependency=%2B1",
            "?dependency=2147483648", "?dependency=1&after=1", "?dependency=1&dependency=2" })
            await Get(WireRoutes.AdminCategories + bad, BadRequest, adminToken);
        await Get(tagDependencies + "999", NotFound, adminToken);

        var page = Decode(await Get(WireRoutes.AdminCategories, OK, adminToken));
        Assert.Equal(24, page.NextId);
        Assert.Equal(Enumerable.Range(1, 24), page.Items.Select(item => item.Id));
        Assert.Equal(new AdminTaxonomyItem(1, "Category 1", 2, 1, 1, 1, 1, 6), page.Items[0]);
        Assert.Equal(new AdminTaxonomyItem(2, "Category 2", 0, 1, 1, 0, 0, 2), page.Items[1]);
        var tail = Decode(await Get(WireRoutes.AdminCategories + "?after=24", OK, adminToken));
        Assert.Equal(0, tail.NextId);
        Assert.Equal([25, 26], tail.Items.Select(item => item.Id));
        Assert.Empty(Decode(await Get(WireRoutes.AdminCategories + "?after=26", OK, adminToken)).Items);
        var tags = Decode(await Get(WireRoutes.AdminTags, OK, adminToken));
        Assert.Equal(new AdminTaxonomyItem(1, "Tag primary", 2, 1, 1, 1, 1, 5), tags.Items[0]);
        Assert.Equal(new AdminTaxonomyItem(3, "Tag historical", 0, 0, 0, 0, 0, 1), tags.Items[2]);
        foreach (var (path, expected) in new[]
        {
            (categoryDependencies + "1", new AdminTaxonomyDependencies(1, 4, 2, 0)),
            (categoryDependencies + "26", new AdminTaxonomyDependencies(26, 0, 0, 0)),
            (tagDependencies + "1", new AdminTaxonomyDependencies(1, 4, 1, 0)),
            (tagDependencies + "3", new AdminTaxonomyDependencies(3, 0, 1, 1)),
        })
            Assert.Equal(expected, await Dependencies(path));

        // This deliberately held projection instance cannot combine a newer durable public write with older released counts.
        var direct = new AdminTaxonomyStore(new AdminSessionGate(fixture.DataSource, null));
        await fixture.Exec("insert into public.blog_outbox(article_id,revision,kind) values($1,$2,'publish')", published.Id, published.Revision);
        await Assert.ThrowsAsync<PublicUnavailableException>(() => direct.Taxonomy(adminToken, false, QueryCollection.Empty, publications, ct));
        await fixture.Exec("update public.admin_principal set generation=generation+1 where id=$1", admin);
        await Get(WireRoutes.AdminTags, Unauthorized, adminToken);
        await Get(tagDependencies + "3", Unauthorized, adminToken);

        async Task<AdminTaxonomyDependencies> Dependencies(string path)
        {
            var data = Aeds.Decode(await Get(path, OK, adminToken), FrameType.AdminTaxonomyDependencies);
            Assert.Equal(16, data.Length);
            return new(BinaryPrimitives.ReadInt32LittleEndian(data), BinaryPrimitives.ReadInt32LittleEndian(data[4..]),
                BinaryPrimitives.ReadInt32LittleEndian(data[8..]), BinaryPrimitives.ReadInt32LittleEndian(data[12..]));
        }

        Task<ArticleState> Publish(ArticleState draft) => Change(ArticleAction.Publish, draft.Id, draft.Revision);
        async Task<ArticleState> Draft(string title, int category, int tag) => await Assign(await Change(ArticleAction.Save, 0, 0, title), category, tag);

        async Task<ArticleState> Assign(ArticleState draft, int category, int tag) =>
            draft with { Revision = (await store.WithSession(authorToken, true, (conn, tx, actor) => Store.AssignTaxonomy(conn, tx, actor,
                new TaxonomyAssignment(draft.Id, draft.Revision, Guid.NewGuid(), category, [tag]), ct), ct)).Revision };

        async Task<ArticleState> Schedule(ArticleState draft) =>
            draft with { Revision = (await store.WithSession(authorToken, true, (conn, tx, actor) => Store.Schedule(conn, tx, actor,
                new(draft.Id, draft.Revision, Guid.NewGuid(), DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeMilliseconds()), ct), ct)).Revision };

        async Task<ArticleState> Change(ArticleAction action, int id, long revision, string title = "") =>
            (await publications.Command(store, authorToken, action, new(id, revision, Guid.NewGuid(), title,
                action == ArticleAction.Save ? "Taxonomy fixtures retain article content" : ""), ct)).Article;

        async Task<byte[]> Get(string path, HttpStatusCode expected, string secret, bool adminHost = true, bool siteCookie = false)
        {
            using var request = InboxFixture.AdminRequest(HttpMethod.Get, path, secret, adminHost: adminHost, site: siteCookie);
            using var response = Expect(expected, await server.Client.SendAsync(request, ct));
            Assert.True(response.Headers.CacheControl?.NoStore);
            var bytes = await response.Content.ReadAsByteArrayAsync(ct);
            if (response.IsSuccessStatusCode) Assert.False(bytes.AsSpan().IndexOf("Draft marker stays private"u8) >= 0);
            return bytes;
        }
    }

    private static AdminTaxonomyPage Decode(byte[] frame)
    {
        using var read = InboxFixture.Reader(frame, FrameType.AdminTaxonomyPage);
        var (next, count) = (read.ReadInt32(), read.ReadInt32());
        var items = new List<AdminTaxonomyItem>(count);
        for (var index = 0; index < count; index++)
            items.Add(new(read.ReadInt32(), InboxFixture.Text(read), read.ReadInt32(), read.ReadInt32(), read.ReadInt32(),
                read.ReadInt32(), read.ReadInt32(), read.ReadInt32()));
        Assert.Equal(read.BaseStream.Length, read.BaseStream.Position);
        return new(next, items);
    }
}
