using System.Collections.Immutable;
using System.IO.Compression;
using System.Text;
using System.Xml.Linq;

using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Validation;

using FsusBlog.Server.Services.DocumentExport;

namespace FsusBlog.Server.Tests.Unit;

public sealed class DocumentExportDocxProviderTests
{
    private const string Pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
    private const string AssetId = "3f3b2e7a-1d2e-4f8a-9c5b-6a7b8c9d0e1f";
    private static readonly string s_fragment = $"""
        <h1 id="title">标题 中文 🌍</h1><p dir="rtl">שלום <strong>bold</strong> <em>italic</em> <code>inline</code></p><p><a href="#title">heading</a> <a href="https://example.com/reference?a=1&amp;b=2">reference</a></p><ol start="3"><li>third<ul><li>nested</li></ul></li><li>fourth</li></ol><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>C</td><td>D</td></tr></tbody></table><pre><code class="language-csharp">  var x = 1;
        &#9;Console.WriteLine(x);</code></pre><figure><img data-asset-id="{AssetId}" src="data:image/png;base64,{Pixel}" alt="red pixel" /><figcaption>caption</figcaption></figure><p><a href="#footnote-1">note label</a></p><aside id="footnote-1"><p>footnote text</p></aside><section data-embed="static"><p>embedded text</p></section><figure><svg xmlns="http://www.w3.org/2000/svg"><text>A to B</text></svg></figure><span class="katex">x²</span>
        """;

    [Fact]
    public void ProducesRealSchemaValidStructuredDeterministicOpenXml()
    {
        DocumentExportDocxProjection projection = Projection(s_fragment);
        byte[] first = DocumentExportDocxPackage.Render(projection);
        byte[] second = DocumentExportDocxPackage.Render(projection);
        Assert.Equal(first, second);
        string digest = DocumentExportDocxVerifier.Validate(first, projection);
        Assert.Equal(digest, DocumentExportDocxVerifier.Validate(second, projection));
        using var source = new MemoryStream(first);
        using WordprocessingDocument document = WordprocessingDocument.Open(source, false);
        Assert.Empty(new OpenXmlValidator().Validate(document));
        Dictionary<string, byte[]> parts = Parts(first);
        XNamespace w = DocumentExportDocxPackage.Word;
        XElement body = Xml(parts["word/document.xml"]);
        Assert.Contains(body.Descendants(w + "pStyle"), style => (string?)style.Attribute(w + "val") == "Heading1");
        Assert.Contains(body.Descendants(w + "numId"), number => (string?)number.Attribute(w + "val") == "1");
        Assert.Equal(2, body.Descendants(w + "tr").Count());
        Assert.Single(body.Descendants(w + "drawing"));
        Assert.Single(body.Descendants(w + "footnoteReference"));
        Assert.Contains("footnote text", Encoding.UTF8.GetString(parts["word/footnotes.xml"]), StringComparison.Ordinal);
        Assert.Equal(Convert.FromBase64String(Pixel), parts["word/media/image1.png"]);
        Assert.Contains("mermaid:preserve-canonical-diagram-text", projection.Warnings);
        Assert.Contains("katex-latex:preserve-canonical-math-text", projection.Warnings);
        Assert.Contains("fonts:registered-family-references-require-reader-fonts", projection.Warnings);
    }

    [Theory]
    [InlineData("word/vbaProject.bin")]
    [InlineData("word/embeddings/object.bin")]
    [InlineData("word/settings.xml")]
    [InlineData("../escape.xml")]
    public void RejectsUnregisteredMacroObjectAndTraversalParts(string path)
    {
        DocumentExportDocxProjection projection = Projection(s_fragment);
        Dictionary<string, byte[]> parts = Parts(DocumentExportDocxPackage.Render(projection));
        parts.Add(path, "payload"u8.ToArray());
        Assert.Throws<InvalidDataException>(() => DocumentExportDocxVerifier.Validate(Pack(parts), projection));
    }

    [Fact]
    public void RejectsActualSchemaInvalidWordprocessingEvenWhenXmlIsWellFormed()
    {
        DocumentExportDocxProjection projection = Projection(s_fragment);
        byte[] malformed = Mutate(projection, "word/document.xml", root =>
            root.Element(DocumentExportDocxPackage.Word + "body")!.AddFirst(
                new XElement(DocumentExportDocxPackage.Word + "r", new XElement(DocumentExportDocxPackage.Word + "t", "invalid"))));
        using var source = new MemoryStream(malformed);
        using WordprocessingDocument document = WordprocessingDocument.Open(source, false);
        Assert.NotEmpty(new OpenXmlValidator().Validate(document));
        Assert.Throws<InvalidDataException>(() => DocumentExportDocxVerifier.Validate(malformed, projection));
    }

