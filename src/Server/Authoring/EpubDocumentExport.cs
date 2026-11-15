using System.Globalization;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Xml;
using FsusBlog.V2.Core;

namespace FsusBlog.V2.Server.Authoring;

internal static class EpubDocumentExport
{
    internal const string ContentType = "application/epub+zip";
    private const int MaximumOutput = HtmlDocumentExport.MaximumOutput;
    private const string Xhtml = "http://www.w3.org/1999/xhtml";
    private static readonly DateTimeOffset ArchiveEpoch = new(1980, 1, 1, 0, 0, 0, TimeSpan.Zero);
    private static readonly HashSet<string> TextElements = new(StringComparer.Ordinal)
    {
        "html", "head", "title", "body", "main", "article", "div", "h1", "h2", "h3", "h4", "h5", "h6", "p", "br", "hr",
        "ul", "ol", "li", "blockquote", "strong", "em", "code", "pre",
    };

    internal static byte[] Write(string title, string body, DateTimeOffset happenedAt, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(title)) throw Invalid("EPUB requires a saved article title.");
        var content = HtmlDocumentExport.RenderBody(title, body, "EPUB", ct);
        var heading = HtmlEncoder.Default.Encode(title);
        var chapter = $"""
            <?xml version="1.0" encoding="UTF-8"?>
            <html xmlns="{Xhtml}" lang="und" xml:lang="und" dir="auto">
            <head><title>{heading}</title></head>
            <body><main><article><h1>{heading}</h1><div dir="auto">
            {content}
            </div></article></main></body></html>
            """;
        if (Encoding.UTF8.GetByteCount(chapter) > MaximumOutput) throw HtmlDocumentExport.TooLarge("EPUB");
        ValidateChapter(chapter, ct);
        var chapterBytes = Encoding.UTF8.GetBytes(chapter);
        var digest = SHA256.HashData(chapterBytes);
        digest[6] = (byte)((digest[6] & 0x0f) | 0x80);
        digest[8] = (byte)((digest[8] & 0x3f) | 0x80);
        var publicationId = new Guid(digest.AsSpan(0, 16), bigEndian: true);
        var modified = happenedAt.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);
        var package = $"""
            <?xml version="1.0" encoding="UTF-8"?>
            <package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="publication">
              <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
                <dc:identifier id="publication">urn:uuid:{publicationId:D}</dc:identifier>
                <dc:title>{heading}</dc:title>
                <dc:language>und</dc:language>
                <meta property="dcterms:modified">{modified}</meta>
                <meta property="schema:accessMode">textual</meta>
                <meta property="schema:accessModeSufficient">textual</meta>
                <meta property="schema:accessibilityFeature">structuralNavigation</meta>
                <meta property="schema:accessibilityFeature">tableOfContents</meta>
                <meta property="schema:accessibilityHazard">none</meta>
              </metadata>
              <manifest>
                <item id="content" href="article.xhtml" media-type="application/xhtml+xml"/>
                <item id="navigation" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
              </manifest>
              <spine><itemref idref="content"/></spine>
            </package>
            """;
        var navigation = $"""
            <?xml version="1.0" encoding="UTF-8"?>
            <html xmlns="{Xhtml}" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en" lang="en">
            <head><title>Contents</title></head>
            <body>
            <nav epub:type="toc"><h1>Contents</h1><ol><li><a href="article.xhtml" xml:lang="und" lang="und">{heading}</a></li></ol></nav>
            <nav epub:type="landmarks"><h2>Landmarks</h2><ol><li><a epub:type="bodymatter" href="article.xhtml">Article</a></li></ol></nav>
            </body></html>
            """;
        using var output = new MemoryStream();
        using (var zip = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true))
        {
            WritePart(zip, "mimetype", "application/epub+zip"u8, CompressionLevel.NoCompression);
            WritePart(zip, "META-INF/container.xml", Encoding.UTF8.GetBytes(Container));
            WritePart(zip, "EPUB/package.opf", Encoding.UTF8.GetBytes(package));
            WritePart(zip, "EPUB/nav.xhtml", Encoding.UTF8.GetBytes(navigation));
            WritePart(zip, "EPUB/article.xhtml", chapterBytes);
        }
        ct.ThrowIfCancellationRequested();
        if (output.Length > MaximumOutput) throw HtmlDocumentExport.TooLarge("EPUB");
        return output.ToArray();
    }

    private static void ValidateChapter(string chapter, CancellationToken ct)
    {
        try
        {
            using var input = new StringReader(chapter);
            using var xml = XmlReader.Create(input, new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null });
            while (xml.Read())
            {
                ct.ThrowIfCancellationRequested();
                if (xml.NodeType != XmlNodeType.Element) continue;
                if (xml.NamespaceURI != Xhtml || !TextElements.Contains(xml.LocalName))
                    throw Invalid("This revision contains markup outside the EPUB text profile.");
                var element = xml.LocalName;
                while (xml.MoveToNextAttribute())
                    if (!(element == "html" && xml.Name is "xmlns" or "xml:lang" or "lang" or "dir") &&
                        !(element == "div" && xml.Name == "dir") &&
                        !(element == "code" && xml.Name == "class") && !(element == "ol" && xml.Name == "start"))
                        throw Invalid("This revision contains markup outside the EPUB text profile.");
                xml.MoveToElement();
            }
        }
        catch (XmlException)
        {
            throw Invalid("This revision contains characters that cannot be represented in EPUB.");
        }
    }

    private static void WritePart(ZipArchive zip, string name, ReadOnlySpan<byte> contents,
        CompressionLevel compression = CompressionLevel.Fastest)
    {
        var entry = zip.CreateEntry(name, compression);
        entry.LastWriteTime = ArchiveEpoch;
        using var stream = entry.Open();
        stream.Write(contents);
    }

    private static BusinessException Invalid(string message) => new(Rejection.Invalid, message);

    private const string Container = """
        <?xml version="1.0" encoding="UTF-8"?>
        <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
          <rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles>
        </container>
        """;
}
