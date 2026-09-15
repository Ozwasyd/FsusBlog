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
        CancellationToken cancellationToken)
    {
        TokenizationStatus baseStatus = TryTokenize(
            baseBytes,
            baseOffset,
            remainingTokenBudget,
            cancellationToken,
            out List<TextToken>? baseTokens);
        if (baseStatus == TokenizationStatus.BudgetExceeded)
        {
            return new WordDiffResult([], baseTokens.Count, true);
        }
        if (baseStatus == TokenizationStatus.InvalidUtf8)
        {
            return new WordDiffResult([], 0, false);
        }
        TokenizationStatus compareStatus = TryTokenize(
            compareBytes,
            compareOffset,
            remainingTokenBudget - baseTokens.Count,
            cancellationToken,
            out List<TextToken>? compareTokens);
        if (compareStatus == TokenizationStatus.BudgetExceeded)
        {
            return new WordDiffResult([], baseTokens.Count + compareTokens.Count, true);
        }
        if (compareStatus == TokenizationStatus.InvalidUtf8)
        {
            return new WordDiffResult([], 0, false);
        }
        int tokenCount = baseTokens.Count + compareTokens.Count;

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

    private static TokenizationStatus TryTokenize(
        ReadOnlySpan<byte> bytes,
        int absoluteOffset,
        int maxTokenCount,
        CancellationToken cancellationToken,
        out List<TextToken> tokens)
    {
        tokens = [];
        string text;
        try
        {
            text = new UTF8Encoding(false, true).GetString(bytes);
        }
        catch (DecoderFallbackException)
        {
            return TokenizationStatus.InvalidUtf8;
        }
        TextElementEnumerator enumerator = StringInfo.GetTextElementEnumerator(text);
        int byteOffset = absoluteOffset;
        int tokenCharStart = 0;
        int tokenByteOffset = absoluteOffset;
        int tokenByteLength = 0;
        TextTokenClass tokenClass = default;
        bool hasToken = false;
        int elementCount = 0;
        while (enumerator.MoveNext())
        {
            if ((elementCount++ & 1023) == 0)
            {
                cancellationToken.ThrowIfCancellationRequested();
            }
            string value = enumerator.GetTextElement();
            int byteLength = Encoding.UTF8.GetByteCount(value);
            TextTokenClass currentClass = Classify(value);
            bool coalesces = hasToken
                && (currentClass is TextTokenClass.Word or TextTokenClass.Whitespace)
                && tokenClass == currentClass;
            if (!coalesces)
            {
                if (hasToken)
                {
                    if (tokens.Count >= maxTokenCount)
                    {
                        return TokenizationStatus.BudgetExceeded;
                    }
                    tokens.Add(new TextToken(
                        text[tokenCharStart..enumerator.ElementIndex],
                        tokenByteOffset,
                        tokenByteLength,
                        tokenClass));
                }
                tokenCharStart = enumerator.ElementIndex;
                tokenByteOffset = byteOffset;
                tokenByteLength = 0;
                tokenClass = currentClass;
                hasToken = true;
            }
            tokenByteLength += byteLength;
            byteOffset += byteLength;
        }
        cancellationToken.ThrowIfCancellationRequested();
        if (hasToken)
        {
            if (tokens.Count >= maxTokenCount)
            {
                return TokenizationStatus.BudgetExceeded;
            }
            tokens.Add(new TextToken(text[tokenCharStart..], tokenByteOffset, tokenByteLength, tokenClass));
        }
        return TokenizationStatus.Available;
    }

    private static TextTokenClass Classify(string textElement)
    {
        if (textElement.All(char.IsWhiteSpace))
        {
            return TextTokenClass.Whitespace;
        }
        UnicodeCategory category = char.GetUnicodeCategory(textElement, 0);
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
