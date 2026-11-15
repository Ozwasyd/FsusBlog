using System.Globalization;
using System.IO.Compression;
using System.Security;
using System.Text;
using System.Xml;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Content;
using Markdig.Extensions.Tables;
using Markdig.Syntax;

namespace FsusBlog.V2.Server.Authoring;

internal static class WordDocumentExport
{
    internal const string ContentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    internal const int MaximumOutput = 2 * 1024 * 1024;
    private const string Word = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    private const int PageContentWidthTwips = 9026;
    private const int PageContentHeightTwips = 13958;
    private const string DocumentRelationship = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private static readonly XmlWriterSettings Xml = new() { Encoding = Utf8, NewLineHandling = NewLineHandling.None, CloseOutput = true };

    internal static byte[] Write(string title, string body, CancellationToken ct, bool includeTables = true,
        DocumentExportAttachment? attachment = null) =>
        WriteWithImages(title, body, attachment is null ? [] : [attachment], ct, includeTables);

    internal static byte[] WriteWithImages(string title, string body, DocumentExportAttachment[] images,
        CancellationToken ct, bool includeTables)
    {
        ct.ThrowIfCancellationRequested();
        if (Utf8.GetByteCount(title) > WireLimits.TitleBytes || Utf8.GetByteCount(body) > WireLimits.BodyBytes ||
            body.Count(c => c is '\n' or '\r' or '\t') > 16_384) throw Unsupported();
        title = XmlText(title);
        body = XmlText(body);
        if (images.Any(image => image.Format is not (MediaFormat.Png or MediaFormat.Jpeg)))
            throw new BusinessException(Rejection.Invalid, "Word can embed PNG and JPEG images.");
        var paths = images.Select((image, index) => "media/" + image.PackageName(index + 1, images.Length > 1)).ToArray();
        var types = Types;
        var documentRelations = DocumentRelations;
        for (var index = 0; index < images.Length; index++)
        {
            types = types.Replace("</Types>", $"  <Override PartName=\"/word/{paths[index]}\" ContentType=\"{images[index].ContentType}\"/>\n</Types>");
            documentRelations = documentRelations.Replace("</Relationships>",
                $"  <Relationship Id=\"{ImageId(index)}\" Type=\"{DocumentRelationship}/image\" Target=\"{paths[index]}\"/>\n</Relationships>");
        }
        using var data = new MemoryStream();
        using (var archive = new ZipArchive(data, ZipArchiveMode.Create, leaveOpen: true))
        {
            DocumentArchive.Write(archive, "[Content_Types].xml", Utf8.GetBytes(types));
            DocumentArchive.Write(archive, "_rels/.rels", Utf8.GetBytes(RootRelations));
            DocumentArchive.Write(archive, "word/_rels/document.xml.rels", Utf8.GetBytes(documentRelations));
            for (var index = 0; index < images.Length; index++)
                DocumentArchive.Write(archive, $"word/{paths[index]}", images[index].Bytes);
            using (var styles = XmlWriter.Create(DocumentArchive.Open(archive, "word/styles.xml"), Xml))
            {
                styles.WriteStartElement("w", "styles", Word);
                Style(styles, "Normal", "Normal", 22, 120);
                Style(styles, "Title", "Title", 42, 360, heading: true);
                Style(styles, "Heading1", "Heading 1", 32, 160, heading: true, level: 0);
                Style(styles, "Heading2", "Heading 2", 28, 120, heading: true, level: 1);
                Style(styles, "Heading3", "Heading 3", 24, 100, heading: true, level: 2);
                Style(styles, "SourceCode", "Source Code", 20, 0, code: true);
                styles.WriteEndElement();
            }

            using var output = XmlWriter.Create(DocumentArchive.Open(archive, "word/document.xml"), Xml);
            output.WriteStartElement("w", "document", Word);
            output.WriteStartElement("w", "body", Word);
            Paragraph(output, "Title", title, ct);
            var markdown = HtmlDocumentExport.ParseMarkdown(body, "Word", ct, includeTables);
            var next = 0;
            foreach (var block in markdown)
            {
                ct.ThrowIfCancellationRequested();
                switch (block)
                {
                    case HeadingBlock heading:
                        var label = HeadingLabel(heading);
                        Paragraph(output, heading.Level switch { 1 => "Heading1", 2 => "Heading2", _ => "Heading3" }, label ?? Raw(), ct);
                        break;
                    case CodeBlock code:
                        Paragraph(output, "SourceCode", code.Lines.ToString(), ct);
                        break;
                    case Table table:
                        WriteTable(output, table, body, ct);
                        break;
                    default:
                        Paragraph(output, "Normal", Raw(), ct);
                        break;
                }
                string Raw()
                {
                    var start = Math.Clamp(block.Span.Start, next, body.Length);
                    var stop = Math.Clamp(block.Span.End + 1, start, body.Length);
                    return body[start..stop];
                }
                next = Math.Max(next, block.Span.End + 1);
            }
            for (var index = 0; index < images.Length; index++)
                WriteImage(output, images[index], index, ImageId(index));
            output.WriteStartElement("w", "sectPr", Word);
            Empty(output, "pgSz", ("w", "11906"), ("h", "16838"));
            Empty(output, "pgMar", ("top", "1440"), ("right", "1440"), ("bottom", "1440"), ("left", "1440"), ("header", "720"), ("footer", "720"), ("gutter", "0"));
            output.WriteEndElement();
            output.WriteEndElement();
            output.WriteEndElement();
        }
        ct.ThrowIfCancellationRequested();
        if (data.Length > MaximumOutput) throw Unsupported();
        return data.ToArray();

        string ImageId(int index) => images.Length == 1 ? "Image" : string.Create(CultureInfo.InvariantCulture, $"Image{index + 1}");
    }

