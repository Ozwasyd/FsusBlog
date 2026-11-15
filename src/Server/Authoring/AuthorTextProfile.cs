using System.Collections.Frozen;
using System.Globalization;
using System.Text;
using FsusBlog.V2.Contracts;

namespace FsusBlog.V2.Server.Authoring;

internal enum AuthorTextField { Any = 0, Title = 1, MarkdownBody = 2 }
internal sealed record AuthorTextClause(AuthorTextField Field, bool Phrase, string[] Terms);
internal sealed record AuthorTextQuery(AuthorTextClause[] Clauses);
internal sealed record AuthorTextLegacyQuery(string[] Terms, bool Phrase);
internal readonly record struct AuthorTextTerm(string Value, int Ordinal, int Start, int End, int ByteStart, int ByteEnd);

/// <summary>Author text profile 1: NFC and Unicode 17 default simple case folding with half-open raw source spans.</summary>
internal static class AuthorTextProfile
{
    internal const int Version = 1;
    internal const int MaxSourceChars = 200_000;
    internal const int MaxTerms = 200_000;
    internal const int MaxTermBytes = 512;
    internal const string CaseFoldingResource = "AuthorSearch.Unicode17.CaseFolding.txt";
    private const int MaxQueryTerms = 8;
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private static readonly FrozenDictionary<int, Rune> SimpleFolds = LoadSimpleFolds();

    internal static AuthorTextLegacyQuery Parse(string raw)
    {
        if (raw.Length > WireLimits.AuthorTextSearchQueryChars || raw.Any(char.IsControl))
            throw InvalidQuery();
        var text = raw.Trim();
        var phrase = text.Length >= 2 && text[0] == '"' && text[^1] == '"';
        if (phrase) text = text[1..^1];
        if (text.Contains('"') || text.Contains('\\'))
            throw InvalidQuery();

        // Each emitted token has one ordinal. Punctuation and whitespace are separators,
        // and phrase queries keep repeated terms and require consecutive ordinals.
        var tokens = Tokenize(text, CancellationToken.None, bareQuery: !phrase).Take(MaxQueryTerms + 1).ToArray();
        if (tokens.Length is 0 or > MaxQueryTerms || tokens.Any(term => ByteCount(term.Value) > MaxTermBytes) ||
            !phrase && tokens.Any(term => text.AsSpan(term.Start, term.End - term.Start) is "AND" or "OR" or "NOT" or "NEAR"))
            throw InvalidQuery();
        var terms = tokens.Select(term => term.Value).ToArray();
        return new(phrase ? terms : terms.Distinct(StringComparer.Ordinal).ToArray(), phrase);
    }

    internal static AuthorTextQuery ParseRanked(string raw)
    {
        if (raw.Length > WireLimits.AuthorTextSearchQueryChars || raw.Any(char.IsControl))
            throw InvalidQuery();
        var named = new HashSet<AuthorTextField>();
        var clauses = new List<AuthorTextClause>();
        var remaining = MaxQueryTerms;
        var offset = 0;
        while (offset < raw.Length)
        {
            if (char.IsWhiteSpace(raw[offset])) { offset++; continue; }
            var field = ReadField(raw, ref offset);
            if (field != AuthorTextField.Any && !named.Add(field)) throw InvalidQuery();
            var phrase = offset < raw.Length && raw[offset] == '"';
            var value = phrase ? ReadPhrase(raw, ref offset) : ReadBare(raw, ref offset);
            var tokens = Tokenize(value, CancellationToken.None, bareQuery: !phrase).Take(remaining + 1).ToArray();
            if (tokens.Length > remaining || tokens.Any(term => ByteCount(term.Value) > MaxTermBytes) ||
                !phrase && tokens.Any(term => value.AsSpan(term.Start, term.End - term.Start) is "AND" or "OR" or "NOT" or "NEAR"))
                throw InvalidQuery();
            if ((phrase || field != AuthorTextField.Any) && tokens.Length == 0) throw InvalidQuery();
            remaining -= tokens.Length;
            var terms = tokens.Select(term => term.Value);
            var operands = (phrase ? terms : terms.Distinct(StringComparer.Ordinal)).ToArray();
            if (operands.Length != 0 && !clauses.Any(clause => clause.Field == field && clause.Phrase == phrase &&
                    clause.Terms.SequenceEqual(operands, StringComparer.Ordinal)))
                clauses.Add(new(field, phrase, operands));
        }
        if (clauses.Count == 0) throw InvalidQuery();
        return new(clauses.ToArray());
    }

