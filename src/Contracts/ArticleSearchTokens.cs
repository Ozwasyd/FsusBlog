namespace FsusBlog.V2.Contracts;

public readonly record struct SearchTermKey(ulong Hash64, string Term) : IComparable<SearchTermKey>
{
    public int CompareTo(SearchTermKey other)
    {
        var cmp = Hash64.CompareTo(other.Hash64);
        return cmp != 0 ? cmp : string.CompareOrdinal(Term, other.Term);
    }

    public static SearchTermKey From(SearchToken token) => new(token.Key, token.Term);
    public static SearchTermKey From(string term) => new(SearchTextAnalyzer.HashTerm64(term), term);
}

internal static class ArticleSearchTokens
{
    internal const int AsciiMinPrefixLength = SearchTextAnalyzer.AsciiMinPrefixLength;
    internal const int AsciiMaxPrefixLength = SearchTextAnalyzer.AsciiMaxPrefixLength;
    internal const int MaxAsciiSubtokens = SearchTextAnalyzer.MaxAsciiSubtokens;

    internal static AnalyzedQuery AnalyzeQuery(string text, CancellationToken ct) =>
        SearchTextAnalyzer.AnalyzeQuery(text, ct);

    internal static bool VisitFieldTokens(string text, SearchFieldKind field, bool isMarkdown, CancellationToken ct,
        Func<SearchTermKey, bool, bool> visit, out int sourceLength)
    {
        if (isMarkdown)
        {
            var (headings, body, code) = SearchTextAnalyzer.AnalyzeMarkdownBody(text, ct);
            sourceLength = Math.Max(1, headings.SourceLength + body.SourceLength + code.SourceLength);
            return EmitList(headings.Tokens, visit, ct) &&
                   EmitList(body.Tokens, visit, ct) &&
                   EmitList(code.Tokens, visit, ct);
        }

        var analyzed = SearchTextAnalyzer.AnalyzePlainField(text, field, SearchAnalysisMode.Index, 0, ct);
        sourceLength = analyzed.SourceLength;
        return EmitList(analyzed.Tokens, visit, ct);

        static bool EmitList(IReadOnlyList<SearchToken> tokens, Func<SearchTermKey, bool, bool> visit, CancellationToken ct)
        {
            for (var i = 0; i < tokens.Count; i++)
            {
                if ((i & 1023) == 0) ct.ThrowIfCancellationRequested();
                var token = tokens[i];
                var isPrimary = token.Kind == SearchTokenKind.Exact || token.Advance > 0;
                if (!visit(SearchTermKey.From(token), isPrimary)) return false;
            }
            return true;
        }
    }

    internal static bool VisitFieldSources(string text, SearchFieldKind field, bool isMarkdown, CancellationToken ct,
        Func<SearchTermKey?, ReadOnlySpan<SearchTermKey>, bool> visit, out int sourceLength)
    {
        if (isMarkdown)
        {
            var (headings, body, code) = SearchTextAnalyzer.AnalyzeMarkdownBody(text, ct);
            sourceLength = Math.Max(1, headings.SourceLength + body.SourceLength + code.SourceLength);
            return EmitGroups(headings.Tokens, visit, ct) &&
                   EmitGroups(body.Tokens, visit, ct) &&
                   EmitGroups(code.Tokens, visit, ct);
        }

        var analyzed = SearchTextAnalyzer.AnalyzePlainField(text, field, SearchAnalysisMode.Index, 0, ct);
        sourceLength = analyzed.SourceLength;
        return EmitGroups(analyzed.Tokens, visit, ct);

        static bool EmitGroups(IReadOnlyList<SearchToken> tokens,
            Func<SearchTermKey?, ReadOnlySpan<SearchTermKey>, bool> visit, CancellationToken ct)
        {
            var aliases = new List<SearchTermKey>(16);
            var i = 0;
            while (i < tokens.Count)
            {
                if ((i & 1023) == 0) ct.ThrowIfCancellationRequested();
                var head = tokens[i];
                var headPrimary = head.Kind == SearchTokenKind.Exact || head.Advance > 0;
                if (!headPrimary)
                {
                    if (!visit(null, [SearchTermKey.From(head)])) return false;
                    i++;
                    continue;
                }
                aliases.Clear();
                var headKey = SearchTermKey.From(head);
                var j = i + 1;
                while (j < tokens.Count && tokens[j].Advance == 0 && tokens[j].Position == head.Position &&
                       tokens[j].SourceStart == head.SourceStart && tokens[j].SourceEnd == head.SourceEnd &&
                       tokens[j].Kind is SearchTokenKind.Prefix or SearchTokenKind.Subword or SearchTokenKind.ScriptAlias)
                {
                    var key = SearchTermKey.From(tokens[j]);
                    if (!key.Equals(headKey)) aliases.Add(key);
                    j++;
                }
                var span = System.Runtime.InteropServices.CollectionsMarshal.AsSpan(aliases);
                if (!visit(headKey, span)) return false;
                i = j;
            }
            return true;
        }
    }

