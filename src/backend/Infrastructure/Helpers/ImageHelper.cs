using System.Text.RegularExpressions;

using FsusBlog.Server.Infrastructure.Content;

namespace FsusBlog.Server.Helpers;

/// <summary>
/// Extracts illustration references from Markdown and HTML content.
/// </summary>
public static partial class ImageHelper
{
    public readonly record struct IllustrationReference(string Url, string? AltText);

    /// <summary>
    /// 匹配插图路径的正则 (预编译)
    /// </summary>
    [GeneratedRegex(@"/uploads/illustration/[\w\-\.\(\)\s\[\]]+?\.(?i:jpg|jpeg|png|gif|webp|avif|svg)", RegexOptions.IgnoreCase)]
    private static partial Regex IllustrationRegex();

    [GeneratedRegex(@"!\[(?<alt>[^\]]*)\]\((?<url>/uploads/illustration/[\w\-\.\(\)\s\[\]]+?\.(?i:jpg|jpeg|png|gif|webp|avif|svg))(?:\s+""[^""]*"")?\)", RegexOptions.IgnoreCase)]
    private static partial Regex MarkdownIllustrationRegex();

    /// <summary>
    /// 将 Markdown/HTML 转为摘要纯文本。保留链接文本，移除图片和 fenced code，
    /// 解码 HTML entity，并在句子、单词和 Unicode grapheme 边界安全截断。
    /// </summary>
    public static string StripMarkdown(string content, int maxLength)
        => ArticleSummaryProjection.ToPlainText(content, maxLength);

    public static List<string> ExtractIllustrationUrls(string content)
    {
        if (string.IsNullOrWhiteSpace(content))
            return [];

        var uniquePhysicalPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var span = content.AsSpan();

        foreach (var match in IllustrationRegex().EnumerateMatches(span))
        {
            // Slice the original content instead of materializing Match.Value.
            var matchSpan = span.Slice(match.Index, match.Length).Trim();
            if (matchSpan.IsEmpty)
                continue;

            var relativeSpan = matchSpan.TrimStart('/');

            // 终极优化：一次性计算长度并使用 string.Create 绕过 Path.Combine 的冗余分配
            int len = "wwwroot".Length + 1 + relativeSpan.Length;
            string physicalPath = string.Create(len, relativeSpan, (dst, rel) =>
            {
                "wwwroot".AsSpan().CopyTo(dst);
                dst["wwwroot".Length] = Path.DirectorySeparatorChar;

                // 将 URL 中的 '/' 转换为当前系统对应的物理路径分隔符
                for (int i = 0; i < rel.Length; i++)
                {
                    dst["wwwroot".Length + 1 + i] = rel[i] == '/' ? Path.DirectorySeparatorChar : rel[i];
                }
            });

            uniquePhysicalPaths.Add(physicalPath);
        }

        // 使用 C# 12 集合表达式返回
        return [.. uniquePhysicalPaths];
    }

    public static List<IllustrationReference> ExtractIllustrationReferences(string content)
    {
        if (string.IsNullOrWhiteSpace(content))
            return [];

        var references = new Dictionary<string, IllustrationReference>(StringComparer.OrdinalIgnoreCase);
        ReadOnlySpan<char> span = content.AsSpan();
        foreach (var match in MarkdownIllustrationRegex().EnumerateMatches(span))
        {
            ReadOnlySpan<char> markdown = span.Slice(match.Index, match.Length);
            int altEnd = markdown.IndexOf("](".AsSpan());
            if (altEnd < 2)
            {
                continue;
            }

            var urlMatches = IllustrationRegex().EnumerateMatches(markdown);
            if (!urlMatches.MoveNext())
            {
                continue;
            }

            var urlMatch = urlMatches.Current;
            ReadOnlySpan<char> urlSpan = markdown.Slice(urlMatch.Index, urlMatch.Length).Trim();
            string url = urlSpan.ToString();
            if (url.Length == 0 || references.ContainsKey(url))
            {
                continue;
            }

            ReadOnlySpan<char> altSpan = markdown.Slice(2, altEnd - 2).Trim();
            string alt = altSpan.ToString();
            references[url] = new IllustrationReference(url, alt.Length == 0 ? null : alt);
        }

        foreach (var match in IllustrationRegex().EnumerateMatches(span))
        {
            ReadOnlySpan<char> urlSpan = span.Slice(match.Index, match.Length).Trim();
            string url = urlSpan.ToString();
            if (url.Length > 0 && !references.ContainsKey(url) && !IsInsideUnclosedMarkdownImage(span, match.Index))
            {
                references[url] = new IllustrationReference(url, null);
            }
        }

        return [.. references.Values];
    }

    private static bool IsInsideUnclosedMarkdownImage(ReadOnlySpan<char> source, int urlIndex)
    {
        ReadOnlySpan<char> beforeUrl = source[..urlIndex];
        int opener = beforeUrl.LastIndexOf("](".AsSpan());
        if (opener < 0)
        {
            return false;
        }

        int imageStart = beforeUrl[..opener].LastIndexOf("![".AsSpan());
        if (imageStart < 0)
        {
            return false;
        }

        return beforeUrl[(opener + 2)..].Trim().IsEmpty;
    }

    public static string? GetFirstIllustration(string content)
    {
        if (string.IsNullOrWhiteSpace(content))
            return null;

        // EnumerateMatches avoids materializing a Match object graph before the first result.
        var enumerator = IllustrationRegex().EnumerateMatches(content.AsSpan());
        if (enumerator.MoveNext())
        {
            var match = enumerator.Current;
            return content.AsSpan().Slice(match.Index, match.Length).ToString();
        }

        return null;
    }
}
