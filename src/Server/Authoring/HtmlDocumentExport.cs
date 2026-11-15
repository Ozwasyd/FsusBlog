using System.Text;
using System.Text.Encodings.Web;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using Markdig;
using Markdig.Syntax;
using Markdig.Syntax.Inlines;

namespace FsusBlog.V2.Server.Authoring;

internal static class HtmlDocumentExport
{
    internal const string ContentType = "text/html; charset=utf-8";
    internal const int MaximumOutput = 2 * 1024 * 1024;
    private const string DocumentPolicy = "default-src 'none'; base-uri 'none'; form-action 'none'";
    private const string DocumentImagePolicy = DocumentPolicy + "; img-src data:";
    internal const string ResponsePolicy = DocumentPolicy + "; frame-ancestors 'none'";
    internal const string ImageResponsePolicy = DocumentImagePolicy + "; frame-ancestors 'none'";
    private const int MaximumExpandedTableCells = 32_768;
    private static readonly MarkdownPipeline BasicMarkdown = new MarkdownPipelineBuilder().DisableHtml().Build();
    private static readonly MarkdownPipeline TableMarkdown = new MarkdownPipelineBuilder().DisableHtml().UsePipeTables().Build();
    private static readonly HashSet<string> RenderedFences = new(StringComparer.OrdinalIgnoreCase)
        { "mermaid", "katex", "latex", "math" };

    internal static byte[] Write(string title, string body, CancellationToken ct, bool includeTables = true, DocumentExportAttachment? attachment = null)
    {
        var content = RenderBody(title, body, "HTML", ct, includeTables);
        var documentPolicy = attachment is null ? DocumentPolicy : DocumentImagePolicy;
        if (attachment is not null)
            content += attachment.Figure($"data:{attachment.ContentType};base64,{Convert.ToBase64String(attachment.Bytes)}", xhtml: false);
        var heading = HtmlEncoder.Default.Encode(title);
        var html = $"""
            <!doctype html>
            <html>
            <head>
            <meta charset="utf-8">
            <meta http-equiv="Content-Security-Policy" content="{documentPolicy}">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>{heading}</title>
            </head>
            <body><main><article dir="auto"><h1>{heading}</h1>
            {content}
            </article></main></body>
            </html>
            """;
        ct.ThrowIfCancellationRequested();
        if (Encoding.UTF8.GetByteCount(html) > MaximumOutput) throw TooLarge("HTML");
        return Encoding.UTF8.GetBytes(html);
    }

    internal static string RenderBody(string title, string body, string format, CancellationToken ct, bool includeTables = true)
    {
        ct.ThrowIfCancellationRequested();
        if (Encoding.UTF8.GetByteCount(title) > WireLimits.TitleBytes || Encoding.UTF8.GetByteCount(body) > WireLimits.BodyBytes)
            throw TooLarge(format);

        var pipeline = includeTables ? SelectPipeline(body, format, ct) : BasicMarkdown;
        var document = Markdown.Parse(body, pipeline);
        if (document.Descendants<MarkdownObject>().Any(node => node is LinkInline or AutolinkInline or LinkReferenceDefinitionGroup ||
            node is FencedCodeBlock { Info: { } info } && RenderedFences.Contains(info)))
            throw new BusinessException(Rejection.Invalid,
                $"Offline {format} supports basic text Markdown without links, images, or render directives.");

        ct.ThrowIfCancellationRequested();
        return Markdown.ToHtml(document, pipeline);
    }

    internal static MarkdownDocument ParseMarkdown(string body, string format, CancellationToken ct, bool includeTables) =>
        Markdown.Parse(body, includeTables ? SelectPipeline(body, format, ct) : BasicMarkdown);

    private static MarkdownPipeline SelectPipeline(string body, string format, CancellationToken ct)
    {
        var lines = 0;
        var maxPipes = 0;
        var possibleSeparator = false;
        foreach (var line in body.AsSpan().EnumerateLines())
        {
            ct.ThrowIfCancellationRequested();
            lines++;
            var pipes = line.Count('|');
            if (pipes == 0) continue;
            maxPipes = Math.Max(maxPipes, pipes);
            possibleSeparator |= IsTableSeparator(line);
        }
        if (!possibleSeparator || lines < 2) return BasicMarkdown;
        // Markdig pads short rows to the widest row. Bound that expansion before parsing.
        if ((long)lines * (maxPipes + 1) > MaximumExpandedTableCells) throw TooLarge(format);
        return TableMarkdown;
    }

    private static bool IsTableSeparator(ReadOnlySpan<char> line)
    {
        foreach (var character in line)
            if (character is not (' ' or '\t' or '>' or '|' or ':' or '-')) return false;
        return line.Contains('-');
    }

    internal static BusinessException TooLarge(string format) => new(Rejection.Invalid, $"This revision exceeds the offline {format} size limit.");
}
