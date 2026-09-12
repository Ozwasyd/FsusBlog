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
        Assert.Throws<ArgumentNullException>(() => new DocumentExportProviderRegistry(null!));
    }

    [Fact]
    public async Task ProducesStableOfflineFullSyntaxDocumentAndQualifiedReceipt()
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput(
            new string('x', 100_001) + "\n\n# 中文\n\nRTL שלום 🌍");
        DocumentExportTask task = DocumentExportContractTests.ValidTask(input);
        using var fixture = new DocumentExportTestToolFixture(
            responseDigest: ValidResponse(input).ContentDigest);
        SelfContainedHtmlDocumentExportProvider provider = CreateProvider(fixture);

        DocumentExportProviderResult first = await provider.ExportAsync(task, input);
        DocumentExportProviderResult second = await provider.ExportAsync(task, input);

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
        Assert.Contains($"content=\"{input.ReadingStyleAuthorityDigest}\"", html, StringComparison.Ordinal);
        Assert.Equal(7, html.Split("@font-face", StringSplitOptions.None).Length - 1);
        Assert.Contains("font-family:'Google Sans';font-style:normal;font-weight:400", html, StringComparison.Ordinal);
        Assert.Contains("font-family:'Google Sans';font-style:normal;font-weight:500", html, StringComparison.Ordinal);
        Assert.Contains("font-family:'Google Sans';font-style:normal;font-weight:700", html, StringComparison.Ordinal);
        Assert.Contains("font-family:'Noto Sans SC';font-style:normal;font-weight:400", html, StringComparison.Ordinal);
        Assert.Contains("font-family:'Noto Sans SC';font-style:normal;font-weight:500", html, StringComparison.Ordinal);
        Assert.Contains("font-family:'Noto Sans SC';font-style:normal;font-weight:700", html, StringComparison.Ordinal);
        Assert.Contains("font-family:'JetBrains Mono';font-style:normal;font-weight:400", html, StringComparison.Ordinal);
        Assert.Equal(7, html.Split("src:url(data:font/woff2;base64,", StringSplitOptions.None).Length - 1);
        Assert.Contains("max-width:72ch", html, StringComparison.Ordinal);
        Assert.Contains("font-size:16px;font-weight:400;line-height:1.8", html, StringComparison.Ordinal);
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
    [InlineData("<p style=\"background:url(https://example.com/a)\">bad</p>")]
    [InlineData("<img data-asset-id=\"3f3b2e7a-1d2e-4f8a-9c5b-6a7b8c9d0e1f\" src=\"data:image/png;base64,iVBORw0KGgo=\" srcset=\"https://example.com/a.png 2x\" alt=\"hero\" />")]
    [InlineData("<p onclick=\"alert(1)\">bad</p>")]
    [InlineData("<p id=\"duplicate\">a</p><p id=\"duplicate\">b</p>")]
    [InlineData("<a href=\"#missing\">missing target</a>")]
    public async Task RejectsActiveOrRemoteCanonicalRendererOutput(string fragment)
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        DocumentExportTask task = DocumentExportContractTests.ValidTask(input);
        using var fixture = new DocumentExportTestToolFixture(
            fragment,
            ValidResponse(input, fragment).ContentDigest);
        SelfContainedHtmlDocumentExportProvider provider = CreateProvider(fixture);

        await Assert.ThrowsAsync<InvalidDataException>(
            () => provider.ExportAsync(task, input));
    }

    [Theory]
    [InlineData("light-v1", "ltr", "#FFFFFF", "#0F0F11", "#71717A", "#2A599C")]
    [InlineData("dark-v1", "rtl", "#09090B", "#F0F0F4", "#A1A1AA", "#4B79CC")]
    public async Task ProjectsExactThemeDirectionAndReadingAuthority(
        string themeProfile,
        string direction,
        string background,
        string foreground,
        string muted,
        string link)
    {
        DocumentExportFrozenInput baseline = DocumentExportContractTests.ValidInput();
        string locale = direction == "rtl" ? "he-IL" : "zh-Hant";
        DocumentExportFrozenInput input = DocumentExportContractValidator.Seal(baseline with
        {
            ThemeProfile = themeProfile,
            Locale = locale,
            ContentDigest = string.Empty
        });
        DocumentExportTask task = DocumentExportContractTests.ValidTask(input);
        using var fixture = new DocumentExportTestToolFixture(
            responseDigest: ValidResponse(input).ContentDigest);

        DocumentExportProviderResult result = await CreateProvider(fixture).ExportAsync(task, input);
        string html = Encoding.UTF8.GetString(result.Bytes);

        Assert.Contains($"<html lang=\"{locale}\" dir=\"{direction}\">", html, StringComparison.Ordinal);
        Assert.Contains($"--reading-bg:{background}", html, StringComparison.Ordinal);
        Assert.Contains($"--reading-fg:{foreground}", html, StringComparison.Ordinal);
        Assert.Contains($"--reading-muted:{muted}", html, StringComparison.Ordinal);
        Assert.Contains($"--reading-link:{link}", html, StringComparison.Ordinal);
        SelfContainedHtmlDocumentExportProvider.ValidateResult(
            result,
            task,
            input,
            fixture.Tool,
            fixture.HostBuildDigest);
    }

    [Theory]
    [InlineData(false, 0)]
    [InlineData(true, 1)]
    public async Task DerivesWarningsOnlyFromClosedObservedFeaturePolicy(
        bool observePageEbookLimit,
        int expectedWarningCount)
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        DocumentExportTask task = DocumentExportContractTests.ValidTask(input);
        ImmutableArray<string> observed = observePageEbookLimit
            ? ["headings", "page-ebook-limits"]
            : ["headings"];
        DocumentExportRendererResponse response = ValidResponse(input, observedFeatures: observed);
        using var fixture = new DocumentExportTestToolFixture(
            responseDigest: response.ContentDigest,
            observedFeatures: observed);

        DocumentExportProviderResult result = await CreateProvider(fixture).ExportAsync(task, input);

        Assert.Equal(expectedWarningCount, result.Receipt.Warnings.Count);
        if (observePageEbookLimit)
        {
            Assert.Equal(
                "page-ebook-limits:preserve-semantic-flow-with-explicit-warning",
                Assert.Single(result.Receipt.Warnings));
        }
        Assert.Equal(observed.OrderBy(value => value, StringComparer.Ordinal), result.Receipt.ObservedFeatures);
    }

    [Theory]
    [InlineData("headings,headings")]
    [InlineData("headings,unknown-feature")]
    public async Task RejectsUnknownOrDuplicateObservedFeatures(string observedCsv)
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        DocumentExportTask task = DocumentExportContractTests.ValidTask(input);
        ImmutableArray<string> observed = observedCsv.Split(',').ToImmutableArray();
        DocumentExportRendererResponse response = ValidResponse(input, observedFeatures: observed);
        using var fixture = new DocumentExportTestToolFixture(
            responseDigest: response.ContentDigest,
            observedFeatures: observed);

        await Assert.ThrowsAsync<InvalidDataException>(
            () => CreateProvider(fixture).ExportAsync(task, input));
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
        DocumentExportAsset[] assetContainer = baseline.Assets.ToArray();
        assetContainer[0] = asset;
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
        SelfContainedHtmlDocumentExportProvider provider = CreateProvider(fixture);

        Task<DocumentExportProviderResult> pending = provider.ExportAsync(task, callerOwned);
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
        SelfContainedHtmlDocumentExportProvider provider = CreateProvider(fixture);
        DocumentExportProviderResult result = await provider.ExportAsync(task, input);

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
        string providerSource = FsusBlog.Server.Tests.TestInfrastructure.BackendTestPaths.ReadAllTextFromRoot(
            "src", "backend", "Services", "DocumentExport", "SelfContainedHtmlDocumentExportProvider.cs");
        string adapterSource = FsusBlog.Server.Tests.TestInfrastructure.BackendTestPaths.ReadAllTextFromRoot(
            "src", "backend", "Services", "DocumentExport", "CanonicalDocumentRendererAdapter.cs");
        string sanitizerSource = FsusBlog.Server.Tests.TestInfrastructure.BackendTestPaths.ReadAllTextFromRoot(
            "src", "backend", "Services", "DocumentExport", "DocumentExportHtmlSanitizer.cs");
        string verifierSource = FsusBlog.Server.Tests.TestInfrastructure.BackendTestPaths.ReadAllTextFromRoot(
            "src", "backend", "Services", "DocumentExport", "DocumentExportHtmlVerifier.cs");
        string[] sources = [providerSource, adapterSource, sanitizerSource, verifierSource];

        Assert.All(sources, source =>
        {
            Assert.DoesNotContain("Markdig", source, StringComparison.Ordinal);
            Assert.DoesNotContain("Markdown.Parse", source, StringComparison.Ordinal);
            Assert.DoesNotContain("HttpClient", source, StringComparison.Ordinal);
            Assert.DoesNotContain("Process.Start", source, StringComparison.Ordinal);
            Assert.DoesNotContain("Screenshot", source, StringComparison.Ordinal);
            Assert.DoesNotContain("document-export.pdf", source, StringComparison.Ordinal);
            Assert.DoesNotContain("document-export.docx", source, StringComparison.Ordinal);
            Assert.DoesNotContain("document-export.epub", source, StringComparison.Ordinal);
        });
        Assert.Empty(typeof(SelfContainedHtmlDocumentExportProvider).GetConstructors());
        System.Reflection.MethodInfo export = Assert.Single(
            typeof(SelfContainedHtmlDocumentExportProvider).GetMethods(),
            method => method.Name == nameof(SelfContainedHtmlDocumentExportProvider.ExportAsync));
        Assert.Equal(
            [typeof(DocumentExportTask), typeof(DocumentExportFrozenInput), typeof(CancellationToken)],
            export.GetParameters().Select(parameter => parameter.ParameterType));
        Assert.Equal(1, adapterSource.Split("new SelfContainedHtmlDocumentExportProvider(", StringSplitOptions.None).Length - 1);
        Assert.Contains("RequireRegisteredTool(\"self-contained-html\")", adapterSource, StringComparison.Ordinal);
    }

    private static DocumentExportRendererResponse ValidResponse(
        DocumentExportFrozenInput input,
        string? fragment = null,
        ImmutableArray<string>? observedFeatures = null)
        => SelfContainedHtmlDocumentExportProvider.SealRendererResponse(new DocumentExportRendererResponse(
            DocumentExportContractCatalog.RendererResponseSchema,
            input.InputId,
            input.ContentDigest,
            input.SourceDigest,
            input.AssetManifestDigest,
            input.FontManifestDigest,
            input.ReadingStyleAuthorityDigest,
            input.RendererId,
            input.RendererVersion,
            input.RendererDigest,
            "离线文档",
            fragment ?? DocumentExportTestToolFixture.DefaultFragment,
            observedFeatures ?? DocumentExportTestToolFixture.DefaultObservedFeatures,
            string.Empty));

    private static SelfContainedHtmlDocumentExportProvider CreateProvider(
        DocumentExportTestToolFixture fixture)
        => new DocumentExportProviderRegistry(fixture.CreateSandbox())
            .RequireSelfContainedHtml("self-contained-html");
}
