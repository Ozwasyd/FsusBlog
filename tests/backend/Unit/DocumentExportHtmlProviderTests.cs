using System.Collections.Immutable;
using System.Runtime.InteropServices;
using System.Text;

using FsusBlog.Server.Services.DocumentExport;
using FsusBlog.Server.Tests.Helpers;

namespace FsusBlog.Server.Tests.Unit;

public sealed class DocumentExportHtmlProviderTests
{
    [Fact]
    public void RequiresSandboxRuntime()
    {
        Assert.Throws<ArgumentNullException>(() => new SelfContainedHtmlDocumentExportProvider(null!));
    }

    [Fact]
    public async Task ProducesStableOfflineFullSyntaxDocumentAndQualifiedReceipt()
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput(
            new string('x', 100_001) + "\n\n# 中文\n\nRTL שלום 🌍");
        DocumentExportTask task = DocumentExportContractTests.ValidTask(input);
        using var fixture = new DocumentExportTestToolFixture(
            responseDigest: ValidResponse(input).ContentDigest);
        var provider = new SelfContainedHtmlDocumentExportProvider(fixture.CreateSandbox());

        DocumentExportProviderResult first = await provider.ExportAsync(task, input, fixture.Tool);
        DocumentExportProviderResult second = await provider.ExportAsync(task, input, fixture.Tool);

        Assert.Equal(first.Bytes, second.Bytes);
        Assert.Equal(first.Receipt.OutputDigest, second.Receipt.OutputDigest);
        string html = Encoding.UTF8.GetString(first.Bytes);
        Assert.StartsWith("<!doctype html>\n", html, StringComparison.Ordinal);
        Assert.Contains("Content-Security-Policy", html, StringComparison.Ordinal);
        Assert.Contains("default-src 'none'", html, StringComparison.Ordinal);
        Assert.Contains("data:image/png;base64,", html, StringComparison.Ordinal);
        Assert.Contains("noopener noreferrer external", html, StringComparison.Ordinal);
        Assert.Contains("<svg", html, StringComparison.Ordinal);
        Assert.Contains("katex", html, StringComparison.Ordinal);
        Assert.Contains("中文 🌍", html, StringComparison.Ordinal);
        Assert.DoesNotContain("<script", html, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("src=\"http", html, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("url(http", html, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(DocumentExportContractCatalog.FeatureIds.Count, first.Receipt.ObservedFeatures.Count);
        Assert.Single(first.Receipt.Warnings);
        Assert.Empty(first.Receipt.Errors);
        SelfContainedHtmlDocumentExportProvider.ValidateResult(
            first,
            task,
            input,
            fixture.Tool,
            fixture.HostBuildDigest);
    }

    [Theory]
    [InlineData("<script>alert(1)</script>")]
    [InlineData("<img src=\"https://example.com/a.png\" data-asset-id=\"asset-1\" alt=\"pixel\" />")]
    [InlineData("<a href=\"javascript:alert(1)\">bad</a>")]
    [InlineData("<svg><use href=\"https://example.com/remote.svg#icon\" /></svg>")]
    [InlineData("<iframe srcdoc=\"bad\"></iframe>")]
    public async Task RejectsActiveOrRemoteCanonicalRendererOutput(string fragment)
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        DocumentExportTask task = DocumentExportContractTests.ValidTask(input);
        using var fixture = new DocumentExportTestToolFixture(
            fragment,
            ValidResponse(input, fragment).ContentDigest);
        var provider = new SelfContainedHtmlDocumentExportProvider(fixture.CreateSandbox());

        await Assert.ThrowsAsync<InvalidDataException>(
            () => provider.ExportAsync(task, input, fixture.Tool));
    }

    [Fact]
    public void RendererResponseDigestBindsEveryClosedIdentityAndSemanticField()
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        DocumentExportRendererResponse response = ValidResponse(input);

        SelfContainedHtmlDocumentExportProvider.ValidateRendererResponse(response, input);
        Assert.Throws<InvalidDataException>(() => SelfContainedHtmlDocumentExportProvider.ValidateRendererResponse(
            response with
            {
                Title = "tampered title"
            }, input));
        Assert.Throws<InvalidDataException>(() => SelfContainedHtmlDocumentExportProvider.ValidateRendererResponse(
            response with
            {
                ObservedFeatures = ["headings"]
            }, input));
        Assert.Throws<InvalidDataException>(() => SelfContainedHtmlDocumentExportProvider.ValidateRendererResponse(
            response with
            {
                RendererVersion = "other"
            }, input));
        Assert.Throws<InvalidDataException>(() => SelfContainedHtmlDocumentExportProvider.ValidateRendererResponse(
            response with
            {
                HtmlFragment = "<p>tampered</p>"
            }, input));
    }

