using System.Net;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Administration;
using FsusBlog.V2.Server.Passkeys;
using Microsoft.AspNetCore.WebUtilities;
using static FsusBlog.V2.Integration.Tests.AuthorPropertyFixture;

namespace FsusBlog.V2.Integration.Tests;

public sealed class AuthorTextPropertyFacetPostgresTests
{
    private const string Keyword = "facetprobe";

    [PostgresFact]
    public async Task FacetsUseTheEntireFilteredOwnedMatchSetAndWitnessValueChanges()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        var owner = await SignIn(fixture, "Facet owner", ct);
        var outsider = await SignIn(fixture, "Facet outsider", ct);
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);
        var author = new AuthorPropertyFixture(fixture, server.Client, ct);

        var red = Guid.Parse("00000000-0000-4000-8000-000000000001");
        var blue = Guid.Parse("00000000-0000-4000-8000-000000000002");
        var unused = Guid.Parse("00000000-0000-4000-8000-000000000003");
        PropertyFieldOption[] options = [new(unused, "Unused"), new(blue, "Blue"), new(red, "Red")];
        var flag = await Define(owner, "flag", PropertyFieldKind.Boolean);
        var multi = await Define(owner, "choices", PropertyFieldKind.MultiSelect, options);
        var single = await Define(owner, "choice", PropertyFieldKind.SingleSelect, options);
        var disabled = await Define(owner, "disabled", PropertyFieldKind.Boolean, enabled: false);
        var deprecated = await Define(owner, "deprecated", PropertyFieldKind.Boolean);
        await author.ChangeDefinition(owner, 3, deprecated.Id, deprecated.Revision);
        var unsupported = await Define(owner, "text", PropertyFieldKind.Text);
        // Reuse the UUID across two schemas. Both the definition and value must stay owner-scoped.
        var outsiderFlag = await Define(outsider, "flag", PropertyFieldKind.Boolean, id: flag.Id);

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
        RequireFacet(first, flag, PropertyFieldKind.Boolean, 4, 3, 0, Bool(false, 7), Bool(true, 10));

        var continuation = request with { Search = request.Search with { Cursor = first.Search.NextCursor } };
        var tail = await Read(continuation, owner);
        Assert.True(tail.Search.Ready);
        Assert.Equal(matches, tail.Search.Total);
        Assert.Empty(tail.Search.NextCursor);
        RequireFacet(tail, flag, PropertyFieldKind.Boolean, 4, 3, 0, Bool(false, 7), Bool(true, 10));
        var seen = first.Search.Rows.Concat(tail.Search.Rows).ToArray();
        Assert.Equal(articles.Select(row => row.Id).Order(), seen.Select(row => row.Id).Order());
        Assert.Equal(new[] { 1, 2 }, seen.Select(row => row.Field).Distinct().Order());
        Assert.DoesNotContain(seen, row => row.Id == archived.Id || row.Id == deleted.Id || row.Id == foreign.Id || row.Id == nonmatch.Id);

        var multiPage = await Ready(Query(owner, multi), owner);
        Assert.Equal(matches, multiPage.Search.Total);
        RequireFacet(multiPage, multi, PropertyFieldKind.MultiSelect, 4, 4, 4, Choice(red, 8), Choice(blue, 8), Choice(unused, 0));
        var singlePage = await Ready(Query(owner, single), owner);
        Assert.Equal(matches, singlePage.Search.Total);
        RequireFacet(singlePage, single, PropertyFieldKind.SingleSelect, 20, 1, 0, Choice(red, 2), Choice(blue, 1), Choice(unused, 0));

        var alternatives = new PropertyCondition(multi.Id, multi.Revision, PropertyComparison.MultiSelectAnyOf,
            new PropertyFieldValue.MultiSelect([blue, red]));
        var filtered = await Ready(Query(owner, flag, alternatives), owner);
        Assert.Equal(12, filtered.Search.Total);
        Assert.Equal(articles.Where((_, i) => i % 6 < 3).Select(row => row.Id).Order(),
            filtered.Search.Rows.Select(row => row.Id).Order());
        RequireFacet(filtered, flag, PropertyFieldKind.Boolean, 3, 0, 0, Bool(false, 3), Bool(true, 6));
        var onlyFalse = new PropertyCondition(flag.Id, flag.Revision, PropertyComparison.Equal, new PropertyFieldValue.Boolean(false));
        var filteredMulti = await Ready(Query(owner, multi, onlyFalse), owner);
        Assert.Equal(7, filteredMulti.Search.Total);
        Assert.Equal(articles.Skip(10).Take(7).Select(row => row.Id), filteredMulti.Search.Rows.Select(row => row.Id).Order());
        RequireFacet(filteredMulti, multi, PropertyFieldKind.MultiSelect, 2, 1, 1, Choice(red, 2), Choice(blue, 2), Choice(unused, 0));

        var outsiderPage = await Ready(Query(outsider, outsiderFlag), outsider);
        Assert.Equal(foreign.Id, Assert.Single(outsiderPage.Search.Rows).Id);
        RequireFacet(outsiderPage, outsiderFlag, PropertyFieldKind.Boolean, 0, 0, 0, Bool(false, 1), Bool(true, 0));
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

        async Task<Field> Define(Actor actor, string name, PropertyFieldKind kind, PropertyFieldOption[]? choices = null,
            bool enabled = true, Guid? id = null)
        {
            var field = await author.Create(actor, name, kind, id, choices);
            return enabled ? await author.SetFilterable(actor, field) : field;
        }

        AuthorTextPropertyFacetQuery Query(Actor actor, Field field, params PropertyCondition[] conditions) =>
            new(new(Keyword, "", null, null, actor.SchemaRevision, conditions), false, field.Id, field.Revision);

        async Task<AuthorTextPropertyFacetPage> Ready(AuthorTextPropertyFacetQuery query, Actor actor)
        {
            for (var attempt = 0; attempt < 8; attempt++)
            {
                var page = await Read(query, actor);
                if (page.Search.Ready) return page;
                Assert.Null(page.Facet);
                Assert.Empty(page.Search.Rows);
                Assert.Empty(page.Search.NextCursor);
                Assert.Equal(0, page.Search.Total);
            }
            throw new InvalidOperationException("The fixture search index did not finish within eight requests.");
        }

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
            await using var conn = await fixture.DataSource.OpenConnectionAsync(ct);
            await using var coordinate = Store.Sql(conn, null,
                "select publication_id from public.article_publication where article_id=$1 and revision=$2", draft.Id, published.Revision);
            var release = Assert.IsType<long>(await coordinate.ExecuteScalarAsync(ct));
            var intent = new AdminArticleArchiveIntent(draft.Id, published.Revision, release, original.Revision,
                Guid.NewGuid(), "Archive the matched private facet fixture", Wire.AdminArticleArchiveStatus);
            var admin = Guid.NewGuid();
            var token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
            var digest = Store.TokenDigest(token)!;
            await author.Execute("""
                with principal as (
                    insert into public.admin_principal(id,handle,user_handle,enabled,generation)
                    values($1,'facet-fixture-admin',$2,true,1) returning id
                ), credential as (
                    insert into public.admin_passkey_credential(credential_id,principal_id,public_key,sign_count,backup_eligible,backed_up)
                    select $3,id,decode('01','hex'),0,false,false from principal
                ), permissions as (
                    insert into public.admin_permission(principal_id,permission)
                    select id,permission from principal cross join (values ('admin.manage'),('article.write')) grants(permission)
                )
                insert into public.admin_session(digest,principal_id,generation,expires_at)
                select $4,id,1,clock_timestamp()+interval '2 minutes' from principal
                """, admin, RandomNumberGenerator.GetBytes(32), RandomNumberGenerator.GetBytes(32), digest);
            var proof = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
            await author.Execute("""
                insert into public.admin_article_rollback_step_up
                    (digest,principal_id,session_digest,generation,action,body_digest,expires_at,kind)
                values($1,$2,$3,1,8,$4,clock_timestamp()+interval '45 seconds',2)
                """, SHA256.HashData(Encoding.ASCII.GetBytes(proof)), admin, digest, AdminPasskeyStore.ArticleArchiveIntentDigest(intent));
            var archives = new AdminPasskeyStore(fixture.DataSource, null, new PasskeyConfiguration(new Uri("https://localhost"), "localhost"));
            var receipt = await archives.ExecuteArticleArchive(token, proof, intent, () => { }, ct);
            Assert.Equal((draft.Id, published.Revision + 1, Wire.AdminArticleArchiveStatus), (receipt.ArticleId, receipt.Revision, receipt.TargetStatus));
        }

    }

    private static void RequireFlags(AuthorTextPropertyFacetPage page, Field flag, IEnumerable<PropertyFieldValue> entries)
    {
        var values = entries.ToArray();
        RequireFacet(page, flag, PropertyFieldKind.Boolean,
            values.Count(v => v is PropertyFieldValue.Missing), values.Count(v => v is PropertyFieldValue.Null), 0,
            Bool(false, values.Count(v => v is PropertyFieldValue.Boolean { Value: false })),
            Bool(true, values.Count(v => v is PropertyFieldValue.Boolean { Value: true })));
    }

    private static void RequireFacet(AuthorTextPropertyFacetPage page, Field field, PropertyFieldKind kind, int missing, int nil,
        int empty, params AuthorTextPropertyFacetBucket[] buckets)
    {
        var facet = Assert.IsType<AuthorTextPropertyFacet>(page.Facet);
        Assert.Equal((field.Id, field.Revision, kind, missing, nil, empty),
            (facet.DefinitionId, facet.DefinitionRevision, facet.Kind, facet.Missing, facet.Null, facet.Empty));
        Assert.Equal(buckets, facet.Buckets);
    }

    private static AuthorTextPropertyFacetBucket Bool(bool value, int count) => new(new PropertyFieldValue.Boolean(value), count);
    private static AuthorTextPropertyFacetBucket Choice(Guid id, int count) => new(new PropertyFieldValue.SingleSelect(id), count);

}
