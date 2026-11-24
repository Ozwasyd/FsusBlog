using ArticleScheduleStore = FsusBlog.V2.Server.Authoring.ArticleScheduleStore;
using static FsusBlog.V2.Integration.Tests.AuthorPropertyFixture;

namespace FsusBlog.V2.Integration.Tests;

public sealed class AuthorTextSearchPostgresTests
{
    [PostgresFact]
    public async Task CurrentPrivateIndexIsBoundedReconciledAndNeverReturnsAnotherAuthorsText()
    {
        await using var db = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(60));
        // This fixture checks exact foreground batch counts on the compatible pre-worker schema.
        await db.ExecAsync(ct, "drop table public.author_text_rebuild_job");
        var store = new Store(db.DataSource);
        var owner = await SignIn(db, "Full-text owner", ct);
        var stranger = await SignIn(db, "Full-text stranger", ct);
        var reader = await SignIn(db, "Full-text reader", ct, canAuthor: false);
        await using var server = await ServerProcess.Start(db.ConnectionString, ct);
        var author = new AuthorPropertyFixture(db, server.Client, ct);
        var prefix = "😀\r\n" + new string('-', 230) + " ";
        var source = prefix + "Cafe\u0301 orbit";
        for (var i = 0; i < 6; i++) await author.Save(owner, "Unrelated article " + i, "Other material");
        var fragment = await author.Save(owner, "Caféteria", "orbital movement");
        var across = await author.Save(owner, "Café", "orbit");
        var primary = await author.Save(owner, "Tropical Harbor", source);
        var foreign = await author.Save(stranger, "Private foreign title", source);
        const string phrase = "\"Café orbit\"";

        await Send(phrase, reader, HttpStatusCode.Unauthorized);
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
        Assert.Equal((primary.Id, primary.Revision), (match.Id, match.Revision));
        RequireSource(match, 2, source, "Cafe\u0301");

        Assert.Equal(new[] { primary.Id, across.Id }, (await Search("Café orbit", owner)).Rows.Select(row => row.Id).ToArray());
        Assert.Equal(new[] { primary.Id, across.Id }, (await Search("Café", owner)).Rows.Select(row => row.Id).ToArray());
        Assert.Equal(1, Assert.Single((await Search("Tropical", owner)).Rows).Field);
        Assert.Equal(new[] { primary.Id, across.Id }, (await Search("CAFÉ", owner)).Rows.Select(row => row.Id).ToArray());
        Assert.Equal(fragment.Id, Assert.Single((await Search("orbital", owner)).Rows).Id);
        Assert.Equal(foreign.Id, Assert.Single((await Search(phrase, stranger)).Rows).Id);
        await Send("body:orbit", owner, HttpStatusCode.BadRequest);
        await CheckStatusAsync(HttpStatusCode.NotFound, server.Client.GetAsync(WireRoutes.PublicArticle.Replace("{id}",
            primary.Id.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal), ct));

        var edited = await author.ChangeArticle(owner, ArticleAction.Save, new(primary.Id, primary.Revision, Guid.NewGuid(), primary.Title, "updated orbit"));
        Assert.Empty((await Search(phrase, owner)).Rows);
        var changed = Assert.Single((await Search("\"updated orbit\"", owner)).Rows);
        Assert.Equal(edited.Revision, changed.Revision);
        Assert.Equal("updated", changed.Snippet[changed.HighlightStart..changed.HighlightEnd]);
        var deleted = await author.ChangeArticle(owner, ArticleAction.Delete, new(edited.Id, edited.Revision, Guid.NewGuid(), "", ""));
        Assert.Empty((await Search("updated", owner)).Rows);
        Assert.Equal(8, await IndexedCount(owner.Id));
        var restored = await author.ChangeArticle(owner, ArticleAction.Restore, new(deleted.Id, deleted.Revision, Guid.NewGuid(), "", ""));
        Assert.Equal(restored.Revision, Assert.Single((await Search("updated", owner)).Rows).Revision);

        const string rankedTerm = "harborproof";
        var bodyHits = new List<ArticleState>();
        for (var i = 0; i < 22; i++) bodyHits.Add(await author.Save(owner, "Rank body " + i, rankedTerm));
        var titleHit = await author.Save(owner, "Harborproof launch", "blue orbit");
        Assert.Equal(22, await db.ExecAsync(ct, "update public.article set updated_at='2025-01-01T00:00:00Z' where id=any($1)", bodyHits.Select(row => row.Id).ToArray()));

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

