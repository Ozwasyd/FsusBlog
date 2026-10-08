using System.Globalization;
using System.Text;
using System.Xml;

namespace FsusBlog.Server.Services.DocumentExport;

internal static class DocumentExportHtmlSanitizer
{
    private const string XhtmlNamespace = "http://www.w3.org/1999/xhtml";
    private const string SvgNamespace = "http://www.w3.org/2000/svg";

    private static readonly HashSet<string> s_htmlElements = new(StringComparer.Ordinal)
    {
        "h1", "h2", "h3", "h4", "h5", "h6", "p", "div", "span", "section", "aside",
        "blockquote", "ul", "ol", "li", "dl", "dt", "dd", "pre", "code", "kbd", "samp",
        "strong", "em", "b", "i", "u", "s", "del", "ins", "mark", "small", "sup", "sub",
        "a", "img", "figure", "figcaption", "table", "thead", "tbody", "tfoot", "tr", "th",
        "td", "caption", "hr", "br", "details", "summary", "abbr", "time", "q", "cite", "svg"
    };

    private static readonly HashSet<string> s_svgElements = new(StringComparer.Ordinal)
    {
        "svg", "g", "path", "line", "polyline", "polygon", "circle", "ellipse", "rect", "text",
        "tspan", "title", "desc", "defs", "marker"
    };

    private static readonly HashSet<string> s_globalAttributes = new(StringComparer.Ordinal)
    {
        "id", "class", "dir", "lang", "title", "role", "aria-label", "aria-describedby",
        "aria-labelledby", "data-embed"
    };

    private static readonly IReadOnlyDictionary<string, HashSet<string>> s_htmlAttributes =
        new Dictionary<string, HashSet<string>>(StringComparer.Ordinal)
        {
            ["a"] = new(StringComparer.Ordinal) { "href", "target", "rel" },
            ["img"] = new(StringComparer.Ordinal) { "data-asset-id", "src", "alt", "width", "height" },
            ["th"] = new(StringComparer.Ordinal) { "colspan", "rowspan", "scope", "headers" },
            ["td"] = new(StringComparer.Ordinal) { "colspan", "rowspan", "headers" },
            ["ol"] = new(StringComparer.Ordinal) { "start", "reversed", "type" },
            ["details"] = new(StringComparer.Ordinal) { "open" },
            ["time"] = new(StringComparer.Ordinal) { "datetime" },
            ["code"] = new(StringComparer.Ordinal) { "tabindex" },
            ["figure"] = new(StringComparer.Ordinal) { "data-mermaid-rendered", "data-mermaid-width", "data-mermaid-height" }
        };

    private static readonly HashSet<string> s_svgAttributes = new(StringComparer.Ordinal)
    {
        "xmlns", "viewBox", "width", "height", "fill", "stroke", "stroke-width", "d", "x", "y",
        "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "points", "transform",
        "text-anchor", "dominant-baseline", "role", "aria-label", "aria-describedby", "id", "class"
    };

    private static readonly IReadOnlyDictionary<string, HashSet<string>> s_svgElementAttributes =
        new Dictionary<string, HashSet<string>>(StringComparer.Ordinal)
        {
            ["svg"] = new(StringComparer.Ordinal) { "preserveAspectRatio" },
            ["marker"] = new(StringComparer.Ordinal) { "refX", "refY", "markerWidth", "markerHeight", "orient" },
            ["line"] = new(StringComparer.Ordinal) { "marker-end" },
            ["text"] = new(StringComparer.Ordinal) { "font-size", "font-family" }
        };

