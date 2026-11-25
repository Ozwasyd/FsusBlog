using System.Runtime.InteropServices;

namespace FsusBlog.V2.Contracts;

public enum ArticleSearchSort
{
    Relevance = 0,
    Latest = 1
}

public readonly record struct ArticleSearchPage(Article[] Articles, int Total);

/// <summary>
/// In-memory concept-aware BM25F search index over the active public generation (#46, profile v3).
/// Compact (&lt;= 40,000 docs) and Wide (40,001..100,000 docs) profiles compute identical globally consistent
/// 5-field BM25F scores, concept coverage, CJK bigram sequences, quoted phrases, bounded relaxation,
/// and deterministic tie-breaking, verified against <see cref="ExhaustiveSearchOracle"/>.
/// </summary>
public sealed partial class ArticleSearchIndex
{
    private const int MaxResults = 200;
    public const int MaxPaginatedResults = 1_000;
    private const int CompactMaxDocuments = WireLimits.SearchIndexMaxPages * WireLimits.SearchIndexPageSize;
    private const int MaxTerms = 262_144;
    private const int MaxPostings = 3_000_000;
    private const long MaxScannedChars = 128 * 1024 * 1024;
    private const byte ExactFlagBit = 1;

    private readonly Document[] _documents;
    private readonly double[] _avgFieldLengths;
    private readonly Term[] _terms;
    private readonly Posting[] _postings;
    private readonly uint[] _positions;
    private readonly WideIndex? _wide;

    private ArticleSearchIndex(
        Document[] documents,
        double[] avgFieldLengths,
        Term[] terms,
        Posting[] postings,
        uint[] positions,
        WideIndex? wide = null) =>
        (_documents, _avgFieldLengths, _terms, _postings, _positions, _wide) =
            (documents, avgFieldLengths, terms, postings, positions, wide);

    public int AnalyzerVersion => SearchTextAnalyzer.Version;
    public int ProfileVersion => SearchScoringProfile.ProfileVersion;
    public bool UsesWideProfile => _wide is not null;
    public int DocumentCount => _documents.Length;
    public int TermCount => _wide is { } wide ? wide.Aliases.Length : _terms.Length;
    public int PostingCount => _wide is { } wide
        ? wide.Blocks.Sum(static block => block.Terms.Sum(static term => term.Count))
        : _postings.Length;

    public static ArticleSearchIndex? Build(IReadOnlyList<Article> articles, CancellationToken ct)
    {
        if (articles.Count > CompactMaxDocuments) return BuildWide(articles, ct);

        var documents = new Document[articles.Count];
        var totalFieldLengths = new long[SearchScoringProfile.FieldCount];
        var builder = new PostingBuilder(MaxScannedChars);
        if (!builder.Collect(articles, documents, totalFieldLengths, MaxTerms, MaxPostings, ct)) return null;

        var terms = new Term[builder.Heads.Count];
        var postings = new Posting[builder.Pending.Count];
        var termIndex = 0;
        var start = 0;
        foreach (var (key, bucket) in builder.Heads)
        {
            ct.ThrowIfCancellationRequested();
            terms[termIndex++] = new Term(key, start, bucket.Count);
            // Reverse linked list into ascending Ordinal order for O(log df) lookup and #48 seeking
            var write = start + bucket.Count - 1;
            for (var entry = bucket.Head; entry >= 0; entry = builder.Pending[entry].Previous)
                postings[write--] = builder.Pending[entry].Value;
            start += bucket.Count;
        }
        Array.Sort(terms, Term.ByKey);

        var avgFieldLengths = ComputeAvgFieldLengths(totalFieldLengths, articles.Count);
        return new ArticleSearchIndex(documents, avgFieldLengths, terms, postings, [.. builder.Positions]);
    }

    public Article[] Search(string query, CancellationToken ct) =>
        SearchPage(query, ArticleSearchSort.Relevance, 1, MaxResults, ct).Articles;

    public ArticleSearchPage SearchPage(string query, ArticleSearchSort sort, int page, int size, CancellationToken ct)
    {
        var detailed = SearchDetailed(query, sort, page, size, ct);
        if (detailed.Hits.Length == 0) return new([], detailed.Total);
        var articles = new Article[detailed.Hits.Length];
        for (var i = 0; i < detailed.Hits.Length; i++) articles[i] = detailed.Hits[i].Article;
        return new(articles, detailed.Total);
    }

