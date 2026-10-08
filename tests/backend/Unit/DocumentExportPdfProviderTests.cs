using System.Collections.Immutable;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Services.DocumentExport;

namespace FsusBlog.Server.Tests.Unit;

public sealed class DocumentExportPdfProviderTests
{
    [Fact]
    public void PrintDocument_PreservesCanonicalTextLinksFontsAndPrintBreaks()
    {
        DocumentExportFrozenInput input = WithoutImages();
        DocumentExportRendererResponse response = Response(input,
            "<h1 id=\"heading\">Reading 中文</h1><p>Hello <strong>world</strong>!</p>"
            + "<p class=\"page-break-before\">Next page</p><a href=\"https://example.com/reference?a=1&amp;b=2\">Reference</a>"
            + "<p><a href=\"#heading\">Back</a></p><pre><code>print(&quot;safe&quot;)</code></pre>");

        PdfPrintRenderRequest request = PdfPrintDocumentLayout.Compose(response, input, 1024 * 1024);

        Assert.Equal(input.ContentDigest, request.InputDigest);
        Assert.Equal("a4-reading-v1", request.PrintProfile);
        Assert.Null(request.PdfBase64);
        Assert.Equal("Reading 中文 Hello world! Next page Reference Back print(\"safe\")", request.ExpectedText);
        Assert.Equal(["https://example.com/reference?a=1&b=2"], request.ExpectedLinks);
        Assert.Contains("@page{size:A4;margin:20mm 18mm 20mm", request.HtmlDocument, StringComparison.Ordinal);
        Assert.Contains("counter(page)", request.HtmlDocument, StringComparison.Ordinal);
        Assert.Contains(".page-break-before{break-before:page}", request.HtmlDocument, StringComparison.Ordinal);
        Assert.Contains("thead{display:table-header-group}", request.HtmlDocument, StringComparison.Ordinal);
        Assert.Contains("orphans:3;widows:3", request.HtmlDocument, StringComparison.Ordinal);
        Assert.DoesNotContain("color-scheme:", request.HtmlDocument, StringComparison.Ordinal);
        Assert.DoesNotContain("@media(max-width:", request.HtmlDocument, StringComparison.Ordinal);
        Assert.Contains("print(\"safe\")", request.ExpectedText, StringComparison.Ordinal);
        Assert.Equal(DocumentExportReadingStyleAuthority.RequiredFonts.Count, request.FontAssets.Length);
        foreach (PdfPrintFontAsset font in request.FontAssets)
        {
            DocumentExportAsset frozen = Assert.Single(input.Assets,
                asset => asset.FontFamily == font.Family && asset.FontWeight == font.Weight && asset.FontStyle == font.Style);
            Assert.True(frozen.Bytes.AsSpan().SequenceEqual(Convert.FromBase64String(font.Bytes)));
            Assert.Equal(frozen.Sha256, font.Sha256);
            Assert.Contains(font.Bytes, request.HtmlDocument, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void PrintDocument_RetainsRtlAndEscapesTitleWithoutInjectingMarkup()
    {
        DocumentExportFrozenInput input = DocumentExportContractValidator.Seal(WithoutImages() with
        {
            Locale = "he-IL"
        });
        DocumentExportRendererResponse response = SelfContainedHtmlDocumentExportProvider.SealRendererResponse(
            Response(input, "<p dir=\"rtl\">שלום</p>") with
            {
                Title = "<script>title</script>"
            });

        PdfPrintRenderRequest request = PdfPrintDocumentLayout.Compose(response, input, 1024 * 1024);

        Assert.Contains("lang=\"he-IL\" dir=\"rtl\"", request.HtmlDocument, StringComparison.Ordinal);
        Assert.Contains("<title>&lt;script&gt;title&lt;/script&gt;</title>", request.HtmlDocument, StringComparison.Ordinal);
        Assert.DoesNotContain("<script>", request.HtmlDocument, StringComparison.Ordinal);
        Assert.Equal("שלום", request.ExpectedText);
    }

    [Theory]
    [InlineData("fa-IR")]
    [InlineData("ur-PK")]
    public void PrintDocument_UsesCultureDirectionForPersianAndUrdu(string locale)
    {
        DocumentExportFrozenInput input = DocumentExportContractValidator.Seal(WithoutImages() with
        {
            Locale = locale
        });
        PdfPrintRenderRequest request = PdfPrintDocumentLayout.Compose(Response(input, "<p>Text</p>"), input, 1024 * 1024);

        Assert.Contains($"lang=\"{locale}\" dir=\"rtl\"", request.HtmlDocument, StringComparison.Ordinal);
        Assert.Contains("pre{direction:ltr;text-align:left;", request.HtmlDocument, StringComparison.Ordinal);
    }

    [Fact]
    public void PrintDocument_UsesOnlyVisibleSvgTextAsExpectedPdfText()
    {
        DocumentExportFrozenInput input = WithoutImages();
        DocumentExportRendererResponse response = Response(input,
            "<svg xmlns=\"http://www.w3.org/2000/svg\" role=\"img\" aria-label=\"diagram\">"
            + "<title>Accessible title</title><desc>Hidden description</desc><text x=\"0\" y=\"15\">A to B</text></svg>");

        PdfPrintRenderRequest request = PdfPrintDocumentLayout.Compose(response, input, 1024 * 1024);

        Assert.Equal("A to B", request.ExpectedText);
        Assert.Contains("Accessible title", request.HtmlDocument, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("<script>unsafe()</script>")]
    [InlineData("<p style=\"break-before:page\">unsafe</p>")]
    [InlineData("<img src=\"https://example.com/image.png\" alt=\"remote\" />")]
    public void PrintDocument_RejectsCanonicalContentOutsideSharedSanitizer(string fragment)
    {
        DocumentExportFrozenInput input = WithoutImages();
        Assert.Throws<InvalidDataException>(() => PdfPrintDocumentLayout.Compose(Response(input, fragment), input, 1024 * 1024));
    }

    [Fact]
    public void PrintDocument_RejectsResealedRendererDriftAndOutputBudgetOverflow()
    {
        DocumentExportFrozenInput input = WithoutImages();
        DocumentExportRendererResponse response = Response(input, "<p>Text</p>");
        DocumentExportRendererResponse drifted = SelfContainedHtmlDocumentExportProvider.SealRendererResponse(
            response with
            {
                RendererDigest = DocumentExportDigest.ComputeBytes("other"u8)
            });
        Assert.Throws<InvalidDataException>(() => PdfPrintDocumentLayout.Compose(drifted, input, 1024 * 1024));
        Assert.Throws<DocumentExportBudgetExceededException>(() => PdfPrintDocumentLayout.Compose(response, input, 100));
    }

    [Fact]
    public void PrintRequest_UsesTheSharedStrictCamelCaseWireAndBase64FontBytes()
    {
        DocumentExportFrozenInput input = WithoutImages();
        PdfPrintRenderRequest request = PdfPrintDocumentLayout.Compose(Response(input, "<p>Text</p>"), input, 1024 * 1024);
        using JsonDocument wire = JsonDocument.Parse(DocumentExportDigest.Serialize(request));
        JsonElement root = wire.RootElement;

        Assert.Equal(["htmlDocument", "fontAssets", "expectedText", "expectedLinks", "inputDigest", "printProfile", "pdfBase64"],
            root.EnumerateObject().Select(property => property.Name));
        Assert.Equal(JsonValueKind.Null, root.GetProperty("pdfBase64").ValueKind);
        Assert.Equal(JsonValueKind.String, root.GetProperty("fontAssets")[0].GetProperty("bytes").ValueKind);
        Assert.Equal(request, DocumentExportDigest.Deserialize<PdfPrintRenderRequest>(DocumentExportDigest.Serialize(request))
            with
        {
            FontAssets = request.FontAssets,
            ExpectedLinks = request.ExpectedLinks
        });
    }

    [Theory]
    [InlineData(0, 1, "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    [InlineData(1, 0, "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    [InlineData(1, 1, "invalid")]
    [InlineData(1, 1, "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")]
    public void PdfResponse_RejectsIncompleteOrUnboundVerificationReport(int pages, int fonts, string digest)
    {
        var response = new PdfPrintRenderResponse(Convert.ToBase64String("%PDF-1.7\n"u8), digest, pages, fonts, []);
        Assert.Throws<InvalidDataException>(() => PdfDocumentExportProvider.ReadResponse(DocumentExportDigest.Serialize(response), 1024));
    }

    [Fact]
    public void PdfResponse_RejectsUnknownDuplicateFieldsAndNonPdfEnvelope()
    {
        Assert.Throws<InvalidDataException>(() => PdfDocumentExportProvider.ReadResponse(
            Encoding.UTF8.GetBytes("{\"pdfBase64\":\"\",\"pdfBase64\":\"\"}"), 1024));
        var response = new PdfPrintRenderResponse(Convert.ToBase64String("not a PDF"u8),
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 1, 1, []);
        Assert.Throws<InvalidDataException>(() => PdfDocumentExportProvider.ReadResponse(DocumentExportDigest.Serialize(response), 1024));
        response = response with
        {
            PdfBase64 = Convert.ToBase64String("%PDF-1.7\n"u8)
        };
        string wire = Encoding.UTF8.GetString(DocumentExportDigest.Serialize(response));
        Assert.Throws<InvalidDataException>(() => PdfDocumentExportProvider.ReadResponse(
            Encoding.UTF8.GetBytes(wire[..^1] + ",\"outputId\":\"unexpected-second-authority\"}"), 1024));
        Assert.Throws<InvalidDataException>(() => PdfDocumentExportProvider.ReadResponse(DocumentExportDigest.Serialize(response), 4));
    }

    [Fact]
    public void CanonicalPdfEvidence_RejectsInactivePdfBeforeInspectingAReceipt()
    {
        DocumentExportFrozenInput input = WithoutImages();
        DocumentExportProviderContract pdf = DocumentExportContractCatalog.RequireProvider("pdf");
        DocumentExportTask task = DocumentExportContractValidator.Seal(DocumentExportContractTests.ValidTask(input) with
        {
            FormatId = pdf.FormatId,
            ProviderId = pdf.ProviderId,
            ProviderVersion = pdf.ProviderVersion,
            ContentDigest = string.Empty
        });
        DocumentExportToolContract tool = CanonicalTool();

        Assert.Throws<InvalidOperationException>(() => PdfDocumentExportProvider.ValidateCanonicalEvidence(
            [], null!, null!, task, input, tool, DocumentExportContractTests.Digest("trusted-host")));
        // A canonical tool binding cannot qualify the final PDF phase.
        Assert.Throws<InvalidDataException>(() => DocumentExportSandboxRuntime.ValidateReceipt(
            null!, null!, task, input, tool, DocumentExportContractTests.Digest("trusted-host"), []));
    }

    [Fact]
    public void CanonicalPdfEvidence_RejectsFrozenInputDriftBeforeInspectingAReceipt()
    {
        DocumentExportFrozenInput input = WithoutImages();
        DocumentExportProviderContract pdf = DocumentExportContractCatalog.RequireProvider("pdf");
        DocumentExportTask task = DocumentExportContractValidator.Seal(DocumentExportContractTests.ValidTask(input) with
        {
            FormatId = pdf.FormatId,
            ProviderId = pdf.ProviderId,
            ProviderVersion = pdf.ProviderVersion,
            InputDigest = DocumentExportContractTests.Digest("other-input"),
            ContentDigest = string.Empty
        });

        Assert.Throws<InvalidDataException>(() => PdfDocumentExportProvider.ValidateCanonicalEvidence(
            [], null!, null!, task, input, CanonicalTool(), DocumentExportContractTests.Digest("trusted-host")));
    }

    [Fact]
    public void PdfAttemptEvidence_RetainsActualCanonicalEvidenceAndConsumesItOnce()
    {
        PdfDocumentExportResult result = AttemptResult();
        var pending = new PdfDocumentExportAttemptEvidence();

        Assert.Same(result.ProviderResult, pending.Retain(result));
        Assert.Same(result, pending.Take(result.ProviderResult, result.AttemptResources));
        Assert.Throws<InvalidDataException>(() => pending.Take(result.ProviderResult, result.AttemptResources));
    }

    [Fact]
    public void PdfAttemptEvidence_RejectsChangedResultBytesWithoutConsumingTheOriginal()
    {
        PdfDocumentExportResult result = AttemptResult();
        var pending = new PdfDocumentExportAttemptEvidence();
        pending.Retain(result);
        DocumentExportProviderResult reconstructed = result.ProviderResult with
        {
            SandboxOutputBytes = [9]
        };

        Assert.Throws<InvalidDataException>(() => pending.Take(reconstructed, result.AttemptResources));
        Assert.Same(result, pending.Take(result.ProviderResult, result.AttemptResources));
    }

    [Fact]
    public void PdfAttemptEvidence_VerifiesTheJobsPrivatelyOwnedCopyInTheSameAttempt()
    {
        PdfDocumentExportResult result = AttemptResult();
        var pending = new PdfDocumentExportAttemptEvidence();
        pending.Retain(result);
        DocumentExportProviderResult owned = result.ProviderResult with
        {
            Bytes = result.ProviderResult.Bytes.ToArray(),
            SandboxOutputBytes = result.ProviderResult.SandboxOutputBytes.ToArray()
        };

        PdfDocumentExportResult verified = pending.Take(owned, result.AttemptResources);

        Assert.Same(owned, verified.ProviderResult);
        Assert.Same(result.CanonicalRendererOutputBytes, verified.CanonicalRendererOutputBytes);
        Assert.Same(result.AttemptResources, verified.AttemptResources);
        Assert.Throws<InvalidDataException>(() => pending.Take(owned, result.AttemptResources));
    }

    [Fact]
    public void PdfAttemptEvidence_RejectsAResetResourceOwnerWithoutConsumingTheOriginal()
    {
        PdfDocumentExportResult result = AttemptResult();
        PdfDocumentExportResult other = AttemptResult();
        var pending = new PdfDocumentExportAttemptEvidence();
        pending.Retain(result);

        Assert.Throws<InvalidDataException>(() => pending.Take(result.ProviderResult, other.AttemptResources));
        Assert.Same(result, pending.Take(result.ProviderResult, result.AttemptResources));
    }

    [Fact]
    public void PdfAttemptEvidence_RejectsUnownedEvidenceAndSupportsTheOriginalLegacyCallPair()
    {
        PdfDocumentExportResult result = AttemptResult();
        var pending = new PdfDocumentExportAttemptEvidence();

        Assert.Throws<InvalidDataException>(() => pending.Retain(result with { AttemptResources = null }));
        Assert.Throws<InvalidDataException>(() => pending.Take(result.ProviderResult));
        pending.Retain(result);
        Assert.Same(result, pending.Take(result.ProviderResult));
    }

    [Fact]
    public async Task PdfAttemptEvidence_ConcurrentVerifyCannotConsumeTheSameEvidenceTwice()
    {
        PdfDocumentExportResult result = AttemptResult();
        var pending = new PdfDocumentExportAttemptEvidence();
        pending.Retain(result);
        Task<bool>[] claims = Enumerable.Range(0, 8).Select(_ => Task.Run(() =>
        {
            try
            {
                pending.Take(result.ProviderResult, result.AttemptResources);
                return true;
            }
            catch (InvalidDataException)
            {
                return false;
            }
        })).ToArray();

        Assert.Equal(1, (await Task.WhenAll(claims)).Count(claimed => claimed));
    }

    private static PdfDocumentExportResult AttemptResult()
    {
        DocumentExportFrozenInput input = WithoutImages();
        DocumentExportProviderContract pdf = DocumentExportContractCatalog.RequireProvider("pdf");
        DocumentExportTask task = DocumentExportContractValidator.Seal(DocumentExportContractTests.ValidTask(input) with
        {
            FormatId = pdf.FormatId,
            ProviderId = pdf.ProviderId,
            ProviderVersion = pdf.ProviderVersion,
            ContentDigest = string.Empty
        });
        // These are inert custody controls. Null receipt/plan fields cannot
        // qualify a renderer or sandbox; native execution is not simulated.
        return new(new([1, 2], [3, 4], null!, null!, null!), [], null!, null!, 1, 1)
        {
            AttemptResources = new(task, input, pdf.Budgets, TimeProvider.System)
        };
    }

    private static DocumentExportToolContract CanonicalTool()
        => new("canonical-markdown-renderer", "current-v1", "/not-executed/renderer",
            DocumentExportContractTests.Digest("not-executed-tool"), "/not-executed/runtime",
            DocumentExportContractTests.Digest("not-executed-runtime"), ["render"]);

    private static DocumentExportFrozenInput WithoutImages()
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        ImmutableArray<DocumentExportAsset> assets = input.Assets.Where(asset => asset.Role == "font").ToImmutableArray();
        return DocumentExportContractValidator.Seal(input with
        {
            Assets = assets,
            AssetManifestDigest = DocumentExportContractValidator.ComputeAssetManifestDigest(assets),
            FontManifestDigest = DocumentExportContractValidator.ComputeFontManifestDigest(assets)
        });
    }

    private static DocumentExportRendererResponse Response(DocumentExportFrozenInput input, string fragment)
        => SelfContainedHtmlDocumentExportProvider.SealRendererResponse(new DocumentExportRendererResponse(
            DocumentExportContractCatalog.RendererResponseSchema, input.InputId, input.ContentDigest,
            input.SourceDigest, input.AssetManifestDigest, input.FontManifestDigest, input.ReadingStyleAuthorityDigest,
            input.RendererId, input.RendererVersion, input.RendererDigest, "PDF reading", fragment, ["headings", "links"], string.Empty));
}
