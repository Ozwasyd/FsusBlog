using System.Text;
using System.Text.Encodings.Web;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Content;
using Markdig.Syntax;
using Markdig.Syntax.Inlines;

namespace FsusBlog.V2.Server.Authoring;

internal static class HtmlDocumentExport
{
    internal const string ContentType = "text/html; charset=utf-8";
    internal const int MaximumOutput = 2 * 1024 * 1024;
    private const string DocumentPolicy = "default-src 'none'; base-uri 'none'; form-action 'none'";
    internal const string ResponsePolicy = DocumentPolicy + "; frame-ancestors 'none'";
    private static readonly HashSet<string> RenderedFences = new(StringComparer.OrdinalIgnoreCase)
        { "mermaid", "katex", "latex", "math" };

    internal static byte[] Write(string title, string body, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (Encoding.UTF8.GetByteCount(title) > WireLimits.TitleBytes || Encoding.UTF8.GetByteCount(body) > WireLimits.BodyBytes)
            throw TooLarge();

        var document = PublicArticleHtml.ParseMarkdown(body);
        if (document.Descendants<MarkdownObject>().Any(node => node is LinkInline or AutolinkInline or LinkReferenceDefinitionGroup ||
            node is FencedCodeBlock { Info: { } info } && RenderedFences.Contains(info)))
            throw new BusinessException(Rejection.Invalid,
                "Offline HTML supports basic text Markdown without links, images, or render directives.");

        ct.ThrowIfCancellationRequested();
        var heading = HtmlEncoder.Default.Encode(title);
        var html = $"""
            <!doctype html>
            <html>
            <head>
            <meta charset="utf-8">
            <meta http-equiv="Content-Security-Policy" content="{DocumentPolicy}">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>{heading}</title>
            </head>
            <body><main><article dir="auto"><h1>{heading}</h1>
            {PublicArticleHtml.RenderMarkdown(document)}
            </article></main></body>
            </html>
            """;
        ct.ThrowIfCancellationRequested();
        if (Encoding.UTF8.GetByteCount(html) > MaximumOutput) throw TooLarge();
        return Encoding.UTF8.GetBytes(html);
    }

    private static BusinessException TooLarge() => new(Rejection.Invalid, "This revision exceeds the offline HTML size limit.");
}
