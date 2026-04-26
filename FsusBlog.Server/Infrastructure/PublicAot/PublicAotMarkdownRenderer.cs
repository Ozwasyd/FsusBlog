using System.Net;
using System.Text;
using System.Text.RegularExpressions;

namespace FsusBlog.Server.Infrastructure.PublicAot;

internal static class PublicAotMarkdownRenderer
{
    private static readonly Regex OrderedListRegex = new(@"^\d+\.\s+", RegexOptions.Compiled);
    private static readonly Regex HorizontalRuleRegex = new(@"^\s{0,3}([-*_])(\s*\1){2,}\s*$", RegexOptions.Compiled);
    private static readonly Regex TableSeparatorRegex = new(@"^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$", RegexOptions.Compiled);

    internal static string BuildMarkdownShellHost(string rawContent)
    {
        return $"""
<div class="markdown-body markdown-renderer__body prose prose-zinc max-w-none subpixel-antialiased whitespace-pre-wrap" role="article" aria-live="polite" data-markdown-renderer="wasm">{Encode(rawContent)}</div>
""";
    }

    internal static string BuildHydrationMarkdownShellHost(string renderedHtml)
    {
        return $"""
<div class="markdown-body prose prose-zinc max-w-none subpixel-antialiased whitespace-pre-wrap"><div class="markdown-renderer__root markdown-renderer__body" role="article" aria-live="polite" data-markdown-renderer="wasm">{renderedHtml}</div></div>
""";
    }