        // The rank witness includes clock changes at the same source revision, as in scheduled publication.
        Assert.Equal(1, await db.ExecAsync(ct, "update public.article set updated_at='2025-01-02T00:00:00Z' where id=$1", bodyHits[^1].Id));
        await SendRanked(rankedTerm, first.NextCursor, owner, HttpStatusCode.Conflict);
        owner = await SignIn(db, owner.Id, ct);
        await SendRanked(rankedTerm, first.NextCursor, owner, HttpStatusCode.Conflict);
        first = await Ranked(rankedTerm, "", owner);
        Assert.Equal(bodyHits[^1].Id, first.Rows[1].Id);
        var previousIndexedRevision = bodyHits[0].Revision;
        bodyHits[0] = await author.ChangeArticle(owner, ArticleAction.Save,
            new(bodyHits[0].Id, previousIndexedRevision, Guid.NewGuid(), "New revision", rankedTerm));
        await SendRanked(rankedTerm, first.NextCursor, owner, HttpStatusCode.Conflict);
        Assert.Equal(previousIndexedRevision, await db.ScalarAsync<long>(ct,
            "select revision from public.author_text_document where owner_id=$1 and article_id=$2", owner.Id, bodyHits[0].Id));
        Assert.Equal(restored.Revision, Assert.Single((await Search("updated", owner)).Rows).Revision);

        Assert.Equal(31, await db.ExecAsync(ct, """
            insert into public.category(id,name) select id,'分类 ' || id from generate_series(101,115) id;
            insert into public.tag(id,name) select id,'Étiquette ' || id from generate_series(201,216) id;
            """));
        for (var i = 0; i < 14; i++)
        {
            var body = bodyHits[i];
            var assigned = await Assign(owner, body, 101 + i, [201 + i, 215]);
            bodyHits[i] = body with { Revision = assigned.Revision };
        }
        var foreignRanked = await author.Save(stranger, "Private foreign ranking", rankedTerm);
        await Assign(stranger, foreignRanked, 115, [216]);
        var queued = await store.WithSession(owner.Token, true, (conn, tx, identity) => Store.Schedule(conn, tx, identity,
            new(bodyHits[15].Id, bodyHits[15].Revision, Guid.NewGuid(), DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeMilliseconds()), ct), ct);
        var published = await author.ChangeArticle(owner, ArticleAction.Publish, new(bodyHits[16].Id, bodyHits[16].Revision, Guid.NewGuid(), "", ""));
        var publishedThenRetracted = await author.ChangeArticle(owner, ArticleAction.Publish, new(bodyHits[17].Id, bodyHits[17].Revision, Guid.NewGuid(), "", ""));
        var retracted = await author.ChangeArticle(owner, ArticleAction.Retract, new(publishedThenRetracted.Id, publishedThenRetracted.Revision, Guid.NewGuid(), "", ""));
        await author.ChangeArticle(owner, ArticleAction.Delete, new(bodyHits[18].Id, bodyHits[18].Revision, Guid.NewGuid(), "", ""));

        var unfinished = await Faceted(rankedTerm, "", owner);
        Assert.False(unfinished.Ready);
        Assert.Equal(0, unfinished.Total);
        Assert.Equal(new[] { 0, 0, 0, 0 }, unfinished.StateCounts);
        Assert.False(unfinished.MoreCategories || unfinished.MoreTags);
        Assert.Empty(unfinished.Categories);
        Assert.Empty(unfinished.Tags);
        Assert.Empty(unfinished.NextCursor);
        Assert.False((await Faceted(rankedTerm, "", owner)).Ready);
        var facets = await Faceted(rankedTerm, "", owner);
        Assert.True(facets.Ready);
        Assert.Equal(22, facets.Total);
        Assert.Equal(new[] { 19, 1, 1, 1 }, facets.StateCounts);
        Assert.Equal(WireLimits.AuthorTextSearchRows, facets.Rows.Count);
        Assert.True(facets.MoreCategories && facets.MoreTags);
        Assert.Equal(Enumerable.Range(101, 12).Select(id => new AuthorTextTaxonomyFacet(id, $"分类 {id}", 1)), facets.Categories);
        Assert.Equal(new[] { new AuthorTextTaxonomyFacet(215, "Étiquette 215", 14) }.Concat(
            Enumerable.Range(201, 11).Select(id => new AuthorTextTaxonomyFacet(id, $"Étiquette {id}", 1))), facets.Tags);
        Assert.DoesNotContain(facets.Rows, row => row.Id == foreignRanked.Id || row.Id == bodyHits[18].Id);
        var facetNext = await Faceted(rankedTerm, facets.NextCursor, owner);
        Assert.Equal(facets.Total, facetNext.Total);
        Assert.Equal(facets.StateCounts, facetNext.StateCounts);
        Assert.Equal(facets.Categories, facetNext.Categories);
        Assert.Equal(facets.Tags, facetNext.Tags);
        Assert.Equal(2, facetNext.Rows.Count);
        Assert.Empty(facets.Rows.Select(row => row.Id).Intersect(facetNext.Rows.Select(row => row.Id)));
        Assert.Empty(facetNext.NextCursor);

