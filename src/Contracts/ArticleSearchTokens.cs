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

    internal static int DocumentLength(string body, CancellationToken ct = default)
    {
        var (headings, prose, code) = SearchTextAnalyzer.AnalyzeMarkdownBody(body ?? "", ct);
        return Math.Max(1, headings.SourceLength + prose.SourceLength + code.SourceLength);
    }
}

