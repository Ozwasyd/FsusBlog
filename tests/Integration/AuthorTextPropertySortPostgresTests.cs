using static FsusBlog.V2.Integration.Tests.AuthorPropertyFixture;

namespace FsusBlog.V2.Integration.Tests;

public sealed class AuthorTextPropertySortPostgresTests
{
    private const string Keyword = "sortprobe";
    private const int CohortSize = 30;

    [PostgresFact]
    public async Task TypedOrderingUsesExactVisibleValuesAndBindsTheWholeCohortToTheCursor()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var owner = await SignIn(fixture, "Sort owner", ct);
        var outsider = await SignIn(fixture, "Sort outsider", ct);
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);
        var author = new AuthorPropertyFixture(fixture, server.Client, ct);

        var number = await author.Create(owner, "ranking", PropertyFieldKind.Number);
        number = await author.SetProjection(owner, number, searchable: false, sortable: true);
        var flag = await author.Create(owner, "flag", PropertyFieldKind.Boolean);
        flag = await author.SetFilterable(owner, flag);
        flag = await author.SetProjection(owner, flag, searchable: false, sortable: true);
        var disabled = await author.Create(owner, "disabled", PropertyFieldKind.Number);
        disabled = await author.SetFilterable(owner, disabled);
        disabled = await author.SetProjection(owner, disabled, searchable: true, sortable: false);
        var retired = await author.Create(owner, "retired", PropertyFieldKind.Number);
        retired = await author.SetProjection(owner, retired, searchable: false, sortable: true);
        retired = await author.ChangeDefinition(owner, 3, retired.Id, retired.Revision);
        var outsiderNumber = await author.Create(outsider, "ranking", PropertyFieldKind.Number, number.Id);
        outsiderNumber = await author.SetProjection(outsider, outsiderNumber, searchable: false, sortable: true);
        await author.Create(outsider, "other", PropertyFieldKind.Boolean);

        var members = new Member[CohortSize];
        var oldAt = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        for (var index = 0; index < members.Length; index++)
        {
            bool bodyOnly = index == 10;
            var article = await author.Save(owner, bodyOnly ? $"Body match {index}" : $"{Keyword} title {index}",
                bodyOnly ? $"The {Keyword} body is indexed" : "Other body");
            var at = index is 8 or 10 ? oldAt.AddDays(1) : oldAt;
            var member = new Member(article, bodyOnly, at, NumberAt(index), FlagAt(index));
            members[index] = member;
            await PutIfPresent(owner, article, number, member.Number);
            await PutIfPresent(owner, article, flag, member.Flag);
        }
        foreach (var group in members.GroupBy(member => member.UpdatedAt))
            Assert.Equal(group.Count(), await author.Execute("update public.article set updated_at=$1 where id=any($2)",
                group.Key, group.Select(member => member.Article.Id).ToArray()));

        var unrelated = await author.Save(owner, "Independent subject", "Independent body");
        await author.Put(owner, unrelated, number, new PropertyFieldValue.Number(-200));
        var deleted = await author.Save(owner, $"{Keyword} deleted", "Other body");
        await author.Put(owner, deleted, number, new PropertyFieldValue.Number(-300));
        await author.ChangeArticle(owner, ArticleAction.Delete, new(deleted.Id, deleted.Revision, Guid.NewGuid(), "", ""));
        var foreign = await author.Save(outsider, $"{Keyword} foreign", "Other body");
        await author.Put(outsider, foreign, outsiderNumber, new PropertyFieldValue.Number(-400));

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
        var before = await author.ArticleStamp(moved.Article.Id);
        var replacement = new PropertyFieldValue.Number(-100);
        await author.Put(owner, moved.Article, number, replacement);
        Assert.Equal(before, await author.ArticleStamp(moved.Article.Id));
        await Reject(continuation, owner, HttpStatusCode.Conflict);
        members[Array.IndexOf(members, moved)] = moved with { Number = replacement };
        var after = await VerifyPages(ascending, owner, Expect(members, member => member.Number, ascending.Direction));
        Assert.Equal(moved.Article.Id, after.Search.Rows[0].Id);

        number = await author.SetProjection(owner, number, searchable: true, sortable: false);
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

        Task<AuthorTextPropertySortPage> Ready(AuthorTextPropertySortQuery query, Actor actor) =>
            ReadyWithFacet(() => Read(query, actor), page => (page.Search, page.Facet));

        async Task<AuthorTextPropertySortPage> Read(AuthorTextPropertySortQuery query, Actor actor) =>
            Wire.DecodeAuthorTextPropertySortPage(
                await author.Send(WireRoutes.AuthorTextSearch, Wire.EncodeAuthorTextPropertySortQuery(query), actor),
                includeHeading: query.IncludeHeading, expectFacet: query.Facet is not null);

        Task<byte[]> Reject(AuthorTextPropertySortQuery query, Actor actor, HttpStatusCode status) =>
            author.Send(WireRoutes.AuthorTextSearch, Wire.EncodeAuthorTextPropertySortQuery(query), actor, status);

        Task PutIfPresent(Actor actor, ArticleState article, Field field, PropertyFieldValue value) =>
            value is PropertyFieldValue.Missing ? Task.CompletedTask : author.Put(actor, article, field, value);

    }

    private static AuthorTextPropertySortQuery Continue(AuthorTextPropertySortQuery query, string cursor) =>
        query with { Search = query.Search with { Cursor = cursor } };

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
}
