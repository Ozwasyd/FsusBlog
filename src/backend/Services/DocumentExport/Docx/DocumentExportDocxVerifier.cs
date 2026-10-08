using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Xml;
using System.Xml.Linq;

using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Validation;

namespace FsusBlog.Server.Services.DocumentExport;

/// <summary>
/// Independently opens the produced ZIP, checks the closed relationship graph,
/// validates actual Open XML schemas and compares canonical text/links/media.
/// A successful tool exit or a resealed output digest cannot bypass this gate.
/// </summary>
internal static class DocumentExportDocxVerifier
{
    private static readonly string[] s_fixedParts =
    [
        "[Content_Types].xml", "_rels/.rels", "docProps/core.xml", "word/_rels/document.xml.rels",
        "word/document.xml", "word/fontTable.xml", "word/footnotes.xml", "word/numbering.xml", "word/styles.xml"
    ];

    private static readonly HashSet<string> s_wordElements = new(StringComparer.Ordinal)
    {
        "document", "body", "p", "pPr", "pStyle", "r", "rPr", "rStyle", "t", "br", "tab", "b", "i", "u", "strike",
        "vertAlign", "bidi", "rtl", "hyperlink", "bookmarkStart", "bookmarkEnd", "drawing", "sectPr", "pgSz", "pgMar",
        "tbl", "tblPr", "tblW", "tblGrid", "gridCol", "tr", "trPr", "tblHeader", "tc", "tcPr", "tcW",
        "footnoteReference", "footnotes", "footnote", "footnoteRef", "separator", "continuationSeparator",
        "styles", "style", "name", "basedOn", "keepNext", "outlineLvl", "rFonts", "sz", "lang", "docDefaults",
        "rPrDefault", "pPrDefault", "fonts", "font", "family", "numbering", "abstractNum", "lvl", "start", "numFmt",
        "lvlText", "lvlJc", "num", "abstractNumId", "numPr", "ilvl", "numId"
    };

