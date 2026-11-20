using System.Text;
using System.Text.RegularExpressions;

namespace FsusBlog.V2.Contracts;

internal static class ArticleSearchTokens
{
    private const int MaxCjkSegment = 4096;
    private const int MaxMeasuredBody = 256 * 1024;
    internal const int AsciiMinPrefixLength = 3;
    internal const int AsciiMaxPrefixLength = 12;
    internal const int MaxAsciiSubtokens = 32;
    private static readonly Regex Link = new(@"!?\[(?<text>.*?)\]\(.*?\)", RegexOptions.NonBacktracking);
    private static readonly Regex Tag = new(@"<.*?>", RegexOptions.NonBacktracking);

    internal static (string Text, bool ExactIdentifier) NormalizeQuery(string text)
    {
        var normalized = text.Normalize(NormalizationForm.FormKC).AsSpan().Trim();
        var exactIdentifier = IsCompoundIdentifier(normalized);
        if (exactIdentifier && normalized.Length > WireLimits.SearchQueryChars) return ("", true);
        Span<char> query = stackalloc char[WireLimits.SearchQueryChars + 1];
        var length = 0;
        foreach (var value in normalized)
        {
            if (char.IsWhiteSpace(value))
            {
                if (length > 0 && query[length - 1] != ' ') query[length++] = ' ';
                continue;
            }
            query[length++] = char.ToLowerInvariant(value);
            if (length >= WireLimits.SearchQueryChars) break;
        }
        var trimmed = query[..length].TrimEnd();
        return (trimmed.Length <= WireLimits.SearchQueryChars ? new string(trimmed) : "", exactIdentifier);
    }

    internal static IEnumerable<uint> Hashes(string text, CancellationToken ct)
    {
        for (var offset = 0; offset < text.Length;)
        {
            ct.ThrowIfCancellationRequested();
            if (char.IsAsciiLetterOrDigit(text[offset]))
            {
                var start = offset++;
                while (offset < text.Length && char.IsAsciiLetterOrDigit(text[offset])) offset++;
                yield return LocalSearchCorpus.HashAscii(text.AsSpan(start, offset - start));
            }
            else if (SearchLexicon.IsCjk(text[offset]))
            {
                var start = offset++;
                while (offset < text.Length && SearchLexicon.IsCjk(text[offset])) offset++;
                // The frozen tokenizer falls through to one scalar until its remaining suffix fits.
                while (offset - start > MaxCjkSegment)
                    yield return LocalSearchCorpus.HashWord(text.AsSpan(start++, 1));
                foreach (var (at, width) in SearchLexicon.Segment(text, start, offset))
                {
                    yield return LocalSearchCorpus.HashWord(text.AsSpan(at, width));
                    for (var relative = 0; relative < width; relative++)
                    {
                        var longest = Math.Min(width - 1, width - relative);
                        for (var part = 2; part <= longest; part++)
                        {
                            var candidate = text.AsSpan(at + relative, part);
                            if (SearchLexicon.IsWord(candidate))
                                yield return LocalSearchCorpus.HashWord(candidate);
                        }
                    }
                }
            }
            else
            {
                if (!Rune.TryGetRuneAt(text, offset, out var scalar)) scalar = Rune.ReplacementChar;
                offset += scalar.Utf16SequenceLength;
                var unit = (char)scalar.Value;
                if (scalar.Value > 0x20 && !char.IsPunctuation(unit) && !char.IsWhiteSpace(unit))
                    yield return LocalSearchCorpus.HashRune(scalar);
            }
        }
    }

    internal static bool VisitIndexTokens(string text, CancellationToken ct, Func<uint, bool, bool> visit)
    {
        Span<uint> subtokens = stackalloc uint[MaxAsciiSubtokens];
        for (var offset = 0; offset < text.Length;)
        {
            ct.ThrowIfCancellationRequested();
            if (char.IsAsciiLetterOrDigit(text[offset]))
            {
                var start = offset++;
                while (offset < text.Length && char.IsAsciiLetterOrDigit(text[offset])) offset++;
                var span = text.AsSpan(start, offset - start);
                var fullHash = LocalSearchCorpus.HashAscii(span);
                if (!visit(fullHash, true)) return false;
                var expanded = ExpandAscii(span, fullHash, subtokens);
                for (var i = 0; i < expanded; i++)
                    if (!visit(subtokens[i], false)) return false;
            }
            else if (SearchLexicon.IsCjk(text[offset]))
            {
                var start = offset++;
                while (offset < text.Length && SearchLexicon.IsCjk(text[offset])) offset++;
                while (offset - start > MaxCjkSegment)
                    if (!visit(LocalSearchCorpus.HashWord(text.AsSpan(start++, 1)), true)) return false;
                foreach (var (at, width) in SearchLexicon.Segment(text, start, offset))
                {
                    if (!visit(LocalSearchCorpus.HashWord(text.AsSpan(at, width)), true)) return false;
                    for (var relative = 0; relative < width; relative++)
                    {
                        var longest = Math.Min(width - 1, width - relative);
                        for (var part = 2; part <= longest; part++)
                        {
                            var candidate = text.AsSpan(at + relative, part);
                            if (SearchLexicon.IsWord(candidate) && !visit(LocalSearchCorpus.HashWord(candidate), true))
                                return false;
                        }
                    }
                }
            }
            else
            {
                if (!Rune.TryGetRuneAt(text, offset, out var scalar)) scalar = Rune.ReplacementChar;
                offset += scalar.Utf16SequenceLength;
                var unit = (char)scalar.Value;
                if (scalar.Value > 0x20 && !char.IsPunctuation(unit) && !char.IsWhiteSpace(unit) &&
                    !visit(LocalSearchCorpus.HashRune(scalar), true))
                    return false;
            }
        }
        return true;
    }

