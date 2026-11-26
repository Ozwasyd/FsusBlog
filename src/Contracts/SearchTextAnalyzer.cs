using System.Text.Json;

namespace FsusBlog.V2.Contracts;

public enum SearchTokenKind : byte
{
    Exact = 0,
    CjkBigram = 1,
    CjkChar = 2,
    Prefix = 3,
    Subword = 4,
    ScriptAlias = 5
}

public enum SearchAnalysisMode : byte
{
    Index = 0,
    Query = 1
}

/// <summary>
/// Unified analyzed token carrying collision-safe canonical string identity, 64-bit hash key,
/// legacy 32-bit hash, token role, position, width, source-length advance, and exact original UTF-16 offsets.
/// </summary>
public readonly record struct SearchToken(
    string Term,
    ulong Key,
    uint Hash32,
    SearchTokenKind Kind,
    int Position,
    int Width,
    int Advance,
    int SourceStart,
    int SourceEnd,
    bool IsStopword);

public sealed record SearchFieldAnalysis(
    SearchFieldKind Field,
    IReadOnlyList<SearchToken> Tokens,
    int SourceLength,
    int EndPosition);

public sealed record AnalyzedQuery(
    string NormalizedText,
    IReadOnlyList<SearchToken> Tokens,
    IReadOnlyList<string> ShortAsciiPrefixes,
    bool IsExactIdentifier,
    bool IsOverlongExactIdentifier,
    bool IsOverlongQuery);

/// <summary>
/// Single versioned text analysis contract shared across public indexing and querying (#45).
/// </summary>
public static class SearchTextAnalyzer
{
    public const int Version = WireLimits.SearchAnalyzerVersion;
    public const int BlockPositionGap = 16;
    public const int MaxCjkSegment = 4096;
    public const int MaxIndexedTokenChars = WireLimits.SearchQueryChars;
    public const int AsciiMinPrefixLength = 3;
    public const int AsciiMaxPrefixLength = 12;
    public const int MaxAsciiSubtokens = 32;
    public const int MaxTokensPerField = 262_144;

    private static readonly UTF8Encoding Utf8 = new(false, true);
    private static readonly Dictionary<char, char> TraditionalToSimplified = LoadScTcMap();

    private static Dictionary<char, char> LoadScTcMap()
    {
        using var stream = typeof(SearchTextAnalyzer).Assembly.GetManifestResourceStream("SearchScTcMap")
            ?? throw new InvalidOperationException("Missing embedded SearchScTcMap resource.");
        using var doc = JsonDocument.Parse(stream);
        var map = new Dictionary<char, char>();
        foreach (var prop in doc.RootElement.GetProperty("traditionalToSimplified").EnumerateObject())
        {
            var key = prop.Name;
            var val = prop.Value.GetString()!;
            if (key.Length == 1 && val.Length == 1 && key[0] != val[0])
                map[key[0]] = val[0];
        }
        return map;
    }

    public static bool TryMapTraditionalChar(char c, out char simplified) =>
        TraditionalToSimplified.TryGetValue(c, out simplified);

    public static string ToSimplifiedCjk(ReadOnlySpan<char> text)
    {
        char[]? rented = null;
        for (var i = 0; i < text.Length; i++)
        {
            if (TraditionalToSimplified.TryGetValue(text[i], out var mapped))
            {
                if (rented is null)
                {
                    rented = new char[text.Length];
                    text[..i].CopyTo(rented);
                }
                rented[i] = mapped;
            }
            else if (rented is not null)
            {
                rented[i] = text[i];
            }
        }
        return rented is null ? new string(text) : new string(rented);
    }

    private static (string Source, int Offset) ToSimplifiedCjkSlice(string text, int start, int length)
    {
        char[]? rented = null;
        for (var i = 0; i < length; i++)
        {
            var ch = text[start + i];
            if (TraditionalToSimplified.TryGetValue(ch, out var mapped))
            {
                if (rented is null)
                {
                    rented = new char[length];
                    text.AsSpan(start, i).CopyTo(rented);
                }
                rented[i] = mapped;
            }
            else if (rented is not null)
            {
                rented[i] = ch;
            }
        }
        return rented is null ? (text, start) : (new string(rented), 0);
    }

    /// <summary>Collision-safe 64-bit FNV-1a key (paired with exact Term string verification in term dictionaries).</summary>
    public static ulong HashTerm64(ReadOnlySpan<char> term) => HashTermBoth(term).Hash64;

    /// <summary>Legacy 32-bit Murmur3 hash matching FSPK v4 term hashes.</summary>
    public static uint HashTerm32(ReadOnlySpan<char> term) => HashTermBoth(term).Hash32;

