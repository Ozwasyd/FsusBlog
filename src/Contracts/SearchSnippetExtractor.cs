namespace FsusBlog.V2.Contracts;

/// <summary>Bounded plain-text snippet and validated UTF-16 highlight ranges for one returned search hit (#47).</summary>
public readonly record struct SearchSnippet(
    PublicSearchSnippetField Field,
    string Text,
    IReadOnlyList<PublicSearchHighlight> Highlights);

/// <summary>
/// Extracts bounded, plain-text, query-specific snippets and surrogate-pair-safe UTF-16 highlight ranges
/// strictly for returned search results using #45's Markdown extractor and source-offset analyzer.
/// Never outputs raw HTML markup or scans non-returned documents.
/// </summary>
public static class SearchSnippetExtractor
{
    private const int TargetWindowChars = 180;
    private const int BoundarySnapChars = 18;
    private static readonly UTF8Encoding Utf8 = new(false, true);

    private readonly record struct MatchedSpan(int Start, int End, int ConceptIndex, bool ExactForm, bool IsCode);

    private readonly record struct Candidate(
        PublicSearchSnippetField Field,
        string Text,
        IReadOnlyList<PublicSearchHighlight> Highlights,
        int DistinctConcepts,
        bool HasPhrase,
        int ExactHits,
        int FieldPriority);

