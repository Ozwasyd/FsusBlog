using System.Collections.Immutable;
using System.Reflection;
using System.Reflection.Emit;
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
    [InlineData("</article><p>TAIL-CANARY</p>")]
    [InlineData("</article>TAIL-CANARY")]
    [InlineData("</article><!--TAIL-CANARY-->")]
    public void RejectsPrematureWrapperCloseWithoutDroppingTrailingRendererContent(string suffix)
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        long maximumBytes = DocumentExportContractCatalog.RequireProvider("self-contained-html").Budgets.MaxOutputBytes;
        byte[] benign = DocumentExportHtmlSanitizer.Sanitize(
            DocumentExportTestToolFixture.DefaultFragment, input.Assets, maximumBytes);
        Assert.NotEmpty(benign);
        Assert.Contains("Heading 中文 🌍", Encoding.UTF8.GetString(benign), StringComparison.Ordinal);

        DocumentExportRendererResponse response = ValidResponse(
            input, DocumentExportTestToolFixture.DefaultFragment + suffix);
        SelfContainedHtmlDocumentExportProvider.ValidateRendererResponse(response, input);
        Assert.Throws<InvalidDataException>(() => DocumentExportHtmlSanitizer.Sanitize(
            response.HtmlFragment, input.Assets, maximumBytes));
    }

    [Theory]
    [InlineData("")]
    [InlineData(" \n\t")]
    public void PreservesCompleteRendererFragmentAndLegalSurroundingWhitespace(string whitespace)
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        long maximumBytes = DocumentExportContractCatalog.RequireProvider("self-contained-html").Budgets.MaxOutputBytes;
        byte[] baseline = DocumentExportHtmlSanitizer.Sanitize(
            DocumentExportTestToolFixture.DefaultFragment, input.Assets, maximumBytes);
        DocumentExportRendererResponse response = ValidResponse(
            input, whitespace + DocumentExportTestToolFixture.DefaultFragment + whitespace);
        SelfContainedHtmlDocumentExportProvider.ValidateRendererResponse(response, input);

        byte[] actual = DocumentExportHtmlSanitizer.Sanitize(response.HtmlFragment, input.Assets, maximumBytes);

        Assert.Equal(whitespace + Encoding.UTF8.GetString(baseline) + whitespace, Encoding.UTF8.GetString(actual));
    }

    [Fact]
    public async Task ProviderRejectsFullySealedPrematureWrapperCloseAfterCompleteValidPrefix()
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        DocumentExportTask task = DocumentExportContractTests.ValidTask(input);
        string fragment = DocumentExportTestToolFixture.DefaultFragment + "</article><p>TAIL-CANARY</p>";
        DocumentExportRendererResponse response = ValidResponse(input, fragment);
        SelfContainedHtmlDocumentExportProvider.ValidateRendererResponse(response, input);
        using var fixture = new DocumentExportTestToolFixture(fragment, response.ContentDigest);

        await Assert.ThrowsAsync<InvalidDataException>(() => CreateProvider(fixture).ExportAsync(task, input));
    }

    [Fact]
    public async Task ProviderPreservesAllowedTailAfterCompleteValidPrefix()
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        DocumentExportTask task = DocumentExportContractTests.ValidTask(input);
        string fragment = DocumentExportTestToolFixture.DefaultFragment + "<p>TAIL-CANARY</p>";
        DocumentExportRendererResponse response = ValidResponse(input, fragment);
        SelfContainedHtmlDocumentExportProvider.ValidateRendererResponse(response, input);
        using var fixture = new DocumentExportTestToolFixture(fragment, response.ContentDigest);

        DocumentExportProviderResult result = await CreateProvider(fixture).ExportAsync(task, input);

        Assert.Contains("<p>TAIL-CANARY</p>", Encoding.UTF8.GetString(result.Bytes), StringComparison.Ordinal);
        SelfContainedHtmlDocumentExportProvider.ValidateResult(
            result, task, input, fixture.Tool, fixture.HostBuildDigest);
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
        Type[] closedTypes =
        [
            typeof(DocumentExportRendererRequest),
            typeof(DocumentExportRendererResponse),
            typeof(DocumentExportProviderResult),
            typeof(SelfContainedHtmlDocumentExportProvider),
            typeof(CanonicalDocumentRendererResult),
            typeof(ICanonicalDocumentRendererAdapter),
            typeof(SandboxCanonicalDocumentRendererAdapter),
            typeof(DocumentExportProviderRegistry),
            typeof(DocumentExportBoundedMemoryStream),
            typeof(DocumentExportHtmlSanitizer),
            typeof(DocumentExportHtmlVerifier)
        ];
        Assert.All(closedTypes, AssertNoFallbackAuthority);
        Assert.Empty(typeof(SelfContainedHtmlDocumentExportProvider).GetConstructors());
        MethodInfo export = Assert.Single(
            typeof(SelfContainedHtmlDocumentExportProvider).GetMethods(),
            method => method.Name == nameof(SelfContainedHtmlDocumentExportProvider.ExportAsync));
        Assert.Equal(
            [typeof(DocumentExportTask), typeof(DocumentExportFrozenInput), typeof(CancellationToken)],
            export.GetParameters().Select(parameter => parameter.ParameterType));
        AssertRegistryConstruction(typeof(DocumentExportProviderRegistry));
    }

    [Fact]
    public void CompiledRegistryRefusalsCannotSubstituteTextOrAnotherTypeForRealConstruction()
    {
        Type[] refusals =
        [
            typeof(TextOnlyRegistryFixture),
            typeof(OtherProviderRegistryFixture),
            typeof(DuplicateProviderRegistryFixture),
            typeof(TextOnlyToolRegistryFixture),
            typeof(OtherToolRegistryFixture),
            typeof(WrongFormatRegistryFixture)
        ];
        ConstructorInfo providerConstructor = ProviderConstructor();
        MethodInfo requireTool = RegisteredToolMethod();
        Assert.DoesNotContain(ReadSoleConstructor(typeof(TextOnlyRegistryFixture)),
            instruction => instruction.OpCode == OpCodes.Newobj && instruction.Member == providerConstructor);
        IlInstruction otherConstruction = Assert.Single(ReadSoleConstructor(typeof(OtherProviderRegistryFixture)),
            instruction => instruction.OpCode == OpCodes.Newobj
                && instruction.Member?.DeclaringType == typeof(OtherProviderRegistryFixture.SelfContainedHtmlDocumentExportProvider));
        Assert.NotEqual(providerConstructor, otherConstruction.Member);
        Assert.Equal(2, ReadSoleConstructor(typeof(DuplicateProviderRegistryFixture))
            .Count(instruction => instruction.OpCode == OpCodes.Newobj && instruction.Member == providerConstructor));
        Assert.DoesNotContain(ReadSoleConstructor(typeof(TextOnlyToolRegistryFixture)),
            instruction => instruction.Member == requireTool);
        Assert.Contains(ReadSoleConstructor(typeof(OtherToolRegistryFixture)),
            instruction => instruction.Member?.DeclaringType == typeof(OtherToolRegistryFixture.OtherSandbox)
                && instruction.Member?.Name == requireTool.Name);
        Assert.Contains(ReadSoleConstructor(typeof(WrongFormatRegistryFixture)),
            instruction => instruction.Member == requireTool
                && (instruction.OpCode == OpCodes.Call || instruction.OpCode == OpCodes.Callvirt));
        Assert.All(refusals, type => Assert.ThrowsAny<Xunit.Sdk.XunitException>(() => AssertRegistryConstruction(type)));

        AssertRegistryConstruction(typeof(BenignRegistryFixture));
    }

    [Fact]
    public void CompiledFallbackRefusalsIncludeUncalledNestedMethodsAndConstructors()
    {
        MethodInfo network = Assert.Single(typeof(NestedNetworkFixture.Uncalled).GetMethods(DeclaredMembers),
            method => method.Name == nameof(NestedNetworkFixture.Uncalled.CreateClient));
        Assert.Contains(ReadInstructions(network), instruction => instruction.OpCode == OpCodes.Newobj
            && instruction.Member?.DeclaringType == typeof(System.Net.Http.HttpClient));
        MethodInfo process = Assert.Single(typeof(NestedProcessFixture.Uncalled).GetMethods(DeclaredMembers),
            method => method.Name == nameof(NestedProcessFixture.Uncalled.Start));
        Assert.Contains(ReadInstructions(process), instruction => instruction.OpCode == OpCodes.Call
            && instruction.Member?.DeclaringType == typeof(System.Diagnostics.Process)
            && instruction.Member?.Name == nameof(System.Diagnostics.Process.Start));
        Assert.Contains(ReadSoleConstructor(typeof(NestedConstructorFixture.Uncalled)),
            instruction => instruction.OpCode == OpCodes.Ldstr && instruction.Literal == "Screenshot");
        (Type Type, string Method, string Literal)[] literalBodies =
        [
            (typeof(NestedFormatFixture.Uncalled), "Format", "document-export.epub"),
            (typeof(NestedPdfFixture.Uncalled), "Format", "document-export.pdf"),
            (typeof(NestedDocxFixture.Uncalled), "Format", "document-export.docx"),
            (typeof(NestedParserFixture.Uncalled), "Parser", "Markdig"),
            (typeof(NestedMarkdownFixture.Uncalled), "Parser", "Markdown.Parse")
        ];
        Assert.All(literalBodies, candidate =>
        {
            MethodInfo method = Assert.Single(candidate.Type.GetMethods(DeclaredMembers),
                declared => declared.Name == candidate.Method);
            Assert.Contains(ReadInstructions(method), instruction => instruction.OpCode == OpCodes.Ldstr
                && instruction.Literal == candidate.Literal);
        });
        Type[] refusals =
        [
            typeof(NestedNetworkFixture),
            typeof(NestedProcessFixture),
            typeof(NestedConstructorFixture),
            typeof(NestedFormatFixture),
            typeof(NestedPdfFixture),
            typeof(NestedDocxFixture),
            typeof(NestedParserFixture),
            typeof(NestedMarkdownFixture)
        ];
        Assert.All(refusals, type => Assert.ThrowsAny<Xunit.Sdk.XunitException>(() => AssertNoFallbackAuthority(type)));
        AssertNoFallbackAuthority(typeof(BenignFallbackFixture));
    }

    private const BindingFlags DeclaredMembers = BindingFlags.Instance | BindingFlags.Static
        | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly;

    private static readonly IReadOnlyDictionary<ushort, OpCode> s_opCodes = typeof(OpCodes)
        .GetFields(BindingFlags.Public | BindingFlags.Static)
        .Where(field => field.FieldType == typeof(OpCode))
        .Select(field => (OpCode)field.GetValue(null)!)
        .GroupBy(opCode => unchecked((ushort)opCode.Value))
        .ToDictionary(group => group.Key, group => group.First());

    private static void AssertNoFallbackAuthority(Type type)
    {
        string compiled = string.Join('\n',
            RuntimeMetadataInspection.DescribeType(type),
            RuntimeMetadataInspection.DescribeConstructors(type));
        Assert.DoesNotContain("Markdig", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("Markdown.Parse", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("HttpClient", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("Process.Start", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("Screenshot", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("document-export.pdf", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("document-export.docx", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("document-export.epub", compiled, StringComparison.Ordinal);
        Assert.All(type.GetNestedTypes(BindingFlags.Public | BindingFlags.NonPublic), AssertNoFallbackAuthority);
    }

    private static ConstructorInfo ProviderConstructor()
    {
        ConstructorInfo constructor = Assert.Single(typeof(SelfContainedHtmlDocumentExportProvider).GetConstructors(DeclaredMembers));
        Assert.Equal([typeof(ICanonicalDocumentRendererAdapter)],
            constructor.GetParameters().Select(parameter => parameter.ParameterType));
        return constructor;
    }

    private static MethodInfo RegisteredToolMethod()
    {
        MethodInfo method = Assert.Single(typeof(DocumentExportSandboxRuntime).GetMethods(DeclaredMembers),
            candidate => candidate.Name == "RequireRegisteredTool");
        Assert.Equal(typeof(DocumentExportToolContract), method.ReturnType);
        Assert.Equal([typeof(string)], method.GetParameters().Select(parameter => parameter.ParameterType));
        return method;
    }

    private static void AssertRegistryConstruction(Type type)
    {
        IReadOnlyList<IlInstruction> instructions = ReadSoleConstructor(type);
        ConstructorInfo providerConstructor = ProviderConstructor();
        Assert.Single(instructions, instruction => instruction.OpCode == OpCodes.Newobj
            && instruction.Member == providerConstructor);
        MethodInfo requireTool = RegisteredToolMethod();
        // These are exact sites in the declared constructor, not a tool-to-provider dataflow proof.
        Assert.Contains(Enumerable.Range(1, instructions.Count - 1), index =>
            (instructions[index].OpCode == OpCodes.Call || instructions[index].OpCode == OpCodes.Callvirt)
            && instructions[index].Member == requireTool
            && instructions[index - 1].OpCode == OpCodes.Ldstr
            && instructions[index - 1].Literal == "self-contained-html");
    }

    private static IReadOnlyList<IlInstruction> ReadSoleConstructor(Type type)
        => ReadInstructions(Assert.Single(type.GetConstructors(DeclaredMembers)));

    private static IReadOnlyList<IlInstruction> ReadInstructions(MethodBase method)
    {
        MethodBody body = Assert.IsAssignableFrom<MethodBody>(method.GetMethodBody());
        byte[] il = Assert.IsType<byte[]>(body.GetILAsByteArray());
        Type[] typeArguments = method.DeclaringType?.GetGenericArguments() ?? Type.EmptyTypes;
        Type[] methodArguments = method.IsGenericMethod ? method.GetGenericArguments() : Type.EmptyTypes;
        var instructions = new List<IlInstruction>();
        for (int offset = 0; offset < il.Length;)
        {
            ushort value = il[offset++];
            if (value == 0xfe)
            {
                Assert.True(offset < il.Length);
                value = (ushort)(0xfe00 | il[offset++]);
            }
            Assert.True(s_opCodes.TryGetValue(value, out OpCode opCode));
            int operandSize = opCode.OperandType switch
            {
                OperandType.InlineNone => 0,
                OperandType.ShortInlineBrTarget or OperandType.ShortInlineI or OperandType.ShortInlineVar => 1,
                OperandType.InlineVar => 2,
                OperandType.InlineBrTarget or OperandType.InlineField or OperandType.InlineI or OperandType.InlineMethod
                    or OperandType.InlineSig or OperandType.InlineString or OperandType.InlineTok or OperandType.InlineType
                    or OperandType.ShortInlineR => 4,
                OperandType.InlineI8 or OperandType.InlineR => 8,
                OperandType.InlineSwitch when offset + 4 <= il.Length => checked(4 + BitConverter.ToInt32(il, offset) * 4),
                _ => -1
            };
            Assert.True(operandSize >= 0 && operandSize <= il.Length - offset);
            MemberInfo? member = opCode.OperandType == OperandType.InlineMethod
                ? method.Module.ResolveMethod(BitConverter.ToInt32(il, offset), typeArguments, methodArguments)
                : null;
            string? literal = opCode == OpCodes.Ldstr
                ? method.Module.ResolveString(BitConverter.ToInt32(il, offset))
                : null;
            if (opCode != OpCodes.Nop)
            {
                instructions.Add(new IlInstruction(opCode, member, literal));
            }
            offset += operandSize;
        }
        return instructions;
    }

    private readonly record struct IlInstruction(OpCode OpCode, MemberInfo? Member, string? Literal);

    private sealed class TextOnlyRegistryFixture
    {
        public TextOnlyRegistryFixture() => GC.KeepAlive(
            "SelfContainedHtmlDocumentExportProvider..ctor\nself-contained-html\nFsusBlog.Server.Services.DocumentExport.DocumentExportSandboxRuntime.RequireRegisteredTool");
    }

    private sealed class OtherProviderRegistryFixture
    {
        public OtherProviderRegistryFixture(DocumentExportSandboxRuntime sandbox)
        {
            GC.KeepAlive(sandbox.RequireRegisteredTool("self-contained-html"));
            GC.KeepAlive(new SelfContainedHtmlDocumentExportProvider());
        }

        internal sealed class SelfContainedHtmlDocumentExportProvider
        {
            public SelfContainedHtmlDocumentExportProvider()
            {
            }
        }
    }

    private sealed class DuplicateProviderRegistryFixture
    {
        public DuplicateProviderRegistryFixture(DocumentExportSandboxRuntime sandbox)
        {
            GC.KeepAlive(sandbox.RequireRegisteredTool("self-contained-html"));
            GC.KeepAlive(new SelfContainedHtmlDocumentExportProvider(null!));
            GC.KeepAlive(new SelfContainedHtmlDocumentExportProvider(null!));
        }
    }

    private sealed class TextOnlyToolRegistryFixture
    {
        public TextOnlyToolRegistryFixture()
        {
            GC.KeepAlive("self-contained-html\nFsusBlog.Server.Services.DocumentExport.DocumentExportSandboxRuntime.RequireRegisteredTool");
            GC.KeepAlive(new SelfContainedHtmlDocumentExportProvider(null!));
        }
    }

    private sealed class WrongFormatRegistryFixture
    {
        public WrongFormatRegistryFixture(DocumentExportSandboxRuntime sandbox)
        {
            GC.KeepAlive("self-contained-html");
            GC.KeepAlive(sandbox.RequireRegisteredTool("document-export.pdf"));
            GC.KeepAlive(new SelfContainedHtmlDocumentExportProvider(null!));
        }
    }

    private sealed class OtherToolRegistryFixture
    {
        public OtherToolRegistryFixture(OtherSandbox sandbox)
        {
            GC.KeepAlive(sandbox.RequireRegisteredTool("self-contained-html"));
            GC.KeepAlive(new SelfContainedHtmlDocumentExportProvider(null!));
        }

        internal sealed class OtherSandbox
        {
            public DocumentExportToolContract RequireRegisteredTool(string formatId) => null!;
        }
    }

    private sealed class BenignRegistryFixture
    {
        public BenignRegistryFixture(DocumentExportSandboxRuntime sandbox)
        {
            GC.KeepAlive("SelfContainedHtmlDocumentExportProvider..ctor");
            DocumentExportToolContract tool = sandbox.RequireRegisteredTool("self-contained-html");
            GC.KeepAlive(new SelfContainedHtmlDocumentExportProvider(
                new SandboxCanonicalDocumentRendererAdapter(sandbox, tool)));
        }
    }

    private sealed class NestedNetworkFixture
    {
        internal static class Uncalled
        {
            public static object CreateClient() => new System.Net.Http.HttpClient();
        }
    }

    private sealed class NestedProcessFixture
    {
        internal static class Uncalled
        {
            public static object? Start() => System.Diagnostics.Process.Start("forbidden-fixture");
        }
    }

    private sealed class NestedConstructorFixture
    {
        internal sealed class Uncalled
        {
            public Uncalled() => GC.KeepAlive("Screenshot");
        }
    }

    private sealed class NestedFormatFixture
    {
        internal static class Uncalled
        {
            public static string Format() => "document-export.epub";
        }
    }

    private sealed class BenignFallbackFixture
    {
        internal static class Uncalled
        {
            public static string Format() => "self-contained-html";
        }
    }

    private sealed class NestedPdfFixture
    {
        internal static class Uncalled
        {
            public static string Format() => "document-export.pdf";
        }
    }

    private sealed class NestedDocxFixture
    {
        internal static class Uncalled
        {
            public static string Format() => "document-export.docx";
        }
    }

    private sealed class NestedParserFixture
    {
        internal static class Uncalled
        {
            public static string Parser() => "Markdig";
        }
    }

    private sealed class NestedMarkdownFixture
    {
        internal static class Uncalled
        {
            public static string Parser() => "Markdown.Parse";
        }
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
