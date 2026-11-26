using System.Runtime.InteropServices;

namespace FsusBlog.V2.Contracts;

public enum ArticleSearchSort
{
    Relevance = 0,
    Latest = 1
}

public readonly record struct ArticleSearchPage(Article[] Articles, int Total);

/// <summary>
/// In-memory concept-aware BM25F search index over the active public generation (#46, #48, #51, profile v3).
/// Compact (&lt;= 40,000 docs) uses immutable generation-consistent segments with incremental updates,
/// thresholded zero-reanalysis compaction, exact global live statistics, and Block-Max conjunction /
/// Block-Max WAND / Latest block pruning with pooled value-type Top-K heaps.
/// Wide (40,001..100,000 docs) computes identical globally consistent 5-field BM25F scores,
/// concept coverage, CJK bigram sequences, quoted phrases, bounded relaxation, and deterministic
/// tie-breaking, verified against <see cref="ExhaustiveSearchOracle"/>.
/// </summary>
public sealed partial class ArticleSearchIndex
{
    private const int MaxResults = 200;
    public const int MaxPaginatedResults = 1_000;
    public const int DefaultWorkBudgetCandidates = 200_000;
    private const int CompactMaxDocuments = WireLimits.SearchIndexMaxPages * WireLimits.SearchIndexPageSize;
    private const int MaxTerms = 262_144;
    private const int MaxPostings = 3_000_000;
    private const long MaxScannedChars = 128 * 1024 * 1024;
    private const byte ExactFlagBit = 1;

    private readonly SearchSegment[] _segments;
    private readonly ulong[]?[] _liveMasks;
    private readonly int[] _segmentLiveCounts;
    private readonly Dictionary<int, (int SegmentIndex, int LocalOrdinal)> _liveLocator;
    private readonly Dictionary<int, Article> _articlesById;
    private readonly Article[]? _fallbackArticles;
    private readonly bool _duplicateIdsFallback;
    private readonly int _liveDocumentCount;
    private readonly int _deadDocumentSlots;
    private readonly long[] _totalFieldLengths;
    private readonly double[] _avgFieldLengths;
    private readonly long _liveScannedChars;
    private readonly Dictionary<SearchTermKey, int>? _globalLiveDf;
    private readonly Dictionary<ushort, int>? _globalShortPrefixLiveDf;
    private readonly int _analyzerVersion;
    private readonly int _profileVersion;
    private readonly WideIndex? _wide;

    private ArticleSearchIndex(
        SearchSegment[] segments,
        ulong[]?[] liveMasks,
        int[] segmentLiveCounts,
        Dictionary<int, (int SegmentIndex, int LocalOrdinal)> liveLocator,
        Dictionary<int, Article> articlesById,
        Article[]? fallbackArticles,
        int liveDocumentCount,
        int deadDocumentSlots,
        long[] totalFieldLengths,
        double[] avgFieldLengths,
        long liveScannedChars,
        Dictionary<SearchTermKey, int>? globalLiveDf,
        Dictionary<ushort, int>? globalShortPrefixLiveDf,
        int analyzerVersion,
        int profileVersion,
        WideIndex? wide = null)
    {
        _segments = segments;
        _liveMasks = liveMasks;
        _segmentLiveCounts = segmentLiveCounts;
        _liveLocator = liveLocator;
        _articlesById = articlesById;
        _fallbackArticles = fallbackArticles;
        _duplicateIdsFallback = fallbackArticles is not null;
        _liveDocumentCount = liveDocumentCount;
        _deadDocumentSlots = deadDocumentSlots;
        _totalFieldLengths = totalFieldLengths;
        _avgFieldLengths = avgFieldLengths;
        _liveScannedChars = liveScannedChars;
        _globalLiveDf = globalLiveDf;
        _globalShortPrefixLiveDf = globalShortPrefixLiveDf;
        _analyzerVersion = analyzerVersion;
        _profileVersion = profileVersion;
        _wide = wide;
    }

    private static ArticleSearchIndex CreateEmpty(int analyzerVersion, int profileVersion) => new(
        [],
        [],
        [],
        new Dictionary<int, (int SegmentIndex, int LocalOrdinal)>(0),
        new Dictionary<int, Article>(0),
        fallbackArticles: null,
        liveDocumentCount: 0,
        deadDocumentSlots: 0,
        new long[SearchScoringProfile.FieldCount],
        ComputeAvgFieldLengths(new long[SearchScoringProfile.FieldCount], 0),
        liveScannedChars: 0,
        globalLiveDf: null,
        globalShortPrefixLiveDf: null,
        analyzerVersion,
        profileVersion);

