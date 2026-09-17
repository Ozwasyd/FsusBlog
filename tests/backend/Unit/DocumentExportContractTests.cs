using System.Collections.Immutable;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;

using FsusBlog.Server.Services.DocumentExport;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class DocumentExportContractTests
{
    [Fact]
    public void Catalog_DeclaresExactFourFormatsAndOneAvailableImplementation()
    {
        DocumentExportContractValidator.ValidateCatalog(DocumentExportContractCatalog.Providers);

        Assert.Equal(
            ["self-contained-html", "pdf", "docx", "epub"],
            DocumentExportContractCatalog.Providers.Select(provider => provider.FormatId));
        DocumentExportProviderContract active = Assert.Single(
            DocumentExportContractCatalog.Providers,
            provider => provider.ImplementationAvailable);
        Assert.Equal("self-contained-html", active.FormatId);
        Assert.All(DocumentExportContractCatalog.Providers, provider =>
        {
            Assert.Equal(DocumentExportContractCatalog.InputSchema, provider.InputSchema);
            Assert.Equal(DocumentExportContractCatalog.ResultSchema, provider.ResultSchema);
            Assert.Equal(DocumentExportContractCatalog.SandboxClass, provider.SandboxClass);
            Assert.Equal(DocumentExportContractCatalog.NetworkPolicy, provider.NetworkPolicy);
            Assert.Equal(DocumentExportContractCatalog.FeatureIds.Count, provider.Features.Count);
        });
    }

    [Fact]
    public void Catalog_RejectsMissingDuplicateUnknownAndMismatchedProviders()
    {
        DocumentExportProviderContract html = DocumentExportContractCatalog.RequireProvider("self-contained-html");
        Assert.Throws<InvalidOperationException>(() => DocumentExportContractValidator.ValidateCatalog(
            DocumentExportContractCatalog.Providers.Take(3).ToArray()));
        Assert.Throws<InvalidOperationException>(() => DocumentExportContractValidator.ValidateCatalog(
            [html, html, .. DocumentExportContractCatalog.Providers.Skip(2)]));
        Assert.Throws<InvalidOperationException>(() => DocumentExportContractValidator.ValidateCatalog(
            [html with { FormatId = "html" }, .. DocumentExportContractCatalog.Providers.Skip(1)]));
        Assert.Throws<InvalidOperationException>(() => DocumentExportContractValidator.ValidateCatalog(
            [html with { NetworkPolicy = "network-allowed" }, .. DocumentExportContractCatalog.Providers.Skip(1)]));
        Assert.Throws<ArgumentException>(() => DocumentExportContractCatalog.RequireProvider("latest-html"));
    }

    [Fact]
    public void Catalog_BindsProviderImplementationAndToolIdentitiesBidirectionally()
    {
        DocumentExportContractValidator.ValidateCatalog(DocumentExportContractCatalog.Providers);
        Assert.Equal(
            DocumentExportContractCatalog.Providers.Select(provider => provider.ProviderId),
            DocumentExportContractCatalog.ExecutionBindings.Select(binding => binding.ProviderId));

        DocumentExportProviderExecutionBinding[] missing = [.. DocumentExportContractCatalog.ExecutionBindings.Skip(1)];
        Assert.Throws<InvalidOperationException>(() => DocumentExportContractValidator.ValidateCatalog(
            DocumentExportContractCatalog.Providers,
            missing,
            DocumentExportContractCatalog.Normalizations,
            DocumentExportContractCatalog.StaticGovernance));

        DocumentExportProviderExecutionBinding[] drifted = [.. DocumentExportContractCatalog.ExecutionBindings];
        drifted[0] = drifted[0] with
        {
            ToolId = "same-name-different-tool"
        };
        Assert.Throws<InvalidOperationException>(() => DocumentExportContractValidator.ValidateCatalog(
            DocumentExportContractCatalog.Providers,
            drifted,
            DocumentExportContractCatalog.Normalizations,
            DocumentExportContractCatalog.StaticGovernance));

        DocumentExportProviderContract[] providers = [.. DocumentExportContractCatalog.Providers];
        providers[0] = providers[0] with
        {
            ProviderOwner = "other-implementation",
            ToolchainId = "other-tool"
        };
        drifted[0] = drifted[0] with
        {
            ImplementationIdentity = "other-implementation",
            ToolId = "other-tool"
        };
        Assert.Throws<InvalidOperationException>(() => DocumentExportContractValidator.ValidateCatalog(
            providers,
            drifted,
            DocumentExportContractCatalog.Normalizations,
            DocumentExportContractCatalog.StaticGovernance));
    }

    [Theory]
    [InlineData(DocumentExportFeatureDisposition.Supported, "fallback")]
    [InlineData(DocumentExportFeatureDisposition.WarningWithPreservedFallback, "")]
    [InlineData(DocumentExportFeatureDisposition.HardFail, "fallback")]
    [InlineData((DocumentExportFeatureDisposition)99, "none")]
    public void Catalog_RejectsSilentOrUnknownFeaturePolicy(
        DocumentExportFeatureDisposition disposition,
        string fallback)
    {
        DocumentExportProviderContract html = DocumentExportContractCatalog.RequireProvider("self-contained-html");
        DocumentExportFeatureSupport[] features = [.. html.Features];
        features[0] = features[0] with
        {
            Disposition = disposition,
            PreservedFallback = fallback
        };

        Assert.Throws<InvalidOperationException>(() => DocumentExportContractValidator.ValidateCatalog(
            [html with { Features = features }, .. DocumentExportContractCatalog.Providers.Skip(1)]));
    }

    [Fact]
    public void FrozenInput_BindsExactCoordinateAuthoritiesRendererAndAssetBytes()
    {
        DocumentExportFrozenInput input = ValidInput();

        DocumentExportContractValidator.Validate(input);
        DocumentExportContractValidator.ValidateFrozenIdentity(
            input,
            input.SourceDigest,
            input.MetadataDigest,
            input.PropertyDigest,
            input.AssetManifestDigest,
            input.FontManifestDigest,
            input.RendererDigest,
            input.ReadingStyleAuthorityDigest);

        Assert.Throws<InvalidDataException>(() => DocumentExportContractValidator.Validate(
            input with
            {
                MarkdownUtf8 = Encoding.UTF8.GetBytes("new latest source")
                    .ToImmutableArray()
            }));
        Assert.Throws<InvalidDataException>(() => DocumentExportContractValidator.ValidateFrozenIdentity(
            input,
            Digest("latest source"),
            input.MetadataDigest,
            input.PropertyDigest,
            input.AssetManifestDigest,
            input.FontManifestDigest,
            input.RendererDigest,
            input.ReadingStyleAuthorityDigest));
        Assert.Throws<InvalidDataException>(() => DocumentExportContractValidator.Validate(
            input with
            {
                Assets = [input.Assets[0] with { Bytes = [1, 2, 3] }]
            }));
        Assert.Throws<InvalidDataException>(() => DocumentExportContractValidator.Validate(
            input with
            {
                RendererDigest = Digest("new renderer")
            }));
    }

    [Fact]
    public void FrozenInput_RequiresExactReadingFontClosureAndAuthorityDigest()
    {
        DocumentExportFrozenInput baseline = ValidInput();
        DocumentExportAsset[] missingFont = baseline.Assets
            .Where(asset => asset.AssetId != "font-7")
            .ToArray();
        DocumentExportFrozenInput missingFontInput = ResealAssets(baseline, missingFont);
        Assert.Throws<InvalidDataException>(() => DocumentExportContractValidator.Validate(missingFontInput));

        DocumentExportAsset duplicateFont = baseline.Assets[^1] with
        {
            AssetId = "font-duplicate"
        };
        DocumentExportAsset[] duplicateFonts = [.. baseline.Assets, duplicateFont];
        DocumentExportFrozenInput duplicateFontInput = ResealAssets(baseline, duplicateFonts);
        Assert.Throws<InvalidDataException>(() => DocumentExportContractValidator.Validate(duplicateFontInput));

        Assert.Throws<InvalidDataException>(() => DocumentExportContractValidator.Validate(
            baseline with
            {
                ReadingStyleAuthorityDigest = Digest("other-reading-authority")
            }));
    }

    [Fact]
    public void FrozenInput_SealOwnsDeepImmutableSourceAssetAndManifestSnapshot()
    {
        byte[] source = Encoding.UTF8.GetBytes("# caller-owned source");
        byte[] assetBytes = [1, 2, 3, 4];
        DocumentExportAsset[] assets =
        [
            new(
                "asset-owned",
                "image/png",
                DocumentExportDigest.ComputeBytes(assetBytes),
                ImmutableCollectionsMarshal.AsImmutableArray(assetBytes),
                "owned",
                "image",
                string.Empty,
                0,
                "normal"),
            .. FontAssets()
        ];
        var unsealed = new DocumentExportFrozenInput(
            DocumentExportContractCatalog.InputSchema,
            "input-owned",
            7,
            11,
            new DocumentExportArticleCoordinate(DocumentExportCoordinateKind.Revision, 42, null, 101, null, 3),
            ImmutableCollectionsMarshal.AsImmutableArray(source),
            DocumentExportDigest.ComputeBytes(source),
            Digest("metadata"),
            Digest("properties"),
            DocumentExportContractValidator.ComputeAssetManifestDigest(assets),
            DocumentExportContractValidator.ComputeFontManifestDigest(assets),
            "fsusui.markdown-renderer",
            "current-v1",
            Digest("renderer"),
            DocumentExportReadingStyleAuthority.LayoutProfile,
            DocumentExportReadingStyleAuthority.LightThemeProfile,
            "zh-CN",
            ImmutableCollectionsMarshal.AsImmutableArray(assets),
            DocumentExportReadingStyleAuthority.AuthorityDigest,
            string.Empty);

        DocumentExportFrozenInput frozen = DocumentExportContractValidator.Seal(unsealed);
        source[0] = (byte)'!';
        assetBytes[0] = 99;
        assets[0] = assets[0] with
        {
            AltText = "mutated"
        };

        DocumentExportContractValidator.Validate(frozen);
        Assert.Equal("# caller-owned source", Encoding.UTF8.GetString(frozen.MarkdownUtf8.AsSpan()));
        Assert.Equal(new byte[] { 1, 2, 3, 4 }, frozen.Assets[0].Bytes.AsSpan().ToArray());
        Assert.Equal("owned", frozen.Assets[0].AltText);
    }

    [Theory]
    [InlineData("fsusblog.document-export-frozen-input.v1")]
    [InlineData("fsusblog.document-export-frozen-input.v3")]
    [InlineData("")]
    public void FrozenInput_RejectsOldFutureAndMissingSchemas(string schema)
    {
        Assert.Throws<ArgumentException>(() => DocumentExportContractValidator.Validate(
            ValidInput() with
            {
                Schema = schema
            }));
    }

    [Fact]
    public void FrozenInput_RejectsMixedCoordinateKinds()
    {
        DocumentExportFrozenInput input = ValidInput();
        Assert.Throws<ArgumentException>(() => DocumentExportContractValidator.Validate(
            input with
            {
                Coordinate = input.Coordinate with
                {
                    Kind = DocumentExportCoordinateKind.Draft,
                    DraftKey = "draft:article:42"
                }
            }));
        Assert.Throws<ArgumentException>(() => DocumentExportContractValidator.Validate(
            input with
            {
                Coordinate = input.Coordinate with
                {
                    Kind = (DocumentExportCoordinateKind)99
                }
            }));
    }

    [Theory]
    [InlineData(DocumentExportCoordinateKind.Draft)]
    [InlineData(DocumentExportCoordinateKind.Revision)]
    [InlineData(DocumentExportCoordinateKind.Publication)]
    public void FrozenInput_AcceptsEachExactCoordinateKind(DocumentExportCoordinateKind kind)
    {
        DocumentExportFrozenInput input = ValidInput();
        DocumentExportArticleCoordinate coordinate = kind switch
        {
            DocumentExportCoordinateKind.Draft => input.Coordinate with
            {
                Kind = kind,
                DraftKey = "draft:42:3",
                RevisionId = null,
                PublicationId = null
            },
            DocumentExportCoordinateKind.Revision => input.Coordinate with
            {
                Kind = kind,
                DraftKey = null,
                RevisionId = 101,
                PublicationId = null
            },
            _ => input.Coordinate
        };
        input = DocumentExportContractValidator.Seal(input with
        {
            Coordinate = coordinate
        });

        DocumentExportContractValidator.Validate(input);
        DocumentExportContractValidator.Validate(ValidTask(input), input);
    }

    [Fact]
    public void Task_BindsFrozenInputAndClosedLifecycleWithoutFallback()
    {
        DocumentExportFrozenInput input = ValidInput();
        DocumentExportTask task = ValidTask(input);

        DocumentExportContractValidator.Validate(task, input);

        Assert.Throws<InvalidDataException>(() => DocumentExportContractValidator.Validate(
            task with
            {
                InputDigest = Digest("latest input")
            },
            input));
        Assert.Throws<InvalidDataException>(() => DocumentExportContractValidator.Validate(
            task with
            {
                ProviderId = "document-export.pdf"
            },
            input));
        Assert.Throws<ArgumentException>(() => DocumentExportContractValidator.Validate(
            DocumentExportContractValidator.Seal(task with
            {
                FormatId = "html"
            }),
            input));
        Assert.Throws<ArgumentException>(() => DocumentExportContractValidator.Validate(
            DocumentExportContractValidator.Seal(task with
            {
                Status = (DocumentExportTaskStatus)99
            }),
            input));
    }

    [Fact]
    public void TaskLifecycle_IsExactAndEveryDeclaredStateValidates()
    {
        string[] expected =
        [
            "Queued", "Preparing", "Running", "Cancelling", "Cancelled", "Succeeded", "Failed",
            "Blocked", "Expired", "CleanupRequired"
        ];
        Assert.Equal(expected, Enum.GetNames<DocumentExportTaskStatus>());
        DocumentExportFrozenInput input = ValidInput();
        foreach (DocumentExportTaskStatus status in Enum.GetValues<DocumentExportTaskStatus>())
        {
            DocumentExportTask task = DocumentExportContractValidator.Seal(ValidTask(input) with
            {
                Status = status
            });
            DocumentExportContractValidator.Validate(task, input);
        }
    }

    [Fact]
    public void Catalog_DeclaresMechanicallyExecutableIsolationAndNoFallbackGovernance()
    {
        Assert.Equal(
            [
                "headings", "links", "images", "tables", "code-shiki", "mermaid", "katex-latex",
                "footnotes", "anchors", "embeds", "captions", "cjk", "rtl", "emoji", "page-ebook-limits"
            ],
            DocumentExportContractCatalog.FeatureIds);
        Assert.All(DocumentExportContractCatalog.Providers, provider =>
        {
            Assert.Equal("document-export-isolated-process-v1", provider.SandboxClass);
            Assert.Equal("deny-all-except-declared-loopback-v1", provider.NetworkPolicy);
            Assert.DoesNotContain("latest", provider.ToolchainVersion, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("screenshot", provider.ToolchainId, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("parser", provider.ProviderOwner, StringComparison.OrdinalIgnoreCase);
            Assert.True(provider.Budgets.MaxConcurrency > 0);
            Assert.True(provider.Budgets.MaxProcessCount > 0);
            Assert.True(provider.Budgets.MaxOutputBytes > 0);
            Assert.Equal("prohibited", provider.Delivery.PublicStaticRootPolicy);
        });
        DocumentExportProviderContract html = DocumentExportContractCatalog.RequireProvider("self-contained-html");
        DocumentExportFeatureSupport[] hardFail = [.. html.Features];
        hardFail[0] = hardFail[0] with
        {
            Disposition = DocumentExportFeatureDisposition.HardFail,
            PreservedFallback = "none"
        };
        Assert.Throws<InvalidOperationException>(() => DocumentExportContractValidator.ValidateCatalog(
            [html with { Features = hardFail }, .. DocumentExportContractCatalog.Providers.Skip(1)]));

        DocumentExportProviderExecutionBinding[] shellMutation = [.. DocumentExportContractCatalog.ExecutionBindings];
        shellMutation[0] = shellMutation[0] with
        {
            ExactArguments = ["-c", "render"],
            ShellPolicy = "allowed"
        };
        Assert.Throws<InvalidOperationException>(() => DocumentExportContractValidator.ValidateCatalog(
            DocumentExportContractCatalog.Providers,
            shellMutation,
            DocumentExportContractCatalog.Normalizations,
            DocumentExportContractCatalog.StaticGovernance));
        Assert.Throws<InvalidOperationException>(() => DocumentExportContractValidator.ValidateCatalog(
            DocumentExportContractCatalog.Providers,
            DocumentExportContractCatalog.ExecutionBindings,
            DocumentExportContractCatalog.Normalizations,
            DocumentExportContractCatalog.StaticGovernance with
            {
                InputResolutionPolicy = "latest"
            }));
    }

    [Fact]
    public void Catalog_DeclaresExactResultNormalizationAndRejectsDrift()
    {
        Assert.Collection(
            DocumentExportContractCatalog.Normalizations,
            html =>
            {
                Assert.True(html.ByteIdenticalForEqualFrozenInput);
                Assert.Empty(html.NormalizedMetadataFields);
            },
            pdf =>
            {
                Assert.False(pdf.ByteIdenticalForEqualFrozenInput);
                Assert.Contains("creation-date", pdf.NormalizedMetadataFields);
            },
            docx =>
            {
                Assert.False(docx.ByteIdenticalForEqualFrozenInput);
                Assert.Contains("modified", docx.NormalizedMetadataFields);
            },
            epub =>
            {
                Assert.False(epub.ByteIdenticalForEqualFrozenInput);
                Assert.Contains("archive-entry-timestamp", epub.NormalizedMetadataFields);
            });

        DocumentExportNormalizationContract[] drifted = [.. DocumentExportContractCatalog.Normalizations];
        drifted[1] = drifted[1] with
        {
            NormalizedMetadataFields = []
        };
        Assert.Throws<InvalidOperationException>(() => DocumentExportContractValidator.ValidateCatalog(
            DocumentExportContractCatalog.Providers,
            DocumentExportContractCatalog.ExecutionBindings,
            drifted,
            DocumentExportContractCatalog.StaticGovernance));
    }

    [Fact]
    public void StaticGovernance_ContractSliceHasOneRegistryAndNoExecutionOrAlternateParserAuthority()
    {
        string[] sources =
        [
            BackendTestPaths.ReadAllTextFromRoot(
                "src", "backend", "Services", "DocumentExport", "DocumentExportContracts.cs"),
            BackendTestPaths.ReadAllTextFromRoot(
                "src", "backend", "Services", "DocumentExport", "DocumentExportContractValidator.cs"),
            BackendTestPaths.ReadAllTextFromRoot(
                "src", "backend", "Services", "DocumentExport", "DocumentExportDigest.cs")
        ];
        Assert.Equal(
            1,
            sources.Sum(source => source.Split(
                "public static class DocumentExportContractCatalog",
                StringSplitOptions.None).Length - 1));
        Assert.All(sources, source =>
        {
            Assert.DoesNotContain("Process.Start", source, StringComparison.Ordinal);
            Assert.DoesNotContain("ProcessStartInfo", source, StringComparison.Ordinal);
            Assert.DoesNotContain("HttpClient", source, StringComparison.Ordinal);
            Assert.DoesNotContain("GetLatest", source, StringComparison.Ordinal);
            Assert.DoesNotContain("HtmlToMarkdown", source, StringComparison.Ordinal);
            Assert.DoesNotContain("Screenshot", source, StringComparison.Ordinal);
        });
        Assert.All(DocumentExportContractCatalog.ExecutionBindings, binding =>
        {
            Assert.Equal("exact-argv-v1", binding.InvocationPolicy);
            Assert.Equal(["render"], binding.ExactArguments);
            Assert.Equal("prohibited", binding.ShellPolicy);
        });
    }

    [Fact]
    public void ClosedWireBoundaryRejectsUnknownDuplicateWrongCaseAndMissingProperties()
    {
        DocumentExportFrozenInput input = ValidInput();
        byte[] valid = DocumentExportDigest.Serialize(input);
        DocumentExportFrozenInput parsed = DocumentExportDigest.Deserialize<DocumentExportFrozenInput>(valid);
        DocumentExportContractValidator.Validate(parsed);

        string json = Encoding.UTF8.GetString(valid);
        byte[] unknown = Encoding.UTF8.GetBytes(json.Insert(json.Length - 1, ",\"unknown\":true"));
        byte[] duplicate = Encoding.UTF8.GetBytes(
            $"{{\"schema\":\"{DocumentExportContractCatalog.InputSchema}\"," + json[1..]);
        byte[] wrongCase = Encoding.UTF8.GetBytes(json.Replace("\"schema\"", "\"Schema\"", StringComparison.Ordinal));
        JsonObject missingObject = JsonNode.Parse(json)!.AsObject();
        Assert.True(missingObject.Remove("inputId"));
        byte[] missing = Encoding.UTF8.GetBytes(missingObject.ToJsonString());

        Assert.Throws<InvalidDataException>(() => DocumentExportDigest.Deserialize<DocumentExportFrozenInput>(unknown));
        Assert.Throws<InvalidDataException>(() => DocumentExportDigest.Deserialize<DocumentExportFrozenInput>(duplicate));
        Assert.Throws<InvalidDataException>(() => DocumentExportDigest.Deserialize<DocumentExportFrozenInput>(wrongCase));
        Assert.Throws<InvalidDataException>(() => DocumentExportDigest.Deserialize<DocumentExportFrozenInput>(missing));
    }

    [Fact]
    public void ProviderResultContract_BindsInputProviderToolOutputAndRejectsTamper()
    {
        DocumentExportFrozenInput input = ValidInput();
        DocumentExportTask task = ValidTask(input);
        DocumentExportProviderContract provider = DocumentExportContractCatalog.RequireProvider(task.FormatId);
        byte[] output = Encoding.UTF8.GetBytes("<!doctype html>\n<html></html>\n");
        DocumentExportProviderReceipt receipt = DocumentExportContractValidator.Seal(new DocumentExportProviderReceipt(
            DocumentExportContractCatalog.ResultSchema,
            task.ContentDigest,
            input.ContentDigest,
            provider.ProviderId,
            provider.ProviderVersion,
            input.RendererId,
            input.RendererVersion,
            input.RendererDigest,
            input.AssetManifestDigest,
            input.FontManifestDigest,
            input.ReadingStyleAuthorityDigest,
            provider.ToolchainId,
            provider.ToolchainVersion,
            Digest("sandbox-receipt"),
            provider.OutputMediaType,
            provider.OutputExtension,
            provider.NormalizationPolicy,
            DocumentExportDigest.ComputeBytes(output),
            DocumentExportDigest.ComputeBytes(output),
            output.LongLength,
            ["headings"],
            [],
            [],
            DocumentExportProviderResultStatus.Succeeded,
            (long)provider.Delivery.RetentionTtl.TotalSeconds,
            string.Empty));

        DocumentExportContractValidator.Validate(receipt, task, input, provider);
        Assert.Throws<InvalidDataException>(() => DocumentExportContractValidator.Validate(
            receipt with
            {
                OutputBytes = receipt.OutputBytes + 1
            },
            task,
            input,
            provider));
        Assert.Throws<ArgumentException>(() => DocumentExportContractValidator.Validate(
            receipt with
            {
                Schema = "fsusblog.document-export-provider-result.v1"
            },
            task,
            input,
            provider));
    }

    internal static DocumentExportFrozenInput ValidInput(string markdown = "# 标题\n\nHello 🌍")
    {
        byte[] source = Encoding.UTF8.GetBytes(markdown);
        byte[] assetBytes = [137, 80, 78, 71, 13, 10, 26, 10];
        var asset = new DocumentExportAsset(
            "3f3b2e7a-1d2e-4f8a-9c5b-6a7b8c9d0e1f",
            "image/png",
            DocumentExportDigest.ComputeBytes(assetBytes),
            assetBytes.ToImmutableArray(),
            "hero",
            "image",
            string.Empty,
            0,
            "normal");
        DocumentExportAsset[] assets = [asset, .. FontAssets()];
        var input = new DocumentExportFrozenInput(
            DocumentExportContractCatalog.InputSchema,
            "input-0001",
            7,
            11,
            new DocumentExportArticleCoordinate(
                DocumentExportCoordinateKind.Publication,
                42,
                DraftKey: null,
                RevisionId: 101,
                PublicationId: 202,
                SourceVersion: 3),
            source.ToImmutableArray(),
            DocumentExportDigest.ComputeBytes(source),
            Digest("metadata"),
            Digest("properties"),
            DocumentExportContractValidator.ComputeAssetManifestDigest(assets),
            DocumentExportContractValidator.ComputeFontManifestDigest(assets),
            "fsusui.markdown-renderer",
            "current-v1",
            Digest("renderer"),
            "document-reading-v1",
            "light-v1",
            "zh-Hant",
            assets.ToImmutableArray(),
            DocumentExportReadingStyleAuthority.AuthorityDigest,
            string.Empty);
        return DocumentExportContractValidator.Seal(input);
    }

    internal static DocumentExportAsset[] FontAssets()
        => DocumentExportReadingStyleAuthority.RequiredFonts
            .Select((font, index) =>
            {
                byte[] bytes = Encoding.ASCII.GetBytes($"wOF2-test-font-{index}-{font.Family}-{font.Weight}");
                return new DocumentExportAsset(
                    $"font-{index + 1}",
                    "font/woff2",
                    DocumentExportDigest.ComputeBytes(bytes),
                    bytes.ToImmutableArray(),
                    string.Empty,
                    "font",
                    font.Family,
                    font.Weight,
                    font.Style);
            })
            .ToArray();

    private static DocumentExportFrozenInput ResealAssets(
        DocumentExportFrozenInput input,
        IReadOnlyList<DocumentExportAsset> assets)
        => DocumentExportContractValidator.Seal(input with
        {
            Assets = assets.ToImmutableArray(),
            AssetManifestDigest = DocumentExportContractValidator.ComputeAssetManifestDigest(assets),
            FontManifestDigest = DocumentExportContractValidator.ComputeFontManifestDigest(assets),
            ContentDigest = string.Empty
        });

    internal static DocumentExportTask ValidTask(DocumentExportFrozenInput input)
    {
        DocumentExportProviderContract provider = DocumentExportContractCatalog.RequireProvider("self-contained-html");
        return DocumentExportContractValidator.Seal(new DocumentExportTask(
            DocumentExportContractCatalog.TaskSchema,
            "task-0001",
            "request-0001",
            "idempotency-0001",
            input.UserId,
            input.SiteId,
            input.Coordinate,
            input.InputId,
            input.ContentDigest,
            input.SourceDigest,
            input.MetadataDigest,
            input.PropertyDigest,
            input.AssetManifestDigest,
            input.FontManifestDigest,
            input.ReadingStyleAuthorityDigest,
            input.RendererDigest,
            provider.FormatId,
            provider.ProviderId,
            provider.ProviderVersion,
            input.LayoutProfile,
            input.ThemeProfile,
            input.Locale,
            DocumentExportTaskStatus.Queued,
            string.Empty));
    }

    internal static string Digest(string value)
        => DocumentExportDigest.ComputeBytes(Encoding.UTF8.GetBytes(value));
}
