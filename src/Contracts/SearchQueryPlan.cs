namespace FsusBlog.V2.Contracts;

public enum SearchConceptKind : byte
{
    Term = 0,
    CjkSequence = 1,
    CompoundHyphen = 2
}

/// <summary>
/// One canonical lookup step within a concept or phrase constraint.
/// <see cref="CanonicalKey"/> is the Simplified-folded (or lowercased ASCII) key that spans all script variants
/// in one index lookup without double counting; <see cref="ExactFormKey"/> tracks the exact user-typed form.
/// </summary>
public sealed record SearchConceptStep(
    string CanonicalTerm,
    SearchTermKey CanonicalKey,
    string ExactFormTerm,
    SearchTermKey ExactFormKey,
    bool DiffersFromExactForm,
    int RelativeOffset,
    int Width,
    uint CanonicalHash32,
    uint ExactFormHash32,
    bool IsStopword);

/// <summary>
/// One logical query concept grouping exact terms and approved alternatives so they are evaluated
/// and scored as a single semantic requirement rather than independent terms.
/// </summary>
public sealed record SearchConcept(
    int Index,
    SearchConceptKind Kind,
    SearchConceptStep[] Steps,
    string? ShortAsciiPrefix,
    bool IsStrictIdentifier,
    bool IsStopword,
    int QueryPosition,
    int QueryWidth,
    string IdentityKey);

/// <summary>Explicit quoted phrase constraint that must match contiguously in a single field and is never relaxed.</summary>
public sealed record SearchPhraseConstraint(SearchConceptStep[] Steps, string RawText);