    public int AnalyzerVersion => _analyzerVersion;
    public int ProfileVersion => _profileVersion;
    public bool UsesWideProfile => _wide is not null;
    public int DocumentCount => _liveDocumentCount;
    public int SegmentCount => _wide is not null ? 1 : _segments.Length;
    public int DeadDocumentSlots => _deadDocumentSlots;
    public int TermCount => _wide is { } wide
        ? wide.Aliases.Length
        : (_globalLiveDf is not null ? _globalLiveDf.Count : (_segments.Length == 1 ? _segments[0].Terms.Length : 0));
    public int PostingCount
    {
        get
        {
            if (_wide is { } wide)
                return wide.Blocks.Sum(static block => block.Terms.Sum(static term => term.Count));
            var total = 0;
            for (var i = 0; i < _segments.Length; i++) total += _segments[i].Postings.Length;
            return total;
        }
    }
    public int BlockCount
    {
        get
        {
            var total = 0;
            for (var i = 0; i < _segments.Length; i++) total += _segments[i].Blocks.Length;
            return total;
        }
    }
    public long EstimatedRetainedBytes
    {
        get
        {
            if (_wide is { } wide)
                return wide.EstimatedBytes;
            long total = 0;
            for (var i = 0; i < _segments.Length; i++) total += _segments[i].EstimatedBytes;
            for (var i = 0; i < _liveMasks.Length; i++)
                if (_liveMasks[i] is { } mask) total += (long)mask.Length * sizeof(ulong);
            if (_globalLiveDf is not null) total += (long)_globalLiveDf.Count * 32;
            if (_globalShortPrefixLiveDf is not null) total += (long)_globalShortPrefixLiveDf.Count * 16;
            return total;
        }
    }

    public static ArticleSearchIndex? Build(IReadOnlyList<Article> articles, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(articles);
        ct.ThrowIfCancellationRequested();
        if (articles.Count == 0) return CreateEmpty(SearchTextAnalyzer.Version, SearchScoringProfile.ProfileVersion);
        if (articles.Count > CompactMaxDocuments) return BuildWide(articles, ct);
        return BuildSingleSegmentIndex(articles, "full", 0, ct, out _);
    }

    public Article[] Search(string query, CancellationToken ct) =>
        SearchPage(query, ArticleSearchSort.Relevance, 1, MaxResults, ct).Articles;

    public ArticleSearchPage SearchPage(string query, ArticleSearchSort sort, int page, int size, CancellationToken ct) =>
        SearchPage(SearchQueryPlan.Build(query, ct), sort, page, size, ct);

    public ArticleSearchPage SearchPage(SearchQueryPlan plan, ArticleSearchSort sort, int page, int size, CancellationToken ct)
    {
        var detailed = SearchDetailed(plan, sort, page, size, ct, out _);
        if (detailed.Hits.Length == 0) return new([], detailed.Total);
        var articles = new Article[detailed.Hits.Length];
        for (var i = 0; i < detailed.Hits.Length; i++) articles[i] = detailed.Hits[i].Article;
        return new(articles, detailed.Total);
    }

    public ArticleSearchDetailedPage SearchDetailed(string query, ArticleSearchSort sort, int page, int size, CancellationToken ct) =>
        SearchDetailed(SearchQueryPlan.Build(query, ct), sort, page, size, ct, out _);

    public ArticleSearchDetailedPage SearchDetailed(
        string query, ArticleSearchSort sort, int page, int size, CancellationToken ct, out SearchExecutionStats stats) =>
        SearchDetailed(SearchQueryPlan.Build(query, ct), sort, page, size, ct, out stats);

