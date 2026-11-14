using FsusBlog.V2.Contracts;

internal static class LocalSearchVectors
{
    internal static void Run(string fixtures)
    {
        var date = DateTimeOffset.FromUnixTimeMilliseconds(1_700_000_002_345);
        var article = new Article(42, 9_007_199_254_740_993, 9_007_199_254_741_001, 4, 2,
            "Title", "needle", date, date, date, "note", new(7, "Lab"), [new(11, "雪")]);
        var first = LocalSearchCorpus.Build([article]);
        if (first is not { Count: 1 })
            throw new InvalidOperationException("Local search did not produce one complete FSPK page");

        var expected = Convert.FromHexString(File.ReadAllText(Path.Combine(fixtures, "search-fspk-v4.hex")).Trim());
        if (!first[0].AsSpan().SequenceEqual(expected))
            throw new InvalidOperationException("FSPK writer differs from the independently constructed search corpus");

        var articlePage = Enumerable.Range(1, WireLimits.SearchIndexPageSize + 1)
            .Select(id => article with { Id = id }).ToArray();
        if (LocalSearchCorpus.Build(articlePage) is not { Count: 2 })
            throw new InvalidOperationException("Local search did not split its bounded corpus pages");

        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        try
        {
            LocalSearchCorpus.Build(articlePage, cancelled.Token);
        }
        catch (OperationCanceledException)
        {
            return;
        }
        throw new InvalidOperationException("Local search did not observe cancellation");
    }
}
