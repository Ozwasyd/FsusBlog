namespace FsusBlog.V2.Server;

internal sealed class PublicListProjection
{
    private readonly record struct Ranked(Article Article, PublicListPosition Position);
    private sealed record DefaultPages(long RefreshAt, byte[] Home10, byte[] Home20, byte[] Archive10);
    private readonly Ranked[] ordered;
    private readonly object gate = new();
    private readonly long generation;
    private readonly PublicListCursor cursor;
    private DefaultPages defaults;

    internal PublicListProjection(long generation, IReadOnlyList<Article> articles, PublicListCursor cursor)
    {
        this.generation = generation;
        this.cursor = cursor;
        ordered = articles.OrderByDescending(article => article.CreatedAt)
            .ThenByDescending(article => article.Id)
            .Select(article => new Ranked(article, PublicListPosition.From(article, 0))).ToArray();
        defaults = PrepareDefaults(cursor.Now);
    }

    internal byte[] Read(PublicListQuery query, CancellationToken ct, Func<Article, bool>? filter)
    {
        ct.ThrowIfCancellationRequested();
        PublicListPosition? anchor = query.Cursor is null ? null : cursor.Decode(generation, query);
        if (query.Page == 1 && query.Keyword.Length == 0 && filter is null)
        {
            return (query.Scope, query.Size) switch
            {
                ("home", 10) => ReadDefaults().Home10,
                ("home", 20) => ReadDefaults().Home20,
                ("archive", 10) => ReadDefaults().Archive10,
                _ => Page(query, ordered, null)
            };
        }

        var items = query.Keyword.Length == 0 && filter is null ? ordered : Match(query, filter, ct);
        return Page(query, items, anchor);
    }

    private DefaultPages ReadDefaults()
    {
        var pages = Volatile.Read(ref defaults);
        var now = cursor.Now;
        if (now < pages.RefreshAt) return pages;
        lock (gate)
        {
            pages = defaults;
            if (now >= pages.RefreshAt) Volatile.Write(ref defaults, pages = PrepareDefaults(now));
            return pages;
        }
    }

    private DefaultPages PrepareDefaults(long now) => new(
        ordered.Length <= 10 ? long.MaxValue : now + 60,
        Page(new("home", 1, 10, "", PublicListSort.Latest, null), ordered, null),
        Page(new("home", 1, 20, "", PublicListSort.Latest, null), ordered, null),
        Page(new("archive", 1, 10, "", PublicListSort.Latest, null), ordered, null));

    private Ranked[] Match(PublicListQuery query, Func<Article, bool>? filter, CancellationToken ct)
    {
        var matching = new List<Ranked>();
        foreach (var entry in ordered)
        {
            ct.ThrowIfCancellationRequested();
            var article = entry.Article;
            if (filter is not null && !filter(article)) continue;
            var term = query.Keyword;
            var titleMatch = article.Title.Contains(term, StringComparison.Ordinal);
            if (term.Length > 0 && !titleMatch && article.Summary?.Contains(term, StringComparison.Ordinal) != true)
                continue;

            var score = !titleMatch || query.Sort != PublicListSort.Relevance ? 0
                : article.Title.Equals(term, StringComparison.Ordinal) ? 3
                : article.Title.StartsWith(term, StringComparison.Ordinal) ? 2 : 1;
            matching.Add(new(article, entry.Position with { Score = score }));
        }
        if (query.Sort == PublicListSort.Relevance)
            matching.Sort(static (left, right) => left.Position.CompareTo(right.Position));
        return matching.ToArray();
    }

    private byte[] Page(PublicListQuery query, Ranked[] items, PublicListPosition? anchor)
    {
        var start = anchor is { } position ? FindAfter(items, position) : 0;
        var count = Math.Min(query.Size, items.Length - start);
        var result = new Article[count];
        for (var index = 0; index < count; index++)
            result[index] = items[start + index].Article;

        var end = start + count;
        var next = end < items.Length ? cursor.Encode(generation, query, items[end - 1].Position) : null;
        return PublicArticles.EncodeList(result, items.Length, next);
    }

    private static int FindAfter(Ranked[] items, PublicListPosition anchor)
    {
        var low = 0;
        var high = items.Length - 1;
        while (low <= high)
        {
            var middle = low + (high - low) / 2;
            var item = items[middle].Position;
            var compare = item.CompareTo(anchor);
            if (compare == 0 && item == anchor) return middle + 1;
            if (compare < 0) low = middle + 1;
            else high = middle - 1;
        }
        throw PublicListFailure.InvalidCursor();
    }
}
