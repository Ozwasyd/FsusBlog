using System.Buffers;
using System.Runtime.InteropServices;

namespace FsusBlog.V2.Contracts;

public enum ArticleSearchSort
{
    Relevance = 0,
    Latest = 1
}

public readonly record struct ArticleSearchPage(Article[] Articles, int Total);

/// <summary>In-memory weighted BM25 over the active snapshot's public article coordinates.</summary>
public sealed partial class ArticleSearchIndex
{
    private const int MaxResults = 200;
    public const int MaxPaginatedResults = 1_000;
    private const int CompactMaxDocuments = WireLimits.SearchIndexMaxPages * WireLimits.SearchIndexPageSize;
    private const int MaxTerms = 262_144;
    private const int MaxPostings = 3_000_000;
    private const long MaxScannedChars = 128 * 1024 * 1024;
    private const int TitleWeight = 16;
    private const int SummaryWeight = 8;
    private const int TaxonomyWeight = 5;
    private const int BodyWeight = 2;
    private const int ShortPrefixTitleWeight = 4;
    private const int ShortPrefixSummaryWeight = 2;
    private const int ShortPrefixTaxonomyWeight = 1;
    private const double K1 = 1.2;
    private const double B = 0.75;

    private readonly Document[] _documents;
    private readonly Term[] _terms;
    private readonly Posting[] _postings;
    private readonly WideBlock[]? _wide;

    private ArticleSearchIndex(Document[] documents, Term[] terms, Posting[] postings, WideBlock[]? wide = null) =>
        (_documents, _terms, _postings, _wide) = (documents, terms, postings, wide);

    public bool UsesWideProfile => _wide is not null;

    public static ArticleSearchIndex? Build(IReadOnlyList<Article> articles, CancellationToken ct)
    {
        if (articles.Count > CompactMaxDocuments) return BuildWide(articles, ct);

        var lengths = new int[articles.Count];
        var builder = new PostingBuilder(MaxScannedChars);
        if (!builder.Collect(articles, 0, lengths, MaxTerms, MaxPostings, ct)) return null;

        var terms = new Term[builder.Heads.Count];
        var postings = new Posting[builder.Pending.Count];
        var termIndex = 0;
        var start = 0;
        foreach (var (hash, bucket) in builder.Heads)
        {
            ct.ThrowIfCancellationRequested();
            terms[termIndex++] = new Term(hash, start, bucket.Count);
            for (var entry = bucket.Head; entry >= 0; entry = builder.Pending[entry].Previous)
                postings[start++] = builder.Pending[entry].Value;
        }
        Array.Sort(terms, Term.ByHash);
        return new ArticleSearchIndex(Normalize(articles, lengths, builder.TotalLength, ct), terms, postings);
    }

    public Article[] Search(string query, CancellationToken ct) =>
        SearchPage(query, ArticleSearchSort.Relevance, 1, MaxResults, ct).Articles;