    public ArticleSearchDetailedPage SearchDetailed(string query, ArticleSearchSort sort, int page, int size, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        ArgumentOutOfRangeException.ThrowIfLessThan(page, 1);
        ArgumentOutOfRangeException.ThrowIfLessThan(size, 1);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(size, MaxResults);
        if (_documents.Length == 0) return new([], 0, 0, 0);

        var plan = SearchQueryPlan.Build(query, ct);
        if (plan.IsEmpty || plan.IsOverlongExactIdentifier) return new([], 0, 0, 0);

        var start = (long)(page - 1) * size;
        var window = start >= MaxPaginatedResults ? 0 : (int)Math.Min(start + size, MaxPaginatedResults);
        if (_wide is { } wide)
            return SearchWideDetailed(wide, plan, sort, (int)Math.Min(start, MaxPaginatedResults), window, ct);

        return SearchCompactDetailed(plan, sort, (int)Math.Min(start, MaxPaginatedResults), window, ct);
    }

    private ArticleSearchDetailedPage SearchCompactDetailed(SearchQueryPlan plan, ArticleSearchSort sort,
        int start, int window, CancellationToken ct)
    {
        var n = _documents.Length;
        var concepts = plan.ContentConcepts;
        var conceptIdfs = new double[concepts.Length];
        var shortPrefixIdfs = new double[concepts.Length];
        var shortPrefixWeights = new int[concepts.Length][]; // non-null only for concepts with short ASCII prefix
        var totalQueryIdf = 0.0;

        // Resolve dictionary terms once per unique key
        var resolvedTerms = new Dictionary<SearchTermKey, Term>();
        Term Lookup(SearchTermKey key)
        {
            if (resolvedTerms.TryGetValue(key, out var found)) return found;
            found = FindTerm(_terms, key);
            resolvedTerms[key] = found;
            return found;
        }

        // Pre-resolve every concept step & quoted phrase step
        foreach (var phrase in plan.QuotedPhrases)
        {
            foreach (var st in phrase.Steps)
            {
                if (Lookup(st.CanonicalKey).Count == 0) return new([], 0, 0, 0);
            }
        }

        var allowsRelaxation = SearchScoringProfile.AllowsRelaxation(plan);
        var minRelaxed = SearchScoringProfile.MinRelaxedConcepts(concepts.Length);
        var minRelaxedRatio = SearchScoringProfile.MinRelaxedIdfRatio(concepts.Length);

        var possibleConcepts = 0;
        var possibleIdfSum = 0.0;
        for (var c = 0; c < concepts.Length; c++)
        {
            ct.ThrowIfCancellationRequested();
            var concept = concepts[c];
            double idf;
            var canMatch = false;
            switch (concept.Kind)
            {
                case SearchConceptKind.CjkSequence:
                {
                    var maxIdf = 0.0;
                    var allPresent = true;
                    foreach (var st in concept.Steps)
                    {
                        var df = Lookup(st.CanonicalKey).Count;
                        if (df == 0) allPresent = false;
                        if (st.DiffersFromExactForm) Lookup(st.ExactFormKey);
                        var stIdf = SearchScoringProfile.InverseDocumentFrequency(n, df);
                        if (stIdf > maxIdf) maxIdf = stIdf;
                    }
                    idf = maxIdf;
                    canMatch = allPresent;
                    break;
                }
                case SearchConceptKind.CompoundHyphen:
                {
                    var exactDf = Lookup(concept.Steps[0].CanonicalKey).Count;
                    var minSubDf = n;
                    var allSubs = concept.Steps.Length > 1;
                    for (var i = 1; i < concept.Steps.Length; i++)
                    {
                        var d = Lookup(concept.Steps[i].CanonicalKey).Count;
                        if (d == 0) allSubs = false;
                        if (d < minSubDf) minSubDf = d;
                    }
                    var combinedDf = Math.Min(n, Math.Max(exactDf, allSubs ? minSubDf : 0));
                    idf = SearchScoringProfile.InverseDocumentFrequency(n, combinedDf);
                    canMatch = exactDf > 0 || allSubs;
                    break;
                }
                default:
                {
                    var st = concept.Steps[0];
                    var df = Lookup(st.CanonicalKey).Count;
                    if (st.DiffersFromExactForm) Lookup(st.ExactFormKey);
                    idf = SearchScoringProfile.InverseDocumentFrequency(n, df);
                    canMatch = df > 0;
                    if (concept.ShortAsciiPrefix is { } prefix)
                    {
                        var prefixDf = 0;
                        var packedCounts = new int[n];
                        for (var ord = 0; ord < n; ord++)
                        {
                            if ((ord & 1023) == 0) ct.ThrowIfCancellationRequested();
                            var p = PackShortPrefixHits(_documents[ord].Article, prefix);
                            if (p != 0) { packedCounts[ord] = p; prefixDf++; }
                        }
                        if (prefixDf > 0)
                        {
                            shortPrefixWeights[c] = packedCounts;
                            shortPrefixIdfs[c] = SearchScoringProfile.InverseDocumentFrequency(n, Math.Min(n, df + prefixDf));
                            canMatch = true;
                        }
                    }
                    break;
                }
            }

            conceptIdfs[c] = idf;
            totalQueryIdf += idf;
            if (!canMatch)
            {
                if (concept.IsStrictIdentifier || !allowsRelaxation) return new([], 0, 0, 0);
            }
            else
            {
                possibleConcepts++;
                possibleIdfSum += idf;
            }
        }

        if (possibleConcepts < minRelaxed || (totalQueryIdf > 0.0 && possibleIdfSum / totalQueryIdf < minRelaxedRatio))
            return new([], 0, 0, 0);

        // Pre-resolve OrderedQuerySequence keys for proximity bonus
        foreach (var st in plan.OrderedQuerySequence) Lookup(st.CanonicalKey);

        // Collect candidate document ordinals without scanning the full corpus when selective
        var candidateOrdinals = CollectCompactCandidates(plan, concepts, shortPrefixWeights, Lookup, allowsRelaxation, ct);
        if (candidateOrdinals.Count == 0) return new([], 0, 0, 0);

        var primaryHits = new List<ArticleSearchHit>();
        var relaxedHits = new List<ArticleSearchHit>();
        Span<double> tfs = stackalloc double[SearchScoringProfile.FieldCount];
        Span<int> docLens = stackalloc int[SearchScoringProfile.FieldCount];

        foreach (var ordinal in candidateOrdinals)
        {
            ct.ThrowIfCancellationRequested();

            // 1. Strict quoted phrases MUST match (never relaxed)
            var phraseOk = true;
            foreach (var phrase in plan.QuotedPhrases)
            {
                if (!CompactMatchesExactSequence(ordinal, phrase.Steps, Lookup, out _))
                {
                    phraseOk = false;
                    break;
                }
            }
            if (!phraseOk) continue;

            var doc = _documents[ordinal];
            doc.CopyLengths(docLens);

            var matchedCount = 0;
            var matchedIdfSum = 0.0;
            var strictOk = true;
            var score = 0.0;

            for (var c = 0; c < concepts.Length; c++)
            {
                var concept = concepts[c];
                tfs.Clear();
                var matched = EvaluateCompactConcept(ordinal, concept, shortPrefixWeights[c], Lookup, tfs,
                    out var exactFormHit, out var usedShortPrefixOnly);
                if (!matched)
                {
                    if (concept.IsStrictIdentifier) { strictOk = false; break; }
                    continue;
                }
                matchedCount++;
                matchedIdfSum += conceptIdfs[c];
                var activeIdf = usedShortPrefixOnly ? shortPrefixIdfs[c] : conceptIdfs[c];
                score += SearchScoringProfile.ScoreConceptBm25F(activeIdf, tfs, docLens, _avgFieldLengths);
                if (exactFormHit)
                    score += SearchScoringProfile.ExactFormBonusFactor * activeIdf;
            }
            if (!strictOk || matchedCount == 0) continue;

            var isPrimary = matchedCount == concepts.Length;
            var isRelaxed = !isPrimary && allowsRelaxation &&
                            matchedCount >= minRelaxed &&
                            totalQueryIdf > 0.0 &&
                            (matchedIdfSum / totalQueryIdf) >= minRelaxedRatio;
            if (!isPrimary && !isRelaxed) continue;

            if (plan.QuotedPhrases.Length > 0 || (isPrimary && plan.OrderedQuerySequence.Length >= 2))
            {
                var seq = plan.QuotedPhrases.Length > 0 ? plan.QuotedPhrases[0].Steps : plan.OrderedQuerySequence;
                if (CompactMatchesExactSequence(ordinal, seq, Lookup, out var matchField))
                {
                    var factor = matchField is SearchScoreField.Title or SearchScoreField.Heading
                        ? SearchScoringProfile.TitleOrHeadingPhraseBonusFactor
                        : SearchScoringProfile.BodyPhraseBonusFactor;
                    score += factor * matchedIdfSum;
                }
                else if (isPrimary && concepts.Length >= 2 &&
                         CompactMatchesTightProximity(ordinal, plan.OrderedQuerySequence, Lookup, 2 * concepts.Length + 4))
                {
                    score += SearchScoringProfile.TightProximityBonusFactor * matchedIdfSum;
                }
            }

            if (isPrimary) primaryHits.Add(new ArticleSearchHit(doc.Article, SearchMatchTier.Primary, score));
            else relaxedHits.Add(new ArticleSearchHit(doc.Article, SearchMatchTier.Relaxed, score));
        }

        return FinalizeDetailedPage(primaryHits, relaxedHits, allowsRelaxation, sort, start, window);
    }

