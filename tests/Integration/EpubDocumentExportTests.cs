using System.Buffers.Binary;
using System.IO.Compression;
using System.Xml.Linq;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Authoring;
using FsusBlog.V2.Server.Content;
using SkiaSharp;
using Xunit.Sdk;

public sealed class EpubDocumentExportTests
{
    private const string Title = "Saved <demo> & 版本";
    private static readonly DateTimeOffset HappenedAt = new(2026, 10, 7, 19, 5, 28, 215, TimeSpan.FromHours(8));
    private static readonly XNamespace Container = "urn:oasis:names:tc:opendocument:xmlns:container";
    private static readonly XNamespace Opf = "http://www.idpf.org/2007/opf";
    private static readonly XNamespace Dc = "http://purl.org/dc/elements/1.1/";
    private static readonly XNamespace Xhtml = "http://www.w3.org/1999/xhtml";
    private static readonly XNamespace Epub = "http://www.idpf.org/2007/ops";

    [Fact]
    public void WritesDeterministicEpubWithNavigationAndSafeReflowableText()
    {
        const string markdown = """
            ## 一章

            A paragraph with **emphasis**, &copy;, and مرحبا 😀.

            4. First item
            5. Second item

            | Heading | Units |
            | --- | ---: |
            | **Count** | 12 |

            ```html
            <iframe src="https://export.invalid/blocked"></iframe>
            ```

            <script>alert(1)</script>
            """;
        var bytes = EpubDocumentExport.Write(Title, markdown, HappenedAt, CancellationToken.None);
        Assert.Equal(bytes, EpubDocumentExport.Write(Title, markdown, HappenedAt, CancellationToken.None));
        var chapter = AssertFile(bytes, Title, "2026-10-07T11:05:28Z");
        Assert.Equal("一章", Assert.Single(chapter.Descendants(Xhtml + "h2")).Value);
        Assert.Equal(new[] { "emphasis", "Count" }, chapter.Descendants(Xhtml + "strong").Select(node => node.Value));
        var table = Assert.Single(chapter.Descendants(Xhtml + "table"));
        Assert.Equal(new[] { "Heading", "Units" }, table.Descendants(Xhtml + "th").Select(node => node.Value));
        Assert.Equal(new[] { "Count", "12" }, table.Descendants(Xhtml + "td").Select(node => node.Value));
        Assert.Equal("text-align: right;", table.Descendants(Xhtml + "td").Last().Attribute("style")?.Value);
        var legacy = AssertFile(EpubDocumentExport.Write(Title, markdown, HappenedAt, CancellationToken.None, includeTables: false),
            Title, "2026-10-07T11:05:28Z");
        Assert.Empty(legacy.Descendants(Xhtml + "table"));
        Assert.Contains("| Heading | Units |", legacy.Root!.Value, StringComparison.Ordinal);
        Assert.Equal("4", (string?)Assert.Single(chapter.Descendants(Xhtml + "ol")).Attribute("start"));
        Assert.Contains("©, and مرحبا 😀.", chapter.Root!.Value, StringComparison.Ordinal);
        Assert.Contains("<iframe src=", Assert.Single(chapter.Descendants(Xhtml + "code")).Value, StringComparison.Ordinal);
        Assert.Contains("<script>alert(1)</script>", chapter.Root.Value, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("[relative](other.xhtml)")]
    [InlineData("![remote](https://export.invalid/blocked)")]
    [InlineData("| Item | Value |\n| --- | --- |\n| [outside](https://export.invalid/blocked) | 1 |")]
    [InlineData("~~~mermaid\ngraph TD; A --> B;\n~~~")]
    [InlineData("before\fafter")]
    public void RefusesLinksImagesRenderDirectivesAndInvalidXml(string markdown)
    {
        var error = Assert.Throws<BusinessException>(() =>
            EpubDocumentExport.Write(Title, markdown, HappenedAt, CancellationToken.None));
        Assert.Equal(Rejection.Invalid, error.Rejection);
    }

    [Fact]
    public void RejectsAnEmptyTitleOversizedTextAndCancellation()
    {
        Assert.Throws<BusinessException>(() => EpubDocumentExport.Write(" ", "Body", HappenedAt, CancellationToken.None));
        var error = Assert.Throws<BusinessException>(() =>
            EpubDocumentExport.Write(Title, new string('&', 1024 * 1024), HappenedAt, CancellationToken.None));
        Assert.Contains("size limit", error.Message, StringComparison.Ordinal);
        Assert.Throws<OperationCanceledException>(() =>
            EpubDocumentExport.Write(Title, "Body", HappenedAt, new CancellationToken(true)));
    }

    [Theory]
    [InlineData(1, SKEncodedImageFormat.Png, "png", "image/png")]
    [InlineData(2, SKEncodedImageFormat.Jpeg, "jpeg", "image/jpeg")]
    [InlineData(3, SKEncodedImageFormat.Webp, "webp", "image/webp")]
    public void EmbedsImageBytesAndBindsThePublicationIdentifier(int kind, SKEncodedImageFormat codec, string extension, string mime)
    {
        var (firstId, first) = Package(SKColors.Red);
        var (secondId, second) = Package(SKColors.Green);
        Assert.NotEqual(firstId, secondId);
        Assert.False(first.SequenceEqual(second));

        (string Id, byte[] Bytes) Package(SKColor color)
        {
            using var bitmap = new SKBitmap(3, 2);
            bitmap.Erase(color);
            using var encoded = bitmap.Encode(codec, 90);
            var bytes = encoded.ToArray();
            var image = new DocumentExportAttachment("image " + extension, (MediaFormat)kind, 3, 2, bytes);
            var document = EpubDocumentExport.Write(Title, "Body", HappenedAt, CancellationToken.None, attachment: image);
            using var package = new ZipArchive(new MemoryStream(document));
            var entry = $"images/attachment.{extension}";
            var metadata = Read(package, "EPUB/package.opf");
            var resource = Assert.Single(metadata.Descendants(Opf + "item"), item => (string?)item.Attribute("id") == "attachment");
            Assert.Equal((entry, mime), ((string?)resource.Attribute("href"), (string?)resource.Attribute("media-type")));
            using var contents = package.GetEntry("EPUB/" + entry)!.Open();
            using var actual = new MemoryStream();
            contents.CopyTo(actual);
            Assert.Equal(bytes, actual.ToArray());
            return (Assert.Single(metadata.Descendants(Dc + "identifier")).Value, document);
        }
    }

    [Fact]
    public void IndependentPackageCheckRejectsACompressedMimetypeHeader()
    {
        var bytes = EpubDocumentExport.Write(Title, "Body", HappenedAt, CancellationToken.None);
        BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(8, 2), 8);
        Assert.ThrowsAny<XunitException>(() => AssertFile(bytes, Title, "2026-10-07T11:05:28Z"));
    }

