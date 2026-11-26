using System.Runtime.InteropServices;

namespace FsusBlog.V2.Contracts;

/// <summary>
/// Independent, unpruned exhaustive reference evaluator implementing the canonical #46 concept-aware matching
/// and BM25F scoring specification directly over analyzed article text.
/// Used for differential verification of <see cref="ArticleSearchIndex"/> (compact, wide, and #48 pruning).
/// </summary>
public sealed class ExhaustiveSearchOracle
{
    private sealed class OracleDoc
    {
        internal required Article Article;
        internal required int[] FieldLengths; // 5 fields: Title, Heading, Summary, Taxonomy, Body
        internal required Dictionary<SearchTermKey, TermDocData> Terms;
    }

    private struct TermDocData
    {
        internal int HalfTf0, HalfTf1, HalfTf2, HalfTf3, HalfTf4;
        internal bool HasExact;
        internal List<uint>? Positions;

        internal readonly double FieldTf(int field) => (field switch
        {
            0 => HalfTf0,
            1 => HalfTf1,
            2 => HalfTf2,
            3 => HalfTf3,
            _ => HalfTf4
        }) * 0.5;

        internal void AddHalfTf(int field, int delta)
        {
            switch (field)
            {
                case 0: HalfTf0 = Math.Min(254, HalfTf0 + delta); break;
                case 1: HalfTf1 = Math.Min(254, HalfTf1 + delta); break;
                case 2: HalfTf2 = Math.Min(254, HalfTf2 + delta); break;
                case 3: HalfTf3 = Math.Min(254, HalfTf3 + delta); break;
                default: HalfTf4 = Math.Min(254, HalfTf4 + delta); break;
            }
        }
    }

    private readonly OracleDoc[] _docs;
    private readonly double[] _avgFieldLengths = new double[SearchScoringProfile.FieldCount];
    private readonly Dictionary<SearchTermKey, int> _docFreqs = [];

    private ExhaustiveSearchOracle(OracleDoc[] docs)
    {
        _docs = docs;
        var totals = new long[SearchScoringProfile.FieldCount];
        foreach (var doc in docs)
        {
            for (var f = 0; f < SearchScoringProfile.FieldCount; f++)
                totals[f] += Math.Max(1, doc.FieldLengths[f]);
            foreach (var key in doc.Terms.Keys)
                _docFreqs[key] = _docFreqs.GetValueOrDefault(key) + 1;
        }
        var n = Math.Max(1, docs.Length);
        for (var f = 0; f < SearchScoringProfile.FieldCount; f++)
            _avgFieldLengths[f] = Math.Max(1.0, (double)totals[f] / n);
    }

