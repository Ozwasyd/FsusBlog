using System.IO.Compression;
using System.Text;
using System.Xml.Linq;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Authoring;

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