    internal static XDocument AssertFile(byte[] bytes, string title, string modified)
    {
        Assert.Equal(0x04034b50u, BinaryPrimitives.ReadUInt32LittleEndian(bytes));
        Assert.Equal(0, BinaryPrimitives.ReadUInt16LittleEndian(bytes.AsSpan(6, 2)) & 1);
        Assert.Equal((ushort)0, BinaryPrimitives.ReadUInt16LittleEndian(bytes.AsSpan(8, 2)));
        Assert.Equal((ushort)8, BinaryPrimitives.ReadUInt16LittleEndian(bytes.AsSpan(26, 2)));
        Assert.Equal((ushort)0, BinaryPrimitives.ReadUInt16LittleEndian(bytes.AsSpan(28, 2)));
        Assert.True(bytes.AsSpan(30, 8).SequenceEqual("mimetype"u8));
        Assert.True(bytes.AsSpan(38, 20).SequenceEqual("application/epub+zip"u8));

        using var stream = new MemoryStream(bytes);
        using var zip = new ZipArchive(stream, ZipArchiveMode.Read);
        Assert.Equal(new[] { "mimetype", "META-INF/container.xml", "EPUB/package.opf", "EPUB/nav.xhtml", "EPUB/article.xhtml" },
            zip.Entries.Select(entry => entry.FullName));
        var rootfile = Assert.Single(Read(zip, "META-INF/container.xml").Descendants(Container + "rootfile"));
        Assert.Equal("EPUB/package.opf", (string?)rootfile.Attribute("full-path"));
        Assert.Equal("application/oebps-package+xml", (string?)rootfile.Attribute("media-type"));

        var package = Read(zip, "EPUB/package.opf").Root!;
        Assert.Equal(Opf + "package", package.Name);
        Assert.Equal("3.0", (string?)package.Attribute("version"));
        var metadata = package.Element(Opf + "metadata")!;
        var identifier = Assert.Single(metadata.Elements(Dc + "identifier"));
        Assert.Equal((string?)package.Attribute("unique-identifier"), (string?)identifier.Attribute("id"));
        Assert.Matches(@"^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", identifier.Value);
        Assert.Equal(title, Assert.Single(metadata.Elements(Dc + "title")).Value);
        Assert.Equal("und", Assert.Single(metadata.Elements(Dc + "language")).Value);
        Assert.Equal(modified, MetadataValue("dcterms:modified"));
        Assert.Equal("textual", MetadataValue("schema:accessMode"));
        Assert.Equal("none", MetadataValue("schema:accessibilityHazard"));

        var manifest = package.Element(Opf + "manifest")!.Elements(Opf + "item")
            .ToDictionary(entry => (string)entry.Attribute("id")!, StringComparer.Ordinal);
        Assert.Equal(2, manifest.Count);
        var item = Assert.Single(package.Element(Opf + "spine")!.Elements(Opf + "itemref"));
        Assert.Equal("article.xhtml", (string?)manifest[(string)item.Attribute("idref")!].Attribute("href"));
        var navItem = Assert.Single(manifest.Values, entry => (string?)entry.Attribute("properties") == "nav");
        Assert.Equal("nav.xhtml", (string?)navItem.Attribute("href"));
        foreach (var entry in manifest.Values)
            Assert.Equal("application/xhtml+xml", (string?)entry.Attribute("media-type"));
        var nav = Read(zip, "EPUB/nav.xhtml");
        var toc = Assert.Single(nav.Descendants(Xhtml + "nav"), elem => (string?)elem.Attribute(Epub + "type") == "toc");
        var link = Assert.Single(toc.Descendants(Xhtml + "a"));
        Assert.Equal(title, link.Value);
        Assert.Equal("article.xhtml", (string?)link.Attribute("href"));
        var landmarks = Assert.Single(nav.Descendants(Xhtml + "nav"), elem => (string?)elem.Attribute(Epub + "type") == "landmarks");
        Assert.Equal("bodymatter", (string?)Assert.Single(landmarks.Descendants(Xhtml + "a")).Attribute(Epub + "type"));
        Assert.All(nav.Descendants(Xhtml + "a"), anchor => Assert.Equal("article.xhtml", (string?)anchor.Attribute("href")));

        var chapter = Read(zip, "EPUB/article.xhtml");
        Assert.Equal(Xhtml + "html", chapter.Root!.Name);
        Assert.Equal("auto", (string?)chapter.Root.Attribute("dir"));
        Assert.Equal(title, Assert.Single(chapter.Descendants(Xhtml + "article")).Elements(Xhtml + "h1").First().Value);
        Assert.DoesNotContain(chapter.Descendants(), element => element.Name.LocalName is "script" or "iframe" or "img" or "form" or "link" or "style");
        Assert.DoesNotContain(chapter.Descendants().Attributes(), attr => attr.Name.LocalName is "href" or "src" or "srcset");
        return chapter;

        string MetadataValue(string property) =>
            Assert.Single(metadata.Elements(Opf + "meta"), e => (string?)e.Attribute("property") == property).Value;
    }

    private static XDocument Read(ZipArchive zip, string path)
    {
        using var content = zip.GetEntry(path)!.Open();
        return XDocument.Load(content);
    }
}