    public static ExhaustiveSearchOracle Build(IReadOnlyList<Article> articles, CancellationToken ct = default)
    {
        var docs = new OracleDoc[articles.Count];
        for (var i = 0; i < articles.Count; i++)
        {
            ct.ThrowIfCancellationRequested();
            var article = articles[i];
            var fieldLengths = new int[SearchScoringProfile.FieldCount];
            var terms = new Dictionary<SearchTermKey, TermDocData>();

            void Collect(IReadOnlyList<SearchToken> tokens, SearchScoreField field, int posShift)
            {
                var fIdx = (int)field;
                foreach (var tok in tokens)
                {
                    var key = SearchTermKey.From(tok);
                    terms.TryGetValue(key, out var entry);
                    var role = ArticleSearchTokens.TokenRole(tok);
                    entry.AddHalfTf(fIdx, role <= 1 ? 2 : 1);
                    if (role == 0) entry.HasExact = true;
                    if (tok.Kind is SearchTokenKind.Exact or SearchTokenKind.CjkBigram or SearchTokenKind.Subword or SearchTokenKind.ScriptAlias)
                    {
                        (entry.Positions ??= []).Add(SearchScoringProfile.PackPosition(field, tok.Position + posShift, tok.Width));
                    }
                    terms[key] = entry;
                }
            }

            var title = SearchTextAnalyzer.AnalyzePlainField(article.Title, SearchFieldKind.Title, SearchAnalysisMode.Index, 0, ct);
            fieldLengths[(int)SearchScoreField.Title] = Math.Max(1, title.SourceLength);
            Collect(title.Tokens, SearchScoreField.Title, 0);

            var summary = SearchTextAnalyzer.AnalyzePlainField(article.Summary ?? "", SearchFieldKind.Summary, SearchAnalysisMode.Index, 0, ct);
            fieldLengths[(int)SearchScoreField.Summary] = Math.Max(1, summary.SourceLength);
            Collect(summary.Tokens, SearchScoreField.Summary, 0);

            var taxPos = 0;
            var taxLen = 0;
            if (article.Category is { Name.Length: > 0 } cat)
            {
                var catRes = SearchTextAnalyzer.AnalyzePlainField(cat.Name, SearchFieldKind.Taxonomy, SearchAnalysisMode.Index, taxPos, ct);
                Collect(catRes.Tokens, SearchScoreField.Taxonomy, 0);
                taxLen += catRes.SourceLength;
                taxPos = catRes.EndPosition + SearchTextAnalyzer.BlockPositionGap;
            }
            foreach (var tag in article.Tags ?? [])
            {
                if (string.IsNullOrEmpty(tag.Name)) continue;
                var tagRes = SearchTextAnalyzer.AnalyzePlainField(tag.Name, SearchFieldKind.Taxonomy, SearchAnalysisMode.Index, taxPos, ct);
                Collect(tagRes.Tokens, SearchScoreField.Taxonomy, 0);
                taxLen += tagRes.SourceLength;
                taxPos = tagRes.EndPosition + SearchTextAnalyzer.BlockPositionGap;
            }
            fieldLengths[(int)SearchScoreField.Taxonomy] = Math.Max(1, taxLen);

            SearchTextAnalyzer.VisitMarkdownIndexTokens(article.Body ?? "", (tokens, field, shift) =>
            {
                Collect(tokens, SearchScoringProfile.ToScoreField(field), shift);
                return true;
            }, ct, out var headingLength, out var bodyLength);
            fieldLengths[(int)SearchScoreField.Heading] = Math.Max(1, headingLength);
            fieldLengths[(int)SearchScoreField.Body] = Math.Max(1, bodyLength);

            // Deduplicate and sort positions per term so positional checks match index order
            foreach (var key in terms.Keys.ToArray())
            {
                var entry = terms[key];
                if (entry.Positions is { Count: > 1 } list)
                {
                    list.Sort();
                    var write = 1;
                    for (var r = 1; r < list.Count; r++)
                        if (list[r] != list[r - 1]) list[write++] = list[r];
                    if (write < list.Count) list.RemoveRange(write, list.Count - write);
                    terms[key] = entry;
                }
            }

            docs[i] = new OracleDoc { Article = article, FieldLengths = fieldLengths, Terms = terms };
        }
        return new ExhaustiveSearchOracle(docs);
    }