    public static SearchSnippet Extract(Article article, SearchQueryPlan plan, CancellationToken ct = default)
    {
        ct.ThrowIfCancellationRequested();
        if (plan.IsEmpty || plan.IsOverlongExactIdentifier)
            return new(PublicSearchSnippetField.None, "", []);

        Candidate? bestNonTitle = null;
        void Consider(Candidate? candidate)
        {
            if (candidate is not { } c) return;
            if (bestNonTitle is null || CompareCandidates(c, bestNonTitle.Value) > 0)
                bestNonTitle = c;
        }

        // 1. Markdown body: extract visible headings, prose (with inline code in reading order), and fenced code blocks.
        if (!string.IsNullOrEmpty(article.Body))
        {
            var visible = SearchMarkdownExtractor.Extract(article.Body, ct);
            if (visible.Count > 0)
            {
                // Headings: evaluate each heading block independently so unrelated headings never concatenate.
                var headingBuf = new StringBuilder();
                var headingSpace = false;
                var proseBuf = new StringBuilder();
                var proseSpace = false;
                var proseCodeMask = new List<(int Start, int End)>();
                var fenceBuf = new StringBuilder();
                var fenceSpace = false;

                void FlushHeading()
                {
                    if (headingBuf.Length == 0) return;
                    Consider(EvaluatePlainText(headingBuf.ToString(), PublicSearchSnippetField.Heading,
                        SearchFieldKind.Heading, fieldPriority: 4, plan, codeRanges: null, ct));
                    headingBuf.Clear();
                    headingSpace = false;
                }

                void FlushFence()
                {
                    if (fenceBuf.Length == 0) return;
                    Consider(EvaluatePlainText(fenceBuf.ToString(), PublicSearchSnippetField.Code,
                        SearchFieldKind.Code, fieldPriority: 5, plan, codeRanges: null, ct));
                    fenceBuf.Clear();
                    fenceSpace = false;
                }

                foreach (var span in visible)
                {
                    ct.ThrowIfCancellationRequested();
                    var rawSlice = article.Body.AsSpan(span.SourceStart, span.SourceEnd - span.SourceStart);
                    switch (span.Field)
                    {
                        case SearchFieldKind.Heading:
                            FlushFence();
                            if (span.StartsNewBlock) FlushHeading();
                            AppendNormalizedText(headingBuf, rawSlice, ref headingSpace);
                            break;

                        case SearchFieldKind.Code:
                            FlushHeading();
                            if (span.StartsNewBlock)
                            {
                                // Fenced code block start (or standalone code line after break)
                                FlushFence();
                                AppendNormalizedText(fenceBuf, rawSlice, ref fenceSpace);
                            }
                            else if (fenceBuf.Length > 0)
                            {
                                // Subsequent line inside the same fenced code block
                                fenceSpace = true;
                                AppendNormalizedText(fenceBuf, rawSlice, ref fenceSpace);
                            }
                            else
                            {
                                // Inline code inside a prose paragraph: keep reading flow intact while tracking code bounds
                                if (proseBuf.Length > 0 && proseSpace)
                                {
                                    proseBuf.Append(' ');
                                    proseSpace = false;
                                }
                                var cStart = proseBuf.Length;
                                AppendNormalizedText(proseBuf, rawSlice, ref proseSpace);
                                var cEnd = proseBuf.Length;
                                if (cEnd > cStart) proseCodeMask.Add((cStart, cEnd));
                            }
                            break;

                        default:
                            FlushHeading();
                            FlushFence();
                            if (span.StartsNewBlock && proseBuf.Length > 0) proseSpace = true;
                            AppendNormalizedText(proseBuf, rawSlice, ref proseSpace);
                            break;
                    }
                }

                FlushHeading();
                FlushFence();
                if (proseBuf.Length > 0)
                {
                    Consider(EvaluatePlainText(proseBuf.ToString(), PublicSearchSnippetField.Body,
                        SearchFieldKind.Body, fieldPriority: 5, plan, proseCodeMask, ct));
                }
            }
        }

        // 2. Summary field
        if (!string.IsNullOrEmpty(article.Summary))
        {
            var summaryClean = NormalizeSnippetWhitespace(article.Summary);
            if (summaryClean.Length > 0)
            {
                Consider(EvaluatePlainText(summaryClean, PublicSearchSnippetField.Summary,
                    SearchFieldKind.Summary, fieldPriority: 3, plan, codeRanges: null, ct));
            }
        }

        // 3. Taxonomy field (Category + Tags)
        var taxonomyText = BuildTaxonomyPlainText(article);
        if (taxonomyText.Length > 0)
        {
            Consider(EvaluatePlainText(taxonomyText, PublicSearchSnippetField.Taxonomy,
                SearchFieldKind.Taxonomy, fieldPriority: 2, plan, codeRanges: null, ct));
        }

        if (bestNonTitle is { } chosen)
            return new(chosen.Field, chosen.Text, chosen.Highlights);

        // 4. Title-only fallback when no non-title field matched
        if (!string.IsNullOrEmpty(article.Title))
        {
            var titleClean = NormalizeSnippetWhitespace(article.Title);
            if (titleClean.Length > 0 &&
                EvaluatePlainText(titleClean, PublicSearchSnippetField.Title, SearchFieldKind.Title,
                    fieldPriority: 1, plan, codeRanges: null, ct) is { } titleCandidate)
            {
                return new(titleCandidate.Field, titleCandidate.Text, titleCandidate.Highlights);
            }
        }

        return new(PublicSearchSnippetField.None, "", []);
    }

    private static int CompareCandidates(Candidate a, Candidate b)
    {
        if (a.HasPhrase != b.HasPhrase) return a.HasPhrase ? 1 : -1;
        var cmp = a.DistinctConcepts.CompareTo(b.DistinctConcepts);
        if (cmp != 0) return cmp;
        cmp = a.FieldPriority.CompareTo(b.FieldPriority);
        if (cmp != 0) return cmp;
        return a.ExactHits.CompareTo(b.ExactHits);
    }