    internal static byte[] Sanitize(
        string fragment,
        IReadOnlyList<DocumentExportAsset> assets,
        long maximumBytes)
    {
        ArgumentNullException.ThrowIfNull(fragment);
        Dictionary<string, DocumentExportAsset> images = assets
            .Where(asset => asset.Role == "image")
            .ToDictionary(asset => asset.AssetId, StringComparer.Ordinal);
        var seenImages = new HashSet<string>(StringComparer.Ordinal);
        var ids = new HashSet<string>(StringComparer.Ordinal);
        var anchorReferences = new HashSet<string>(StringComparer.Ordinal);
        SvgScope? svgScope = null;

        XmlReaderSettings readerSettings = new()
        {
            Async = false,
            ConformanceLevel = ConformanceLevel.Document,
            DtdProcessing = DtdProcessing.Prohibit,
            XmlResolver = null,
            IgnoreComments = false,
            IgnoreProcessingInstructions = false,
            MaxCharactersInDocument = maximumBytes,
            MaxCharactersFromEntities = 0
        };
        XmlWriterSettings writerSettings = new()
        {
            Encoding = new UTF8Encoding(false, true),
            OmitXmlDeclaration = true,
            ConformanceLevel = ConformanceLevel.Fragment,
            NewLineHandling = NewLineHandling.None,
            NamespaceHandling = NamespaceHandling.OmitDuplicates,
            CloseOutput = false
        };

        try
        {
            using TextReader source = new SequenceTextReader(
                new StringReader($"<article xmlns=\"{XhtmlNamespace}\">"),
                new StringReader(fragment),
                new StringReader("</article>"));
            using XmlReader reader = XmlReader.Create(source, readerSettings);
            using var output = new DocumentExportBoundedMemoryStream(
                maximumBytes,
                "Sanitized HTML fragment exceeds its output budget.",
                "output-budget");
            using XmlWriter writer = XmlWriter.Create(output, writerSettings);

            if (!reader.Read() || reader.NodeType != XmlNodeType.Element
                || reader.LocalName != "article" || reader.NamespaceURI != XhtmlNamespace)
            {
                throw new InvalidDataException("Canonical renderer fragment wrapper is invalid.");
            }

            while (reader.Read())
            {
                if (reader.NodeType == XmlNodeType.EndElement && reader.Depth == 0)
                {
                    // A renderer-supplied closing tag must not hide unread fragment content.
                    if (reader.Read() || !reader.EOF)
                    {
                        throw new InvalidDataException("Canonical renderer fragment has content after its wrapper.");
                    }
                    break;
                }
                switch (reader.NodeType)
                {
                    case XmlNodeType.Element:
                        if (reader.NamespaceURI == SvgNamespace && reader.LocalName == "svg")
                        {
                            if (svgScope is not null)
                            {
                                throw new InvalidDataException("Nested SVG documents are outside the closed diagram contract.");
                            }
                            svgScope = new SvgScope(reader.Depth);
                        }
                        WriteStartElement(reader, writer, images, seenImages, ids, anchorReferences, svgScope);
                        if (reader.IsEmptyElement)
                        {
                            if (reader.NamespaceURI == XhtmlNamespace && reader.LocalName is not ("img" or "br" or "hr"))
                            {
                                // HTML5 ignores the self-closing flag on ordinary HTML
                                // elements. Preserve the renderer's empty-node semantics.
                                writer.WriteFullEndElement();
                            }
                            else
                            {
                                writer.WriteEndElement();
                            }
                            CloseSvgElement(reader, ref svgScope);
                        }
                        break;
                    case XmlNodeType.EndElement:
                        writer.WriteFullEndElement();
                        CloseSvgElement(reader, ref svgScope);
                        break;
                    case XmlNodeType.Text:
                    case XmlNodeType.SignificantWhitespace:
                    case XmlNodeType.Whitespace:
                        writer.WriteString(reader.Value);
                        break;
                    case XmlNodeType.CDATA:
                    case XmlNodeType.Comment:
                    case XmlNodeType.ProcessingInstruction:
                    case XmlNodeType.DocumentType:
                    case XmlNodeType.EntityReference:
                        throw new InvalidDataException("Canonical renderer fragment contains a prohibited node type.");
                }
            }
            writer.Flush();

            if (!seenImages.SetEquals(images.Keys))
            {
                throw new InvalidDataException("Not every frozen image asset was embedded exactly once.");
            }
            if (anchorReferences.Any(reference => !ids.Contains(reference)))
            {
                throw new InvalidDataException("Canonical renderer fragment contains an unresolved internal anchor.");
            }
            return output.ToArray();
        }
        catch (Exception exception) when (exception is XmlException or ArgumentException)
        {
            throw new InvalidDataException("Canonical renderer output is not a closed deterministic XHTML fragment.", exception);
        }
    }

