using System.Collections.Immutable;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;

namespace FsusBlog.Server.Services.DocumentExport;

/// <summary>Verified EPUB facts for the existing provider receipt owner; this is not a second receipt authority.</summary>
public sealed record EpubPackageValidation(
    string ValidatorIdentity,
    string ChapterPolicy,
    string OutputDigest,
    string SemanticDigest,
    long OutputBytes,
    int ChapterCount,
    int NavigationCount,
    int ResourceCount,
    ImmutableArray<string> ObservedFeatures,
    ImmutableArray<string> Warnings);

/// <summary>
/// Independently validates actual ZIP entries, XML structure, resource integrity,
/// security, navigation and semantic content against the exact frozen authorities.
/// Passive XHTML must satisfy the supported content models and scalar attribute bounds;
/// unsupported structures are refused rather than repaired or silently flattened.
/// A successful external tool exit cannot substitute for these checks.
/// </summary>
public static class DocumentExportEpubPackageValidator
{
    private static readonly XNamespace s_xhtml = "http://www.w3.org/1999/xhtml";
    private static readonly XNamespace s_opf = "http://www.idpf.org/2007/opf";
    private static readonly XNamespace s_dc = "http://purl.org/dc/elements/1.1/";
    private static readonly XNamespace s_epub = "http://www.idpf.org/2007/ops";
    private static readonly XNamespace s_svg = "http://www.w3.org/2000/svg";
    private static readonly HashSet<string> s_elements = new(StringComparer.Ordinal)
    {
        "html", "head", "title", "link", "body", "main", "article", "nav", "h1", "h2", "h3", "h4", "h5", "h6",
        "p", "div", "span", "section", "aside", "blockquote", "ul", "ol", "li", "dl", "dt", "dd", "pre", "code",
        "kbd", "samp", "strong", "em", "b", "i", "u", "s", "del", "ins", "mark", "small", "sup", "sub", "a", "img",
        "figure", "figcaption", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "hr", "br", "details",
        "summary", "abbr", "time", "q", "cite"
    };
    private static readonly HashSet<string> s_svgElements = new(StringComparer.Ordinal)
    {
        "svg", "g", "path", "line", "polyline", "polygon", "circle", "ellipse", "rect", "text", "tspan", "title", "desc"
    };
    private static readonly HashSet<string> s_phrasingElements = new(StringComparer.Ordinal)
    {
        "span", "code", "kbd", "samp", "strong", "em", "b", "i", "u", "s", "del", "ins", "mark", "small",
        "sup", "sub", "a", "img", "br", "abbr", "time", "q", "cite"
    };
    private static readonly HashSet<string> s_flowElements = new(s_elements.Except(new[]
    {
        "html", "head", "title", "link", "body", "li", "dt", "dd", "figcaption", "thead", "tbody", "tfoot",
        "tr", "th", "td", "caption", "summary"
    }), StringComparer.Ordinal);
    private static readonly HashSet<string> s_grandfatheredLanguages = new(StringComparer.OrdinalIgnoreCase)
    {
        "en-GB-oed", "i-ami", "i-bnn", "i-default", "i-enochian", "i-hak", "i-klingon", "i-lux", "i-mingo",
        "i-navajo", "i-pwn", "i-tao", "i-tay", "i-tsu", "sgn-BE-FR", "sgn-BE-NL", "sgn-CH-DE", "art-lojban",
        "cel-gaulish", "no-bok", "no-nyn", "zh-guoyu", "zh-hakka", "zh-min", "zh-min-nan", "zh-xiang"
    };
    private const string ClockPattern = @"(?<hour>[0-9]{2}):(?<minute>[0-9]{2})(?::(?<second>[0-9]{2})(?:\.[0-9]{1,3})?)?";
    private static readonly Regex s_temporalValue = new(
        @"\A(?:(?<year>[0-9]{4,})(?:-(?<month>[0-9]{2})(?:-(?<day>[0-9]{2})(?:[T ]" + ClockPattern
            + @"(?:Z|[+-](?<offsetHour>[0-9]{2}):?(?<offsetMinute>[0-9]{2}))?)?)?|-W(?<week>[0-9]{2}))?"
            + @"|(?:--)?(?<month>[0-9]{2})-(?<day>[0-9]{2})|" + ClockPattern + @")\z",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);
    private static readonly Regex s_durationValue = new(
        @"\AP(?:[0-9]+D)?(?:T(?:[0-9]+H)?(?:[0-9]+M)?(?:[0-9]+(?:\.[0-9]{1,3})?S)?)?\z",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);

