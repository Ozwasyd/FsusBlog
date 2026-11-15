using System.Diagnostics;
using System.Net;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using Xunit.Abstractions;

namespace FsusBlog.V2.Integration.Tests;

public sealed class PropertyScalePostgresTests(ITestOutputHelper evidence)
{
    private const int DefinitionCount = 1_000;
    private const int ArticleCount = 10_000;
    private const string Keyword = "propertyscalejoint";

    [PostgresFact]
    public async Task ReadsAndQueriesThousandDefinitionsAcrossTenThousandOwnedArticles()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(4));
        var ct = deadline.Token;
        await using var db = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        var store = new Store(db.DataSource);
        await using var conn = await db.DataSource.OpenConnectionAsync(ct);
        var owner = await db.SignIn("Property scale author", ct);
        var outsider = await db.SignIn("Property scale outsider", ct);
        await SeedArticles();
        await using var server = await ServerProcess.Start(db.ConnectionString, ct);
        var policy = new ArticleRightsCommand(1, 1, Guid.NewGuid(), true, "CC0-1.0", "", 0, "", "", "disabled", 0, false, false, false);
        var rights = Wire.DecodeArticleRightsPolicy(await Send(WireRoutes.DraftRightsCommand, Wire.EncodeArticleRightsCommand(policy), owner));
        var target = await store.WithSession(owner.Token, true, (connection, tx, actor) =>
            Store.Execute(connection, tx, actor, ArticleAction.Publish, new(1, rights.Revision, Guid.NewGuid(), "", ""), ct), ct);
        Assert.True(target.Article.PublishedRevision.HasValue);

        var kinds = Enum.GetValues<PropertyFieldKind>();
        var red = new PropertyFieldOption(new Guid("10000000-0000-4000-8000-000000000001"), "Red");
        var blue = new PropertyFieldOption(new Guid("10000000-0000-4000-8000-000000000002"), "Blue");
        var definitions = Enumerable.Range(1, DefinitionCount).Select(_ => Guid.NewGuid()).ToArray();
        var clock = Stopwatch.StartNew();
        long schemaRevision = 0;
        for (var index = 0; index < definitions.Length; index++)
        {
            var receipt = await Change(Create(definitions[index], index), owner);
            Assert.Equal(new PropertyCommandReceipt(definitions[index], ++schemaRevision, 1), receipt);
        }
        evidence.WriteLine($"Created {DefinitionCount} definitions through the protected schema API in {clock.ElapsedMilliseconds} ms.");

        var replacement = Guid.NewGuid();
        await Send(WireRoutes.PropertySchemaCommand, Wire.EncodePropertySchemaInput(Create(replacement, DefinitionCount)), owner, HttpStatusCode.Conflict);
        var removed = definitions[^1];
        var deprecation = await Change(new(new(3, removed, Guid.NewGuid(), schemaRevision, 1, "", ""), PropertyFieldKind.Text, []), owner);
        Assert.Equal(++schemaRevision, deprecation.SchemaRevision);
        var deletion = await Change(new(new(4, removed, Guid.NewGuid(), schemaRevision, deprecation.Revision, "", ""), PropertyFieldKind.Text, []), owner);
        Assert.Equal(++schemaRevision, deletion.SchemaRevision);
        var creation = await Change(Create(replacement, DefinitionCount), owner);
        Assert.Equal(++schemaRevision, creation.SchemaRevision);
        definitions[^1] = replacement;
        var rename = await Change(new(new(2, definitions[0], Guid.NewGuid(), schemaRevision, 1, "", "Renamed scale field"), PropertyFieldKind.Text, []), owner);
        Assert.Equal(++schemaRevision, rename.SchemaRevision);

        var score = definitions[(int)PropertyFieldKind.Number];
        var gate = definitions[(int)PropertyFieldKind.Boolean];
        var category = definitions[(int)PropertyFieldKind.SingleSelect];
        var gateRevision = await EnableFilter(gate);
        var categoryRevision = await EnableFilter(category);
        var scoreCommand = new PropertyDefinitionProjectionCommand(score, Guid.NewGuid(), schemaRevision, 1, false, true);
        var scoreReceipt = Wire.DecodePropertyCommandReceipt(await Send(WireRoutes.PropertySchemaCommand,
            Wire.EncodePropertyDefinitionProjectionCommand(scoreCommand), owner));
        Assert.Equal(++schemaRevision, scoreReceipt.SchemaRevision);

        await SeedValues();
        await using (var census = Store.Sql(conn, null, """
            select count(*),count(distinct definition_id),count(distinct article_id)
            from public.property_value where owner_id=$1
            """, owner.Id))
        await using (var row = await census.ExecuteReaderAsync(ct))
        {
            Assert.True(await row.ReadAsync(ct));
            Assert.Equal((88_000L, 1_000L, 10_000L), (row.GetInt64(0), row.GetInt64(1), row.GetInt64(2)));
        }

        clock.Restart();
        var firstRequest = new PropertyWorkspaceRequest(ArticleCount, 1, 0, 0, "");
        var workspace = firstRequest;
        var fields = new List<PropertyEditorField>();
        var pages = 0;
        var maximumPayload = 0;
        do
        {
            var bytes = await Send(WireRoutes.PropertyEditor, Wire.EncodePropertyWorkspaceRequest(workspace), owner);
            maximumPayload = Math.Max(maximumPayload, bytes.Length);
            var result = Wire.DecodePropertyEditor(bytes);
            Assert.Equal((ArticleCount, 1L, schemaRevision, 1L), (result.ArticleId, result.ArticleRevision, result.SchemaRevision, result.ValueRevision));
            Assert.Equal(WireLimits.PropertyPageSize, result.Fields.Count);
            fields.AddRange(result.Fields);
            workspace = workspace with { SchemaRevision = result.SchemaRevision, ValueRevision = result.ValueRevision, AfterKey = result.NextKey };
        } while (++pages < DefinitionCount / WireLimits.PropertyPageSize && workspace.AfterKey.Length > 0);
        Assert.Equal(40, pages);
        Assert.Empty(workspace.AfterKey);
        Assert.Equal(definitions, fields.Select(field => field.DefinitionId));
        Assert.Equal("Renamed scale field", fields[0].Label);
        Assert.Equal(kinds, fields.Take(kinds.Length).Select(field => field.Kind));
        Assert.Equal(9, fields.Count(field => field.Value is not PropertyFieldValue.Missing));
        Assert.Equal(new PropertyFieldValue.Number(10_000.125m), fields[1].Value);
        Assert.Equal(new[] { 1 }, Assert.IsType<PropertyFieldValue.ArticleReference>(fields[6].Value).Value);
        evidence.WriteLine($"Read {fields.Count} definitions in {pages} editor responses in {clock.ElapsedMilliseconds} ms; max AEDS response {maximumPayload} bytes.");

        var gateTrue = new PropertyCondition(gate, gateRevision, PropertyComparison.Equal, new PropertyFieldValue.Boolean(true));
        var matchingIds = Enumerable.Range(1, ArticleCount).Where(id => id % 2 == 0).Reverse().ToArray();
        var filter = Wire.EncodePropertyArticleQueryGroup(new(schemaRevision, [gateTrue], ""));
        var filtered = Wire.DecodePropertyArticlePage(await Send(WireRoutes.PropertyArticleQuery, filter, owner));
        Assert.Equal(matchingIds.Take(WireLimits.PropertyPageSize), filtered.Rows.Select(item => item.Id));
        await Send(WireRoutes.PropertyArticleQuery, filter, outsider, HttpStatusCode.Conflict);
        await Send(WireRoutes.PropertyEditor, Wire.EncodePropertyWorkspaceRequest(firstRequest), outsider, HttpStatusCode.NotFound);

        var sorted = new AuthorTextPropertySortQuery(new(Keyword, "", null, null, schemaRevision, [gateTrue]), false,
            score, scoreReceipt.Revision, AuthorTextPropertySortDirection.Descending, new(category, categoryRevision));
        AuthorTextPropertySortPage? page = null;
        clock.Restart();
        for (var attempt = 0; attempt < 180; attempt++)
        {
            page = await ReadSorted(sorted);
            if (page.Search.Ready) break;
            await Task.Delay(TimeSpan.FromMilliseconds(250), ct);
        }
        Assert.NotNull(page);
        Assert.True(page.Search.Ready, "The genuine PostgreSQL author index did not finish rebuilding the fixture.");
        evidence.WriteLine($"Search became ready after {clock.ElapsedMilliseconds} ms; {page.Search.Total} filtered articles.");
        ConfirmSorted(page, 0);
        Assert.NotEmpty(page.Search.NextCursor);
        clock.Restart();
        ConfirmSorted(await ReadSorted(sorted with { Search = sorted.Search with { Cursor = page.Search.NextCursor } }), WireLimits.AuthorTextSearchRows);
        evidence.WriteLine($"Read the second author rank/facet page in {clock.ElapsedMilliseconds} ms.");

        PropertySchemaInput Create(Guid id, int index)
        {
            var kind = kinds[index % kinds.Length];
            return new(new(1, id, Guid.NewGuid(), schemaRevision, 0, $"scale-{index:D4}", $"Scale field {index:D4}"), kind,
                kind is PropertyFieldKind.SingleSelect or PropertyFieldKind.MultiSelect ? [red, blue] : []);
        }

        async Task<long> EnableFilter(Guid id)
        {
            var receipt = Wire.DecodePropertyCommandReceipt(await Send(WireRoutes.PropertyFilterability,
                Wire.EncodePropertyFilterabilityCommand(new(id, Guid.NewGuid(), schemaRevision, 1, true)), owner));
            Assert.Equal(++schemaRevision, receipt.SchemaRevision);
            return receipt.Revision;
        }

        async Task<PropertyCommandReceipt> Change(PropertySchemaInput input, (Guid Id, string Token, string Handle) actor) =>
            Wire.DecodePropertyCommandReceipt(await Send(WireRoutes.PropertySchemaCommand, Wire.EncodePropertySchemaInput(input), actor));

        async Task<AuthorTextPropertySortPage> ReadSorted(AuthorTextPropertySortQuery input) =>
            Wire.DecodeAuthorTextPropertySortPage(await Send(WireRoutes.AuthorTextSearch, Wire.EncodeAuthorTextPropertySortQuery(input), owner), false, true);

        void ConfirmSorted(AuthorTextPropertySortPage result, int offset)
        {
            Assert.Equal(matchingIds.Length, result.Search.Total);
            Assert.Equal(new[] { matchingIds.Length, 0, 0, 0 }, result.Search.StateCounts);
            Assert.Equal(matchingIds.Skip(offset).Take(WireLimits.AuthorTextSearchRows), result.Search.Rows.Select(item => item.Id));
            var facet = Assert.IsType<AuthorTextPropertyFacet>(result.Facet);
            Assert.Equal(matchingIds.Count(id => id % 5 == 4), facet.Missing);
            Assert.Equal(matchingIds.Count(id => id % 5 == 3), facet.Null);
            var counts = facet.Buckets.ToDictionary(bucket => Assert.IsType<PropertyFieldValue.SingleSelect>(bucket.Value).Value, bucket => bucket.Count);
            Assert.Equal(2, counts.Count);
            Assert.Equal(matchingIds.Count(id => id % 5 == 0), counts[red.Id]);
            Assert.Equal(matchingIds.Count(id => id % 5 is 1 or 2), counts[blue.Id]);
        }

        async Task<byte[]> Send(string path, byte[] packet, (Guid Id, string Token, string Handle) actor, HttpStatusCode expected = HttpStatusCode.OK)
        {
            using var request = SiteAedsFixture.Request(HttpMethod.Post, path, packet, actor.Token, actor.Handle);
            using var response = await server.Client.SendAsync(request, ct);
            var body = await response.Content.ReadAsByteArrayAsync(ct);
            Assert.True(response.StatusCode == expected, $"{path}: expected {(int)expected}, got {(int)response.StatusCode}");
            Assert.True(response.Headers.CacheControl?.NoStore);
            return body;
        }

        async Task SeedArticles()
        {
            Assert.Equal(ArticleCount + 1, await FixtureSql.ExecuteAsync(conn, null, ct, """
                with inserted as (
                    insert into public.article(id,owner_id,revision,title,body,deleted,created_at,updated_at) overriding system value
                    select n,case when n<=$3 then $1::uuid else $2::uuid end,1,'Scale draft '||n,
                        E'## propertyscalejoint\n\nPrivate scale corpus',false,
                        timestamptz '2026-01-01 00:00+00'+n*interval '1 second',
                        timestamptz '2026-01-01 00:00+00'+n*interval '1 second'
                    from generate_series(1,$3+1) n returning id,revision,title,body,created_at
                )
                insert into public.article_revision(article_id,revision,title,body,happened_at)
                select id,revision,title,body,created_at from inserted
                """, owner.Id, outsider.Id, ArticleCount));
        }

        async Task SeedValues()
        {
            // The cap test replaces the last URL definition with a Text definition. Its seed type follows the replacement.
            await using var tx = await conn.BeginTransactionAsync(ct);
            Assert.Equal(ArticleCount, await FixtureSql.ExecuteAsync(conn, tx, ct, """
                insert into public.property_article(article_id,owner_id,revision)
                select id,owner_id,1 from public.article where owner_id=$1
                """, owner.Id));
            Assert.Equal(88_000, await FixtureSql.ExecuteAsync(conn, tx, ct, """
                with defs as (select id, n::integer from unnest($2::uuid[]) with ordinality as f(id,n)),
                entries as (
                    select a.article_id as id, f.id as definition, (case when f.n=1000 then 0 else (f.n-1)%8 end) as kind,
                           (case when a.article_id=1 then 2 else 1 end) as ref
                    from public.property_article a join defs f on f.n<=8 or f.n=9+(a.article_id-1)%992
                    where a.owner_id=$1
                )
                insert into public.property_value(article_id,owner_id,definition_id,data,references_ids)
                select id,$1,definition,case kind
                    when 0 then jsonb_build_object('$type','text','Value','Scale note '||id)
                    when 1 then jsonb_build_object('$type','number','Value',id+0.125)
                    when 2 then jsonb_build_object('$type','boolean','Value',id%2=0)
                    when 3 then jsonb_build_object('$type','date','Value','2026-01-01T00:00:00+00:00')
                    when 4 then case when id%5=3 then jsonb_build_object('$type','null') else
                        jsonb_build_object('$type','single-select','OptionId',case when id%5=0 then $3::uuid else $4::uuid end) end
                    when 5 then jsonb_build_object('$type','multi-select','OptionIds',jsonb_build_array($3::uuid,$4::uuid))
                    when 6 then jsonb_build_object('$type','article-reference','ArticleIds',jsonb_build_array(ref))
                    when 7 then jsonb_build_object('$type','url','Value','https://example.test/draft/'||id)
                end, case when kind=6 then array[ref] else '{}'::integer[] end
                from entries where kind<>4 or id%5<>4 or definition<>$5::uuid
                """, owner.Id, definitions, red.Id, blue.Id, category));
            await tx.CommitAsync(ct);
        }
    }
}