    private static AuthorTextField ReadField(string raw, ref int offset)
    {
        var start = offset;
        while (offset < raw.Length && !char.IsWhiteSpace(raw[offset]) && raw[offset] is not (':' or '"')) offset++;
        if (offset == raw.Length || raw[offset] != ':')
        {
            offset = start;
            return AuthorTextField.Any;
        }
        var field = raw.AsSpan(start, offset - start) switch
        {
            "field.title" => AuthorTextField.Title,
            "field.markdown-body" => AuthorTextField.MarkdownBody,
            _ => throw InvalidQuery(),
        };
        offset++;
        return field;
    }

    private static string ReadBare(string raw, ref int offset)
    {
        var start = offset;
        while (offset < raw.Length && !char.IsWhiteSpace(raw[offset]))
        {
            if (raw[offset] is '"' or '\\' or '$') throw InvalidQuery();
            offset++;
        }
        return raw[start..offset];
    }

    private static string ReadPhrase(string raw, ref int offset)
    {
        var phrase = new StringBuilder();
        offset++;
        while (offset < raw.Length)
        {
            var character = raw[offset++];
            if (character == '"')
            {
                if (offset < raw.Length && !char.IsWhiteSpace(raw[offset])) throw InvalidQuery();
                return phrase.ToString();
            }
            if (character == '\\')
            {
                if (offset == raw.Length || raw[offset] is not ('"' or '\\')) throw InvalidQuery();
                character = raw[offset++];
            }
            phrase.Append(character);
        }
        throw InvalidQuery();
    }

    internal static IEnumerable<AuthorTextTerm> Tokenize(string raw, CancellationToken ct) =>
        Tokenize(raw, ct, bareQuery: false);

    private static IEnumerable<AuthorTextTerm> Tokenize(string raw, CancellationToken ct, bool bareQuery)
    {
        ct.ThrowIfCancellationRequested();
        if (raw.Length > MaxSourceChars) throw new ProtocolException("Author search source exceeds its character limit.");
        _ = ByteCount(raw);

        var ordinal = 0;
        var offset = 0;
        var byteOffset = 0;
        var wordStart = -1;
        var wordByteStart = 0;
        while (offset < raw.Length)
        {
            ct.ThrowIfCancellationRequested();
            var width = StringInfo.GetNextTextElementLength(raw.AsSpan(offset));
            var element = raw.AsSpan(offset, width);
            var keycap = IsKeycap(element);
            if (bareQuery && !keycap && IsOperator(raw, offset)) throw InvalidQuery();
            var kind = keycap ? Element.Single : Classify(element);
            var bytes = ByteCount(element);
            if (kind == Element.Word)
            {
                if (wordStart < 0)
                {
                    wordStart = offset;
                    wordByteStart = byteOffset;
                }
            }
            else
            {
                if (wordStart >= 0)
                {
                    yield return Term(wordStart, offset, wordByteStart, byteOffset);
                    wordStart = -1;
                }
                if (kind == Element.Single)
                    yield return Term(offset, offset + width, byteOffset, byteOffset + bytes);
            }
            offset += width;
            byteOffset += bytes;
        }
        if (wordStart >= 0) yield return Term(wordStart, offset, wordByteStart, byteOffset);

        AuthorTextTerm Term(int start, int end, int byteStart, int byteEnd)
        {
            if (ordinal >= MaxTerms) throw new ProtocolException("Author search source exceeds its token limit.");
            return new(NormalizeTerm(raw[start..end]), ordinal++, start, end, byteStart, byteEnd);
        }
    }

    internal static string NormalizeTerm(string raw)
    {
        var canonical = raw.Normalize(NormalizationForm.FormC);
        StringBuilder? folded = null;
        var offset = 0;
        Span<char> scalarText = stackalloc char[2];
        foreach (var source in canonical.EnumerateRunes())
        {
            if (SimpleFolds.TryGetValue(source.Value, out var replacement))
            {
                folded ??= new StringBuilder(canonical.Length).Append(canonical, 0, offset);
                var width = replacement.EncodeToUtf16(scalarText);
                folded.Append(scalarText[..width]);
            }
            else folded?.Append(canonical, offset, source.Utf16SequenceLength);
            offset += source.Utf16SequenceLength;
        }
        return folded?.ToString().Normalize(NormalizationForm.FormC) ?? canonical;
    }

