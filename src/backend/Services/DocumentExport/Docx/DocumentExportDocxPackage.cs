using System.Buffers.Binary;
using System.Globalization;
using System.IO.Compression;
using System.Text;
using System.Xml;
using System.Xml.Linq;

namespace FsusBlog.Server.Services.DocumentExport;

/// <summary>
/// Writes a closed WordprocessingML subset from canonical renderer facts. No
/// templates, scripts, external media, filesystem reads or tool launches exist
/// at this format boundary. Execution admission remains owned by the sandbox.
/// </summary>
internal sealed class DocumentExportDocxPackage
{
    internal static XNamespace Word { get; } = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    internal static XNamespace Relationship { get; } = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    internal static XNamespace PackageRelationship { get; } = "http://schemas.openxmlformats.org/package/2006/relationships";
    internal static XNamespace ContentType { get; } = "http://schemas.openxmlformats.org/package/2006/content-types";
    internal static XNamespace Drawing { get; } = "http://schemas.openxmlformats.org/drawingml/2006/main";
    internal static XNamespace Picture { get; } = "http://schemas.openxmlformats.org/drawingml/2006/picture";
    internal static XNamespace WordDrawing { get; } = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
    internal const long MaximumOutputBytes = 64 * 1024 * 1024;
    internal const int MaximumParts = 64;
    internal const string FixedTimestamp = "2000-01-01T00:00:00Z";
    internal static DateTimeOffset ZipTimestamp { get; } = new(2000, 1, 1, 0, 0, 0, TimeSpan.Zero);

    private readonly DocumentExportDocxProjection _projection;
    private readonly CancellationToken _cancellationToken;
    private readonly SortedDictionary<string, byte[]> _parts = new(StringComparer.Ordinal);
    private readonly List<XElement> _relationships = [];
    private readonly List<XElement> _numbering = [];
    private readonly Dictionary<string, string> _bookmarks = new(StringComparer.Ordinal);
    private readonly Dictionary<string, int> _notes = new(StringComparer.Ordinal);
    private readonly Dictionary<string, (string RelationshipId, int Width, int Height)> _images = new(StringComparer.Ordinal);
    private int _drawingId;

    private DocumentExportDocxPackage(DocumentExportDocxProjection projection, CancellationToken cancellationToken)
    {
        _projection = projection;
        _cancellationToken = cancellationToken;
    }

