using System.Runtime.InteropServices;

namespace FsusBlog.V2.Contracts;

public enum ArticleSearchSort
{
    Relevance = 0,
    Latest = 1
}

public readonly record struct ArticleSearchPage(Article[] Articles, int Total);

/// <summary>
/// In-memory concept-aware BM25F search index over the active public generation (#46, #48, profile v3).
/// Compact (&lt;= 40,000 docs) and Wide (40,001..100,000 docs) profiles compute identical globally consistent
/// 5-field BM25F scores, concept coverage, CJK bigram sequences, quoted phrases, bounded relaxation,
/// and deterministic tie-breaking, verified against <see cref="ExhaustiveSearchOracle"/>.
/// Compact retrieval uses selective exact intersections for rare queries and Block-Max conjunction /
/// Block-Max WAND / Latest block pruning with pooled Top-K heaps for broad queries.
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

    private readonly Document[] _documents;
    private readonly double[] _avgFieldLengths;
    private readonly Term[] _terms;
    private readonly Posting[] _postings;
    private readonly SearchPostingBlockMeta[] _blocks;
    private readonly uint[] _positions;
    private readonly ShortPrefixTerm[] _shortPrefixTerms;
    private readonly ShortPrefixPosting[] _shortPrefixPostings;
    private readonly ShortPrefixBlockMeta[] _shortPrefixBlocks;
    private readonly WideIndex? _wide;

    private ArticleSearchIndex(
        Document[] documents,
        double[] avgFieldLengths,
        Term[] terms,
        Posting[] postings,
        SearchPostingBlockMeta[] blocks,
        uint[] positions,
        ShortPrefixTerm[] shortPrefixTerms,
        ShortPrefixPosting[] shortPrefixPostings,
        ShortPrefixBlockMeta[] shortPrefixBlocks,
        WideIndex? wide = null) =>
        (_documents, _avgFieldLengths, _terms, _postings, _blocks, _positions,
            _shortPrefixTerms, _shortPrefixPostings, _shortPrefixBlocks, _wide) =
            (documents, avgFieldLengths, terms, postings, blocks, positions,
                shortPrefixTerms, shortPrefixPostings, shortPrefixBlocks, wide);

    public int AnalyzerVersion => SearchTextAnalyzer.Version;
    public int ProfileVersion => SearchScoringProfile.ProfileVersion;
    public bool UsesWideProfile => _wide is not null;
    public int DocumentCount => _documents.Length;
    public int TermCount => _wide is { } wide ? wide.Aliases.Length : _terms.Length;
    public int PostingCount => _wide is { } wide
        ? wide.Blocks.Sum(static block => block.Terms.Sum(static term => term.Count))
        : _postings.Length;
    public int BlockCount => _blocks.Length;

    public static ArticleSearchIndex? Build(IReadOnlyList<Article> articles, CancellationToken ct)
    {
        if (articles.Count > CompactMaxDocuments) return BuildWide(articles, ct);

        var documents = new Document[articles.Count];
        var totalFieldLengths = new long[SearchScoringProfile.FieldCount];
        var builder = new PostingBuilder(MaxScannedChars);
        if (!builder.Collect(articles, documents, totalFieldLengths, MaxTerms, MaxPostings, ct)) return null;

        // Materialize postings in ascending Ordinal order and compute 64-doc generation-independent block bounds
        var totalBlocks = 0;
        foreach (var bucket in builder.Heads.Values)
            totalBlocks += (bucket.Count + PostingBlockSize - 1) / PostingBlockSize;

        var terms = new Term[builder.Heads.Count];
        var postings = new Posting[builder.Pending.Count];
        var blocks = new SearchPostingBlockMeta[totalBlocks];
        var termIndex = 0;
        var start = 0;
        var blockCursor = 0;

        foreach (var (key, bucket) in builder.Heads)
        {
            ct.ThrowIfCancellationRequested();
            var bCount = (bucket.Count + PostingBlockSize - 1) / PostingBlockSize;
            terms[termIndex++] = new Term(key, start, bucket.Count, blockCursor, bCount);

            var write = start + bucket.Count - 1;
            for (var entry = bucket.Head; entry >= 0; entry = builder.Pending[entry].Previous)
                postings[write--] = builder.Pending[entry].Value;

            for (var b = 0; b < bCount; b++)
            {
                var bStart = start + b * PostingBlockSize;
                var bEnd = Math.Min(start + bucket.Count, bStart + PostingBlockSize);
                byte mTf0 = 0, mTf1 = 0, mTf2 = 0, mTf3 = 0, mTf4 = 0, anyExact = 0;
                ushort minL0 = ushort.MaxValue, minL1 = ushort.MaxValue, minL2 = ushort.MaxValue,
                       minL3 = ushort.MaxValue, minL4 = ushort.MaxValue;
                var maxPub = long.MinValue;
                var minPub = long.MaxValue;

                for (var i = bStart; i < bEnd; i++)
                {
                    var p = postings[i];
                    if (p.Tf0 > mTf0) mTf0 = p.Tf0;
                    if (p.Tf1 > mTf1) mTf1 = p.Tf1;
                    if (p.Tf2 > mTf2) mTf2 = p.Tf2;
                    if (p.Tf3 > mTf3) mTf3 = p.Tf3;
                    if (p.Tf4 > mTf4) mTf4 = p.Tf4;
                    anyExact |= (byte)(p.ExactFlags & ExactFlagBit);

                    var d = documents[p.Ordinal];
                    var l0 = (ushort)Math.Min(ushort.MaxValue, d.TitleLen);
                    var l1 = (ushort)Math.Min(ushort.MaxValue, d.HeadingLen);
                    var l2 = (ushort)Math.Min(ushort.MaxValue, d.SummaryLen);
                    var l3 = (ushort)Math.Min(ushort.MaxValue, d.TaxonomyLen);
                    var l4 = (ushort)Math.Min(ushort.MaxValue, d.BodyLen);
                    if (l0 < minL0) minL0 = l0;
                    if (l1 < minL1) minL1 = l1;
                    if (l2 < minL2) minL2 = l2;
                    if (l3 < minL3) minL3 = l3;
                    if (l4 < minL4) minL4 = l4;

                    var pub = d.Article.PublishedAt.UtcTicks;
                    if (pub > maxPub) maxPub = pub;
                    if (pub < minPub) minPub = pub;
                }

                blocks[blockCursor++] = new SearchPostingBlockMeta(
                    postings[bEnd - 1].Ordinal,
                    mTf0, mTf1, mTf2, mTf3, mTf4,
                    anyExact,
                    minL0, minL1, minL2, minL3, minL4,
                    maxPub, minPub);
            }

            start += bucket.Count;
        }
        Array.Sort(terms, Term.ByKey);

        // Materialize pre-indexed 1-2 char ASCII short-prefix postings & block metadata (eliminates O(N) metadata scans)
        var totalSpBlocks = 0;
        foreach (var bucket in builder.ShortPrefixHeads.Values)
            totalSpBlocks += (bucket.Count + PostingBlockSize - 1) / PostingBlockSize;

        var spTerms = new ShortPrefixTerm[builder.ShortPrefixHeads.Count];
        var spPostings = new ShortPrefixPosting[builder.PendingShortPrefixes.Count];
        var spBlocks = new ShortPrefixBlockMeta[totalSpBlocks];
        var spTermIndex = 0;
        var spStart = 0;
        var spBlockCursor = 0;

        foreach (var (spKey, bucket) in builder.ShortPrefixHeads)
        {
            ct.ThrowIfCancellationRequested();
            var bCount = (bucket.Count + PostingBlockSize - 1) / PostingBlockSize;
            spTerms[spTermIndex++] = new ShortPrefixTerm(spKey, spStart, bucket.Count, spBlockCursor, bCount);

            var write = spStart + bucket.Count - 1;
            for (var entry = bucket.Head; entry >= 0; entry = builder.PendingShortPrefixes[entry].Previous)
                spPostings[write--] = builder.PendingShortPrefixes[entry].Value;

            for (var b = 0; b < bCount; b++)
            {
                var bStart = spStart + b * PostingBlockSize;
                var bEnd = Math.Min(spStart + bucket.Count, bStart + PostingBlockSize);
                ushort maxT = 0, maxS = 0, maxX = 0;
                ushort minL0 = ushort.MaxValue, minL2 = ushort.MaxValue, minL3 = ushort.MaxValue;
                var maxPub = long.MinValue;
                var minPub = long.MaxValue;

                for (var i = bStart; i < bEnd; i++)
                {
                    var sp = spPostings[i];
                    var tHits = (ushort)((sp.Packed >> 20) & 1023);
                    var sHits = (ushort)((sp.Packed >> 10) & 1023);
                    var xHits = (ushort)(sp.Packed & 1023);
                    if (tHits > maxT) maxT = tHits;
                    if (sHits > maxS) maxS = sHits;
                    if (xHits > maxX) maxX = xHits;

                    var d = documents[sp.Ordinal];
                    var l0 = (ushort)Math.Min(ushort.MaxValue, d.TitleLen);
                    var l2 = (ushort)Math.Min(ushort.MaxValue, d.SummaryLen);
                    var l3 = (ushort)Math.Min(ushort.MaxValue, d.TaxonomyLen);
                    if (l0 < minL0) minL0 = l0;
                    if (l2 < minL2) minL2 = l2;
                    if (l3 < minL3) minL3 = l3;

                    var pub = d.Article.PublishedAt.UtcTicks;
                    if (pub > maxPub) maxPub = pub;
                    if (pub < minPub) minPub = pub;
                }

                spBlocks[spBlockCursor++] = new ShortPrefixBlockMeta(
                    spPostings[bEnd - 1].Ordinal,
                    maxT, maxS, maxX,
                    minL0, minL2, minL3,
                    maxPub, minPub);
            }

            spStart += bucket.Count;
        }
        Array.Sort(spTerms, ShortPrefixTerm.ByKey);

        var avgFieldLengths = ComputeAvgFieldLengths(totalFieldLengths, articles.Count);
        return new ArticleSearchIndex(
            documents, avgFieldLengths, terms, postings, blocks, [.. builder.Positions],
            spTerms, spPostings, spBlocks);
    }

    public Article[] Search(string query, CancellationToken ct) =>
        SearchPage(query, ArticleSearchSort.Relevance, 1, MaxResults, ct).Articles;

    public ArticleSearchPage SearchPage(string query, ArticleSearchSort sort, int page, int size, CancellationToken ct)
    {
        var detailed = SearchDetailed(query, sort, page, size, ct, out _);
        if (detailed.Hits.Length == 0) return new([], detailed.Total);
        var articles = new Article[detailed.Hits.Length];
        for (var i = 0; i < detailed.Hits.Length; i++) articles[i] = detailed.Hits[i].Article;
        return new(articles, detailed.Total);
    }

    public ArticleSearchDetailedPage SearchDetailed(string query, ArticleSearchSort sort, int page, int size, CancellationToken ct) =>
        SearchDetailed(query, sort, page, size, ct, out _);

    public ArticleSearchDetailedPage SearchDetailed(
        string query, ArticleSearchSort sort, int page, int size, CancellationToken ct, out SearchExecutionStats stats)
    {
        stats = default;
        ct.ThrowIfCancellationRequested();
        ArgumentOutOfRangeException.ThrowIfLessThan(page, 1);
        ArgumentOutOfRangeException.ThrowIfLessThan(size, 1);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(size, MaxResults);
        if (_documents.Length == 0) return new([], 0, 0, 0);

        var plan = SearchQueryPlan.Build(query, ct);
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
        if (_documents.Length == 0 || plan.IsEmpty || plan.IsOverlongExactIdentifier)
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

    private bool TryFindPosting(Term term, int ordinal, out Posting posting)
    {
        var lo = term.Start;
        var hi = term.Start + term.Count - 1;
        while (lo <= hi)
        {
            var mid = lo + ((hi - lo) >> 1);
            var ord = _postings[mid].Ordinal;
            if (ord == ordinal) { posting = _postings[mid]; return true; }
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

        internal bool Collect(IReadOnlyList<Article> articles, Document[] documents, long[] totalFieldLengths,
            int termLimit, int postingLimit, CancellationToken ct)
        {
            Heads.Clear();
            Pending.Clear();
            Positions.Clear();
            ShortPrefixHeads.Clear();
            PendingShortPrefixes.Clear();

            for (var ordinal = 0; ordinal < articles.Count; ordinal++)
            {
                ct.ThrowIfCancellationRequested();
                var article = articles[ordinal];
                _docTerms.Clear();
                _docShortPrefixes.Clear();
                _docPositions.Clear();

                if (!ChargeChars(article.Title.Length)) return false;
                var titleRes = SearchTextAnalyzer.AnalyzePlainField(article.Title, SearchFieldKind.Title, SearchAnalysisMode.Index, 0, ct);
                if (!Accumulate(titleRes.Tokens, SearchScoreField.Title, 0, termLimit)) return false;
                ArticleSearchTokens.AccumulateShortPrefixCounts(article.Title, 20, _docShortPrefixes);
                var titleLen = Math.Max(1, titleRes.SourceLength);

                var summaryText = article.Summary ?? "";
                if (!ChargeChars(summaryText.Length)) return false;
                var sumRes = SearchTextAnalyzer.AnalyzePlainField(summaryText, SearchFieldKind.Summary, SearchAnalysisMode.Index, 0, ct);
                if (!Accumulate(sumRes.Tokens, SearchScoreField.Summary, 0, termLimit)) return false;
                ArticleSearchTokens.AccumulateShortPrefixCounts(summaryText, 10, _docShortPrefixes);
                var sumLen = Math.Max(1, sumRes.SourceLength);

                var taxPos = 0;
                var taxLen = 0;
                if (article.Category is { Name.Length: > 0 } cat)
                {
                    if (!ChargeChars(cat.Name.Length)) return false;
                    var catRes = SearchTextAnalyzer.AnalyzePlainField(cat.Name, SearchFieldKind.Taxonomy, SearchAnalysisMode.Index, taxPos, ct);
                    if (!Accumulate(catRes.Tokens, SearchScoreField.Taxonomy, 0, termLimit)) return false;
                    ArticleSearchTokens.AccumulateShortPrefixCounts(cat.Name, 0, _docShortPrefixes);
                    taxLen += catRes.SourceLength;
                    taxPos = catRes.EndPosition + SearchTextAnalyzer.BlockPositionGap;
                }
                foreach (var tag in article.Tags ?? [])
                {
                    if (string.IsNullOrEmpty(tag.Name)) continue;
                    if (!ChargeChars(tag.Name.Length)) return false;
                    var tagRes = SearchTextAnalyzer.AnalyzePlainField(tag.Name, SearchFieldKind.Taxonomy, SearchAnalysisMode.Index, taxPos, ct);
                    if (!Accumulate(tagRes.Tokens, SearchScoreField.Taxonomy, 0, termLimit)) return false;
                    ArticleSearchTokens.AccumulateShortPrefixCounts(tag.Name, 0, _docShortPrefixes);
                    taxLen += tagRes.SourceLength;
                    taxPos = tagRes.EndPosition + SearchTextAnalyzer.BlockPositionGap;
                }
                taxLen = Math.Max(1, taxLen);

                var bodyText = article.Body ?? "";
                if (!ChargeChars(bodyText.Length)) return false;
                var (headings, prose, code) = SearchTextAnalyzer.AnalyzeMarkdownBody(bodyText, ct);
                if (!Accumulate(headings.Tokens, SearchScoreField.Heading, 0, termLimit)) return false;
                var headingLen = Math.Max(1, headings.SourceLength);

                var codeShift = prose.EndPosition > 0 ? prose.EndPosition + SearchTextAnalyzer.BlockPositionGap : 0;
                if (!Accumulate(prose.Tokens, SearchScoreField.Body, 0, termLimit) ||
                    !Accumulate(code.Tokens, SearchScoreField.Body, codeShift, termLimit))
                    return false;
                var bodyLen = Math.Max(1, prose.SourceLength + code.SourceLength);

                documents[ordinal] = new Document(article, titleLen, headingLen, sumLen, taxLen, bodyLen);
                totalFieldLengths[0] += titleLen;
                totalFieldLengths[1] += headingLen;
                totalFieldLengths[2] += sumLen;
                totalFieldLengths[3] += taxLen;
                totalFieldLengths[4] += bodyLen;

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
                    ushort posCount = 0;
                    if (acc.PosCount > 0)
                    {
                        _posScratch.Clear();
                        for (var p = acc.PosHead; p >= 0; p = _docPositions[p].Previous)
                            _posScratch.Add(_docPositions[p].Packed);
                        _posScratch.Sort();
                        posStart = Positions.Count;
                        uint last = 0;
                        var added = 0;
                        for (var i = 0; i < _posScratch.Count; i++)
                        {
                            var val = _posScratch[i];
                            if (i > 0 && val == last) continue;
                            last = val;
                            Positions.Add(val);
                            added++;
                            if (added == ushort.MaxValue) break;
                        }
                        posCount = (ushort)added;
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

        private bool ChargeChars(int count)
        {
            remainingChars -= count;
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
        ushort PosCount)
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

    private readonly record struct Document(Article Article, int TitleLen, int HeadingLen, int SummaryLen, int TaxonomyLen, int BodyLen)
    {
        internal void CopyLengths(Span<int> target)
        {
            target[0] = TitleLen;
            target[1] = HeadingLen;
            target[2] = SummaryLen;
            target[3] = TaxonomyLen;
            target[4] = BodyLen;
        }
    }

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