        var narrowed = await Faceted($"{rankedTerm} status:draft category:101 tag:201", "", owner);
        Assert.Equal(bodyHits[0].Id, Assert.Single(narrowed.Rows).Id);
        Assert.Equal(1, narrowed.Total);
        Assert.Equal(new[] { 1, 0, 0, 0 }, narrowed.StateCounts);
        Assert.Equal(101, Assert.Single(narrowed.Categories).Id);
        Assert.Equal(new[] { 201, 215 }, narrowed.Tags.Select(row => row.Id));
        Assert.Equal(0, (await Faceted($"{rankedTerm} category:101 tag:202", "", owner)).Total);
        Assert.Equal(published.Id, Assert.Single((await Faceted($"{rankedTerm} status:published", "", owner)).Rows).Id);
        Assert.Equal(retracted.Id, Assert.Single((await Faceted($"{rankedTerm} status:retracted", "", owner)).Rows).Id);
        Assert.Equal(queued.Id, Assert.Single((await Faceted($"{rankedTerm} status:scheduled", "", owner)).Rows).Id);
        Assert.Equal(foreignRanked.Id, Assert.Single((await Faceted(rankedTerm, "", stranger)).Rows).Id);
        foreach (var filter in new[] { "status:archived", "status:published status:scheduled", "category:0", "tag:-1", "category:2147483648", "tag:201 tag:202" })
            await SendFaceted($"{rankedTerm} {filter}", "", owner, HttpStatusCode.BadRequest);
        await SendRanked($"{rankedTerm} category:101", "", owner, HttpStatusCode.BadRequest);
        var rankedOnly = await Ranked(rankedTerm, "", owner);
        await SendRanked(rankedTerm, facets.NextCursor, owner, HttpStatusCode.Conflict);
        await SendFaceted(rankedTerm, rankedOnly.NextCursor, owner, HttpStatusCode.Conflict);
        await SendFaceted(rankedTerm, facets.NextCursor, stranger, HttpStatusCode.Conflict);

        // Renaming a shared label must invalidate only a mode that returned it.
        Assert.Equal(1, await db.ExecAsync(ct, "update public.tag set name='改名 201' where id=201"));
        await SendFaceted(rankedTerm, facets.NextCursor, owner, HttpStatusCode.Conflict);
        Assert.True((await Ranked(rankedTerm, rankedOnly.NextCursor, owner)).Ready);
        var renamed = await Faceted(rankedTerm, "", owner);
        Assert.Equal("改名 201", renamed.Tags.Single(item => item.Id == 201).Name);

        // A worker can clear a schedule with the same article revision and timestamp.
        var unchangedSource = await store.WithSession(owner.Token, true, async (conn, tx, identity) =>
        {
            var current = await Store.Find(conn, tx, identity, queued.Id, true, ct);
            await ArticleScheduleStore.Clear(conn, tx, queued.Id, ct);
            return current;
        }, ct);
        Assert.Equal(queued.Revision, unchangedSource.Revision);
        await SendFaceted(rankedTerm, renamed.NextCursor, owner, HttpStatusCode.Conflict);
        Assert.Equal(new[] { 20, 0, 1, 1 }, (await Faceted(rankedTerm, "", owner)).StateCounts);

        async Task<AuthorTextSearchPage> Search(string query, Actor actor) =>
            Wire.DecodeAuthorTextSearchPage(await Send(query, actor, HttpStatusCode.OK));

        async Task<AuthorTextRankedPage> Ranked(string query, string cursor, Actor actor) =>
            Wire.DecodeAuthorTextRankedPage(await SendRanked(query, cursor, actor, HttpStatusCode.OK));

        async Task<AuthorTextFacetedPage> Faceted(string query, string cursor, Actor actor) =>
            Wire.DecodeAuthorTextFacetedPage(await SendFaceted(query, cursor, actor, HttpStatusCode.OK));

        Task<DraftTaxonomy> Assign(Actor actor, ArticleState article, int category, int[] tags) =>
            store.WithSession(actor.Token, true, (conn, tx, identity) => Store.AssignTaxonomy(conn, tx, identity,
                new(article.Id, article.Revision, Guid.NewGuid(), category, tags), ct), ct);

        Task<byte[]> Send(string query, Actor actor, HttpStatusCode expected) =>
            author.Send(WireRoutes.AuthorTextSearch, Wire.EncodeAuthorTextSearchQuery(query), actor, expected);

        Task<byte[]> SendRanked(string query, string cursor, Actor actor, HttpStatusCode expected) =>
            author.Send(WireRoutes.AuthorTextSearch, Wire.EncodeAuthorTextRankedQuery(new(query, cursor)), actor, expected);

        Task<byte[]> SendFaceted(string query, string cursor, Actor actor, HttpStatusCode expected) =>
            author.Send(WireRoutes.AuthorTextSearch, Wire.EncodeAuthorTextFacetedQuery(new(query, cursor)), actor, expected);

        Task<long> IndexedCount(Guid id) =>
            db.ScalarAsync<long>(ct, "select count(*) from public.author_text_document where owner_id=$1", id);
    }
}
