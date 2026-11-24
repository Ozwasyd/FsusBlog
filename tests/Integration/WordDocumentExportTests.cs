using System.IO.Compression;

public sealed class WordDocumentExportTests
{
    internal const string Title = "Word export — 原稿 📝";
    internal static readonly string Markdown = """
        ## Saved outline

        A paragraph with ampersands & angle brackets <literal> and accented words Café.

        ```js
        const value = "quoted & <safe>";
        TABreturn value;
        ```

        ![private picture](/api/v2/authoring/media/112233)
        [Local file](file:///etc/passwd)
        <script>alert('seen as text')</script>
        """.Replace("TAB", "\t", StringComparison.Ordinal);

    private static readonly XNamespace Word = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

    [Fact]
    public void ProducesDeterministicWordPackageWithClosedPartsAndInertText()
    {
        var bytes = WordDocumentExport.Write(Title, Markdown, CancellationToken.None);
        Assert.Equal(bytes, WordDocumentExport.Write(Title, Markdown, CancellationToken.None));
        AssertFile(bytes, Title, "Saved outline", "const value", "![private picture]", "file:///etc/passwd", "<script>alert");
        using var zip = new ZipArchive(new MemoryStream(bytes), ZipArchiveMode.Read);
        var document = Read(zip, "word/document.xml");
        var paragraphs = document.Descendants(Word + "p").ToArray();
        var style = new Func<XElement, string?>(p => p.Element(Word + "pPr")?.Element(Word + "pStyle")?.Attribute(Word + "val")?.Value);
        Assert.Equal("Title", style(paragraphs[0]));
        Assert.Equal("Heading2", style(paragraphs[1]));
        Assert.Equal("Saved outline", Assert.Single(paragraphs[1].Descendants(Word + "t")).Value);
        var code = Assert.Single(paragraphs, p => style(p) == "SourceCode");
        Assert.Contains("const value = \"quoted & <safe>\"", code.Value, StringComparison.Ordinal);
        Assert.Single(code.Descendants(Word + "tab"));
        Assert.Single(code.Descendants(Word + "br"));
    }

    [Fact]
    public void RejectsUnsupportedXmlCharactersOversizedStructuralInputAndCancellation()
    {
        Assert.Throws<BusinessException>(() => WordDocumentExport.Write(Title, "before\fafter", CancellationToken.None));
        Assert.Throws<BusinessException>(() => WordDocumentExport.Write(Title, new string('\n', 16_385), CancellationToken.None));
        Assert.Throws<OperationCanceledException>(() => WordDocumentExport.Write(Title, Markdown, new CancellationToken(true)));
    }

    [Fact]
    public void LinkReferencesAndRawMarkupRemainLiteral()
    {
        const string source = "[ref]: https://example.com/docs \"example\"\n\n# Heading *with markup*\n\n> ![photo][ref]\n\n---\n\n";
        var bytes = WordDocumentExport.Write(Title, source, CancellationToken.None);
        AssertFile(bytes, "[ref]: https://example.com/docs", "# Heading *with markup*", "> ![photo][ref]", "---");
    }

    [Fact]
    public void WritesTableWithRepeatingHeaderAndPreservesEveryCellAsText()
    {
        const string markdown = """
            | Name | Count |
            | --- | ---: |
            | [A](https://export.invalid/) | 12 |
            | B | | Extra value |
            """;
        var bytes = WordDocumentExport.Write(Title, markdown, CancellationToken.None);
        Assert.Equal(bytes, WordDocumentExport.Write(Title, markdown, CancellationToken.None));
        AssertFile(bytes, "[A](https://export.invalid/)", "Extra value");

        using var zip = new ZipArchive(new MemoryStream(bytes), ZipArchiveMode.Read);
        var table = Assert.Single(Read(zip, "word/document.xml").Descendants(Word + "tbl"));
        Assert.Equal(3, table.Descendants(Word + "gridCol").Count());
        var rows = table.Elements(Word + "tr").ToArray();
        Assert.Equal(3, rows.Length);
        Assert.Single(rows[0].Descendants(Word + "tblHeader"));
        Assert.Equal(new[] { "Name", "Count", "" }, rows[0].Elements(Word + "tc").Select(cell => cell.Value));
        Assert.Equal(new[] { "B", "", "Extra value" }, rows[2].Elements(Word + "tc").Select(cell => cell.Value));
        Assert.Equal("right", rows[1].Elements(Word + "tc").ElementAt(1).Descendants(Word + "jc").Single().Attribute(Word + "val")?.Value);

        var legacy = WordDocumentExport.Write(Title, markdown, CancellationToken.None, includeTables: false);
        AssertFile(legacy, "| Name | Count |", "| B | | Extra value |");
        using var legacyZip = new ZipArchive(new MemoryStream(legacy), ZipArchiveMode.Read);
        Assert.Empty(Read(legacyZip, "word/document.xml").Descendants(Word + "tbl"));
    }

