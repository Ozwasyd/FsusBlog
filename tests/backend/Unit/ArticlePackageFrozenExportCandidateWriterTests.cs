using System.Collections;
using System.Collections.Immutable;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.DocumentExport;
using FsusBlog.Shared.Contracts.ArticlePackages;
using FsusBlog.Shared.Contracts.ArticleProperties;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Actual frozen-input, manifest and ZIP component controls; no candidate establishes complete export authority.</summary>
[Trait("Category", "Unit")]
public sealed class ArticlePackageFrozenExportCandidateWriterTests
{
    private const string SiteScope = "https://example.test";
    private static readonly Guid s_definition = Guid.Parse("30000000-0000-4000-8000-000000000001");

    [Theory]
    [InlineData("# 原文\n", false)]
    [InlineData("# 原文 😀 שלום\r\ntrailing  \t\r\n", true)]
    [InlineData("no final newline  ", false)]
    [InlineData("# e\u0301\r\n", false)]
    public void Writer_UsesRealFrozenValidatorAndPreservesExactOriginalMarkdown(string markdown, bool bom)
    {
        ExportFixture fixture = Fixture(markdown: markdown, bom: bom);
        DocumentExportContractValidator.Validate(fixture.Export.Input);
        ArticlePackageManifestCandidatePlan plan = Plan([fixture]);
        ArticlePackageFrozenExportCandidate candidate = Write(plan, [fixture.Export]);
        byte[] archive = candidate.CopyArchiveBytes();
        string path = $"articles/{fixture.Export.PortableArticle.FileNameToken}.md";

        Assert.Equal(fixture.RawBytes, candidate.Candidate.CopyFileBytes(path));
        Assert.Equal(archive.Length, candidate.ArchiveByteLength);
        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(archive)), candidate.ArchiveSha256);
        Assert.True(ArticlePackageImportZipCandidateReader.TryReadCandidate(archive, out var imported).IsValid);
        Assert.Equal(candidate.Candidate.PackageBytesDigest, imported!.Candidate.PackageBytesDigest);
        Assert.Equal(plan.Manifest.SemanticDigest, imported.Candidate.Manifest.SemanticDigest);
        Assert.Single(candidate.SourceBindings);
        Assert.False(candidate.RequireExportAuthority().IsValid);
        Assert.Equal("article_package_export_authority_unavailable", candidate.RequireExportAuthority().ReasonCode);
        Assert.False(plan.RequirePackageAuthority().IsValid);
        Assert.False(imported.RequireArchiveAuthority().IsValid);
    }

    [Theory]
    [InlineData("![unresolved image](https://asset.example.test/not-observed.png)\n")]
    [InlineData("[unresolved article](article:01991e72-9a2c-7b60-8f47-b339f58e4a11)\n")]
    public void Writer_NullFrozenEmbedSlotNeverProvesAbsenceOfDependenciesInRawMarkdown(string markdown)
    {
        ExportFixture fixture = Fixture(markdown: markdown);
        Assert.Null(fixture.Export.Input.FrozenEmbeds);

        ArticlePackageFrozenExportCandidate candidate = Write(Plan([fixture]), [fixture.Export]);

        Assert.Equal(fixture.RawBytes, candidate.Candidate.CopyFileBytes($"articles/{fixture.Export.PortableArticle.FileNameToken}.md"));
        // This component preserves opaque Markdown; it has run no FsusUI parser or dependency provider.
        Assert.False(candidate.RequireExportAuthority().IsValid);
        Assert.Equal("article_package_export_authority_unavailable", candidate.RequireExportAuthority().ReasonCode);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(3)]
    [InlineData(1000)]
    public void Writer_CompleteWholeSetIsOrderedStoredFixedTimeAndContainsNoPresentationFontEntries(int count)
    {
        ExportFixture[] fixtures = Enumerable.Range(1, count).Select(id => Fixture(id)).ToArray();
        ArticlePackageFrozenExportCandidate candidate = Write(Plan(fixtures), fixtures.Select(fixture => fixture.Export).Reverse().ToArray());
        using var memory = new MemoryStream(candidate.CopyArchiveBytes(), writable: false);
        using var zip = new ZipArchive(memory, ZipArchiveMode.Read);

        Assert.Equal(count, candidate.Candidate.Manifest.Articles.Count);
        Assert.Equal(count, candidate.SourceBindings.Count);
        Assert.Equal(count + 2, zip.Entries.Count);
        Assert.Equal(zip.Entries.Select(entry => entry.FullName).Order(StringComparer.Ordinal), zip.Entries.Select(entry => entry.FullName));
        Assert.All(zip.Entries, entry =>
        {
            Assert.Equal(entry.Length, entry.CompressedLength);
            Assert.Equal(new DateTime(1980, 1, 1), entry.LastWriteTime.DateTime);
            Assert.Equal(0, entry.ExternalAttributes & 0x418);
        });
        Assert.DoesNotContain(candidate.Candidate.FilePaths, path => path.StartsWith("assets/", StringComparison.Ordinal));
        Assert.False(candidate.RequireExportAuthority().IsValid);
    }

    [Fact]
    public void Writer_ReorderingAndRepeatedCallsProduceIdenticalArchiveBytes()
    {
        ExportFixture[] fixtures = [Fixture(1), Fixture(2), Fixture(3)];
        ArticlePackageManifestCandidatePlan plan = Plan(fixtures);
        ArticlePackageFrozenExportCandidate first = Write(plan, fixtures.Select(fixture => fixture.Export).ToArray());
        ArticlePackageFrozenExportCandidate reverse = Write(plan, fixtures.Select(fixture => fixture.Export).Reverse().ToArray());

        Assert.Equal(first.CopyArchiveBytes(), reverse.CopyArchiveBytes());
        Assert.Equal(first.ArchiveSha256, reverse.ArchiveSha256);
        Assert.Equal(first.Candidate.PackageBytesDigest, reverse.Candidate.PackageBytesDigest);
        Assert.Equal(first.CopyArchiveBytes(), Write(plan, fixtures.Select(fixture => fixture.Export).ToArray()).CopyArchiveBytes());
    }

    [Fact]
    public void Writer_ReusesActualTypedPropertyProjectionWithoutTreatingDocumentPropertyHashAsThatDomain()
    {
        ExportFixture fixture = Fixture(property: true);
        ArticlePackageManifestCandidatePlan plan = Plan([fixture]);
        ArticlePackageFrozenExportCandidate candidate = Write(plan, [fixture.Export]);

        Assert.Single(plan.Articles[0].Properties.Properties);
        Assert.True(ArticlePackagePropertyMapper.ValidateCandidate(fixture.Manifest.PropertySnapshot,
            fixture.Manifest.PropertyBindings, plan.Articles[0].Properties).IsValid);
        Assert.Equal(plan.Articles[0].Properties.MappingDigest, candidate.Candidate.Manifest.Articles[0].PropertyMappingDigest);
        Assert.NotEqual(fixture.Export.Input.PropertyDigest, candidate.Candidate.Manifest.Articles[0].PropertyMappingDigest);
    }

    [Fact]
    public void Writer_PreservesOriginalTypedDocumentBindingsWithoutEquatingSourceDomains()
    {
        ExportFixture fixture = Fixture(property: true);
        ArticlePackageManifestCandidatePlan plan = Plan([fixture]);
        DocumentExportFrozenInput original = fixture.Export.Input;
        DocumentExportFrozenInput changed = DocumentExportContractValidator.Seal(original with
        {
            InputId = "other-frozen-input",
            UserId = 8,
            Coordinate = original.Coordinate with
            {
                SourceVersion = 999
            },
            MetadataDigest = Digest("other-source-metadata"),
            PropertyDigest = Digest("other-source-properties")
        });
        DocumentExportContractValidator.Validate(changed);
        ArticlePackageFrozenExportCandidate first = Write(plan, [fixture.Export]);
        ArticlePackageFrozenExportCandidate second = Write(plan, [fixture.Export with { Input = changed }]);
        ArticlePackageFrozenExportSourceBinding binding = Assert.Single(second.SourceBindings);

        Assert.Equal(new ArticlePackageFrozenExportSourceBinding(fixture.Export.PortableArticle,
            changed.InputId, changed.ContentDigest, changed.UserId, changed.SiteScope, changed.Coordinate.SourceVersion,
            changed.SourceDigest, changed.MetadataDigest, changed.PropertyDigest, changed.AssetManifestDigest,
            changed.FontManifestDigest, changed.RendererDigest, changed.ReadingStyleAuthorityDigest), binding);
        Assert.NotEqual(Assert.Single(first.SourceBindings), binding);
        Assert.NotEqual(plan.Manifest.Articles[0].Source.RevisionNo, binding.SourceVersion);
        Assert.NotEqual(fixture.Manifest.PropertySnapshot.Coordinates.DefinitionOwnerUserId, binding.UserId);
        Assert.Equal(first.CopyArchiveBytes(), second.CopyArchiveBytes());
        Assert.False(second.RequireExportAuthority().IsValid);
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("empty")]
    [InlineData("extra")]
    [InlineData("duplicate")]
    [InlineData("unknown")]
    [InlineData("default-identity")]
    [InlineData("null-row")]
    [InlineData("null-input")]
    public void Writer_RejectsIncompleteAliasedAndInvalidInputBijections(string fault)
    {
        ExportFixture[] fixtures = [Fixture(1), Fixture(2)];
        ArticlePackageFrozenExportCandidateInput first = fixtures[0].Export;
        ArticlePackageFrozenExportCandidateInput second = fixtures[1].Export;
        IReadOnlyList<ArticlePackageFrozenExportCandidateInput>? changed = fault switch
        {
            "missing" => null,
            "empty" => [],
            "extra" => [first, second, Fixture(3).Export],
            "duplicate" => [first, first],
            "unknown" => [first, second with { PortableArticle = Identity(3) }],
            "default-identity" => [first, second with { PortableArticle = default }],
            "null-row" => [first, null!],
            _ => [first, second with { Input = null! }]
        };

        Reject(Plan(fixtures), changed);
    }

    [Theory]
    [InlineData("article")]
    [InlineData("revision")]
    [InlineData("site")]
    [InlineData("raw-markdown")]
    [InlineData("malformed-source")]
    public void Writer_RejectsSelfConsistentFrozenSourceDriftAgainstThePlan(string fault)
    {
        ExportFixture fixture = Fixture();
        DocumentExportFrozenInput source = fixture.Export.Input;
        byte[] raw = fault switch
        {
            "raw-markdown" => Encoding.UTF8.GetBytes("different source\r\n"),
            "malformed-source" => [0xff],
            _ => fixture.RawBytes
        };
        DocumentExportFrozenInput changed = DocumentExportContractValidator.Seal(source with
        {
            Coordinate = source.Coordinate with
            {
                ArticleId = fault == "article" ? source.Coordinate.ArticleId + 1 : source.Coordinate.ArticleId,
                RevisionId = fault == "revision" ? source.Coordinate.RevisionId + 1 : source.Coordinate.RevisionId
            },
            SiteScope = fault == "site" ? "https://other.example.test" : source.SiteScope,
            MarkdownUtf8 = raw.ToImmutableArray(),
            SourceDigest = DocumentExportDigest.ComputeBytes(raw)
        });
        DocumentExportContractValidator.Validate(changed);

        Reject(Plan([fixture]), [fixture.Export with { Input = changed }], "article_package_export_source_binding_mismatch");
    }

    [Theory]
    [InlineData("line-endings")]
    [InlineData("unicode-normalization")]
    public void Writer_CanonicalNormalizationEqualityCannotSubstituteForFrozenRawByteEquality(string variant)
    {
        ExportFixture fixture = Fixture(markdown: "# caf\u00e9\nexact\n");
        string alternate = variant == "line-endings" ? "# caf\u00e9\r\nexact\r\n" : "# cafe\u0301\nexact\n";
        ArticleCanonicalInput normalizedVariant = fixture.Manifest.Article with
        {
            MarkdownContent = alternate
        };
        Assert.Equal(fixture.Manifest.TitleBinding.SourceCanonicalHash, ArticleCanonicalHashV1.ComputeHashHex(normalizedVariant));
        byte[] raw = Encoding.UTF8.GetBytes(alternate);
        DocumentExportFrozenInput changed = DocumentExportContractValidator.Seal(fixture.Export.Input with
        {
            MarkdownUtf8 = raw.ToImmutableArray(),
            SourceDigest = DocumentExportDigest.ComputeBytes(raw)
        });
        DocumentExportContractValidator.Validate(changed);
        Assert.NotEqual(fixture.Export.Input.SourceDigest, changed.SourceDigest);

        Reject(Plan([fixture]), [fixture.Export with { Input = changed }], "article_package_export_source_binding_mismatch");
    }

    [Theory]
    [InlineData("draft")]
    [InlineData("publication")]
    public void Writer_RejectsOtherActualFrozenCoordinateKindsWithoutInventingRevisionMapping(string kind)
    {
        ExportFixture fixture = Fixture();
        DocumentExportArticleCoordinate coordinate = kind == "draft"
            ? new(DocumentExportCoordinateKind.Draft, fixture.Export.Input.Coordinate.ArticleId, "draft-explicit", null, null, 3)
            : new(DocumentExportCoordinateKind.Publication, fixture.Export.Input.Coordinate.ArticleId, null,
                fixture.Export.Input.Coordinate.RevisionId, 999, 3);
        DocumentExportFrozenInput changed = DocumentExportContractValidator.Seal(fixture.Export.Input with
        {
            Coordinate = coordinate
        });
        DocumentExportContractValidator.Validate(changed);

        Reject(Plan([fixture]), [fixture.Export with { Input = changed }], "article_package_export_coordinate_unavailable");
    }

    [Theory]
    [InlineData("schema")]
    [InlineData("source-digest")]
    [InlineData("content-digest")]
    [InlineData("metadata-digest")]
    [InlineData("property-digest")]
    [InlineData("renderer-digest")]
    [InlineData("reading-authority")]
    [InlineData("font-manifest")]
    [InlineData("asset-manifest")]
    [InlineData("copied-content-after-renderer")]
    [InlineData("missing-font")]
    [InlineData("empty-source")]
    [InlineData("zero-source-version")]
    public void Writer_RejectsMalformedOrUnsealedFrozenInputsInsteadOfRepairingTheirClaims(string fault)
    {
        ExportFixture fixture = Fixture();
        DocumentExportFrozenInput source = fixture.Export.Input;
        DocumentExportFrozenInput changed = fault switch
        {
            "schema" => source with { Schema = "unknown-v1" },
            "source-digest" => source with { SourceDigest = new string('0', 64) },
            "content-digest" => source with { ContentDigest = new string('0', 64) },
            "metadata-digest" => source with { MetadataDigest = "bad" },
            "property-digest" => source with { PropertyDigest = "bad" },
            "renderer-digest" => source with { RendererDigest = "bad" },
            "reading-authority" => source with { ReadingStyleAuthorityDigest = new string('0', 64) },
            "font-manifest" => source with { FontManifestDigest = new string('0', 64) },
            "asset-manifest" => source with { AssetManifestDigest = new string('0', 64) },
            "copied-content-after-renderer" => source with { RendererVersion = "changed-renderer-version" },
            "missing-font" => source with { Assets = source.Assets.RemoveAt(0) },
            "empty-source" => source with { MarkdownUtf8 = [] },
            _ => source with { Coordinate = source.Coordinate with { SourceVersion = 0 } }
        };

        Reject(Plan([fixture]), [fixture.Export with { Input = changed }]);
        Assert.Equal(source.ContentDigest, Write(Plan([fixture]), [fixture.Export]).SourceBindings[0].FrozenInputContentDigest);
    }

    [Fact]
    public void Writer_RejectsActuallyValidNonfontAssetsInsteadOfSilentlyDroppingThem()
    {
        ExportFixture fixture = Fixture();
        byte[] imageBytes = [137, 80, 78, 71, 13, 10, 26, 10];
        var image = new DocumentExportAsset("image-explicit", "image/png", DocumentExportDigest.ComputeBytes(imageBytes),
            imageBytes.ToImmutableArray(), "original alt text", "image", string.Empty, 0, "normal");
        DocumentExportFrozenInput changed = WithAssets(fixture.Export.Input, [.. fixture.Export.Input.Assets, image]);
        DocumentExportContractValidator.Validate(changed);

        Reject(Plan([fixture]), [fixture.Export with { Input = changed }], "article_package_manifest_assets_authority_unavailable");
    }

    [Fact]
    public void Writer_RealDocumentValidatorRejectsResealedInvalidPresentationFontBytes()
    {
        ExportFixture fixture = Fixture();
        DocumentExportAsset[] assets = fixture.Export.Input.Assets.ToArray();
        byte[] wrongSignature = "not-a-woff2-font"u8.ToArray();
        assets[0] = assets[0] with
        {
            Bytes = wrongSignature.ToImmutableArray(),
            Sha256 = DocumentExportDigest.ComputeBytes(wrongSignature)
        };
        DocumentExportFrozenInput changed = WithAssets(fixture.Export.Input, assets);
        Assert.Throws<InvalidDataException>(() => DocumentExportContractValidator.Validate(changed));

        Reject(Plan([fixture]), [fixture.Export with { Input = changed }], "article_package_export_input_invalid");
    }

    [Fact]
    public void Writer_RejectsAnyNonnullFrozenEmbedSlotBeforeRepresentingUnavailableDependencySchema()
    {
        ExportFixture fixture = Fixture();
        var explicitUnsupported = new DocumentExportFrozenEmbeds(new string('a', 64), null!, null!, []);
        DocumentExportFrozenInput changed = fixture.Export.Input with
        {
            FrozenEmbeds = explicitUnsupported
        };

        Reject(Plan([fixture]), [fixture.Export with { Input = changed }], "article_package_export_dependency_schema_unavailable");
    }

    [Fact]
    public void Writer_OwnsArchiveAndReadonlyBindingsAfterCallerCollectionsAndReturnedCopiesChange()
    {
        ExportFixture fixture = Fixture();
        ArticlePackageFrozenExportCandidateInput[] caller = [fixture.Export];
        ArticlePackageFrozenExportCandidate candidate = Write(Plan([fixture]), caller);
        byte[] original = candidate.CopyArchiveBytes();
        string digest = candidate.ArchiveSha256;
        caller[0] = Fixture(2).Export;
        byte[] copy = candidate.CopyArchiveBytes();
        Array.Fill(copy, (byte)0);
        byte[] returned = candidate.Candidate.CopyFileBytes($"articles/{fixture.Export.PortableArticle.FileNameToken}.md");
        Array.Fill(returned, (byte)0);

        Assert.Equal(original, candidate.CopyArchiveBytes());
        Assert.Equal(digest, candidate.ArchiveSha256);
        Assert.Equal(fixture.RawBytes, candidate.Candidate.CopyFileBytes($"articles/{fixture.Export.PortableArticle.FileNameToken}.md"));
        Assert.Throws<NotSupportedException>(() => ((IList)candidate.SourceBindings).Clear());
        Assert.False(candidate.RequireExportAuthority().IsValid);
    }

    [Fact]
    public void Writer_FreezesActualAliasedMarkdownAndFontBuffersAndRefusesTheirLaterDrift()
    {
        ExportFixture fixture = Fixture();
        ArticlePackageManifestCandidatePlan plan = Plan([fixture]);
        byte[] raw = (byte[])fixture.RawBytes.Clone();
        byte[] font = fixture.Export.Input.Assets[0].Bytes.ToArray();
        DocumentExportAsset[] assets = fixture.Export.Input.Assets.ToArray();
        assets[0] = assets[0] with
        {
            Bytes = ImmutableCollectionsMarshal.AsImmutableArray(font)
        };
        DocumentExportFrozenInput aliased = fixture.Export.Input with
        {
            MarkdownUtf8 = ImmutableCollectionsMarshal.AsImmutableArray(raw),
            Assets = assets.ToImmutableArray()
        };
        DocumentExportContractValidator.Validate(aliased);
        ArticlePackageFrozenExportCandidateInput input = fixture.Export with
        {
            Input = aliased
        };
        ArticlePackageFrozenExportCandidate candidate = Write(plan, [input]);
        byte[] archive = candidate.CopyArchiveBytes();
        raw[0] ^= 1;
        font[^1] ^= 1;

        Assert.Equal(archive, candidate.CopyArchiveBytes());
        Assert.Equal(fixture.Export.Input.ContentDigest, candidate.SourceBindings[0].FrozenInputContentDigest);
        Reject(plan, [input]);
        raw[0] ^= 1;
        font[^1] ^= 1;
        Assert.Equal(archive, Write(plan, [input]).CopyArchiveBytes());
    }

    [Fact]
    public void Writer_GlobalFontByteBudgetRejectsIndividuallyValidatedInputsWithoutReturningSubset()
    {
        ExportFixture[] fixtures = [Fixture(1), Fixture(2), Fixture(3)];
        ArticlePackageFrozenExportCandidateInput[] inputs = LargeFontInputs(fixtures);

        Reject(Plan(fixtures), inputs, "article_package_export_byte_budget_exceeded");
        Assert.Single(Write(Plan([fixtures[0]]), [fixtures[0].Export]).SourceBindings);
    }

    [Fact]
    public void Writer_FreezesFontRowsAtBudgetAdmissionAndRejectsLaterRestorationOfUnbudgetedBytes()
    {
        ExportFixture[] fixtures = [Fixture(1), Fixture(2), Fixture(3)];
        ArticlePackageFrozenExportCandidateInput[] large = LargeFontInputs(fixtures);
        DocumentExportAsset[][] rows = new DocumentExportAsset[large.Length][];
        DocumentExportAsset[] originalLarge = new DocumentExportAsset[large.Length];
        ArticlePackageFrozenExportCandidateInput[] aliases = new ArticlePackageFrozenExportCandidateInput[large.Length];
        for (int index = 0; index < large.Length; index++)
        {
            rows[index] = large[index].Input.Assets.ToArray();
            originalLarge[index] = rows[index][0];
            DocumentExportFrozenInput alias = large[index].Input with
            {
                Assets = ImmutableCollectionsMarshal.AsImmutableArray(rows[index])
            };
            DocumentExportContractValidator.Validate(alias);
            aliases[index] = large[index] with
            {
                Input = alias
            };
            // Keep the original large-input seal. Only the caller-owned row array is changed.
            rows[index][0] = fixtures[index].Export.Input.Assets[0];
        }
        var caller = new IndexOnlyInputs(aliases, 3, 3, onIndex: index =>
        {
            if (index == 2)
            {
                // Earlier rows have already been budgeted as tiny fonts. Restore all original
                // individually valid 24-MiB rows before the writer can validate or seal them.
                for (int item = 0; item < rows.Length; item++)
                {
                    rows[item][0] = originalLarge[item];
                }
            }
        });

        Reject(Plan(fixtures), caller, "article_package_export_input_invalid");
        Assert.Equal(1, caller.CountReads);
        Assert.Equal(3, caller.IndexReads);
        Assert.Equal(0, caller.EnumeratorReads);
        Assert.Single(Write(Plan([fixtures[0]]), [fixtures[0].Export]).SourceBindings);
    }

    [Theory]
    [InlineData("count", false)]
    [InlineData("count", true)]
    [InlineData("index", false)]
    [InlineData("index", true)]
    public void Writer_ForeignCollectionFailuresRemainFixedInputErrorsWithoutEscapingExceptions(string location, bool ioFailure)
    {
        ExportFixture fixture = Fixture();
        var caller = new ForeignFailingInputs(fixture.Export, location == "count", ioFailure);

        Reject(Plan([fixture]), caller, "article_package_export_input_invalid");
        Assert.Equal(1, caller.CountReads);
        Assert.Equal(location == "count" ? 0 : 1, caller.IndexReads);
        Assert.Equal(0, caller.EnumeratorReads);
        Assert.Single(Write(Plan([fixture]), [fixture.Export]).SourceBindings);
    }

    [Fact]
    public void Writer_ReadsCallerCountOnceAndNeverEnumerates()
    {
        ExportFixture[] fixtures = [Fixture(1), Fixture(2)];
        var inputs = new IndexOnlyInputs(fixtures.Select(fixture => fixture.Export).ToArray(), 2, 1001);
        ArticlePackageFrozenExportCandidate candidate = Write(Plan(fixtures), inputs);

        Assert.Equal(2, candidate.SourceBindings.Count);
        Assert.Equal(1, inputs.CountReads);
        Assert.Equal(2, inputs.IndexReads);
        Assert.Equal(0, inputs.EnumeratorReads);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(0)]
    [InlineData(1001)]
    public void Writer_RejectsInputCountBeforeAccessingAnyRow(int count)
    {
        ExportFixture fixture = Fixture();
        var inputs = new IndexOnlyInputs([], count, 1);

        Reject(Plan([fixture]), inputs);
        Assert.Equal(1, inputs.CountReads);
        Assert.Equal(0, inputs.IndexReads);
        Assert.Equal(0, inputs.EnumeratorReads);
    }

    [Fact]
    public void Writer_RejectsAssetCountBeforeSealingOrReadingAssetBytes()
    {
        ExportFixture fixture = Fixture();
        DocumentExportFrozenInput changed = fixture.Export.Input with
        {
            Assets = Enumerable.Repeat(fixture.Export.Input.Assets[0], 257).ToImmutableArray()
        };

        Reject(Plan([fixture]), [fixture.Export with { Input = changed }], "article_package_export_byte_budget_exceeded");
    }

    [Fact]
    public void Writer_PrecancelAndCancellationDuringBoundedCopyReturnNoPartialCandidate()
    {
        ExportFixture[] fixtures = [Fixture(1), Fixture(2)];
        ArticlePackageManifestCandidatePlan plan = Plan(fixtures);
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        ArticlePackageManifestCandidateResult result = ArticlePackageFrozenExportCandidateWriter.TryWriteCandidate(plan,
            fixtures.Select(fixture => fixture.Export).ToArray(), out var candidate, cancelled.Token);
        Assert.False(result.IsValid);
        Assert.Equal("article_package_export_cancelled", result.ReasonCode);
        Assert.Null(candidate);
        using var during = new CancellationTokenSource();
        var inputs = new IndexOnlyInputs(fixtures.Select(fixture => fixture.Export).ToArray(), 2, 2, callback: during.Cancel);
        result = ArticlePackageFrozenExportCandidateWriter.TryWriteCandidate(plan, inputs, out candidate, during.Token);
        Assert.False(result.IsValid);
        Assert.Equal("article_package_export_cancelled", result.ReasonCode);
        Assert.Null(candidate);
        Assert.Equal(0, inputs.EnumeratorReads);
    }

    [Fact]
    public void Writer_LateFailureAndIndexFailureNeverYieldPartialArchiveAndLaterAttemptIsStable()
    {
        ExportFixture[] fixtures = [Fixture(1), Fixture(2)];
        ArticlePackageManifestCandidatePlan plan = Plan(fixtures);
        ArticlePackageFrozenExportCandidateInput[] valid = fixtures.Select(fixture => fixture.Export).ToArray();
        byte[] original = Write(plan, valid).CopyArchiveBytes();
        var broken = fixtures[1].Export with
        {
            Input = fixtures[1].Export.Input with
            {
                ContentDigest = new string('0', 64)
            }
        };
        for (int attempt = 0; attempt < 2; attempt++)
        {
            Reject(plan, [valid[0], broken]);
            Reject(plan, [broken, valid[0]]);
            var indexes = new IndexOnlyInputs(valid, 2, 2, failIndex: 1);
            Reject(plan, indexes);
            Assert.Equal(0, indexes.EnumeratorReads);
            Assert.Equal(original, Write(plan, valid).CopyArchiveBytes());
        }
        Reject(null, valid);
        Reject(plan, null);
    }

    private static ArticlePackageFrozenExportCandidate Write(ArticlePackageManifestCandidatePlan plan,
        IReadOnlyList<ArticlePackageFrozenExportCandidateInput> inputs)
    {
        ArticlePackageManifestCandidateResult result = ArticlePackageFrozenExportCandidateWriter.TryWriteCandidate(plan, inputs, out var candidate);
        Assert.True(result.IsValid, result.ReasonCode);
        return Assert.IsType<ArticlePackageFrozenExportCandidate>(candidate);
    }

    private static void Reject(ArticlePackageManifestCandidatePlan? plan, IReadOnlyList<ArticlePackageFrozenExportCandidateInput>? inputs,
        string? reason = null)
    {
        ArticlePackageManifestCandidateResult result = ArticlePackageFrozenExportCandidateWriter.TryWriteCandidate(plan, inputs, out var candidate);
        Assert.False(result.IsValid);
        Assert.False(string.IsNullOrWhiteSpace(result.ReasonCode));
        if (reason is not null)
        {
            Assert.Equal(reason, result.ReasonCode);
        }
        Assert.Null(candidate);
    }

    private static ArticlePackageManifestCandidatePlan Plan(IReadOnlyList<ExportFixture> fixtures)
    {
        ArticlePackageManifestCandidateResult result = ArticlePackageManifestCandidatePlanner.TryCreateCandidatePlan(
            fixtures.Select(fixture => fixture.Manifest).ToArray(), out var plan);
        Assert.True(result.IsValid, result.ReasonCode);
        return Assert.IsType<ArticlePackageManifestCandidatePlan>(plan);
    }

    private static ExportFixture Fixture(int id = 42, string markdown = "# original\r\nexact  \t\r\n", bool bom = false, bool property = false)
    {
        byte[] raw = Encoding.UTF8.GetBytes(markdown);
        if (bom)
        {
            raw = [0xef, 0xbb, 0xbf, .. raw];
        }
        long revision = 1000 + id;
        var article = new ArticleCanonicalInput(id, revision, 3, "route", "Raw title e\u0301 😀", null, null, 1, [], 0, null, null, markdown);
        ArticlePackageIdentity identity = Identity(id);
        var title = new ArticlePackageTitleSummaryBinding(id, revision, 3, ArticleCanonicalHashV1.ComputeHashHex(article), identity);
        var coordinates = new ArticlePropertySnapshotCoordinates(7, SiteScope, id, 1, revision);
        ArticlePropertyValueEntry[] values = [];
        ArticlePackagePropertyDefinitionBinding[] definitions = [];
        if (property)
        {
            string definitionDigest = new('a', 64);
            var value = new ArticlePropertyValueInput(s_definition, 1, definitionDigest, ArticlePropertyValuePresence.Present,
                new ArticlePropertyBooleanValue(false));
            values = [new(s_definition, 1, definitionDigest, value.Presence, value.Value, ArticlePropertyValueDigest.ComputeValue(value))];
            Assert.True(ArticlePackageIdentity.TryCreate(ArticlePackageIdentityKind.Definition,
                "portable-definition:30000000-0000-4000-8000-000000000001", out var definition).IsValid);
            definitions = [new(s_definition, 1, definitionDigest, definition)];
        }
        var snapshot = new ArticlePropertyValueSnapshot(1, coordinates, values, ArticlePropertyValueDigest.ComputeSnapshot(coordinates, values));
        var bindings = new ArticlePackagePropertyMappingBindings(coordinates, snapshot.ContentDigest, definitions, [], []);
        var manifest = new ArticlePackageManifestCandidateInput(article, title, snapshot, bindings, raw);
        DocumentExportAsset[] assets = FontAssets();
        var document = new DocumentExportFrozenInput(DocumentExportContractCatalog.InputSchema, $"frozen-input-{id}", 7, SiteScope,
            new(DocumentExportCoordinateKind.Revision, id, null, revision, null, 3), raw.ToImmutableArray(),
            DocumentExportDigest.ComputeBytes(raw), Digest("source-metadata"),
            Digest("source-properties"), DocumentExportContractValidator.ComputeAssetManifestDigest(assets),
            DocumentExportContractValidator.ComputeFontManifestDigest(assets), "fsusui.markdown-renderer", "current-v1",
            Digest("renderer"), DocumentExportReadingStyleAuthority.LayoutProfile,
            DocumentExportReadingStyleAuthority.LightThemeProfile, "zh-Hant", assets.ToImmutableArray(),
            DocumentExportReadingStyleAuthority.AuthorityDigest, null, string.Empty);
        document = DocumentExportContractValidator.Seal(document);
        DocumentExportContractValidator.Validate(document);
        return new(manifest, new ArticlePackageFrozenExportCandidateInput(identity, document), raw);
    }

    // The canonical document contract's declared-font fixture exercises its real digest and
    // closure validation. These bytes establish no native font renderer or permission receipt.
    private static DocumentExportAsset[] FontAssets()
        => DocumentExportReadingStyleAuthority.RequiredFonts.Select((font, index) =>
        {
            byte[] bytes = Encoding.ASCII.GetBytes($"wOF2-test-font-{index}-{font.Family}-{font.Weight}");
            return new DocumentExportAsset($"font-{index + 1}", "font/woff2", DocumentExportDigest.ComputeBytes(bytes),
                bytes.ToImmutableArray(), string.Empty, "font", font.Family, font.Weight, font.Style);
        }).ToArray();

    private static string Digest(string value)
        => DocumentExportDigest.ComputeBytes(Encoding.UTF8.GetBytes(value));

    private static ArticlePackageFrozenExportCandidateInput[] LargeFontInputs(IReadOnlyList<ExportFixture> fixtures)
    {
        byte[] fontBytes = new byte[24 * 1024 * 1024];
        "wOF2"u8.CopyTo(fontBytes);
        ImmutableArray<byte> font = ImmutableCollectionsMarshal.AsImmutableArray(fontBytes);
        string digest = DocumentExportDigest.ComputeBytes(fontBytes);
        return fixtures.Select(fixture =>
        {
            DocumentExportAsset[] assets = fixture.Export.Input.Assets.ToArray();
            assets[0] = assets[0] with
            {
                Bytes = font,
                Sha256 = digest
            };
            DocumentExportFrozenInput document = WithAssets(fixture.Export.Input, assets);
            DocumentExportContractValidator.Validate(document);
            return fixture.Export with
            {
                Input = document
            };
        }).ToArray();
    }

    private static DocumentExportFrozenInput WithAssets(DocumentExportFrozenInput source, IReadOnlyList<DocumentExportAsset> assets)
        => DocumentExportContractValidator.Seal(source with
        {
            Assets = assets.ToImmutableArray(),
            AssetManifestDigest = DocumentExportContractValidator.ComputeAssetManifestDigest(assets),
            FontManifestDigest = DocumentExportContractValidator.ComputeFontManifestDigest(assets)
        });

    private static ArticlePackageIdentity Identity(int id)
    {
        Assert.True(ArticlePackageIdentity.TryCreate(ArticlePackageIdentityKind.Article,
            $"article:{id:x8}-0000-4000-8000-000000000001", out var identity).IsValid);
        return identity;
    }

    private sealed record ExportFixture(ArticlePackageManifestCandidateInput Manifest, ArticlePackageFrozenExportCandidateInput Export, byte[] RawBytes);

    private sealed class ForeignFailingInputs(ArticlePackageFrozenExportCandidateInput input, bool failCount,
        bool ioFailure) : IReadOnlyList<ArticlePackageFrozenExportCandidateInput>
    {
        public int CountReads
        {
            get;
            private set;
        }
        public int IndexReads
        {
            get;
            private set;
        }
        public int EnumeratorReads
        {
            get;
            private set;
        }
        public int Count
        {
            get
            {
                CountReads++;
                if (failCount)
                {
                    ThrowFailure();
                }
                return 1;
            }
        }
        public ArticlePackageFrozenExportCandidateInput this[int index]
        {
            get
            {
                IndexReads++;
                ThrowFailure();
                return input;
            }
        }
        private void ThrowFailure()
        {
            Exception error = ioFailure ? new IOException("private caller I/O diagnostic")
                : new InvalidOperationException("private caller collection diagnostic");
            throw error;
        }
        public IEnumerator<ArticlePackageFrozenExportCandidateInput> GetEnumerator()
        {
            EnumeratorReads++;
            throw new InvalidOperationException("Caller collection must never be enumerated.");
        }
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }

    private sealed class IndexOnlyInputs(ArticlePackageFrozenExportCandidateInput[] values, int firstCount, int laterCount,
        int failIndex = -1, Action? callback = null, Action<int>? onIndex = null) : IReadOnlyList<ArticlePackageFrozenExportCandidateInput>
    {
        public int CountReads
        {
            get;
            private set;
        }
        public int IndexReads
        {
            get;
            private set;
        }
        public int EnumeratorReads
        {
            get;
            private set;
        }
        public int Count
        {
            get
            {
                CountReads++;
                int countReads = CountReads;
                return countReads == 1 ? firstCount : laterCount;
            }
        }
        public ArticlePackageFrozenExportCandidateInput this[int index]
        {
            get
            {
                IndexReads++;
                if (index == failIndex)
                {
                    throw new IndexOutOfRangeException();
                }
                ArticlePackageFrozenExportCandidateInput value = values[index];
                onIndex?.Invoke(index);
                if (index == 0)
                {
                    callback?.Invoke();
                }
                return value;
            }
        }
        public IEnumerator<ArticlePackageFrozenExportCandidateInput> GetEnumerator()
        {
            EnumeratorReads++;
            throw new InvalidOperationException("Caller frozen inputs must use bounded index copy.");
        }
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }
}
