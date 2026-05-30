using System.Buffers;
using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;

namespace FsusBlog.Server.Helpers;

/// <summary>
/// 博客插图辅助工具：负责从 Markdown 或 HTML 正文中精准提取资源引用
/// 修复日期: 2026-02-23 (引入 EnumerateMatches 流式解析，短路求值消灭 O(N) 扫描，利用 Span 与 string.Create 实现全流程极低分配)
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
    /// 匹配 Markdown 常用标记的正则 (源生成器预编译)
    /// 用于将 Markdown 转换为纯文本摘要
    /// 注：移除了无意义的 RegexOptions.Compiled，消除编译器警告
    /// </summary>
    [GeneratedRegex(@"!\[.*?\]\(.*?\)|\[.*?\]\(.*?\)|<.*?>|#+|\*|_|`|>|---|\n")]
    private static partial Regex MarkdownStripRegex();

    /// <summary>
    /// 高性能 Markdown 内容清除器 (物理级 O(maxLength) 优化)
    /// </summary>
    public static string StripMarkdown(string content, int maxLength)
    {
        if (string.IsNullOrWhiteSpace(content) || maxLength <= 0) return string.Empty;

        var span = content.AsSpan();

        // 缓冲区的最大长度不可能超过原文长度或需要的最大截断长度
        int rentLength = Math.Min(maxLength, content.Length);
        char[] buffer = ArrayPool<char>.Shared.Rent(rentLength);

        try
        {
            int bufferIndex = 0;
            int lastMatchEnd = 0;

            // 核心优化 1：流式扫描。EnumerateMatches 是极其廉价的 ref struct
            foreach (var match in MarkdownStripRegex().EnumerateMatches(span))
            {
                // 核心优化 2：短路求值。如果摘要已达到 maxLength，立即停止后续几十 KB 正文的正则扫描！
                if (bufferIndex >= maxLength) break;

                // 提取两个正则匹配项之间的正常文本
                ReadOnlySpan<char> textBetween = span[lastMatchEnd..match.Index];
                AppendAndCollapseSpaces(textBetween, buffer, ref bufferIndex, maxLength);

                if (bufferIndex >= maxLength) break;

                // 模拟原逻辑 `.Replace(content, " ")`，为被正则剔除的部分补上一个空格
                // 同时模拟 `.Replace("  ", " ")` 确保它不会形成连续空格
                if (bufferIndex > 0 && buffer[bufferIndex - 1] != ' ')
                {
                    buffer[bufferIndex++] = ' ';
                }

                lastMatchEnd = match.Index + match.Length;
            }

            // 追加最后一个匹配项之后的尾部文本（如果还没达到 maxLength）
            if (bufferIndex < maxLength && lastMatchEnd < span.Length)
            {
                ReadOnlySpan<char> textAfter = span[lastMatchEnd..];
                AppendAndCollapseSpaces(textAfter, buffer, ref bufferIndex, maxLength);
            }

            // 清理尾部多余的空格
            while (bufferIndex > 0 && buffer[bufferIndex - 1] == ' ')
            {
                bufferIndex--;
            }

            // 清理头部多余的空格
            int startIndex = 0;
            while (startIndex < bufferIndex && buffer[startIndex] == ' ')
            {
                startIndex++;
            }

            return new string(buffer, startIndex, bufferIndex - startIndex);
        }
        finally
        {
            ArrayPool<char>.Shared.Return(buffer);
        }
    }

    /// <summary>
    /// 内联辅助方法：将源文本追加到缓冲区，并实时将所有类型连续的空白字符折叠为单个标准空格
    /// </summary>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static void AppendAndCollapseSpaces(ReadOnlySpan<char> source, char[] buffer, ref int bufferIndex, int maxLength)
    {
        for (int i = 0; i < source.Length; i++)
        {
            if (bufferIndex >= maxLength) break;

            char c = source[i];
            if (char.IsWhiteSpace(c))
            {
                // 仅当上一个字符不是空格时，才写入空格，实现原地连续空格折叠
                if (bufferIndex > 0 && buffer[bufferIndex - 1] != ' ')
                {
                    buffer[bufferIndex++] = ' ';
                }
            }
            else
            {
                buffer[bufferIndex++] = c;
            }
        }
    }

    public static List<string> ExtractIllustrationUrls(string content)
    {
        if (string.IsNullOrWhiteSpace(content)) return [];

        var uniquePhysicalPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var span = content.AsSpan();

        foreach (var match in IllustrationRegex().EnumerateMatches(span))
        {
            // 彻底消灭原有的 match.Value 分配
            var matchSpan = span.Slice(match.Index, match.Length).Trim();
            if (matchSpan.IsEmpty) continue;

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
        if (string.IsNullOrWhiteSpace(content)) return [];

        var references = new Dictionary<string, IllustrationReference>(StringComparer.OrdinalIgnoreCase);
        foreach (Match match in MarkdownIllustrationRegex().Matches(content))
        {
            string url = match.Groups["url"].Value.Trim();
            if (url.Length == 0 || references.ContainsKey(url))
            {
                continue;
            }

            string alt = match.Groups["alt"].Value.Trim();
            references[url] = new IllustrationReference(url, alt.Length == 0 ? null : alt);
        }

        foreach (Match match in IllustrationRegex().Matches(content))
        {
            string url = match.Value.Trim();
            if (url.Length > 0 && !references.ContainsKey(url))
            {
                references[url] = new IllustrationReference(url, null);
            }
        }

        return [.. references.Values];
    }

    public static string? GetFirstIllustration(string content)
    {
        if (string.IsNullOrWhiteSpace(content)) return null;

        // 核心优化：使用 EnumerateMatches 替代 Match。
        // 如果没有匹配项，它的开销为绝对的 0（没有实例化任何 Match 对象体系）。
        var enumerator = IllustrationRegex().EnumerateMatches(content.AsSpan());
        if (enumerator.MoveNext())
        {
            var match = enumerator.Current;
            return content.AsSpan().Slice(match.Index, match.Length).ToString();
        }

        return null;
    }
}