    private List<int> CollectCompactCandidates(
        SearchQueryPlan plan,
        SearchConcept[] concepts,
        int[][] shortPrefixWeights,
        Func<SearchTermKey, Term> lookup,
        bool allowsRelaxation,
        CancellationToken ct)
    {
        // Fast selective intersection driver when a non-relaxable constraint exists:
        // either quoted phrase step, strict identifier, or full-coverage non-relaxable query (|C| <= 2)
        Term? smallestDriver = null;
        void ConsiderDriver(Term t)
        {
            if (smallestDriver is null || t.Count < smallestDriver.Value.Count)
                smallestDriver = t;
        }

        foreach (var phrase in plan.QuotedPhrases)
            foreach (var st in phrase.Steps)
                ConsiderDriver(lookup(st.CanonicalKey));

        foreach (var c in concepts)
        {
            if (c.IsStrictIdentifier)
            {
                ConsiderDriver(lookup(c.Steps[0].CanonicalKey));
            }
            else if (!allowsRelaxation)
            {
                if (c.Kind == SearchConceptKind.Term && c.ShortAsciiPrefix is null)
                    ConsiderDriver(lookup(c.Steps[0].CanonicalKey));
                else if (c.Kind == SearchConceptKind.CjkSequence)
                    foreach (var st in c.Steps) ConsiderDriver(lookup(st.CanonicalKey));
            }
        }

        if (smallestDriver is { } driver)
        {
            var list = new List<int>(driver.Count);
            for (var i = 0; i < driver.Count; i++)
            {
                if ((i & 1023) == 0) ct.ThrowIfCancellationRequested();
                list.Add(_postings[driver.Start + i].Ordinal);
            }
            return list;
        }

        // Broad / relaxable or short-prefix/hyphen-only query: union of candidate doc ordinals via pooled bitset/seen array
        var seen = ArrayPool<byte>.Shared.Rent(_documents.Length);
        try
        {
            seen.AsSpan(0, _documents.Length).Clear();
            var list = new List<int>();
            void AddTerm(Term t)
            {
                for (var i = 0; i < t.Count; i++)
                {
                    if ((i & 1023) == 0) ct.ThrowIfCancellationRequested();
                    var ord = _postings[t.Start + i].Ordinal;
                    if (seen[ord] == 0) { seen[ord] = 1; list.Add(ord); }
                }
            }

            for (var c = 0; c < concepts.Length; c++)
            {
                var concept = concepts[c];
                if (concept.Kind == SearchConceptKind.CjkSequence)
                {
                    // Pick the rarest bigram of the CJK sequence as its candidate generator (all bigrams are required)
                    var rarest = lookup(concept.Steps[0].CanonicalKey);
                    for (var s = 1; s < concept.Steps.Length; s++)
                    {
                        var t = lookup(concept.Steps[s].CanonicalKey);
                        if (t.Count < rarest.Count) rarest = t;
                    }
                    if (rarest.Count > 0) AddTerm(rarest);
                }
                else if (concept.Kind == SearchConceptKind.CompoundHyphen)
                {
                    AddTerm(lookup(concept.Steps[0].CanonicalKey));
                    if (concept.Steps.Length > 1)
                    {
                        var rarest = lookup(concept.Steps[1].CanonicalKey);
                        for (var s = 2; s < concept.Steps.Length; s++)
                        {
                            var t = lookup(concept.Steps[s].CanonicalKey);
                            if (t.Count < rarest.Count) rarest = t;
                        }
                        if (rarest.Count > 0) AddTerm(rarest);
                    }
                }
                else
                {
                    AddTerm(lookup(concept.Steps[0].CanonicalKey));
                    if (shortPrefixWeights[c] is { } spw)
                    {
                        for (var ord = 0; ord < spw.Length; ord++)
                            if (spw[ord] != 0 && seen[ord] == 0) { seen[ord] = 1; list.Add(ord); }
                    }
                }
            }
            return list;
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(seen);
        }
    }

