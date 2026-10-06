using System.Collections.Immutable;
using System.Globalization;
using System.Text;

namespace FsusBlog.Core.Services.Articles;

public sealed partial class RevisionSourceDiffEngine
{
    private static WordDiffResult CreateWordEdits(
        ReadOnlySpan<byte> baseBytes,
        int baseOffset,
        ReadOnlySpan<byte> compareBytes,
        int compareOffset,
        int remainingTokenBudget,
        MemoryBudget memory,
        CancellationToken cancellationToken)
    {
        using var decoded = memory.Reserve(DecodedWordBytes(baseBytes.Length, compareBytes.Length));
        WordTokenization prepared = PrepareWordTokenization(
            baseBytes, compareBytes, remainingTokenBudget, cancellationToken);
        if (prepared.Status == TokenizationStatus.BudgetExceeded)
        {
            return new WordDiffResult([], prepared.BaseCount + prepared.CompareCount, true);
        }
        if (prepared.Status == TokenizationStatus.InvalidUtf8)
        {
            return new WordDiffResult([], 0, false);
        }
        int tokenCount = prepared.BaseCount + prepared.CompareCount;
        // No token record, substring, list/dictionary or anchor array exists
        // until the complete hunk workspace has passed this admission.
        using var tokens = memory.Reserve(TokenWorkspaceBytes(tokenCount,
            prepared.BaseText.Length + prepared.CompareText.Length));
        TryTokenize(prepared.BaseText, baseOffset, prepared.BaseCount, cancellationToken, out List<TextToken> baseTokens);
        TryTokenize(prepared.CompareText, compareOffset, prepared.CompareCount, cancellationToken, out List<TextToken> compareTokens);

        int prefix = 0;
        while (prefix < baseTokens.Count
            && prefix < compareTokens.Count
            && string.Equals(baseTokens[prefix].Value, compareTokens[prefix].Value, StringComparison.Ordinal))
        {
            prefix++;
        }
        int suffix = 0;
        while (suffix < baseTokens.Count - prefix
            && suffix < compareTokens.Count - prefix
            && string.Equals(
                baseTokens[baseTokens.Count - suffix - 1].Value,
                compareTokens[compareTokens.Count - suffix - 1].Value,
                StringComparison.Ordinal))
        {
            suffix++;
        }
        int baseEnd = baseTokens.Count - suffix;
        int compareEnd = compareTokens.Count - suffix;
        List<(int Base, int Compare)> anchors = UniqueTokenAnchors(
            baseTokens,
            prefix,
            baseEnd,
            compareTokens,
            prefix,
            compareEnd,
            cancellationToken);
        var edits = ImmutableArray.CreateBuilder<RevisionDiffWordEdit>();
        int baseCursor = prefix;
        int compareCursor = prefix;
        foreach ((int baseAnchor, int compareAnchor) in anchors)
        {
            AddWordChange(
                edits,
                baseTokens,
                baseCursor,
                baseAnchor - baseCursor,
                baseOffset + baseBytes.Length,
                compareTokens,
                compareCursor,
                compareAnchor - compareCursor,
                compareOffset + compareBytes.Length);
            baseCursor = baseAnchor + 1;
            compareCursor = compareAnchor + 1;
        }
        AddWordChange(
            edits,
            baseTokens,
            baseCursor,
            baseEnd - baseCursor,
            baseOffset + baseBytes.Length,
            compareTokens,
            compareCursor,
            compareEnd - compareCursor,
            compareOffset + compareBytes.Length);
        // Retained output remains charged while all hunk workspace is still
        // live; disposal only releases the temporary reservation, not its peak.
        memory.Retain(edits.Count * 192L);
        return new WordDiffResult(edits.ToImmutable(), tokenCount, false);
    }