    private static FrozenDictionary<int, Rune> LoadSimpleFolds()
    {
        using var resource = typeof(AuthorTextProfile).Assembly.GetManifestResourceStream(CaseFoldingResource)
            ?? throw new InvalidOperationException("The author search Unicode case folding resource is unavailable.");
        using var reader = new StreamReader(resource, Utf8);
        if (reader.ReadLine() != "# CaseFolding-17.0.0.txt")
            throw new InvalidOperationException("The author search Unicode case folding version does not match.");

        var folds = new Dictionary<int, Rune>();
        while (reader.ReadLine() is { } line)
        {
            var comment = line.IndexOf('#');
            var data = (comment < 0 ? line : line[..comment]).Trim();
            if (data.Length == 0) continue;
            var fields = data.Split(';', StringSplitOptions.TrimEntries);
            if (fields.Length != 4 || fields[3].Length != 0)
                throw new InvalidOperationException("Invalid author search Unicode case folding row.");
            if (fields[1] is "F" or "T") continue;
            if (fields[1] is not ("C" or "S"))
                throw new InvalidOperationException("Invalid author search Unicode case folding status.");
            var original = int.Parse(fields[0], NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture);
            var folded = int.Parse(fields[2], NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture);
            folds.Add(original, new Rune(folded));
        }
        return folds.Count == 1_512 ? folds.ToFrozenDictionary()
            : throw new InvalidOperationException("The author search Unicode case folding data is incomplete.");
    }

    private static bool IsOperator(string expression, int offset)
    {
        var value = expression[offset];
        if (value is ':' or '/' or '|' or '&' or '=' or '*' or '?' or '[' or ']' or '{' or '}' or '(' or ')' or
            '<' or '>' or '^' or '~' or '+') return true;
        return (value is '-' or '!') && (offset == 0 || char.IsWhiteSpace(expression[offset - 1]));
    }

    private enum Element { Separator, Word, Single }

    private static bool IsKeycap(ReadOnlySpan<char> text) =>
        (text.Length == 2 || text.Length == 3 && text[1] == '\ufe0f') &&
        (text[0] is >= '0' and <= '9' or '#' or '*') && text[^1] == '\u20e3';

    private static Element Classify(ReadOnlySpan<char> text)
    {
        Rune.DecodeFromUtf16(text, out var first, out _);
        if (Rune.IsLetter(first) || Rune.IsNumber(first))
            return IsCjk(first.Value) ? Element.Single : Element.Word;
        // Includes pictographs and flags. Explicit emoji presentation also covers four punctuation bases.
        return Rune.GetUnicodeCategory(first) == UnicodeCategory.OtherSymbol ||
            first.Value is >= 0x1f3fb and <= 0x1f3ff ||
            (first.Value is 0x203c or 0x2049 or 0x3030 or 0x303d) && text.Length == 2 && text[1] == '\ufe0f'
            ? Element.Single : Element.Separator;
    }

    private static bool IsCjk(int value) => value is
        >= 0x1100 and <= 0x11ff or >= 0x3040 and <= 0x30ff or >= 0x3130 and <= 0x318f or
        >= 0x31f0 and <= 0x31ff or >= 0x3400 and <= 0x9fff or >= 0xa960 and <= 0xa97f or
        >= 0xac00 and <= 0xd7ff or >= 0xf900 and <= 0xfaff or >= 0xff66 and <= 0xff9f or
        >= 0x1aff0 and <= 0x1b16f or >= 0x20000 and <= 0x2ffff or >= 0x30000 and <= 0x3347f;

    private static int ByteCount(ReadOnlySpan<char> text)
    {
        try { return Utf8.GetByteCount(text); }
        catch (EncoderFallbackException) { throw new ProtocolException("Invalid Unicode in author search text."); }
    }

    private static ProtocolException InvalidQuery() => new("Invalid author search expression.");
}