    public ArticleSearchDetailedPage SearchDetailed(
        SearchQueryPlan plan, ArticleSearchSort sort, int page, int size, CancellationToken ct, out SearchExecutionStats stats)
    {
        stats = default;
        ct.ThrowIfCancellationRequested();
        ArgumentOutOfRangeException.ThrowIfLessThan(page, 1);
        ArgumentOutOfRangeException.ThrowIfLessThan(size, 1);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(size, MaxResults);
        if (_liveDocumentCount == 0) return new([], 0, 0, 0);

        if (plan.IsEmpty || plan.IsOverlongExactIdentifier) return new([], 0, 0, 0);

        var start = (long)(page - 1) * size;
        var window = start >= MaxPaginatedResults ? 0 : (int)Math.Min(start + size, MaxPaginatedResults);
        var outcome = _wide is { } wide
            ? ExecuteWideSearch(wide, plan, sort, window, window, null, 0, window, DefaultWorkBudgetCandidates, ct, out stats)
            : ExecuteCompactSearch(plan, sort, window, window, null, 0, window, DefaultWorkBudgetCandidates, requireExactCount: true, ct, out stats);
        return BuildDetailedPageFromOutcome(outcome, (int)Math.Min(start, MaxPaginatedResults), window);
    }

    public ArticleSearchCursorPage SearchWithCursor(
        string query,
        ArticleSearchSort sort,
        int size,
        SearchCursorPosition? afterCursor,
        int returnedSoFar,
        CancellationToken ct,
        int? countThreshold = null,
        int? workBudget = null) =>
        SearchWithCursor(SearchQueryPlan.Build(query, ct), sort, size, afterCursor, returnedSoFar, ct, out _, countThreshold, workBudget);

    public ArticleSearchCursorPage SearchWithCursor(
        SearchQueryPlan plan,
        ArticleSearchSort sort,
        int size,
        SearchCursorPosition? afterCursor,
        int returnedSoFar,
        CancellationToken ct,
        int? countThreshold = null,
        int? workBudget = null) =>
        SearchWithCursor(plan, sort, size, afterCursor, returnedSoFar, ct, out _, countThreshold, workBudget);

    public ArticleSearchCursorPage SearchWithCursor(
        string query,
        ArticleSearchSort sort,
        int size,
        SearchCursorPosition? afterCursor,
        int returnedSoFar,
        CancellationToken ct,
        out SearchExecutionStats stats,
        int? countThreshold = null,
        int? workBudget = null) =>
        SearchWithCursor(SearchQueryPlan.Build(query, ct), sort, size, afterCursor, returnedSoFar, ct, out stats, countThreshold, workBudget);

    public ArticleSearchCursorPage SearchWithCursor(
        SearchQueryPlan plan,
        ArticleSearchSort sort,
        int size,
        SearchCursorPosition? afterCursor,
        int returnedSoFar,
        CancellationToken ct,
        out SearchExecutionStats stats,
        int? countThreshold = null,
        int? workBudget = null)
    {
        stats = default;
        ct.ThrowIfCancellationRequested();
        ArgumentOutOfRangeException.ThrowIfLessThan(size, 1);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(size, WireLimits.PublicSearchMaxPageSize);
        ArgumentOutOfRangeException.ThrowIfLessThan(returnedSoFar, 0);
        if (_liveDocumentCount == 0 || plan.IsEmpty || plan.IsOverlongExactIdentifier)
            return new([], 0, PublicSearchTotalRelation.Exact, 0, 0, false, null);

        var budget = Math.Max(1, workBudget ?? DefaultWorkBudgetCandidates);
        var threshold = Math.Max(1, countThreshold ?? MaxPaginatedResults);
        var remainingWindow = Math.Max(0, MaxPaginatedResults - Math.Max(0, returnedSoFar));
        var pageTake = Math.Min(size, remainingWindow);
        var needExtra = pageTake > 0 && returnedSoFar + pageTake < MaxPaginatedResults;
        var needTotal = pageTake + (needExtra ? 1 : 0);

        var outcome = _wide is { } wide
            ? ExecuteWideSearch(wide, plan, sort, needTotal, needTotal, afterCursor, returnedSoFar, pageTake, budget, ct, out stats)
            : ExecuteCompactSearch(plan, sort, needTotal, needTotal, afterCursor, returnedSoFar, pageTake, budget, requireExactCount: false, ct, out stats);
        return BuildCursorPageFromOutcome(outcome, size, returnedSoFar, threshold);
    }

    private static bool TryFindPosting(Posting[] postings, Term term, int ordinal, out Posting posting)
    {
        var lo = term.Start;
        var hi = term.Start + term.Count - 1;
        while (lo <= hi)
        {
            var mid = lo + ((hi - lo) >> 1);
            var ord = postings[mid].Ordinal;
            if (ord == ordinal) { posting = postings[mid]; return true; }
            if (ord < ordinal) lo = mid + 1;
            else hi = mid - 1;
        }
        posting = default;
        return false;
    }