    private static (ulong Hash64, uint Hash32) HashTermBoth(ReadOnlySpan<char> term)
    {
        const ulong offsetBasis = 14695981039346656037UL;
        const ulong prime = 1099511628211UL;
        var byteLen = Utf8.GetByteCount(term);
        byte[]? pooled = null;
        Span<byte> buf = byteLen <= 256 ? stackalloc byte[byteLen] : (pooled = ArrayPool<byte>.Shared.Rent(byteLen)).AsSpan(0, byteLen);
        try
        {
            Utf8.GetBytes(term, buf);
            var h64 = offsetBasis;
            for (var i = 0; i < buf.Length; i++)
            {
                h64 ^= buf[i];
                h64 *= prime;
            }
            return (h64, LocalSearchCorpus.HashUtf8Bytes(buf));
        }
        finally
        {
            if (pooled is not null) ArrayPool<byte>.Shared.Return(pooled);
        }
    }

    /// <summary>
    /// Normalize <paramref name="source"/> with per-cluster NFKC while recording exact,
    /// surrogate-pair-safe UTF-16 source spans [OrigStart[i], OrigEnd[i]) for every normalized unit.
    /// Returns null offset arrays when the span is an identity mapping (OrigStart[i]=baseOffset+i, OrigEnd[i]=baseOffset+i+1).
    /// </summary>
    internal static (string Normalized, int[]? OrigStart, int[]? OrigEnd) NormalizeWithOffsets(string source,
        int baseOffset, CancellationToken ct)
    {
        if (source.Length == 0) return ("", null, null);

        // Zero-allocation identity fast path: no surrogates, no Hangul Jamo, no combining marks,
        // and the entire string is already in FormKC. Every BMP char maps 1:1 to [baseOffset+i, baseOffset+i+1).
        var canCheckIdentity = true;
        var allAscii = true;
        for (var i = 0; i < source.Length; i++)
        {
            var c = source[i];
            if (c < 0x80) continue;
            allAscii = false;
            if (c is >= '\u4E00' and <= '\u9FFF' or >= '\u3400' and <= '\u4DBF') continue;
            if (char.IsSurrogate(c) || c is >= '\u1100' and <= '\u11FF' || IsCombiningMark(source, i, 1))
            {
                canCheckIdentity = false;
                break;
            }
        }
        if (allAscii || (canCheckIdentity && source.IsNormalized(NormalizationForm.FormKC)))
            return (source, null, null);

        var sb = new StringBuilder(source.Length);
        var origStarts = new List<int>(source.Length);
        var origEnds = new List<int>(source.Length);

        var idx = 0;
        var step = 0;
        while (idx < source.Length)
        {
            if ((step++ & 511) == 0) ct.ThrowIfCancellationRequested();
            var clusterStart = idx;
            var first = DecodeCodePointLen(source, idx);
            idx += first;
            // Attach trailing combining marks to keep cluster NFKC composition (e.g. e + U+0301 -> é)
            while (idx < source.Length)
            {
                var nextLen = DecodeCodePointLen(source, idx);
                if (!IsCombiningMark(source, idx, nextLen)) break;
                idx += nextLen;
            }
            var clusterEnd = idx;
            var rawStart = baseOffset + clusterStart;
            var rawEnd = baseOffset + clusterEnd;
            var slice = source.AsSpan(clusterStart, clusterEnd - clusterStart);
            // Single ASCII, standard CJK, or CJK punctuation (U+3001..U+3035) with no combining marks: already NFKC
            if (slice.Length == 1)
            {
                var ch = slice[0];
                if (ch < 0x80 || ch is (>= '\u4E00' and <= '\u9FFF') or (>= '\u3400' and <= '\u4DBF') or (>= '\u3001' and <= '\u3035'))
                {
                    sb.Append(ch);
                    origStarts.Add(rawStart);
                    origEnds.Add(rawEnd);
                    continue;
                }
                if (ch is >= '\uFF01' and <= '\uFF5E')
                {
                    sb.Append((char)(ch - 0xFEE0));
                    origStarts.Add(rawStart);
                    origEnds.Add(rawEnd);
                    continue;
                }
                if (ch == '\u3000')
                {
                    sb.Append(' ');
                    origStarts.Add(rawStart);
                    origEnds.Add(rawEnd);
                    continue;
                }
            }
            var rawStr = new string(slice);
            string norm;
            try
            {
                norm = rawStr.IsNormalized(NormalizationForm.FormKC) ? rawStr : rawStr.Normalize(NormalizationForm.FormKC);
            }
            catch (ArgumentException)
            {
                // Isolated/malformed UTF-16 surrogate: replace safely with U+FFFD without throwing
                norm = "\uFFFD";
            }
            for (var j = 0; j < norm.Length; j++)
            {
                sb.Append(norm[j]);
                origStarts.Add(rawStart);
                origEnds.Add(rawEnd);
            }
        }
        return (sb.ToString(), origStarts.ToArray(), origEnds.ToArray());
    }