    /// <summary>
    /// Emits source-grouped terms for WideIndex alias sharing preserving the exact 3 token strength roles:
    /// role 0 = Exact / Advance>0 CjkBigram (+2 half-steps, HasExact=true),
    /// role 1 = ScriptAlias / standalone CjkChar (+2 half-steps, HasExact=false),
    /// role 2 = Derived Prefix / Subword / internal CjkBigram or CjkChar (+1 half-step, HasExact=false).
    /// </summary>
    internal static bool VisitTokensAsRoleGroups(IReadOnlyList<SearchToken> tokens,
        Func<SearchTermKey?, ReadOnlySpan<SearchTermKey>, ReadOnlySpan<SearchTermKey>, bool> visit, CancellationToken ct)
    {
        var scriptOrStandalone = new List<SearchTermKey>(4);
        var derived = new List<SearchTermKey>(24);
        var i = 0;
        while (i < tokens.Count)
        {
            if ((i & 1023) == 0) ct.ThrowIfCancellationRequested();
            var head = tokens[i];
            var headRole = TokenRole(head);
            if (headRole != 0)
            {
                var key = SearchTermKey.From(head);
                if (headRole == 1)
                {
                    if (!visit(null, [key], [])) return false;
                }
                else
                {
                    if (!visit(null, [], [key])) return false;
                }
                i++;
                continue;
            }
            scriptOrStandalone.Clear();
            derived.Clear();
            var headKey = SearchTermKey.From(head);
            var j = i + 1;
            while (j < tokens.Count && tokens[j].Advance == 0 && tokens[j].Position == head.Position &&
                   tokens[j].SourceStart == head.SourceStart && tokens[j].SourceEnd == head.SourceEnd &&
                   tokens[j].Kind is SearchTokenKind.Prefix or SearchTokenKind.Subword or SearchTokenKind.ScriptAlias)
            {
                var next = tokens[j];
                var key = SearchTermKey.From(next);
                if (!key.Equals(headKey))
                {
                    if (next.Kind == SearchTokenKind.ScriptAlias) scriptOrStandalone.Add(key);
                    else derived.Add(key);
                }
                j++;
            }
            if (!visit(headKey,
                    System.Runtime.InteropServices.CollectionsMarshal.AsSpan(scriptOrStandalone),
                    System.Runtime.InteropServices.CollectionsMarshal.AsSpan(derived)))
                return false;
            i = j;
        }
        return true;
    }

    internal static byte TokenRole(SearchToken tok)
    {
        if (tok.Kind == SearchTokenKind.Exact || (tok.Kind == SearchTokenKind.CjkBigram && tok.Advance > 0))
            return 0; // +2 half-steps, HasExact=true
        if (tok.Kind == SearchTokenKind.ScriptAlias || tok.Advance > 0)
            return 1; // +2 half-steps, HasExact=false
        return 2; // +1 half-step, HasExact=false
    }

    internal static int CountAsciiPrefixMatches(string text, ReadOnlySpan<char> prefix)
    {
        if (string.IsNullOrEmpty(text) || prefix.Length == 0 || text.Length <= prefix.Length) return 0;
        var span = text.IsNormalized(NormalizationForm.FormKC)
            ? text.AsSpan()
            : text.Normalize(NormalizationForm.FormKC).AsSpan();
        var count = 0;
        for (var offset = 0; offset < span.Length;)
        {
            if (!char.IsAsciiLetterOrDigit(span[offset]))
            {
                offset++;
                continue;
            }
            var start = offset++;
            while (offset < span.Length && char.IsAsciiLetterOrDigit(span[offset])) offset++;
            var token = span.Slice(start, offset - start);
            if (token.Length <= prefix.Length) continue;
            if (StartsWithLowerAscii(token, prefix))
            {
                count++;
                continue;
            }
            var segmentStart = 0;
            for (var i = 1; i <= token.Length; i++)
            {
                if (i < token.Length && !SearchTextAnalyzer.IsSubwordBoundary(token, i)) continue;
                var segmentLength = i - segmentStart;
                if (segmentStart > 0 && segmentLength > prefix.Length &&
                    StartsWithLowerAscii(token.Slice(segmentStart, segmentLength), prefix))
                {
                    count++;
                    break;
                }
                segmentStart = i;
            }
        }
        return count;

        static bool StartsWithLowerAscii(ReadOnlySpan<char> value, ReadOnlySpan<char> lowerPrefix)
        {
            for (var i = 0; i < lowerPrefix.Length; i++)
            {
                var unit = value[i];
                if (unit is >= 'A' and <= 'Z') unit = (char)(unit + 32);
                if (unit != lowerPrefix[i]) return false;
            }
            return true;
        }
    }