    private static void WriteStartElement(
        XmlReader reader,
        XmlWriter writer,
        IReadOnlyDictionary<string, DocumentExportAsset> images,
        ISet<string> seenImages,
        ISet<string> ids,
        ISet<string> anchorReferences,
        SvgScope? svgScope)
    {
        bool svg = reader.NamespaceURI == SvgNamespace;
        string name = reader.LocalName;
        if (reader.Prefix.Length != 0
            || svg && !s_svgElements.Contains(name)
            || svg && svgScope is null
            || !svg && (svgScope is not null || name == "svg"
                || reader.NamespaceURI != XhtmlNamespace || !s_htmlElements.Contains(name)))
        {
            throw new InvalidDataException($"Element '{reader.Name}' is outside the self-contained HTML allowlist.");
        }

        var attributes = new SortedDictionary<string, string>(StringComparer.Ordinal);
        if (reader.HasAttributes)
        {
            while (reader.MoveToNextAttribute())
            {
                string attributeName = reader.Name;
                if (reader.Prefix.Length != 0 && reader.Prefix != "xmlns"
                    || attributeName.StartsWith("on", StringComparison.OrdinalIgnoreCase)
                    || attributeName is "style" or "srcset" or "srcdoc" or "formaction" or "poster"
                    || !AttributeAllowed(name, svg, attributeName)
                    || !attributes.TryAdd(attributeName, reader.Value))
                {
                    throw new InvalidDataException($"Attribute '{attributeName}' is outside the self-contained HTML allowlist.");
                }
            }
            reader.MoveToElement();
        }

        if (attributes.TryGetValue("id", out string? id)
            && (!(svg ? IsIdentifier(id) : IsHtmlIdentifier(id)) || !ids.Add(id)))
        {
            throw new InvalidDataException("HTML ids must be non-empty, unique, and canonical.");
        }
        if (svg)
        {
            if ((name == "defs" && svgScope!.Elements.Peek() != "svg")
                || (name == "marker" && svgScope!.Elements.Peek() != "defs"))
            {
                throw new InvalidDataException("SVG marker definitions must belong to their containing document.");
            }
            svgScope!.Elements.Push(name);
            if (id is not null)
            {
                svgScope.Ids.Add(id);
                if (name == "marker")
                {
                    svgScope.MarkerIds.Add(id);
                }
            }
        }
        ValidateScalarAttributes(attributes, svg ? svgScope!.References : anchorReferences, svg);
        ValidateDiagramAttributes(attributes, svgScope);
        if (name == "a")
        {
            NormalizeAnchor(attributes, anchorReferences);
        }
        else if (name == "img")
        {
            ValidateImage(attributes, images, seenImages);
        }

        writer.WriteStartElement(name, svg ? SvgNamespace : string.Empty);
        if (svg && name == "svg")
        {
            writer.WriteAttributeString("xmlns", SvgNamespace);
            attributes.Remove("xmlns");
        }
        foreach ((string attributeName, string value) in attributes)
        {
            writer.WriteAttributeString(attributeName, value);
        }
    }

    private static bool AttributeAllowed(string element, bool svg, string attribute)
        => svg
            ? s_svgAttributes.Contains(attribute)
                || s_svgElementAttributes.TryGetValue(element, out HashSet<string>? svgAllowed)
                    && svgAllowed.Contains(attribute)
            : s_globalAttributes.Contains(attribute)
                || s_htmlAttributes.TryGetValue(element, out HashSet<string>? allowed)
                    && allowed.Contains(attribute);