    private static Candidate? EvaluatePlainText(
        string text,
        PublicSearchSnippetField snippetField,
        SearchFieldKind analyzerField,
        int fieldPriority,
        SearchQueryPlan plan,
        List<(int Start, int End)>? codeRanges,
        CancellationToken ct)
    {
        var analysis = SearchTextAnalyzer.AnalyzePlainField(text, analyzerField, SearchAnalysisMode.Index, 0, ct);
        if (analysis.Tokens.Count == 0) return null;

        var matchedSpans = new List<MatchedSpan>();
        var tokens = analysis.Tokens;

        // Index tokens by canonical term key for fast concept & phrase matching on this single field
        var byKey = new Dictionary<SearchTermKey, List<SearchToken>>();
        for (var i = 0; i < tokens.Count; i++)
        {
            var tok = tokens[i];
            var key = new SearchTermKey(tok.Key, tok.Term);
            if (!byKey.TryGetValue(key, out var list))
            {
                list = [];
                byKey[key] = list;
            }
            list.Add(tok);
        }

        // Check quoted phrases first
        var hasPhrase = false;
        foreach (var phrase in plan.QuotedPhrases)
        {
            if (phrase.Steps.Length == 0) continue;
            if (!byKey.TryGetValue(phrase.Steps[0].CanonicalKey, out var anchors)) continue;
            foreach (var anchor in anchors)
            {
                var phraseStart = anchor.SourceStart;
                var phraseEnd = anchor.SourceEnd;
                var expectedPos = anchor.Position + anchor.Width;
                var ok = true;
                for (var s = 1; s < phrase.Steps.Length; s++)
                {
                    if (!byKey.TryGetValue(phrase.Steps[s].CanonicalKey, out var stepToks)) { ok = false; break; }
                    SearchToken? found = null;
                    foreach (var cand in stepToks)
                    {
                        if (cand.Position == expectedPos) { found = cand; break; }
                    }
                    if (found is null) { ok = false; break; }
                    if (found.Value.SourceStart < phraseStart) phraseStart = found.Value.SourceStart;
                    if (found.Value.SourceEnd > phraseEnd) phraseEnd = found.Value.SourceEnd;
                    expectedPos = found.Value.Position + found.Value.Width;
                }
                if (ok && phraseEnd > phraseStart)
                {
                    hasPhrase = true;
                    matchedSpans.Add(new(phraseStart, phraseEnd, ConceptIndex: -1, ExactForm: true,
                        IsCode: IsWithinCodeRanges(phraseStart, phraseEnd, codeRanges)));
                }
            }
        }

        // Match each concept in plan.ContentConcepts
        var conceptMatched = new HashSet<int>();
        foreach (var concept in plan.ContentConcepts)
        {
            if (concept.ShortAsciiPrefix is { Length: > 0 } prefix &&
                analyzerField is SearchFieldKind.Title or SearchFieldKind.Summary or SearchFieldKind.Taxonomy)
            {
                for (var i = 0; i < tokens.Count; i++)
                {
                    var tok = tokens[i];
                    if (tok.Kind != SearchTokenKind.Exact) continue;
                    if (tok.Term.StartsWith(prefix, StringComparison.Ordinal))
                    {
                        var start = tok.SourceStart;
                        var end = Math.Min(tok.SourceEnd, tok.SourceStart + prefix.Length);
                        end = AlignEndSurrogate(text, start, end);
                        if (end > start)
                        {
                            conceptMatched.Add(concept.Index);
                            matchedSpans.Add(new(start, end, concept.Index, ExactForm: tok.Term.Length == prefix.Length,
                                IsCode: IsWithinCodeRanges(start, end, codeRanges)));
                        }
                    }
                }
                continue;
            }

            if (concept.Kind == SearchConceptKind.CjkSequence && concept.Steps.Length > 1)
            {
                if (!byKey.TryGetValue(concept.Steps[0].CanonicalKey, out var anchors)) continue;
                foreach (var anchor in anchors)
                {
                    var spanStart = anchor.SourceStart;
                    var spanEnd = anchor.SourceEnd;
                    var ok = true;
                    for (var s = 1; s < concept.Steps.Length; s++)
                    {
                        var targetPos = anchor.Position + concept.Steps[s].RelativeOffset;
                        if (!byKey.TryGetValue(concept.Steps[s].CanonicalKey, out var stepToks)) { ok = false; break; }
                        SearchToken? found = null;
                        foreach (var cand in stepToks)
                        {
                            if (cand.Position == targetPos) { found = cand; break; }
                        }
                        if (found is null) { ok = false; break; }
                        if (found.Value.SourceStart < spanStart) spanStart = found.Value.SourceStart;
                        if (found.Value.SourceEnd > spanEnd) spanEnd = found.Value.SourceEnd;
                    }
                    if (ok && spanEnd > spanStart)
                    {
                        conceptMatched.Add(concept.Index);
                        var exactHit = concept.Steps[0].DiffersFromExactForm
                            ? byKey.TryGetValue(concept.Steps[0].ExactFormKey, out var ex) && ex.Exists(t => t.Position == anchor.Position)
                            : true;
                        matchedSpans.Add(new(spanStart, spanEnd, concept.Index, exactHit,
                            IsCode: IsWithinCodeRanges(spanStart, spanEnd, codeRanges)));
                    }
                }
            }
            else if (concept.Kind == SearchConceptKind.CompoundHyphen && concept.Steps.Length > 1)
            {
                var matchedFull = false;
                if (byKey.TryGetValue(concept.Steps[0].CanonicalKey, out var fullToks))
                {
                    foreach (var tok in fullToks)
                    {
                        if (tok.SourceEnd > tok.SourceStart)
                        {
                            matchedFull = true;
                            conceptMatched.Add(concept.Index);
                            matchedSpans.Add(new(tok.SourceStart, tok.SourceEnd, concept.Index, ExactForm: true,
                                IsCode: IsWithinCodeRanges(tok.SourceStart, tok.SourceEnd, codeRanges)));
                        }
                    }
                }
                if (!matchedFull)
                {
                    // All component subwords must appear in this field to highlight the split form
                    var allSubs = true;
                    for (var s = 1; s < concept.Steps.Length; s++)
                    {
                        if (!byKey.ContainsKey(concept.Steps[s].CanonicalKey)) { allSubs = false; break; }
                    }
                    if (allSubs)
                    {
                        for (var s = 1; s < concept.Steps.Length; s++)
                        {
                            foreach (var tok in byKey[concept.Steps[s].CanonicalKey])
                            {
                                if (tok.SourceEnd > tok.SourceStart)
                                {
                                    conceptMatched.Add(concept.Index);
                                    matchedSpans.Add(new(tok.SourceStart, tok.SourceEnd, concept.Index, ExactForm: false,
                                        IsCode: IsWithinCodeRanges(tok.SourceStart, tok.SourceEnd, codeRanges)));
                                }
                            }
                        }
                    }
                }
            }
            else if (concept.Steps.Length > 0)
            {
                var step = concept.Steps[0];
                if (byKey.TryGetValue(step.CanonicalKey, out var toks))
                {
                    HashSet<int>? exactPositions = null;
                    if (step.DiffersFromExactForm && byKey.TryGetValue(step.ExactFormKey, out var exList))
                    {
                        exactPositions = [];
                        foreach (var et in exList) exactPositions.Add(et.Position);
                    }
                    foreach (var tok in toks)
                    {
                        if (tok.SourceEnd <= tok.SourceStart) continue;
                        var isExact = !step.DiffersFromExactForm
                            ? tok.Kind is SearchTokenKind.Exact or SearchTokenKind.CjkBigram or SearchTokenKind.CjkChar
                            : exactPositions is not null && exactPositions.Contains(tok.Position);
                        conceptMatched.Add(concept.Index);
                        matchedSpans.Add(new(tok.SourceStart, tok.SourceEnd, concept.Index, isExact,
                            IsCode: IsWithinCodeRanges(tok.SourceStart, tok.SourceEnd, codeRanges)));
                    }
                }
            }
        }

        if (matchedSpans.Count == 0) return null;

        // If prose+inline-code field matched exclusively inside inline code ranges, label it as Code.
        var effectiveField = snippetField;
        if (snippetField == PublicSearchSnippetField.Body && codeRanges is { Count: > 0 } &&
            matchedSpans.TrueForAll(static s => s.IsCode))
        {
            effectiveField = PublicSearchSnippetField.Code;
        }

        var (windowText, highlights, windowConcepts, windowExactHits) = BuildBoundedWindow(text, matchedSpans);
        if (windowText.Length == 0) return null;

        return new Candidate(
            effectiveField,
            windowText,
            highlights,
            Math.Max(windowConcepts, conceptMatched.Count > 0 ? 1 : 0),
            hasPhrase,
            windowExactHits,
            fieldPriority);
    }