    internal static string RenderArticleDetailMarkdownHtml(string raw)
    {
        string source = NormalizeMarkdownSource(raw);
        if (string.IsNullOrWhiteSpace(source))
        {
            return string.Empty;
        }

        string[] lines = source.Split('\n');
        var html = new StringBuilder(source.Length + 256);
        int index = 0;

        while (index < lines.Length)
        {
            string line = lines[index];
            string trimmed = line.Trim();
            if (string.IsNullOrWhiteSpace(trimmed))
            {
                index++;
                continue;
            }

            if (TryParseFenceStart(trimmed, out string fence, out string language))
            {
                index++;
                var codeLines = new List<string>();
                while (index < lines.Length && !lines[index].TrimStart().StartsWith(fence, StringComparison.Ordinal))
                {
                    codeLines.Add(lines[index]);
                    index++;
                }
                if (index < lines.Length)
                {
                    index++;
                }

                string code = string.Join('\n', codeLines);
                if (string.Equals(language, "mermaid", StringComparison.OrdinalIgnoreCase))
                {
                    html.Append("<figure class=\"markdown-renderer__mermaid\" data-mermaid-placeholder=\"true\"><figcaption class=\"markdown-renderer__placeholder-title\">Mermaid 图表将在交互层激活</figcaption><pre class=\"shiki\"><code class=\"language-mermaid\">")
                        .Append(Encode(code))
                        .Append("</code></pre></figure>");
                }
                else
                {
                    html.Append("<pre class=\"shiki\"><code");
                    if (!string.IsNullOrWhiteSpace(language))
                    {
                        html.Append(" class=\"language-").Append(Encode(language)).Append('"');
                    }
                    html.Append('>').Append(Encode(code)).Append("</code></pre>");
                }
                continue;
            }

            if (trimmed.Equals(":::mermaid", StringComparison.OrdinalIgnoreCase))
            {
                index++;
                var mermaidLines = new List<string>();
                while (index < lines.Length && !lines[index].Trim().Equals(":::", StringComparison.Ordinal))
                {
                    mermaidLines.Add(lines[index]);
                    index++;
                }
                if (index < lines.Length)
                {
                    index++;
                }

                string graph = string.Join('\n', mermaidLines);
                html.Append("<figure class=\"markdown-renderer__mermaid\" data-mermaid-placeholder=\"true\"><figcaption class=\"markdown-renderer__placeholder-title\">Mermaid 图表将在交互层激活</figcaption><pre class=\"shiki\"><code class=\"language-mermaid\">")
                    .Append(Encode(graph))
                    .Append("</code></pre></figure>");
                continue;
            }

            if (trimmed == "$$")
            {
                index++;
                var latexLines = new List<string>();
                while (index < lines.Length && lines[index].Trim() != "$$")
                {
                    latexLines.Add(lines[index]);
                    index++;
                }
                if (index < lines.Length)
                {
                    index++;
                }

                string math = string.Join('\n', latexLines);
                html.Append("<div class=\"markdown-renderer__latex\" data-latex-placeholder=\"true\"><p class=\"markdown-renderer__placeholder-title\">LaTeX 公式将在交互层激活</p><pre class=\"shiki\"><code class=\"language-latex\">")
                    .Append(Encode(math))
                    .Append("</code></pre></div>");
                continue;
            }

            int headingLevel = CountHeadingLevel(trimmed);
            if (headingLevel > 0)
            {
                string headingText = trimmed[(headingLevel + 1)..].Trim();
                html.Append("<h").Append(headingLevel).Append('>').Append(RenderInlineMarkdown(headingText)).Append("</h").Append(headingLevel).Append('>');
                index++;
                continue;
            }

            if (HorizontalRuleRegex.IsMatch(trimmed))
            {
                html.Append("<hr />");
                index++;
                continue;
            }

            if (trimmed.StartsWith('>'))
            {
                html.Append("<blockquote>");
                while (index < lines.Length)
                {
                    string quoteLine = lines[index].TrimStart();
                    if (!quoteLine.StartsWith('>'))
                    {
                        break;
                    }

                    string quote = quoteLine[1..].TrimStart();
                    if (!string.IsNullOrWhiteSpace(quote))
                    {
                        html.Append("<p>").Append(RenderInlineMarkdown(quote)).Append("</p>");
                    }
                    index++;
                }
                html.Append("</blockquote>");
                continue;
            }

            if (IsListItem(trimmed, out bool ordered, out string item))
            {
                html.Append(ordered ? "<ol>" : "<ul>");
                html.Append("<li><p>").Append(RenderInlineMarkdown(item)).Append("</p></li>");
                index++;

                while (index < lines.Length && IsListItem(lines[index].Trim(), out bool nextOrdered, out string nextItem) && nextOrdered == ordered)
                {
                    html.Append("<li><p>").Append(RenderInlineMarkdown(nextItem)).Append("</p></li>");
                    index++;
                }

                html.Append(ordered ? "</ol>" : "</ul>");
                continue;
            }

            if (LooksLikeTableHeader(trimmed, index, lines))
            {
                string[] headers = SplitTableCells(trimmed);
                string[] alignments = SplitTableCells(lines[index + 1].Trim());
                index += 2;

                html.Append("<table><thead><tr>");
                for (int i = 0; i < headers.Length; i++)
                {
                    string align = i < alignments.Length ? ResolveTableAlign(alignments[i]) : string.Empty;
                    html.Append("<th");
                    if (!string.IsNullOrEmpty(align))
                    {
                        html.Append(" style=\"text-align: ").Append(align).Append('"');
                    }
                    html.Append('>').Append(RenderInlineMarkdown(headers[i])).Append("</th>");
                }
                html.Append("</tr></thead><tbody>");

                while (index < lines.Length && lines[index].Contains('|', StringComparison.Ordinal))
                {
                    string rowLine = lines[index].Trim();
                    if (string.IsNullOrWhiteSpace(rowLine))
                    {
                        break;
                    }

                    string[] cells = SplitTableCells(rowLine);
                    html.Append("<tr>");
                    for (int i = 0; i < headers.Length; i++)
                    {
                        string cell = i < cells.Length ? cells[i] : string.Empty;
                        string align = i < alignments.Length ? ResolveTableAlign(alignments[i]) : string.Empty;
                        html.Append("<td");
                        if (!string.IsNullOrEmpty(align))
                        {
                            html.Append(" style=\"text-align: ").Append(align).Append('"');
                        }
                        html.Append('>').Append(RenderInlineMarkdown(cell)).Append("</td>");
                    }
                    html.Append("</tr>");
                    index++;
                }
                html.Append("</tbody></table>");
                continue;
            }

            var paragraph = new List<string>();
            while (index < lines.Length && !string.IsNullOrWhiteSpace(lines[index].Trim()) && !IsMarkdownBlockStart(lines, index))
            {
                paragraph.Add(lines[index].Trim());
                index++;
            }

            if (paragraph.Count > 0)
            {
                html.Append("<p>").Append(RenderInlineMarkdown(string.Join(' ', paragraph))).Append("</p>");
            }
            else
            {
                index++;
            }
        }

        return html.ToString();
    }

