namespace FsusBlog.V2.Integration.Tests;

public sealed class PublicListPaginationTests
{
    private static readonly DateTimeOffset Epoch = DateTimeOffset.UnixEpoch.AddDays(10);

    [Fact]
    public void TraversesStableKeysetAndRanksExactPrefixContainsAndSummary()
    {
        var articles = new[]
        {
            ArticleAt(1, "other", 5, "fox"),
            ArticleAt(2, "a fox", 4),
            ArticleAt(3, "fox tail", 3),
            ArticleAt(4, "fox", 2),
            ArticleAt(5, "fox hunt", 3),
            ArticleAt(6, "Fox", 6, body: "fox"),
        };
        var pager = new PublicListProjection(7, articles, new PublicListCursor(TimeProvider.System));

        var latest = Read(pager, new("home", 1, 2, "", PublicListSort.Latest, null));
        Assert.Equal(new[] { 6, 1 }, latest.Ids);
        Assert.Equal(6, latest.Total);

        var query = PublicListQuery.Parse("home", 1, 2, " fox ", null, null);
        var first = Read(pager, query);
        Assert.Equal(new[] { 4, 5 }, first.Ids);
        Assert.Equal(5, first.Total);
        var second = Read(pager, query with { Page = 2, Cursor = first.Cursor });
        Assert.Equal(new[] { 3, 2 }, second.Ids);
        var third = Read(pager, query with { Page = 3, Cursor = second.Cursor });
        Assert.Equal(new[] { 1 }, third.Ids);
        Assert.Null(third.Cursor);
    }

    [Fact]
    public void RejectsTamperedMismatchedExpiredAndPriorProcessCursors()
    {
        var clock = new TestTime();
        var codec = new PublicListCursor(clock);
        var articles = new[] { ArticleAt(1, "fox", 1), ArticleAt(2, "fox", 1) };
        var pager = new PublicListProjection(17, articles, codec);
        var query = PublicListQuery.Parse("home", 1, 1, "fox", "latest", null);
        var first = Read(pager, query);
        var next = query with { Page = 2, Cursor = first.Cursor };
        Assert.Equal(new[] { 1 }, Read(pager, next).Ids);
        Assert.Equal(new[] { 1 }, Read(pager, next).Ids);

        var cursor = Assert.IsType<string>(next.Cursor);
        var tampered = (cursor[0] == 'A' ? "B" : "A") + cursor[1..];
        foreach (var candidate in new PublicListQuery[]
        {
            next with { Cursor = tampered }, next with { Cursor = cursor + "=" },
            next with { Scope = "archive" }, next with { Size = 2 }, next with { Page = 3 },
            next with { Sort = PublicListSort.Relevance }, next with { Keyword = "Fox" },
        })
            Invalid(() => Read(pager, candidate));

        Invalid(() => Read(new PublicListProjection(18, articles, codec), next));
        Invalid(() => Read(new PublicListProjection(17, articles, new PublicListCursor(clock)), next));

        clock.Advance(TimeSpan.FromMinutes(15));
        Invalid(() => Read(pager, next));
        Invalid(() => PublicListQuery.Parse("home", 2, 1, "fox", "latest", null));
        Invalid(() => PublicListQuery.Parse("home", 1, 1, "fox", "latest", cursor));
    }