    public ArticleSearchDetailedPage SearchDetailed(string query, ArticleSearchSort sort, int page, int size, CancellationToken ct = default)
    {
        ct.ThrowIfCancellationRequested();
        ArgumentOutOfRangeException.ThrowIfLessThan(page, 1);
        ArgumentOutOfRangeException.ThrowIfLessThan(size, 1);
        var plan = SearchQueryPlan.Build(query, ct);
        if (_docs.Length == 0 || plan.IsEmpty || plan.IsOverlongExactIdentifier)
            return new([], 0, 0, 0);

        var n = _docs.Length;
        var concepts = plan.ContentConcepts;
        var conceptIdfs = new double[concepts.Length];
        var shortPrefixIdfs = new double[concepts.Length];
        var totalQueryIdf = 0.0;

        for (var c = 0; c < concepts.Length; c++)
        {
            var concept = concepts[c];
            var idf = ComputeConceptIdf(concept, n);
            conceptIdfs[c] = idf;
            totalQueryIdf += idf;

            if (concept.ShortAsciiPrefix is { } prefix)
            {
                var prefixDf = 0;
                foreach (var doc in _docs)
                    if (HasShortPrefix(doc.Article, prefix)) prefixDf++;
                if (prefixDf > 0)
                {
                    var exactDf = _docFreqs.GetValueOrDefault(concept.Steps[0].CanonicalKey);
                    shortPrefixIdfs[c] = SearchScoringProfile.InverseDocumentFrequency(n, Math.Min(n, exactDf + prefixDf));
                }
            }
        }

        var allowsRelaxation = SearchScoringProfile.AllowsRelaxation(plan);
        var minRelaxed = SearchScoringProfile.MinRelaxedConcepts(concepts.Length);
        var minRelaxedRatio = SearchScoringProfile.MinRelaxedIdfRatio(concepts.Length);

        var primaryHits = new List<ArticleSearchHit>();
        var relaxedHits = new List<ArticleSearchHit>();
        Span<double> tfs = stackalloc double[SearchScoringProfile.FieldCount];

        foreach (var doc in _docs)
        {
            ct.ThrowIfCancellationRequested();

            // 1. Strict quoted phrases MUST match (never relaxed)
            var phraseOk = true;
            foreach (var phrase in plan.QuotedPhrases)
            {
                if (!MatchesExactSequence(doc, phrase.Steps, out _))
                {
                    phraseOk = false;
                    break;
                }
            }
            if (!phraseOk) continue;

            // 2. Evaluate every content concept once (deduplicated)
            var matchedCount = 0;
            var matchedIdfSum = 0.0;
            var strictOk = true;
            var score = 0.0;

            for (var c = 0; c < concepts.Length; c++)
            {
                var concept = concepts[c];
                tfs.Clear();
                var matched = EvaluateConcept(doc, concept, tfs, out var exactFormHit, out var usedShortPrefixOnly);
                if (!matched)
                {
                    if (concept.IsStrictIdentifier) { strictOk = false; break; }
                    continue;
                }
                matchedCount++;
                matchedIdfSum += conceptIdfs[c];
                var activeIdf = usedShortPrefixOnly ? shortPrefixIdfs[c] : conceptIdfs[c];
                score += SearchScoringProfile.ScoreConceptBm25F(activeIdf, tfs, doc.FieldLengths, _avgFieldLengths);
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

            // 3. Phrase / proximity bonus for multi-concept queries or explicit quoted phrases
            if (plan.QuotedPhrases.Length > 0 || (isPrimary && plan.OrderedQuerySequence.Length >= 2))
            {
                var seq = plan.QuotedPhrases.Length > 0 ? plan.QuotedPhrases[0].Steps : plan.OrderedQuerySequence;
                if (MatchesExactSequence(doc, seq, out var matchField))
                {
                    var factor = matchField is SearchScoreField.Title or SearchScoreField.Heading
                        ? SearchScoringProfile.TitleOrHeadingPhraseBonusFactor
                        : SearchScoringProfile.BodyPhraseBonusFactor;
                    score += factor * matchedIdfSum;
                }
                else if (isPrimary && concepts.Length >= 2 && MatchesTightProximity(doc, plan.OrderedQuerySequence, 2 * concepts.Length + 4))
                {
                    score += SearchScoringProfile.TightProximityBonusFactor * matchedIdfSum;
                }
            }

            if (isPrimary) primaryHits.Add(new ArticleSearchHit(doc.Article, SearchMatchTier.Primary, score));
            else relaxedHits.Add(new ArticleSearchHit(doc.Article, SearchMatchTier.Relaxed, score));
        }

        primaryHits.Sort((a, b) => SearchScoringProfile.CompareHits(a, b, sort));
        var includeRelaxed = allowsRelaxation && primaryHits.Count < SearchScoringProfile.RelaxationTriggerPrimaryCount && relaxedHits.Count > 0;
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

        var combined = new List<ArticleSearchHit>(primaryHits.Count + relaxedHits.Count);
        combined.AddRange(primaryHits);
        combined.AddRange(relaxedHits);

        var start = (long)(page - 1) * size;
        var window = Math.Min(combined.Count, ArticleSearchIndex.MaxPaginatedResults);
        if (start >= window)
            return new([], combined.Count, primaryHits.Count, relaxedHits.Count);
        var take = (int)Math.Min(size, window - start);
        var slice = new ArticleSearchHit[take];
        combined.CopyTo((int)start, slice, 0, take);
        return new(slice, combined.Count, primaryHits.Count, relaxedHits.Count);
    }

    private double ComputeConceptIdf(SearchConcept concept, int totalDocs)
    {
        switch (concept.Kind)
        {
            case SearchConceptKind.CjkSequence:
            {
                // O(1) deterministic upper-bound concept IDF = max_j idf(bigram_j)
                var maxIdf = 0.0;
                foreach (var st in concept.Steps)
                {
                    var df = _docFreqs.GetValueOrDefault(st.CanonicalKey);
                    var idf = SearchScoringProfile.InverseDocumentFrequency(totalDocs, df);
                    if (idf > maxIdf) maxIdf = idf;
                }
                return maxIdf;
            }
            case SearchConceptKind.CompoundHyphen:
            {
                var exactDf = _docFreqs.GetValueOrDefault(concept.Steps[0].CanonicalKey);
                var minSubDf = totalDocs;
                for (var i = 1; i < concept.Steps.Length; i++)
                {
                    var d = _docFreqs.GetValueOrDefault(concept.Steps[i].CanonicalKey);
                    if (d < minSubDf) minSubDf = d;
                }
                var combinedDf = Math.Min(totalDocs, Math.Max(exactDf, minSubDf));
                return SearchScoringProfile.InverseDocumentFrequency(totalDocs, combinedDf);
            }
            default:
            {
                var df = _docFreqs.GetValueOrDefault(concept.Steps[0].CanonicalKey);
                return SearchScoringProfile.InverseDocumentFrequency(totalDocs, df);
            }
        }
    }

    private static bool EvaluateConcept(OracleDoc doc, SearchConcept concept, Span<double> tfs,
        out bool exactFormHit, out bool usedShortPrefixOnly)
    {
        exactFormHit = false;
        usedShortPrefixOnly = false;

        switch (concept.Kind)
        {
            case SearchConceptKind.CjkSequence:
            {
                // Verify all bigrams exist AND occur at consecutive positions in the same field
                if (!MatchesExactSequence(doc, concept.Steps, out _)) return false;
                for (var f = 0; f < SearchScoringProfile.FieldCount; f++)
                {
                    var minTf = double.MaxValue;
                    foreach (var st in concept.Steps)
                    {
                        if (!doc.Terms.TryGetValue(st.CanonicalKey, out var d)) { minTf = 0; break; }
                        var tf = d.FieldTf(f);
                        if (tf < minTf) minTf = tf;
                    }
                    tfs[f] = minTf == double.MaxValue ? 0 : minTf;
                }
                // Check exact script form across all steps
                exactFormHit = true;
                foreach (var st in concept.Steps)
                {
                    if (!doc.Terms.TryGetValue(st.ExactFormKey, out var ex) || !ex.HasExact)
                    {
                        exactFormHit = false;
                        break;
                    }
                }
                return true;
            }
            case SearchConceptKind.CompoundHyphen:
            {
                // Matches EITHER exact "batch-item" OR all component subwords ("batch" AND "item"), counted once
                var hasExact = doc.Terms.TryGetValue(concept.Steps[0].CanonicalKey, out var exactData);
                var hasAllSub = concept.Steps.Length > 1;
                for (var i = 1; i < concept.Steps.Length; i++)
                {
                    if (!doc.Terms.ContainsKey(concept.Steps[i].CanonicalKey)) { hasAllSub = false; break; }
                }
                if (!hasExact && !hasAllSub) return false;

                for (var f = 0; f < SearchScoringProfile.FieldCount; f++)
                {
                    var tf = hasExact ? exactData.FieldTf(f) : 0.0;
                    if (hasAllSub)
                    {
                        var minSub = double.MaxValue;
                        for (var i = 1; i < concept.Steps.Length; i++)
                        {
                            var subTf = doc.Terms[concept.Steps[i].CanonicalKey].FieldTf(f);
                            if (subTf < minSub) minSub = subTf;
                        }
                        if (minSub != double.MaxValue && minSub > tf) tf = minSub;
                    }
                    tfs[f] = tf;
                }
                exactFormHit = hasExact && exactData.HasExact;
                return true;
            }
            default:
            {
                var step = concept.Steps[0];
                var matchedTerm = doc.Terms.TryGetValue(step.CanonicalKey, out var termData);
                if (matchedTerm)
                {
                    for (var f = 0; f < SearchScoringProfile.FieldCount; f++)
                        tfs[f] = termData.FieldTf(f);
                    exactFormHit = step.DiffersFromExactForm
                        ? (doc.Terms.TryGetValue(step.ExactFormKey, out var ex) && ex.HasExact)
                        : termData.HasExact;
                    return true;
                }

                if (concept.ShortAsciiPrefix is { } prefix)
                {
                    var titleHits = ArticleSearchTokens.CountAsciiPrefixMatches(doc.Article.Title, prefix.AsSpan());
                    var sumHits = ArticleSearchTokens.CountAsciiPrefixMatches(doc.Article.Summary ?? "", prefix.AsSpan());
                    var taxHits = ArticleSearchTokens.CountAsciiPrefixMatches(doc.Article.Category?.Name ?? "", prefix.AsSpan());
                    foreach (var tag in doc.Article.Tags ?? [])
                        taxHits += ArticleSearchTokens.CountAsciiPrefixMatches(tag.Name, prefix.AsSpan());
                    if (titleHits + sumHits + taxHits > 0)
                    {
                        // Match the scoring precision of the index's three 10-bit hit counts.
                        const int maxPrefixHits = (1 << 10) - 1;
                        tfs[(int)SearchScoreField.Title] = Math.Min(titleHits, maxPrefixHits) * SearchScoringProfile.ShortPrefixTitleTf;
                        tfs[(int)SearchScoreField.Summary] = Math.Min(sumHits, maxPrefixHits) * SearchScoringProfile.ShortPrefixSummaryTf;
                        tfs[(int)SearchScoreField.Taxonomy] = Math.Min(taxHits, maxPrefixHits) * SearchScoringProfile.ShortPrefixTaxonomyTf;
                        usedShortPrefixOnly = true;
                        return true;
                    }
                }
                return false;
            }
        }
    }

    private static bool HasShortPrefix(Article article, string prefix)
    {
        var span = prefix.AsSpan();
        if (ArticleSearchTokens.CountAsciiPrefixMatches(article.Title, span) > 0) return true;
        if (ArticleSearchTokens.CountAsciiPrefixMatches(article.Summary ?? "", span) > 0) return true;
        if (ArticleSearchTokens.CountAsciiPrefixMatches(article.Category?.Name ?? "", span) > 0) return true;
        foreach (var tag in article.Tags ?? [])
            if (ArticleSearchTokens.CountAsciiPrefixMatches(tag.Name, span) > 0) return true;
        return false;
    }

    private static bool MatchesExactSequence(OracleDoc doc, SearchConceptStep[] steps, out SearchScoreField matchedField)
    {
        matchedField = SearchScoreField.Body;
        if (steps.Length == 0) return false;
        var lists = new List<uint>[steps.Length];
        for (var i = 0; i < steps.Length; i++)
        {
            if (!doc.Terms.TryGetValue(steps[i].CanonicalKey, out var d) || d.Positions is not { Count: > 0 } p)
                return false;
            lists[i] = p;
        }
        return MatchPositionsExactSequence(lists, steps, out matchedField);
    }

    internal static bool MatchPositionsExactSequence(List<uint>[] posLists, SearchConceptStep[] steps, out SearchScoreField bestField)
    {
        bestField = SearchScoreField.Body;
        if (steps.Length == 0 || posLists[0].Count == 0) return false;
        var found = false;
        var baseList = posLists[0];
        var baseOffset = steps[0].RelativeOffset;
        for (var i = 0; i < baseList.Count; i++)
        {
            var packed0 = baseList[i];
            var field = SearchScoringProfile.UnpackField(packed0);
            var pos0 = SearchScoringProfile.UnpackPosition(packed0);
            var allOk = true;
            for (var s = 1; s < steps.Length; s++)
            {
                var targetPos = pos0 + (steps[s].RelativeOffset - baseOffset);
                if (!ContainsFieldAndPos(CollectionsMarshal.AsSpan(posLists[s]), field, targetPos))
                {
                    allOk = false;
                    break;
                }
            }
            if (allOk)
            {
                if (!found || (int)field < (int)bestField)
                    bestField = field;
                found = true;
                if (bestField == SearchScoreField.Title) return true;
            }
        }
        return found;
    }

    private static bool MatchesTightProximity(OracleDoc doc, SearchConceptStep[] steps, int maxSpan)
    {
        if (steps.Length < 2) return false;
        var lists = new List<uint>[steps.Length];
        for (var i = 0; i < steps.Length; i++)
        {
            if (!doc.Terms.TryGetValue(steps[i].CanonicalKey, out var d) || d.Positions is not { Count: > 0 } p)
                return false;
            lists[i] = p;
        }
        return MatchPositionsTightProximity(lists, maxSpan);
    }

    internal static bool MatchPositionsTightProximity(List<uint>[] posLists, int maxSpan)
    {
        if (posLists.Length < 2) return false;
        for (var f = 0; f < SearchScoringProfile.FieldCount; f++)
        {
            var field = (SearchScoreField)f;
            var baseList = posLists[0];
            for (var i = 0; i < baseList.Count; i++)
            {
                if (SearchScoringProfile.UnpackField(baseList[i]) != field) continue;
                var anchor = SearchScoringProfile.UnpackPosition(baseList[i]);
                var minP = anchor;
                var maxP = anchor;
                var allNear = true;
                for (var s = 1; s < posLists.Length; s++)
                {
                    if (!TryFindClosestInField(CollectionsMarshal.AsSpan(posLists[s]), field, anchor, out var closest))
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

    internal static bool ContainsFieldAndPos(ReadOnlySpan<uint> sortedPacked, SearchScoreField field, int targetPos)
    {
        if (targetPos < 0 || sortedPacked.Length == 0) return false;
        var targetFp = (((uint)field & 7U) << 25) | (uint)Math.Clamp(targetPos, 0, 0x01FF_FFFF);
        var lo = 0;
        var hi = sortedPacked.Length - 1;
        while (lo <= hi)
        {
            var mid = lo + ((hi - lo) >> 1);
            var midFp = sortedPacked[mid] >> 4;
            if (midFp == targetFp) return true;
            if (midFp < targetFp) lo = mid + 1;
            else hi = mid - 1;
        }
        return false;
    }

    internal static bool TryFindClosestInField(ReadOnlySpan<uint> sortedPacked, SearchScoreField field, int anchor, out int closest)
    {
        closest = 0;
        if (sortedPacked.Length == 0) return false;
        var fieldPrefix = ((uint)field & 7U) << 25;
        var targetFp = fieldPrefix | (uint)Math.Clamp(anchor, 0, 0x01FF_FFFF);
        // Binary search for lower bound of (field, anchor)
        var lo = 0;
        var hi = sortedPacked.Length;
        while (lo < hi)
        {
            var mid = lo + ((hi - lo) >> 1);
            if ((sortedPacked[mid] >> 4) < targetFp) lo = mid + 1;
            else hi = mid;
        }
        var bestDist = int.MaxValue;
        if (lo < sortedPacked.Length && SearchScoringProfile.UnpackField(sortedPacked[lo]) == field)
        {
            var p = SearchScoringProfile.UnpackPosition(sortedPacked[lo]);
            var d = Math.Abs(p - anchor);
            if (d < bestDist) { bestDist = d; closest = p; }
        }
        if (lo > 0 && SearchScoringProfile.UnpackField(sortedPacked[lo - 1]) == field)
        {
            var p = SearchScoringProfile.UnpackPosition(sortedPacked[lo - 1]);
            var d = Math.Abs(p - anchor);
            if (d < bestDist) { bestDist = d; closest = p; }
        }
        return bestDist != int.MaxValue;
    }
}