    private static List<(int Base, int Compare)> UniqueTokenAnchors(
        List<TextToken> baseTokens,
        int baseStart,
        int baseEnd,
        List<TextToken> compareTokens,
        int compareStart,
        int compareEnd,
        CancellationToken cancellationToken)
    {
        var baseOccurrences = new Dictionary<string, LineOccurrence>(StringComparer.Ordinal);
        var compareOccurrences = new Dictionary<string, LineOccurrence>(StringComparer.Ordinal);
        CountTokens(baseTokens, baseStart, baseEnd, baseOccurrences, cancellationToken);
        CountTokens(compareTokens, compareStart, compareEnd, compareOccurrences, cancellationToken);
        var candidates = new List<(int Base, int Compare)>();
        foreach ((string value, LineOccurrence left) in baseOccurrences)
        {
            if (left.Count == 1
                && compareOccurrences.TryGetValue(value, out LineOccurrence right)
                && right.Count == 1)
            {
                candidates.Add((left.Index, right.Index));
            }
        }
        candidates.Sort(static (left, right) => left.Base.CompareTo(right.Base));
        return LongestIncreasingSubsequence(candidates);
    }

    private static void CountTokens(
        List<TextToken> tokens,
        int start,
        int end,
        Dictionary<string, LineOccurrence> occurrences,
        CancellationToken cancellationToken)
    {
        for (int index = start; index < end; index++)
        {
            if ((index & 1023) == 0)
            {
                cancellationToken.ThrowIfCancellationRequested();
            }
            string value = tokens[index].Value;
            occurrences[value] = occurrences.TryGetValue(value, out LineOccurrence existing)
                ? existing with
                {
                    Count = existing.Count + 1
                }
                : new LineOccurrence(index, 1);
        }
    }

    private static void AddWordChange(
        ImmutableArray<RevisionDiffWordEdit>.Builder edits,
        List<TextToken> baseTokens,
        int baseStart,
        int baseCount,
        int baseEnd,
        List<TextToken> compareTokens,
        int compareStart,
        int compareCount,
        int compareEnd)
    {
        while (baseCount > 0
            && compareCount > 0
            && string.Equals(
                baseTokens[baseStart].Value,
                compareTokens[compareStart].Value,
                StringComparison.Ordinal))
        {
            baseStart++;
            baseCount--;
            compareStart++;
            compareCount--;
        }
        while (baseCount > 0
            && compareCount > 0
            && string.Equals(
                baseTokens[baseStart + baseCount - 1].Value,
                compareTokens[compareStart + compareCount - 1].Value,
                StringComparison.Ordinal))
        {
            baseCount--;
            compareCount--;
        }
        if (baseCount == 0 && compareCount == 0)
        {
            return;
        }
        RevisionDiffKind kind = baseCount == 0
            ? RevisionDiffKind.Insert
            : compareCount == 0
                ? RevisionDiffKind.Delete
                : RevisionDiffKind.Replace;
        edits.Add(new RevisionDiffWordEdit(
            kind,
            TokenRange(baseTokens, baseStart, baseCount, baseEnd),
            TokenRange(compareTokens, compareStart, compareCount, compareEnd)));
    }