    /// <summary>Packs a 1- or 2-character lowercase ASCII prefix into a collision-free ushort key.</summary>
    internal static ushort PackShortPrefixKey(ReadOnlySpan<char> lowerPrefix) =>
        lowerPrefix.Length == 1
            ? (ushort)lowerPrefix[0]
            : (ushort)(((uint)lowerPrefix[0] << 8) | lowerPrefix[1]);

    /// <summary>
    /// Collects exact per-field 1- and 2-char ASCII prefix hit counts matching <see cref="CountAsciiPrefixMatches"/>
    /// in one linear pass at index build time so queries never scan article metadata strings (#48).
    /// fieldShift: 20=Title, 10=Summary, 0=Taxonomy.
    /// </summary>
    internal static void AccumulateShortPrefixCounts(string? text, int fieldShift, Dictionary<ushort, int> docPacked)
    {
        if (string.IsNullOrEmpty(text) || text.Length <= 1) return;
        var span = text.IsNormalized(NormalizationForm.FormKC)
            ? text.AsSpan()
            : text.Normalize(NormalizationForm.FormKC).AsSpan();
        var allowLen2 = text.Length > 2;
        Span<ushort> seenInToken = stackalloc ushort[64];
        HashSet<ushort>? seenOverflow = null;
        for (var offset = 0; offset < span.Length;)
        {
            if (!char.IsAsciiLetterOrDigit(span[offset]))
            {
                offset++;
                continue;
            }
            var start = offset++;
            while (offset < span.Length && char.IsAsciiLetterOrDigit(span[offset])) offset++;
            var token = span.Slice(start, offset - start);
            if (token.Length <= 1) continue;

            var seenCount = 0;
            seenOverflow?.Clear();

            static char Lower(char c) => c is >= 'A' and <= 'Z' ? (char)(c + 32) : c;

            // Whole-token prefix of length 1 (token.Length >= 2) and length 2 (text.Length > 2 && token.Length >= 3)
            var c0 = Lower(token[0]);
            RecordShortPrefix((ushort)c0, seenInToken, ref seenCount, ref seenOverflow, docPacked, fieldShift);
            if (allowLen2 && token.Length > 2)
                RecordShortPrefix((ushort)(((uint)c0 << 8) | Lower(token[1])), seenInToken, ref seenCount, ref seenOverflow, docPacked, fieldShift);

            // CamelCase / digit subword boundary prefixes matching CountAsciiPrefixMatches
            var segmentStart = 0;
            for (var i = 1; i <= token.Length; i++)
            {
                if (i < token.Length && !SearchTextAnalyzer.IsSubwordBoundary(token, i)) continue;
                var segLen = i - segmentStart;
                if (segmentStart > 0 && segLen > 1)
                {
                    var s0 = Lower(token[segmentStart]);
                    RecordShortPrefix((ushort)s0, seenInToken, ref seenCount, ref seenOverflow, docPacked, fieldShift);
                    if (allowLen2 && segLen > 2)
                        RecordShortPrefix((ushort)(((uint)s0 << 8) | Lower(token[segmentStart + 1])), seenInToken, ref seenCount, ref seenOverflow, docPacked, fieldShift);
                }
                segmentStart = i;
            }
        }

        static void RecordShortPrefix(ushort key, Span<ushort> seenInToken, ref int seenCount,
            ref HashSet<ushort>? seenOverflow, Dictionary<ushort, int> docPacked, int fieldShift)
        {
            for (var s = 0; s < seenCount; s++)
                if (seenInToken[s] == key) return;
            if (seenCount < seenInToken.Length)
            {
                seenInToken[seenCount++] = key;
            }
            else
            {
                seenOverflow ??= [];
                if (!seenOverflow.Add(key)) return;
            }
            ref var slot = ref System.Runtime.InteropServices.CollectionsMarshal.GetValueRefOrAddDefault(docPacked, key, out _);
            slot = IncrementPackedSlot(slot, fieldShift);
        }

        static int IncrementPackedSlot(int packed, int shift)
        {
            var cur = (packed >> shift) & 1023;
            if (cur >= 1023) return packed;
            return (packed & ~(1023 << shift)) | ((cur + 1) << shift);
        }
    }

    internal static int DocumentLength(string body, CancellationToken ct = default)
    {
        var (headings, prose, code) = SearchTextAnalyzer.AnalyzeMarkdownBody(body ?? "", ct);
        return Math.Max(1, headings.SourceLength + prose.SourceLength + code.SourceLength);
    }
}