    private bool EvaluateCompactConcept(int ordinal, SearchConcept concept, int[]? shortPrefixPacked,
        Func<SearchTermKey, Term> lookup, Span<double> tfs, out bool exactFormHit, out bool usedShortPrefixOnly)
    {
        exactFormHit = false;
        usedShortPrefixOnly = false;

        switch (concept.Kind)
        {
            case SearchConceptKind.CjkSequence:
            {
                if (!CompactMatchesExactSequence(ordinal, concept.Steps, lookup, out _)) return false;
                for (var f = 0; f < SearchScoringProfile.FieldCount; f++)
                {
                    var minTf = double.MaxValue;
                    foreach (var st in concept.Steps)
                    {
                        if (!TryFindPosting(lookup(st.CanonicalKey), ordinal, out var p)) { minTf = 0; break; }
                        var tf = p.FieldTf(f);
                        if (tf < minTf) minTf = tf;
                    }
                    tfs[f] = minTf == double.MaxValue ? 0 : minTf;
                }
                exactFormHit = true;
                foreach (var st in concept.Steps)
                {
                    if (!TryFindPosting(lookup(st.ExactFormKey), ordinal, out var ex) || (ex.ExactFlags & ExactFlagBit) == 0)
                    {
                        exactFormHit = false;
                        break;
                    }
                }
                return true;
            }
            case SearchConceptKind.CompoundHyphen:
            {
                var hasExact = TryFindPosting(lookup(concept.Steps[0].CanonicalKey), ordinal, out var exactPosting);
                var hasAllSub = concept.Steps.Length > 1;
                Span<Posting> subPostings = concept.Steps.Length <= 8
                    ? stackalloc Posting[concept.Steps.Length]
                    : new Posting[concept.Steps.Length];
                for (var i = 1; i < concept.Steps.Length; i++)
                {
                    if (!TryFindPosting(lookup(concept.Steps[i].CanonicalKey), ordinal, out subPostings[i]))
                    {
                        hasAllSub = false;
                        break;
                    }
                }
                if (!hasExact && !hasAllSub) return false;

                for (var f = 0; f < SearchScoringProfile.FieldCount; f++)
                {
                    var tf = hasExact ? exactPosting.FieldTf(f) : 0.0;
                    if (hasAllSub)
                    {
                        var minSub = double.MaxValue;
                        for (var i = 1; i < concept.Steps.Length; i++)
                        {
                            var stf = subPostings[i].FieldTf(f);
                            if (stf < minSub) minSub = stf;
                        }
                        if (minSub != double.MaxValue && minSub > tf) tf = minSub;
                    }
                    tfs[f] = tf;
                }
                exactFormHit = hasExact && (exactPosting.ExactFlags & ExactFlagBit) != 0;
                return true;
            }
            default:
            {
                var step = concept.Steps[0];
                if (TryFindPosting(lookup(step.CanonicalKey), ordinal, out var posting))
                {
                    for (var f = 0; f < SearchScoringProfile.FieldCount; f++)
                        tfs[f] = posting.FieldTf(f);
                    exactFormHit = step.DiffersFromExactForm
                        ? (TryFindPosting(lookup(step.ExactFormKey), ordinal, out var ex) && (ex.ExactFlags & ExactFlagBit) != 0)
                        : (posting.ExactFlags & ExactFlagBit) != 0;
                    return true;
                }
                if (shortPrefixPacked is not null && shortPrefixPacked[ordinal] != 0)
                {
                    UnpackShortPrefixTfs(shortPrefixPacked[ordinal], tfs);
                    usedShortPrefixOnly = true;
                    return true;
                }
                return false;
            }
        }
    }

