using System.Text.RegularExpressions;
using FsusBlog.Server.Infrastructure.Helpers;

namespace FsusBlog.Server.Infrastructure.Content;

public readonly record struct CommentMarkdownPolicyResult(
    bool IsValid,
    string ReasonCode,
    string PublicMessage,
    string ReviewText);

public static partial class CommentMarkdownPolicy
{
    private const string ImageReasonCode = "comment_markdown_image";
    private const string HtmlReasonCode = "comment_markdown_html";
    private const string UnsafeLinkReasonCode = "comment_markdown_unsafe_link";

    private const string ImageMessage = "评论暂不支持图片 Markdown，请改为文字或链接。";
    private const string HtmlMessage = "评论暂不支持 HTML，请使用 Markdown 文本格式。";
    private const string UnsafeLinkMessage = "评论链接仅支持 http/https 或相对地址。";

    public static CommentMarkdownPolicyResult ValidateForSubmit(string? content)
    {
        string source = (content ?? string.Empty).Trim();
        if (source.Length == 0)
        {
            return Valid(string.Empty);
        }

        Dictionary<string, string> references = CollectReferenceDefinitions(source);
        var reviewParts = new List<string>();
        bool inFence = false;
        char fenceMarker = '\0';

        foreach (string line in SplitLines(source))
        {
            Match fence = MarkdownFenceRegex().Match(line);
            if (fence.Success)
            {
                char marker = fence.Groups[1].Value[0];
                if (!inFence)
                {
                    inFence = true;
                    fenceMarker = marker;
                }
                else if (marker == fenceMarker)
                {
                    inFence = false;
                    fenceMarker = '\0';
                }

                continue;
            }

            if (inFence)
            {
                reviewParts.Add(line);
                continue;
            }

            if (ReferenceDefinitionRegex().IsMatch(line))
            {
                continue;
            }

            CommentMarkdownPolicyResult inline = ReadInlineReviewText(line, references);
            if (!inline.IsValid)
            {
                return inline;
            }

            reviewParts.Add(inline.ReviewText);
        }

        return Valid(NormalizeReviewText(string.Join(' ', reviewParts)));
    }

    private static Dictionary<string, string> CollectReferenceDefinitions(string source)
    {
        var references = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        bool inFence = false;
        char fenceMarker = '\0';

        foreach (string line in SplitLines(source))
        {
            Match fence = MarkdownFenceRegex().Match(line);
            if (fence.Success)
            {
                char marker = fence.Groups[1].Value[0];
                if (!inFence)
                {
                    inFence = true;
                    fenceMarker = marker;
                }
                else if (marker == fenceMarker)
                {
                    inFence = false;
                    fenceMarker = '\0';
                }

                continue;
            }

            if (inFence)
            {
                continue;
            }

            Match match = ReferenceDefinitionRegex().Match(line);
            if (match.Success)
            {
                references[NormalizeReferenceLabel(match.Groups[1].Value)] = ExtractLinkDestination(match.Groups[2].Value);
            }
        }

        return references;
    }