    private static string NormalizeMarkdownSource(string input)
        => (input ?? string.Empty).Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n');

    private static bool TryParseFenceStart(string trimmed, out string fence, out string language)
    {
        fence = string.Empty;
        language = string.Empty;

        if (!(trimmed.StartsWith("```", StringComparison.Ordinal) || trimmed.StartsWith("~~~", StringComparison.Ordinal)))
        {
            return false;
        }

        fence = trimmed[..3];
        language = trimmed.Length > 3 ? trimmed[3..].Trim() : string.Empty;
        return true;
    }

    private static int CountHeadingLevel(string trimmed)
    {
        if (trimmed.Length < 2 || trimmed[0] != '#')
        {
            return 0;
        }

        int level = 0;
        while (level < trimmed.Length && trimmed[level] == '#')
        {
            level++;
        }

        return level is >= 1 and <= 6 && level < trimmed.Length && trimmed[level] == ' ' ? level : 0;
    }

    private static bool IsListItem(string trimmed, out bool ordered, out string content)
    {
        ordered = false;
        content = string.Empty;
        if (string.IsNullOrWhiteSpace(trimmed))
        {
            return false;
        }

        if (trimmed.StartsWith("- ", StringComparison.Ordinal) || trimmed.StartsWith("* ", StringComparison.Ordinal) || trimmed.StartsWith("+ ", StringComparison.Ordinal))
        {
            content = trimmed[2..].Trim();
            return true;
        }

        if (!OrderedListRegex.IsMatch(trimmed))
        {
            return false;
        }

        int dot = trimmed.IndexOf('.', StringComparison.Ordinal);
        if (dot < 0)
        {
            return false;
        }

        ordered = true;
        content = trimmed[(dot + 1)..].Trim();
        return true;
    }

    private static bool LooksLikeTableHeader(string trimmed, int index, string[] lines)
        => index + 1 < lines.Length
           && trimmed.Contains('|', StringComparison.Ordinal)
           && TableSeparatorRegex.IsMatch(lines[index + 1].Trim());

    private static string[] SplitTableCells(string row)
    {
        string normalized = row.Trim();
        if (normalized.StartsWith('|'))
        {
            normalized = normalized[1..];
        }

        if (normalized.EndsWith('|'))
        {
            normalized = normalized[..^1];
        }

        string[] cells = normalized.Split('|');
        for (int i = 0; i < cells.Length; i++)
        {
            cells[i] = cells[i].Trim();
        }
        return cells;
    }

    private static string ResolveTableAlign(string marker)
    {
        string value = marker.Trim();
        bool left = value.StartsWith(':');
        bool right = value.EndsWith(':');
        if (left && right)
        {
            return "center";
        }

        if (right)
        {
            return "right";
        }

        return left ? "left" : string.Empty;
    }

    private static bool IsMarkdownBlockStart(string[] lines, int index)
    {
        if (index < 0 || index >= lines.Length)
        {
            return false;
        }

        string trimmed = lines[index].Trim();
        return TryParseFenceStart(trimmed, out _, out _)
               || trimmed.Equals(":::mermaid", StringComparison.OrdinalIgnoreCase)
               || trimmed == "$$"
               || CountHeadingLevel(trimmed) > 0
               || HorizontalRuleRegex.IsMatch(trimmed)
               || trimmed.StartsWith('>')
               || IsListItem(trimmed, out _, out _)
               || LooksLikeTableHeader(trimmed, index, lines);
    }