    [Fact]
    public void CommonReadReusesPreencodedBytesAndRenewsCursorWhileScopedPagesStaySeparate()
    {
        var clock = new TestTime();
        var articles = Enumerable.Range(1, 25).Select(id => ArticleAt(id, "fox", id)).ToArray();
        var pager = new PublicListProjection(17, articles, new PublicListCursor(clock));
        var home = PublicListQuery.Parse("home", 1, 10, null, null, null);
        var archive = home with { Scope = "archive" };
        var first = pager.Read(home, CancellationToken.None, null);
        Assert.Same(first, pager.Read(home, CancellationToken.None, null));
        var cached = Decode(first);
        Invalid(() => Read(pager, archive with { Page = 2, Cursor = cached.Cursor }));
        Assert.Equal(Enumerable.Range(6, 10).Reverse(), Read(pager, home with { Page = 2, Cursor = cached.Cursor }).Ids);
        clock.Advance(TimeSpan.FromSeconds(60));
        Assert.NotSame(first, pager.Read(home, CancellationToken.None, null));
        Assert.NotEqual(cached.Cursor, Read(pager, home).Cursor);
        Assert.Equal(Enumerable.Range(6, 10).Reverse(), Read(pager, home with { Page = 2, Cursor = cached.Cursor }).Ids);

        var scope = home with { Scope = "category:4", Size = 3 };
        var keyset = Decode(pager.Read(scope, CancellationToken.None, item => item.Id % 2 == 0));
        Assert.Equal(new[] { 24, 22, 20 }, keyset.Ids);
        var continuation = Decode(pager.Read(scope with { Page = 2, Cursor = keyset.Cursor }, CancellationToken.None, item => item.Id % 2 == 0));
        Assert.Equal(new[] { 18, 16, 14 }, continuation.Ids);
    }

    [Fact]
    public void RejectsUnsupportedSortsAndGatesUnavailablePopularity()
    {
        Assert.Equal(PublicListSort.Latest, PublicListQuery.Parse("home", 1, 1, null, " LaTeSt ", null).Sort);
        Assert.Equal(PublicListSort.Relevance, PublicListQuery.Parse("home", 1, 1, "fox", " RELEVANCE ", null).Sort);
        Assert.Equal("article_sort_invalid", Assert.Throws<PublicListFailure>(
            () => PublicListQuery.Parse("home", 1, 1, null, "hot", null)).Details);
        Assert.Equal("article_sort_invalid", Assert.Throws<PublicListFailure>(
            () => PublicListQuery.Parse("home", 1, 1, "fox", "oldest", null)).Details);
        var hot = Assert.Throws<PublicListFailure>(() => PublicListQuery.Parse("home", 1, 1, "fox", "hot", null));
        Assert.Equal(503, hot.Status);
        Assert.Equal("article_hot_unavailable", hot.Details);
    }

    private static Article ArticleAt(int id, string title, int minute, string? summary = null, string body = "body") =>
        new(id, id, 100 + id, 1, 1, title, body, Epoch.AddMinutes(minute), Epoch.AddDays(1), Epoch.AddDays(2), summary);

    private static void Invalid(Action action) =>
        Assert.Equal("article_cursor_invalid", Assert.Throws<PublicListFailure>(action).Details);

    private static (int[] Ids, int Total, string? Cursor) Read(PublicListProjection pager, PublicListQuery query) =>
        Decode(pager.Read(query, CancellationToken.None, null));

    private static (int[] Ids, int Total, string? Cursor) Decode(byte[] bytes)
    {
        var payload = Aeds.Decode(bytes, FrameType.ArticleList);
        var cursorLength = BinaryPrimitives.ReadInt32LittleEndian(payload[WireLayouts.ArticleListCursorLengthOffset..]);
        var cursor = cursorLength == 0 ? null : Encoding.ASCII.GetString(payload.Slice(WireLayouts.ArticleListCursorOffset, cursorLength));
        var meta = payload[(WireLayouts.ArticleListCursorOffset + cursorLength)..];
        var count = BinaryPrimitives.ReadInt32LittleEndian(meta);
        var records = meta[(12 + BinaryPrimitives.ReadInt32LittleEndian(meta[8..]))..];
        var ids = new int[count];
        for (var index = 0; index < count; index++)
            ids[index] = BinaryPrimitives.ReadInt32LittleEndian(records[(index * WireLayouts.ArticleListRecordSizeCurrent)..]);
        return (ids, BinaryPrimitives.ReadInt32LittleEndian(payload[WireLayouts.ArticleListTotalOffset..]), cursor);
    }

    private sealed class TestTime : TimeProvider
    {
        private DateTimeOffset utcNow = Epoch;
        public override DateTimeOffset GetUtcNow() => utcNow;
        internal void Advance(TimeSpan elapsed) => utcNow += elapsed;
    }
}