    [Theory]
    [InlineData("attachedTemplate", "https://example.com/template.dotm")]
    [InlineData("image", "https://example.com/remote.png")]
    [InlineData("hyperlink", "javascript:alert(1)")]
    [InlineData("hyperlink", "https://user:secret@example.com/path")]
    [InlineData("hyperlink", "file:///etc/passwd")]
    public void RejectsRemoteRelationshipTypesAndUnsafeLinks(string type, string target)
    {
        DocumentExportDocxProjection projection = Projection(s_fragment);
        byte[] malformed = Mutate(projection, "word/_rels/document.xml.rels", root =>
        {
            XElement link = root.Elements().Last();
            link.SetAttributeValue("Type", DocumentExportDocxPackage.Relationship.NamespaceName + "/" + type);
            link.SetAttributeValue("Target", target);
            link.SetAttributeValue("TargetMode", "External");
        });
        Assert.Throws<InvalidDataException>(() => DocumentExportDocxVerifier.Validate(malformed, projection));
    }

    [Theory]
    [InlineData("text")]
    [InlineData("code-whitespace")]
    [InlineData("heading")]
    [InlineData("link-target")]
    [InlineData("dangling-image")]
    [InlineData("macro-field")]
    [InlineData("bookmark")]
    [InlineData("footnote")]
    [InlineData("text-whitespace")]
    [InlineData("list-numbering")]
    [InlineData("list-start")]
    [InlineData("font")]
    [InlineData("margin")]
    [InlineData("image-alt")]
    public void RejectsResealedSemanticAndActiveContentMutations(string mutation)
    {
        DocumentExportDocxProjection projection = Projection(s_fragment);
        XNamespace w = DocumentExportDocxPackage.Word;
        XNamespace r = DocumentExportDocxPackage.Relationship;
        string part = mutation switch
        {
            "link-target" => "word/_rels/document.xml.rels",
            "list-start" => "word/numbering.xml",
            "font" => "word/styles.xml",
            _ => "word/document.xml"
        };
        byte[] malformed = Mutate(projection, part, root =>
        {
            switch (mutation)
            {
                case "text":
                    root.Descendants(w + "t").First().Value = "changed";
                    break;
                case "code-whitespace":
                    root.Descendants(w + "p").Single(paragraph => (string?)paragraph.Element(w + "pPr")?.Element(w + "pStyle")?.Attribute(w + "val") == "Code")
                        .Descendants(w + "t").First().Value = "var x = 1;";
                    break;
                case "heading":
                    root.Descendants(w + "pStyle").First().SetAttributeValue(w + "val", "Normal");
                    break;
                case "link-target":
                    root.Elements().Last().SetAttributeValue("Target", "https://example.com/changed");
                    break;
                case "dangling-image":
                    root.Descendants(DocumentExportDocxPackage.Drawing + "blip").Single().SetAttributeValue(r + "embed", "rId999");
                    break;
                case "macro-field":
                    root.Descendants(w + "r").First().Add(new XElement(w + "instrText", "INCLUDEPICTURE https://example.com/remote"));
                    break;
                case "bookmark":
                    root.Descendants(w + "bookmarkEnd").First().Remove();
                    break;
                case "footnote":
                    root.Descendants(w + "footnoteReference").Single().SetAttributeValue(w + "id", "20");
                    break;
                case "text-whitespace":
                    root.Descendants(w + "t").First().Value = "标题中文🌍";
                    break;
                case "list-numbering":
                    root.Descendants(w + "numPr").Remove();
                    break;
                case "list-start":
                    root.Descendants(w + "start").First().SetAttributeValue(w + "val", "99");
                    break;
                case "font":
                    root.Descendants(w + "rFonts").First().SetAttributeValue(w + "ascii", "Arial");
                    break;
                case "margin":
                    root.Descendants(w + "pgMar").Single().SetAttributeValue(w + "left", "4000");
                    break;
                case "image-alt":
                    root.Descendants(DocumentExportDocxPackage.WordDrawing + "docPr").Single().SetAttributeValue("descr", "changed");
                    break;
                default:
                    throw new ArgumentException("Unknown mutation.", nameof(mutation));
            }
        });
        Assert.NotEqual(DocumentExportDigest.ComputeBytes(DocumentExportDocxPackage.Render(projection)), DocumentExportDigest.ComputeBytes(malformed));
        Assert.Throws<InvalidDataException>(() => DocumentExportDocxVerifier.Validate(malformed, projection));
    }