    [Fact]
    public void EmbedsJpegInsideThePrintableAreaAndRejectsUnsupportedImageFormats()
    {
        using var bitmap = new SKBitmap(1600, 800);
        bitmap.Erase(SKColors.Blue);
        using var encoded = bitmap.Encode(SKEncodedImageFormat.Jpeg, 90);
        var attachment = new DocumentExportAttachment("A & B.jpeg", MediaFormat.Jpeg, bitmap.Width, bitmap.Height, encoded.ToArray());
        var file = WordDocumentExport.Write(Title, Markdown, CancellationToken.None, attachment: attachment);
        Assert.Equal(file, WordDocumentExport.Write(Title, Markdown, CancellationToken.None, attachment: attachment));
        using var zip = new ZipArchive(new MemoryStream(file));
        using var image = zip.GetEntry("word/media/attachment.jpeg")!.Open();
        using var bytes = new MemoryStream();
        image.CopyTo(bytes);
        Assert.Equal(attachment.Bytes, bytes.ToArray());
        Assert.Contains(Read(zip, "[Content_Types].xml").Root!.Elements(), element =>
            (string?)element.Attribute("PartName") == "/word/media/attachment.jpeg" &&
            (string?)element.Attribute("ContentType") == "image/jpeg");

        XNamespace drawing = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
        var inline = Assert.Single(Read(zip, "word/document.xml").Descendants(drawing + "inline"));
        var extent = inline.Element(drawing + "extent")!;
        const int printableWidth = 9026 * 635;
        Assert.Equal(printableWidth, (int?)extent.Attribute("cx"));
        Assert.Equal(printableWidth / 2, (int?)extent.Attribute("cy"));
        Assert.Equal("A & B.jpeg", (string?)inline.Element(drawing + "docPr")?.Attribute("descr"));
        Assert.Throws<BusinessException>(() => WordDocumentExport.Write(Title, Markdown, CancellationToken.None,
            attachment: attachment with { Format = MediaFormat.Webp }));
    }

    internal static void AssertFile(byte[] bytes, params string[] text)
    {
        using var stream = new MemoryStream(bytes);
        using var zip = new ZipArchive(stream, ZipArchiveMode.Read);
        Assert.Equal(new[] { "[Content_Types].xml", "_rels/.rels", "word/_rels/document.xml.rels", "word/document.xml", "word/styles.xml" },
            zip.Entries.Select(entry => entry.FullName).Order(StringComparer.Ordinal));
        foreach (var rel in new[] { "_rels/.rels", "word/_rels/document.xml.rels" })
        {
            var relation = Assert.Single(Read(zip, rel).Root!.Elements());
            Assert.Null(relation.Attribute("TargetMode"));
            Assert.Contains(relation.Attribute("Target")!.Value, new[] { "word/document.xml", "styles.xml" });
        }
        var document = Read(zip, "word/document.xml");
        Assert.Empty(document.Descendants(Word + "hyperlink"));
        Assert.Empty(document.Descendants(Word + "drawing"));
        Assert.Empty(document.Descendants(Word + "fldSimple"));
        var actual = string.Join('\n', document.Descendants(Word + "t").Select(node => node.Value));
        foreach (var value in text) Assert.Contains(value, actual, StringComparison.Ordinal);
    }

    private static XDocument Read(ZipArchive zip, string name)
    {
        using var part = zip.GetEntry(name)!.Open();
        return XDocument.Load(part);
    }
}
