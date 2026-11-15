using FsusBlog.V2.Server.Authoring;

public sealed class AuthorHeadingSourceTests
{
    [Fact]
    public void ReadsRawAtxContentOutsideClosedFences()
    {
        const string source = "\uFEFF## 雪😀 ##\r\n```\r\n# hidden\r\n```\r\n# Cafe\u0301\r\n";
        var headings = AuthorHeadingSource.Collect(source, CancellationToken.None);
        Assert.Collection(headings,
            first => Assert.Equal(new AuthorHeadingRange(4, 7), Assert.Single(first.ContentRanges)),
            second => Assert.Equal(new AuthorHeadingRange(34, 39), Assert.Single(second.ContentRanges)));
    }

    [Fact]
    public void ReadsSetextAndKeepsTheEarliestRawBoundary()
    {
        const string source = "\uFEFF  Ω😀  \r\n===\r\n##\tTabbed\r\n####### Nope";
        var heading = Assert.Single(AuthorHeadingSource.Collect(source, CancellationToken.None));
        Assert.Equal(new AuthorHeadingRange(0, 8), Assert.Single(heading.ContentRanges));
    }

    [Fact]
    public void KeepsEmptyAtxHeadingAndIgnoresUnclosedFenceContent()
    {
        const string source = "## \r\n\r\n#\tTabbed\r\n####### Too many\r\n```\r\n# Hidden\r\n";
        var heading = Assert.Single(AuthorHeadingSource.Collect(source, CancellationToken.None));
        Assert.Empty(heading.ContentRanges);
    }

    [Fact]
    public void MapsIsolatedCarriageReturnsAsEditorNewlines()
    {
        var headings = AuthorHeadingSource.Collect("# A\rB\r# C\n", CancellationToken.None);
        Assert.Collection(headings,
            first => Assert.Equal(new AuthorHeadingRange(2, 3), Assert.Single(first.ContentRanges)),
            second => Assert.Equal(new AuthorHeadingRange(8, 9), Assert.Single(second.ContentRanges)));
    }

    [Fact]
    public void RefusesAnOverBudgetSourceBeforeCallingTheCollector()
    {
        Assert.Throws<AuthorHeadingBudgetException>(() =>
            AuthorHeadingSource.Collect(new string('\n', 4096), CancellationToken.None));
    }
}