/// <summary>Versioned query plan produced deterministically from raw query input via <see cref="SearchTextAnalyzer"/>.</summary>
public sealed record SearchQueryPlan(
    int ProfileVersion,
    int AnalyzerVersion,
    string NormalizedText,
    SearchConcept[] Concepts,
    SearchConcept[] ContentConcepts,
    SearchPhraseConstraint[] QuotedPhrases,
    SearchConceptStep[] OrderedQuerySequence,
    bool HasStrictIdentifier,
    bool IsOverlongExactIdentifier,
    bool IsEmpty)
{
    public static SearchQueryPlan Build(string? rawQuery, CancellationToken ct = default)
    {
        ct.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(rawQuery))
            return Empty("");

        var (nfkc, _, _) = SearchTextAnalyzer.NormalizeWithOffsets(rawQuery, 0, ct);
        var trimmedRaw = nfkc.Trim();
        if (trimmedRaw.Length == 0)
            return Empty("");

        var unquotedWhole = StripSurroundingQuotes(trimmedRaw);
        if (SearchTextAnalyzer.IsStrictExactIdentifier(unquotedWhole.AsSpan()) &&
            unquotedWhole.Length > WireLimits.SearchQueryChars)
        {
            return new SearchQueryPlan(
                SearchScoringProfile.ProfileVersion,
                SearchTextAnalyzer.Version,
                "",
                [],
                [],
                [],
                [],
                HasStrictIdentifier: true,
                IsOverlongExactIdentifier: true,
                IsEmpty: true);
        }

        // Collapse whitespace and lowercase ASCII within the 128-unit query limit without splitting surrogate pairs.
        Span<char> buf = stackalloc char[WireLimits.SearchQueryChars + 1];
        var len = 0;
        for (var i = 0; i < trimmedRaw.Length; i++)
        {
            var c = trimmedRaw[i];
            if (char.IsWhiteSpace(c))
            {
                if (len > 0 && buf[len - 1] != ' ') buf[len++] = ' ';
                continue;
            }
            if (len == WireLimits.SearchQueryChars - 1 && char.IsHighSurrogate(c)) break;
            buf[len++] = c is >= 'A' and <= 'Z' ? (char)(c + 32) : c;
            if (len >= WireLimits.SearchQueryChars) break;
        }
        var normalized = new string(buf[..len].TrimEnd());
        if (normalized.Length == 0)
            return Empty("");

        var segments = SplitQuotedSegments(normalized);
        var allConcepts = new List<SearchConcept>();
        var quotedPhrases = new List<SearchPhraseConstraint>();
        var orderedSequence = new List<SearchConceptStep>();
        var hasStrictId = false;
        var globalPos = 0;

        foreach (var (text, isQuoted) in segments)
        {
            ct.ThrowIfCancellationRequested();
            if (string.IsNullOrWhiteSpace(text)) continue;

            var tokens = new List<SearchToken>();
            var shortPrefixes = new List<string>();
            var segStartPos = globalPos;
            SearchTextAnalyzer.AnalyzeSpanInto(text, 0, SearchAnalysisMode.Query, tokens, ref globalPos, shortPrefixes, ct);
            if (tokens.Count == 0) continue;

            var shortPrefixSet = shortPrefixes.Count > 0 ? new HashSet<string>(shortPrefixes, StringComparer.Ordinal) : null;
            var phraseSteps = isQuoted ? new List<SearchConceptStep>() : null;

            var i = 0;
            while (i < tokens.Count)
            {
                ct.ThrowIfCancellationRequested();
                var tok = tokens[i];
                if (tok.Kind == SearchTokenKind.ScriptAlias)
                {
                    i++;
                    continue;
                }

                // Pair token with its immediate ScriptAlias (if Traditional != Simplified)
                var (canonicalTerm, exactTerm, differs, canonHash32, exactHash32) = ReadPairedForm(tokens, ref i);

                // 1. Pure-letter hyphenated compound (e.g. "batch-item" followed by Subword "batch", "item")
                if (tok.Kind == SearchTokenKind.Exact && !SearchTextAnalyzer.IsStrictExactIdentifier(tok.Term.AsSpan()) &&
                    tok.Term.Contains('-') && i < tokens.Count && tokens[i].Kind == SearchTokenKind.Subword &&
                    tokens[i].Position == tok.Position)
                {
                    var steps = new List<SearchConceptStep>
                    {
                        MakeStep(canonicalTerm, exactTerm, differs, 0, tok.Width, canonHash32, exactHash32, tok.IsStopword)
                    };
                    while (i < tokens.Count && tokens[i].Kind == SearchTokenKind.Subword && tokens[i].Position == tok.Position)
                    {
                        var sub = tokens[i];
                        var (sCanon, sExact, sDiff, sCH32, sEH32) = ReadPairedForm(tokens, ref i);
                        steps.Add(MakeStep(sCanon, sExact, sDiff, 0, sub.Width, sCH32, sEH32, sub.IsStopword));
                    }
                    var idKey = "hyphen:" + canonicalTerm;
                    allConcepts.Add(new SearchConcept(
                        allConcepts.Count, SearchConceptKind.CompoundHyphen, [.. steps],
                        ShortAsciiPrefix: null, IsStrictIdentifier: false, IsStopword: tok.IsStopword,
                        tok.Position, tok.Width, idKey));
                    if (phraseSteps is not null)
                        phraseSteps.Add(steps[0] with { RelativeOffset = tok.Position - segStartPos });
                    if (!tok.IsStopword)
                        orderedSequence.Add(steps[0] with { RelativeOffset = tok.Position });
                    continue;
                }

                // 2. Contiguous CJK bigram sequence (unknown compound/name like "量子纠缠" or "林徽因")
                if (tok.Kind == SearchTokenKind.CjkBigram)
                {
                    var seqStartPos = tok.Position;
                    var steps = new List<SearchConceptStep>
                    {
                        MakeStep(canonicalTerm, exactTerm, differs, 0, tok.Width, canonHash32, exactHash32, tok.IsStopword)
                    };
                    var lastPos = tok.Position;
                    while (i < tokens.Count && tokens[i].Kind == SearchTokenKind.CjkBigram && tokens[i].Position == lastPos + 1)
                    {
                        var next = tokens[i];
                        var (nCanon, nExact, nDiff, nCH32, nEH32) = ReadPairedForm(tokens, ref i);
                        steps.Add(MakeStep(nCanon, nExact, nDiff, next.Position - seqStartPos, next.Width, nCH32, nEH32, next.IsStopword));
                        lastPos = next.Position;
                    }

                    if (steps.Count >= 2)
                    {
                        var totalWidth = (lastPos - seqStartPos) + 2;
                        var idKey = "cjkseq:" + string.Join('|', steps.Select(static s => s.CanonicalTerm));
                        allConcepts.Add(new SearchConcept(
                            allConcepts.Count, SearchConceptKind.CjkSequence, [.. steps],
                            ShortAsciiPrefix: null, IsStrictIdentifier: false, IsStopword: false,
                            seqStartPos, totalWidth, idKey));
                        if (phraseSteps is not null)
                        {
                            foreach (var st in steps)
                                phraseSteps.Add(st with { RelativeOffset = (seqStartPos + st.RelativeOffset) - segStartPos });
                        }
                        foreach (var st in steps)
                            orderedSequence.Add(st with { RelativeOffset = seqStartPos + st.RelativeOffset });
                    }
                    else
                    {
                        var st = steps[0];
                        var idKey = "term:" + st.CanonicalTerm;
                        allConcepts.Add(new SearchConcept(
                            allConcepts.Count, SearchConceptKind.Term, [st],
                            ShortAsciiPrefix: null, IsStrictIdentifier: false, IsStopword: st.IsStopword,
                            seqStartPos, tok.Width, idKey));
                        if (phraseSteps is not null)
                            phraseSteps.Add(st with { RelativeOffset = seqStartPos - segStartPos });
                        if (!st.IsStopword)
                            orderedSequence.Add(st with { RelativeOffset = seqStartPos });
                    }
                    continue;
                }

                // 3. Regular term (plain word, dictionary CJK word, explicit 1-char CJK, strict exact identifier)
                var isStrict = SearchTextAnalyzer.IsStrictExactIdentifier(tok.Term.AsSpan());
                if (isStrict) hasStrictId = true;
                var shortPrefix = !isStrict && shortPrefixSet is not null && shortPrefixSet.Contains(tok.Term)
                    ? tok.Term
                    : null;
                var step = MakeStep(canonicalTerm, exactTerm, differs, 0, tok.Width, canonHash32, exactHash32, tok.IsStopword);
                var conceptKey = (isStrict ? "strict:" : "term:") + canonicalTerm + (shortPrefix is not null ? ":p" : "");
                allConcepts.Add(new SearchConcept(
                    allConcepts.Count, SearchConceptKind.Term, [step],
                    ShortAsciiPrefix: shortPrefix, IsStrictIdentifier: isStrict, IsStopword: tok.IsStopword,
                    tok.Position, tok.Width, conceptKey));
                if (phraseSteps is not null)
                    phraseSteps.Add(step with { RelativeOffset = tok.Position - segStartPos });
                if (!tok.IsStopword)
                    orderedSequence.Add(step with { RelativeOffset = tok.Position });
            }

            if (phraseSteps is { Count: >= 2 })
            {
                var baseOffset = phraseSteps[0].RelativeOffset;
                var normalizedSteps = phraseSteps
                    .Select(s => s with { RelativeOffset = s.RelativeOffset - baseOffset })
                    .ToArray();
                quotedPhrases.Add(new SearchPhraseConstraint(normalizedSteps, text));
            }
        }

        if (allConcepts.Count == 0)
            return Empty(normalized);

        // Deduplicate concepts by IdentityKey while preserving first-seen order and strictness.
        var deduped = new List<SearchConcept>(allConcepts.Count);
        var seenIds = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var concept in allConcepts)
        {
            if (seenIds.TryGetValue(concept.IdentityKey, out var existingIdx))
            {
                // Preserve strictness if repeated
                if (concept.IsStrictIdentifier && !deduped[existingIdx].IsStrictIdentifier)
                    deduped[existingIdx] = deduped[existingIdx] with { IsStrictIdentifier = true };
                continue;
            }
            seenIds[concept.IdentityKey] = deduped.Count;
            deduped.Add(concept with { Index = deduped.Count });
        }

        // ContentConcepts exclude stopwords unless every concept in the query is a stopword (e.g. query "的").
        var nonStop = deduped.Where(static c => !c.IsStopword).ToArray();
        var content = nonStop.Length > 0 ? nonStop : [.. deduped];
        for (var idx = 0; idx < content.Length; idx++)
            content[idx] = content[idx] with { Index = idx };

        // Normalize OrderedQuerySequence relative offsets from the first ordered step
        SearchConceptStep[] seqArray = [];
        if (orderedSequence.Count >= 2)
        {
            var basePos = orderedSequence[0].RelativeOffset;
            seqArray = orderedSequence.Select(s => s with { RelativeOffset = s.RelativeOffset - basePos }).ToArray();
        }

        return new SearchQueryPlan(
            SearchScoringProfile.ProfileVersion,
            SearchTextAnalyzer.Version,
            normalized,
            [.. deduped],
            content,
            [.. quotedPhrases],
            seqArray,
            hasStrictId,
            IsOverlongExactIdentifier: false,
            IsEmpty: content.Length == 0);
    }

    private static SearchQueryPlan Empty(string normalized) =>
        new(SearchScoringProfile.ProfileVersion, SearchTextAnalyzer.Version, normalized, [], [], [], [], false, false, true);

    private static string StripSurroundingQuotes(string s)
    {
        if (s.Length >= 2 && ((s[0] == '"' && s[^1] == '"') || (s[0] == '“' && s[^1] == '”')))
            return s[1..^1].Trim();
        return s;
    }

    private static List<(string Text, bool IsQuoted)> SplitQuotedSegments(string text)
    {
        var result = new List<(string, bool)>();
        var i = 0;
        var plainStart = 0;
        while (i < text.Length)
        {
            var c = text[i];
            if (c is '"' or '“')
            {
                var closeChar = c == '"' ? '"' : '”';
                var closeIdx = text.IndexOf(closeChar, i + 1);
                if (closeIdx > i)
                {
                    if (i > plainStart)
                        result.Add((text[plainStart..i], false));
                    var inner = text[(i + 1)..closeIdx].Trim();
                    if (inner.Length > 0)
                        result.Add((inner, true));
                    i = closeIdx + 1;
                    plainStart = i;
                    continue;
                }
            }
            i++;
        }
        if (plainStart < text.Length)
            result.Add((text[plainStart..], false));
        return result;
    }

    private static (string CanonicalTerm, string ExactFormTerm, bool Differs, uint CanonHash32, uint ExactHash32)
        ReadPairedForm(List<SearchToken> tokens, ref int index)
    {
        var primary = tokens[index++];
        var exactTerm = primary.Term;
        var exactHash32 = primary.Hash32;
        if (index < tokens.Count &&
            tokens[index].Kind == SearchTokenKind.ScriptAlias &&
            tokens[index].Position == primary.Position &&
            tokens[index].Width == primary.Width)
        {
            var alias = tokens[index++];
            return (alias.Term, exactTerm, !string.Equals(alias.Term, exactTerm, StringComparison.Ordinal),
                alias.Hash32, exactHash32);
        }
        return (exactTerm, exactTerm, false, exactHash32, exactHash32);
    }

    private static SearchConceptStep MakeStep(string canonicalTerm, string exactFormTerm, bool differs,
        int relOffset, int width, uint canonHash32, uint exactHash32, bool isStopword) =>
        new(
            canonicalTerm,
            SearchTermKey.From(canonicalTerm),
            exactFormTerm,
            SearchTermKey.From(exactFormTerm),
            differs,
            relOffset,
            width,
            canonHash32,
            exactHash32,
            isStopword);
}
