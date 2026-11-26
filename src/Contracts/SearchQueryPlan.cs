using System.Runtime.InteropServices;

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
        var concepts = new List<SearchConcept>();
        HashSet<string>? seenIdentities = null;
        var quotedPhrases = new List<SearchPhraseConstraint>();
        var orderedSequence = new List<SearchConceptStep>();
        var hasStrictId = false;
        var globalPos = 0;

        // Keep the first occurrence even when later occurrences have different exact forms.
        void AddFirstConcept(string identity, SearchConceptKind kind, ReadOnlySpan<SearchConceptStep> steps,
            int position, int width, bool stopword = false, string? shortPrefix = null, bool strict = false)
        {
            seenIdentities ??= new HashSet<string>(StringComparer.Ordinal);
            if (seenIdentities.Add(identity))
                concepts.Add(new(concepts.Count, kind, steps.ToArray(), shortPrefix, strict, stopword, position, width, identity));
        }

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

                var step = ReadStep(tokens, ref i);

                // 1. Pure-letter hyphenated compound (e.g. "batch-item" followed by Subword "batch", "item")
                if (tok.Kind == SearchTokenKind.Exact && tok.Term.Contains('-') &&
                    i < tokens.Count && tokens[i].Kind == SearchTokenKind.Subword && tokens[i].Position == tok.Position &&
                    !SearchTextAnalyzer.IsStrictExactIdentifier(tok.Term.AsSpan()))
                {
                    var steps = new List<SearchConceptStep> { step };
                    while (i < tokens.Count && tokens[i].Kind == SearchTokenKind.Subword && tokens[i].Position == tok.Position)
                        steps.Add(ReadStep(tokens, ref i));
                    var idKey = "hyphen:" + step.CanonicalTerm;
                    AddFirstConcept(idKey, SearchConceptKind.CompoundHyphen, CollectionsMarshal.AsSpan(steps),
                        tok.Position, tok.Width, tok.IsStopword);
                    if (phraseSteps is not null)
                        phraseSteps.Add(step with { RelativeOffset = tok.Position - segStartPos });
                    if (!tok.IsStopword)
                        orderedSequence.Add(step with { RelativeOffset = tok.Position });
                    continue;
                }

                // 2. Contiguous CJK bigram sequence (unknown compound/name like "量子纠缠" or "林徽因")
                if (tok.Kind == SearchTokenKind.CjkBigram)
                {
                    var seqStartPos = tok.Position;
                    var steps = new List<SearchConceptStep> { step };
                    var lastPos = tok.Position;
                    while (i < tokens.Count && tokens[i].Kind == SearchTokenKind.CjkBigram && tokens[i].Position == lastPos + 1)
                    {
                        lastPos = tokens[i].Position;
                        steps.Add(ReadStep(tokens, ref i, lastPos - seqStartPos));
                    }

                    if (steps.Count >= 2)
                    {
                        var totalWidth = (lastPos - seqStartPos) + 2;
                        var idKey = "cjkseq:" + string.Join('|', steps.Select(static s => s.CanonicalTerm));
                        AddFirstConcept(idKey, SearchConceptKind.CjkSequence, CollectionsMarshal.AsSpan(steps),
                            seqStartPos, totalWidth);
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
                        var idKey = "term:" + step.CanonicalTerm;
                        AddFirstConcept(idKey, SearchConceptKind.Term, [step], seqStartPos, tok.Width, step.IsStopword);
                        if (phraseSteps is not null)
                            phraseSteps.Add(step with { RelativeOffset = seqStartPos - segStartPos });
                        if (!step.IsStopword)
                            orderedSequence.Add(step with { RelativeOffset = seqStartPos });
                    }
                    continue;
                }

                // 3. Regular term (plain word, dictionary CJK word, explicit 1-char CJK, strict exact identifier)
                var isStrict = SearchTextAnalyzer.IsStrictExactIdentifier(tok.Term.AsSpan());
                if (isStrict) hasStrictId = true;
                var shortPrefix = !isStrict && shortPrefixSet is not null && shortPrefixSet.Contains(tok.Term)
                    ? tok.Term
                    : null;
                var conceptKey = (isStrict ? "strict:" : "term:") + step.CanonicalTerm + (shortPrefix is not null ? ":p" : "");
                AddFirstConcept(conceptKey, SearchConceptKind.Term, [step], tok.Position, tok.Width, tok.IsStopword,
                    shortPrefix, isStrict);
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

        if (concepts.Count == 0)
            return Empty(normalized);

        // ContentConcepts exclude stopwords unless every concept in the query is a stopword (e.g. query "的").
        var nonStop = concepts.Where(static c => !c.IsStopword).ToArray();
        var content = nonStop.Length > 0 ? nonStop : [.. concepts];
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
            [.. concepts],
            content,
            [.. quotedPhrases],
            seqArray,
            hasStrictId,
            IsOverlongExactIdentifier: false,
            IsEmpty: content.Length == 0);
    }

    private static SearchQueryPlan Empty(string normalized) =>
        new(SearchScoringProfile.ProfileVersion, SearchTextAnalyzer.Version, normalized, [], [], [], [], false, false, true);

    /// <summary>
    /// Builds a deterministic canonical cache key for this analyzed query plan (#50).
    /// Binds versions, emptiness/overlong-identifier state, normalized text, concepts (including exact form), and quoted phrases.
    /// </summary>
    public string BuildCanonicalCacheKey()
    {
        var sb = new StringBuilder(NormalizedText.Length + 64);
        sb.Append(ProfileVersion).Append('\0')
            .Append(AnalyzerVersion).Append('\0')
            .Append(IsEmpty ? '1' : '0')
            .Append(IsOverlongExactIdentifier ? '1' : '0')
            .Append(HasStrictIdentifier ? '1' : '0')
            .Append('\0')
            .Append(NormalizedText);
        foreach (var concept in ContentConcepts)
        {
            sb.Append('\u001F').Append(concept.IdentityKey);
            foreach (var step in concept.Steps)
            {
                if (step.DiffersFromExactForm)
                    sb.Append('=').Append(step.ExactFormTerm);
            }
        }
        foreach (var phrase in QuotedPhrases)
            sb.Append('\u001E').Append(phrase.RawText);
        return sb.ToString();
    }

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

    private static SearchConceptStep ReadStep(List<SearchToken> tokens, ref int index, int relativeOffset = 0)
    {
        var exact = tokens[index++];
        var canonical = exact;
        if (index < tokens.Count &&
            tokens[index].Kind == SearchTokenKind.ScriptAlias &&
            tokens[index].Position == exact.Position &&
            tokens[index].Width == exact.Width)
            canonical = tokens[index++];

        return new SearchConceptStep(
            canonical.Term,
            SearchTermKey.From(canonical),
            exact.Term,
            SearchTermKey.From(exact),
            !string.Equals(canonical.Term, exact.Term, StringComparison.Ordinal),
            relativeOffset,
            exact.Width,
            canonical.Hash32,
            exact.Hash32,
            exact.IsStopword);
    }
}