    private static (string Text, IReadOnlyList<PublicSearchHighlight> Highlights, int DistinctConcepts, int ExactHits) BuildBoundedWindow(
        string text, List<MatchedSpan> spans)
    {
        spans.Sort(static (a, b) =>
        {
            var cmp = a.Start.CompareTo(b.Start);
            return cmp != 0 ? cmp : b.End.CompareTo(a.End);
        });

        // Pick the best target window [winStart, winEnd) centered around the highest-value match cluster.
        int bestStart = 0, bestEnd = text.Length;
        int bestScore = -1, bestConcepts = 0, bestExact = 0;

        if (text.Length > TargetWindowChars || Utf8.GetByteCount(text) > WireLimits.PublicSearchSnippetMaxBytes)
        {
            var conceptBits = new HashSet<int>();
            var stepCount = Math.Min(spans.Count, 32);
            for (var i = 0; i < stepCount; i++)
            {
                var anchor = spans[i];
                var center = anchor.Start + (anchor.End - anchor.Start) / 2;
                var rawStart = Math.Max(0, center - TargetWindowChars / 3);
                var rawEnd = Math.Min(text.Length, rawStart + TargetWindowChars);
                if (rawEnd - rawStart < TargetWindowChars && rawStart > 0)
                    rawStart = Math.Max(0, rawEnd - TargetWindowChars);

                var s = SnapStart(text, rawStart, anchor.Start);
                var e = SnapEnd(text, rawEnd, anchor.End);
                if (e < anchor.End) e = AlignEndSurrogate(text, s, Math.Min(text.Length, anchor.End));

                conceptBits.Clear();
                var exact = 0;
                var hits = 0;
                var phraseBonus = 0;
                for (var j = 0; j < spans.Count; j++)
                {
                    var sp = spans[j];
                    if (sp.End <= s) continue;
                    if (sp.Start >= e) break;
                    if (sp.Start >= s && sp.End <= e)
                    {
                        hits++;
                        if (sp.ConceptIndex >= 0) conceptBits.Add(sp.ConceptIndex);
                        else phraseBonus = 1;
                        if (sp.ExactForm) exact++;
                    }
                }
                var score = phraseBonus * 400 + conceptBits.Count * 100 + exact * 10 + hits;
                if (score > bestScore)
                {
                    bestScore = score;
                    bestStart = s;
                    bestEnd = e;
                    bestConcepts = conceptBits.Count;
                    bestExact = exact;
                }
            }
        }
        else
        {
            var conceptBits = new HashSet<int>();
            foreach (var sp in spans)
            {
                if (sp.ConceptIndex >= 0) conceptBits.Add(sp.ConceptIndex);
                if (sp.ExactForm) bestExact++;
            }
            bestConcepts = conceptBits.Count;
        }

        // Trim whitespace around the selected window while keeping surrogate boundaries intact.
        while (bestStart < bestEnd && char.IsWhiteSpace(text[bestStart])) bestStart++;
        while (bestEnd > bestStart && char.IsWhiteSpace(text[bestEnd - 1])) bestEnd--;
        bestStart = AlignStartSurrogate(text, bestStart);
        bestEnd = AlignEndSurrogate(text, bestStart, bestEnd);

        var leadingEllipsis = bestStart > 0;
        var trailingEllipsis = bestEnd < text.Length;
        // Reserve 3 UTF-8 bytes per ellipsis character ("…" = U+2026 = 3 bytes).
        var maxCoreBytes = WireLimits.PublicSearchSnippetMaxBytes - (leadingEllipsis ? 3 : 0) - 3;
        var coreSpan = text.AsSpan(bestStart, bestEnd - bestStart);
        var coreLen = FitUtf8Bytes(coreSpan, maxCoreBytes);
        if (coreLen < coreSpan.Length)
        {
            trailingEllipsis = true;
            // Re-trim trailing whitespace cleanly if truncation stopped right after space
            while (coreLen > 0 && char.IsWhiteSpace(coreSpan[coreLen - 1])) coreLen--;
            coreLen = AlignSpanEndSurrogate(coreSpan, coreLen);
        }

        var finalEnd = bestStart + coreLen;
        if (coreLen == 0) return ("", [], 0, 0);

        var prefixLen = leadingEllipsis ? 1 : 0;
        var resultText = string.Concat(
            leadingEllipsis ? "…" : "",
            text.AsSpan(bestStart, coreLen),
            trailingEllipsis ? "…" : "");

        // Project matched spans into the final snippet string, clamp, validate surrogate boundaries, and merge overlaps.
        var rawHighlights = new List<(int Start, int End)>();
        foreach (var sp in spans)
        {
            if (sp.End <= bestStart || sp.Start >= finalEnd) continue;
            var hs = Math.Max(sp.Start, bestStart) - bestStart + prefixLen;
            var he = Math.Min(sp.End, finalEnd) - bestStart + prefixLen;
            hs = AlignStartSurrogate(resultText, hs);
            he = AlignEndSurrogate(resultText, hs, he);
            if (he > hs && hs >= 0 && he <= resultText.Length)
                rawHighlights.Add((hs, he));
        }

        var merged = MergeAndBoundHighlights(resultText, rawHighlights);
        return (resultText, merged, bestConcepts, bestExact);
    }