    private bool CompactMatchesExactSequence(int ordinal, SearchConceptStep[] steps, Func<SearchTermKey, Term> lookup,
        out SearchScoreField bestField)
    {
        bestField = SearchScoreField.Body;
        if (steps.Length == 0) return false;
        Span<Posting> postings = steps.Length <= 16 ? stackalloc Posting[steps.Length] : new Posting[steps.Length];
        for (var i = 0; i < steps.Length; i++)
        {
            if (!TryFindPosting(lookup(steps[i].CanonicalKey), ordinal, out postings[i]) || postings[i].PosCount == 0)
                return false;
        }
        var baseSpan = _positions.AsSpan(postings[0].PosStart, postings[0].PosCount);
        var baseOffset = steps[0].RelativeOffset;
        var found = false;
        for (var i = 0; i < baseSpan.Length; i++)
        {
            var packed0 = baseSpan[i];
            var field = SearchScoringProfile.UnpackField(packed0);
            var pos0 = SearchScoringProfile.UnpackPosition(packed0);
            var allOk = true;
            for (var s = 1; s < steps.Length; s++)
            {
                var targetPos = pos0 + (steps[s].RelativeOffset - baseOffset);
                var spanS = _positions.AsSpan(postings[s].PosStart, postings[s].PosCount);
                if (!ExhaustiveSearchOracle.ContainsFieldAndPos(spanS, field, targetPos))
                {
                    allOk = false;
                    break;
                }
            }
            if (allOk)
            {
                if (!found || (int)field < (int)bestField) bestField = field;
                found = true;
                if (bestField == SearchScoreField.Title) return true;
            }
        }
        return found;
    }