    [Fact]
    public void RejectsMediaBytesContentTypesMetadataAndDuplicateZipEntries()
    {
        DocumentExportDocxProjection projection = Projection(s_fragment);
        Dictionary<string, byte[]> parts = Parts(DocumentExportDocxPackage.Render(projection));
        parts["word/media/image1.png"][20] ^= 1;
        Assert.Throws<InvalidDataException>(() => DocumentExportDocxVerifier.Validate(Pack(parts), projection));
        byte[] contentType = Mutate(projection, "[Content_Types].xml", root =>
            root.Elements().First(element => (string?)element.Attribute("Extension") == "png").SetAttributeValue("ContentType", "application/octet-stream"));
        Assert.Throws<InvalidDataException>(() => DocumentExportDocxVerifier.Validate(contentType, projection));
        byte[] metadata = Mutate(projection, "docProps/core.xml", root => root.Elements().Last().Value = "2026-10-08T00:00:00Z");
        Assert.Throws<InvalidDataException>(() => DocumentExportDocxVerifier.Validate(metadata, projection));
        parts = Parts(DocumentExportDocxPackage.Render(projection));
        Assert.Throws<InvalidDataException>(() => DocumentExportDocxVerifier.Validate(Pack(parts, duplicate: true), projection));
        byte[] trailing = DocumentExportDocxPackage.Render(projection).Concat("trailing"u8.ToArray()).ToArray();
        Assert.Throws<InvalidDataException>(() => DocumentExportDocxVerifier.Validate(trailing, projection));
    }

    [Theory]
    [InlineData("<ol reversed=\"reversed\"><li>x</li></ol>")]
    [InlineData("<table><tr><td colspan=\"2\">x</td></tr></table>")]
    [InlineData("<script>alert(1)</script>")]
    [InlineData("<a href=\"javascript:alert(1)\">x</a>")]
    [InlineData("<svg xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M0 0L1 1\" /></svg>")]
    public void RefusesUnsupportedAndUnsafeCanonicalContentWithoutDroppingIt(string fragment)
    {
        Assert.Throws<InvalidDataException>(() => Projection(fragment, image: false));
    }

    [Fact]
    public void RefusesTruncatedMediaCorruptEmptyOverBudgetAndCancellation()
    {
        DocumentExportDocxProjection projection = Projection(s_fragment);
        Assert.Throws<InvalidDataException>(() => DocumentExportDocxPackage.VerifyImage([137, 80, 78, 71, 13, 10, 26, 10], "image/png"));
        Assert.Throws<InvalidDataException>(() => DocumentExportDocxVerifier.Validate([], projection));
        Assert.Throws<InvalidDataException>(() => DocumentExportDocxVerifier.Validate("corrupt"u8.ToArray(), projection));
        Assert.Throws<InvalidDataException>(() => Projection("<p>" + new string('x', 1000001) + "</p>", image: false));
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        Assert.Throws<OperationCanceledException>(() => DocumentExportDocxPackage.Render(projection, cancellation.Token));
        Assert.Throws<OperationCanceledException>(() => DocumentExportDocxVerifier.Validate(DocumentExportDocxPackage.Render(projection), projection, cancellation.Token));
        Assert.Throws<InvalidDataException>(() => DocumentExportDocxPackage.Render(projection with { Fragment = "changed" }));
    }

    [Fact]
    public void PreservesLongCjkRtlEmojiAndCodeText()
    {
        string text = string.Concat(Enumerable.Repeat("中文 שלום 🌍", 5000));
        DocumentExportDocxProjection projection = Projection("<h2>long</h2><p dir=\"rtl\">" + text + "</p>", image: false);
        byte[] output = DocumentExportDocxPackage.Render(projection);
        DocumentExportDocxVerifier.Validate(output, projection);
        Assert.Contains(text, Encoding.UTF8.GetString(Parts(output)["word/document.xml"]), StringComparison.Ordinal);
    }