    private static List<PublicSearchHighlight> MergeAndBoundHighlights(string text, List<(int Start, int End)> ranges)
    {
        var result = new List<PublicSearchHighlight>();
        if (ranges.Count == 0) return result;
        ranges.Sort(static (a, b) =>
        {
            var cmp = a.Start.CompareTo(b.Start);
            return cmp != 0 ? cmp : a.End.CompareTo(b.End);
        });

        var curStart = ranges[0].Start;
        var curEnd = ranges[0].End;
        for (var i = 1; i < ranges.Count; i++)
        {
            var (s, e) = ranges[i];
            if (s <= curEnd)
            {
                if (e > curEnd) curEnd = e;
            }
            else
            {
                AddValidated(result, text, curStart, curEnd);
                if (result.Count >= WireLimits.PublicSearchMaxHighlights) return result;
                curStart = s;
                curEnd = e;
            }
        }
        if (result.Count < WireLimits.PublicSearchMaxHighlights)
            AddValidated(result, text, curStart, curEnd);
        return result;

        static void AddValidated(List<PublicSearchHighlight> list, string s, int start, int end)
        {
            if (start < 0 || end > s.Length || start >= end) return;
            if (char.IsLowSurrogate(s[start]) || char.IsHighSurrogate(s[end - 1])) return;
            list.Add(new(start, end));
        }
    }

