using System.Globalization;
using System.Net;
using System.Text;
using System.Xml;

namespace FsusBlog.Server.Services.DocumentExport;

internal sealed record PdfPrintFontAsset(
    string Family,
    int Weight,
    string Style,
    string MediaType,
    string Bytes,
    string Sha256);

internal sealed record PdfPrintRenderRequest(
    string HtmlDocument,
    PdfPrintFontAsset[] FontAssets,
    string ExpectedText,
    string[] ExpectedLinks,
    string InputDigest,
    string PrintProfile,
    string? PdfBase64);

internal sealed record PdfPrintRenderResponse(
    string PdfBase64,
    string SemanticDigest,
    int PageCount,
    int FontCount,
    string[] Warnings);

/// <summary>
/// Projects the canonical sanitized fragment into an offline print document.
/// It does not parse Markdown, resolve assets, or consult installed host fonts.
/// </summary>
internal static class PdfPrintDocumentLayout
{
    internal const string PrintProfile = "a4-reading-v1";

    private const string PrintStyle = """
        @page{size:A4;margin:20mm 18mm 20mm;@bottom-center{content:counter(page) " / " counter(pages);font-family:'Google Sans';font-size:9pt;color:#71717A}}
        @media print{
        html,body{background:#FFFFFF;color:#0F0F11}body{font-size:12pt;line-height:1.8}
        main{max-width:none;margin:0;padding:0}article{overflow-wrap:anywhere}
        h1,h2,h3,h4,h5,h6{break-after:avoid}p,li,blockquote{orphans:3;widows:3}
        figure,img,svg{break-inside:avoid;max-width:100%}figure{margin:1em 0}
        table{table-layout:fixed}thead{display:table-header-group}tfoot{display:table-footer-group}tr{break-inside:avoid}
        pre{direction:ltr;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere;overflow:visible}code{white-space:inherit}
        .page-break,.page-break-before{break-before:page}.page-break-after{break-after:page}.page-break-inside-avoid{break-inside:avoid}
        details,details>*{display:block}a{color:#2A599C;text-decoration:underline}
        }
        """;

    internal static PdfPrintRenderRequest Compose(
        DocumentExportRendererResponse response,
        DocumentExportFrozenInput input,
        long maximumBytes)
    {
        DocumentExportContractValidator.Validate(input);
        SelfContainedHtmlDocumentExportProvider.ValidateRendererResponse(response, input);
        byte[] fragment = DocumentExportHtmlSanitizer.Sanitize(response.HtmlFragment, input.Assets, maximumBytes);
        // Print uses the same frozen typography but a readable paper palette for both themes.
        byte[] readingStyle = DocumentExportReadingStyleAuthority.BuildStyleBytes(
            input.Assets,
            DocumentExportReadingStyleAuthority.LightThemeProfile,
            maximumBytes);
        // These exact screen-only rules are outside the print engine's CSS
        // vocabulary. Remove them from the trusted reading projection rather
        // than weakening rejection of unknown print/resource warnings.
        string style = Encoding.UTF8.GetString(readingStyle)
            .Replace("color-scheme:light;", string.Empty, StringComparison.Ordinal)
            .Replace("@media(max-width:480px){main{padding:1.5rem 1rem}}", string.Empty, StringComparison.Ordinal);
        string direction = CultureInfo.GetCultureInfo(input.Locale).TextInfo.IsRightToLeft ? "rtl" : "ltr";
        using var output = new DocumentExportBoundedMemoryStream(maximumBytes, "PDF print document exceeds its budget.", "output-budget");
        WriteUtf8(output, $"<!doctype html>\n<html lang=\"{WebUtility.HtmlEncode(input.Locale)}\" dir=\"{direction}\"><head><meta charset=\"utf-8\" /><title>{WebUtility.HtmlEncode(response.Title)}</title><style>");
        WriteUtf8(output, style);
        WriteUtf8(output, PrintStyle);
        WriteUtf8(output, "</style></head><body><main><article>");
        output.Write(fragment);
        WriteUtf8(output, "</article></main></body></html>\n");
        (string expectedText, string[] expectedLinks) = ReadSemantics(fragment, maximumBytes);
        PdfPrintFontAsset[] fonts = input.Assets
            .Where(DocumentExportReadingStyleAuthority.IsFont)
            .OrderBy(font => font.FontFamily, StringComparer.Ordinal)
            .ThenBy(font => font.FontWeight)
            .ThenBy(font => font.FontStyle, StringComparer.Ordinal)
            .Select(font => new PdfPrintFontAsset(
                font.FontFamily, font.FontWeight, font.FontStyle, font.MediaType,
                Convert.ToBase64String(font.Bytes.AsSpan()), font.Sha256))
            .ToArray();
        return new PdfPrintRenderRequest(
            Encoding.UTF8.GetString(output.ToArray()), fonts, expectedText, expectedLinks,
            input.ContentDigest, PrintProfile, null);
    }

    private static (string Text, string[] Links) ReadSemantics(byte[] fragment, long maximumBytes)
    {
        using var source = new StringReader("<article>" + Encoding.UTF8.GetString(fragment) + "</article>");
        using XmlReader reader = XmlReader.Create(source, new XmlReaderSettings
        {
            DtdProcessing = DtdProcessing.Prohibit,
            XmlResolver = null,
            MaxCharactersInDocument = maximumBytes,
            MaxCharactersFromEntities = 0
        });
        var text = new StringBuilder();
        var links = new SortedSet<string>(StringComparer.Ordinal);
        int hiddenDepth = -1;
        while (reader.Read())
        {
            if (reader.NodeType == XmlNodeType.Element)
            {
                if (hiddenDepth < 0 && reader.NamespaceURI == "http://www.w3.org/2000/svg"
                    && reader.LocalName is "title" or "desc" && !reader.IsEmptyElement)
                {
                    hiddenDepth = reader.Depth;
                }
                if (reader.LocalName == "a" && reader.GetAttribute("href") is string href
                    && !href.StartsWith('#'))
                {
                    links.Add(href);
                }
                if (IsTextBoundary(reader.LocalName))
                {
                    text.Append(' ');
                }
            }
            else if (reader.NodeType == XmlNodeType.EndElement)
            {
                if (reader.Depth == hiddenDepth)
                {
                    hiddenDepth = -1;
                }
                if (IsTextBoundary(reader.LocalName))
                {
                    text.Append(' ');
                }
            }
            else if (hiddenDepth < 0 && reader.NodeType is XmlNodeType.Text or XmlNodeType.SignificantWhitespace or XmlNodeType.Whitespace)
            {
                text.Append(reader.Value);
            }
        }
        return (string.Join(' ', text.ToString().Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)), links.ToArray());
    }

    private static bool IsTextBoundary(string element)
        => element is "h1" or "h2" or "h3" or "h4" or "h5" or "h6" or "p" or "div" or "section"
            or "aside" or "blockquote" or "li" or "dt" or "dd" or "pre" or "figure" or "figcaption"
            or "tr" or "th" or "td" or "caption" or "hr" or "br" or "text" or "summary";

    private static void WriteUtf8(Stream output, string value)
        => output.Write(Encoding.UTF8.GetBytes(value));
}