    [Fact]
    public async Task OwnsDeepFrozenInputBeforeAwaitAndIgnoresCallerMutation()
    {
        DocumentExportFrozenInput baseline = DocumentExportContractTests.ValidInput("# original caller source");
        byte[] sourceBytes = baseline.MarkdownUtf8.ToArray();
        byte[] assetBytes = baseline.Assets[0].Bytes.ToArray();
        var asset = baseline.Assets[0] with
        {
            Bytes = ImmutableCollectionsMarshal.AsImmutableArray(assetBytes)
        };
        DocumentExportAsset[] assetContainer = [asset];
        DocumentExportFrozenInput callerOwned = baseline with
        {
            MarkdownUtf8 = ImmutableCollectionsMarshal.AsImmutableArray(sourceBytes),
            Assets = ImmutableCollectionsMarshal.AsImmutableArray(assetContainer),
            ContentDigest = string.Empty
        };
        callerOwned = callerOwned with
        {
            ContentDigest = DocumentExportDigest.Compute(callerOwned)
        };
        DocumentExportFrozenInput expectedSnapshot = DocumentExportContractValidator.Seal(callerOwned);
        DocumentExportTask task = DocumentExportContractTests.ValidTask(expectedSnapshot);
        using var fixture = new DocumentExportTestToolFixture(
            responseDigest: ValidResponse(expectedSnapshot).ContentDigest);
        var provider = new SelfContainedHtmlDocumentExportProvider(fixture.CreateSandbox());

        Task<DocumentExportProviderResult> pending = provider.ExportAsync(task, callerOwned, fixture.Tool);
        sourceBytes[0] = (byte)'!';
        assetBytes[0] = 0;
        assetContainer[0] = asset with
        {
            AltText = "mutated"
        };
        DocumentExportProviderResult result = await pending;

        string expectedDataUri = $"data:{asset.MediaType};base64,{Convert.ToBase64String(expectedSnapshot.Assets[0].Bytes.AsSpan())}";
        Assert.Contains(expectedDataUri, Encoding.UTF8.GetString(result.Bytes), StringComparison.Ordinal);
        SelfContainedHtmlDocumentExportProvider.ValidateResult(
            result,
            task,
            expectedSnapshot,
            fixture.Tool,
            fixture.HostBuildDigest);
    }

    [Fact]
    public async Task IndependentVerifierRejectsOutputReceiptAndSandboxTamper()
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        DocumentExportTask task = DocumentExportContractTests.ValidTask(input);
        using var fixture = new DocumentExportTestToolFixture(
            responseDigest: ValidResponse(input).ContentDigest);
        var provider = new SelfContainedHtmlDocumentExportProvider(fixture.CreateSandbox());
        DocumentExportProviderResult result = await provider.ExportAsync(task, input, fixture.Tool);

        Assert.Throws<InvalidDataException>(() => SelfContainedHtmlDocumentExportProvider.ValidateResult(
            result with
            {
                Bytes = [.. result.Bytes, 0]
            },
            task,
            input,
            fixture.Tool,
            fixture.HostBuildDigest));
        Assert.Throws<InvalidDataException>(() => SelfContainedHtmlDocumentExportProvider.ValidateResult(
            result with
            {
                Receipt = result.Receipt with
                {
                    Status = DocumentExportProviderResultStatus.Failed
                }
            },
            task,
            input,
            fixture.Tool,
            fixture.HostBuildDigest));
        Assert.Throws<InvalidDataException>(() => SelfContainedHtmlDocumentExportProvider.ValidateResult(
            result with
            {
                SandboxReceipt = result.SandboxReceipt with
                {
                    RunDirectoryRemoved = false
                }
            },
            task,
            input,
            fixture.Tool,
            fixture.HostBuildDigest));
        Assert.Throws<InvalidDataException>(() => SelfContainedHtmlDocumentExportProvider.ValidateResult(
            result with
            {
                SandboxOutputBytes = [.. result.SandboxOutputBytes, 0]
            },
            task,
            input,
            fixture.Tool,
            fixture.HostBuildDigest));

        DocumentExportProviderReceipt warningTamper = result.Receipt with
        {
            Warnings = [],
            ContentDigest = string.Empty
        };
        warningTamper = warningTamper with
        {
            ContentDigest = DocumentExportDigest.Compute(warningTamper)
        };
        Assert.Throws<InvalidDataException>(() => SelfContainedHtmlDocumentExportProvider.ValidateResult(
            result with
            {
                Receipt = warningTamper
            },
            task,
            input,
            fixture.Tool,
            fixture.HostBuildDigest));
    }

    [Fact]
    public void StaticGovernanceHasNoRendererParserNetworkScreenshotOrFormatFallbackAuthority()
    {
        string source = FsusBlog.Server.Tests.TestInfrastructure.BackendTestPaths.ReadAllTextFromRoot(
            "src", "backend", "Services", "DocumentExport", "SelfContainedHtmlDocumentExportProvider.cs");

        Assert.DoesNotContain("Markdig", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Markdown.Parse", source, StringComparison.Ordinal);
        Assert.DoesNotContain("HttpClient", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Process.Start", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Screenshot", source, StringComparison.Ordinal);
        Assert.DoesNotContain("document-export.pdf", source, StringComparison.Ordinal);
        Assert.DoesNotContain("document-export.docx", source, StringComparison.Ordinal);
        Assert.DoesNotContain("document-export.epub", source, StringComparison.Ordinal);
    }

    private static DocumentExportRendererResponse ValidResponse(
        DocumentExportFrozenInput input,
        string? fragment = null)
        => SelfContainedHtmlDocumentExportProvider.SealRendererResponse(new DocumentExportRendererResponse(
            DocumentExportContractCatalog.RendererResponseSchema,
            input.InputId,
            input.ContentDigest,
            input.SourceDigest,
            input.RendererId,
            input.RendererVersion,
            input.RendererDigest,
            "离线文档",
            fragment ?? DocumentExportTestToolFixture.DefaultFragment,
            DocumentExportTestToolFixture.DefaultObservedFeatures,
            string.Empty));
}