    private static CommentMarkdownPolicyResult ReadInlineReviewText(string line, IReadOnlyDictionary<string, string> references)
    {
        string source = StripLinePrefix(line);
        var output = new System.Text.StringBuilder(source.Length);

        for (int index = 0; index < source.Length; index++)
        {
            char current = source[index];

            if (current == '`')
            {
                int end = source.IndexOf('`', index + 1);
                if (end > index)
                {
                    output.Append(' ').Append(source.AsSpan(index + 1, end - index - 1)).Append(' ');
                    index = end;
                    continue;
                }
            }

            if (source.AsSpan(index).StartsWith("<!--", StringComparison.Ordinal) || LooksLikeRawHtml(source, index))
            {
                return Invalid(HtmlReasonCode, HtmlMessage);
            }

            if (current == '!' && index + 1 < source.Length && source[index + 1] == '[')
            {
                int labelEnd = FindClosingBracket(source, index + 2);
                if (labelEnd > index)
                {
                    int next = SkipHorizontalWhitespace(source, labelEnd + 1);
                    if (next >= source.Length || source[next] is '(' or '[')
                    {
                        return Invalid(ImageReasonCode, ImageMessage);
                    }
                }
            }

            if (current == '[')
            {
                int labelEnd = FindClosingBracket(source, index + 1);
                if (labelEnd > index)
                {
                    string label = source[(index + 1)..labelEnd];
                    int next = SkipHorizontalWhitespace(source, labelEnd + 1);
                    if (next < source.Length && source[next] == '(')
                    {
                        int destinationEnd = FindClosingParen(source, next + 1);
                        if (destinationEnd > next)
                        {
                            string destination = source[(next + 1)..destinationEnd];
                            if (!IsSafeLinkDestination(destination))
                            {
                                return Invalid(UnsafeLinkReasonCode, UnsafeLinkMessage);
                            }

                            AppendLinkReview(output, label, destination);
                            index = destinationEnd;
                            continue;
                        }
                    }
                    else if (next < source.Length && source[next] == '[')
                    {
                        int refEnd = source.IndexOf(']', next + 1);
                        if (refEnd > next)
                        {
                            string referenceLabel = source[(next + 1)..refEnd];
                            if (referenceLabel.Length == 0)
                            {
                                referenceLabel = label;
                            }

                            if (references.TryGetValue(NormalizeReferenceLabel(referenceLabel), out string? destination))
                            {
                                if (!IsSafeLinkDestination(destination))
                                {
                                    return Invalid(UnsafeLinkReasonCode, UnsafeLinkMessage);
                                }

                                AppendLinkReview(output, label, destination);
                                index = refEnd;
                                continue;
                            }
                        }
                    }
                }
            }

            output.Append(IsMarkdownControl(current) ? ' ' : current);
        }

        return Valid(output.ToString());
    }

    private static void AppendLinkReview(System.Text.StringBuilder output, string label, string destination)
    {
        output.Append(' ').Append(label).Append(' ');
        string reviewTarget = BuildLinkReviewTarget(destination);
        if (reviewTarget.Length > 0)
        {
            output.Append(reviewTarget).Append(' ');
        }
    }

    private static bool LooksLikeRawHtml(string source, int start)
    {
        ReadOnlySpan<char> remaining = source.AsSpan(start);
        if (remaining.StartsWith("<!", StringComparison.Ordinal))
        {
            return true;
        }

        if (remaining.Length < 3 || remaining[0] != '<')
        {
            return false;
        }

        int index = remaining[1] == '/' ? 2 : 1;
        if (index >= remaining.Length || !TextHelpers.IsAsciiAlpha(remaining[index]))
        {
            return false;
        }

        index++;
        while (index < remaining.Length && TextHelpers.IsAsciiTokenChar(remaining[index], ":-"))
        {
            index++;
        }

        return index < remaining.Length && (char.IsWhiteSpace(remaining[index]) || remaining[index] is '>' or '/');
    }

    private static bool IsMarkdownControl(char value)
        => value is '*' or '_' or '~' or '>' or '#' or '|';

    private static string StripLinePrefix(string line)
        => OrderedListPrefixRegex().Replace(
            UnorderedListPrefixRegex().Replace(
                QuotePrefixRegex().Replace(
                    HeadingPrefixRegex().Replace(line, string.Empty),
                    string.Empty),
                string.Empty),
            string.Empty);

    private static int FindClosingBracket(string source, int start)
    {
        bool escaped = false;
        for (int index = start; index < source.Length; index++)
        {
            char current = source[index];
            if (escaped)
            {
                escaped = false;
                continue;
            }

            if (current == '\\')
            {
                escaped = true;
                continue;
            }

            if (current == ']')
            {
                return index;
            }
        }

        return -1;
    }

    private static int FindClosingParen(string source, int start)
    {
        bool escaped = false;
        int depth = 0;
        for (int index = start; index < source.Length; index++)
        {
            char current = source[index];
            if (escaped)
            {
                escaped = false;
                continue;
            }

            if (current == '\\')
            {
                escaped = true;
                continue;
            }

            if (current == '(')
            {
                depth++;
                continue;
            }

            if (current == ')')
            {
                if (depth == 0)
                {
                    return index;
                }

                depth--;
            }
        }

        return -1;
    }