    public ArticleSearchPage SearchPage(string query, ArticleSearchSort sort, int page, int size, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        ArgumentOutOfRangeException.ThrowIfLessThan(page, 1);
        ArgumentOutOfRangeException.ThrowIfLessThan(size, 1);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(size, MaxResults);
        if (_documents.Length == 0) return new([], 0);
        var (normalized, exactIdentifier) = ArticleSearchTokens.NormalizeQuery(query);
        if (normalized.Length == 0) return new([], 0);
        var start = (long)(page - 1) * size;
        var window = start >= MaxPaginatedResults ? 0 : (int)Math.Min(start + size, MaxPaginatedResults);
        if (exactIdentifier) return SearchIdentifier(normalized, sort, (int)Math.Min(start, MaxPaginatedResults), window, ct);
        query = normalized;
        if (_wide is { } blocks) return SearchWide(blocks, query, sort, (int)Math.Min(start, MaxPaginatedResults), window, ct);
        var hashes = new HashSet<uint>();
        var candidates = window == 0 ? null : new PriorityQueue<Article, SearchRank>(window);
        var total = 0;
        var buffer = ArrayPool<double>.Shared.Rent(_documents.Length);
        try
        {
            var scores = buffer.AsSpan(0, _documents.Length);
            scores.Clear();
            foreach (var hash in ArticleSearchTokens.Hashes(query, ct))
            {
                if (!hashes.Add(hash)) continue;
                var term = FindTerm(_terms, hash);
                if (term.Count == 0) continue;
                var idf = InverseFrequency(term.Count);
                for (var i = 0; i < term.Count; i++)
                {
                    if ((i & 1023) == 0) ct.ThrowIfCancellationRequested();
                    var posting = _postings[term.Start + i];
                    var normalization = _documents[posting.Ordinal].Normalization;
                    scores[posting.Ordinal] += Score(posting.Weight, normalization, idf);
                }
            }
            if (ArticleSearchTokens.ShortAsciiPrefixes(query) is { Count: > 0 } shortPrefixes)
                AddCompactShortPrefixScores(scores, shortPrefixes, ct);
            Select(scores, 0, candidates, sort, window, ref total, ct);
        }
        finally
        {
            ArrayPool<double>.Shared.Return(buffer);
        }

        return new(Ordered(candidates, (int)Math.Min(start, MaxPaginatedResults)), total);
    }

    private void AddCompactShortPrefixScores(Span<double> scores, IReadOnlyList<(string Prefix, uint Hash)> prefixes,
        CancellationToken ct)
    {
        var weightBuffer = ArrayPool<int>.Shared.Rent(_documents.Length);
        try
        {
            var weights = weightBuffer.AsSpan(0, _documents.Length);
            for (var p = 0; p < prefixes.Count; p++)
            {
                var (prefix, hash) = prefixes[p];
                var prefixDf = 0;
                for (var ordinal = 0; ordinal < _documents.Length; ordinal++)
                {
                    if ((ordinal & 1023) == 0) ct.ThrowIfCancellationRequested();
                    var weight = ShortPrefixWeight(_documents[ordinal].Article, prefix);
                    weights[ordinal] = weight;
                    if (weight > 0) prefixDf++;
                }
                if (prefixDf == 0) continue;
                var exactDf = FindTerm(_terms, hash).Count;
                var idf = InverseFrequency(Math.Min(_documents.Length, exactDf + prefixDf));
                for (var ordinal = 0; ordinal < _documents.Length; ordinal++)
                {
                    var weight = weights[ordinal];
                    if (weight > 0) scores[ordinal] += Score(weight, _documents[ordinal].Normalization, idf);
                }
            }
        }
        finally
        {
            ArrayPool<int>.Shared.Return(weightBuffer);
        }
    }

    private static int ShortPrefixWeight(Article article, string prefix)
    {
        var span = prefix.AsSpan();
        var weight = ShortPrefixTitleWeight * ArticleSearchTokens.CountAsciiPrefixMatches(article.Title, span)
            + ShortPrefixSummaryWeight * ArticleSearchTokens.CountAsciiPrefixMatches(article.Summary ?? "", span)
            + ShortPrefixTaxonomyWeight * ArticleSearchTokens.CountAsciiPrefixMatches(article.Category?.Name ?? "", span);
        foreach (var tag in article.Tags ?? [])
            weight += ShortPrefixTaxonomyWeight * ArticleSearchTokens.CountAsciiPrefixMatches(tag.Name, span);
        return weight;
    }

