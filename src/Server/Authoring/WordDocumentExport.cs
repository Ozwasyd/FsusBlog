using System.Globalization;
using System.IO.Compression;
using System.Text;
using System.Xml;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using Markdig.Extensions.Tables;
using Markdig.Syntax;

namespace FsusBlog.V2.Server.Authoring;

internal static class WordDocumentExport
{
    internal const string ContentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    internal const int MaximumOutput = 2 * 1024 * 1024;
    private const string Word = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    private const int PageContentWidthTwips = 9026;
    private static readonly DateTimeOffset ArchiveEpoch = new(1980, 1, 1, 0, 0, 0, TimeSpan.Zero);
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private static readonly XmlWriterSettings Xml = new() { Encoding = Utf8, NewLineHandling = NewLineHandling.None, CloseOutput = true };

    internal static byte[] Write(string title, string body, CancellationToken ct, bool includeTables = true)
    {
        ct.ThrowIfCancellationRequested();
        if (Utf8.GetByteCount(title) > WireLimits.TitleBytes || Utf8.GetByteCount(body) > WireLimits.BodyBytes ||
            body.Count(c => c is '\n' or '\r' or '\t') > 16_384) throw Unsupported();
        title = XmlText(title);
        body = XmlText(body);
        using var data = new MemoryStream();
        using (var archive = new ZipArchive(data, ZipArchiveMode.Create, leaveOpen: true))
        {
            WritePart(archive, "[Content_Types].xml", Types);
            WritePart(archive, "_rels/.rels", RootRelations);
            WritePart(archive, "word/_rels/document.xml.rels", DocumentRelations);
            using (var styles = XmlWriter.Create(CreatePart(archive, "word/styles.xml"), Xml))
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

            using var output = XmlWriter.Create(CreatePart(archive, "word/document.xml"), Xml);
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

    private static Stream CreatePart(ZipArchive zip, string name)
    {
        var entry = zip.CreateEntry(name, CompressionLevel.Fastest);
        entry.LastWriteTime = ArchiveEpoch;
        return entry.Open();
    }

    private static void WritePart(ZipArchive zip, string name, string content)
    {
        using var stream = CreatePart(zip, name);
        stream.Write(Utf8.GetBytes(content));
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
