using System.Collections.Immutable;
using System.Text;
using System.Xml;
using System.Xml.Linq;

namespace FsusBlog.Server.Services.DocumentExport;

/// <summary>
/// A format-local projection of the canonical renderer's validated XHTML.
/// It never reads Markdown or resolves assets outside the frozen inventory.
/// </summary>
internal sealed record DocumentExportDocxProjection(
    string InputDigest,
    string RendererResponseDigest,
    string Title,
    string Locale,
    string Fragment,
    ImmutableArray<DocumentExportAsset> Images,
    ImmutableArray<string> Features,
    ImmutableArray<string> Warnings,
    string ContentDigest)
{
    internal const int MaximumNodes = 20000;
    internal const int MaximumDepth = 32;
    internal const int MaximumCharacters = 1000000;

    internal static DocumentExportDocxProjection Create(
        DocumentExportRendererResponse response,
        DocumentExportFrozenInput input,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        DocumentExportContractValidator.Validate(input);
        SelfContainedHtmlDocumentExportProvider.ValidateRendererResponse(response, input);
        if (response.HtmlFragment.Length > MaximumCharacters)
        {
            throw new InvalidDataException("DOCX canonical fragment exceeds the character limit.");
        }
        string[] features = response.ObservedFeatures.Order(StringComparer.Ordinal).ToArray();
        if (features.Distinct(StringComparer.Ordinal).Count() != features.Length
            || features.Any(feature => !DocumentExportContractCatalog.FeatureIds.Contains(feature, StringComparer.Ordinal)))
        {
            throw new InvalidDataException("DOCX projection received unknown or duplicate canonical features.");
        }
        byte[] sanitized = DocumentExportHtmlSanitizer.Sanitize(
            response.HtmlFragment, input.Assets, MaximumCharacters * 4L);
        string fragment = Encoding.UTF8.GetString(sanitized);
        XElement root = ReadFragment(fragment);
        if (string.IsNullOrWhiteSpace(root.Value)
            && !root.Descendants().Any(element => element.Name.LocalName is "img" or "hr"))
        {
            throw new InvalidDataException("DOCX canonical projection is semantically empty.");
        }
        var warnings = new SortedSet<string>(StringComparer.Ordinal);
        int count = 0;
        foreach (XElement element in root.Descendants())
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (++count > MaximumNodes || element.Ancestors().Count() > MaximumDepth)
            {
                throw new InvalidDataException("DOCX projection exceeds its structural limits.");
            }
            if (element.Name.LocalName == "svg")
            {
                if (string.IsNullOrWhiteSpace(element.Value))
                {
                    throw new InvalidDataException("DOCX diagram has no canonical preserved text fallback.");
                }
                warnings.Add("mermaid:preserve-canonical-diagram-text");
            }
            if (((string?)element.Attribute("class"))?.Split(' ').Contains("katex", StringComparer.Ordinal) == true)
            {
                if (string.IsNullOrWhiteSpace(element.Value))
                {
                    throw new InvalidDataException("DOCX math has no canonical preserved text fallback.");
                }
                warnings.Add("katex-latex:preserve-canonical-math-text");
            }
            if (element.Attribute("data-embed") is not null)
            {
                warnings.Add("embeds:preserve-static-canonical-content");
            }
            if (element.Name.LocalName == "ol"
                && (element.Attribute("reversed") is not null || element.Attribute("type") is not null))
            {
                throw new InvalidDataException("DOCX reversed or custom ordered lists are unsupported.");
            }
            if (element.Attribute("rowspan") is not null || element.Attribute("colspan") is not null)
            {
                throw new InvalidDataException("DOCX merged table cells are unsupported.");
            }
            if (element.Attribute("id") is not null && element.Name.LocalName is "tr" or "thead" or "tbody" or "tfoot"
                || (string?)element.Attribute("dir") == "auto")
            {
                throw new InvalidDataException("DOCX table group anchors or automatic direction are unsupported.");
            }
        }
        _ = DocumentExportDocxFootnote.ReadGraph(root);
        warnings.Add("page-ebook-limits:preserve-semantic-flow-with-explicit-warning");
        warnings.Add("fonts:registered-family-references-require-reader-fonts");
        DocumentExportAsset[] images = input.Assets.Where(asset => asset.Role == "image").ToArray();
        foreach (DocumentExportAsset image in images)
        {
            if (image.MediaType != "image/png"
                || image.Bytes.Length > 8 * 1024 * 1024
                || image.Sha256 != DocumentExportDigest.ComputeBytes(image.Bytes.AsSpan()))
            {
                throw new InvalidDataException("DOCX media MIME, digest or budget is unsupported.");
            }
            DocumentExportDocxPackage.VerifyImage(image.Bytes.AsSpan(), image.MediaType, cancellationToken);
        }
        var unsigned = new DocumentExportDocxProjection(
            input.ContentDigest, response.ContentDigest, response.Title, input.Locale, fragment,
            images.ToImmutableArray(), features.ToImmutableArray(), warnings.ToImmutableArray(), string.Empty);
        return unsigned with
        {
            ContentDigest = DocumentExportDigest.Compute(unsigned)
        };
    }

    internal XElement ReadRoot()
    {
        if (ContentDigest != DocumentExportDigest.Compute(this with
        {
            ContentDigest = string.Empty
        }))
        {
            throw new InvalidDataException("DOCX projection digest mismatch.");
        }
        return ReadFragment(Fragment);
    }

    private static XElement ReadFragment(string fragment)
    {
        using var source = new StringReader("<article>" + fragment + "</article>");
        using XmlReader reader = XmlReader.Create(source, new XmlReaderSettings
        {
            DtdProcessing = DtdProcessing.Prohibit,
            XmlResolver = null,
            MaxCharactersInDocument = MaximumCharacters * 4L,
            MaxCharactersFromEntities = 0
        });
        return XElement.Load(reader, LoadOptions.PreserveWhitespace);
    }
}