    private bool CompactMatchesTightProximity(int ordinal, SearchConceptStep[] steps, Func<SearchTermKey, Term> lookup, int maxSpan)
    {
        if (steps.Length < 2) return false;
        Span<Posting> postings = steps.Length <= 16 ? stackalloc Posting[steps.Length] : new Posting[steps.Length];
        for (var i = 0; i < steps.Length; i++)
        {
            if (!TryFindPosting(lookup(steps[i].CanonicalKey), ordinal, out postings[i]) || postings[i].PosCount == 0)
                return false;
        }
        var baseSpan = _positions.AsSpan(postings[0].PosStart, postings[0].PosCount);
        for (var f = 0; f < SearchScoringProfile.FieldCount; f++)
        {
            var field = (SearchScoreField)f;
            for (var i = 0; i < baseSpan.Length; i++)
            {
                if (SearchScoringProfile.UnpackField(baseSpan[i]) != field) continue;
                var anchor = SearchScoringProfile.UnpackPosition(baseSpan[i]);
                var minP = anchor;
                var maxP = anchor;
                var allNear = true;
                for (var s = 1; s < steps.Length; s++)
                {
                    var spanS = _positions.AsSpan(postings[s].PosStart, postings[s].PosCount);
                    if (!ExhaustiveSearchOracle.TryFindClosestInField(spanS, field, anchor, out var closest))
                    {
                        allNear = false;
                        break;
                    }
                    if (closest < minP) minP = closest;
                    if (closest > maxP) maxP = closest;
                    if (maxP - minP > maxSpan) { allNear = false; break; }
                }
                if (allNear) return true;
            }
        }
        return false;
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

    private static ArticleSearchDetailedPage FinalizeDetailedPage(
        List<ArticleSearchHit> primaryHits,
        List<ArticleSearchHit> relaxedHits,
        bool allowsRelaxation,
        ArticleSearchSort sort,
        int start,
        int window)
    {
        primaryHits.Sort((a, b) => SearchScoringProfile.CompareHits(a, b, sort));
        var includeRelaxed = allowsRelaxation &&
                             primaryHits.Count < SearchScoringProfile.RelaxationTriggerPrimaryCount &&
                             relaxedHits.Count > 0;
        if (includeRelaxed)
        {
            relaxedHits.Sort((a, b) => SearchScoringProfile.CompareHits(a, b, sort));
            if (relaxedHits.Count > SearchScoringProfile.MaxRelaxedResults)
                relaxedHits.RemoveRange(SearchScoringProfile.MaxRelaxedResults, relaxedHits.Count - SearchScoringProfile.MaxRelaxedResults);
        }
        else
        {
            relaxedHits.Clear();
        }

        var total = primaryHits.Count + relaxedHits.Count;
        if (window == 0 || start >= total || start >= window)
            return new([], total, primaryHits.Count, relaxedHits.Count);

        var end = Math.Min(total, window);
        var count = end - start;
        var slice = new ArticleSearchHit[count];
        for (var i = 0; i < count; i++)
        {
            var idx = start + i;
            slice[i] = idx < primaryHits.Count ? primaryHits[idx] : relaxedHits[idx - primaryHits.Count];
        }
        return new(slice, total, primaryHits.Count, relaxedHits.Count);
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
        var position = Array.BinarySearch(terms, new Term(key, 0, 0), Term.ByKey);
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
        private readonly List<PendingPos> _docPositions = [];
        private readonly List<uint> _posScratch = [];
        internal readonly Dictionary<SearchTermKey, Bucket> Heads = [];
        internal readonly List<PendingPosting> Pending = [];
        internal readonly List<uint> Positions = [];

        internal bool Collect(IReadOnlyList<Article> articles, Document[] documents, long[] totalFieldLengths,
            int termLimit, int postingLimit, CancellationToken ct)
        {
            Heads.Clear();
            Pending.Clear();
            Positions.Clear();

            for (var ordinal = 0; ordinal < articles.Count; ordinal++)
            {
                ct.ThrowIfCancellationRequested();
                var article = articles[ordinal];
                _docTerms.Clear();
                _docPositions.Clear();

                if (!ChargeChars(article.Title.Length)) return false;
                var titleRes = SearchTextAnalyzer.AnalyzePlainField(article.Title, SearchFieldKind.Title, SearchAnalysisMode.Index, 0, ct);
                if (!Accumulate(titleRes.Tokens, SearchScoreField.Title, 0, termLimit)) return false;
                var titleLen = Math.Max(1, titleRes.SourceLength);

                var summaryText = article.Summary ?? "";
                if (!ChargeChars(summaryText.Length)) return false;
                var sumRes = SearchTextAnalyzer.AnalyzePlainField(summaryText, SearchFieldKind.Summary, SearchAnalysisMode.Index, 0, ct);
                if (!Accumulate(sumRes.Tokens, SearchScoreField.Summary, 0, termLimit)) return false;
                var sumLen = Math.Max(1, sumRes.SourceLength);

                var taxPos = 0;
                var taxLen = 0;
                if (article.Category is { Name.Length: > 0 } cat)
                {
                    if (!ChargeChars(cat.Name.Length)) return false;
                    var catRes = SearchTextAnalyzer.AnalyzePlainField(cat.Name, SearchFieldKind.Taxonomy, SearchAnalysisMode.Index, taxPos, ct);
                    if (!Accumulate(catRes.Tokens, SearchScoreField.Taxonomy, 0, termLimit)) return false;
                    taxLen += catRes.SourceLength;
                    taxPos = catRes.EndPosition + SearchTextAnalyzer.BlockPositionGap;
                }
                foreach (var tag in article.Tags ?? [])
                {
                    if (string.IsNullOrEmpty(tag.Name)) continue;
                    if (!ChargeChars(tag.Name.Length)) return false;
                    var tagRes = SearchTextAnalyzer.AnalyzePlainField(tag.Name, SearchFieldKind.Taxonomy, SearchAnalysisMode.Index, taxPos, ct);
                    if (!Accumulate(tagRes.Tokens, SearchScoreField.Taxonomy, 0, termLimit)) return false;
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

    private readonly record struct Term(SearchTermKey Key, int Start, int Count)
    {
        internal static readonly IComparer<Term> ByKey =
            Comparer<Term>.Create(static (left, right) => left.Key.CompareTo(right.Key));
    }
}
