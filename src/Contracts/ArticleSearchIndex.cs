using System.Buffers;
using System.Runtime.InteropServices;

namespace FsusBlog.V2.Contracts;

/// <summary>In-memory weighted BM25 over the active snapshot's public article coordinates.</summary>
public sealed class ArticleSearchIndex
{
    private const int MaxResults = 200;
    private const int MaxDocuments = WireLimits.SearchIndexMaxPages * WireLimits.SearchIndexPageSize;
    private const int MaxTerms = 262_144;
    private const int MaxPostings = 3_000_000;
    private const long MaxScannedChars = 128 * 1024 * 1024;
    private const double K1 = 1.2;
    private const double B = 0.75;

    private readonly Document[] _documents;
    private readonly Term[] _terms;
    private readonly Posting[] _postings;

    private ArticleSearchIndex(Document[] documents, Term[] terms, Posting[] postings) =>
        (_documents, _terms, _postings) = (documents, terms, postings);

    public static ArticleSearchIndex? Build(IReadOnlyList<Article> articles, CancellationToken ct)
    {
        if (articles.Count > MaxDocuments) return null;

        var lengths = new int[articles.Count];
        var totalLength = 0L;
        var remainingChars = MaxScannedChars;
        var frequencies = new Dictionary<uint, int>();
        var heads = new Dictionary<uint, Bucket>();
        var pending = new List<PendingPosting>();
        for (var ordinal = 0; ordinal < articles.Count; ordinal++)
        {
            ct.ThrowIfCancellationRequested();
            var article = articles[ordinal];
            frequencies.Clear();
            if (!Index(article.Title, 16) || !Index(article.Summary ?? "", 8) ||
                !Index(article.Category?.Name ?? "", 5))
                return null;
            foreach (var tag in article.Tags ?? [])
            {
                if (!Index(tag.Name, 5)) return null;
            }
            if (!Index(article.Body, 2)) return null;
            var length = ArticleSearchTokens.DocumentLength(article.Body);
            lengths[ordinal] = length;
            totalLength += length;

            if (frequencies.Count > MaxPostings - pending.Count) return null;
            foreach (var (hash, weight) in frequencies)
            {
                ref var bucket = ref CollectionsMarshal.GetValueRefOrAddDefault(heads, hash, out var found);
                if (!found)
                {
                    if (heads.Count > MaxTerms) return null;
                    bucket = new Bucket(-1, 0);
                }
                pending.Add(new PendingPosting(new Posting(ordinal, weight), bucket.Head));
                bucket = new Bucket(pending.Count - 1, bucket.Count + 1);
            }
        }

        var average = Math.Max((double)totalLength / Math.Max(articles.Count, 1), 1);
        var documents = new Document[articles.Count];
        for (var ordinal = 0; ordinal < documents.Length; ordinal++)
            documents[ordinal] = new Document(articles[ordinal], K1 * (1 - B + B * lengths[ordinal] / average));

        var terms = new Term[heads.Count];
        var postings = new Posting[pending.Count];
        var termIndex = 0;
        var start = 0;
        foreach (var (hash, bucket) in heads)
        {
            ct.ThrowIfCancellationRequested();
            terms[termIndex++] = new Term(hash, start, bucket.Count);
            for (var entry = bucket.Head; entry >= 0; entry = pending[entry].Previous)
                postings[start++] = pending[entry].Value;
        }
        Array.Sort(terms, Term.ByHash);
        return new ArticleSearchIndex(documents, terms, postings);

        bool Index(string text, int weight)
        {
            remainingChars -= text.Length;
            if (remainingChars < 0) return false;
            foreach (var hash in ArticleSearchTokens.Hashes(text, ct))
            {
                ref var frequency = ref CollectionsMarshal.GetValueRefOrAddDefault(frequencies, hash, out _);
                frequency += weight;
                if (frequencies.Count > MaxTerms) return false;
            }
            return true;
        }
    }

    public Article[] Search(string query, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (_documents.Length == 0) return [];
        var hashes = new HashSet<uint>();
        var candidates = new PriorityQueue<Article, (double Score, long CreatedAt, int Id)>(MaxResults);
        var buffer = ArrayPool<double>.Shared.Rent(_documents.Length);
        try
        {
            var scores = buffer.AsSpan(0, _documents.Length);
            scores.Clear();
            foreach (var hash in ArticleSearchTokens.Hashes(ArticleSearchTokens.NormalizeQuery(query), ct))
            {
                if (!hashes.Add(hash)) continue;
                var position = Array.BinarySearch(_terms, new Term(hash, 0, 0), Term.ByHash);
                if (position < 0) continue;
                var term = _terms[position];
                var idf = Math.Log(1 + (_documents.Length - term.Count + 0.5) / (term.Count + 0.5));
                for (var i = 0; i < term.Count; i++)
                {
                    if ((i & 1023) == 0) ct.ThrowIfCancellationRequested();
                    var posting = _postings[term.Start + i];
                    var normalization = _documents[posting.Ordinal].Normalization;
                    scores[posting.Ordinal] += idf * ((posting.Weight * (K1 + 1)) / (posting.Weight + normalization));
                }
            }

            for (var ordinal = 0; ordinal < _documents.Length; ordinal++)
            {
                if ((ordinal & 1023) == 0) ct.ThrowIfCancellationRequested();
                var score = scores[ordinal];
                if (score <= 0) continue;
                var article = _documents[ordinal].Article;
                var rank = (score, article.CreatedAt.UtcTicks, article.Id);
                if (candidates.Count < MaxResults) candidates.Enqueue(article, rank);
                else candidates.EnqueueDequeue(article, rank);
            }
        }
        finally
        {
            ArrayPool<double>.Shared.Return(buffer);
        }

        var result = new Article[candidates.Count];
        for (var index = result.Length - 1; index >= 0; index--)
            result[index] = candidates.Dequeue();
        return result;
    }

    private readonly record struct Posting(int Ordinal, int Weight);
    private readonly record struct PendingPosting(Posting Value, int Previous);
    private readonly record struct Bucket(int Head, int Count);
    private readonly record struct Document(Article Article, double Normalization);
    private readonly record struct Term(uint Hash, int Start, int Count)
    {
        internal static readonly IComparer<Term> ByHash =
            Comparer<Term>.Create(static (left, right) => left.Hash.CompareTo(right.Hash));
    }
}