    internal static byte[] Render(DocumentExportDocxProjection projection, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var package = new DocumentExportDocxPackage(projection, cancellationToken);
        package.Build();
        using var output = new DocumentExportBoundedMemoryStream(MaximumOutputBytes, "DOCX output budget exceeded.");
        using (var zip = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true, Encoding.UTF8))
        {
            foreach ((string path, byte[] bytes) in package._parts)
            {
                cancellationToken.ThrowIfCancellationRequested();
                ZipArchiveEntry entry = zip.CreateEntry(path, CompressionLevel.NoCompression);
                entry.LastWriteTime = ZipTimestamp;
                entry.ExternalAttributes = 0;
                using Stream destination = entry.Open();
                destination.Write(bytes);
            }
        }
        cancellationToken.ThrowIfCancellationRequested();
        return output.ToArray();
    }

    private void Build()
    {
        XElement root = _projection.ReadRoot();
        DocumentExportDocxFootnote[] notes = DocumentExportDocxFootnote.ReadGraph(root);
        foreach (DocumentExportDocxFootnote note in notes)
        {
            _notes.Add((string)note.Definition.Attribute("id")!, _notes.Count + 1);
        }
        XElement[] ids = root.Descendants().Where(element => element.Attribute("id") is not null).ToArray();
        for (int index = 0; index < ids.Length; index++)
        {
            string id = (string)ids[index].Attribute("id")!;
            _bookmarks.Add(id, $"anchor{index + 1}");
        }
        AddRelationship("styles", "styles.xml");
        AddRelationship("numbering", "numbering.xml");
        AddRelationship("fontTable", "fontTable.xml");
        AddRelationship("footnotes", "footnotes.xml");
        foreach (DocumentExportAsset image in _projection.Images)
        {
            (int width, int height) = VerifyImage(image.Bytes.AsSpan(), image.MediaType, _cancellationToken);
            string extension = image.MediaType == "image/png" ? "png" : "jpg";
            string path = $"media/image{_images.Count + 1}.{extension}";
            _images.Add(image.AssetId, (AddRelationship("image", path), width, height));
            _parts.Add("word/" + path, image.Bytes.ToArray());
        }
        var body = new XElement(Word + "body");
        AppendBlocks(root.Nodes(), body, listId: null, level: 0);
        body.Add(new XElement(Word + "sectPr",
            new XElement(Word + "pgSz", W("w", "11906"), W("h", "16838")),
            new XElement(Word + "pgMar", W("top", "1440"), W("right", "1440"), W("bottom", "1440"),
                W("left", "1440"), W("header", "720"), W("footer", "720"), W("gutter", "0"))));
        AddXml("word/document.xml", new XElement(Word + "document",
            new XAttribute(XNamespace.Xmlns + "w", Word), new XAttribute(XNamespace.Xmlns + "r", Relationship), body));
        AddXml("word/styles.xml", Styles());
        AddXml("word/numbering.xml", new XElement(Word + "numbering",
            _numbering.Where(element => element.Name == Word + "abstractNum"),
            _numbering.Where(element => element.Name == Word + "num")));
        AddXml("word/fontTable.xml", new XElement(Word + "fonts",
            new[] { "Google Sans", "Noto Sans SC", "JetBrains Mono" }.Select(name =>
                new XElement(Word + "font", W("name", name), new XElement(Word + "family", W("val", "auto"))))));
        var footnotes = new XElement(Word + "footnotes",
            new XElement(Word + "footnote", W("type", "separator"), W("id", "-1"),
                new XElement(Word + "p", new XElement(Word + "r", new XElement(Word + "separator")))),
            new XElement(Word + "footnote", W("type", "continuationSeparator"), W("id", "0"),
                new XElement(Word + "p", new XElement(Word + "r", new XElement(Word + "continuationSeparator")))));
        foreach ((string id, int number) in _notes)
        {
            XElement source = notes.Single(note => (string?)note.Definition.Attribute("id") == id).ReadContent();
            var note = new XElement(Word + "footnote", W("id", number));
            AppendBlocks(source.Nodes(), note, listId: null, level: 0);
            XElement paragraph = note.Elements(Word + "p").FirstOrDefault()
                ?? throw new InvalidDataException("DOCX footnote has no paragraph.");
            paragraph.Element(Word + "pPr")!.AddAfterSelf(new XElement(Word + "r", new XElement(Word + "rPr", new XElement(Word + "vertAlign", W("val", "superscript"))),
                new XElement(Word + "footnoteRef")));
            footnotes.Add(note);
        }
        AddXml("word/footnotes.xml", footnotes);
        AddXml("word/_rels/document.xml.rels", new XElement(PackageRelationship + "Relationships", _relationships));
        XNamespace core = "http://schemas.openxmlformats.org/package/2006/metadata/core-properties";
        XNamespace dc = "http://purl.org/dc/elements/1.1/";
        XNamespace terms = "http://purl.org/dc/terms/";
        XNamespace xsi = "http://www.w3.org/2001/XMLSchema-instance";
        AddXml("docProps/core.xml", new XElement(core + "coreProperties",
            new XAttribute(XNamespace.Xmlns + "dcterms", terms), new XAttribute(XNamespace.Xmlns + "xsi", xsi),
            new XElement(dc + "title", _projection.Title), new XElement(dc + "language", _projection.Locale),
            new XElement(core + "revision", "1"), new XElement(core + "lastModifiedBy", "FsusBlog"),
            new XElement(terms + "created", new XAttribute(xsi + "type", "dcterms:W3CDTF"), FixedTimestamp),
            new XElement(terms + "modified", new XAttribute(xsi + "type", "dcterms:W3CDTF"), FixedTimestamp)));
        AddXml("_rels/.rels", new XElement(PackageRelationship + "Relationships",
            Rel("rId1", Relationship.NamespaceName + "/officeDocument", "word/document.xml"),
            Rel("rId2", core.NamespaceName, "docProps/core.xml")));
        AddXml("[Content_Types].xml", new XElement(ContentType + "Types",
            new XElement(ContentType + "Default", new XAttribute("Extension", "rels"),
                new XAttribute("ContentType", "application/vnd.openxmlformats-package.relationships+xml")),
            _projection.Images.Select(image => image.MediaType).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal)
                .Select(mime => new XElement(ContentType + "Default", new XAttribute("Extension", mime == "image/png" ? "png" : "jpg"),
                    new XAttribute("ContentType", mime))),
            new[] { ("document", "document.main"), ("styles", "styles"), ("numbering", "numbering"),
                ("fontTable", "fontTable"), ("footnotes", "footnotes") }.Select(part =>
                    new XElement(ContentType + "Override", new XAttribute("PartName", $"/word/{part.Item1}.xml"),
                        new XAttribute("ContentType", $"application/vnd.openxmlformats-officedocument.wordprocessingml.{part.Item2}+xml"))),
            new XElement(ContentType + "Override", new XAttribute("PartName", "/docProps/core.xml"),
                new XAttribute("ContentType", "application/vnd.openxmlformats-package.core-properties+xml"))));
        if (_parts.Count > MaximumParts || _parts.Sum(part => part.Value.LongLength) > MaximumOutputBytes)
        {
            throw new InvalidDataException("DOCX package exceeds part or expanded-byte limits.");
        }
    }

    private void AppendBlocks(IEnumerable<XNode> nodes, XElement destination, int? listId, int level)
    {
        var pending = new List<XNode>();
        void Flush()
        {
            if (pending.Count > 0 && pending.Any(node => node is XElement || !string.IsNullOrWhiteSpace(((XText)node).Value)))
            {
                destination.Add(Paragraph(pending, "Normal", null, listId, level));
            }
            pending.Clear();
        }
        foreach (XNode node in nodes)
        {
            _cancellationToken.ThrowIfCancellationRequested();
            if (node is not XElement element)
            {
                pending.Add(node);
                continue;
            }
            string name = element.Name.LocalName;
            if (DocumentExportDocxFootnote.HasClass(element, "footnotes"))
            {
                Flush();
                continue;
            }
            if (name is "ul" or "ol")
            {
                Flush();
                if (element.Attribute("id") is not null)
                {
                    destination.Add(Paragraph([], "Normal", element, null, 0));
                }
                if (level >= 9 || element.Nodes().Any(child => child is XElement item && item.Name.LocalName != "li"))
                {
                    throw new InvalidDataException("DOCX list structure or nesting is unsupported.");
                }
                int number = AddNumbering(name == "ol", (string?)element.Attribute("start") ?? "1");
                foreach (XElement item in element.Elements())
                {
                    var itemBlocks = new XElement("blocks");
                    AppendBlocks(item.Nodes(), itemBlocks, number, level + 1);
                    bool numbered = false;
                    foreach (XElement paragraph in itemBlocks.Elements(Word + "p"))
                    {
                        XElement? numberProperties = paragraph.Element(Word + "pPr")?.Element(Word + "numPr");
                        if ((int?)numberProperties?.Element(Word + "numId")?.Attribute(Word + "val") == number)
                        {
                            if (numbered)
                            {
                                numberProperties!.Remove();
                            }
                            numbered = true;
                        }
                    }
                    if (!numbered)
                    {
                        itemBlocks.AddFirst(Paragraph([], "Normal", null, number, level + 1));
                    }
                    if (item.Attribute("id") is not null)
                    {
                        itemBlocks.AddFirst(Paragraph([], "Normal", item, null, 0));
                    }
                    destination.Add(itemBlocks.Elements());
                }
            }
            else if (name == "table")
            {
                Flush();
                if (element.Attribute("id") is not null)
                {
                    destination.Add(Paragraph([], "Normal", element, null, 0));
                }
                destination.Add(Table(element));
            }
            else if (name is "p" or "pre" or "figcaption" or "caption" or "dt" or "dd" or "summary"
                || name.Length == 2 && name[0] == 'h' && name[1] is >= '1' and <= '6')
            {
                Flush();
                string style = name == "pre" ? "Code" : name is "caption" or "figcaption" ? "Caption"
                    : name[0] == 'h' ? "Heading" + name[1] : "Normal";
                if (name == "pre")
                {
                    string? language = element.Descendants().FirstOrDefault(child => child.Name.LocalName == "code")?
                        .Attribute("class")?.Value.Split(' ').FirstOrDefault(value => value.StartsWith("language-", StringComparison.Ordinal));
                    if (language is not null)
                    {
                        destination.Add(Paragraph([new XText(language[9..])], "Caption", null, null, 0));
                    }
                }
                destination.Add(Paragraph(element.Nodes(), style, element, listId, level));
            }
            else if (name is "div" or "section" or "aside" or "figure" or "blockquote" or "dl" or "details" or "li")
            {
                Flush();
                if (element.Attribute("id") is not null)
                {
                    destination.Add(Paragraph([], "Normal", element, null, 0));
                }
                AppendBlocks(element.Nodes(), destination, listId, level);
            }
            else if (name == "hr")
            {
                Flush();
                destination.Add(Paragraph([new XText("—")], "Normal", element, listId, level));
            }
            else
            {
                pending.Add(element);
            }
        }
        Flush();
        if (!destination.Elements().Any())
        {
            destination.Add(Paragraph([], "Normal", null, listId, level));
        }
    }

    private XElement Paragraph(IEnumerable<XNode> nodes, string style, XElement? source, int? listId, int level)
    {
        var properties = new XElement(Word + "pPr", new XElement(Word + "pStyle", W("val", style)));
        if (listId is not null)
        {
            properties.Add(new XElement(Word + "numPr", new XElement(Word + "ilvl", W("val", Math.Max(0, level - 1))),
                new XElement(Word + "numId", W("val", listId))));
        }
        XElement? context = source ?? nodes.FirstOrDefault()?.Parent;
        string? direction = context?.AncestorsAndSelf().Select(element => (string?)element.Attribute("dir"))
            .FirstOrDefault(value => value is "rtl" or "ltr");
        if (direction == "rtl" || direction is null && (_projection.Locale.StartsWith("ar", StringComparison.OrdinalIgnoreCase)
            || _projection.Locale.StartsWith("he", StringComparison.OrdinalIgnoreCase)))
        {
            properties.Add(new XElement(Word + "bidi"));
        }
        var paragraph = new XElement(Word + "p", properties);
        Bookmark(source, paragraph, () => AppendInline(nodes, paragraph, []));
        return paragraph;
    }

    private void AppendInline(IEnumerable<XNode> nodes, XElement destination, IReadOnlyList<string> marks)
    {
        foreach (XNode node in nodes)
        {
            _cancellationToken.ThrowIfCancellationRequested();
            if (node is XText text)
            {
                destination.Add(Run(text.Value, marks));
                continue;
            }
            if (node is not XElement element)
            {
                throw new InvalidDataException("DOCX projection contains a non-semantic node.");
            }
            string name = element.Name.LocalName;
            if (name is "a" or "img" or "svg" or "br")
            {
                Bookmark(element, destination, null);
            }
            if (name == "a")
            {
                string? linkDirection = (string?)element.Attribute("dir");
                IReadOnlyList<string> linkMarks = linkDirection is "rtl" or "ltr"
                    ? marks.Where(value => value is not ("rtl" or "ltr")).Append(linkDirection).ToArray() : marks;
                string href = (string?)element.Attribute("href") ?? throw new InvalidDataException("DOCX link lacks a target.");
                if (href.StartsWith('#') && _notes.TryGetValue(href[1..], out int note))
                {
                    // The native reference supplies the canonical ordinal; writing
                    // the HTML number as text would display it twice.
                    destination.Add(new XElement(Word + "r", new XElement(Word + "rPr", new XElement(Word + "vertAlign", W("val", "superscript"))),
                        new XElement(Word + "footnoteReference", W("id", note))));
                }
                else
                {
                    XElement hyperlink = href.StartsWith('#')
                        ? new XElement(Word + "hyperlink", W("anchor", _bookmarks[href[1..]]))
                        : new XElement(Word + "hyperlink", new XAttribute(Relationship + "id", AddRelationship("hyperlink", href, external: true)));
                    AppendInline(element.Nodes(), hyperlink, linkMarks);
                    destination.Add(hyperlink);
                }
            }
            else if (name == "img")
            {
                destination.Add(Image(element));
            }
            else if (name == "br")
            {
                destination.Add(new XElement(Word + "r", new XElement(Word + "br")));
            }
            else if (name == "svg")
            {
                destination.Add(Run(element.Value, marks));
            }
            else
            {
                string? mark = name switch
                {
                    "strong" or "b" => "b",
                    "em" or "i" => "i",
                    "u" => "u",
                    "s" or "del" => "strike",
                    "sup" => "superscript",
                    "sub" => "subscript",
                    "code" or "kbd" or "samp" => "CodeChar",
                    _ => null
                };
                IReadOnlyList<string> nextMarks = mark is null ? marks : marks.Append(mark).Distinct(StringComparer.Ordinal).ToArray();
                string? inlineDirection = (string?)element.Attribute("dir");
                if (inlineDirection is "rtl" or "ltr")
                {
                    nextMarks = nextMarks.Where(value => value is not ("rtl" or "ltr")).Append(inlineDirection).ToArray();
                }
                if (name is "table" or "p" or "pre" or "ul" or "ol")
                {
                    throw new InvalidDataException("DOCX block cannot be nested in inline content.");
                }
                Bookmark(element, destination, () => AppendInline(element.Nodes(), destination, nextMarks));
            }
        }
    }

    private void Bookmark(XElement? source, XElement destination, Action? content)
    {
        string? id = (string?)source?.Attribute("id");
        if (id is not null)
        {
            destination.Add(new XElement(Word + "bookmarkStart", W("id", Array.IndexOf(_bookmarks.Keys.ToArray(), id) + 1), W("name", _bookmarks[id])));
        }
        content?.Invoke();
        if (id is not null)
        {
            destination.Add(new XElement(Word + "bookmarkEnd", W("id", Array.IndexOf(_bookmarks.Keys.ToArray(), id) + 1)));
        }
    }

    private static XElement Run(string text, IReadOnlyList<string> marks)
    {
        var run = new XElement(Word + "r");
        if (marks.Count > 0)
        {
            // CT_RPr is a sequence; keep the closed properties in schema order.
            var properties = new XElement(Word + "rPr");
            if (marks.Contains("CodeChar"))
            {
                properties.Add(new XElement(Word + "rStyle", W("val", "CodeChar")));
            }
            foreach (string property in new[] { "b", "i", "strike", "u" })
            {
                if (marks.Contains(property))
                {
                    properties.Add(new XElement(Word + property, property == "u" ? W("val", "single") : null));
                }
            }
            if (marks.Contains("superscript") || marks.Contains("subscript"))
            {
                properties.Add(new XElement(Word + "vertAlign", W("val", marks.Contains("superscript") ? "superscript" : "subscript")));
            }
            if (marks.Contains("rtl") || marks.Contains("ltr"))
            {
                properties.Add(new XElement(Word + "rtl", W("val", marks.Contains("rtl") ? "1" : "0")));
            }
            run.Add(properties);
        }
        string[] lines = text.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n').Split('\n');
        for (int line = 0; line < lines.Length; line++)
        {
            if (line > 0)
            {
                run.Add(new XElement(Word + "br"));
            }
            string[] segments = lines[line].Split('\t');
            for (int segment = 0; segment < segments.Length; segment++)
            {
                if (segment > 0)
                {
                    run.Add(new XElement(Word + "tab"));
                }
                run.Add(new XElement(Word + "t", new XAttribute(XNamespace.Xml + "space", "preserve"), segments[segment]));
            }
        }
        return run;
    }

    private XElement Table(XElement source)
    {
        XElement[] rows = source.Elements().SelectMany(element => element.Name.LocalName == "tr" ? [element]
            : element.Name.LocalName is "thead" or "tbody" or "tfoot" ? element.Elements() : []).ToArray();
        if (source.Elements().Any(element => element.Name.LocalName == "caption") || rows.Length == 0 || rows.Length > 1000)
        {
            throw new InvalidDataException("DOCX table caption or row limit is unsupported; use an external canonical caption.");
        }
        int columns = rows[0].Elements().Count();
        if (columns is < 1 or > 32 || rows.Any(row => row.Name.LocalName != "tr" || row.Elements().Count() != columns
            || row.Elements().Any(cell => cell.Name.LocalName is not ("td" or "th"))))
        {
            throw new InvalidDataException("DOCX table grid is non-rectangular or unsupported.");
        }
        var table = new XElement(Word + "tbl", new XElement(Word + "tblPr", new XElement(Word + "tblW", W("w", "0"), W("type", "auto"))),
            new XElement(Word + "tblGrid", Enumerable.Range(0, columns).Select(_ => new XElement(Word + "gridCol", W("w", 9000 / columns)))));
        foreach (XElement row in rows)
        {
            var outputRow = new XElement(Word + "tr");
            if (row.Elements().All(cell => cell.Name.LocalName == "th"))
            {
                outputRow.Add(new XElement(Word + "trPr", new XElement(Word + "tblHeader")));
            }
            foreach (XElement cell in row.Elements())
            {
                var outputCell = new XElement(Word + "tc", new XElement(Word + "tcPr",
                    new XElement(Word + "tcW", W("w", 9000 / columns), W("type", "dxa"))));
                if (cell.Attribute("id") is not null)
                {
                    outputCell.Add(Paragraph([], "Normal", cell, null, 0));
                }
                AppendBlocks(cell.Nodes(), outputCell, null, 0);
                if (outputCell.Elements().Last().Name != Word + "p")
                {
                    outputCell.Add(Paragraph([], "Normal", null, null, 0));
                }
                outputRow.Add(outputCell);
            }
            table.Add(outputRow);
        }
        return table;
    }

    private XElement Image(XElement source)
    {
        string assetId = (string)source.Attribute("data-asset-id")!;
        (string relationshipId, int width, int height) = _images[assetId];
        long cx = Math.Min(5400000L, width * 9525L);
        long cy = Math.Max(1, height * cx / width);
        int id = ++_drawingId;
        return new XElement(Word + "r", new XElement(Word + "drawing",
            new XElement(WordDrawing + "inline", new XElement(WordDrawing + "extent", new XAttribute("cx", cx), new XAttribute("cy", cy)),
                new XElement(WordDrawing + "docPr", new XAttribute("id", id), new XAttribute("name", "image" + id),
                    new XAttribute("descr", (string)source.Attribute("alt")!)),
                new XElement(Drawing + "graphic", new XElement(Drawing + "graphicData", new XAttribute("uri", Picture.NamespaceName),
                    new XElement(Picture + "pic", new XElement(Picture + "nvPicPr",
                        new XElement(Picture + "cNvPr", new XAttribute("id", id), new XAttribute("name", "image" + id)),
                        new XElement(Picture + "cNvPicPr")),
                        new XElement(Picture + "blipFill", new XElement(Drawing + "blip", new XAttribute(Relationship + "embed", relationshipId)),
                            new XElement(Drawing + "stretch", new XElement(Drawing + "fillRect"))),
                        new XElement(Picture + "spPr", new XElement(Drawing + "xfrm",
                            new XElement(Drawing + "off", new XAttribute("x", "0"), new XAttribute("y", "0")),
                            new XElement(Drawing + "ext", new XAttribute("cx", cx), new XAttribute("cy", cy))),
                            new XElement(Drawing + "prstGeom", new XAttribute("prst", "rect"), new XElement(Drawing + "avLst")))))))));
    }

    private int AddNumbering(bool ordered, string start)
    {
        if (!int.TryParse(start, NumberStyles.None, CultureInfo.InvariantCulture, out int first) || first is < 1 or > 100000)
        {
            throw new InvalidDataException("DOCX list start is outside the supported range.");
        }
        int id = _numbering.Count / 2 + 1;
        _numbering.Add(new XElement(Word + "abstractNum", W("abstractNumId", id),
            Enumerable.Range(0, 9).Select(level => new XElement(Word + "lvl", W("ilvl", level),
                new XElement(Word + "start", W("val", first)), new XElement(Word + "numFmt", W("val", ordered ? "decimal" : "bullet")),
                new XElement(Word + "lvlText", W("val", ordered ? $"%{level + 1}." : "•")), new XElement(Word + "lvlJc", W("val", "left"))))));
        _numbering.Add(new XElement(Word + "num", W("numId", id), new XElement(Word + "abstractNumId", W("val", id))));
        return id;
    }

    private string AddRelationship(string type, string target, bool external = false)
    {
        string id = "rId" + (_relationships.Count + 1).ToString(CultureInfo.InvariantCulture);
        _relationships.Add(Rel(id, Relationship.NamespaceName + "/" + type, target, external));
        return id;
    }

    private static XElement Rel(string id, string type, string target, bool external = false)
        => new(PackageRelationship + "Relationship", new XAttribute("Id", id), new XAttribute("Type", type),
            new XAttribute("Target", target), external ? new XAttribute("TargetMode", "External") : null);

    private void AddXml(string path, XElement root)
    {
        using var output = new DocumentExportBoundedMemoryStream(8 * 1024 * 1024, "DOCX XML part budget exceeded.");
        using (XmlWriter writer = XmlWriter.Create(output, new XmlWriterSettings
        {
            Encoding = new UTF8Encoding(false, true),
            OmitXmlDeclaration = false,
            NewLineHandling = NewLineHandling.None,
            Indent = false
        }))
        {
            root.WriteTo(writer);
        }
        _parts.Add(path, output.ToArray());
    }

    private XElement Styles()
    {
        XElement Fonts(string family) => new(Word + "rFonts", W("ascii", family), W("hAnsi", family),
            W("eastAsia", "Noto Sans SC"), W("cs", "Google Sans"));
        return new XElement(Word + "styles",
            new XElement(Word + "docDefaults", new XElement(Word + "rPrDefault", new XElement(Word + "rPr", Fonts("Google Sans"),
                new XElement(Word + "sz", W("val", "24")), new XElement(Word + "lang", W("val", _projection.Locale)))),
                new XElement(Word + "pPrDefault", new XElement(Word + "pPr"))),
            new XElement(Word + "style", W("type", "paragraph"), W("default", "1"), W("styleId", "Normal"),
                new XElement(Word + "name", W("val", "Normal"))),
            Enumerable.Range(1, 6).Select(level => new XElement(Word + "style", W("type", "paragraph"), W("styleId", "Heading" + level),
                new XElement(Word + "name", W("val", "heading " + level)), new XElement(Word + "basedOn", W("val", "Normal")),
                new XElement(Word + "pPr", new XElement(Word + "keepNext"), new XElement(Word + "outlineLvl", W("val", level - 1))),
                new XElement(Word + "rPr", new XElement(Word + "b"), new XElement(Word + "sz", W("val", 40 - level * 2))))),
            new XElement(Word + "style", W("type", "paragraph"), W("styleId", "Code"), new XElement(Word + "name", W("val", "Code")),
                new XElement(Word + "basedOn", W("val", "Normal")), new XElement(Word + "rPr", Fonts("JetBrains Mono"))),
            new XElement(Word + "style", W("type", "character"), W("styleId", "CodeChar"), new XElement(Word + "name", W("val", "CodeChar")),
                new XElement(Word + "rPr", Fonts("JetBrains Mono"))),
            new XElement(Word + "style", W("type", "paragraph"), W("styleId", "Caption"), new XElement(Word + "name", W("val", "Caption")),
                new XElement(Word + "basedOn", W("val", "Normal")), new XElement(Word + "rPr", new XElement(Word + "i"))));
    }

    private static XAttribute W(string name, object value) => new(Word + name, value);

    internal static (int Width, int Height) VerifyImage(ReadOnlySpan<byte> bytes, string mime,
        CancellationToken cancellationToken = default)
    {
        int width = 0;
        int height = 0;
        if (mime == "image/png")
        {
            if (bytes.Length < 45 || !bytes[..8].SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }))
            {
                throw new InvalidDataException("DOCX PNG is truncated or has the wrong MIME signature.");
            }
            int offset = 8;
            bool data = false;
            bool end = false;
            int channels = 0;
            using var compressed = new MemoryStream();
            while (offset <= bytes.Length - 12)
            {
                cancellationToken.ThrowIfCancellationRequested();
                uint size = BinaryPrimitives.ReadUInt32BigEndian(bytes.Slice(offset, 4));
                if (size > (uint)(bytes.Length - offset - 12))
                {
                    throw new InvalidDataException("DOCX PNG chunk is truncated.");
                }
                int length = checked((int)size);
                ReadOnlySpan<byte> type = bytes.Slice(offset + 4, 4);
                if (offset != 8 && type.SequenceEqual("IHDR"u8)
                    || !type.SequenceEqual("IHDR"u8) && !type.SequenceEqual("IDAT"u8) && !type.SequenceEqual("IEND"u8))
                {
                    throw new InvalidDataException("DOCX PNG chunk sequence or ancillary encoding is unsupported.");
                }
                uint crc = uint.MaxValue;
                foreach (byte value in bytes.Slice(offset + 4, length + 4))
                {
                    crc ^= value;
                    for (int bit = 0; bit < 8; bit++)
                    {
                        crc = (crc >> 1) ^ ((crc & 1) != 0 ? 0xedb88320U : 0);
                    }
                }
                if (~crc != BinaryPrimitives.ReadUInt32BigEndian(bytes.Slice(offset + 8 + length, 4)))
                {
                    throw new InvalidDataException("DOCX PNG chunk CRC mismatch.");
                }
                if (offset == 8)
                {
                    if (!type.SequenceEqual("IHDR"u8) || length != 13)
                    {
                        throw new InvalidDataException("DOCX PNG IHDR is missing.");
                    }
                    width = checked((int)BinaryPrimitives.ReadUInt32BigEndian(bytes.Slice(offset + 8, 4)));
                    height = checked((int)BinaryPrimitives.ReadUInt32BigEndian(bytes.Slice(offset + 12, 4)));
                    byte color = bytes[offset + 17];
                    channels = color == 2 ? 3 : color == 6 ? 4 : 0;
                    if (bytes[offset + 16] != 8 || channels == 0 || bytes[offset + 18] != 0
                        || bytes[offset + 19] != 0 || bytes[offset + 20] != 0
                        || width is < 1 or > 10000 || height is < 1 or > 10000 || (long)width * height > 40000000)
                    {
                        throw new InvalidDataException("DOCX PNG encoding or pixel budget is unsupported.");
                    }
                }
                if (type.SequenceEqual("IDAT"u8))
                {
                    data |= length > 0;
                    compressed.Write(bytes.Slice(offset + 8, length));
                }
                if (type.SequenceEqual("IEND"u8))
                {
                    end = length == 0 && offset + 12 == bytes.Length;
                    break;
                }
                offset += length + 12;
            }
            if (!data || !end)
            {
                throw new InvalidDataException("DOCX PNG lacks a complete data/end sequence.");
            }
            compressed.Position = 0;
            using var decoded = new ZLibStream(compressed, CompressionMode.Decompress);
            byte[] row = new byte[checked(width * channels + 1)];
            try
            {
                for (int index = 0; index < height; index++)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    decoded.ReadExactly(row);
                    if (row[0] > 4)
                    {
                        throw new InvalidDataException("DOCX PNG scanline filter is invalid.");
                    }
                }
                if (decoded.ReadByte() != -1)
                {
                    throw new InvalidDataException("DOCX PNG expanded bytes exceed their pixel dimensions.");
                }
            }
            catch (EndOfStreamException exception)
            {
                throw new InvalidDataException("DOCX PNG scanlines are truncated.", exception);
            }
        }
        else
        {
            throw new InvalidDataException("DOCX media requires a bounded PNG decoder; other MIME types are unsupported.");
        }
        if (width is < 1 or > 10000 || height is < 1 or > 10000 || (long)width * height > 40000000)
        {
            throw new InvalidDataException("DOCX media dimensions are missing or outside the pixel budget.");
        }
        return (width, height);
    }
}