    [Fact]
    public void PreservesInheritedInlineDirectionAndEmptyOrMultiParagraphListItems()
    {
        DocumentExportDocxProjection projection = Projection(
            "<div dir=\"rtl\"><p>שלום <span dir=\"ltr\">left</span></p></div><ul><li></li><li><p>first</p><p>continuation</p></li><li><ul><li>child</li></ul></li></ul><p><a id=\"link-id\" href=\"https://example.com\" dir=\"rtl\">label</a><a href=\"#link-id\">local</a></p>", image: false);
        byte[] bytes = DocumentExportDocxPackage.Render(projection);
        DocumentExportDocxVerifier.Validate(bytes, projection);
        XElement document = Xml(Parts(bytes)["word/document.xml"]);
        XNamespace w = DocumentExportDocxPackage.Word;
        Assert.Single(document.Descendants(w + "bidi"));
        Assert.Contains(document.Descendants(w + "rtl"), direction => (string?)direction.Attribute(w + "val") == "0");
        Assert.Equal(4, document.Descendants(w + "numPr").Count());
    }

    [Fact]
    public void RefusesFakeJpegAndCrcValidInvalidPngScanlines()
    {
        Assert.Throws<InvalidDataException>(() => DocumentExportDocxPackage.VerifyImage(
            [255, 216, 255, 192, 0, 8, 8, 0, 1, 0, 1, 1, 255, 217], "image/jpeg"));
        byte[] png = Convert.FromBase64String(Pixel);
        // Alter IDAT while recomputing CRC, proving refusal is not only a byte digest/CRC check.
        png[42] ^= 0xff;
        uint crc = uint.MaxValue;
        foreach (byte value in png.AsSpan(37, 17))
        {
            crc ^= value;
            for (int bit = 0; bit < 8; bit++)
            {
                crc = (crc >> 1) ^ ((crc & 1) != 0 ? 0xedb88320U : 0);
            }
        }
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(png.AsSpan(54, 4), ~crc);
        Assert.Throws<InvalidDataException>(() => DocumentExportDocxPackage.VerifyImage(png, "image/png"));
    }