    private static void CloseSvgElement(XmlReader reader, ref SvgScope? scope)
    {
        if (scope is null)
        {
            return;
        }
        scope.Elements.Pop();
        if (reader.Depth != scope.Depth)
        {
            return;
        }
        SvgScope completedScope = scope;
        if (completedScope.References.Any(reference => !completedScope.Ids.Contains(reference))
            || completedScope.MarkerReferences.Any(reference => !completedScope.MarkerIds.Contains(reference)))
        {
            throw new InvalidDataException("SVG references must resolve inside their own document with the expected target type.");
        }
        scope = null;
    }

    private static void ValidateDiagramAttributes(
        IReadOnlyDictionary<string, string> attributes,
        SvgScope? svgScope)
    {
        foreach (string numeric in new[]
        {
            "data-mermaid-width", "data-mermaid-height", "markerWidth", "markerHeight", "refX", "refY", "font-size"
        })
        {
            if (attributes.TryGetValue(numeric, out string? value)
                && (!double.TryParse(value, NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out double parsed)
                    || !double.IsFinite(parsed) || parsed < 0 || parsed > 100000
                    || ((numeric is "data-mermaid-width" or "data-mermaid-height" or "markerWidth" or "markerHeight" or "font-size")
                        && parsed == 0)
                    || (numeric == "font-size" && parsed > 512)))
            {
                throw new InvalidDataException($"Diagram attribute '{numeric}' is outside its numeric range.");
            }
        }
        if (attributes.TryGetValue("data-mermaid-rendered", out string? rendered) && rendered != "true"
            || attributes.TryGetValue("preserveAspectRatio", out string? aspect) && aspect != "xMidYMid meet"
            || attributes.TryGetValue("orient", out string? orient) && orient != "auto-start-reverse"
            || attributes.TryGetValue("font-family", out string? family)
                && family != "Google Sans, Noto Sans SC, system-ui, sans-serif")
        {
            throw new InvalidDataException("Diagram attributes drifted from the closed canonical renderer values.");
        }
        if (attributes.TryGetValue("marker-end", out string? marker))
        {
            if (svgScope is null || !marker.StartsWith("url(#", StringComparison.Ordinal)
                || !marker.EndsWith(')') || !IsIdentifier(marker[5..^1]))
            {
                throw new InvalidDataException("SVG marker references may only target one local canonical marker.");
            }
            svgScope.MarkerReferences.Add(marker[5..^1]);
        }
    }

    private sealed class SvgScope(int depth)
    {
        internal int Depth { get; } = depth;
        internal Stack<string> Elements { get; } = new();
        internal HashSet<string> Ids { get; } = new(StringComparer.Ordinal);
        internal HashSet<string> MarkerIds { get; } = new(StringComparer.Ordinal);
        internal HashSet<string> References { get; } = new(StringComparer.Ordinal);
        internal HashSet<string> MarkerReferences { get; } = new(StringComparer.Ordinal);
    }

    private static void NormalizeAnchor(
        IDictionary<string, string> attributes,
        ISet<string> anchorReferences)
    {
        if (!attributes.TryGetValue("href", out string? href) || string.IsNullOrWhiteSpace(href))
        {
            throw new InvalidDataException("Links require a closed href.");
        }
        href = href.Trim();
        attributes["href"] = href;
        if (href.StartsWith('#'))
        {
            string target = href[1..];
            if (!IsHtmlIdentifier(target) || attributes.ContainsKey("target") || attributes.ContainsKey("rel"))
            {
                throw new InvalidDataException("Internal links must target one local canonical id.");
            }
            anchorReferences.Add(target);
            return;
        }
        if (!Uri.TryCreate(href, UriKind.Absolute, out Uri? uri)
            || uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps
            || uri.UserInfo.Length != 0)
        {
            throw new InvalidDataException("Links may only use local anchors or credential-free HTTP(S) destinations.");
        }
        attributes["target"] = "_blank";
        attributes["rel"] = "noopener noreferrer external";
    }