    internal static int ExpandAscii(ReadOnlySpan<char> token, uint fullHash, Span<uint> destination)
    {
        if (token.Length < 2 || destination.Length == 0) return 0;
        var count = 0;

        var maxPrefix = Math.Min(AsciiMaxPrefixLength, token.Length - 1);
        for (var length = AsciiMinPrefixLength; length <= maxPrefix; length++)
            Add(destination, ref count, fullHash, LocalSearchCorpus.HashAscii(token[..length]));

        var segmentStart = 0;
        for (var i = 1; i <= token.Length; i++)
        {
            if (i < token.Length && !IsSubwordBoundary(token, i)) continue;
            var segmentLength = i - segmentStart;
            if (segmentLength >= 2 && segmentLength < token.Length)
            {
                var segment = token.Slice(segmentStart, segmentLength);
                Add(destination, ref count, fullHash, LocalSearchCorpus.HashAscii(segment));
                var segmentMaxPrefix = Math.Min(AsciiMaxPrefixLength, segmentLength - 1);
                for (var length = AsciiMinPrefixLength; length <= segmentMaxPrefix; length++)
                    Add(destination, ref count, fullHash, LocalSearchCorpus.HashAscii(segment[..length]));
            }
            segmentStart = i;
        }

        return count;

        static void Add(Span<uint> target, ref int written, uint exactHash, uint hash)
        {
            if (hash == exactHash || written >= target.Length) return;
            for (var i = 0; i < written; i++)
                if (target[i] == hash) return;
            target[written++] = hash;
        }
    }

    private static bool IsSubwordBoundary(ReadOnlySpan<char> token, int index)
    {
        var previous = token[index - 1];
        var current = token[index];
        if (char.IsAsciiDigit(previous) != char.IsAsciiDigit(current)) return true;
        if (char.IsAsciiLetterLower(previous) && char.IsAsciiLetterUpper(current)) return true;
        if (char.IsAsciiLetterUpper(previous) && char.IsAsciiLetterUpper(current) &&
            index + 1 < token.Length && char.IsAsciiLetterLower(token[index + 1])) return true;
        return false;
    }

    private static bool IsCompoundIdentifier(ReadOnlySpan<char> query)
    {
        var hasDigit = false;
        var separator = false;
        var inSegment = false;
        foreach (var unit in query)
        {
            if (char.IsAsciiLetterOrDigit(unit))
            {
                hasDigit |= char.IsAsciiDigit(unit);
                inSegment = true;
            }
            else if (inSegment && (unit is '-' or '_'))
            {
                separator = true;
                inSegment = false;
            }
            else return false;
        }
        return hasDigit && separator && inSegment;
    }

    internal static int CountIdentifier(string text, string query, CancellationToken ct)
    {
        var value = text.AsSpan();
        var count = 0;
        for (var start = 0; start <= value.Length - query.Length;)
        {
            ct.ThrowIfCancellationRequested();
            var match = value[start..].IndexOf(query, StringComparison.OrdinalIgnoreCase);
            if (match < 0) break;
            var first = start + match;
            var end = first + query.Length;
            if ((first == 0 || !IdentifierUnit(value[first - 1])) &&
                (end == value.Length || !IdentifierUnit(value[end])) && Ascii.IsValid(value[first..end]))
                count++;
            start = end;
        }
        return count;

        static bool IdentifierUnit(char unit) => char.IsAsciiLetterOrDigit(unit) || unit is '-' or '_';
    }

    internal static int DocumentLength(string body)
    {
        if (body.Length > MaxMeasuredBody) body = body[..MaxMeasuredBody];
        if (body.Contains('[')) body = Link.Replace(body, static match => match.Groups["text"].Value);
        if (body.Contains('<')) body = Tag.Replace(body, "");

        // The production index normalized visible Markdown whitespace and then counted its words.
        var words = 1;
        var inWord = false;
        foreach (var value in body)
        {
            var boundary = char.IsWhiteSpace(value) || value is '`' or '#' or '>' or '*' or '_' or '~' or '-';
            if (!boundary && !inWord) words++;
            inWord = !boundary;
        }
        return words;
    }
}