    [Fact]
    public async Task InactiveCatalogRefusesBeforeRendererAndJobExecution()
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        DocumentExportProviderContract contract = DocumentExportContractCatalog.RequireProvider("docx");
        DocumentExportTask task = DocumentExportContractValidator.Seal(DocumentExportContractTests.ValidTask(input) with
        {
            FormatId = contract.FormatId,
            ProviderId = contract.ProviderId,
            ProviderVersion = contract.ProviderVersion,
            ContentDigest = string.Empty
        });
        var provider = new DocxDocumentExportProvider(new UnavailableRenderer(), DocumentExportDigest.ComputeBytes("host"u8));
        Assert.Equal(contract.ProviderId, provider.ProviderId);
        Assert.IsAssignableFrom<FsusBlog.Server.Services.DocumentExport.Jobs.IDocumentExportJobProvider>(provider);
        await Assert.ThrowsAsync<InvalidOperationException>(() => provider.ExportAsync(task, input));
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAsync<OperationCanceledException>(() => provider.ExportAsync(task, input, cancellation.Token));
        await Assert.ThrowsAsync<OperationCanceledException>(() => provider.VerifyAsync(null!, task, input, cancellation.Token));
    }

    [Theory]
    [InlineData("plan")]
    [InlineData("receipt")]
    [InlineData("failure-receipt")]
    public void CanonicalRendererStageRefusesInactiveDocxBeforeInspectingExecutionClaims(string stage)
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        DocumentExportProviderContract provider = DocumentExportContractCatalog.RequireProvider("docx");
        DocumentExportTask task = DocumentExportContractValidator.Seal(DocumentExportContractTests.ValidTask(input) with
        {
            FormatId = provider.FormatId,
            ProviderId = provider.ProviderId,
            ProviderVersion = provider.ProviderVersion,
            ContentDigest = string.Empty
        });
        void Validate()
        {
            // No synthetic execution receipt or tool authority is supplied:
            // inactive admission must reject before examining those claims.
            switch (stage)
            {
                case "plan":
                    DocumentExportSandboxRuntime.ValidateCanonicalRendererPlan(null!, task, input, null!, string.Empty);
                    break;
                case "receipt":
                    DocumentExportSandboxRuntime.ValidateCanonicalRendererReceipt(null!, null!, task, input, null!, string.Empty, []);
                    break;
                case "failure-receipt":
                    DocumentExportSandboxRuntime.ValidateCanonicalRendererFailureReceipt(null!, null!, task, input, null!, string.Empty,
                        "failed", "execution-failed");
                    break;
                default:
                    throw new ArgumentException("Unknown stage.", nameof(stage));
            }
        }
        Assert.Throws<InvalidOperationException>(Validate);
        DocumentExportTask mismatchedTask = task with
        {
            InputDigest = DocumentExportDigest.ComputeBytes("other-input"u8)
        };
        Assert.Throws<InvalidDataException>(() => DocumentExportSandboxRuntime.ValidateCanonicalRendererPlan(
            null!, mismatchedTask, input, null!, string.Empty));
    }

    private sealed class UnavailableRenderer : ICanonicalDocumentRendererAdapter
    {
        public DocumentExportToolContract Tool => throw new InvalidOperationException("Inactive provider cannot request a tool.");

        public Task<CanonicalDocumentRendererResult> RenderAsync(DocumentExportTask task, DocumentExportFrozenInput input,
            CancellationToken cancellationToken = default)
            => throw new InvalidOperationException("Inactive provider cannot invoke the renderer.");
    }

    internal static DocumentExportDocxProjection Projection(string fragment, bool image = true)
    {
        DocumentExportFrozenInput baseline = DocumentExportContractTests.ValidInput();
        DocumentExportAsset[] assets = baseline.Assets.Where(asset => asset.Role != "image").ToArray();
        if (image)
        {
            byte[] bytes = Convert.FromBase64String(Pixel);
            assets = [new DocumentExportAsset(AssetId, "image/png", DocumentExportDigest.ComputeBytes(bytes), bytes.ToImmutableArray(),
                "red pixel", "image", string.Empty, 0, "normal"), .. assets];
        }
        DocumentExportFrozenInput input = DocumentExportContractValidator.Seal(baseline with
        {
            Assets = assets.ToImmutableArray(),
            AssetManifestDigest = DocumentExportContractValidator.ComputeAssetManifestDigest(assets),
            FontManifestDigest = DocumentExportContractValidator.ComputeFontManifestDigest(assets),
            ContentDigest = string.Empty
        });
        var response = new DocumentExportRendererResponse(DocumentExportContractCatalog.RendererResponseSchema,
            input.InputId, input.ContentDigest, input.SourceDigest, input.AssetManifestDigest, input.FontManifestDigest,
            input.ReadingStyleAuthorityDigest, input.RendererId, input.RendererVersion, input.RendererDigest,
            "DOCX 测试", fragment, DocumentExportContractCatalog.FeatureIds.ToImmutableArray(), string.Empty);
        return DocumentExportDocxProjection.Create(SelfContainedHtmlDocumentExportProvider.SealRendererResponse(response), input, default);
    }

    private static byte[] Mutate(DocumentExportDocxProjection projection, string part, Action<XElement> mutation)
    {
        Dictionary<string, byte[]> parts = Parts(DocumentExportDocxPackage.Render(projection));
        XElement root = Xml(parts[part]);
        mutation(root);
        parts[part] = Encoding.UTF8.GetBytes(root.ToString(SaveOptions.DisableFormatting));
        return Pack(parts);
    }

    private static Dictionary<string, byte[]> Parts(byte[] bytes)
    {
        using var source = new MemoryStream(bytes);
        using var zip = new ZipArchive(source, ZipArchiveMode.Read);
        return zip.Entries.ToDictionary(entry => entry.FullName, entry =>
        {
            using Stream content = entry.Open();
            using var destination = new MemoryStream();
            content.CopyTo(destination);
            return destination.ToArray();
        }, StringComparer.Ordinal);
    }

    private static XElement Xml(byte[] bytes) => XElement.Parse(Encoding.UTF8.GetString(bytes));

    private static byte[] Pack(IReadOnlyDictionary<string, byte[]> parts, bool duplicate = false)
    {
        using var destination = new MemoryStream();
        using (var zip = new ZipArchive(destination, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach ((string path, byte[] bytes) in parts.OrderBy(part => part.Key, StringComparer.Ordinal))
            {
                ZipArchiveEntry entry = zip.CreateEntry(path, CompressionLevel.NoCompression);
                entry.LastWriteTime = DocumentExportDocxPackage.ZipTimestamp;
                entry.ExternalAttributes = 0;
                using Stream content = entry.Open();
                content.Write(bytes);
            }
            if (duplicate)
            {
                ZipArchiveEntry entry = zip.CreateEntry("word/document.xml", CompressionLevel.NoCompression);
                entry.LastWriteTime = DocumentExportDocxPackage.ZipTimestamp;
                using Stream content = entry.Open();
                content.Write(parts["word/document.xml"]);
            }
        }
        return destination.ToArray();
    }
}