    private static int SkipHorizontalWhitespace(string source, int start)
    {
        int index = start;
        while (index < source.Length && source[index] is ' ' or '\t')
        {
            index++;
        }

        return index;
    }

    private static bool IsSafeLinkDestination(string rawDestination)
    {
        string destination = NormalizeUrlForPolicy(ExtractLinkDestination(rawDestination));
        if (destination.Length == 0 ||
            destination.StartsWith('#') ||
            destination.StartsWith('/') ||
            destination.StartsWith("./", StringComparison.Ordinal) ||
            destination.StartsWith("../", StringComparison.Ordinal))
        {
            return true;
        }

        if (Uri.TryCreate(destination, UriKind.Absolute, out Uri? absolute))
        {
            return IsHttpScheme(absolute);
        }

        return !SchemePrefixRegex().IsMatch(destination);
    }

    private static string BuildLinkReviewTarget(string rawDestination)
    {
        string destination = NormalizeUrlForPolicy(ExtractLinkDestination(rawDestination));
        if (destination.Length == 0)
        {
            return string.Empty;
        }

        if (Uri.TryCreate(destination, UriKind.Absolute, out Uri? absolute))
        {
            if (IsHttpScheme(absolute))
            {
                return absolute.Host + (absolute.AbsolutePath == "/" ? string.Empty : absolute.AbsolutePath);
            }

            return string.Empty;
        }

        int queryIndex = destination.IndexOfAny(['?', '#']);
        return queryIndex >= 0 ? destination[..queryIndex] : destination;
    }

    private static string ExtractLinkDestination(string rawDestination)
    {
        string value = rawDestination.Trim();
        if (value.StartsWith('<'))
        {
            int end = value.IndexOf('>');
            return end > 0 ? value[1..end].Trim() : value[1..].Trim();
        }

        int whitespace = value.AsSpan().IndexOfAny([' ', '\t', '\r', '\n']);
        return whitespace >= 0 ? value[..whitespace].Trim() : value;
    }

    private static string NormalizeUrlForPolicy(string value)
    {
        Span<char> buffer = stackalloc char[value.Length];
        int count = 0;
        foreach (char current in value.Trim())
        {
            if (!char.IsControl(current) && !char.IsWhiteSpace(current))
            {
                buffer[count++] = current;
            }
        }

        return new string(buffer[..count]);
    }

    private static bool IsHttpScheme(Uri uri)
        => string.Equals(uri.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase) ||
            string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase);

    private static string NormalizeReferenceLabel(string label)
        => Regex.Replace(label.Trim(), @"\s+", " ").ToLowerInvariant();

    private static IEnumerable<string> SplitLines(string source)
        => source.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n').Split('\n');

    private static string NormalizeReviewText(string value)
        => Regex.Replace(value, @"\s+", " ").Trim();

    private static CommentMarkdownPolicyResult Valid(string reviewText)
        => new(true, "ok", string.Empty, NormalizeReviewText(reviewText));

    private static CommentMarkdownPolicyResult Invalid(string reasonCode, string publicMessage)
        => new(false, reasonCode, publicMessage, string.Empty);

    [GeneratedRegex(@"^\s{0,3}(`{3,}|~{3,})")]
    private static partial Regex MarkdownFenceRegex();

    [GeneratedRegex(@"^\s{0,3}\[([^\]]+)\]:\s*(\S[^\n]*)$")]
    private static partial Regex ReferenceDefinitionRegex();

    [GeneratedRegex(@"^\s{0,3}#{1,6}\s+")]
    private static partial Regex HeadingPrefixRegex();

    [GeneratedRegex(@"^\s{0,3}>\s?")]
    private static partial Regex QuotePrefixRegex();

    [GeneratedRegex(@"^\s{0,3}[-*+]\s+")]
    private static partial Regex UnorderedListPrefixRegex();

    [GeneratedRegex(@"^\s{0,3}\d+[.)]\s+")]
    private static partial Regex OrderedListPrefixRegex();

    [GeneratedRegex(@"^[A-Za-z][A-Za-z0-9+.-]*:")]
    private static partial Regex SchemePrefixRegex();
}
