using System.Text.Encodings.Web;
using FsusBlog.V2.Contracts;
using Markdig;
using Markdig.Syntax;
using Markdig.Syntax.Inlines;

namespace FsusBlog.V2.Server.Content;

internal static class PublicArticleHtml
{
    private static readonly MarkdownPipeline Pipeline = new MarkdownPipelineBuilder().DisableHtml().Build();

    internal static string Render(Article article)
        => $"<main><article><h1>{HtmlEncoder.Default.Encode(article.Title)}</h1>{RenderMarkdown(article.Body)}</article></main>";

    internal static string RenderMarkdown(string markdown)
    {
        var document = Markdown.Parse(markdown, Pipeline);
        foreach (var link in document.Descendants<LinkInline>())
        {
            if (!IsPublicUrl(link.Url, permitMail: !link.IsImage))
                link.Url = "#";
        }
        foreach (var link in document.Descendants<AutolinkInline>().ToArray())
        {
            if (!link.IsEmail && !IsPublicUrl(link.Url, permitMail: true))
                link.ReplaceBy(new LiteralInline(link.Url));
        }

        return Markdown.ToHtml(document, Pipeline);
    }

    private static bool IsPublicUrl(string? url, bool permitMail)
    {
        // Browsers may normalize control characters and backslashes before resolving a URL.
        if (string.IsNullOrWhiteSpace(url) || url.Any(c => char.IsControl(c) || c == '\\') ||
            !string.Equals(url, url.Trim(), StringComparison.Ordinal) || url.StartsWith("//", StringComparison.Ordinal))
            return false;
        var boundary = url.AsSpan().IndexOfAny('/', '?', '#');
        var colon = url.IndexOf(':');
        if (colon < 0 || (boundary >= 0 && colon > boundary)) return true;
        var scheme = url[..colon];
        return scheme.Equals("https", StringComparison.OrdinalIgnoreCase) ||
               scheme.Equals("http", StringComparison.OrdinalIgnoreCase) ||
               (permitMail && scheme.Equals("mailto", StringComparison.OrdinalIgnoreCase));
    }
}
