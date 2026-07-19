using System.Globalization;
using System.Net;
using System.Text.RegularExpressions;

namespace FsusBlog.Server.Infrastructure.Content;

public readonly record struct ArticleSummaryProjectionResult(
    string Text,
    string? GenerationVersion)
{
    public bool IsGenerated => GenerationVersion is not null;
}

/// <summary>
/// Authoritative Markdown-to-plain-text projection used by generated article summaries and
/// every fallback consumer. Manual summaries are returned unchanged apart from outer whitespace.
/// </summary>
public static partial class ArticleSummaryProjection
{
    public const string CurrentGenerationVersion = "plain-text-v1";
    public const int DefaultMaxGraphemes = 200;
    public const int StoredSummaryMaxUtf16Length = 512;
    public const string RevisionMarkerPrefix = "[summary:auto:";

    [GeneratedRegex(@"(?s)(?:```.*?```|~~~.*?~~~)")]
    private static partial Regex FencedCodeRegex();

    [GeneratedRegex(@"(?s)\A---[\t ]*\r?\n.*?\r?\n---[\t ]*(?:\r?\n|$)")]
    private static partial Regex FrontMatterRegex();

    [GeneratedRegex(@"(?m)^(?: {4}|\t).*$")]
    private static partial Regex IndentedCodeRegex();

    [GeneratedRegex(@"(?is)<(?:script|style)\b[^>]*>.*?</(?:script|style)\s*>")]
    private static partial Regex NonContentHtmlRegex();

    [GeneratedRegex(@"(?s)<!--.*?-->")]
    private static partial Regex HtmlCommentRegex();

    [GeneratedRegex(@"!\[[^\]]*\]\([^)]*\)|!\[[^\]]*\]\[[^\]]*\]")]
    private static partial Regex MarkdownImageRegex();

    [GeneratedRegex(@"\[([^\]]+)\]\([^)]*\)|\[([^\]]+)\]\[[^\]]*\]")]
    private static partial Regex MarkdownLinkRegex();

    [GeneratedRegex(@"(?m)^[\t ]{0,3}\[[^\]]+\]:\s*\S+.*$")]
    private static partial Regex LinkDefinitionRegex();

    [GeneratedRegex(@"(?i)<(?:(?:https?|ftp)://|mailto:)[^>]+>")]
    private static partial Regex AutolinkRegex();

    [GeneratedRegex(@"(?i)\b(?:https?|ftp)://[a-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+")]
    private static partial Regex BareUrlRegex();

    [GeneratedRegex(@"<[^>]+>")]
    private static partial Regex HtmlTagRegex();

    [GeneratedRegex(@"(?m)^[\t ]{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])[\t ]+|[*_~`]+|[|]")]
    private static partial Regex MarkdownSyntaxRegex();

    [GeneratedRegex(@"(?m)^[\t ]*(?:=+|-+)[\t ]*$")]
    private static partial Regex SetextUnderlineRegex();

    [GeneratedRegex(@"\s+")]
    private static partial Regex WhitespaceRegex();

    public static ArticleSummaryProjectionResult Resolve(
        string? manualSummary,
        string? markdown,
        int maxGraphemes = DefaultMaxGraphemes)
    {
        if (!string.IsNullOrWhiteSpace(manualSummary))
        {
            return new ArticleSummaryProjectionResult(manualSummary.Trim(), null);
        }

        return new ArticleSummaryProjectionResult(
            ToPlainText(markdown, maxGraphemes, StoredSummaryMaxUtf16Length),
            CurrentGenerationVersion);
    }

    public static string ToPlainText(string? markdown, int maxGraphemes)
        => ToPlainText(markdown, maxGraphemes, int.MaxValue);

    private static string ToPlainText(string? markdown, int maxGraphemes, int maxUtf16Length)
    {
        if (string.IsNullOrWhiteSpace(markdown) || maxGraphemes <= 0)
        {
            return string.Empty;
        }

        string plain = FrontMatterRegex().Replace(markdown, " ");
        plain = FencedCodeRegex().Replace(plain, " ");
        plain = IndentedCodeRegex().Replace(plain, " ");
        plain = NonContentHtmlRegex().Replace(plain, " ");
        plain = HtmlCommentRegex().Replace(plain, " ");
        plain = MarkdownImageRegex().Replace(plain, " ");
        plain = MarkdownLinkRegex().Replace(plain, static match =>
            match.Groups[1].Success ? match.Groups[1].Value : match.Groups[2].Value);
        plain = LinkDefinitionRegex().Replace(plain, " ");
        plain = AutolinkRegex().Replace(plain, " ");
        plain = BareUrlRegex().Replace(plain, " ");
        plain = WebUtility.HtmlDecode(plain);
        plain = HtmlTagRegex().Replace(plain, " ");
        plain = SetextUnderlineRegex().Replace(plain, " ");
        plain = MarkdownSyntaxRegex().Replace(plain, string.Empty);
        plain = WhitespaceRegex().Replace(plain, " ").Trim();

        return TruncateAtGraphemeBoundary(plain, maxGraphemes, maxUtf16Length);
    }

    public static string AttachGenerationVersion(
        string revisionDescription,
        ArticleSummaryProjectionResult projection)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(revisionDescription);
        return projection.IsGenerated
            ? $"{revisionDescription.Trim()} {RevisionMarkerPrefix}{projection.GenerationVersion}]"
            : revisionDescription.Trim();
    }

    public static bool WasAutomaticallyGenerated(string? revisionDescription)
        => !string.IsNullOrWhiteSpace(revisionDescription)
            && revisionDescription.Contains(RevisionMarkerPrefix, StringComparison.Ordinal);

    private static string TruncateAtGraphemeBoundary(
        string plain,
        int maxGraphemes,
        int maxUtf16Length)
    {
        int[] boundaries = StringInfo.ParseCombiningCharacters(plain);
        if (boundaries.Length <= maxGraphemes && plain.Length <= maxUtf16Length)
        {
            return plain;
        }

        if (maxGraphemes == 1 || maxUtf16Length == 1)
        {
            return "…";
        }

        int contentBudget = Math.Max(1, maxGraphemes - 1);
        int utf16Budget = Math.Max(1, maxUtf16Length - 1);
        int selectedGraphemes = 0;
        while (selectedGraphemes < boundaries.Length
            && selectedGraphemes < contentBudget)
        {
            int end = selectedGraphemes + 1 < boundaries.Length
                ? boundaries[selectedGraphemes + 1]
                : plain.Length;
            if (end > utf16Budget)
            {
                break;
            }

            selectedGraphemes++;
        }

        if (selectedGraphemes == 0)
        {
            return "…";
        }

        int limit = selectedGraphemes < boundaries.Length
            ? boundaries[selectedGraphemes]
            : plain.Length;
        int sentenceEnd = plain.LastIndexOfAny(['。', '！', '？', '.', '!', '?', '；', ';'], limit - 1, limit);
        if (sentenceEnd >= limit / 2)
        {
            return plain[..(sentenceEnd + 1)].TrimEnd();
        }

        int wordBoundary = plain.LastIndexOf(' ', limit - 1, limit);
        if (wordBoundary >= limit / 2)
        {
            limit = wordBoundary;
        }

        return string.Concat(plain.AsSpan(0, limit).TrimEnd(), "…");
    }
}
