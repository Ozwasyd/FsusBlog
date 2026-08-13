using Microsoft.Extensions.Primitives;

namespace FsusBlog.Server.Infrastructure.Helpers;

internal static class HttpEntityTagPreconditions
{
    public static bool MatchesIfNoneMatch(StringValues validators, string? selectedRepresentationTag)
    {
        if (!TryParseSelectedTag(
                selectedRepresentationTag,
                out int selectedOpaqueStart,
                out int selectedOpaqueLength)
            || validators.Count == 0)
        {
            return false;
        }

        ReadOnlySpan<char> selectedOpaqueTag =
            selectedRepresentationTag.AsSpan(selectedOpaqueStart, selectedOpaqueLength);
        bool matched = false;
        bool sawWildcard = false;
        int validatorCount = 0;
        for (int i = 0; i < validators.Count; i++)
        {
            ReadOnlySpan<char> value = (validators[i] ?? string.Empty).AsSpan();
            int offset = 0;
            while (true)
            {
                SkipOptionalWhitespace(value, ref offset);
                if (offset == value.Length
                    || !TryReadEntityTag(
                        value,
                        ref offset,
                        allowWildcard: true,
                        out int opaqueStart,
                        out int opaqueLength,
                        out bool wildcard))
                {
                    return false;
                }

                validatorCount++;
                sawWildcard |= wildcard;
                matched |= wildcard
                    || value.Slice(opaqueStart, opaqueLength).SequenceEqual(selectedOpaqueTag);

                SkipOptionalWhitespace(value, ref offset);
                if (offset == value.Length)
                {
                    break;
                }

                if (value[offset] != ',')
                {
                    return false;
                }

                offset++;
                SkipOptionalWhitespace(value, ref offset);
                if (offset == value.Length)
                {
                    return false;
                }
            }
        }

        return matched && (!sawWildcard || validatorCount == 1);
    }

    private static bool TryParseSelectedTag(
        string? value,
        out int opaqueStart,
        out int opaqueLength)
    {
        opaqueStart = 0;
        opaqueLength = 0;
        if (string.IsNullOrWhiteSpace(value))
        {
            return false;
        }

        ReadOnlySpan<char> input = value.AsSpan();
        int offset = 0;
        SkipOptionalWhitespace(input, ref offset);
        if (!TryReadEntityTag(
                input,
                ref offset,
                allowWildcard: false,
                out opaqueStart,
                out opaqueLength,
                out _))
        {
            return false;
        }

        SkipOptionalWhitespace(input, ref offset);
        return offset == input.Length;
    }

    private static bool TryReadEntityTag(
        ReadOnlySpan<char> value,
        ref int offset,
        bool allowWildcard,
        out int opaqueStart,
        out int opaqueLength,
        out bool wildcard)
    {
        opaqueStart = 0;
        opaqueLength = 0;
        wildcard = false;
        if (offset >= value.Length)
        {
            return false;
        }

        if (allowWildcard && value[offset] == '*')
        {
            wildcard = true;
            offset++;
            return true;
        }

        if (value[offset..].StartsWith("W/", StringComparison.Ordinal))
        {
            offset += 2;
        }

        if (offset >= value.Length || value[offset] != '"')
        {
            return false;
        }

        opaqueStart = ++offset;
        while (offset < value.Length && value[offset] != '"')
        {
            if (!IsEntityTagCharacter(value[offset]))
            {
                return false;
            }

            offset++;
        }

        if (offset == value.Length)
        {
            return false;
        }

        opaqueLength = offset - opaqueStart;
        offset++;
        return true;
    }

    private static bool IsEntityTagCharacter(char value)
        => value == '\x21'
            || value is >= '\x23' and <= '\x7E'
            || value is >= '\x80' and <= '\xFF';

    private static void SkipOptionalWhitespace(ReadOnlySpan<char> value, ref int offset)
    {
        while (offset < value.Length && value[offset] is ' ' or '\t')
        {
            offset++;
        }
    }
}
