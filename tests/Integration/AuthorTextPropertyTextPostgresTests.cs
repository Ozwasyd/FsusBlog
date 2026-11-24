using AuthorTextRebuildProfile = FsusBlog.V2.Server.Authoring.AuthorTextRebuildProfile;
using static FsusBlog.V2.Integration.Tests.AuthorPropertyFixture;

namespace FsusBlog.V2.Integration.Tests;

public sealed class AuthorTextPropertyTextPostgresTests
{
    [PostgresFact]
    public async Task PhraseSearchUsesOnlySavedTextAndRejectsAChangedOffPageSource()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var owner = await SignIn(fixture, "Property text author", ct);
        var stranger = await SignIn(fixture, "Property text stranger", ct);
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);
        var author = new AuthorPropertyFixture(fixture, server.Client, ct);

        var selected = await author.Create(owner, "research", PropertyFieldKind.Text);
        selected = await EnableText(owner, selected, true);
        var other = await author.Create(owner, "notes", PropertyFieldKind.Text);
        other = await EnableText(owner, other, true);
        var flag = await author.Create(owner, "visible", PropertyFieldKind.Boolean);
        flag = await author.SetFilterable(owner, flag);
        var order = await author.Create(owner, "priority", PropertyFieldKind.Number);
        order = await author.SetProjection(owner, order, searchable: false, sortable: true);
        var foreignField = await author.Create(stranger, "research", PropertyFieldKind.Text, selected.Id);
        foreignField = await EnableText(stranger, foreignField, true);

        const string prefix = "🙂 ";
        const string canonical = prefix + "Café orbit";
        const string input = prefix + "Cafe\u0301 orbit";
        const string phrase = "\"CAFÉ orbit\"";
        var cohort = new List<ArticleState>();
        for (var i = 0; i <= WireLimits.AuthorTextSearchRows; i++)
        {
            var article = await author.Save(owner, $"Property article {i}", "Independent body");
            cohort.Add(article);
            await author.Put(owner, article, selected, new PropertyFieldValue.Text(input));
        }
        await author.Put(owner, cohort[0], flag, new PropertyFieldValue.Boolean(true));
        await author.Put(owner, cohort[^1], flag, new PropertyFieldValue.Boolean(false));
        await author.Put(owner, cohort[0], order, new PropertyFieldValue.Number(20));
        await author.Put(owner, cohort[^1], order, new PropertyFieldValue.Number(10));
        var unrelated = await author.Save(owner, "Café orbit in the title", "Café orbit in the body");
        await author.Put(owner, unrelated, selected, new PropertyFieldValue.Text("Café distant orbit"));
        await author.Put(owner, unrelated, other, new PropertyFieldValue.Text(input));
        await author.Put(owner, unrelated, flag, new PropertyFieldValue.Boolean(true));
        await author.Put(owner, unrelated, order, new PropertyFieldValue.Number(0));
        var foreign = await author.Save(stranger, "Foreign property article", "Independent body");
        await author.Put(stranger, foreign, foreignField, new PropertyFieldValue.Text(input));

        var query = Query(owner, selected, phrase);
        var pending = await Read(query, owner);
        Assert.False(pending.Ready);
        Assert.Empty(pending.Rows);
        Assert.Empty(pending.NextCursor);

        // Seed an already obsolete durable job in the owned fixture. The same definition
        // ID in the other scope has saved text and stays cold even when its old job is drained.
        var oldForeignSchema = stranger.SchemaRevision;
        await author.Create(stranger, "other", PropertyFieldKind.Boolean);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        Assert.Equal(1, await FixtureSql.ExecuteAsync(db, null, ct, """
            insert into public.author_text_rebuild_job
                (owner_id,profile,definition_id,owner_generation,schema_revision,definition_revision,available_at)
            values ($1,$2,$3,1,$4,$5,statement_timestamp())
            """, stranger.Id, (int)AuthorTextRebuildProfile.PropertyText, foreignField.Id, oldForeignSchema, foreignField.Revision));

        // Only PostgreSQL observations occur before the next search request.
        await using (var queued = Store.Sql(db, null, """
            select exists(select from public.author_text_rebuild_job where owner_id in ($1,$2) and definition_id=$3)
            """, owner.Id, stranger.Id, selected.Id))
        {
            for (var attempt = 0; await queued.ExecuteScalarAsync(ct) is true; attempt++)
            {
                Assert.True(attempt < 100, "Property search jobs did not drain autonomously within ten seconds.");
                await Task.Delay(TimeSpan.FromMilliseconds(100), ct);
            }
        }
        await using (var projected = Store.Sql(db, null, """
            select count(*) from public.author_text_property_document d
            join public.property_article a on a.article_id=d.article_id and a.owner_id=d.owner_id and a.revision=d.value_revision
            where d.owner_id=$1 and d.definition_id=$2 and d.definition_revision=$3 and d.article_id=any($4)
            """, owner.Id, selected.Id, selected.Revision, cohort.Append(unrelated).Select(article => article.Id).ToArray()))
            Assert.Equal(cohort.Count + 1L, Assert.IsType<long>(await projected.ExecuteScalarAsync(ct)));
        await using (var foreignProjection = Store.Sql(db, null, """
            select count(*) from public.author_text_property_document where owner_id=$1 and definition_id=$2
            """, stranger.Id, foreignField.Id))
            Assert.Equal(0L, Assert.IsType<long>(await foreignProjection.ExecuteScalarAsync(ct)));

        var first = await Read(query, owner);
        Assert.True(first.Ready);
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

        var composition = new AuthorTextPropertyTextQualifiedQuery(query.Search with
        {
            Query = $"field.property:{phrase} status:draft",
            UpdatedFromUnixMs = DateTimeOffset.UtcNow.AddDays(-1).ToUnixTimeMilliseconds(),
        }, selected.Id, selected.Revision, new(flag.Id, flag.Revision),
            new(order.Id, order.Revision, AuthorTextPropertySortDirection.Ascending));
        var composed = await ReadComposed(composition, owner);
        Assert.True(composed.Search.Ready);
        Assert.Equal(cohort.Count, composed.Search.Total);
        Assert.Equal(new[] { cohort[^1].Id, cohort[0].Id }, composed.Search.Rows.Take(2).Select(row => row.Id));
        Assert.All(composed.Search.Rows, row =>
        {
            Assert.Equal(5, row.Field);
            Assert.Equal("Café", row.Snippet[row.HighlightStart..row.HighlightEnd]);
        });
        Assert.DoesNotContain(composed.Search.Rows, row => row.Id == unrelated.Id || row.Id == foreign.Id);
        RequireBooleanFacet(composed, cohort.Count - 2, falseCount: 1, trueCount: 1);
        Assert.NotEmpty(composed.Search.NextCursor);
        var composedAfter = composition with { Search = composition.Search with { Cursor = composed.Search.NextCursor } };
        var composedLast = await ReadComposed(composedAfter, owner);
        Assert.Empty(composedLast.Search.NextCursor);
        Assert.Single(composedLast.Search.Rows);
        RequireBooleanFacet(composedLast, cohort.Count - 2, falseCount: 1, trueCount: 1);
        Assert.Equal(cohort.Select(article => article.Id).Order(),
            composed.Search.Rows.Concat(composedLast.Search.Rows).Select(row => row.Id).Order());
        await RejectComposed(composedAfter with
        {
            Sort = composition.Sort! with { Direction = AuthorTextPropertySortDirection.Descending },
        }, owner, HttpStatusCode.Conflict);
        await RejectComposed(composedAfter with { Facet = null }, owner, HttpStatusCode.Conflict);
        await Reject(new(composedAfter.Search, selected.Id, selected.Revision), owner, HttpStatusCode.Conflict);

        RequireBooleanFacet(await ReadComposed(composition with { Sort = null }, owner), cohort.Count - 2, falseCount: 1, trueCount: 1);
        var orderedOnly = await ReadComposed(composition with { Facet = null }, owner);
        Assert.Null(orderedOnly.Facet);
        Assert.Equal(composed.Search.Rows.Select(row => row.Id), orderedOnly.Search.Rows.Select(row => row.Id));
        var narrowed = await ReadComposed(composition with
        {
            Search = composition.Search with { Conditions = filtered.Search.Conditions },
        }, owner);
        Assert.Equal(cohort[0].Id, Assert.Single(narrowed.Search.Rows).Id);
        RequireBooleanFacet(narrowed, 0, falseCount: 0, trueCount: 1);

        Assert.Equal(unrelated.Id, Assert.Single((await Ready(Query(owner, other, phrase), owner)).Rows).Id);
        Assert.Equal(foreign.Id, Assert.Single((await Ready(Query(stranger, foreignField, phrase), stranger)).Rows).Id);
        await Reject(Query(owner, selected, "field.title:café"), owner, HttpStatusCode.BadRequest);
        await Reject(Query(owner, flag, phrase), owner, HttpStatusCode.NotFound);
        await Reject(continuation with { DefinitionId = other.Id, DefinitionRevision = other.Revision }, owner, HttpStatusCode.Conflict);

        var hit = new PropertyTextHitRequest(last.Id, last.Revision, owner.SchemaRevision, 0, selected.Id, selected.Revision, last.SourceDigest);
        var exact = Wire.DecodePropertyEditor(await ReadHit(hit, owner));
        Assert.Equal((hit.ArticleId, hit.ArticleRevision, hit.SchemaRevision, author.ValueRevision(hit.ArticleId)),
            (exact.ArticleId, exact.ArticleRevision, exact.SchemaRevision, exact.ValueRevision));
        Assert.Empty(exact.NextKey);
        var exactField = Assert.Single(exact.Fields);
        Assert.Equal((selected.Id, selected.Revision), (exactField.DefinitionId, exactField.DefinitionRevision));
        Assert.Equal(new PropertyFieldValue.Text(canonical), exactField.Value);
        var pinned = hit with { ValueRevision = exact.ValueRevision };
        Assert.Equal(canonical,
            Assert.IsType<PropertyFieldValue.Text>(Assert.Single(Wire.DecodePropertyEditor(await ReadHit(pinned, owner)).Fields).Value).Value);
        await ReadHit(hit with { SchemaRevision = stranger.SchemaRevision, DefinitionRevision = foreignField.Revision }, stranger, HttpStatusCode.NotFound);
        await ReadHit(hit with { SourceDigest = new byte[32] }, owner, HttpStatusCode.Conflict);

        var edited = Assert.Single(cohort, article => article.Id == last.Id);
        await author.Put(owner, edited, selected, new PropertyFieldValue.Text("Independently replaced"));
        await ReadHit(pinned, owner, HttpStatusCode.Conflict);
        await Reject(continuation, owner, HttpStatusCode.Conflict);
        var refreshed = await Ready(query, owner);
        Assert.Equal(cohort.Count - 1, refreshed.Total);
        Assert.DoesNotContain(refreshed.Rows, row => row.Id == last.Id);
        Assert.Empty(refreshed.NextCursor);

        await author.Put(owner, edited, selected, new PropertyFieldValue.Text(input));
        Assert.Equal(cohort.Count, (await Ready(query, owner)).Total);
        await ReadHit(pinned, owner, HttpStatusCode.Conflict);
        Assert.Equal(author.ValueRevision(hit.ArticleId), Wire.DecodePropertyEditor(await ReadHit(hit, owner)).ValueRevision);

        var beforeSortEdit = await ReadComposed(composition, owner);
        var beforeSortEditAfter = composition with { Search = composition.Search with { Cursor = beforeSortEdit.Search.NextCursor } };
        var offPage = Assert.Single((await ReadComposed(beforeSortEditAfter, owner)).Search.Rows);
        await author.Put(owner, Assert.Single(cohort, article => article.Id == offPage.Id), order, new PropertyFieldValue.Number(-100));
        await RejectComposed(beforeSortEditAfter, owner, HttpStatusCode.Conflict);
        var moved = await ReadComposed(composition, owner);
        Assert.Equal(offPage.Id, moved.Search.Rows[0].Id);
        Assert.Equal(offPage.Revision, moved.Search.Rows[0].Revision);
        Assert.Equal(offPage.SourceDigest, moved.Search.Rows[0].SourceDigest);
        RequireBooleanFacet(moved, cohort.Count - 2, falseCount: 1, trueCount: 1);

        order = await author.SetProjection(owner, order, searchable: false, sortable: false);
        await RejectComposed(composition with
        {
            Search = composition.Search with { SchemaRevision = owner.SchemaRevision },
            Sort = composition.Sort! with { DefinitionRevision = order.Revision },
        }, owner, HttpStatusCode.NotFound);

        selected = await EnableText(owner, selected, false);
        await Reject(Query(owner, selected, phrase), owner, HttpStatusCode.NotFound);
        await using var count = Store.Sql(db, null, "select count(*) from public.author_text_document where owner_id=$1", owner.Id);
        Assert.Equal(0L, Assert.IsType<long>(await count.ExecuteScalarAsync(ct)));

        selected = await EnableText(owner, selected, true);
        order = await author.SetProjection(owner, order, searchable: false, sortable: true);
        const string specialBody = "# Canopy Orbit\r\n\r\nVerified manuscript";
        const string specialSummary = "Verified star witness";
        var special = await author.Save(owner, "Mixed evidence", specialBody);
        var summary = Wire.DecodeDraft(await author.Send(WireRoutes.ArticleSummarySave,
            Wire.EncodeArticleSummaryCommand(new(special.Id, special.Revision, Guid.NewGuid(), specialSummary)), owner));
        special = special with { Revision = summary.Revision };
        await author.Put(owner, special, selected, new PropertyFieldValue.Text("Enamel vault"));

        var mixed = new AuthorTextPropertyTextMixedQuery(new($"field.title:article field.property:{phrase} status:draft",
            "", DateTimeOffset.UtcNow.AddDays(-1).ToUnixTimeMilliseconds(), null, owner.SchemaRevision, []),
            selected.Id, selected.Revision, false, new(flag.Id, flag.Revision),
            new(order.Id, order.Revision, AuthorTextPropertySortDirection.Ascending));
        var coldMixed = await ReadMixed(mixed);
        Assert.False(coldMixed.Search.Ready);
        Assert.Empty(coldMixed.Search.Rows);
        Assert.Null(coldMixed.Facet);
        var readyMixed = await ReadyMixed(mixed);
        Assert.Equal(cohort.Count, readyMixed.Search.Total);
        Assert.Equal(offPage.Id, readyMixed.Search.Rows[0].Id);
        RequireBooleanFacet(readyMixed, cohort.Count - 2, falseCount: 1, trueCount: 1);
        Assert.All(readyMixed.Search.Rows, row => RequireSource(row, 5, canonical, "Café"));
        var mixedAfter = mixed with { Search = mixed.Search with { Cursor = readyMixed.Search.NextCursor } };
        var lastMixedPage = await ReadMixed(mixedAfter);
        var lastMixed = Assert.Single(lastMixedPage.Search.Rows);
        RequireBooleanFacet(lastMixedPage, cohort.Count - 2, falseCount: 1, trueCount: 1);
        Assert.Equal(cohort.Select(article => article.Id).Order(),
            readyMixed.Search.Rows.Append(lastMixed).Select(row => row.Id).Order());
        await RejectMixed(mixedAfter with { IncludeHeading = true }, HttpStatusCode.Conflict);
        await Reject(new(mixedAfter.Search with { Query = $"field.property:{phrase}" }, selected.Id, selected.Revision),
            owner, HttpStatusCode.Conflict);

        var fromBody = await ReadyMixed(mixed with
        {
            Search = mixed.Search with { Query = "field.markdown-body:\"Independent body\" field.property:café" },
            Facet = null,
            Sort = null,
        });
        Assert.Equal(cohort.Count, fromBody.Search.Total);
        Assert.All(fromBody.Search.Rows, row => RequireSource(row, 2, "Independent body", "Independent"));
        var fromTitle = await ReadyMixed(mixed with { Search = mixed.Search with { Query = "field.title:article field.property:café" } });
        Assert.All(fromTitle.Search.Rows, row =>
        {
            var article = Assert.Single(cohort, item => item.Id == row.Id);
            RequireSource(row, 1, article.Title, "article");
        });
        var fromSummary = await ReadyMixed(mixed with
        {
            Search = mixed.Search with { Query = "field.summary:\"star witness\" field.property:enamel" },
        });
        RequireSource(Assert.Single(fromSummary.Search.Rows), 3, specialSummary, "star");
        var headingQuery = mixed with { Search = mixed.Search with { Query = "field.heading:\"canopy orbit\" field.property:enamel" } };
        await RejectMixed(headingQuery, HttpStatusCode.BadRequest);
        RequireSource(Assert.Single((await ReadyMixed(headingQuery with { IncludeHeading = true })).Search.Rows), 4, specialBody, "Canopy");

        Assert.Empty((await ReadyMixed(mixed with
        {
            Search = mixed.Search with { Query = "field.title:\"property orbit\" field.property:orbit" },
        })).Search.Rows);
        Assert.Empty((await ReadyMixed(mixed with
        {
            Search = mixed.Search with { Query = $"field.title:café field.property:{phrase}" },
        })).Search.Rows);
        await RejectMixed(mixed with { Search = mixed.Search with { Query = "field.title:article" } }, HttpStatusCode.BadRequest);
        await RejectMixed(mixed with { Search = mixed.Search with { Query = "field.property:café" } }, HttpStatusCode.BadRequest);
        var bothFiltered = await ReadyMixed(mixed with
        {
            Search = mixed.Search with { Query = $"independent field.property:{phrase}", Conditions = filtered.Search.Conditions },
        });
        Assert.Equal(cohort[0].Id, Assert.Single(bothFiltered.Search.Rows).Id);
        RequireBooleanFacet(bothFiltered, 0, falseCount: 0, trueCount: 1);

        var mixedArticle = Assert.Single(cohort, article => article.Id == lastMixed.Id);
        var articleEdit = await author.ChangeArticle(owner, ArticleAction.Save,
            new(mixedArticle.Id, mixedArticle.Revision, Guid.NewGuid(), mixedArticle.Title, "Current replacement body"));
        await RejectMixed(mixedAfter, HttpStatusCode.Conflict);
        var currentMixed = await ReadyMixed(mixed);
        var propertyAfter = mixed with { Search = mixed.Search with { Cursor = currentMixed.Search.NextCursor } };
        await author.Put(owner, articleEdit, selected, new PropertyFieldValue.Text("Replaced precise property"));
        await RejectMixed(propertyAfter, HttpStatusCode.Conflict);
        var removed = await ReadyMixed(mixed);
        Assert.Equal(cohort.Count - 1, removed.Search.Total);
        Assert.DoesNotContain(removed.Search.Rows, row => row.Id == articleEdit.Id);

        static AuthorTextPropertyTextQuery Query(Actor actor, Field field, string text) =>
            new(new(text, "", null, null, actor.SchemaRevision, []), field.Id, field.Revision);

        Task<AuthorTextFacetedPage> Ready(AuthorTextPropertyTextQuery request, Actor actor) =>
            AuthorPropertyFixture.Ready(() => Read(request, actor), page =>
            {
                if (page.Ready) return true;
                Assert.Empty(page.Rows);
                Assert.Empty(page.NextCursor);
                return false;
            }, "The fixture property index did not finish within eight requests.");

        async Task<AuthorTextFacetedPage> Read(AuthorTextPropertyTextQuery request, Actor actor) =>
            Wire.DecodeAuthorTextPropertyTextPage(await author.Send(WireRoutes.AuthorTextSearch, Wire.EncodeAuthorTextPropertyTextQuery(request), actor));

        Task<byte[]> Reject(AuthorTextPropertyTextQuery request, Actor actor, HttpStatusCode status) =>
            author.Send(WireRoutes.AuthorTextSearch, Wire.EncodeAuthorTextPropertyTextQuery(request), actor, status);

        async Task<AuthorTextPropertySortPage> ReadComposed(AuthorTextPropertyTextQualifiedQuery request, Actor actor) =>
            Wire.DecodeAuthorTextPropertyTextQualifiedPage(
                await author.Send(WireRoutes.AuthorTextSearch, Wire.EncodeAuthorTextPropertyTextQualifiedQuery(request), actor),
                expectFacet: request.Facet is not null);

        Task<byte[]> RejectComposed(AuthorTextPropertyTextQualifiedQuery request, Actor actor, HttpStatusCode status) =>
            author.Send(WireRoutes.AuthorTextSearch, Wire.EncodeAuthorTextPropertyTextQualifiedQuery(request), actor, status);

        Task<AuthorTextPropertySortPage> ReadyMixed(AuthorTextPropertyTextMixedQuery request) =>
            AuthorPropertyFixture.Ready(() => ReadMixed(request), page =>
            {
                if (page.Search.Ready) return true;
                Assert.Empty(page.Search.Rows);
                return false;
            }, "The fixture mixed index did not finish within eight requests.");

        async Task<AuthorTextPropertySortPage> ReadMixed(AuthorTextPropertyTextMixedQuery request) =>
            Wire.DecodeAuthorTextPropertyTextMixedPage(
                await author.Send(WireRoutes.AuthorTextSearch, Wire.EncodeAuthorTextPropertyTextMixedQuery(request), owner),
                includeHeading: request.IncludeHeading, expectFacet: request.Facet is not null);

        Task<byte[]> RejectMixed(AuthorTextPropertyTextMixedQuery request, HttpStatusCode status) =>
            author.Send(WireRoutes.AuthorTextSearch, Wire.EncodeAuthorTextPropertyTextMixedQuery(request), owner, status);

        static void RequireSource(AuthorTextSearchRow row, int field, string raw, string term)
        {
            var start = raw.IndexOf(term, StringComparison.Ordinal);
            Assert.True(start >= 0);
            Assert.Equal(field, row.Field);
            Assert.Equal(term, row.Snippet[row.HighlightStart..row.HighlightEnd]);
            Assert.Equal((start, start + term.Length), (row.SourceStart, row.SourceEnd));
            Assert.Equal((Encoding.UTF8.GetByteCount(raw.AsSpan(0, start)), Encoding.UTF8.GetByteCount(raw.AsSpan(0, start + term.Length))),
                (row.SourceByteStart, row.SourceByteEnd));
            Assert.Equal(SHA256.HashData(Encoding.UTF8.GetBytes(raw)), row.SourceDigest);
        }

        void RequireBooleanFacet(AuthorTextPropertySortPage page, int missing, int falseCount, int trueCount)
        {
            var facet = Assert.IsType<AuthorTextPropertyFacet>(page.Facet);
            Assert.Equal((flag.Id, flag.Revision, PropertyFieldKind.Boolean, missing, 0, 0),
                (facet.DefinitionId, facet.DefinitionRevision, facet.Kind, facet.Missing, facet.Null, facet.Empty));
            Assert.Collection(facet.Buckets,
                bucket => Assert.Equal(new AuthorTextPropertyFacetBucket(new PropertyFieldValue.Boolean(false), falseCount), bucket),
                bucket => Assert.Equal(new AuthorTextPropertyFacetBucket(new PropertyFieldValue.Boolean(true), trueCount), bucket));
        }

        Task<byte[]> ReadHit(PropertyTextHitRequest request, Actor actor, HttpStatusCode status = HttpStatusCode.OK) =>
            author.Send(WireRoutes.PropertyEditor, Wire.EncodePropertyTextHitRequest(request), actor, status);

        Task<Field> EnableText(Actor actor, Field field, bool enabled) =>
            author.SetProjection(actor, field, searchable: enabled, sortable: false);
    }
}