    private static int PackShortPrefixHits(Article article, string prefix)
    {
        var span = prefix.AsSpan();
        var titleHits = Math.Min(1023, ArticleSearchTokens.CountAsciiPrefixMatches(article.Title, span));
        var sumHits = Math.Min(1023, ArticleSearchTokens.CountAsciiPrefixMatches(article.Summary ?? "", span));
        var taxHits = ArticleSearchTokens.CountAsciiPrefixMatches(article.Category?.Name ?? "", span);
        foreach (var tag in article.Tags ?? [])
            taxHits += ArticleSearchTokens.CountAsciiPrefixMatches(tag.Name, span);
        taxHits = Math.Min(1023, taxHits);
        return (titleHits << 20) | (sumHits << 10) | taxHits;
    }

    private static void UnpackShortPrefixTfs(int packed, Span<double> tfs)
    {
        tfs[(int)SearchScoreField.Title] = ((packed >> 20) & 1023) * SearchScoringProfile.ShortPrefixTitleTf;
        tfs[(int)SearchScoreField.Summary] = ((packed >> 10) & 1023) * SearchScoringProfile.ShortPrefixSummaryTf;
        tfs[(int)SearchScoreField.Taxonomy] = (packed & 1023) * SearchScoringProfile.ShortPrefixTaxonomyTf;
    }

    private static Term FindTerm(Term[] terms, SearchTermKey key)
    {
        var position = Array.BinarySearch(terms, new Term(key, 0, 0, 0, 0), Term.ByKey);
        return position >= 0 ? terms[position] : default;
    }

    private static double[] ComputeAvgFieldLengths(long[] totals, int docCount)
    {
        var avgs = new double[SearchScoringProfile.FieldCount];
        var denom = Math.Max(1, docCount);
        for (var f = 0; f < SearchScoringProfile.FieldCount; f++)
            avgs[f] = Math.Max(1.0, (double)totals[f] / denom);
        return avgs;
    }

    private sealed class PostingBuilder(long remainingChars)
    {
        private readonly record struct PendingPos(uint Packed, int Previous);
        private struct DocAccum
        {
            internal byte Tf0, Tf1, Tf2, Tf3, Tf4;
            internal byte ExactFlags;
            internal int PosHead;
            internal int PosCount;

            internal void AddHalfTf(int field, byte delta)
            {
                switch (field)
                {
                    case 0: Tf0 = (byte)Math.Min(254, Tf0 + delta); break;
                    case 1: Tf1 = (byte)Math.Min(254, Tf1 + delta); break;
                    case 2: Tf2 = (byte)Math.Min(254, Tf2 + delta); break;
                    case 3: Tf3 = (byte)Math.Min(254, Tf3 + delta); break;
                    default: Tf4 = (byte)Math.Min(254, Tf4 + delta); break;
                }
            }
        }

        private readonly Dictionary<SearchTermKey, DocAccum> _docTerms = [];
        private readonly Dictionary<ushort, int> _docShortPrefixes = [];
        private readonly List<PendingPos> _docPositions = [];
        private readonly List<uint> _posScratch = [];
        internal readonly Dictionary<SearchTermKey, Bucket> Heads = [];
        internal readonly List<PendingPosting> Pending = [];
        internal readonly List<uint> Positions = [];
        internal readonly Dictionary<ushort, Bucket> ShortPrefixHeads = [];
        internal readonly List<PendingShortPrefixPosting> PendingShortPrefixes = [];
        internal long TotalScannedChars;
        internal int AnalyzedDocuments;