    private ArticleSearchPage SearchIdentifier(string query, ArticleSearchSort sort, int start, int window, CancellationToken ct)
    {
        // A complete identifier must have all of its segments in the existing postings. Verify only
        // the rarest segment's candidates, including those outside the regular 200-result limit.
        var fewest = int.MaxValue;
        uint anchor = 0;
        foreach (var hash in ArticleSearchTokens.Hashes(query, ct))
        {
            var count = _wide is null ? FindTerm(_terms, hash).Count : _wide.Sum(block => FindTerm(block.Terms, hash).Count);
            if (count == 0) return new([], 0);
            if (count >= fewest) continue;
            fewest = count;
            anchor = hash;
        }

        var candidates = window == 0 ? null : new PriorityQueue<Article, SearchRank>(window);
        var total = 0;
        if (_wide is { } blocks)
        {
            foreach (var block in blocks)
            {
                var term = FindTerm(block.Terms, anchor);
                var offset = term.Start;
                var ordinal = block.Count;
                for (var index = 0; index < term.Count; index++)
                {
                    ordinal -= ReadVarint(block.Postings, ref offset);
                    _ = ReadVarint(block.Postings, ref offset);
                    Match(block.First + ordinal);
                }
            }
        }
        else
        {
            var term = FindTerm(_terms, anchor);
            for (var index = 0; index < term.Count; index++) Match(_postings[term.Start + index].Ordinal);
        }
        return new(Ordered(candidates, start), total);

        void Match(int ordinal)
        {
            ct.ThrowIfCancellationRequested();
            var document = _documents[ordinal];
            var article = document.Article;
            var weight = TitleWeight * Count(article.Title) + SummaryWeight * Count(article.Summary ?? "") +
                TaxonomyWeight * Count(article.Category?.Name ?? "") + BodyWeight * Count(article.Body);
            foreach (var tag in article.Tags ?? []) weight += TaxonomyWeight * Count(tag.Name);
            // An identifier has one IDF shared by every hit, so it cannot change the ordering.
            if (weight > 0) Offer(candidates, article, Score(weight, document.Normalization, 1), sort, window, ref total);
        }

        int Count(string value) => ArticleSearchTokens.CountIdentifier(value, query, ct);
    }

    private static Term FindTerm(Term[] terms, uint hash)
    {
        var position = Array.BinarySearch(terms, new Term(hash, 0, 0), Term.ByHash);
        return position >= 0 ? terms[position] : default;
    }

    private double InverseFrequency(int documentFrequency) =>
        Math.Log(1 + (_documents.Length - documentFrequency + 0.5) / (documentFrequency + 0.5));

    private static double Score(int weight, double normalization, double idf) =>
        idf * ((weight * (K1 + 1)) / (weight + normalization));

    private void Select(ReadOnlySpan<double> scores, int start,
        PriorityQueue<Article, SearchRank>? candidates, ArticleSearchSort sort, int window, ref int total, CancellationToken ct)
    {
        for (var ordinal = 0; ordinal < scores.Length; ordinal++)
        {
            if ((ordinal & 1023) == 0) ct.ThrowIfCancellationRequested();
            var score = scores[ordinal];
            if (score <= 0) continue;
            Offer(candidates, _documents[start + ordinal].Article, score, sort, window, ref total);
        }
    }

    private static void Offer(PriorityQueue<Article, SearchRank>? candidates,
        Article article, double score, ArticleSearchSort sort, int window, ref int total)
    {
        total++;
        if (candidates is null || window == 0) return;
        var rank = new SearchRank(score, article.PublishedAt.UtcTicks, article.CreatedAt.UtcTicks, article.Id, sort);
        if (candidates.Count < window) candidates.Enqueue(article, rank);
        else candidates.EnqueueDequeue(article, rank);
    }

    private static Article[] Ordered(PriorityQueue<Article, SearchRank>? candidates, int start)
    {
        if (candidates is null || candidates.Count <= start) return [];
        var count = candidates.Count - start;
        var result = new Article[count];
        for (var index = count - 1; index >= 0; index--)
            result[index] = candidates.Dequeue();
        return result;
    }

    private static Document[] Normalize(IReadOnlyList<Article> articles, ReadOnlySpan<int> lengths, long totalLength,
        CancellationToken ct)
    {
        var average = Math.Max((double)totalLength / Math.Max(articles.Count, 1), 1);
        var documents = new Document[articles.Count];
        for (var ordinal = 0; ordinal < documents.Length; ordinal++)
        {
            if ((ordinal & 1023) == 0) ct.ThrowIfCancellationRequested();
            documents[ordinal] = new Document(articles[ordinal], K1 * (1 - B + B * lengths[ordinal] / average));
        }
        return documents;
    }

