using System.Collections.Immutable;
using System.Globalization;
using System.Text;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>A normalized term retains its exact raw grapheme span and logical position.</summary>
public sealed record AuthorSearchToken(int Position, string Term, AuthorSearchSourceRange Source);

/// <summary>
/// The sole author tokenizer consumes raw source and the existing contract registry. It
/// never parses Markdown or borrows the public search dictionary. Normalization cannot
/// move highlights: every output term retains the complete original grapheme span.
/// </summary>
public static class AuthorFullTextSearchTokenizer
{
    public const int MaxSourceCharacters = 1_048_576;
    public const int MaxTokens = 131_072;
    public const string UnicodeCaseFoldingVersion = "17.0.0-default-simple";

    public static ImmutableArray<AuthorSearchToken> Tokenize(
        string rawSource,
        AuthorSearchSourceRange fieldRange,
        string admittedParserVersion,
        string currentDocumentEpoch)
    {
        ArgumentNullException.ThrowIfNull(rawSource);
        if (rawSource.Length > MaxSourceCharacters)
        {
            throw new AuthorSearchContractException("author_search_tokenizer_source_budget_exceeded");
        }
        AuthorFullTextSearchContract.ValidateRange(fieldRange, rawSource,
            admittedParserVersion, currentDocumentEpoch);
        var tokens = ImmutableArray.CreateBuilder<AuthorSearchToken>();
        Scan(rawSource, fieldRange.Utf16Start, fieldRange.Utf16End, Add);
        return tokens.ToImmutable();

        void Add(int start, int end, int byteStart, int byteEnd)
        {
            if (tokens.Count >= MaxTokens)
            {
                throw new AuthorSearchContractException("author_search_tokenizer_token_budget_exceeded");
            }
            tokens.Add(new AuthorSearchToken(tokens.Count,
                Normalize(rawSource.AsSpan(start, end - start)), fieldRange with
                {
                    Utf16Start = start,
                    Utf16End = end,
                    Utf8Start = byteStart,
                    Utf8End = byteEnd
                }));
        }
    }

    /// <summary>
    /// Shares the exact source tokenizer's segmentation/folding for a bounded query
    /// operand. Query input is not a Markdown document and receives no source coordinates.
    /// The separate query owner applies grammar, permission and execution semantics.
    /// </summary>
    public static ImmutableArray<string> TokenizeQueryValue(string rawValue)
    {
        ArgumentNullException.ThrowIfNull(rawValue);
        if (rawValue.Length is <= 0 or > AuthorFullTextSearchContract.MaxQueryCharacters)
        {
            throw new AuthorSearchContractException("author_search_query_budget_invalid");
        }
        _ = AuthorFullTextSearchContract.Digest(rawValue);
        var terms = ImmutableArray.CreateBuilder<string>();
        Scan(rawValue, 0, rawValue.Length, Add);
        return terms.ToImmutable();

        void Add(int start, int end, int byteStart, int byteEnd)
        {
            if (terms.Count >= MaxTokens)
            {
                throw new AuthorSearchContractException("author_search_tokenizer_token_budget_exceeded");
            }
            terms.Add(Normalize(rawValue.AsSpan(start, end - start)));
        }
    }

    private static string Normalize(ReadOnlySpan<char> raw)
    {
        // Compose first: simple folding can change a combining mark (for example
        // Greek ypogegrammeni), so folding raw NFD would break canonical equivalence.
        string canonical = raw.ToString().Normalize(NormalizationForm.FormC);
        var normalized = new StringBuilder(raw.Length);
        foreach (Rune rune in canonical.EnumerateRunes())
        {
            normalized.Append(AuthorFullTextSearchCaseFold.Fold(rune).ToString());
        }
        return normalized.ToString().Normalize(NormalizationForm.FormC);
    }

    private static void Scan(string rawSource, int rangeStart, int rangeEnd, Action<int, int, int, int> emit)
    {
        TextElementEnumerator elements = StringInfo.GetTextElementEnumerator(rawSource);
        int byteOffset = 0;
        int wordStart = -1;
        int wordByteStart = 0;
        int wordEnd = 0;
        int wordByteEnd = 0;
        while (elements.MoveNext())
        {
            int start = elements.ElementIndex;
            string element = elements.GetTextElement();
            int end = start + element.Length;
            int byteStart = byteOffset;
            byteOffset += Encoding.UTF8.GetByteCount(element);
            if (start < rangeStart || end > rangeEnd)
            {
                if (start < rangeEnd && end > rangeStart)
                {
                    throw new AuthorSearchContractException("author_search_field_splits_grapheme");
                }
                continue;
            }
            // Classify a canonical representative while retaining every raw offset.
            // Decomposed Hangul is one grapheme whose first raw scalar is a Jamo.
            Rune scalar = Rune.GetRuneAt(element.Normalize(NormalizationForm.FormC), 0);
            bool independent = IsCjk(scalar.Value) || IsSymbolElement(element, scalar);
            bool word = !independent && IsWord(scalar);
            if (!word && wordStart >= 0)
            {
                emit(wordStart, wordEnd, wordByteStart, wordByteEnd);
                wordStart = -1;
            }
            if (word)
            {
                if (wordStart < 0)
                {
                    wordStart = start;
                    wordByteStart = byteStart;
                }
                wordEnd = end;
                wordByteEnd = byteOffset;
            }
            else if (independent)
            {
                emit(start, end, byteStart, byteOffset);
            }
        }
        if (wordStart >= 0)
        {
            emit(wordStart, wordEnd, wordByteStart, wordByteEnd);
        }
    }

    private static bool IsWord(Rune scalar)
        => Rune.GetUnicodeCategory(scalar) is UnicodeCategory.UppercaseLetter
            or UnicodeCategory.LowercaseLetter or UnicodeCategory.TitlecaseLetter
            or UnicodeCategory.ModifierLetter or UnicodeCategory.OtherLetter
            or UnicodeCategory.DecimalDigitNumber or UnicodeCategory.LetterNumber
            or UnicodeCategory.OtherNumber;

    private static bool IsSymbolElement(string element, Rune scalar)
        => Rune.GetUnicodeCategory(scalar) is UnicodeCategory.OtherSymbol
            or UnicodeCategory.MathSymbol or UnicodeCategory.CurrencySymbol
            or UnicodeCategory.ModifierSymbol
            || element.Contains('\u20E3');

    private static bool IsCjk(int value)
        => value is >= 0x3400 and <= 0x4DBF or >= 0x4E00 and <= 0x9FFF
            or >= 0xF900 and <= 0xFAFF or >= 0x20000 and <= 0x323AF
            or >= 0x3040 and <= 0x30FF or >= 0xAC00 and <= 0xD7AF;
}