        internal bool Collect(
            IReadOnlyList<Article> articles,
            IReadOnlyList<SearchDocFingerprint> fingerprints,
            DocumentMeta[] documents,
            long[] totalFieldLengths,
            int termLimit,
            int postingLimit,
            CancellationToken ct)
        {
            Heads.Clear();
            Pending.Clear();
            Positions.Clear();
            ShortPrefixHeads.Clear();
            PendingShortPrefixes.Clear();
            TotalScannedChars = 0;
            AnalyzedDocuments = 0;

            for (var ordinal = 0; ordinal < articles.Count; ordinal++)
            {
                ct.ThrowIfCancellationRequested();
                var article = articles[ordinal];
                _docTerms.Clear();
                _docShortPrefixes.Clear();
                _docPositions.Clear();
                long docChars = 0;
                AnalyzedDocuments++;

                if (!ChargeChars(article.Title.Length, ref docChars)) return false;
                var titleRes = SearchTextAnalyzer.AnalyzePlainField(article.Title, SearchFieldKind.Title, SearchAnalysisMode.Index, 0, ct);
                if (!Accumulate(titleRes.Tokens, SearchScoreField.Title, 0, termLimit)) return false;
                ArticleSearchTokens.AccumulateShortPrefixCounts(article.Title, 20, _docShortPrefixes);
                var titleLen = Math.Max(1, titleRes.SourceLength);

                var summaryText = article.Summary ?? "";
                if (!ChargeChars(summaryText.Length, ref docChars)) return false;
                var sumRes = SearchTextAnalyzer.AnalyzePlainField(summaryText, SearchFieldKind.Summary, SearchAnalysisMode.Index, 0, ct);
                if (!Accumulate(sumRes.Tokens, SearchScoreField.Summary, 0, termLimit)) return false;
                ArticleSearchTokens.AccumulateShortPrefixCounts(summaryText, 10, _docShortPrefixes);
                var sumLen = Math.Max(1, sumRes.SourceLength);

                var taxPos = 0;
                var taxLen = 0;
                if (article.Category is { Name.Length: > 0 } cat)
                {
                    if (!ChargeChars(cat.Name.Length, ref docChars)) return false;
                    var catRes = SearchTextAnalyzer.AnalyzePlainField(cat.Name, SearchFieldKind.Taxonomy, SearchAnalysisMode.Index, taxPos, ct);
                    if (!Accumulate(catRes.Tokens, SearchScoreField.Taxonomy, 0, termLimit)) return false;
                    ArticleSearchTokens.AccumulateShortPrefixCounts(cat.Name, 0, _docShortPrefixes);
                    taxLen += catRes.SourceLength;
                    taxPos = catRes.EndPosition + SearchTextAnalyzer.BlockPositionGap;
                }
                foreach (var tag in article.Tags ?? [])
                {
                    if (string.IsNullOrEmpty(tag.Name)) continue;
                    if (!ChargeChars(tag.Name.Length, ref docChars)) return false;
                    var tagRes = SearchTextAnalyzer.AnalyzePlainField(tag.Name, SearchFieldKind.Taxonomy, SearchAnalysisMode.Index, taxPos, ct);
                    if (!Accumulate(tagRes.Tokens, SearchScoreField.Taxonomy, 0, termLimit)) return false;
                    ArticleSearchTokens.AccumulateShortPrefixCounts(tag.Name, 0, _docShortPrefixes);
                    taxLen += tagRes.SourceLength;
                    taxPos = tagRes.EndPosition + SearchTextAnalyzer.BlockPositionGap;
                }
                taxLen = Math.Max(1, taxLen);

                var bodyText = article.Body ?? "";
                if (!ChargeChars(bodyText.Length, ref docChars)) return false;
                if (!SearchTextAnalyzer.VisitMarkdownIndexTokens(bodyText,
                    (tokens, field, shift) => Accumulate(tokens, SearchScoringProfile.ToScoreField(field), shift, termLimit),
                    ct, out var headingLength, out var bodyLength))
                    return false;
                var headingLen = Math.Max(1, headingLength);
                var bodyLen = Math.Max(1, bodyLength);

                documents[ordinal] = new DocumentMeta(
                    article.Id,
                    titleLen,
                    headingLen,
                    sumLen,
                    taxLen,
                    bodyLen,
                    article.PublishedAt.UtcTicks,
                    article.CreatedAt.UtcTicks,
                    docChars,
                    fingerprints[ordinal]);
                totalFieldLengths[0] += titleLen;
                totalFieldLengths[1] += headingLen;
                totalFieldLengths[2] += sumLen;
                totalFieldLengths[3] += taxLen;
                totalFieldLengths[4] += bodyLen;
                TotalScannedChars += docChars;

                if (_docTerms.Count > postingLimit - Pending.Count) return false;
                foreach (var (key, acc) in _docTerms)
                {
                    ref var bucket = ref CollectionsMarshal.GetValueRefOrAddDefault(Heads, key, out var found);
                    if (!found)
                    {
                        if (Heads.Count > termLimit) return false;
                        bucket = new Bucket(-1, 0);
                    }

                    var posStart = 0;
                    var posCount = 0;
                    if (acc.PosCount > 0)
                    {
                        _posScratch.Clear();
                        for (var p = acc.PosHead; p >= 0; p = _docPositions[p].Previous)
                            _posScratch.Add(_docPositions[p].Packed);
                        _posScratch.Sort();
                        posStart = Positions.Count;
                        uint last = 0;
                        for (var i = 0; i < _posScratch.Count; i++)
                        {
                            var val = _posScratch[i];
                            if (i > 0 && val == last) continue;
                            last = val;
                            Positions.Add(val);
                        }
                        posCount = Positions.Count - posStart;
                    }

                    Pending.Add(new PendingPosting(
                        new Posting(ordinal, acc.Tf0, acc.Tf1, acc.Tf2, acc.Tf3, acc.Tf4, acc.ExactFlags, posStart, posCount),
                        bucket.Head));
                    bucket = new Bucket(Pending.Count - 1, bucket.Count + 1);
                }

                foreach (var (spKey, packed) in _docShortPrefixes)
                {
                    if (packed == 0) continue;
                    ref var bucket = ref CollectionsMarshal.GetValueRefOrAddDefault(ShortPrefixHeads, spKey, out var found);
                    if (!found) bucket = new Bucket(-1, 0);
                    PendingShortPrefixes.Add(new PendingShortPrefixPosting(new ShortPrefixPosting(ordinal, packed), bucket.Head));
                    bucket = new Bucket(PendingShortPrefixes.Count - 1, bucket.Count + 1);
                }
            }
            return true;
        }

