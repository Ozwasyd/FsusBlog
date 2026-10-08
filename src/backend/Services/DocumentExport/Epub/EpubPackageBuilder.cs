using System.Collections.Immutable;
using System.IO.Compression;
using System.Text;
using System.Xml;
using System.Xml.Linq;

namespace FsusBlog.Server.Services.DocumentExport;

internal sealed record EpubPackageBuildResult(byte[] Bytes, EpubPackageValidation Validation);

/// <summary>
/// Packages the canonical XHTML fragment under an explicit single-chapter policy.
/// Chapter inference waits for canonical semantic facts; Markdown is never parsed here.
/// </summary>
internal static class EpubPackageBuilder
{
    internal const string ChapterPolicy = "fixed-single-chapter-v1";
    internal const string ValidatorIdentity = "fsusblog.epub-structural-validator-v1";
    private static readonly XNamespace s_xhtml = "http://www.w3.org/1999/xhtml";
    private static readonly XNamespace s_epub = "http://www.idpf.org/2007/ops";
    private static readonly XNamespace s_opf = "http://www.idpf.org/2007/opf";
    private static readonly XNamespace s_dc = "http://purl.org/dc/elements/1.1/";

    internal static EpubPackageBuildResult Build(
        DocumentExportFrozenInput input,
        DocumentExportRendererResponse response,
        EpubPublicationMetadata metadata,
        DocumentExportResourceBudgets budgets,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        DocumentExportContractValidator.Validate(input);
        metadata.Validate(input);
        SelfContainedHtmlDocumentExportProvider.ValidateRendererResponse(response, input);
        if (response.Title != metadata.Title
            || response.ObservedFeatures.Distinct(StringComparer.Ordinal).Count() != response.ObservedFeatures.Length
            || response.ObservedFeatures.Any(feature => !DocumentExportContractCatalog.FeatureIds.Contains(feature, StringComparer.Ordinal)))
        {
            throw new InvalidDataException("EPUB title or observed feature identity drifted from the frozen contract.");
        }
        DocumentExportResourceBudgets declared = DocumentExportContractCatalog.RequireProvider("epub").Budgets;
        if (budgets.MaxFileCount < 5 || budgets.MaxFileCount > declared.MaxFileCount
            || budgets.MaxOutputBytes <= 0 || budgets.MaxOutputBytes > declared.MaxOutputBytes
            || budgets.MaxFileBytes <= 0 || budgets.MaxFileBytes > declared.MaxFileBytes
            || budgets.MaxInputBytes <= 0 || budgets.MaxInputBytes > declared.MaxInputBytes)
        {
            throw new DocumentExportBudgetExceededException("EPUB package limits are invalid.", "resource-budget");
        }
        if (Encoding.UTF8.GetByteCount(response.HtmlFragment) > budgets.MaxInputBytes)
        {
            throw new DocumentExportBudgetExceededException("EPUB renderer fragment exceeds the input budget.", "input-budget");
        }
        if (Encoding.UTF8.GetByteCount(response.HtmlFragment) + 64L > budgets.MaxOutputBytes)
        {
            throw new DocumentExportBudgetExceededException("EPUB content exceeds its output budget.", "output-budget");
        }

        EpubXmlBudget.Validate("<article>" + response.HtmlFragment + "</article>", budgets.MaxInputBytes, cancellationToken);
        byte[] fragment = DocumentExportHtmlSanitizer.Sanitize(response.HtmlFragment, input.Assets,
            Math.Min(budgets.MaxOutputBytes, EpubXmlBudget.MaximumBytes));
        XElement article = ParseFragment(fragment, budgets.MaxOutputBytes);
        foreach (XElement element in article.DescendantsAndSelf().Where(element => element.Name.Namespace == XNamespace.None))
        {
            element.Name = s_xhtml + element.Name.LocalName;
        }
        article.Name = s_xhtml + "article";
        article.SetAttributeValue("id", "epub-reading-start");
        foreach (XElement image in article.Descendants(s_xhtml + "img"))
        {
            string assetId = (string?)image.Attribute("data-asset-id")
                ?? throw new InvalidDataException("EPUB image has no frozen inventory reference.");
            DocumentExportAsset asset = input.Assets.Single(asset => asset.AssetId == assetId);
            if (string.IsNullOrWhiteSpace((string?)image.Attribute("alt"))
                && (string?)image.Attribute("role") != "presentation")
            {
                throw new InvalidDataException("EPUB informative images require frozen alt text.");
            }
            image.SetAttributeValue("src", ResourcePath(asset));
            image.Attribute("data-asset-id")!.Remove();
        }
        foreach (XElement element in article.Descendants())
        {
            string? role = (string?)element.Attribute("role");
            if (role is "doc-noteref" or "doc-footnote")
            {
                element.SetAttributeValue(s_epub + "type", role == "doc-noteref" ? "noteref" : "footnote");
            }
        }

        var entries = new SortedDictionary<string, byte[]>(StringComparer.Ordinal)
        {
            ["META-INF/container.xml"] = XmlBytes(new XElement(
                XNamespace.Get("urn:oasis:names:tc:opendocument:xmlns:container") + "container",
                new XAttribute("version", "1.0"),
                new XElement(XNamespace.Get("urn:oasis:names:tc:opendocument:xmlns:container") + "rootfiles",
                    new XElement(XNamespace.Get("urn:oasis:names:tc:opendocument:xmlns:container") + "rootfile",
                        new XAttribute("full-path", "EPUB/package.opf"),
                        new XAttribute("media-type", "application/oebps-package+xml")))), budgets.MaxOutputBytes),
            ["EPUB/chapter-0001.xhtml"] = XmlBytes(Document(metadata,
                new XElement(s_xhtml + "main", article)), budgets.MaxOutputBytes),
            ["EPUB/nav.xhtml"] = XmlBytes(Document(metadata,
                new XElement(s_xhtml + "nav", new XAttribute(s_epub + "type", "toc"), new XAttribute("id", "toc"),
                    new XElement(s_xhtml + "h1", metadata.Title),
                    new XElement(s_xhtml + "ol", new XElement(s_xhtml + "li",
                        new XElement(s_xhtml + "a", new XAttribute("href", "chapter-0001.xhtml#epub-reading-start"), metadata.Title)))),
                new XElement(s_xhtml + "nav", new XAttribute(s_epub + "type", "landmarks"),
                    new XElement(s_xhtml + "h2", "Reading order"),
                    new XElement(s_xhtml + "ol", new XElement(s_xhtml + "li",
                        new XElement(s_xhtml + "a", new XAttribute(s_epub + "type", "bodymatter"),
                            new XAttribute("href", "chapter-0001.xhtml#epub-reading-start"), metadata.Title))))), budgets.MaxOutputBytes)
        };
        byte[] embeddedStyle = DocumentExportReadingStyleAuthority.BuildStyleBytes(input.Assets, input.ThemeProfile, budgets.MaxOutputBytes);
        string style = Encoding.UTF8.GetString(embeddedStyle);
        foreach (DocumentExportAsset asset in input.Assets)
        {
            cancellationToken.ThrowIfCancellationRequested();
            EpubResourceValidation.Validate(asset, budgets.MaxFileBytes, cancellationToken);
            string path = ResourcePath(asset);
            if (entries.TryGetValue("EPUB/" + path, out byte[]? existing))
            {
                if (!existing.AsSpan().SequenceEqual(asset.Bytes.AsSpan()))
                {
                    throw new InvalidDataException("EPUB content-addressed resource collision.");
                }
            }
            else
            {
                entries.Add("EPUB/" + path, asset.Bytes.ToArray());
            }
            if (asset.Role == "font")
            {
                style = style.Replace($"data:{asset.MediaType};base64,{Convert.ToBase64String(asset.Bytes.AsSpan())}", path, StringComparison.Ordinal);
            }
        }
        entries.Add("EPUB/reading.css", Encoding.UTF8.GetBytes(style));
        entries.Add("EPUB/package.opf", XmlBytes(Package(metadata, input.Assets,
            article.Descendants().Any(element => element.Name.NamespaceName == "http://www.w3.org/2000/svg")), budgets.MaxOutputBytes));
        if (entries.Count + 1 > budgets.MaxFileCount
            || entries.Sum(entry => (long)entry.Value.Length) + 20 > budgets.MaxFileBytes)
        {
            throw new DocumentExportBudgetExceededException("EPUB entries exceed the file count or expanded-byte budget.", "file-budget");
        }
        using var output = new DocumentExportBoundedMemoryStream(budgets.MaxOutputBytes,
            "EPUB archive exceeds its output budget.", "output-budget");
        using (var zip = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true, entryNameEncoding: Encoding.UTF8))
        {
            WriteEntry(zip, "mimetype", "application/epub+zip"u8, cancellationToken);
            foreach ((string path, byte[] bytes) in entries)
            {
                WriteEntry(zip, path, bytes, cancellationToken);
            }
        }
        cancellationToken.ThrowIfCancellationRequested();
        byte[] result = output.ToArray();
        EpubPackageValidation validation = DocumentExportEpubPackageValidator.Validate(result, input, response,
            metadata, budgets, cancellationToken);
        return new EpubPackageBuildResult(result, validation);
    }

    internal static string ResourcePath(DocumentExportAsset asset)
        => $"resources/r-{asset.Sha256[7..]}.{(asset.Role == "font" ? "woff2" : "png")}";

    private static XElement Document(EpubPublicationMetadata metadata, params XElement[] body)
        => new(s_xhtml + "html", new XAttribute(XNamespace.Xmlns + "epub", s_epub),
            new XAttribute("lang", metadata.Language), new XAttribute(XNamespace.Xml + "lang", metadata.Language),
            new XAttribute("dir", metadata.Direction),
            new XElement(s_xhtml + "head", new XElement(s_xhtml + "title", metadata.Title),
                new XElement(s_xhtml + "link", new XAttribute("rel", "stylesheet"),
                    new XAttribute("type", "text/css"), new XAttribute("href", "reading.css"))),
            new XElement(s_xhtml + "body", body));

    private static XElement Package(EpubPublicationMetadata metadata, ImmutableArray<DocumentExportAsset> assets, bool svg)
    {
        var manifest = new XElement(s_opf + "manifest",
            new XElement(s_opf + "item", new XAttribute("id", "nav"), new XAttribute("href", "nav.xhtml"),
                new XAttribute("media-type", "application/xhtml+xml"), new XAttribute("properties", "nav")),
            new XElement(s_opf + "item", new XAttribute("id", "chapter-0001"), new XAttribute("href", "chapter-0001.xhtml"),
                new XAttribute("media-type", "application/xhtml+xml"), svg ? new XAttribute("properties", "svg") : null),
            new XElement(s_opf + "item", new XAttribute("id", "reading-style"), new XAttribute("href", "reading.css"),
                new XAttribute("media-type", "text/css")));
        foreach (DocumentExportAsset asset in assets.DistinctBy(ResourcePath).OrderBy(ResourcePath, StringComparer.Ordinal))
        {
            manifest.Add(new XElement(s_opf + "item", new XAttribute("id", "r-" + asset.Sha256[7..]),
                new XAttribute("href", ResourcePath(asset)), new XAttribute("media-type", asset.MediaType)));
        }
        return new XElement(s_opf + "package", new XAttribute("version", "3.0"),
            new XAttribute("unique-identifier", "publication-id"), new XAttribute("dir", metadata.Direction),
            new XAttribute(XNamespace.Xml + "lang", metadata.Language),
            new XAttribute("prefix", "schema: http://schema.org/"),
            new XElement(s_opf + "metadata", new XAttribute(XNamespace.Xmlns + "dc", s_dc),
                new XElement(s_dc + "identifier", new XAttribute("id", "publication-id"), metadata.Identifier),
                new XElement(s_dc + "title", metadata.Title), new XElement(s_dc + "language", metadata.Language),
                metadata.Authors.Select(author => new XElement(s_dc + "creator", author)),
                new XElement(s_opf + "meta", new XAttribute("property", "dcterms:modified"), metadata.Modified),
                new XElement(s_opf + "meta", new XAttribute("property", "schema:accessMode"), "textual"),
                assets.Any(asset => asset.Role == "image")
                    ? new XElement(s_opf + "meta", new XAttribute("property", "schema:accessMode"), "visual") : null,
                new XElement(s_opf + "meta", new XAttribute("property", "schema:accessibilityFeature"), "tableOfContents"),
                new XElement(s_opf + "meta", new XAttribute("property", "schema:accessibilityFeature"), "readingOrder"),
                new XElement(s_opf + "meta", new XAttribute("property", "schema:accessibilitySummary"),
                    "Single canonical chapter with navigation, preserved semantic content and frozen image alternatives. Reader font coverage is not certified.")),
            manifest,
            new XElement(s_opf + "spine", new XAttribute("page-progression-direction", metadata.Direction),
                new XElement(s_opf + "itemref", new XAttribute("idref", "chapter-0001"))));
    }

    private static XElement ParseFragment(byte[] bytes, long maximumBytes)
    {
        using var source = new StringReader("<article>" + Encoding.UTF8.GetString(bytes) + "</article>");
        using XmlReader reader = XmlReader.Create(source, new XmlReaderSettings
        {
            DtdProcessing = DtdProcessing.Prohibit,
            XmlResolver = null,
            MaxCharactersInDocument = maximumBytes,
            MaxCharactersFromEntities = 0
        });
        return XElement.Load(reader, LoadOptions.PreserveWhitespace);
    }

    private static byte[] XmlBytes(XElement element, long maximumBytes)
    {
        using var output = new DocumentExportBoundedMemoryStream(maximumBytes, "EPUB XML exceeds its output budget.", "output-budget");
        using (XmlWriter writer = XmlWriter.Create(output, new XmlWriterSettings
        {
            Encoding = new UTF8Encoding(false, true),
            OmitXmlDeclaration = false,
            NewLineHandling = NewLineHandling.None,
            Indent = false
        }))
        {
            element.WriteTo(writer);
        }
        return output.ToArray();
    }

    private static void WriteEntry(ZipArchive zip, string path, ReadOnlySpan<byte> bytes, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ZipArchiveEntry entry = zip.CreateEntry(path, CompressionLevel.NoCompression);
        entry.LastWriteTime = new DateTimeOffset(1980, 1, 1, 0, 0, 0, TimeSpan.Zero);
        entry.ExternalAttributes = 0;
        using Stream target = entry.Open();
        target.Write(bytes);
    }
}
