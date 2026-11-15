using System.Globalization;
using System.Text;
using System.Text.Encodings.Web;
using FsusBlog.V2.Contracts;
using Markdig;
using Markdig.Syntax;
using Markdig.Syntax.Inlines;

namespace FsusBlog.V2.Server.Content;

internal static class PublicArticleHtml
{
    private static readonly MarkdownPipeline Pipeline = new MarkdownPipelineBuilder().DisableHtml().Build();

    internal static string Render(Article article, IReadOnlyList<PublishedArticleImage>? images = null)
    {
        var header = HtmlEncoder.Default.Encode(article.Title);
        var disclosure = article.Rights?.Policy is { Enabled: true, ShowPublicBadge: true } rights
            ? $"<aside aria-label=\"Article rights\"><p>{HtmlEncoder.Default.Encode(rights.LicenseType)}</p>" +
              $"<p>{HtmlEncoder.Default.Encode(rights.CopyrightHolder)}{(rights.CopyrightYear > 0 ? $" {rights.CopyrightYear}" : "")}</p>" +
              $"<p>{HtmlEncoder.Default.Encode(rights.RightsStatement)}</p></aside>"
            : "";
        var cover = article.CoverMediaDigest is { } digest
            ? $"<img src=\"{PublishedMediaProjection.ImagePath(article.Id, article.Publication, digest)}\" alt=\"Article cover\" class=\"article-cover\">"
            : "";
        return $"<main><article>{cover}<h1>{header}</h1>{RenderMarkdown(article.Body)}{RenderImages(article, images)}{disclosure}</article></main>";
    }

    private static string RenderImages(Article article, IReadOnlyList<PublishedArticleImage>? images)
    {
        if (article.CoverMediaDigest is { } cover && images is not null)
            images = images.Where(image => image.Digest != cover).ToArray();
        if (images is not { Count: > 0 }) return "";
        var html = new StringBuilder();
        html.Append(CultureInfo.InvariantCulture,
            $"<section data-fsus-public-article-media data-article-id=\"{article.Id}\" data-publication=\"{article.Publication}\" aria-label=\"Published images\">");
        for (var index = 0; index < images.Count; index++)
        {
            var image = images[index];
            var path = PublishedMediaProjection.ImagePath(article.Id, article.Publication, image.Digest);
            html.Append(CultureInfo.InvariantCulture,
                $"<img src=\"{path}\" width=\"{image.Width}\" height=\"{image.Height}\" alt=\"Published image {index + 1}\" loading=\"lazy\">");
        }
        return html.Append("</section>").ToString();
    }

    internal static MarkdownDocument ParseMarkdown(string markdown) => Markdown.Parse(markdown, Pipeline);

    internal static string RenderMarkdown(string markdown) => RenderMarkdown(ParseMarkdown(markdown));

    internal static string RenderMarkdown(MarkdownDocument document)
    {
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