    private static void WriteImage(XmlWriter xml, DocumentExportAttachment image, int index, string relationship)
    {
        // Open XML dimensions are EMUs. Use CSS pixel size unless it exceeds the printable area.
        const int emusPerTwip = 635;
        const int emusPerPixel = 9525;
        int originalWidth = checked(image.Width * emusPerPixel);
        int originalHeight = checked(image.Height * emusPerPixel);
        double scale = Math.Min(1d, Math.Min((double)(PageContentWidthTwips * emusPerTwip) / originalWidth,
            (double)(PageContentHeightTwips * emusPerTwip) / originalHeight));
        int width = Math.Max(1, (int)(originalWidth * scale));
        int height = Math.Max(1, (int)(originalHeight * scale));
        var description = SecurityElement.Escape(XmlText(image.Name));
        xml.WriteRaw(string.Create(CultureInfo.InvariantCulture, $"""
            <w:p><w:r><w:drawing>
              <wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
                         xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
                         xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"
                         xmlns:r="{DocumentRelationship}">
                <wp:extent cx="{width}" cy="{height}"/>
                <wp:docPr id="{index + 1}" name="Attachment" descr="{description}"/>
                <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
                  <pic:pic>
                    <pic:nvPicPr><pic:cNvPr id="{index}" name="Attachment"/><pic:cNvPicPr/></pic:nvPicPr>
                    <pic:blipFill><a:blip r:embed="{relationship}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
                    <pic:spPr>
                      <a:xfrm><a:off x="0" y="0"/><a:ext cx="{width}" cy="{height}"/></a:xfrm>
                      <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
                    </pic:spPr>
                  </pic:pic>
                </a:graphicData></a:graphic>
              </wp:inline>
            </w:drawing></w:r></w:p>
            """));
    }

    private static void WriteTable(XmlWriter xml, Table table, string markdown, CancellationToken ct)
    {
        var columns = table.Cast<TableRow>().Max(row => row.Count);
        xml.WriteStartElement("w", "tbl", Word);
        xml.WriteStartElement("w", "tblPr", Word);
        Empty(xml, "tblW", ("w", "5000"), ("type", "pct"));
        xml.WriteEndElement();
        xml.WriteStartElement("w", "tblGrid", Word);
        var columnWidth = Math.Max(1, PageContentWidthTwips / columns).ToString(CultureInfo.InvariantCulture);
        for (var i = 0; i < columns; i++) Empty(xml, "gridCol", ("w", columnWidth));
        xml.WriteEndElement();
        foreach (var row in table.Cast<TableRow>())
        {
            ct.ThrowIfCancellationRequested();
            xml.WriteStartElement("w", "tr", Word);
            if (row.IsHeader)
            {
                xml.WriteStartElement("w", "trPr", Word);
                Empty(xml, "tblHeader");
                xml.WriteEndElement();
            }
            for (var i = 0; i < row.Count; i++)
            {
                var cell = (TableCell)row[i];
                xml.WriteStartElement("w", "tc", Word);
                var alignment = i < table.ColumnDefinitions.Count ? table.ColumnDefinitions[i].Alignment switch
                {
                    TableColumnAlign.Left => "left",
                    TableColumnAlign.Center => "center",
                    TableColumnAlign.Right => "right",
                    _ => null
                } : null;
                var text = cell.Span.Length == 0 ? "" : markdown.AsSpan(cell.Span.Start, cell.Span.Length).Trim().ToString();
                Paragraph(xml, "Normal", text, ct, alignment);
                xml.WriteEndElement();
            }
            xml.WriteEndElement();
        }
        xml.WriteEndElement();
    }

