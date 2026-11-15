using System.Text;
using System.Text.RegularExpressions;

namespace FsusBlog.V2.Contracts;

internal static class ArticleSearchTokens
{
    private const int MaxCjkSegment = 4096;
    private const int MaxMeasuredBody = 256 * 1024;
    private static readonly Regex Link = new(@"!?\[(?<text>.*?)\]\(.*?\)", RegexOptions.NonBacktracking);
    private static readonly Regex Tag = new(@"<.*?>", RegexOptions.NonBacktracking);

    internal static string NormalizeQuery(string text)
    {
        var normalized = text.Normalize(NormalizationForm.FormKC).AsSpan().Trim();
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
        return trimmed.Length <= WireLimits.SearchQueryChars ? new string(trimmed) : "";
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