    /// <summary>Rejects invalid, corrupt, unsupported or tampered package bytes; never reads host files or network resources.</summary>
    public static EpubPackageValidation Validate(byte[] bytes, DocumentExportFrozenInput input,
        DocumentExportRendererResponse response, EpubPublicationMetadata metadata,
        DocumentExportResourceBudgets budgets, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(bytes);
        ArgumentNullException.ThrowIfNull(input);
        ArgumentNullException.ThrowIfNull(response);
        ArgumentNullException.ThrowIfNull(metadata);
        ArgumentNullException.ThrowIfNull(budgets);
        cancellationToken.ThrowIfCancellationRequested();
        DocumentExportContractValidator.Validate(input);
        metadata.Validate(input);
        SelfContainedHtmlDocumentExportProvider.ValidateRendererResponse(response, input);
        if (response.Title != metadata.Title || response.ObservedFeatures.IsDefault
            || response.ObservedFeatures.Distinct(StringComparer.Ordinal).Count() != response.ObservedFeatures.Length
            || response.ObservedFeatures.Any(feature => !DocumentExportContractCatalog.FeatureIds.Contains(feature, StringComparer.Ordinal)))
        {
            throw new InvalidDataException("EPUB renderer feature or title identity is invalid.");
        }
        DocumentExportResourceBudgets declared = DocumentExportContractCatalog.RequireProvider("epub").Budgets;
        if (budgets.MaxOutputBytes <= 0 || budgets.MaxOutputBytes > declared.MaxOutputBytes
            || budgets.MaxFileCount <= 0 || budgets.MaxFileCount > declared.MaxFileCount
            || budgets.MaxFileBytes <= 0 || budgets.MaxFileBytes > declared.MaxFileBytes
            || budgets.MaxInputBytes <= 0 || budgets.MaxInputBytes > declared.MaxInputBytes
            || Encoding.UTF8.GetByteCount(response.HtmlFragment) > budgets.MaxInputBytes)
        {
            throw new DocumentExportBudgetExceededException("EPUB validation limits exceed the registered budgets.", "resource-budget");
        }
        Dictionary<string, ReadOnlyMemory<byte>> entries = EpubZipValidation.Read(bytes, budgets, cancellationToken);
        var expectedPaths = new HashSet<string>(StringComparer.Ordinal)
        {
            "mimetype", "META-INF/container.xml", "EPUB/package.opf", "EPUB/nav.xhtml", "EPUB/chapter-0001.xhtml", "EPUB/reading.css"
        };
        var resources = new Dictionary<string, DocumentExportAsset>(StringComparer.Ordinal);
        foreach (DocumentExportAsset asset in input.Assets)
        {
            cancellationToken.ThrowIfCancellationRequested();
            string extension = asset.Role == "font" && asset.MediaType == "font/woff2" ? "woff2"
                : asset.Role == "image" && asset.MediaType == "image/png" ? "png"
                : throw new InvalidDataException("EPUB resource MIME has no qualified decoder.");
            string path = $"EPUB/resources/r-{asset.Sha256[7..]}.{extension}";
            expectedPaths.Add(path);
            if (!entries.TryGetValue(path, out ReadOnlyMemory<byte> content)
                || !content.Span.SequenceEqual(asset.Bytes.AsSpan())
                || DocumentExportDigest.ComputeBytes(content.Span) != asset.Sha256)
            {
                throw new InvalidDataException("EPUB resource bytes are missing, corrupt or not frozen.");
            }
            EpubResourceValidation.Validate(asset, budgets.MaxFileBytes, cancellationToken);
            resources.TryAdd(path, asset);
        }
        if (!expectedPaths.SetEquals(entries.Keys))
        {
            throw new InvalidDataException("EPUB contains missing or unowned entries.");
        }
        XElement container = Parse(entries["META-INF/container.xml"], budgets.MaxFileBytes, cancellationToken);
        XNamespace containerNamespace = "urn:oasis:names:tc:opendocument:xmlns:container";
        XElement expectedContainer = new(containerNamespace + "container", new XAttribute("version", "1.0"),
            new XElement(containerNamespace + "rootfiles", new XElement(containerNamespace + "rootfile",
                new XAttribute("full-path", "EPUB/package.opf"), new XAttribute("media-type", "application/oebps-package+xml"))));
        RequireEqual(container, expectedContainer, "container");
        XElement package = Parse(entries["EPUB/package.opf"], budgets.MaxFileBytes, cancellationToken);
        ValidatePackage(package, metadata, resources);
        XElement chapter = Parse(entries["EPUB/chapter-0001.xhtml"], budgets.MaxFileBytes, cancellationToken);
        XElement navigation = Parse(entries["EPUB/nav.xhtml"], budgets.MaxFileBytes, cancellationToken);
        var documents = new Dictionary<string, XElement>(StringComparer.Ordinal)
        {
            ["EPUB/chapter-0001.xhtml"] = chapter,
            ["EPUB/nav.xhtml"] = navigation
        };
        foreach ((string path, XElement document) in documents)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ValidateDocument(path, document, metadata, entries, documents, cancellationToken);
        }
        XElement article = chapter.Element(s_xhtml + "body")?.Element(s_xhtml + "main")?.Element(s_xhtml + "article")
            ?? throw new InvalidDataException("EPUB has no semantic reading article.");
        EpubXmlBudget.Validate("<article>" + response.HtmlFragment + "</article>", budgets.MaxInputBytes, cancellationToken);
        byte[] sanitized = DocumentExportHtmlSanitizer.Sanitize(response.HtmlFragment, input.Assets, Math.Min(budgets.MaxOutputBytes, EpubXmlBudget.MaximumBytes));
        XElement expectedArticle = Parse(Encoding.UTF8.GetBytes("<article>" + Encoding.UTF8.GetString(sanitized) + "</article>"),
            budgets.MaxOutputBytes, cancellationToken, requireDeclaration: false);
        foreach (XElement element in expectedArticle.DescendantsAndSelf())
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (element.Name.Namespace == XNamespace.None)
            {
                element.Name = s_xhtml + element.Name.LocalName;
            }
            string? role = (string?)element.Attribute("role");
            if (role is "doc-noteref" or "doc-footnote")
            {
                element.SetAttributeValue(s_epub + "type", role == "doc-noteref" ? "noteref" : "footnote");
            }
            if (element.Name == s_xhtml + "img")
            {
                DocumentExportAsset asset = input.Assets.Single(asset => asset.AssetId == (string?)element.Attribute("data-asset-id"));
                element.SetAttributeValue("src", $"resources/r-{asset.Sha256[7..]}.png");
                element.Attribute("data-asset-id")!.Remove();
            }
        }
        expectedArticle.SetAttributeValue("id", "epub-reading-start");
        RequireEqual(article, expectedArticle, "canonical content order, references and semantic markup");
        XElement expectedBody = new(s_xhtml + "body", new XElement(s_xhtml + "main", new XElement(article)));
        RequireEqual(chapter.Element(s_xhtml + "body")!, expectedBody, "chapter body");
        ValidateNavigation(navigation, metadata);
        bool svg = article.Descendants().Any(element => element.Name.Namespace == s_svg);
        XElement chapterItem = package.Element(s_opf + "manifest")!.Elements(s_opf + "item")
            .Single(item => (string?)item.Attribute("id") == "chapter-0001");
        if ((string?)chapterItem.Attribute("properties") != (svg ? "svg" : null))
        {
            throw new InvalidDataException("EPUB SVG manifest property does not describe actual content.");
        }
        ValidateStyle(entries["EPUB/reading.css"], input, budgets.MaxOutputBytes);
        string[] warnings = ["chapters:fixed-single-chapter-no-heading-facts", "fonts:reader-glyph-coverage-not-certified"];
        string semanticDigest = DocumentExportDigest.Compute(entries.OrderBy(entry => entry.Key, StringComparer.Ordinal)
            .Select(entry => new { Path = entry.Key, Digest = DocumentExportDigest.ComputeBytes(entry.Value.Span), Bytes = entry.Value.Length }).ToArray());
        return new EpubPackageValidation(EpubPackageBuilder.ValidatorIdentity, EpubPackageBuilder.ChapterPolicy,
            DocumentExportDigest.ComputeBytes(bytes), semanticDigest, bytes.LongLength, 1, 1, resources.Count,
            response.ObservedFeatures.OrderBy(feature => feature, StringComparer.Ordinal).ToImmutableArray(), warnings.ToImmutableArray());
    }

    private static void ValidatePackage(XElement package, EpubPublicationMetadata metadata,
        IReadOnlyDictionary<string, DocumentExportAsset> resources)
    {
        if (package.Name != s_opf + "package")
        {
            throw new InvalidDataException("EPUB package namespace is invalid.");
        }
        RequireAttributes(package, new Dictionary<XName, string>
        {
            ["version"] = "3.0",
            ["unique-identifier"] = "publication-id",
            ["dir"] = metadata.Direction,
            [XNamespace.Xml + "lang"] = metadata.Language,
            ["prefix"] = "schema: http://schema.org/"
        });
        if (!package.Elements().Select(element => element.Name).SequenceEqual(new[] { s_opf + "metadata", s_opf + "manifest", s_opf + "spine" }))
        {
            throw new InvalidDataException("EPUB package sections are missing, duplicated or reordered.");
        }
        RequireElementChildren(package);
        XElement meta = package.Element(s_opf + "metadata")!;
        var expectedMetadata = new XElement(s_opf + "metadata",
            new XElement(s_dc + "identifier", new XAttribute("id", "publication-id"), metadata.Identifier),
            new XElement(s_dc + "title", metadata.Title), new XElement(s_dc + "language", metadata.Language),
            metadata.Authors.Select(author => new XElement(s_dc + "creator", author)),
            new XElement(s_opf + "meta", new XAttribute("property", "dcterms:modified"), metadata.Modified),
            new XElement(s_opf + "meta", new XAttribute("property", "schema:accessMode"), "textual"),
            resources.Values.Any(asset => asset.Role == "image")
                ? new XElement(s_opf + "meta", new XAttribute("property", "schema:accessMode"), "visual") : null,
            new XElement(s_opf + "meta", new XAttribute("property", "schema:accessibilityFeature"), "tableOfContents"),
            new XElement(s_opf + "meta", new XAttribute("property", "schema:accessibilityFeature"), "readingOrder"),
            new XElement(s_opf + "meta", new XAttribute("property", "schema:accessibilitySummary"),
                "Single canonical chapter with navigation, preserved semantic content and frozen image alternatives. Reader font coverage is not certified."));
        RequireEqual(meta, expectedMetadata, "frozen metadata and accessibility facts");
        XElement manifest = package.Element(s_opf + "manifest")!;
        RequireAttributes(manifest, new Dictionary<XName, string>());
        RequireElementChildren(manifest);
        var expected = new Dictionary<string, (string Id, string Mime)>(StringComparer.Ordinal)
        {
            ["nav.xhtml"] = ("nav", "application/xhtml+xml"),
            ["chapter-0001.xhtml"] = ("chapter-0001", "application/xhtml+xml"),
            ["reading.css"] = ("reading-style", "text/css")
        };
        foreach ((string path, DocumentExportAsset asset) in resources)
        {
            expected.Add(path[5..], ("r-" + asset.Sha256[7..], asset.MediaType));
        }
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (XElement item in manifest.Elements())
        {
            string href = (string?)item.Attribute("href") ?? string.Empty;
            if (item.Name != s_opf + "item" || !expected.TryGetValue(href, out var fact)
                || !seen.Add(href) || !ids.Add(fact.Id) || item.HasElements || item.Value.Length != 0)
            {
                throw new InvalidDataException("EPUB manifest ID, MIME, resource or closure is invalid.");
            }
            var attributes = new Dictionary<XName, string> { ["id"] = fact.Id, ["href"] = href, ["media-type"] = fact.Mime };
            if (href == "nav.xhtml")
            {
                attributes.Add("properties", "nav");
            }
            else if (href == "chapter-0001.xhtml" && item.Attribute("properties") is not null)
            {
                attributes.Add("properties", "svg");
            }
            RequireAttributes(item, attributes);
        }
        if (!seen.SetEquals(expected.Keys))
        {
            throw new InvalidDataException("EPUB manifest does not cover all publication resources.");
        }
        RequireEqual(package.Element(s_opf + "spine")!, new XElement(s_opf + "spine",
            new XAttribute("page-progression-direction", metadata.Direction),
            new XElement(s_opf + "itemref", new XAttribute("idref", "chapter-0001"))), "spine order");
    }

    private static void ValidateDocument(string path, XElement document, EpubPublicationMetadata metadata,
        IReadOnlyDictionary<string, ReadOnlyMemory<byte>> entries, IReadOnlyDictionary<string, XElement> documents, CancellationToken cancellationToken)
    {
        if (document.Name != s_xhtml + "html"
            || !document.Elements().Select(element => element.Name).SequenceEqual(new[] { s_xhtml + "head", s_xhtml + "body" }))
        {
            throw new InvalidDataException("EPUB XHTML root or head/body closure is invalid.");
        }
        RequireAttributes(document, new Dictionary<XName, string>
        {
            ["lang"] = metadata.Language,
            [XNamespace.Xml + "lang"] = metadata.Language,
            ["dir"] = metadata.Direction
        });
        RequireElementChildren(document);
        RequireEqual(document.Element(s_xhtml + "head")!, new XElement(s_xhtml + "head",
            new XElement(s_xhtml + "title", metadata.Title),
            new XElement(s_xhtml + "link", new XAttribute("rel", "stylesheet"),
                new XAttribute("type", "text/css"), new XAttribute("href", "reading.css"))), "XHTML head");
        var ids = new HashSet<string>(StringComparer.Ordinal);
        var documentIds = documents.ToDictionary(item => item.Key, item => item.Value.DescendantsAndSelf()
            .Attributes("id").Select(attribute => attribute.Value).ToHashSet(StringComparer.Ordinal), StringComparer.Ordinal);
        foreach (XElement element in document.DescendantsAndSelf())
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (element.Name.Namespace == s_xhtml ? !s_elements.Contains(element.Name.LocalName)
                : element.Name.Namespace != s_svg || !s_svgElements.Contains(element.Name.LocalName))
            {
                throw new InvalidDataException("EPUB contains active or unknown markup.");
            }
            if (element.Name.Namespace == s_xhtml)
            {
                ValidateXhtmlContentModel(element);
                ValidateXhtmlAttributeValues(element);
            }
            if (element.Attribute("id") is XAttribute id
                && (id.Value.Length == 0 || id.Value.Length > 160
                    || !id.Value.All(character => char.IsAsciiLetterOrDigit(character) || character is '-' or '_' or ':' or '.')
                    || !ids.Add(id.Value)))
            {
                throw new InvalidDataException("EPUB XHTML IDs are malformed or duplicated.");
            }
            foreach (XAttribute attribute in element.Attributes().Where(attribute => !attribute.IsNamespaceDeclaration))
            {
                string name = attribute.Name.LocalName;
                if (name.StartsWith("on", StringComparison.OrdinalIgnoreCase)
                    || name is "style" or "srcset" or "srcdoc" or "formaction" or "poster" or "base" or "data-asset-id"
                    || attribute.Name.Namespace != XNamespace.None
                        && attribute.Name != XNamespace.Xml + "lang" && attribute.Name != s_epub + "type"
                    || attribute.Value.Any(char.IsControl))
                {
                    throw new InvalidDataException("EPUB contains active, private or unknown attributes.");
                }
            }
            if (element.Name == s_xhtml + "img" && (element.Attribute("alt") is null
                || string.IsNullOrWhiteSpace((string?)element.Attribute("alt")) && (string?)element.Attribute("role") != "presentation"))
            {
                throw new InvalidDataException("EPUB image lacks a frozen accessible alternative.");
            }
            if (element.Name == s_xhtml + "a" && string.IsNullOrWhiteSpace(element.Value)
                && string.IsNullOrWhiteSpace((string?)element.Attribute("aria-label"))
                && !element.Descendants(s_xhtml + "img").Any(image => !string.IsNullOrWhiteSpace((string?)image.Attribute("alt"))))
            {
                throw new InvalidDataException("EPUB link has no accessible text.");
            }
        }
        foreach (XElement element in document.DescendantsAndSelf())
        {
            cancellationToken.ThrowIfCancellationRequested();
            foreach (string attributeName in new[] { "aria-describedby", "aria-labelledby", "headers" })
            {
                if (element.Attribute(attributeName) is XAttribute attribute
                    && attribute.Value.Split(' ', StringSplitOptions.RemoveEmptyEntries).Any(id => !ids.Contains(id)))
                {
                    throw new InvalidDataException("EPUB accessibility or table IDREF is unresolved.");
                }
            }
            foreach (string attributeName in new[] { "fill", "stroke" })
            {
                if (element.Attribute(attributeName) is XAttribute paint && paint.Value.Contains("url(", StringComparison.OrdinalIgnoreCase)
                    && (!paint.Value.StartsWith("url(#", StringComparison.Ordinal) || !paint.Value.EndsWith(')')
                        || !ids.Contains(paint.Value[5..^1])))
                {
                    throw new InvalidDataException("EPUB SVG resource reference is unresolved or remote.");
                }
            }
            foreach (string attributeName in new[] { "href", "src" })
            {
                if (element.Attribute(attributeName) is not XAttribute reference)
                {
                    continue;
                }
                bool externalLink = element.Name == s_xhtml + "a" && attributeName == "href"
                    && Uri.TryCreate(reference.Value, UriKind.Absolute, out Uri? uri)
                    && uri.Scheme is "https" or "http" && uri.UserInfo.Length == 0;
                if (externalLink)
                {
                    if ((string?)element.Attribute("rel") != "noopener noreferrer external" || (string?)element.Attribute("target") != "_blank")
                    {
                        throw new InvalidDataException("EPUB external link safety attributes are missing.");
                    }
                    continue;
                }
                string[] parts = reference.Value.Split('#');
                string targetPath = parts[0].Length == 0 ? path : "EPUB/" + parts[0];
                if (parts.Length > 2 || parts.Length == 2 && parts[1].Length == 0
                    || !entries.ContainsKey(targetPath)
                    || attributeName == "src" && !targetPath.StartsWith("EPUB/resources/", StringComparison.Ordinal)
                    || parts.Length == 2 && (!documentIds.TryGetValue(targetPath, out HashSet<string>? targetIds)
                        || !targetIds.Contains(parts[1])))
                {
                    throw new InvalidDataException("EPUB local link or media reference is unresolved or unsafe.");
                }
            }
        }
    }

    // This is a closed, passive XHTML subset, not browser repair. Validate the actual
    // package before semantic comparison so an equally invalid frozen fragment cannot pass.
    private static void ValidateXhtmlContentModel(XElement element)
    {
        string name = element.Name.LocalName;
        XElement[] children = element.Elements().ToArray();
        string? parent = element.Parent?.Name.Namespace == s_xhtml ? element.Parent.Name.LocalName : null;
        bool valid = name switch
        {
            "html" => parent is null,
            "head" or "body" => parent == "html",
            "title" => parent == "head" && children.Length == 0,
            "link" => parent == "head" && !element.Nodes().Any(),
            "img" or "br" or "hr" => !element.Nodes().Any(),
            "ul" or "ol" => OnlyElementChildren(element, "li"),
            "dl" => ValidDefinitionList(element),
            "table" => ValidTable(element),
            "thead" or "tbody" or "tfoot" => parent == "table" && OnlyElementChildren(element, "tr"),
            "tr" => parent is "table" or "thead" or "tbody" or "tfoot" && OnlyElementChildren(element, "th", "td"),
            "li" => parent is "ul" or "ol" && HasFlowChildren(element),
            "dt" => parent == "dl" && HasPhrasingChildren(element),
            "dd" => parent == "dl" && HasFlowChildren(element),
            "th" or "td" => parent == "tr" && HasFlowChildren(element),
            "caption" => parent == "table" && HasFlowChildren(element) && !element.Descendants(s_xhtml + "table").Any(),
            "figcaption" => parent == "figure" && HasFlowChildren(element),
            "figure" => ValidFigure(element),
            "details" => children.FirstOrDefault()?.Name == s_xhtml + "summary"
                && children.Count(child => child.Name == s_xhtml + "summary") == 1
                && element.Nodes().TakeWhile(node => node != children[0]).OfType<XText>()
                    .All(text => text.Value.All(character => character is ' ' or '\t' or '\n'))
                && children.Skip(1).All(IsFlow),
            "summary" => parent == "details" && (HasPhrasingChildren(element)
                || children.Length == 1 && children[0].Name.Namespace == s_xhtml
                    && children[0].Name.LocalName is "h1" or "h2" or "h3" or "h4" or "h5" or "h6"
                    && HasOnlyInterelementWhitespace(element)),
            "p" or "h1" or "h2" or "h3" or "h4" or "h5" or "h6" or "pre" => HasPhrasingChildren(element),
            "a" or "del" or "ins" => HasFlowChildren(element),
            _ => s_phrasingElements.Contains(name) ? HasPhrasingChildren(element) : HasFlowChildren(element)
        };
        // Anchors are transparent, but the supported interactive elements cannot be
        // descendants. Keep legal flow/block links while refusing nested details.
        if (name == "a" && element.Descendants().Any(child =>
            child.Name.Namespace == s_xhtml && child.Name.LocalName is "a" or "details"
                || child.Attribute("tabindex") is not null)
            || name is "pre" or "code" && element.Descendants(s_xhtml + "pre").Any())
        {
            valid = false;
        }
        if (!valid)
        {
            throw new InvalidDataException("EPUB XHTML content model is invalid or outside the closed supported subset.");
        }
    }

    private static bool HasPhrasingChildren(XElement element) => element.Elements().All(child =>
        child.Name == s_svg + "svg" || child.Name.Namespace == s_xhtml && s_phrasingElements.Contains(child.Name.LocalName)
            && (child.Name.LocalName is not ("a" or "del" or "ins") || HasPhrasingChildren(child)));

    private static bool IsFlow(XElement element) => element.Name == s_svg + "svg"
        || element.Name.Namespace == s_xhtml && s_flowElements.Contains(element.Name.LocalName);

    private static bool HasFlowChildren(XElement element) => element.Elements().All(IsFlow);

    private static bool HasOnlyInterelementWhitespace(XElement element) => element.Nodes()
        .OfType<XText>().All(text => text.Value.All(character => character is ' ' or '\t' or '\n'));

    private static bool OnlyElementChildren(XElement element, params string[] names) => HasOnlyInterelementWhitespace(element)
        && element.Elements().All(child => child.Name.Namespace == s_xhtml && names.Contains(child.Name.LocalName, StringComparer.Ordinal));

    private static bool ValidDefinitionList(XElement element)
    {
        if (!OnlyElementChildren(element, "dt", "dd"))
        {
            return false;
        }
        bool hasTerm = false;
        bool hasDefinition = false;
        foreach (XElement child in element.Elements())
        {
            if (child.Name.LocalName == "dt")
            {
                if (hasDefinition)
                {
                    hasTerm = false;
                    hasDefinition = false;
                }
                hasTerm = true;
            }
            else
            {
                if (!hasTerm)
                {
                    return false;
                }
                hasDefinition = true;
            }
        }
        return !hasTerm || hasDefinition;
    }

    private static bool ValidTable(XElement element)
    {
        if (!OnlyElementChildren(element, "caption", "thead", "tbody", "tr", "tfoot"))
        {
            return false;
        }
        XElement[] children = element.Elements().ToArray();
        int index = 0;
        if (index < children.Length && children[index].Name.LocalName == "caption")
        {
            index++;
        }
        if (index < children.Length && children[index].Name.LocalName == "thead")
        {
            index++;
        }
        string rowKind = index < children.Length && children[index].Name.LocalName == "tr" ? "tr" : "tbody";
        while (index < children.Length && children[index].Name.LocalName == rowKind)
        {
            index++;
        }
        if (index < children.Length && children[index].Name.LocalName == "tfoot")
        {
            index++;
        }
        return index == children.Length;
    }

    private static bool ValidFigure(XElement element)
    {
        XElement[] children = element.Elements().ToArray();
        XElement[] captions = children.Where(child => child.Name == s_xhtml + "figcaption").ToArray();
        // Text participates in caption placement; only HTML interelement whitespace
        // is ignored. Nonbreaking spaces are content, not formatting whitespace.
        XNode[] content = element.Nodes().Where(node => node is not XText text
            || text.Value.Any(character => character is not (' ' or '\t' or '\n'))).ToArray();
        return captions.Length <= 1 && (captions.Length == 0 || captions[0] == content[0] || captions[0] == content[^1])
            && children.All(child => child.Name == s_xhtml + "figcaption" || IsFlow(child));
    }

    private static void ValidateXhtmlAttributeValues(XElement element)
    {
        foreach (XAttribute attribute in element.Attributes().Where(attribute => attribute.Name.Namespace == XNamespace.None
            || attribute.Name == XNamespace.Xml + "lang"))
        {
            string value = attribute.Value;
            bool valid = attribute.Name.LocalName switch
            {
                "colspan" => element.Name.LocalName is "th" or "td" && IsUnsignedInteger(value, 1, 1000),
                "rowspan" => element.Name.LocalName is "th" or "td" && IsUnsignedInteger(value, 0, 65534),
                "width" or "height" => element.Name.LocalName == "img" && IsUnsignedInteger(value, 0, 100000),
                "scope" => element.Name.LocalName == "th" && value is "row" or "col" or "rowgroup" or "colgroup",
                "dir" => value is "ltr" or "rtl" or "auto",
                "lang" => IsLanguageTag(value),
                "datetime" => element.Name.LocalName == "time" && IsTemporalValue(value),
                "type" => element.Name.LocalName == "link" ? value == "text/css"
                    : element.Name.LocalName == "ol" && value is "1" or "a" or "A" or "i" or "I",
                "reversed" => element.Name.LocalName == "ol" && value is "" or "reversed",
                "open" => element.Name.LocalName == "details" && value is "" or "open",
                "start" or "tabindex" => Regex.IsMatch(value, "^-?[0-9]+$", RegexOptions.CultureInvariant)
                    && int.TryParse(value, System.Globalization.NumberStyles.AllowLeadingSign,
                        System.Globalization.CultureInfo.InvariantCulture, out _),
                _ => true
            };
            if (!valid)
            {
                throw new InvalidDataException("EPUB XHTML attribute value is invalid or outside the closed supported subset.");
            }
        }
    }

    // Content language may be empty (unknown) or use BCP47 syntax beyond the
    // publication metadata's deliberately narrower policy. Neither value is rewritten.
    private static bool IsLanguageTag(string value)
    {
        if (value.Length == 0 || s_grandfatheredLanguages.Contains(value))
        {
            return true;
        }
        string[] parts = value.Split('-');
        if (parts.Any(part => part.Length is < 1 or > 8 || !part.All(char.IsAsciiLetterOrDigit)))
        {
            return false;
        }
        if (parts[0].Equals("x", StringComparison.OrdinalIgnoreCase))
        {
            return parts.Length > 1;
        }
        if (parts[0].Length < 2 || !parts[0].All(char.IsAsciiLetter))
        {
            return false;
        }
        int index = 1;
        if (parts[0].Length <= 3)
        {
            for (int count = 0; count < 3 && index < parts.Length && parts[index].Length == 3
                && parts[index].All(char.IsAsciiLetter); count++)
            {
                index++;
            }
        }
        if (index < parts.Length && parts[index].Length == 4 && parts[index].All(char.IsAsciiLetter))
        {
            index++;
        }
        if (index < parts.Length && (parts[index].Length == 2 && parts[index].All(char.IsAsciiLetter)
            || parts[index].Length == 3 && parts[index].All(char.IsAsciiDigit)))
        {
            index++;
        }
        var variants = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        while (index < parts.Length && (parts[index].Length >= 5
            || parts[index].Length == 4 && char.IsAsciiDigit(parts[index][0])))
        {
            if (!variants.Add(parts[index++]))
            {
                return false;
            }
        }
        var singletons = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        while (index < parts.Length && parts[index].Length == 1 && !parts[index].Equals("x", StringComparison.OrdinalIgnoreCase))
        {
            if (!singletons.Add(parts[index++]))
            {
                return false;
            }
            int start = index;
            while (index < parts.Length && parts[index].Length >= 2)
            {
                index++;
            }
            if (start == index)
            {
                return false;
            }
        }
        return index == parts.Length || parts[index].Equals("x", StringComparison.OrdinalIgnoreCase) && index + 1 < parts.Length;
    }

    // Validate calendar/clock components without culture parsing, timezone conversion,
    // whitespace collapse or DateTime's year/offset limits. Duration support is ISO only.
    private static bool IsTemporalValue(string value)
    {
        if (value.StartsWith('P'))
        {
            return value.Length > 1 && !value.EndsWith('T') && s_durationValue.IsMatch(value);
        }
        Match match = s_temporalValue.Match(value);
        if (!match.Success || !TemporalPartInRange(match, "month", 1, 12)
            || !TemporalPartInRange(match, "hour", 0, 23) || !TemporalPartInRange(match, "minute", 0, 59)
            || !TemporalPartInRange(match, "second", 0, 59) || !TemporalPartInRange(match, "offsetHour", 0, 23)
            || !TemporalPartInRange(match, "offsetMinute", 0, 59) || !TemporalPartInRange(match, "week", 1, 53))
        {
            return false;
        }
        int yearModulo = 4; // Yearless February permits leap day.
        if (match.Groups["year"].Success)
        {
            string year = match.Groups["year"].Value;
            if (!year.Any(character => character != '0')
                || !match.Groups["month"].Success && !match.Groups["week"].Success && year.Length != 4)
            {
                return false;
            }
            yearModulo = 0;
            foreach (char digit in year)
            {
                yearModulo = (yearModulo * 10 + digit - '0') % 400;
            }
        }
        int calendarYear = yearModulo == 0 ? 400 : yearModulo;
        if (match.Groups["day"].Success
            && !TemporalPartInRange(match, "day", 1, DateTime.DaysInMonth(calendarYear,
                int.Parse(match.Groups["month"].Value, CultureInfo.InvariantCulture))))
        {
            return false;
        }
        return !match.Groups["week"].Success || TemporalPartInRange(match, "week", 1, ISOWeek.GetWeeksInYear(calendarYear));
    }

    private static bool TemporalPartInRange(Match match, string name, int minimum, int maximum)
        => !match.Groups[name].Success || IsUnsignedInteger(match.Groups[name].Value, minimum, maximum);

    private static bool IsUnsignedInteger(string value, int minimum, int maximum) => value.Length > 0
        && value.All(char.IsAsciiDigit) && int.TryParse(value, System.Globalization.NumberStyles.None,
            System.Globalization.CultureInfo.InvariantCulture, out int number) && number >= minimum && number <= maximum;

    private static void ValidateNavigation(XElement document, EpubPublicationMetadata metadata)
    {
        RequireEqual(document.Element(s_xhtml + "body")!, new XElement(s_xhtml + "body",
            new XElement(s_xhtml + "nav", new XAttribute(s_epub + "type", "toc"), new XAttribute("id", "toc"),
                new XElement(s_xhtml + "h1", metadata.Title),
                new XElement(s_xhtml + "ol", new XElement(s_xhtml + "li", new XElement(s_xhtml + "a",
                    new XAttribute("href", "chapter-0001.xhtml#epub-reading-start"), metadata.Title)))),
            new XElement(s_xhtml + "nav", new XAttribute(s_epub + "type", "landmarks"),
                new XElement(s_xhtml + "h2", "Reading order"),
                new XElement(s_xhtml + "ol", new XElement(s_xhtml + "li", new XElement(s_xhtml + "a",
                    new XAttribute(s_epub + "type", "bodymatter"),
                    new XAttribute("href", "chapter-0001.xhtml#epub-reading-start"), metadata.Title))))), "navigation and landmarks");
    }

    private static void ValidateStyle(ReadOnlyMemory<byte> bytes, DocumentExportFrozenInput input, long maximumBytes)
    {
        string expected = Encoding.UTF8.GetString(DocumentExportReadingStyleAuthority.BuildStyleBytes(input.Assets, input.ThemeProfile, maximumBytes));
        foreach (DocumentExportAsset font in input.Assets.Where(asset => asset.Role == "font"))
        {
            expected = expected.Replace($"data:{font.MediaType};base64,{Convert.ToBase64String(font.Bytes.AsSpan())}",
                $"resources/r-{font.Sha256[7..]}.woff2", StringComparison.Ordinal);
        }
        string actual = new UTF8Encoding(false, true).GetString(bytes.Span);
        if (actual != expected || actual.Contains("@import", StringComparison.OrdinalIgnoreCase)
            || Regex.Matches(actual, "url\\(([^)]+)\\)", RegexOptions.CultureInvariant)
                .Any(match => !input.Assets.Any(asset => asset.Role == "font"
                    && match.Groups[1].Value == $"resources/r-{asset.Sha256[7..]}.woff2")))
        {
            throw new InvalidDataException("EPUB CSS drifted from frozen reading styles or references remote resources.");
        }
    }

    private static XElement Parse(ReadOnlyMemory<byte> bytes, long maximumBytes, CancellationToken cancellationToken,
        bool requireDeclaration = true)
    {
        try
        {
            EpubXmlBudget.Validate(new UTF8Encoding(false, true).GetString(bytes.Span), maximumBytes, cancellationToken);
            using var source = new MemoryStream(bytes.ToArray(), writable: false);
            using var text = new StreamReader(source, new UTF8Encoding(false, true), detectEncodingFromByteOrderMarks: false);
            using XmlReader reader = XmlReader.Create(text, new XmlReaderSettings
            {
                DtdProcessing = DtdProcessing.Prohibit,
                XmlResolver = null,
                MaxCharactersInDocument = maximumBytes,
                MaxCharactersFromEntities = 0,
                IgnoreComments = false,
                IgnoreProcessingInstructions = false
            });
            XDocument document = XDocument.Load(reader, LoadOptions.PreserveWhitespace);
            if (requireDeclaration && (document.Declaration?.Version != "1.0"
                || document.Declaration.Encoding != "utf-8" || document.Declaration.Standalone is not null))
            {
                throw new InvalidDataException("EPUB XML declaration does not match its normalized UTF-8 bytes.");
            }
            if (document.Root is null || document.Nodes().Any(node => node != document.Root)
                || document.Root.DescendantNodes().Any(node => node is not (XElement or XText) || node is XCData))
            {
                throw new InvalidDataException("EPUB XML contains prohibited document nodes.");
            }
            foreach (XElement element in document.Root.DescendantsAndSelf())
            {
                cancellationToken.ThrowIfCancellationRequested();
                foreach (XAttribute declaration in element.Attributes().Where(attribute => attribute.IsNamespaceDeclaration))
                {
                    bool validDefault = declaration.Name.LocalName == "xmlns" && declaration.Value == element.Name.NamespaceName
                        && (element == document.Root && element.Name.NamespaceName is "http://www.w3.org/1999/xhtml"
                            or "http://www.idpf.org/2007/opf" or "urn:oasis:names:tc:opendocument:xmlns:container"
                            || element.Name == s_svg + "svg");
                    bool validEpub = declaration.Name == XNamespace.Xmlns + "epub"
                        && declaration.Value == s_epub.NamespaceName && element == document.Root && element.Name == s_xhtml + "html";
                    bool validDc = declaration.Name == XNamespace.Xmlns + "dc"
                        && declaration.Value == s_dc.NamespaceName && element.Name == s_opf + "metadata";
                    if (!validDefault && !validEpub && !validDc)
                    {
                        throw new InvalidDataException("EPUB contains an unowned or noncanonical namespace binding.");
                    }
                }
            }
            return document.Root;
        }
        catch (Exception exception) when (exception is XmlException or DecoderFallbackException)
        {
            throw new InvalidDataException("EPUB XML is malformed or not UTF-8.", exception);
        }
    }

    private static void RequireAttributes(XElement element, IReadOnlyDictionary<XName, string> expected)
    {
        XAttribute[] actual = element.Attributes().Where(attribute => !attribute.IsNamespaceDeclaration).ToArray();
        if (actual.Length != expected.Count || actual.Any(attribute => !expected.TryGetValue(attribute.Name, out string? value) || attribute.Value != value))
        {
            throw new InvalidDataException("EPUB package attributes are missing, extra or drifted.");
        }
    }

    private static void RequireElementChildren(XElement element)
    {
        if (element.Nodes().Any(node => node is not XElement))
        {
            throw new InvalidDataException("EPUB structural containers contain unowned text or document nodes.");
        }
    }

    private static void RequireEqual(XElement actual, XElement expected, string purpose)
    {
        static XElement Normalize(XElement source)
        {
            var clone = new XElement(source);
            foreach (XElement element in clone.DescendantsAndSelf())
            {
                foreach (XAttribute attribute in element.Attributes().Where(attribute => attribute.IsNamespaceDeclaration).ToArray())
                {
                    attribute.Remove();
                }
                XAttribute[] ordered = element.Attributes().OrderBy(attribute => attribute.Name.ToString(), StringComparer.Ordinal).ToArray();
                element.RemoveAttributes();
                element.Add(ordered);
            }
            return clone;
        }
        if (!XNode.DeepEquals(Normalize(actual), Normalize(expected)))
        {
            throw new InvalidDataException($"EPUB {purpose} drifted from its closed frozen policy.");
        }
    }
}