    private static void Paragraph(XmlWriter xml, string style, string text, CancellationToken ct, string? alignment = null)
    {
        xml.WriteStartElement("w", "p", Word);
        xml.WriteStartElement("w", "pPr", Word);
        Empty(xml, "pStyle", ("val", style));
        if (alignment is not null) Empty(xml, "jc", ("val", alignment));
        xml.WriteEndElement();
        xml.WriteStartElement("w", "r", Word);
        var remaining = text.AsSpan();
        while (!remaining.IsEmpty)
        {
            ct.ThrowIfCancellationRequested();
            var next = remaining.IndexOfAny('\t', '\r', '\n');
            var run = next < 0 ? remaining : remaining[..next];
            if (!run.IsEmpty)
            {
                xml.WriteStartElement("w", "t", Word);
                xml.WriteAttributeString("xml", "space", null, "preserve");
                xml.WriteString(run.ToString());
                xml.WriteEndElement();
            }
            if (next < 0) break;
            Empty(xml, remaining[next] == '\t' ? "tab" : "br");
            remaining = remaining[(next + (remaining[next..].StartsWith("\r\n", StringComparison.Ordinal) ? 2 : 1))..];
        }
        xml.WriteEndElement();
        xml.WriteEndElement();
    }

    private static void Style(XmlWriter xml, string id, string label, int size, int after, bool heading = false, bool code = false, int level = -1)
    {
        xml.WriteStartElement("w", "style", Word);
        xml.WriteAttributeString("w", "type", Word, "paragraph");
        xml.WriteAttributeString("w", "styleId", Word, id);
        if (id == "Normal") xml.WriteAttributeString("w", "default", Word, "1");
        Empty(xml, "name", ("val", label));
        if (id != "Normal") Empty(xml, "basedOn", ("val", "Normal"));
        xml.WriteStartElement("w", "pPr", Word);
        if (heading) Empty(xml, "keepNext");
        Empty(xml, "spacing", ("after", after.ToString(System.Globalization.CultureInfo.InvariantCulture)));
        if (level >= 0) Empty(xml, "outlineLvl", ("val", level.ToString(System.Globalization.CultureInfo.InvariantCulture)));
        xml.WriteEndElement();
        xml.WriteStartElement("w", "rPr", Word);
        if (id == "Normal") Empty(xml, "rFonts", ("eastAsia", "Hiragino Sans GB"));
        if (code) Empty(xml, "rFonts", ("ascii", "Courier New"), ("hAnsi", "Courier New"));
        if (heading) Empty(xml, "b");
        Empty(xml, "sz", ("val", size.ToString(System.Globalization.CultureInfo.InvariantCulture)));
        xml.WriteEndElement();
        xml.WriteEndElement();
    }

    private static void Empty(XmlWriter xml, string name, params (string Name, string Value)[] attributes)
    {
        xml.WriteStartElement("w", name, Word);
        foreach (var (key, value) in attributes) xml.WriteAttributeString("w", key, Word, value);
        xml.WriteEndElement();
    }

    private static string? HeadingLabel(HeadingBlock heading)
    {
        var label = new StringBuilder();
        for (var inline = heading.Inline?.FirstChild; inline is not null; inline = inline.NextSibling)
        {
            if (inline is not Markdig.Syntax.Inlines.LiteralInline literal) return null;
            label.Append(literal.Content.AsSpan());
        }
        return label.Length > 0 ? label.ToString() : null;
    }

    private static string XmlText(string text)
    {
        try { return XmlConvert.VerifyXmlChars(text); }
        catch (XmlException) { throw Unsupported(); }
    }

    private static BusinessException Unsupported() => new(Rejection.Invalid, "This revision exceeds the supported Word export limits.");

    private const string Types = """
        <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
          <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
          <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
          <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
        </Types>
        """;
    private const string RootRelations = """
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
        </Relationships>
        """;
    private const string DocumentRelations = """
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
        </Relationships>
        """;
}