    private static int SnapStart(string text, int rawStart, int mustNotExceed)
    {
        var s = AlignStartSurrogate(text, Math.Clamp(rawStart, 0, Math.Max(0, mustNotExceed)));
        if (s == 0) return 0;
        var limit = Math.Min(mustNotExceed, s + BoundarySnapChars);
        for (var i = s; i < limit; i++)
        {
            if (char.IsWhiteSpace(text[i]))
                return AlignStartSurrogate(text, i + 1);
        }
        return s;
    }

    private static int SnapEnd(string text, int rawEnd, int mustCover)
    {
        var e = AlignEndSurrogate(text, 0, Math.Clamp(rawEnd, mustCover, text.Length));
        if (e >= text.Length) return text.Length;
        var floor = Math.Max(mustCover, e - BoundarySnapChars);
        for (var i = e; i > floor; i--)
        {
            if (char.IsWhiteSpace(text[i - 1]))
                return AlignEndSurrogate(text, 0, i - 1);
        }
        return e;
    }

    private static int AlignStartSurrogate(string text, int index)
    {
        if (index <= 0) return 0;
        if (index >= text.Length) return text.Length;
        return char.IsLowSurrogate(text[index]) ? index + 1 : index;
    }

    private static int AlignEndSurrogate(string text, int start, int end)
    {
        if (end <= start) return start;
        if (end > text.Length) end = text.Length;
        return end > start && char.IsHighSurrogate(text[end - 1]) ? end - 1 : end;
    }

