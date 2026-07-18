using System.Text.RegularExpressions;

namespace FsusBlog.Server.Infrastructure.Content;

public readonly record struct ReadingEstimate(
    int EffectiveChars,
    int TextChars,
    int CodeChars,
    int ImageCount,
    int Minutes,
    bool ShowLongReadNotice);

public static class ReadingEstimator
{
    public const int LongReadThreshold = 5_000;
    private const int CjkCharsPerMinute = 500;
    private const int LatinWordsPerMinute = 220;
    private const int OtherCharsPerMinute = 500;
    private const int CodeCharsPerMinute = 140;
    private const int ImageSeconds = 12;

    private static readonly Regex s_fencedCodeRegex = new("```[\\s\\S]*?```|~~~[\\s\\S]*?~~~", RegexOptions.Compiled);
    private static readonly Regex s_inlineCodeRegex = new("`[^`\\n]+`", RegexOptions.Compiled);
    private static readonly Regex s_imageRegex = new("!\\[[^\\]]*\\]\\([^)]+\\)", RegexOptions.Compiled);
    private static readonly Regex s_linkRegex = new("\\[([^\\]]+)\\]\\([^)]+\\)", RegexOptions.Compiled);
    private static readonly Regex s_latinWordRegex = new("[A-Za-z]+(?:['-][A-Za-z]+)*", RegexOptions.Compiled);

    public static ReadingEstimate Estimate(string? content)
    {
        string source = content ?? string.Empty;
        int effectiveChars = CountNonWhitespace(source);
        int codeChars = CountCodeChars(source);
        int imageCount = s_imageRegex.Count(source);
        string readableText = StripMarkdownForReading(source);
        int cjkChars = 0;
        int latinChars = 0;
        int latinWords = 0;

        foreach (char ch in readableText)
        {
            if (IsCjkReadingChar(ch))
            {
                cjkChars++;
            }
        }

        foreach (Match match in s_latinWordRegex.Matches(readableText))
        {
            latinWords++;
            latinChars += CountNonWhitespace(match.Value);
        }

        int textChars = CountNonWhitespace(readableText);
        int otherChars = Math.Max(0, textChars - cjkChars - latinChars);
        double readingSeconds =
            cjkChars * 60d / CjkCharsPerMinute
            + latinWords * 60d / LatinWordsPerMinute
            + otherChars * 60d / OtherCharsPerMinute
            + codeChars * 60d / CodeCharsPerMinute
            + imageCount * ImageSeconds;

        return new ReadingEstimate(
            effectiveChars,
            textChars,
            codeChars,
            imageCount,
            Math.Max(1, (int)Math.Ceiling(readingSeconds / 60d)),
            effectiveChars > LongReadThreshold);
    }

    public static int CountEffectiveChars(string? content)
        => CountNonWhitespace(content ?? string.Empty);

    private static int CountCodeChars(string source)
    {
        int count = 0;
        foreach (Match match in s_fencedCodeRegex.Matches(source))
        {
            string value = Regex.Replace(match.Value, "^(```|~~~)[^\\n]*\\n?|\\n?(```|~~~)$", string.Empty);
            count += CountNonWhitespace(value);
        }

        foreach (Match match in s_inlineCodeRegex.Matches(source))
        {
            count += CountNonWhitespace(match.Value[1..^1]);
        }

        return count;
    }

    private static string StripMarkdownForReading(string source)
    {
        string withoutCode = s_fencedCodeRegex.Replace(source, " ");
        withoutCode = s_inlineCodeRegex.Replace(withoutCode, " ");
        withoutCode = s_imageRegex.Replace(withoutCode, " ");
        withoutCode = s_linkRegex.Replace(withoutCode, "$1");
        withoutCode = Regex.Replace(withoutCode, "(^|\\n)\\s{0,3}(#{1,6}|[-*+]|\\d+\\.)\\s+", "$1");
        return Regex.Replace(withoutCode, "[*_~>#|\\[\\]()\\\\-]", string.Empty);
    }

    private static int CountNonWhitespace(string value)
    {
        int count = 0;
        foreach (char ch in value)
        {
            if (!char.IsWhiteSpace(ch))
            {
                count++;
            }
        }

        return count;
    }

    private static bool IsCjkReadingChar(char ch)
        => (ch >= '\u3400' && ch <= '\u9fff')
            || (ch >= '\uf900' && ch <= '\ufaff')
            || (ch >= '\u3040' && ch <= '\u30ff')
            || (ch >= '\uac00' && ch <= '\ud7af');
}