    private sealed class PostingBuilder(long remainingChars)
    {
        private readonly Dictionary<uint, int> _frequencies = [];
        internal readonly Dictionary<uint, Bucket> Heads = [];
        internal readonly List<PendingPosting> Pending = [];
        internal long TotalLength { get; private set; }

        internal bool Collect(IReadOnlyList<Article> articles, int first, Span<int> lengths,
            int termLimit, int postingLimit, CancellationToken ct)
        {
            Heads.Clear();
            Pending.Clear();
            for (var ordinal = 0; ordinal < lengths.Length; ordinal++)
            {
                ct.ThrowIfCancellationRequested();
                var article = articles[first + ordinal];
                _frequencies.Clear();
                if (!Index(article.Title, TitleWeight) || !Index(article.Summary ?? "", SummaryWeight) ||
                    !Index(article.Category?.Name ?? "", TaxonomyWeight))
                    return false;
                foreach (var tag in article.Tags ?? [])
                    if (!Index(tag.Name, TaxonomyWeight)) return false;
                if (!Index(article.Body, BodyWeight)) return false;
                lengths[ordinal] = ArticleSearchTokens.DocumentLength(article.Body);
                TotalLength += lengths[ordinal];

                if (_frequencies.Count > postingLimit - Pending.Count) return false;
                foreach (var (hash, weight) in _frequencies)
                {
                    ref var bucket = ref CollectionsMarshal.GetValueRefOrAddDefault(Heads, hash, out var found);
                    if (!found)
                    {
                        if (Heads.Count > termLimit) return false;
                        bucket = new Bucket(-1, 0);
                    }
                    Pending.Add(new PendingPosting(new Posting(ordinal, weight), bucket.Head));
                    bucket = new Bucket(Pending.Count - 1, bucket.Count + 1);
                }
            }
            return true;

            bool Index(string text, int weight)
            {
                remainingChars -= text.Length;
                if (remainingChars < 0) return false;
                var subtokenWeight = Math.Max(1, weight / 2);
                return ArticleSearchTokens.VisitIndexTokens(text, ct, (hash, exact) =>
                {
                    var delta = exact ? weight : subtokenWeight;
                    ref var frequency = ref CollectionsMarshal.GetValueRefOrAddDefault(_frequencies, hash, out _);
                    if (frequency > int.MaxValue - delta) return false;
                    frequency += delta;
                    return _frequencies.Count <= termLimit;
                });
            }
        }
    }

    private readonly record struct Posting(int Ordinal, int Weight);
    private readonly record struct PendingPosting(Posting Value, int Previous);
    private readonly record struct Bucket(int Head, int Count);
    private readonly record struct Document(Article Article, double Normalization);
    private readonly record struct SearchRank(double Score, long PublishedTicks, long CreatedTicks, int Id, ArticleSearchSort Sort)
        : IComparable<SearchRank>
    {
        public int CompareTo(SearchRank other) => Sort == ArticleSearchSort.Latest
            ? Compare(PublishedTicks.CompareTo(other.PublishedTicks), Score.CompareTo(other.Score),
                CreatedTicks.CompareTo(other.CreatedTicks), Id.CompareTo(other.Id))
            : Compare(Score.CompareTo(other.Score), CreatedTicks.CompareTo(other.CreatedTicks),
                Id.CompareTo(other.Id), 0);

        private static int Compare(int a, int b, int c, int d) => a != 0 ? a : b != 0 ? b : c != 0 ? c : d;
    }
    private readonly record struct Term(uint Hash, int Start, int Count)
    {
        internal static readonly IComparer<Term> ByHash =
            Comparer<Term>.Create(static (left, right) => left.Hash.CompareTo(right.Hash));
    }
}