    internal static string Validate(
        byte[] bytes,
        DocumentExportDocxProjection projection,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(bytes);
        cancellationToken.ThrowIfCancellationRequested();
        if (bytes.Length == 0 || bytes.LongLength > DocumentExportDocxPackage.MaximumOutputBytes)
        {
            throw new InvalidDataException("DOCX output is empty or exceeds its byte budget.");
        }
        XElement canonical = projection.ReadRoot();
        try
        {
            Dictionary<string, byte[]> parts = ReadParts(bytes, projection, cancellationToken);
            Dictionary<string, XElement> xml = parts.Where(part => part.Key.EndsWith(".xml", StringComparison.Ordinal)
                    || part.Key.EndsWith(".rels", StringComparison.Ordinal))
                .ToDictionary(part => part.Key, part => ReadXml(part.Value), StringComparer.Ordinal);
            ValidateContentTypes(xml["[Content_Types].xml"], projection);
            ValidateRelationships(xml, parts, canonical);
            ValidateMetadata(xml["docProps/core.xml"], projection);
            foreach ((string path, XElement root) in xml.Where(part => part.Key.StartsWith("word/", StringComparison.Ordinal)
                && !part.Key.EndsWith(".rels", StringComparison.Ordinal)))
            {
                foreach (XElement element in root.DescendantsAndSelf())
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (element.Name.Namespace == DocumentExportDocxPackage.Word && !s_wordElements.Contains(element.Name.LocalName))
                    {
                        throw new InvalidDataException("DOCX contains a field, macro, embedded object or unregistered WML element.");
                    }
                    if (element.Attributes().Any(attribute => attribute.Name.LocalName is "link" or "instr"))
                    {
                        throw new InvalidDataException("DOCX contains an active field or remote image link.");
                    }
                }
            }
            using (var source = new MemoryStream(bytes, writable: false))
            using (WordprocessingDocument document = WordprocessingDocument.Open(source, false, new OpenSettings { AutoSave = false }))
            {
                var validator = new OpenXmlValidator(FileFormatVersions.Office2019) { MaxNumberOfErrors = 1 };
                if (validator.Validate(document, cancellationToken).Any())
                {
                    throw new InvalidDataException("DOCX failed actual Open XML schema/package validation.");
                }
            }
            ValidateSemantics(xml, canonical, projection);
            // Schema validation and semantic rereads above are independent of
            // the producer. Exact normalized-part binding additionally protects
            // whitespace, styles, numbering, layout and media placement from
            // schema-valid mutations that preserve the coarser semantic checks.
            byte[] expectedBytes = DocumentExportDocxPackage.Render(projection, cancellationToken);
            if (!bytes.AsSpan().SequenceEqual(expectedBytes))
            {
                throw new InvalidDataException("DOCX normalized package differs from the frozen projection/style profile.");
            }
            using IncrementalHash digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            foreach ((string path, byte[] content) in parts.OrderBy(part => part.Key, StringComparer.Ordinal))
            {
                digest.AppendData(Encoding.UTF8.GetBytes(path + "\0"));
                digest.AppendData(SHA256.HashData(content));
            }
            return "sha256:" + Convert.ToHexStringLower(digest.GetHashAndReset());
        }
        catch (Exception exception) when (exception is XmlException or ArgumentException or OpenXmlPackageException)
        {
            throw new InvalidDataException("DOCX package is malformed or outside the closed schema.", exception);
        }
    }

    private static Dictionary<string, byte[]> ReadParts(
        byte[] bytes,
        DocumentExportDocxProjection projection,
        CancellationToken cancellationToken)
    {
        string[] media = projection.Images.Select((image, index) =>
            $"word/media/image{index + 1}.{(image.MediaType == "image/png" ? "png" : "jpg")}").ToArray();
        string[] expected = s_fixedParts.Concat(media).Order(StringComparer.Ordinal).ToArray();
        using var source = new MemoryStream(bytes, writable: false);
        using var zip = new ZipArchive(source, ZipArchiveMode.Read, leaveOpen: false, Encoding.UTF8);
        if (zip.Entries.Count > DocumentExportDocxPackage.MaximumParts
            || !zip.Entries.Select(entry => entry.FullName).SequenceEqual(expected, StringComparer.Ordinal))
        {
            throw new InvalidDataException("DOCX entries are missing, duplicated, unsafe, unordered or not registered.");
        }
        var parts = new Dictionary<string, byte[]>(StringComparer.Ordinal);
        long total = 0;
        foreach (ZipArchiveEntry entry in zip.Entries)
        {
            cancellationToken.ThrowIfCancellationRequested();
            total = checked(total + entry.Length);
            const long maximumPart = 8 * 1024 * 1024;
            if (entry.Length <= 0 || entry.Length > maximumPart || total > DocumentExportDocxPackage.MaximumOutputBytes
                || entry.LastWriteTime != DocumentExportDocxPackage.ZipTimestamp || entry.ExternalAttributes != 0
                || entry.CompressedLength != entry.Length)
            {
                throw new InvalidDataException("DOCX part length, compression or normalized ZIP metadata is invalid.");
            }
            using Stream content = entry.Open();
            using var bounded = new DocumentExportBoundedMemoryStream(maximumPart, "DOCX expanded part exceeds its budget.");
            content.CopyTo(bounded);
            byte[] actual = bounded.ToArray();
            if (actual.LongLength != entry.Length)
            {
                throw new InvalidDataException("DOCX part expanded length mismatch.");
            }
            parts.Add(entry.FullName, actual);
        }
        for (int index = 0; index < media.Length; index++)
        {
            DocumentExportAsset image = projection.Images[index];
            if (!parts[media[index]].AsSpan().SequenceEqual(image.Bytes.AsSpan())
                || DocumentExportDigest.ComputeBytes(parts[media[index]]) != image.Sha256)
            {
                throw new InvalidDataException("DOCX media drifted from frozen inventory.");
            }
            DocumentExportDocxPackage.VerifyImage(parts[media[index]], image.MediaType, cancellationToken);
        }
        return parts;
    }

    private static XElement ReadXml(byte[] bytes)
    {
        using var source = new MemoryStream(bytes, writable: false);
        using XmlReader reader = XmlReader.Create(source, new XmlReaderSettings
        {
            DtdProcessing = DtdProcessing.Prohibit,
            XmlResolver = null,
            MaxCharactersInDocument = 8 * 1024 * 1024,
            MaxCharactersFromEntities = 0,
            IgnoreComments = false,
            IgnoreProcessingInstructions = false
        });
        XDocument document = XDocument.Load(reader, LoadOptions.PreserveWhitespace);
        if (document.Root is null || document.DescendantNodes().Any(node => node is XComment or XProcessingInstruction or XCData)
            || document.Root.Descendants().Count() > DocumentExportDocxProjection.MaximumNodes * 20
            || document.Root.Descendants().Any(element => element.Ancestors().Count() > 64))
        {
            throw new InvalidDataException("DOCX XML part violates the structural limits.");
        }
        return document.Root;
    }

    private static void ValidateContentTypes(XElement types, DocumentExportDocxProjection projection)
    {
        XNamespace ct = DocumentExportDocxPackage.ContentType;
        var expected = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["rels"] = "application/vnd.openxmlformats-package.relationships+xml",
            ["/docProps/core.xml"] = "application/vnd.openxmlformats-package.core-properties+xml"
        };
        foreach (string part in new[] { "document", "styles", "numbering", "fontTable", "footnotes" })
        {
            expected.Add($"/word/{part}.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml."
                + (part == "document" ? "document.main" : part) + "+xml");
        }
        foreach (string mime in projection.Images.Select(image => image.MediaType).Distinct(StringComparer.Ordinal))
        {
            expected.Add(mime == "image/png" ? "png" : "jpg", mime);
        }
        if (types.Name != ct + "Types" || types.Attributes().Any(attribute => !attribute.IsNamespaceDeclaration)
            || types.Elements().Count() != expected.Count)
        {
            throw new InvalidDataException("DOCX content type roster is not closed.");
        }
        foreach (XElement item in types.Elements())
        {
            string key = (string?)(item.Attribute("PartName") ?? item.Attribute("Extension")) ?? string.Empty;
            if (item.Name != ct + (key.StartsWith('/') ? "Override" : "Default") || item.HasElements
                || item.Attributes().Count() != 2 || !expected.Remove(key, out string? value)
                || (string?)item.Attribute("ContentType") != value)
            {
                throw new InvalidDataException("DOCX content type is unexpected, duplicated or unsafe.");
            }
        }
    }

    private static void ValidateRelationships(
        IReadOnlyDictionary<string, XElement> xml,
        IReadOnlyDictionary<string, byte[]> parts,
        XElement canonical)
    {
        XNamespace rel = DocumentExportDocxPackage.Relationship;
        XNamespace package = DocumentExportDocxPackage.PackageRelationship;
        XElement[] rootRelationships = xml["_rels/.rels"].Elements().ToArray();
        if (rootRelationships.Length != 2
            || (string?)rootRelationships[0].Attribute("Type") != rel.NamespaceName + "/officeDocument"
            || (string?)rootRelationships[0].Attribute("Target") != "word/document.xml"
            || (string?)rootRelationships[1].Attribute("Type") != "http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
            || (string?)rootRelationships[1].Attribute("Target") != "docProps/core.xml")
        {
            throw new InvalidDataException("DOCX package root relationships are invalid.");
        }
        var documentRelationships = new Dictionary<string, XElement>(StringComparer.Ordinal);
        foreach (string path in new[] { "_rels/.rels", "word/_rels/document.xml.rels" })
        {
            XElement root = xml[path];
            var ids = new HashSet<string>(StringComparer.Ordinal);
            int index = 0;
            if (root.Name != package + "Relationships")
            {
                throw new InvalidDataException("DOCX relationship namespace mismatch.");
            }
            foreach (XElement item in root.Elements())
            {
                string id = (string?)item.Attribute("Id") ?? string.Empty;
                string target = (string?)item.Attribute("Target") ?? string.Empty;
                string type = (string?)item.Attribute("Type") ?? string.Empty;
                bool external = item.Attribute("TargetMode") is not null;
                if (item.Name != package + "Relationship" || item.HasElements || !ids.Add(id) || id != $"rId{++index}"
                    || item.Attributes().Count() != (external ? 4 : 3))
                {
                    throw new InvalidDataException("DOCX relationship shape or deterministic identity is invalid.");
                }
                if (external)
                {
                    if (path != "word/_rels/document.xml.rels" || type != rel.NamespaceName + "/hyperlink"
                        || (string?)item.Attribute("TargetMode") != "External"
                        || !Uri.TryCreate(target, UriKind.Absolute, out Uri? uri) || uri.UserInfo.Length != 0
                        || uri.Scheme is not ("http" or "https"))
                    {
                        throw new InvalidDataException("DOCX remote relationship is not a preserved safe user hyperlink.");
                    }
                }
                else
                {
                    string absolute = path == "_rels/.rels" ? target : "word/" + target;
                    if (target.Contains("..", StringComparison.Ordinal) || target.Contains(':') || target.Contains('\\')
                        || target.StartsWith('/') || !parts.ContainsKey(absolute))
                    {
                        throw new InvalidDataException("DOCX relationship escapes or lacks a registered target.");
                    }
                    if (path.StartsWith("word/", StringComparison.Ordinal)
                        && !new[] { "styles", "numbering", "fontTable", "footnotes", "image" }.Any(value => type == rel.NamespaceName + "/" + value))
                    {
                        throw new InvalidDataException("DOCX relationship type is outside the closed provider subset.");
                    }
                }
                if (path.StartsWith("word/", StringComparison.Ordinal))
                {
                    documentRelationships.Add(id, item);
                }
            }
        }
        XElement document = xml["word/document.xml"];
        foreach (XAttribute attribute in document.Descendants().Attributes()
            .Where(attribute => attribute.Name.Namespace == rel))
        {
            if (!documentRelationships.TryGetValue(attribute.Value, out XElement? relationship)
                || attribute.Name.LocalName is not ("id" or "embed")
                || (string?)relationship.Attribute("Type") != rel.NamespaceName + "/" + (attribute.Name.LocalName == "id" ? "hyperlink" : "image"))
            {
                throw new InvalidDataException("DOCX relationship reference is dangling or has the wrong type.");
            }
        }
        string[] expectedLinks = canonical.Descendants().Where(element => element.Name.LocalName == "a")
            .Select(element => (string)element.Attribute("href")!).Where(href => !href.StartsWith('#')).ToArray();
        string[] actualLinks = document.Descendants(DocumentExportDocxPackage.Word + "hyperlink")
            .Where(element => element.Attribute(rel + "id") is not null)
            .Select(element => (string)documentRelationships[(string)element.Attribute(rel + "id")!].Attribute("Target")!).ToArray();
        if (!actualLinks.SequenceEqual(expectedLinks, StringComparer.Ordinal))
        {
            throw new InvalidDataException("DOCX canonical link order or targets drifted.");
        }
        foreach (XElement relationship in documentRelationships.Values.Where(item => (string?)item.Attribute("Type") == rel.NamespaceName + "/hyperlink"
            || (string?)item.Attribute("Type") == rel.NamespaceName + "/image"))
        {
            string id = (string)relationship.Attribute("Id")!;
            if (!document.Descendants().Attributes().Any(attribute => attribute.Name.Namespace == rel && attribute.Value == id))
            {
                throw new InvalidDataException("DOCX has an unused media or hyperlink relationship.");
            }
        }
    }

    private static void ValidateMetadata(XElement core, DocumentExportDocxProjection projection)
    {
        XNamespace cp = "http://schemas.openxmlformats.org/package/2006/metadata/core-properties";
        XNamespace dc = "http://purl.org/dc/elements/1.1/";
        XNamespace terms = "http://purl.org/dc/terms/";
        if (core.Name != cp + "coreProperties" || core.Elements().Count() != 6
            || (string?)core.Element(dc + "title") != projection.Title || (string?)core.Element(dc + "language") != projection.Locale
            || (string?)core.Element(cp + "revision") != "1" || (string?)core.Element(cp + "lastModifiedBy") != "FsusBlog"
            || (string?)core.Element(terms + "created") != DocumentExportDocxPackage.FixedTimestamp
            || (string?)core.Element(terms + "modified") != DocumentExportDocxPackage.FixedTimestamp)
        {
            throw new InvalidDataException("DOCX normalized core properties drifted.");
        }
    }

    private static void ValidateSemantics(
        IReadOnlyDictionary<string, XElement> xml,
        XElement canonical,
        DocumentExportDocxProjection projection)
    {
        XNamespace w = DocumentExportDocxPackage.Word;
        XElement document = xml["word/document.xml"];
        XElement footnotes = xml["word/footnotes.xml"];
        DocumentExportDocxFootnote[] graph = DocumentExportDocxFootnote.ReadGraph(canonical);
        XElement[] notes = graph.Select(note => note.ReadContent()).ToArray();
        XElement body = document.Element(w + "body") ?? throw new InvalidDataException("DOCX body is missing.");
        if (!body.Elements().Any(element => element.Name is var name && (name == w + "p" || name == w + "tbl")))
        {
            throw new InvalidDataException("DOCX body contains no semantic blocks.");
        }
        XElement withoutNotes = new(canonical);
        withoutNotes.Descendants().Where(element => DocumentExportDocxFootnote.HasClass(element, "footnotes")).Remove();
        withoutNotes.Descendants().Where(element => DocumentExportDocxFootnote.HasClass(element, "footnote-ref")).Remove();
        foreach (XElement hr in withoutNotes.Descendants().Where(element => element.Name.LocalName == "hr").ToArray())
        {
            hr.ReplaceWith(new XText("—"));
        }
        foreach (XElement pre in withoutNotes.Descendants().Where(element => element.Name.LocalName == "pre").ToArray())
        {
            string? language = pre.Descendants().FirstOrDefault(child => child.Name.LocalName == "code")?
                .Attribute("class")?.Value.Split(' ').FirstOrDefault(value => value.StartsWith("language-", StringComparison.Ordinal));
            if (language is not null)
            {
                pre.AddBeforeSelf(new XText(language[9..]));
            }
        }
        static string Compact(string value) => string.Concat(value.Where(character => !char.IsWhiteSpace(character)));
        static string Text(XElement element) => string.Concat(element.Descendants(DocumentExportDocxPackage.Word + "t").Select(text => text.Value));
        if (Compact(Text(body)) != Compact(withoutNotes.Value)
            || !footnotes.Elements(w + "footnote").Where(note => (int)note.Attribute(w + "id")! > 0)
                .Select(note => Compact(Text(note))).SequenceEqual(notes.Select(note => Compact(note.Value)), StringComparer.Ordinal))
        {
            throw new InvalidDataException("DOCX canonical text or semantic order drifted.");
        }
        string[] expectedHeadings = canonical.Descendants().Where(element => element.Name.LocalName.Length == 2
            && element.Name.LocalName[0] == 'h' && element.Name.LocalName[1] is >= '1' and <= '6')
            .Select(element => "Heading" + element.Name.LocalName[1]).ToArray();
        string[] actualHeadings = document.Descendants(w + "pStyle").Select(element => (string)element.Attribute(w + "val")!)
            .Where(value => value.StartsWith("Heading", StringComparison.Ordinal)).ToArray();
        XElement[] code = document.Descendants(w + "p").Where(paragraph =>
            (string?)paragraph.Element(w + "pPr")?.Element(w + "pStyle")?.Attribute(w + "val") == "Code").ToArray();
        string ReadCode(XElement paragraph) => string.Concat(paragraph.Descendants().Where(element => element.Name == w + "t"
            || element.Name == w + "br" || element.Name == w + "tab")
            .Select(element => element.Name == w + "t" ? element.Value : element.Name == w + "br" ? "\n" : "\t"));
        if (!actualHeadings.SequenceEqual(expectedHeadings, StringComparer.Ordinal)
            || !code.Select(ReadCode).SequenceEqual(canonical.Descendants().Where(element => element.Name.LocalName == "pre")
                .Select(element => element.Value.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n')), StringComparer.Ordinal)
            || document.Descendants(w + "tbl").Count() != canonical.Descendants().Count(element => element.Name.LocalName == "table")
            || document.Descendants(w + "drawing").Count() != projection.Images.Length)
        {
            throw new InvalidDataException("DOCX heading/code/table/media semantics drifted.");
        }
        string[] starts = document.Descendants(w + "bookmarkStart").Select(element => (string)element.Attribute(w + "id")!).ToArray();
        string[] ends = document.Descendants(w + "bookmarkEnd").Select(element => (string)element.Attribute(w + "id")!).ToArray();
        var anchors = document.Descendants(w + "bookmarkStart").Select(element => (string)element.Attribute(w + "name")!).ToHashSet(StringComparer.Ordinal);
        if (starts.Distinct(StringComparer.Ordinal).Count() != starts.Length || !starts.Order().SequenceEqual(ends.Order(), StringComparer.Ordinal)
            || document.Descendants(w + "hyperlink").Attributes(w + "anchor").Any(anchor => !anchors.Contains(anchor.Value)))
        {
            throw new InvalidDataException("DOCX bookmark identities or internal links are invalid.");
        }
        int[] actualReferences = document.Descendants(w + "footnoteReference").Select(element => (int)element.Attribute(w + "id")!).ToArray();
        XElement[] actualNotes = footnotes.Elements(w + "footnote").Where(note => (int)note.Attribute(w + "id")! > 0).ToArray();
        int[] expectedReferences = Enumerable.Range(1, graph.Length).ToArray();
        if (!actualReferences.SequenceEqual(expectedReferences)
            || !actualNotes.Select(note => (int)note.Attribute(w + "id")!).SequenceEqual(expectedReferences)
            || actualNotes.Any(note => note.Descendants(w + "footnoteRef").Count() != 1)
            || footnotes.Descendants(w + "footnoteReference").Any() || document.Descendants(w + "footnoteRef").Any())
        {
            throw new InvalidDataException("DOCX footnote graph, definitions or native markers drifted.");
        }
    }
}