        private bool ChargeChars(int count, ref long docChars)
        {
            remainingChars -= count;
            docChars += count;
            return remainingChars >= 0;
        }

        private bool Accumulate(IReadOnlyList<SearchToken> tokens, SearchScoreField field, int posShift, int termLimit)
        {
            var fIdx = (int)field;
            for (var i = 0; i < tokens.Count; i++)
            {
                var tok = tokens[i];
                var key = SearchTermKey.From(tok);
                ref var acc = ref CollectionsMarshal.GetValueRefOrAddDefault(_docTerms, key, out var exists);
                if (!exists)
                {
                    if (_docTerms.Count > termLimit) return false;
                    acc.PosHead = -1;
                }
                var role = ArticleSearchTokens.TokenRole(tok);
                acc.AddHalfTf(fIdx, role <= 1 ? (byte)2 : (byte)1);
                if (role == 0) acc.ExactFlags |= ExactFlagBit;
                if (tok.Kind is SearchTokenKind.Exact or SearchTokenKind.CjkBigram or SearchTokenKind.Subword or SearchTokenKind.ScriptAlias)
                {
                    var packed = SearchScoringProfile.PackPosition(field, tok.Position + posShift, tok.Width);
                    var nextIdx = _docPositions.Count;
                    _docPositions.Add(new PendingPos(packed, acc.PosHead));
                    acc.PosHead = nextIdx;
                    acc.PosCount++;
                }
            }
            return true;
        }
    }

    private readonly record struct Posting(
        int Ordinal,
        byte Tf0, byte Tf1, byte Tf2, byte Tf3, byte Tf4,
        byte ExactFlags,
        int PosStart,
        int PosCount)
    {
        internal double FieldTf(int field) => (field switch
        {
            0 => Tf0,
            1 => Tf1,
            2 => Tf2,
            3 => Tf3,
            _ => Tf4
        }) * 0.5;
    }

    private readonly record struct PendingPosting(Posting Value, int Previous);
    private readonly record struct ShortPrefixPosting(int Ordinal, int Packed);
    private readonly record struct PendingShortPrefixPosting(ShortPrefixPosting Value, int Previous);
    private readonly record struct ShortPrefixBlockMeta(
        int MaxOrdinal,
        ushort MaxTitleHits, ushort MaxSummaryHits, ushort MaxTaxonomyHits,
        ushort MinLen0, ushort MinLen2, ushort MinLen3,
        long MaxPublishedTicks, long MinPublishedTicks);
    private readonly record struct Bucket(int Head, int Count);

    private readonly record struct Term(SearchTermKey Key, int Start, int Count, int BlockStart, int BlockCount)
    {
        internal static readonly IComparer<Term> ByKey =
            Comparer<Term>.Create(static (left, right) => left.Key.CompareTo(right.Key));
    }

    private readonly record struct ShortPrefixTerm(ushort Key, int Start, int Count, int BlockStart, int BlockCount)
    {
        internal static readonly IComparer<ShortPrefixTerm> ByKey =
            Comparer<ShortPrefixTerm>.Create(static (left, right) => left.Key.CompareTo(right.Key));
    }
}
