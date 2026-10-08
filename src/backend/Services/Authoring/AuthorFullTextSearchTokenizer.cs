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
            if (start < fieldRange.Utf16Start || end > fieldRange.Utf16End)
            {
                if (start < fieldRange.Utf16End && end > fieldRange.Utf16Start)
                {
                    throw new AuthorSearchContractException("author_search_field_splits_grapheme");
                }
                continue;
            }
            Rune scalar = Rune.GetRuneAt(element, 0);
            bool independent = IsCjk(scalar.Value) || IsSymbolElement(element, scalar);
            bool word = !independent && IsWord(scalar);
            if (!word && wordStart >= 0)
            {
                Add(wordStart, wordEnd, wordByteStart, wordByteEnd);
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
                Add(start, end, byteStart, byteOffset);
            }
        }
        if (wordStart >= 0)
        {
            Add(wordStart, wordEnd, wordByteStart, wordByteEnd);
        }
        return tokens.ToImmutable();

        void Add(int start, int end, int byteStart, int byteEnd)
        {
            if (tokens.Count >= MaxTokens)
            {
                throw new AuthorSearchContractException("author_search_tokenizer_token_budget_exceeded");
            }
            var normalized = new StringBuilder(end - start);
            foreach (Rune rune in rawSource.AsSpan(start, end - start).EnumerateRunes())
            {
                normalized.Append(AuthorFullTextSearchCaseFold.Fold(rune).ToString());
            }
            tokens.Add(new AuthorSearchToken(tokens.Count,
                normalized.ToString().Normalize(NormalizationForm.FormC), fieldRange with
                {
                    Utf16Start = start,
                    Utf16End = end,
                    Utf8Start = byteStart,
                    Utf8End = byteEnd
                }));
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