    private static int AlignSpanEndSurrogate(ReadOnlySpan<char> text, int len) =>
        len > 0 && char.IsHighSurrogate(text[len - 1]) ? len - 1 : len;

    private static int FitUtf8Bytes(ReadOnlySpan<char> text, int maxBytes)
    {
        if (maxBytes <= 0 || text.IsEmpty) return 0;
        if (Utf8.GetByteCount(text) <= maxBytes) return text.Length;

        var bytes = 0;
        var i = 0;
        while (i < text.Length)
        {
            var c = text[i];
            int charCount, utf8Len;
            if (char.IsHighSurrogate(c) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1]))
            {
                charCount = 2;
                utf8Len = 4;
            }
            else if (char.IsSurrogate(c))
            {
                charCount = 1;
                utf8Len = 3; // U+FFFD replacement if unpaired
            }
            else if (c < 0x80)
            {
                charCount = 1;
                utf8Len = 1;
            }
            else if (c < 0x800)
            {
                charCount = 1;
                utf8Len = 2;
            }
            else
            {
                charCount = 1;
                utf8Len = 3;
            }
            if (bytes + utf8Len > maxBytes) break;
            bytes += utf8Len;
            i += charCount;
        }
        return i;
    }

    private static bool IsWithinCodeRanges(int start, int end, List<(int Start, int End)>? codeRanges)
    {
        if (codeRanges is null || codeRanges.Count == 0) return false;
        for (var i = 0; i < codeRanges.Count; i++)
        {
            if (start >= codeRanges[i].Start && end <= codeRanges[i].End) return true;
        }
        return false;
    }

    private static void AppendNormalizedText(StringBuilder sb, ReadOnlySpan<char> slice, ref bool pendingSpace)
    {
        for (var i = 0; i < slice.Length; i++)
        {
            var c = slice[i];
            if (char.IsWhiteSpace(c) || (char.IsControl(c) && c != '\t'))
            {
                if (sb.Length > 0) pendingSpace = true;
                continue;
            }
            if (pendingSpace)
            {
                sb.Append(' ');
                pendingSpace = false;
            }
            sb.Append(c);
        }
    }

    private static string NormalizeSnippetWhitespace(string input)
    {
        var sb = new StringBuilder(Math.Min(input.Length, 512));
        var pendingSpace = false;
        AppendNormalizedText(sb, input.AsSpan(), ref pendingSpace);
        return sb.ToString();
    }

    private static string BuildTaxonomyPlainText(Article article)
    {
        var hasCategory = article.Category is { Name.Length: > 0 };
        var hasTags = article.Tags is { Count: > 0 };
        if (!hasCategory && !hasTags) return "";
        var sb = new StringBuilder();
        if (hasCategory)
        {
            var pending = false;
            AppendNormalizedText(sb, article.Category!.Name.AsSpan(), ref pending);
        }
        if (hasTags)
        {
            foreach (var tag in article.Tags!)
            {
                if (string.IsNullOrWhiteSpace(tag.Name)) continue;
                if (sb.Length > 0) sb.Append(" · ");
                sb.Append('#');
                var pending = false;
                AppendNormalizedText(sb, tag.Name.AsSpan(), ref pending);
            }
        }
        return sb.ToString();
    }
}