    internal static WordTokenization PrepareWordTokenization(
        ReadOnlySpan<byte> baseBytes,
        ReadOnlySpan<byte> compareBytes,
        int remainingTokenBudget,
        CancellationToken cancellationToken = default)
    {
        string baseText;
        string compareText;
        cancellationToken.ThrowIfCancellationRequested();
        try
        {
            baseText = new UTF8Encoding(false, true).GetString(baseBytes);
        }
        catch (DecoderFallbackException)
        {
            return new WordTokenization(string.Empty, string.Empty, 0, 0, TokenizationStatus.InvalidUtf8);
        }
        int baseCount = CountTextTokens(baseText, remainingTokenBudget, cancellationToken);
        if (baseCount > remainingTokenBudget)
        {
            return new WordTokenization(baseText, string.Empty, baseCount, 0, TokenizationStatus.BudgetExceeded);
        }
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            compareText = new UTF8Encoding(false, true).GetString(compareBytes);
        }
        catch (DecoderFallbackException)
        {
            return new WordTokenization(string.Empty, string.Empty, 0, 0, TokenizationStatus.InvalidUtf8);
        }
        int compareCount = CountTextTokens(compareText, remainingTokenBudget - baseCount, cancellationToken);
        return new WordTokenization(baseText, compareText, baseCount, compareCount,
            compareCount > remainingTokenBudget - baseCount ? TokenizationStatus.BudgetExceeded : TokenizationStatus.Available);
    }

    private static int CountTextTokens(string text, int maxTokenCount, CancellationToken cancellationToken)
    {
        int count = 0;
        int elementCount = 0;
        TextTokenClass previous = default;
        bool hasToken = false;
        for (int index = 0; index < text.Length;)
        {
            if ((elementCount++ & 1023) == 0)
            {
                cancellationToken.ThrowIfCancellationRequested();
            }
            int length = StringInfo.GetNextTextElementLength(text, index);
            TextTokenClass current = Classify(text, index, length);
            if (!hasToken || current != previous || current == TextTokenClass.Symbol)
            {
                if (++count > maxTokenCount)
                {
                    return count;
                }
            }
            hasToken = true;
            previous = current;
            index += length;
        }
        cancellationToken.ThrowIfCancellationRequested();
        return count;
    }

    private static void TryTokenize(
        string text,
        int absoluteOffset,
        int tokenCount,
        CancellationToken cancellationToken,
        out List<TextToken> tokens)
    {
        tokens = new List<TextToken>(tokenCount);
        int byteOffset = absoluteOffset;
        int tokenCharStart = 0;
        int tokenByteOffset = absoluteOffset;
        int tokenByteLength = 0;
        TextTokenClass tokenClass = default;
        bool hasToken = false;
        int elementCount = 0;
        for (int index = 0; index < text.Length;)
        {
            if ((elementCount++ & 1023) == 0)
            {
                cancellationToken.ThrowIfCancellationRequested();
            }
            int length = StringInfo.GetNextTextElementLength(text, index);
            int byteLength = Encoding.UTF8.GetByteCount(text.AsSpan(index, length));
            TextTokenClass currentClass = Classify(text, index, length);
            bool coalesces = hasToken
                && (currentClass is TextTokenClass.Word or TextTokenClass.Whitespace)
                && tokenClass == currentClass;
            if (!coalesces)
            {
                if (hasToken)
                {
                    tokens.Add(new TextToken(text[tokenCharStart..index], tokenByteOffset, tokenByteLength, tokenClass));
                }
                tokenCharStart = index;
                tokenByteOffset = byteOffset;
                tokenByteLength = 0;
                tokenClass = currentClass;
                hasToken = true;
            }
            tokenByteLength += byteLength;
            byteOffset += byteLength;
            index += length;
        }
        cancellationToken.ThrowIfCancellationRequested();
        if (hasToken)
        {
            tokens.Add(new TextToken(text[tokenCharStart..], tokenByteOffset, tokenByteLength, tokenClass));
        }
    }

    private static TextTokenClass Classify(string text, int index, int length)
    {
        bool whitespace = true;
        foreach (char value in text.AsSpan(index, length))
        {
            if (!char.IsWhiteSpace(value))
            {
                whitespace = false;
                break;
            }
        }
        if (whitespace)
        {
            return TextTokenClass.Whitespace;
        }
        UnicodeCategory category = char.GetUnicodeCategory(text, index);
        return category is UnicodeCategory.UppercaseLetter
            or UnicodeCategory.LowercaseLetter
            or UnicodeCategory.TitlecaseLetter
            or UnicodeCategory.ModifierLetter
            or UnicodeCategory.OtherLetter
            or UnicodeCategory.DecimalDigitNumber
            or UnicodeCategory.LetterNumber
            or UnicodeCategory.OtherNumber
            or UnicodeCategory.NonSpacingMark
            or UnicodeCategory.SpacingCombiningMark
            ? TextTokenClass.Word
            : TextTokenClass.Symbol;
    }

}
