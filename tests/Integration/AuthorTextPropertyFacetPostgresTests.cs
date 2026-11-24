using static FsusBlog.V2.Integration.Tests.AuthorPropertyFixture;

namespace FsusBlog.V2.Integration.Tests;

public sealed class AuthorTextPropertyFacetPostgresTests
{
    private const string Keyword = "facetprobe";

    [PostgresFact]
    public async Task FacetsUseTheEntireFilteredOwnedMatchSetAndWitnessValueChanges()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var owner = await SignIn(fixture, "Facet owner", ct);
        var outsider = await SignIn(fixture, "Facet outsider", ct);
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);
        var author = new AuthorPropertyFixture(fixture, server.Client, ct);

        var red = Guid.Parse("00000000-0000-4000-8000-000000000001");
        var blue = Guid.Parse("00000000-0000-4000-8000-000000000002");
        var unused = Guid.Parse("00000000-0000-4000-8000-000000000003");
        PropertyFieldOption[] options = [new(unused, "Unused"), new(blue, "Blue"), new(red, "Red")];
        var flag = await author.Define(owner, "flag", PropertyFieldKind.Boolean, filterable: true);
        var multi = await author.Define(owner, "choices", PropertyFieldKind.MultiSelect, filterable: true, options: options);
        var single = await author.Define(owner, "choice", PropertyFieldKind.SingleSelect, filterable: true, options: options);
        var disabled = await author.Create(owner, "disabled", PropertyFieldKind.Boolean);
        var deprecated = await author.Define(owner, "deprecated", PropertyFieldKind.Boolean, filterable: true);
        await author.ChangeDefinition(owner, 3, deprecated.Id, deprecated.Revision);
        var unsupported = await author.Define(owner, "text", PropertyFieldKind.Text, filterable: true);
        // Reuse the UUID across two schemas. Both the definition and value must stay owner-scoped.
        var outsiderFlag = await author.Define(outsider, "flag", PropertyFieldKind.Boolean, filterable: true, id: flag.Id);

        const int matches = 24;
        var articles = new ArticleState[matches];
        var values = new PropertyFieldValue[matches];
        for (var i = 0; i < matches; i++)
        {
            var article = await author.Save(owner, i % 2 == 0 ? $"{Keyword} title {i}" : $"Body match {i}",
                i % 2 == 0 ? "Different body" : $"The {Keyword} body is indexed");
            articles[i] = article;
            values[i] = i switch
            {
                < 10 => new PropertyFieldValue.Boolean(true),
                < 17 => new PropertyFieldValue.Boolean(false),
                < 21 => new PropertyFieldValue.Missing(),
                _ => new PropertyFieldValue.Null(),
            };
            if (values[i] is not PropertyFieldValue.Missing)
                await author.Put(owner, article, flag, values[i]);

            PropertyFieldValue? choices = (i % 6) switch
            {
                0 => new PropertyFieldValue.MultiSelect([red]),
                1 => new PropertyFieldValue.MultiSelect([blue, red]),
                2 => new PropertyFieldValue.MultiSelect([blue]),
                3 => new PropertyFieldValue.MultiSelect([]),
                4 => null,
                _ => new PropertyFieldValue.Null(),
            };
            if (choices is not null) await author.Put(owner, article, multi, choices);

            PropertyFieldValue? choice = i switch
            {
                0 or 2 => new PropertyFieldValue.SingleSelect(red),
                1 => new PropertyFieldValue.SingleSelect(blue),
                3 => new PropertyFieldValue.Null(),
                _ => null,
            };
            if (choice is not null) await author.Put(owner, article, single, choice);
        }

        var nonmatch = await author.Save(owner, "Other subject", "Other body");
        await author.Put(owner, nonmatch, flag, new PropertyFieldValue.Boolean(true));
        var deleted = await author.Save(owner, $"{Keyword} deleted", "Historical body");
        await author.Put(owner, deleted, flag, new PropertyFieldValue.Boolean(true));
        await author.ChangeArticle(owner, ArticleAction.Delete, new(deleted.Id, deleted.Revision, Guid.NewGuid(), "", ""));
        var archived = await author.Save(owner, $"{Keyword} archived", "Historical body");
        await author.Put(owner, archived, flag, new PropertyFieldValue.Boolean(true));
        await author.Put(owner, archived, multi, new PropertyFieldValue.MultiSelect([red]));
        await Archive(archived);
        var foreign = await author.Save(outsider, $"{Keyword} foreign", "Different body");
        await author.Put(outsider, foreign, outsiderFlag, new PropertyFieldValue.Boolean(false));

        var request = Query(owner, flag);
        var first = await Ready(request, owner);
        Assert.Equal(matches, first.Search.Total);
        Assert.Equal(new[] { matches, 0, 0, 0 }, first.Search.StateCounts);
        Assert.Equal(WireLimits.AuthorTextSearchRows, first.Search.Rows.Count);
        Assert.NotEmpty(first.Search.NextCursor);
        RequireBoolFacet(first.Facet, flag, 4, 3, 7, 10);

        var continuation = request with { Search = request.Search with { Cursor = first.Search.NextCursor } };
        var tail = await Read(continuation, owner);
        Assert.True(tail.Search.Ready);
        Assert.Equal(matches, tail.Search.Total);
        Assert.Empty(tail.Search.NextCursor);
        RequireBoolFacet(tail.Facet, flag, 4, 3, 7, 10);
        var seen = first.Search.Rows.Concat(tail.Search.Rows).ToArray();
        Assert.Equal(articles.Select(row => row.Id).Order(), seen.Select(row => row.Id).Order());
        Assert.Equal(new[] { 1, 2 }, seen.Select(row => row.Field).Distinct().Order());
        Assert.DoesNotContain(seen, row => row.Id == archived.Id || row.Id == deleted.Id || row.Id == foreign.Id || row.Id == nonmatch.Id);

        var multiPage = await Ready(Query(owner, multi), owner);
        Assert.Equal(matches, multiPage.Search.Total);
        RequireFacet(multiPage.Facet, multi, PropertyFieldKind.MultiSelect, 4, 4, 4, ChoiceFacet(red, 8), ChoiceFacet(blue, 8), ChoiceFacet(unused, 0));
        var singlePage = await Ready(Query(owner, single), owner);
        Assert.Equal(matches, singlePage.Search.Total);
        RequireFacet(singlePage.Facet, single, PropertyFieldKind.SingleSelect, 20, 1, 0, ChoiceFacet(red, 2), ChoiceFacet(blue, 1), ChoiceFacet(unused, 0));

        var alternatives = new PropertyCondition(multi.Id, multi.Revision, PropertyComparison.MultiSelectAnyOf,
            new PropertyFieldValue.MultiSelect([blue, red]));
        var filtered = await Ready(Query(owner, flag, alternatives), owner);
        Assert.Equal(12, filtered.Search.Total);
        Assert.Equal(articles.Where((_, i) => i % 6 < 3).Select(row => row.Id).Order(),
            filtered.Search.Rows.Select(row => row.Id).Order());
        RequireBoolFacet(filtered.Facet, flag, 3, 0, 3, 6);
        var onlyFalse = new PropertyCondition(flag.Id, flag.Revision, PropertyComparison.Equal, new PropertyFieldValue.Boolean(false));
        var filteredMulti = await Ready(Query(owner, multi, onlyFalse), owner);
        Assert.Equal(7, filteredMulti.Search.Total);
        Assert.Equal(articles.Skip(10).Take(7).Select(row => row.Id), filteredMulti.Search.Rows.Select(row => row.Id).Order());
        RequireFacet(filteredMulti.Facet, multi, PropertyFieldKind.MultiSelect, 2, 1, 1, ChoiceFacet(red, 2), ChoiceFacet(blue, 2), ChoiceFacet(unused, 0));

        var outsiderPage = await Ready(Query(outsider, outsiderFlag), outsider);
        Assert.Equal(foreign.Id, Assert.Single(outsiderPage.Search.Rows).Id);
        RequireBoolFacet(outsiderPage.Facet, outsiderFlag, 0, 0, 1, 0);
        await Reject(Query(outsider, multi), outsider, HttpStatusCode.NotFound);
        await Reject(Query(owner, new(Guid.NewGuid(), 1)), owner, HttpStatusCode.NotFound);
        await Reject(Query(owner, disabled), owner, HttpStatusCode.NotFound);
        await Reject(Query(owner, deprecated with { Revision = deprecated.Revision + 1 }), owner, HttpStatusCode.NotFound);
        await Reject(Query(owner, unsupported), owner, HttpStatusCode.BadRequest);
        await Reject(request with { Search = request.Search with { SchemaRevision = owner.SchemaRevision - 1 } }, owner, HttpStatusCode.Conflict);
        await Reject(request with { DefinitionRevision = flag.Revision - 1 }, owner, HttpStatusCode.Conflict);
        await Reject(continuation with { DefinitionId = multi.Id, DefinitionRevision = multi.Revision }, owner, HttpStatusCode.Conflict);
        await Reject(continuation, owner with { Handle = null }, HttpStatusCode.Conflict);

        // A property edit on a later page changes only the value revision.
        var offPage = Array.FindIndex(articles, article => article.Id == tail.Search.Rows[^1].Id);
        Assert.InRange(offPage, 0, matches - 1);
        var before = await author.ArticleStamp(articles[offPage].Id);
        var replacement = new PropertyFieldValue.Boolean(values[offPage] is PropertyFieldValue.Boolean { Value: false });
        await author.Put(owner, articles[offPage], flag, replacement);
        Assert.Equal(before, await author.ArticleStamp(articles[offPage].Id));
        values[offPage] = replacement;
        await Reject(continuation, owner, HttpStatusCode.Conflict);
        var updated = await Ready(request, owner);
        Assert.Equal(matches, updated.Search.Total);
        RequireFlags(updated, flag, values);

        // A new article revision removes a member from the lexical cohort.
        var revised = await author.ChangeArticle(owner, ArticleAction.Save, new(articles[0].Id, articles[0].Revision, Guid.NewGuid(),
            "Independent title", "Independent body"));
        Assert.Equal(articles[0].Revision + 1, revised.Revision);
        Assert.NotEmpty(updated.Search.NextCursor);
        await Reject(request with { Search = request.Search with { Cursor = updated.Search.NextCursor } }, owner, HttpStatusCode.Conflict);
        var current = await Ready(request, owner);
        Assert.Equal(matches - 1, current.Search.Total);
        RequireFlags(current, flag, values.Skip(1));

        var renamed = await author.ChangeDefinition(owner, 2, flag.Id, flag.Revision, label: "Renamed flag");
        await Reject(request, owner, HttpStatusCode.Conflict);
        await Reject(Query(owner, flag), owner, HttpStatusCode.Conflict);
        var atNewSchema = await Ready(Query(owner, renamed), owner);
        Assert.Equal(matches - 1, atNewSchema.Search.Total);
        RequireFlags(atNewSchema, renamed, values.Skip(1));

        AuthorTextPropertyFacetQuery Query(Actor actor, Field field, params PropertyCondition[] conditions) =>
            new(new(Keyword, "", null, null, actor.SchemaRevision, conditions), false, field.Id, field.Revision);

        Task<AuthorTextPropertyFacetPage> Ready(AuthorTextPropertyFacetQuery query, Actor actor) =>
            ReadyWithFacet(() => Read(query, actor), page => (page.Search, page.Facet));

        async Task<AuthorTextPropertyFacetPage> Read(AuthorTextPropertyFacetQuery query, Actor actor) =>
            Wire.DecodeAuthorTextPropertyFacetPage(
                await author.Send(WireRoutes.AuthorTextSearch, Wire.EncodeAuthorTextPropertyFacetQuery(query), actor), query.IncludeHeading);

        Task<byte[]> Reject(AuthorTextPropertyFacetQuery query, Actor actor, HttpStatusCode expected) =>
            author.Send(WireRoutes.AuthorTextSearch, Wire.EncodeAuthorTextPropertyFacetQuery(query), actor, expected);

        async Task Archive(ArticleState draft)
        {
            var original = await author.ChangeArticle(owner, ArticleAction.Publish, new(draft.Id, draft.Revision, Guid.NewGuid(), "", ""));
            var edit = await author.ChangeArticle(owner, ArticleAction.Save, new(draft.Id, original.Revision, Guid.NewGuid(), draft.Title, "Replacement body"));
            var published = await author.ChangeArticle(owner, ArticleAction.Publish, new(draft.Id, edit.Revision, Guid.NewGuid(), "", ""));
            await author.Execute("""
                with custody as (
                    insert into public.article_revision_responsibility(article_id,revision,responsible_party,basis,reference,recorded_by)
                    values($1,$2,'Fixture editor','Fixture responsibility for the source release','facet-fixture',current_user)
                    returning id
                )
                insert into public.article_publication_responsibility(publication_id,article_id,revision,snapshot_id)
                select h.publication_id,h.article_id,h.revision,c.id from public.article_publication_history h cross join custody c
                where h.article_id=$1 and h.revision=$2 and h.kind='publish'
                """, draft.Id, original.Revision);
            var release = await fixture.ScalarAsync<long>(ct,
                "select publication_id from public.article_publication where article_id=$1 and revision=$2", draft.Id, published.Revision);
            var intent = new AdminArticleArchiveIntent(draft.Id, published.Revision, release, original.Revision,
                Guid.NewGuid(), "Archive the matched private facet fixture", Wire.AdminArticleArchiveStatus);
            var admin = await fixture.AdminAsync("facet-fixture-admin", ct: ct);
            var (proof, _) = await fixture.SeedStepUpProof("admin_article_rollback_step_up", admin.Id, admin.Digest,
                8, AdminArticleArchiveStore.ArticleArchiveIntentDigest(intent), ct: ct);
            var gate = new AdminSessionGate(fixture.DataSource, null);
            var receipt = await new AdminArticleArchiveStore(gate, new AdminStepUpService(gate))
                .ExecuteArticleArchive(admin.Token, proof, intent, () => { }, ct);
            Assert.Equal((draft.Id, published.Revision + 1, Wire.AdminArticleArchiveStatus), (receipt.ArticleId, receipt.Revision, receipt.TargetStatus));
        }

    }

    private static void RequireFlags(AuthorTextPropertyFacetPage page, Field flag, IEnumerable<PropertyFieldValue> entries)
    {
        var values = entries.ToArray();
        RequireBoolFacet(page.Facet, flag, values.Count(v => v is PropertyFieldValue.Missing), values.Count(v => v is PropertyFieldValue.Null),
            values.Count(v => v is PropertyFieldValue.Boolean { Value: false }), values.Count(v => v is PropertyFieldValue.Boolean { Value: true }));
    }
}