    private static void ValidateImage(
        IReadOnlyDictionary<string, string> attributes,
        IReadOnlyDictionary<string, DocumentExportAsset> images,
        ISet<string> seenImages)
    {
        if (!attributes.TryGetValue("data-asset-id", out string? assetId)
            || !images.TryGetValue(assetId, out DocumentExportAsset? image)
            || !seenImages.Add(assetId)
            || !attributes.TryGetValue("src", out string? src)
            || src != $"data:{image.MediaType};base64,{Convert.ToBase64String(image.Bytes.AsSpan())}"
            || !attributes.TryGetValue("alt", out string? alt)
            || alt != image.AltText)
        {
            throw new InvalidDataException("Rendered image bytes, identity, or accessible text drifted from frozen input.");
        }
    }

    private static void ValidateScalarAttributes(
        IReadOnlyDictionary<string, string> attributes,
        ISet<string> localReferences,
        bool svg)
    {
        if (attributes.Any(attribute => attribute.Value.Any(char.IsControl)))
        {
            throw new InvalidDataException("HTML attributes cannot contain control characters.");
        }
        if (attributes.TryGetValue("xmlns", out string? svgNamespace) && svgNamespace != SvgNamespace)
        {
            throw new InvalidDataException("SVG namespace identity drifted.");
        }
        if (attributes.TryGetValue("dir", out string? direction) && direction is not ("ltr" or "rtl" or "auto"))
        {
            throw new InvalidDataException("HTML direction is outside the closed values.");
        }
        foreach (string dimension in new[] { "width", "height", "colspan", "rowspan", "start", "tabindex" })
        {
            if (attributes.TryGetValue(dimension, out string? value)
                && (!int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out int parsed)
                    || parsed is < -1 or > 100000))
            {
                throw new InvalidDataException($"HTML attribute '{dimension}' is outside its numeric range.");
            }
        }
        foreach (string referenceAttribute in new[] { "aria-describedby", "aria-labelledby", "headers" })
        {
            if (!attributes.TryGetValue(referenceAttribute, out string? references))
            {
                continue;
            }
            foreach (string reference in references.Split(' ', StringSplitOptions.RemoveEmptyEntries))
            {
                if (!(svg ? IsIdentifier(reference) : IsHtmlIdentifier(reference)))
                {
                    throw new InvalidDataException($"HTML attribute '{referenceAttribute}' contains a malformed id reference.");
                }
                localReferences.Add(reference);
            }
        }
        foreach (string paintAttribute in new[] { "fill", "stroke" })
        {
            if (!attributes.TryGetValue(paintAttribute, out string? paint)
                || !paint.Contains("url(", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            if (!paint.StartsWith("url(#", StringComparison.Ordinal)
                || !paint.EndsWith(')')
                || !IsIdentifier(paint[5..^1]))
            {
                throw new InvalidDataException("SVG paint references may only target one local canonical id.");
            }
            localReferences.Add(paint[5..^1]);
        }
    }

    private static bool IsIdentifier(string value)
        => value.Length is > 0 and <= 160
            && value.All(character => char.IsAsciiLetterOrDigit(character)
                || character is '-' or '_' or ':' or '.');

    private static bool IsHtmlIdentifier(string value)
    {
        if (value.Length is not (> 0 and <= 160))
        {
            return false;
        }
        foreach (Rune character in value.EnumerateRunes())
        {
            if (!Rune.IsLetterOrDigit(character)
                && Rune.GetUnicodeCategory(character) is not (UnicodeCategory.LetterNumber
                    or UnicodeCategory.OtherNumber or UnicodeCategory.NonSpacingMark
                    or UnicodeCategory.SpacingCombiningMark or UnicodeCategory.EnclosingMark)
                && character.Value is not ('-' or '_' or ':' or '.'))
            {
                return false;
            }
        }
        return true;
    }

    private sealed class SequenceTextReader(params TextReader[] readers) : TextReader
    {
        private readonly TextReader[] _readers = readers;
        private int _index;

        public override int Read(char[] buffer, int index, int count)
        {
            while (_index < _readers.Length)
            {
                int read = _readers[_index].Read(buffer, index, count);
                if (read != 0)
                {
                    return read;
                }
                _readers[_index++].Dispose();
            }
            return 0;
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                while (_index < _readers.Length)
                {
                    _readers[_index++].Dispose();
                }
            }
            base.Dispose(disposing);
        }
    }
}
