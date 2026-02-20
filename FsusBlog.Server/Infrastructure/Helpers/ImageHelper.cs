using System.Text.RegularExpressions;

namespace FsusBlog.Server.Helpers;

/// <summary>
/// 博客插图辅助工具：负责从 Markdown 或 HTML 正文中精准提取资源引用
/// </summary>
public static partial class ImageHelper
{
    /// <summary>
    /// 匹配插图路径的正则 (预编译)
    /// </summary>
    [GeneratedRegex(@"/uploads/illustration/[\w\-\.\(\)\s\[\]]+?\.(?i:jpg|jpeg|png|gif|webp|avif|svg)", RegexOptions.IgnoreCase)]
    private static partial Regex IllustrationRegex();

    /// <summary>
    /// 匹配 Markdown 常用标记的正则 (预编译)
    /// 用于将 Markdown 转换为纯文本摘要
    /// 匹配范围：链接、图片、标题符、粗体、斜体、代码块、引用、分割线
    /// </summary>
    [GeneratedRegex(@"!\[.*?\]\(.*?\)|\[.*?\]\(.*?\)|<.*?>|#+|\*|_|`|>|---|\n", RegexOptions.Compiled)]
    private static partial Regex MarkdownStripRegex();

    /// <summary>
    /// 高性能 Markdown 内容清除器
    /// </summary>
    /// <param name="content">原始 Markdown 内容</param>
    /// <param name="maxLength">截取的最大长度</param>
    /// <returns>清洗后的纯文本</returns>
    public static string StripMarkdown(string content, int maxLength)
    {
        if (string.IsNullOrWhiteSpace(content)) return string.Empty;

        // 1. 使用预编译正则移除所有标记
        string plainText = MarkdownStripRegex().Replace(content, " ");

        // 2. 清理多余空格并截断
        plainText = plainText.Replace("  ", " ").Trim();

        return plainText.Length > maxLength
            ? plainText[..maxLength]
            : plainText;
    }

    public static List<string> ExtractIllustrationUrls(string content)
    {
        if (string.IsNullOrWhiteSpace(content)) return [];

        var uniquePhysicalPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var matches = IllustrationRegex().Matches(content);

        foreach (Match match in matches)
        {
            var webPath = match.Value.Trim();
            if (!string.IsNullOrEmpty(webPath))
            {
                var relativePath = webPath.TrimStart('/');
                var physicalPath = Path.Combine("wwwroot", relativePath);
                uniquePhysicalPaths.Add(physicalPath);
            }
        }

        return [.. uniquePhysicalPaths];
    }

    public static string? GetFirstIllustration(string content)
    {
        if (string.IsNullOrWhiteSpace(content)) return null;
        var match = IllustrationRegex().Match(content);
        return match.Success ? match.Value : null;
    }
}