    private static string RenderInlineMarkdown(string input)
    {
        if (string.IsNullOrEmpty(input))
        {
            return string.Empty;
        }

        var output = new StringBuilder(input.Length + 32);
        int index = 0;

        while (index < input.Length)
        {
            if (index + 1 < input.Length && input[index] == '\\' && input[index + 1] == '(')
            {
                int close = input.IndexOf(@"\)", index + 2, StringComparison.Ordinal);
                if (close > index)
                {
                    string formula = input[(index + 2)..close];
                    output.Append("<span class=\"markdown-renderer__latex\" data-latex-placeholder=\"true\"><span class=\"markdown-renderer__placeholder-title\">LaTeX 公式将在交互层激活</span><code class=\"language-latex\">")
                        .Append(Encode(formula))
                        .Append("</code></span>");
                    index = close + 2;
                    continue;
                }
            }

            if (input[index] == '`')
            {
                int close = input.IndexOf('`', index + 1);
                if (close > index)
                {
                    output.Append("<code>").Append(Encode(input[(index + 1)..close])).Append("</code>");
                    index = close + 1;
                    continue;
                }
            }

            if (index + 2 < input.Length && input[index] == '!' && input[index + 1] == '[')
            {
                int labelEnd = input.IndexOf(']', index + 2);
                int urlStart = labelEnd >= 0 && labelEnd + 1 < input.Length && input[labelEnd + 1] == '(' ? labelEnd + 2 : -1;
                int urlEnd = urlStart > 0 ? input.IndexOf(')', urlStart) : -1;
                if (labelEnd > index && urlEnd > urlStart)
                {
                    string alt = input[(index + 2)..labelEnd];
                    string url = input[urlStart..urlEnd];
                    output.Append("<img loading=\"lazy\" decoding=\"async\" referrerpolicy=\"no-referrer\" src=\"")
                        .Append(Encode(ResolveSafeUrl(url)))
                        .Append("\" alt=\"")
                        .Append(Encode(alt))
                        .Append("\" />");
                    index = urlEnd + 1;
                    continue;
                }
            }

            if (input[index] == '[')
            {
                int labelEnd = input.IndexOf(']', index + 1);
                int urlStart = labelEnd >= 0 && labelEnd + 1 < input.Length && input[labelEnd + 1] == '(' ? labelEnd + 2 : -1;
                int urlEnd = urlStart > 0 ? input.IndexOf(')', urlStart) : -1;
                if (labelEnd > index && urlEnd > urlStart)
                {
                    string label = input[(index + 1)..labelEnd];
                    string url = input[urlStart..urlEnd];
                    output.Append("<a href=\"")
                        .Append(Encode(ResolveSafeUrl(url)))
                        .Append("\" rel=\"noopener noreferrer\" target=\"_blank\">")
                        .Append(Encode(label))
                        .Append("</a>");
                    index = urlEnd + 1;
                    continue;
                }
            }

            char ch = input[index];
            output.Append(ch switch
            {
                '&' => "&amp;",
                '<' => "&lt;",
                '>' => "&gt;",
                '"' => "&quot;",
                '\'' => "&#39;",
                _ => ch.ToString()
            });
            index++;
        }

        return output.ToString();
    }

    private static string ResolveSafeUrl(string input)
    {
        string url = (input ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(url))
        {
            return "#";
        }

        if (url.StartsWith("//", StringComparison.Ordinal))
        {
            return "#";
        }

        if (url.StartsWith("/", StringComparison.Ordinal)
            || url.StartsWith("#", StringComparison.Ordinal)
            || url.StartsWith("./", StringComparison.Ordinal)
            || url.StartsWith("../", StringComparison.Ordinal))
        {
            return url;
        }

        if (!Uri.TryCreate(url, UriKind.Absolute, out Uri? uri))
        {
            return url;
        }

        return uri.Scheme is "http" or "https" or "mailto" or "tel" ? url : "#";
    }

    private static string Encode(string? value)
        => WebUtility.HtmlEncode(value ?? string.Empty);
}
