using System.Net;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;

namespace FsusBlog.V2.Integration.Tests;

public sealed class AuthorTextPropertySortPostgresTests
{
    private const string Keyword = "sortprobe";
    private const int CohortSize = 30;

    [PostgresFact]
    public async Task TypedOrderingUsesExactVisibleValuesAndBindsTheWholeCohortToTheCursor()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        var store = new Store(fixture.DataSource);
        var owner = await Login("Sort owner");
        var outsider = await Login("Sort outsider");
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);

        var number = await Create(owner, "ranking", PropertyFieldKind.Number);
        number = await SetProjection(owner, number, searchable: false, sortable: true);
        var flag = await Create(owner, "flag", PropertyFieldKind.Boolean);
        flag = await SetFilterable(owner, flag);
        flag = await SetProjection(owner, flag, searchable: false, sortable: true);
        var disabled = await Create(owner, "disabled", PropertyFieldKind.Number);
        disabled = await SetFilterable(owner, disabled);
        disabled = await SetProjection(owner, disabled, searchable: true, sortable: false);
        var retired = await Create(owner, "retired", PropertyFieldKind.Number);
        retired = await SetProjection(owner, retired, searchable: false, sortable: true);
        retired = await ChangeDefinition(owner, 3, retired.Id, retired.Revision);
        var outsiderNumber = await Create(outsider, "ranking", PropertyFieldKind.Number, number.Id);
        outsiderNumber = await SetProjection(outsider, outsiderNumber, searchable: false, sortable: true);
        await Create(outsider, "other", PropertyFieldKind.Boolean);

        var members = new Member[CohortSize];
        var valueRevisions = new Dictionary<int, long>();
        var oldAt = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        for (var index = 0; index < members.Length; index++)
        {
            bool bodyOnly = index == 10;
            var article = await Save(owner, bodyOnly ? $"Body match {index}" : $"{Keyword} title {index}",
                bodyOnly ? $"The {Keyword} body is indexed" : "Other body");
            var at = index is 8 or 10 ? oldAt.AddDays(1) : oldAt;
            var member = new Member(article, bodyOnly, at, NumberAt(index), FlagAt(index));
            members[index] = member;
            await PutIfPresent(owner, article, number, member.Number);
            await PutIfPresent(owner, article, flag, member.Flag);
        }
        foreach (var group in members.GroupBy(member => member.UpdatedAt))
            Assert.Equal(group.Count(), await Execute("update public.article set updated_at=$1 where id=any($2)",
                group.Key, group.Select(member => member.Article.Id).ToArray()));

        var unrelated = await Save(owner, "Independent subject", "Independent body");
        await Put(owner, unrelated, number, new PropertyFieldValue.Number(-200));
        var deleted = await Save(owner, $"{Keyword} deleted", "Other body");
        await Put(owner, deleted, number, new PropertyFieldValue.Number(-300));
        await ChangeArticle(owner, ArticleAction.Delete, new(deleted.Id, deleted.Revision, Guid.NewGuid(), "", ""));
        var foreign = await Save(outsider, $"{Keyword} foreign", "Other body");
        await Put(outsider, foreign, outsiderNumber, new PropertyFieldValue.Number(-400));

        var ascending = Query(owner, number, AuthorTextPropertySortDirection.Ascending);
        var descending = ascending with { Direction = AuthorTextPropertySortDirection.Descending };
        var ascendingRows = Expect(members, member => member.Number, ascending.Direction);
        var descendingRows = Expect(members, member => member.Number, descending.Direction);
        // A long exact-equality run straddles the keyset boundary in both directions.
        Assert.Equal(ascendingRows[19].Number, ascendingRows[20].Number);
        Assert.Equal(descendingRows[19].Number, descendingRows[20].Number);
        var first = await VerifyPages(ascending, owner, ascendingRows);
        await VerifyPages(descending, owner, descendingRows);
        var continuation = Continue(ascending, first.Search.NextCursor);
        await Reject(continuation with { Direction = descending.Direction }, owner, HttpStatusCode.Conflict);
        await Reject(continuation with { DefinitionId = flag.Id, DefinitionRevision = flag.Revision }, owner, HttpStatusCode.Conflict);
        await Reject(continuation with { Facet = new(flag.Id, flag.Revision) }, owner, HttpStatusCode.Conflict);
        await Reject(continuation, outsider, HttpStatusCode.Conflict);

        var flagSort = Query(owner, flag, AuthorTextPropertySortDirection.Ascending);
        await VerifyPages(flagSort, owner, Expect(members, member => member.Flag, flagSort.Direction));
        flagSort = flagSort with { Direction = AuthorTextPropertySortDirection.Descending };
        await VerifyPages(flagSort, owner, Expect(members, member => member.Flag, flagSort.Direction));

        var withFacet = ascending with { Facet = new(flag.Id, flag.Revision) };
        await VerifyPages(withFacet, owner, ascendingRows, page => RequireFlagFacet(page, flag, 7, 5, 9, 9));
        var condition = new PropertyCondition(flag.Id, flag.Revision, PropertyComparison.IsPresent, new PropertyFieldValue.Missing());
        var filtered = withFacet with { Search = withFacet.Search with { Conditions = [condition] } };
        await VerifyPages(filtered, owner, ascendingRows.Where(member => member.Flag is PropertyFieldValue.Boolean).ToArray(),
            page => RequireFlagFacet(page, flag, 0, 0, 9, 9));

        var foreignPage = await Ready(Query(outsider, outsiderNumber, descending.Direction), outsider);
        Assert.Equal(1, foreignPage.Search.Total);
        Assert.Equal(foreign.Id, Assert.Single(foreignPage.Search.Rows).Id);
        await Reject(Query(outsider, flag, ascending.Direction), outsider, HttpStatusCode.NotFound);
        await Reject(Query(owner, disabled, ascending.Direction), owner, HttpStatusCode.NotFound);
        await Reject(Query(owner, retired, ascending.Direction), owner, HttpStatusCode.NotFound);
        await Reject(ascending with { DefinitionRevision = number.Revision - 1 }, owner, HttpStatusCode.Conflict);
        await Reject(ascending with { Search = ascending.Search with { SchemaRevision = owner.SchemaRevision - 1 } }, owner, HttpStatusCode.Conflict);

        // Moving a previously missing off-page value leaves the article source revision and rank clock intact.
        var moved = ascendingRows[^1];
        Assert.IsType<PropertyFieldValue.Missing>(moved.Number);
        var before = await ArticleStamp(moved.Article.Id);
        var replacement = new PropertyFieldValue.Number(-100);
        await Put(owner, moved.Article, number, replacement);
        Assert.Equal(before, await ArticleStamp(moved.Article.Id));
        await Reject(continuation, owner, HttpStatusCode.Conflict);
        members[Array.IndexOf(members, moved)] = moved with { Number = replacement };
        var after = await VerifyPages(ascending, owner, Expect(members, member => member.Number, ascending.Direction));
        Assert.Equal(moved.Article.Id, after.Search.Rows[0].Id);

        number = await SetProjection(owner, number, searchable: true, sortable: false);
        await Reject(Continue(ascending, after.Search.NextCursor), owner, HttpStatusCode.Conflict);
        await Reject(Query(owner, number, ascending.Direction), owner, HttpStatusCode.NotFound);

        AuthorTextPropertySortQuery Query(Actor actor, Field field, AuthorTextPropertySortDirection direction) =>
            new(new(Keyword, "", null, null, actor.SchemaRevision, []), false, field.Id, field.Revision, direction, null);

        async Task<AuthorTextPropertySortPage> VerifyPages(AuthorTextPropertySortQuery query, Actor actor, IReadOnlyList<Member> expected,
            Action<AuthorTextPropertySortPage>? verifyFacet = null)
        {
            var page = await Ready(query, actor);
            Assert.Equal(expected.Count, page.Search.Total);
            Assert.Equal(new[] { expected.Count, 0, 0, 0 }, page.Search.StateCounts);
            Assert.Equal(expected.Take(WireLimits.AuthorTextSearchRows).Select(member => member.Article.Id), page.Search.Rows.Select(row => row.Id));
            verifyFacet?.Invoke(page);
            if (expected.Count <= WireLimits.AuthorTextSearchRows)
            {
                Assert.Empty(page.Search.NextCursor);
                return page;
            }
            Assert.NotEmpty(page.Search.NextCursor);
            var next = await Read(Continue(query, page.Search.NextCursor), actor);
            Assert.True(next.Search.Ready);
            Assert.Equal(page.Search.Total, next.Search.Total);
            Assert.Equal(page.Search.StateCounts, next.Search.StateCounts);
            Assert.Empty(next.Search.NextCursor);
            Assert.Equal(expected.Skip(WireLimits.AuthorTextSearchRows).Select(member => member.Article.Id), next.Search.Rows.Select(row => row.Id));
            verifyFacet?.Invoke(next);
            return page;
        }

        async Task<AuthorTextPropertySortPage> Ready(AuthorTextPropertySortQuery query, Actor actor)
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

        async Task<AuthorTextPropertySortPage> Read(AuthorTextPropertySortQuery query, Actor actor) =>
            Wire.DecodeAuthorTextPropertySortPage(
                await Send(WireRoutes.AuthorTextSearch, Wire.EncodeAuthorTextPropertySortQuery(query), actor),
                includeHeading: query.IncludeHeading, expectFacet: query.Facet is not null);

        Task<byte[]> Reject(AuthorTextPropertySortQuery query, Actor actor, HttpStatusCode status) =>
            Send(WireRoutes.AuthorTextSearch, Wire.EncodeAuthorTextPropertySortQuery(query), actor, status);

        Task<byte[]> Send(string route, byte[] wire, Actor actor, HttpStatusCode status = HttpStatusCode.OK) =>
            SiteAedsFixture.ExpectPrivate(server.Client, HttpMethod.Post, route, wire, actor.Token, actor.Handle, status, ct);

        async Task<Actor> Login(string name)
        {
            var (_, token, handle) = await fixture.SignIn(name, ct);
            return new(token, handle);
        }

        Task<Field> Create(Actor actor, string key, PropertyFieldKind kind, Guid? id = null) =>
            ChangeDefinition(actor, 1, id ?? Guid.NewGuid(), 0, key, kind);

        async Task<Field> ChangeDefinition(Actor actor, int operation, Guid id, long revision, string key = "", PropertyFieldKind kind = PropertyFieldKind.Text)
        {
            var data = Wire.EncodePropertySchemaInput(new(new(operation, id, Guid.NewGuid(), actor.SchemaRevision, revision, key, key), kind, []));
            return AdvanceDefinition(actor, new(id, revision), await Send(WireRoutes.PropertySchemaCommand, data, actor));
        }

        async Task<Field> SetProjection(Actor actor, Field field, bool searchable, bool sortable)
        {
            var data = Wire.EncodePropertyDefinitionProjectionCommand(new(field.Id, Guid.NewGuid(), actor.SchemaRevision, field.Revision, searchable, sortable));
            return AdvanceDefinition(actor, field, await Send(WireRoutes.PropertySchemaCommand, data, actor));
        }

        async Task<Field> SetFilterable(Actor actor, Field field)
        {
            var data = Wire.EncodePropertyFilterabilityCommand(new(field.Id, Guid.NewGuid(), actor.SchemaRevision, field.Revision, true));
            return AdvanceDefinition(actor, field, await Send(WireRoutes.PropertyFilterability, data, actor));
        }

        Task PutIfPresent(Actor actor, ArticleState article, Field field, PropertyFieldValue value) =>
            value is PropertyFieldValue.Missing ? Task.CompletedTask : Put(actor, article, field, value);

        async Task Put(Actor actor, ArticleState article, Field field, PropertyFieldValue value)
        {
            var old = valueRevisions.GetValueOrDefault(article.Id);
            var wire = Wire.EncodePropertyValueInput(new(article.Id, article.Revision, actor.SchemaRevision, old, field.Id, field.Revision, Guid.NewGuid(), value));
            var receipt = Wire.DecodePropertyCommandReceipt(await Send(WireRoutes.PropertyValueCommand, wire, actor));
            Assert.Equal(new PropertyCommandReceipt(field.Id, actor.SchemaRevision, old + 1), receipt);
            valueRevisions[article.Id] = receipt.Revision;
        }

        Task<ArticleState> Save(Actor actor, string title, string body) =>
            ChangeArticle(actor, ArticleAction.Save, new(0, 0, Guid.NewGuid(), title, body));

        async Task<ArticleState> ChangeArticle(Actor actor, ArticleAction action, Edit edit) =>
            (await store.WithSession(actor.Token, true, (db, tx, identity) => Store.Execute(db, tx, identity, action, edit, ct), ct)).Article;

        async Task<(long Revision, DateTime Updated)> ArticleStamp(int id)
        {
            await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
            await using var command = Store.Sql(db, null, "select revision,updated_at from public.article where id=$1", id);
            await using var row = await command.ExecuteReaderAsync(ct);
            Assert.True(await row.ReadAsync(ct));
            return (row.GetInt64(0), row.GetDateTime(1));
        }

        async Task<int> Execute(string sql, params object[] args)
        {
            await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
            await using var command = Store.Sql(db, null, sql, args);
            return await command.ExecuteNonQueryAsync(ct);
        }
    }

    private static AuthorTextPropertySortQuery Continue(AuthorTextPropertySortQuery query, string cursor) =>
        query with { Search = query.Search with { Cursor = cursor } };

    private static Field AdvanceDefinition(Actor actor, Field field, byte[] wire)
    {
        var receipt = Wire.DecodePropertyCommandReceipt(wire);
        Assert.Equal(new PropertyCommandReceipt(field.Id, actor.SchemaRevision + 1, field.Revision + 1), receipt);
        actor.SchemaRevision = receipt.SchemaRevision;
        return field with { Revision = receipt.Revision };
    }

    private static PropertyFieldValue NumberAt(int index) => index switch
    {
        0 or 28 => new PropertyFieldValue.Missing(),
        1 or 29 => new PropertyFieldValue.Null(),
        2 => new PropertyFieldValue.Number(9_007_199_254_740_992.001m),
        3 => new PropertyFieldValue.Number(9_007_199_254_740_992.002m),
        4 => new PropertyFieldValue.Number(0),
        5 => new PropertyFieldValue.Number(-4),
        6 => new PropertyFieldValue.Number(12),
        7 => new PropertyFieldValue.Number(2),
        _ => new PropertyFieldValue.Number(4),
    };

    private static PropertyFieldValue FlagAt(int index) => index switch
    {
        < 9 => new PropertyFieldValue.Boolean(true),
        < 18 => new PropertyFieldValue.Boolean(false),
        < 25 => new PropertyFieldValue.Missing(),
        _ => new PropertyFieldValue.Null(),
    };

    private static Member[] Expect(IEnumerable<Member> members, Func<Member, PropertyFieldValue> read, AuthorTextPropertySortDirection direction) =>
        members.OrderBy(member => read(member) switch
        {
            PropertyFieldValue.Null => 1,
            PropertyFieldValue.Missing => 2,
            _ => 0,
        }).ThenBy(member => (direction == AuthorTextPropertySortDirection.Ascending ? 1m : -1m) * (read(member) switch
        {
            PropertyFieldValue.Number number => number.Value,
            PropertyFieldValue.Boolean flag => flag.Value ? 1m : 0m,
            PropertyFieldValue.Null or PropertyFieldValue.Missing => 0m,
            _ => throw new InvalidOperationException("The fixture expected a number or Boolean."),
        })).ThenBy(member => member.BodyOnly).ThenByDescending(member => member.UpdatedAt).ThenBy(member => member.Article.Id).ToArray();

    private static void RequireFlagFacet(AuthorTextPropertySortPage page, Field flag, int missing, int nil, int falseCount, int trueCount)
    {
        var facet = Assert.IsType<AuthorTextPropertyFacet>(page.Facet);
        Assert.Equal((flag.Id, flag.Revision, PropertyFieldKind.Boolean, missing, nil, 0),
            (facet.DefinitionId, facet.DefinitionRevision, facet.Kind, facet.Missing, facet.Null, facet.Empty));
        Assert.Equal(new[]
        {
            new AuthorTextPropertyFacetBucket(new PropertyFieldValue.Boolean(false), falseCount),
            new AuthorTextPropertyFacetBucket(new PropertyFieldValue.Boolean(true), trueCount),
        }, facet.Buckets);
    }

    private sealed record Member(ArticleState Article, bool BodyOnly, DateTime UpdatedAt, PropertyFieldValue Number, PropertyFieldValue Flag);
    private sealed record Field(Guid Id, long Revision);
    private sealed record Actor(string Token, string Handle)
    {
        internal long SchemaRevision { get; set; }
    }
}