    private static int DecodeCodePointLen(string s, int index) =>
        char.IsHighSurrogate(s[index]) && index + 1 < s.Length && char.IsLowSurrogate(s[index + 1]) ? 2 : 1;

    private static bool IsCombiningMark(string s, int index, int len)
    {
        var cat = len == 2
            ? CharUnicodeInfo.GetUnicodeCategory(s, index)
            : CharUnicodeInfo.GetUnicodeCategory(s[index]);
        return cat is UnicodeCategory.NonSpacingMark or UnicodeCategory.SpacingCombiningMark or UnicodeCategory.EnclosingMark;
    }

    public static bool IsQueryWithinLimit(string? rawQuery, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(rawQuery)) return false;
        var trimmed = rawQuery.Trim();
        if (trimmed.Length == 0 || trimmed.Length > WireLimits.SearchQueryChars) return false;
        var (nfkc, _, _) = NormalizeWithOffsets(trimmed, 0, ct);
        var normalizedTrimmed = nfkc.Trim();
        return normalizedTrimmed.Length > 0 && normalizedTrimmed.Length <= WireLimits.SearchQueryChars;
    }

    public static AnalyzedQuery AnalyzeQuery(string rawQuery, CancellationToken ct = default)
    {
        ct.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(rawQuery))
            return new("", [], [], false, false, false);

        var (nfkc, _, _) = NormalizeWithOffsets(rawQuery, 0, ct);
        var trimmedRaw = nfkc.AsSpan().Trim();
        var exactId = IsStrictExactIdentifier(trimmedRaw);
        if (exactId && trimmedRaw.Length > WireLimits.SearchQueryChars)
            return new("", [], [], true, true, true);

        var overlong = rawQuery.Length > WireLimits.SearchQueryChars || trimmedRaw.Length > WireLimits.SearchQueryChars;

        // Collapse whitespace and lowercase ASCII within the 128-unit query limit
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
            // Don't split a surrogate pair at the truncation boundary
            if (len == WireLimits.SearchQueryChars - 1 && char.IsHighSurrogate(c)) break;
            buf[len++] = c is >= 'A' and <= 'Z' ? (char)(c + 32) : c;
            if (len >= WireLimits.SearchQueryChars) break;
        }
        var collapsed = buf[..len].TrimEnd();
        var normalized = new string(collapsed);
        if (normalized.Length == 0)
            return new("", [], [], exactId, false, overlong);

        var tokens = new List<SearchToken>();
        var shortPrefixes = new List<string>();
        var pos = 0;
        AnalyzeSpanInto(normalized, 0, SearchAnalysisMode.Query, tokens, ref pos, shortPrefixes, ct);
        return new(normalized, tokens, shortPrefixes, exactId, false, overlong);
    }

    public static SearchFieldAnalysis AnalyzePlainField(string text, SearchFieldKind field,
        SearchAnalysisMode mode = SearchAnalysisMode.Index, int startPosition = 0, CancellationToken ct = default)
    {
        var tokens = new List<SearchToken>();
        var pos = startPosition;
        var sourceLen = AnalyzeSpanInto(text ?? "", 0, mode, tokens, ref pos, null, ct);
        return new(field, tokens, sourceLen, pos);
    }

    public static (SearchFieldAnalysis Headings, SearchFieldAnalysis Body, SearchFieldAnalysis Code) AnalyzeMarkdownBody(
        string markdown, CancellationToken ct = default)
    {
        var visible = SearchMarkdownExtractor.Extract(markdown, ct);
        var headingTokens = new List<SearchToken>();
        var bodyTokens = new List<SearchToken>();
        var codeTokens = new List<SearchToken>();
        int headingLen = 0, bodyLen = 0, codeLen = 0;
        int headingPos = 0, bodyPos = 0, codePos = 0;

        foreach (var span in visible)
        {
            ct.ThrowIfCancellationRequested();
            var slice = markdown.Substring(span.SourceStart, span.SourceEnd - span.SourceStart);
            switch (span.Field)
            {
                case SearchFieldKind.Heading:
                    if (span.StartsNewBlock && headingPos > 0) headingPos += BlockPositionGap;
                    headingLen += AnalyzeSpanInto(slice, span.SourceStart, SearchAnalysisMode.Index, headingTokens, ref headingPos, null, ct);
                    break;
                case SearchFieldKind.Code:
                    if (span.StartsNewBlock && codePos > 0) codePos += BlockPositionGap;
                    codeLen += AnalyzeSpanInto(slice, span.SourceStart, SearchAnalysisMode.Index, codeTokens, ref codePos, null, ct);
                    break;
                default:
                    if (span.StartsNewBlock && bodyPos > 0) bodyPos += BlockPositionGap;
                    bodyLen += AnalyzeSpanInto(slice, span.SourceStart, SearchAnalysisMode.Index, bodyTokens, ref bodyPos, null, ct);
                    break;
            }
        }

        return (
            new SearchFieldAnalysis(SearchFieldKind.Heading, headingTokens, headingLen, headingPos),
            new SearchFieldAnalysis(SearchFieldKind.Body, bodyTokens, bodyLen, bodyPos),
            new SearchFieldAnalysis(SearchFieldKind.Code, codeTokens, codeLen, codePos)
        );
    }

    internal static int AnalyzeSpanInto(string rawText, int baseSourceOffset, SearchAnalysisMode mode,
        List<SearchToken> output, ref int position, List<string>? shortAsciiPrefixes, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(rawText)) return 0;
        var (text, origStart, origEnd) = NormalizeWithOffsets(rawText, baseSourceOffset, ct);
        var emitter = new TokenOutput(output, baseSourceOffset, origStart, origEnd);
        HashSet<string>? asciiSeen = null;
        var sourceLength = 0;
        var indexMode = mode == SearchAnalysisMode.Index;

        for (var i = 0; i < text.Length;)
        {
            ct.ThrowIfCancellationRequested();
            if (output.Count >= MaxTokensPerField) break;

            // 1. Technical / ASCII word run (including leading '.', internal '-', '_', '.', '/', trailing '#', '+')
            if (StartsTechnicalToken(text, i))
            {
                var start = i;
                var end = ScanTechnicalToken(text, i);
                i = end;
                var rawToken = text.AsSpan(start, end - start);
                // Reject overlong tokens rather than truncating them into a different term.
                if (rawToken.Length > MaxIndexedTokenChars) continue;
                var hasPunct = HasTechnicalPunctuation(rawToken);

                var lower = LowerAsciiString(rawToken);
                var tokenPos = position;
                position += 1;
                sourceLength += 1;

                emitter.Emit(lower, SearchTokenKind.Exact, tokenPos, 1, 1, start, end);

                // Query mode expands only pure-letter hyphenated terms, so "batch-item" also
                // matches "Batch Item". Strict identifiers such as "issue-2205" stay exact.
                if (indexMode || (rawToken.Contains('-') && !IsStrictExactIdentifier(rawToken)))
                {
                    asciiSeen ??= new HashSet<string>(StringComparer.Ordinal);
                    // Alternatives are strict slices, so the whole term need not be in the set.
                    asciiSeen.Clear();
                    if (indexMode)
                        EmitAsciiAlternatives(rawToken, lower, hasPunct, tokenPos, start, end, emitter, asciiSeen);
                    else
                        EmitConnectorSubwords(rawToken, lower, tokenPos, start, emitter, asciiSeen);
                }

                if (!indexMode && shortAsciiPrefixes is not null && !hasPunct && lower.Length is >= 1 and < AsciiMinPrefixLength)
                    if (!shortAsciiPrefixes.Contains(lower)) shortAsciiPrefixes.Add(lower);
                continue;
            }

            // 2. CJK continuous run
            if (SearchLexicon.IsCjk(text[i]))
            {
                var start = i++;
                while (i < text.Length && SearchLexicon.IsCjk(text[i])) i++;
                var runLen = i - start;
                var runBasePos = position;
                sourceLength += EmitCjkRun(text, start, i, runBasePos, indexMode, emitter, ct);
                position += runLen;
                continue;
            }

            // 3. Other Unicode letters/digits (e.g. accented Latin 'é', Greek, Cyrillic, supplementary CJK '𠀀')
            if (!Rune.TryGetRuneAt(text, i, out var scalar)) scalar = Rune.ReplacementChar;
            var runeLen = scalar.Utf16SequenceLength;
            if (scalar.Value >= 0x80 && Rune.IsLetterOrDigit(scalar))
            {
                var start = i;
                var end = i + runeLen;
                // Group contiguous non-CJK non-ASCII letters/digits (e.g. "café" or "Étoile" when preceded/followed by ASCII?
                // Wait: "café" starts with ASCII 'c'! Wait - let's check accented words like "café"!)
                var term = Rune.ToLowerInvariant(scalar).ToString();
                emitter.Emit(term, SearchTokenKind.Exact, position, 1, 1, start, end);
                position += 1;
                sourceLength += 1;
            }
            i += runeLen;
        }

        return sourceLength;
    }

    private readonly struct TokenOutput(List<SearchToken> output, int baseSourceOffset, int[]? origStart, int[]? origEnd)
    {
        internal void Emit(string term, SearchTokenKind kind, int pos, int width, int advance, int normStart, int normEnd)
        {
            if (term.Length == 0 || output.Count >= MaxTokensPerField) return;
            var sStart = origStart is null ? baseSourceOffset + normStart : origStart[normStart];
            var sEnd = origEnd is null ? baseSourceOffset + normEnd : origEnd[normEnd - 1];
            var stop = SearchLexicon.IsStopword(term.AsSpan());
            var (h64, h32) = HashTermBoth(term.AsSpan());
            output.Add(new SearchToken(term, h64, h32, kind, pos, width, advance, sStart, sEnd, stop));
        }
    }

    private static int EmitCjkRun(string text, int start, int end, int basePos, bool indexMode,
        TokenOutput emitter, CancellationToken ct)
    {
        var runLen = end - start;
        if (runLen == 1)
        {
            var single = text.Substring(start, 1);
            emitter.Emit(single, SearchTokenKind.Exact, basePos, 1, 1, start, end);
            var simp = ToSimplifiedCjk(single);
            if (!string.Equals(simp, single, StringComparison.Ordinal))
                emitter.Emit(simp, SearchTokenKind.ScriptAlias, basePos, 1, 0, start, end);
            return 1;
        }

        var (simpSrc, simpBase) = ToSimplifiedCjkSlice(text, start, runLen);
        var hasScDiff = !ReferenceEquals(simpSrc, text);

        void EmitWithScriptAlias(string origWord, ReadOnlySpan<char> simpWord, SearchTokenKind kind, int pos, int width, int advance, int ns, int ne)
        {
            emitter.Emit(origWord, kind, pos, width, advance, ns, ne);
            if (hasScDiff && !simpWord.SequenceEqual(origWord.AsSpan()))
                emitter.Emit(new string(simpWord), SearchTokenKind.ScriptAlias, pos, width, 0, ns, ne);
        }

        // Long CJK run (> 4096): bounded linear scan without DP table allocation
        if (runLen > MaxCjkSegment)
        {
            for (var rel = 0; rel < runLen; rel++)
            {
                if ((rel & 255) == 0) ct.ThrowIfCancellationRequested();
                var abs = start + rel;
                var pos = basePos + rel;
                for (var w = Math.Min(SearchLexicon.MaxWord, runLen - rel); w >= 2; w--)
                {
                    var simpCand = simpSrc.AsSpan(simpBase + rel, w);
                    if (SearchLexicon.IsWord(simpCand))
                    {
                        EmitWithScriptAlias(text.Substring(abs, w), simpCand,
                            SearchTokenKind.Exact, pos, w, 0, abs, abs + w);
                    }
                }
                if (rel + 1 < runLen && !SearchLexicon.IsWord(simpSrc.AsSpan(simpBase + rel, 2)))
                {
                    EmitWithScriptAlias(text.Substring(abs, 2), simpSrc.AsSpan(simpBase + rel, 2),
                        SearchTokenKind.CjkBigram, pos, 2, indexMode ? 0 : 1, abs, abs + 2);
                }
                if (indexMode)
                {
                    EmitWithScriptAlias(text.Substring(abs, 1), simpSrc.AsSpan(simpBase + rel, 1),
                        SearchTokenKind.CjkChar, pos, 1, 1, abs, abs + 1);
                }
            }
            return runLen;
        }

        // Standard CJK run (2..4096): Viterbi segmentation on SC-folded view so Traditional and Simplified
        // segment on identical dictionary boundaries.
        var segments = new List<(int Rel, int Width)>(Math.Min(runLen, 32));
        foreach (var (segStart, segWidth) in SearchLexicon.Segment(simpSrc, simpBase, simpBase + runLen))
            segments.Add((segStart - simpBase, segWidth));

        ulong emittedMask = 0;
        HashSet<int>? emittedOverflow = runLen > 64 ? [] : null;
        bool MarkBigram(int rel)
        {
            if (rel < 64)
            {
                var bit = 1UL << rel;
                if ((emittedMask & bit) != 0) return false;
                emittedMask |= bit;
                return true;
            }
            return emittedOverflow!.Add(rel);
        }
        void EmitBigramOnce(int rel, int advance)
        {
            if (rel < 0 || rel + 2 > runLen) return;
            if (!MarkBigram(rel)) return;
            var abs = start + rel;
            EmitWithScriptAlias(text.Substring(abs, 2), simpSrc.AsSpan(simpBase + rel, 2),
                SearchTokenKind.CjkBigram, basePos + rel, 2, advance, abs, abs + 2);
        }

        var idx = 0;
        while (idx < segments.Count)
        {
            var (rel, width) = segments[idx];
            if (width >= 2)
            {
                var abs = start + rel;
                // Primary dictionary term counts the source span once (advance = width)
                EmitWithScriptAlias(text.Substring(abs, width), simpSrc.AsSpan(simpBase + rel, width),
                    SearchTokenKind.Exact, basePos + rel, width, width, abs, abs + width);

                // Dictionary subwords (2 <= subWidth < width)
                for (var r = 0; r < width; r++)
                {
                    var maxSub = Math.Min(width - 1, width - r);
                    for (var subW = maxSub; subW >= 2; subW--)
                    {
                        var subSimp = simpSrc.AsSpan(simpBase + rel + r, subW);
                        if (SearchLexicon.IsWord(subSimp))
                        {
                            EmitWithScriptAlias(text.Substring(abs + r, subW), subSimp,
                                SearchTokenKind.Subword, basePos + rel + r, subW, 0, abs + r, abs + r + subW);
                            if (subW == 2) MarkBigram(rel + r);
                        }
                    }
                }

                if (width == 2)
                {
                    MarkBigram(rel);
                }
                if (indexMode)
                {
                    // Adjacent bigrams inside 3+-char dictionary words (for unknown/fragment recall)
                    for (var r = 0; r + 1 < width; r++) EmitBigramOnce(rel + r, 0);
                    // Index-only single-character aliases (so explicit 1-char queries find them,
                    // without polluting multi-character query concepts)
                    for (var r = 0; r < width; r++)
                    {
                        EmitWithScriptAlias(text.Substring(abs + r, 1), simpSrc.AsSpan(simpBase + rel + r, 1),
                            SearchTokenKind.CjkChar, basePos + rel + r, 1, 0, abs + r, abs + r + 1);
                    }
                }
                idx++;
            }
            else
            {
                // Group contiguous unknown 1-char segments
                var groupStart = rel;
                while (idx < segments.Count && segments[idx].Width == 1) idx++;
                var groupEnd = idx < segments.Count ? segments[idx].Rel : runLen;
                var groupLen = groupEnd - groupStart;

                if (groupLen == 1)
                {
                    var abs = start + groupStart;
                    var singleSpan = simpSrc.AsSpan(simpBase + groupStart, 1);
                    var isLexiconSingle = SearchLexicon.IsWord(singleSpan) || SearchLexicon.IsStopword(singleSpan);
                    if (indexMode)
                    {
                        EmitWithScriptAlias(text.Substring(abs, 1), singleSpan,
                            isLexiconSingle ? SearchTokenKind.Exact : SearchTokenKind.CjkChar,
                            basePos + groupStart, 1, 1, abs, abs + 1);
                    }
                    else if (isLexiconSingle)
                    {
                        EmitWithScriptAlias(text.Substring(abs, 1), singleSpan,
                            SearchTokenKind.Exact, basePos + groupStart, 1, 1, abs, abs + 1);
                    }
                    else
                    {
                        // Single unknown char inside a multi-char query: emit bridging bigram(s) with neighbor
                        // so unknown fragments stay positional, plus Exact if isolated
                        var bridged = false;
                        if (groupStart > 0) { EmitBigramOnce(groupStart - 1, 1); bridged = true; }
                        if (groupStart + 1 < runLen) { EmitBigramOnce(groupStart, bridged ? 0 : 1); bridged = true; }
                        if (!bridged)
                        {
                            EmitWithScriptAlias(text.Substring(abs, 1), singleSpan,
                                SearchTokenKind.Exact, basePos + groupStart, 1, 1, abs, abs + 1);
                        }
                    }
                }
                else
                {
                    // Multi-char unknown Chinese compound/name (e.g. 量子纠缠, 林徽因):
                    // Emit adjacent bigrams with exact positions; count source length ONCE across the group!
                    for (var r = 0; r + 1 < groupLen; r++)
                        EmitBigramOnce(groupStart + r, r == 0 ? groupLen : 0);

                    if (indexMode)
                    {
                        for (var r = 0; r < groupLen; r++)
                        {
                            var abs = start + groupStart + r;
                            EmitWithScriptAlias(text.Substring(abs, 1), simpSrc.AsSpan(simpBase + groupStart + r, 1),
                                SearchTokenKind.CjkChar, basePos + groupStart + r, 1, 0, abs, abs + 1);
                        }
                    }
                }
            }
        }

        // Index mode: emit cross-segment bridging bigrams inside the CJK run so fragments crossing
        // dictionary boundaries retain exact positional bigrams.
        if (indexMode)
        {
            for (var s = 1; s < segments.Count; s++)
                EmitBigramOnce(segments[s].Rel - 1, 0);
        }

        return runLen;
    }

    private static bool StartsTechnicalToken(string text, int index)
    {
        var c = text[index];
        if (char.IsAsciiLetterOrDigit(c)) return true;
        // Leading dot identifier like .NET (only when not preceded by an ASCII word char)
        if (c == '.' && index + 1 < text.Length && char.IsAsciiLetter(text[index + 1]) &&
            (index == 0 || !char.IsAsciiLetterOrDigit(text[index - 1])))
            return true;
        return false;
    }

    private static int ScanTechnicalToken(string text, int start)
    {
        var i = start;
        if (text[i] == '.') i++;
        while (i < text.Length)
        {
            if (char.IsAsciiLetterOrDigit(text[i]))
            {
                i++;
                continue;
            }
            // Internal single connector (-, _, ., /) followed by ASCII alnum (or trailing C/C++ style)
            if (text[i] is '-' or '_' or '.' or '/' && i + 1 < text.Length && char.IsAsciiLetterOrDigit(text[i + 1]))
            {
                i += 2;
                continue;
            }
            break;
        }
        // Trailing '#' or '+' runs (1..3 chars, e.g. C#, C++, F#, Q#++, C/C++)
        if (i < text.Length && text[i] is '#' or '+')
        {
            var symStart = i;
            while (i < text.Length && text[i] is '#' or '+' && i - symStart < 3) i++;
            // Only attach trailing #/+ if not immediately glued to another ASCII letter/digit
            if (i < text.Length && char.IsAsciiLetterOrDigit(text[i])) i = symStart;
        }
        return i;
    }

    private static bool HasTechnicalPunctuation(ReadOnlySpan<char> token)
    {
        foreach (var c in token)
            if (c is '-' or '_' or '.' or '/' or '#' or '+') return true;
        return false;
    }

    /// <summary>
    /// Strict exact identifiers: compound identifiers with digits (issue-2205, Batch-Item_7, UTF-8, HTTP/2),
    /// underscore/dot/slash/symbol technical terms (C#, C++, .NET, ASP.NET, Node.js, v2_schema, CI/CD, fsdl_dict).
    /// </summary>
    public static bool IsStrictExactIdentifier(ReadOnlySpan<char> token)
    {
        if (token.Length < 2) return false;
        var hasDigit = false;
        var hasHyphen = false;
        var hasStrictSymbol = false;
        var hasAlnum = false;
        for (var i = 0; i < token.Length; i++)
        {
            var c = token[i];
            if (char.IsAsciiLetterOrDigit(c))
            {
                hasAlnum = true;
                hasDigit |= char.IsAsciiDigit(c);
            }
            else if (c == '-')
            {
                if (i == 0 || i == token.Length - 1 || !char.IsAsciiLetterOrDigit(token[i - 1]) || !char.IsAsciiLetterOrDigit(token[i + 1]))
                    return false;
                hasHyphen = true;
            }
            else if (c is '_' or '.' or '/')
            {
                // Leading dot allowed only before ASCII letter (e.g. .NET); connectors cannot repeat or trail
                if (i == token.Length - 1) return false;
                if (c == '.' && i == 0)
                {
                    if (!char.IsAsciiLetter(token[1])) return false;
                }
                else
                {
                    if (i == 0 || !char.IsAsciiLetterOrDigit(token[i - 1]) || !char.IsAsciiLetterOrDigit(token[i + 1]))
                        return false;
                }
                hasStrictSymbol = true;
            }
            else if (c is '#' or '+')
            {
                if (i == 0) return false;
                hasStrictSymbol = true;
            }
            else
            {
                return false;
            }
        }
        return hasAlnum && (hasStrictSymbol || (hasHyphen && hasDigit));
    }

    private struct AsciiAlternativeOutput(TokenOutput emitter, HashSet<string> seen, int pos, int normStart, int normEnd)
    {
        private int _count;

        internal void Emit(string candidate, SearchTokenKind kind)
        {
            if (_count >= MaxAsciiSubtokens || !seen.Add(candidate)) return;
            _count++;
            emitter.Emit(candidate, kind, pos, 1, 0, normStart, normEnd);
        }

        internal void EmitPrefixes(string term)
        {
            var maxPrefix = Math.Min(AsciiMaxPrefixLength, term.Length - 1);
            for (var len = AsciiMinPrefixLength; len <= maxPrefix; len++)
                Emit(term[..len], SearchTokenKind.Prefix);
        }

        internal void EmitSubwordsAndPrefixes(ReadOnlySpan<char> raw, string lower)
        {
            // Emit subwords first so their kind and budget take precedence over prefixes.
            EmitCamelCaseAlternatives(raw, lower, prefixes: false);
            EmitPrefixes(lower);
            EmitCamelCaseAlternatives(raw, lower, prefixes: true);
        }

        private void EmitCamelCaseAlternatives(ReadOnlySpan<char> raw, string lower, bool prefixes)
        {
            var segStart = 0;
            for (var i = 1; i <= raw.Length; i++)
            {
                if (i < raw.Length && !IsSubwordBoundary(raw, i)) continue;
                var segLen = i - segStart;
                if (segLen >= 2 && segLen < raw.Length)
                {
                    var segLower = lower.Substring(segStart, segLen);
                    if (prefixes)
                        EmitPrefixes(segLower);
                    else
                        Emit(segLower, SearchTokenKind.Subword);
                }
                segStart = i;
            }
        }
    }

    private static void EmitAsciiAlternatives(ReadOnlySpan<char> rawToken, string lower, bool hasPunct, int pos,
        int normStart, int normEnd, TokenOutput emitter, HashSet<string> seen)
    {
        var alternatives = new AsciiAlternativeOutput(emitter, seen, pos, normStart, normEnd);
        if (!hasPunct)
        {
            alternatives.EmitSubwordsAndPrefixes(rawToken, lower);
            return;
        }

        // Punctuation-bearing technical token (e.g. issue-2205, ASP.NET, Node.js, C#, C++, HTTP/2):
        // Skip single-letter bases such as "c" for C# and C++.
        // For dotted names like ASP.NET, also emit leading-dot suffix ".net" as Subword!
        var dotIdx = lower.IndexOf('.');
        if (dotIdx > 0 && dotIdx + 2 < lower.Length)
        {
            var dottedSuffix = lower[dotIdx..];
            if (!dottedSuffix.AsSpan(1).Contains('.'))
                alternatives.Emit(dottedSuffix, SearchTokenKind.Subword);
        }

        // Split on '-', '_', '.', '/' and emit >=2-char alphanumeric segments as Subword (+ camelCase inside each)
        var segStart = 0;
        for (var i = 0; i <= rawToken.Length; i++)
        {
            if (i < rawToken.Length && rawToken[i] is not ('-' or '_' or '.' or '/')) continue;
            var segLen = i - segStart;
            if (segLen >= 2 && segLen < rawToken.Length)
            {
                var segRaw = rawToken.Slice(segStart, segLen);
                // Strip trailing #/+ only when checking pure alphanumeric subword, keep e.g. "c++" from "c/c++"
                var segLower = LowerAsciiString(segRaw);
                alternatives.Emit(segLower, SearchTokenKind.Subword);
                if (!HasTechnicalPunctuation(segRaw))
                    alternatives.EmitSubwordsAndPrefixes(segRaw, segLower);
            }
            segStart = i + 1;
        }
    }

    private static void EmitConnectorSubwords(ReadOnlySpan<char> rawToken, string lower, int pos,
        int normStart, TokenOutput emitter, HashSet<string> seen)
    {
        var segStart = 0;
        for (var i = 0; i <= rawToken.Length; i++)
        {
            if (i < rawToken.Length && rawToken[i] != '-') continue;
            var segLen = i - segStart;
            if (segLen >= 1 && segLen < rawToken.Length)
            {
                var segLower = lower.Substring(segStart, segLen);
                if (seen.Add(segLower))
                    emitter.Emit(segLower, SearchTokenKind.Subword, pos, 1, 0, normStart + segStart, normStart + i);
            }
            segStart = i + 1;
        }
    }

    internal static bool IsSubwordBoundary(ReadOnlySpan<char> token, int index)
    {
        var previous = token[index - 1];
        var current = token[index];
        if (char.IsAsciiDigit(previous) != char.IsAsciiDigit(current)) return true;
        if (char.IsAsciiLetterLower(previous) && char.IsAsciiLetterUpper(current)) return true;
        if (char.IsAsciiLetterUpper(previous) && char.IsAsciiLetterUpper(current) &&
            index + 1 < token.Length && char.IsAsciiLetterLower(token[index + 1])) return true;
        return false;
    }

    private static string LowerAsciiString(ReadOnlySpan<char> span)
    {
        Span<char> buf = span.Length <= 128 ? stackalloc char[span.Length] : new char[span.Length];
        for (var i = 0; i < span.Length; i++)
        {
            var c = span[i];
            buf[i] = c is >= 'A' and <= 'Z' ? (char)(c + 32) : c;
        }
        return new string(buf);
    }
}
