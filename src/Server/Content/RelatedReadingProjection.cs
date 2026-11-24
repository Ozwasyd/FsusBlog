namespace FsusBlog.V2.Server.Content;

/// <summary>Recommendations and chronological navigation over one admitted public snapshot.</summary>
internal sealed class RelatedReadingProjection
{
    private const int CandidateWindow = 120;
    private const int CacheItems = 256;
    private static readonly HashSet<string> StopWords = new(StringComparer.Ordinal)
    {
        "the", "and", "for", "with", "from", "this", "that", "article", "blog", "https", "http", "www"
    };

    private readonly Article[] _published;
    private readonly Dictionary<int, int> _ordinals;
    private readonly Dictionary<int, List<int>> _categories = [];
    private readonly Dictionary<int, List<int>> _tags = [];
    private readonly Dictionary<int, LinkedListNode<(int Id, byte[] Frame)>> _entries = [];
    private readonly LinkedList<(int Id, byte[] Frame)> _recent = [];
    private readonly object _cache = new();

    internal RelatedReadingProjection(IReadOnlyList<Article> articles, CancellationToken cancellationToken)
    {
        _published = articles.OrderByDescending(article => article.PublishedAt).ThenByDescending(article => article.Id).ToArray();
        _ordinals = new Dictionary<int, int>(_published.Length);
        for (var rank = 0; rank < _published.Length; rank++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var article = _published[rank];
            _ordinals.Add(article.Id, rank);
            if (article.Category is { Id: > 0 } category) Index(_categories, category.Id, rank);
            foreach (var tag in article.Tags ?? [])
                Index(_tags, tag.Id, rank);
        }
    }

    internal byte[]? Read(int id, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!_ordinals.TryGetValue(id, out var ordinal)) return null;
        lock (_cache)
        {
            if (_entries.TryGetValue(id, out var existing))
            {
                _recent.Remove(existing);
                _recent.AddFirst(existing);
                return existing.Value.Frame;
            }
        }

        var frame = RelatedReadingWire.Encode(Find(ordinal, cancellationToken));
        cancellationToken.ThrowIfCancellationRequested();
        lock (_cache)
        {
            if (_entries.TryGetValue(id, out var concurrent))
                return concurrent.Value.Frame;

            _entries.Add(id, _recent.AddFirst((id, frame)));
            if (_entries.Count > CacheItems && _recent.Last is { } oldest)
            {
                _entries.Remove(oldest.Value.Id);
                _recent.RemoveLast();
            }
        }

        return frame;
    }

    private RelatedReading Find(int ordinal, CancellationToken cancellationToken)
    {
        var source = _published[ordinal];
        var sourceTags = (source.Tags ?? []).Select(tag => tag.Id).ToHashSet();
        var candidates = new SortedSet<int>();
        if (source.Category is { } category && _categories.TryGetValue(category.Id, out var categoryItems))
            AddCandidates(categoryItems);

        foreach (var tag in sourceTags)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (_tags.TryGetValue(tag, out var tagItems)) AddCandidates(tagItems);
        }

        var keywords = Keywords(source.Title + " " + source.Summary);
        var related = candidates.Take(CandidateWindow)
            .Select(index => Score(source, _published[index], sourceTags, keywords))
            .OrderByDescending(item => item.Score)
            .ThenBy(item => item.DayDistance)
            .ThenByDescending(item => item.Article.PublishedAt)
            .ThenByDescending(item => item.Article.Id)
            .Take(WireLimits.RelatedReadingMaxItems)
            .Select(item => Item(item.Article, item.Reason)).ToArray();
        return new RelatedReading(related,
            ordinal + 1 < _published.Length ? Item(_published[ordinal + 1], "上一篇") : null,
            ordinal > 0 ? Item(_published[ordinal - 1], "下一篇") : null);

        void AddCandidates(List<int> sourceIndexes)
        {
            // Ordinals are globally newest-first. Only the first 120 rows plus a possible self
            // match in a contributing posting list can enter the merged candidate window.
            for (var index = 0; index < Math.Min(sourceIndexes.Count, CandidateWindow + 1); index++)
                if (sourceIndexes[index] != ordinal) candidates.Add(sourceIndexes[index]);
        }
    }

    private static (Article Article, int Score, int DayDistance, string Reason) Score(
        Article source, Article candidate, HashSet<int> sourceTags, string[] keywords)
    {
        var reasons = new List<string>(4);
        var score = 0;
        if (source.Category is { Id: > 0 } category && candidate.Category?.Id == category.Id)
        {
            score += 80;
            reasons.Add("同分类");
        }

        var shared = (candidate.Tags ?? []).Count(tag => sourceTags.Contains(tag.Id));
        if (shared > 0)
        {
            score += Math.Min(60, shared * 30);
            reasons.Add("共同标签");
        }

        var matches = keywords.Count(keyword => candidate.Title.Contains(keyword, StringComparison.OrdinalIgnoreCase) ||
            (candidate.Summary?.Contains(keyword, StringComparison.OrdinalIgnoreCase) ?? false));
        if (matches > 0)
        {
            score += Math.Min(40, matches * 10);
            reasons.Add("全文关键词");
        }

        var distance = Math.Abs((int)Math.Round((candidate.PublishedAt - source.PublishedAt).TotalDays, MidpointRounding.AwayFromZero));
        if (distance <= 14)
        {
            score += Math.Max(1, 20 - distance);
            reasons.Add("发布时间接近");
        }

        return (candidate, score, distance, reasons.Count == 0 ? "近期发布" : string.Join(" / ", reasons));
    }

    private static string[] Keywords(string text)
    {
        text = text.ToLowerInvariant();
        var result = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < text.Length && result.Count < 12; )
        {
            if (IsHan(text[i]))
            {
                if (i + 1 < text.Length && IsHan(text[i + 1])) result.Add(text.Substring(i, 2));
                i++;
                continue;
            }

            var start = i;
            while (i < text.Length && char.IsLetterOrDigit(text[i]) && !IsHan(text[i])) i++;
            if (i - start >= 3)
            {
                var token = text[start..i];
                if (!StopWords.Contains(token)) result.Add(token);
            }

            if (i == start) i++;
        }

        return [.. result];
    }

    private static bool IsHan(char value) => value is >= '\u4e00' and <= '\u9fff';

    private static RelatedItem Item(Article article, string reason) =>
        new(article.Id, article.CreatedAt, article.Title, article.Summary, reason);

    private static void Index(Dictionary<int, List<int>> map, int id, int rank)
    {
        if (!map.TryGetValue(id, out var posting)) map.Add(id, posting = []);
        // Older rows remain discoverable for navigation via _published. They cannot enter the
        // recommendation budget, so the category/tag indexes need only the recent window.
        if (posting.Count <= CandidateWindow) posting.Add(rank);
    }
}
