using System.Buffers;
using System.Buffers.Binary;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticlePackages;
using FsusBlog.Shared.Contracts.ArticleRelations;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticlePackageImportAssetCandidateTests
{
    [Theory]
    [InlineData(CompressionLevel.NoCompression)]
    [InlineData(CompressionLevel.Optimal)]
    public void ActualAssetBytesAndSharedEdgesSurviveByteAndZipPathsWithoutGrantingAuthority(CompressionLevel compression)
    {
        Package package = CreatePackage();
        Assert.True(ArticlePackageImportAssetCandidateValidator.Validate(
            package.Bytes.Inventory, package.Bytes.Files, package.Assets, out var bytes).IsValid);
        Archive archive = CreateArchive(package, compression);
        Assert.True(ArticlePackageImportAssetCandidateValidator.TryReadCandidate(
            archive.Bytes, archive.Assets, out var zip).IsValid);

        Assert.Equal(2, bytes!.Manifest.SchemaVersion);
        Assert.Equal(2, bytes.Manifest.Articles.Count);
        Assert.Single(bytes.Manifest.Assets!.Assets);
        Assert.Equal(2, bytes.Manifest.Assets.References.Count);
        Assert.Equal(bytes.PackageBytesDigest, zip!.Candidate.PackageBytesDigest);
        Assert.Equal(bytes.ChecksumComponentDigest, zip.Candidate.ChecksumComponentDigest);
        Assert.Equal(bytes.Manifest.SemanticDigest, zip.Candidate.Manifest.SemanticDigest);
        Assert.Equal(Hash(archive.Bytes), zip.ArchiveSha256);
        Assert.Equal(archive.Bytes.Length, zip.ArchiveByteLength);
        foreach (ArticlePackageFileBytes file in package.Bytes.Files)
        {
            Assert.Equal(file.Bytes.ToArray(), bytes.CopyFileBytes(file.Path));
            Assert.Equal(file.Bytes.ToArray(), zip.Candidate.CopyFileBytes(file.Path));
        }
        string assetPath = package.Metadata[0].PackagePath;
        byte[] expected = bytes.CopyFileBytes(assetPath);
        byte[] exposed = zip.Candidate.CopyFileBytes(assetPath);
        Array.Fill(exposed, (byte)0);
        Array.Fill(archive.Bytes, (byte)0);
        Array.Fill(package.Bytes.Buffers.Single(buffer => buffer.SequenceEqual(expected)), (byte)0);
        Assert.Equal(expected, bytes.CopyFileBytes(assetPath));
        Assert.Equal(expected, zip.Candidate.CopyFileBytes(assetPath));
        Assert.False(zip.RequireArchiveAuthority().IsValid);
        Assert.Equal("article_package_zip_authority_unavailable", zip.RequireArchiveAuthority().ReasonCode);
        Assert.False(bytes.Manifest.Assets.RequireAssetAuthority().IsValid);
        Assert.All(bytes.Manifest.Assets.Assets, asset => Assert.False(asset.RequireAssetAuthority().IsValid));
        var request = new ArticlePackageImportCandidateRequest(
            new ArticleRelationActorContext("actor:importer", "site:primary", new string('a', 64)),
            ArticlePackageImportCandidateMode.CreateNew, new string('b', 64),
            new(2026, 10, 8, 1, 0, 0, DateTimeKind.Utc), new(2026, 10, 8, 2, 0, 0, DateTimeKind.Utc), null);
        Assert.True(ArticlePackageImportCandidatePlanner.TryCreatePlan(bytes, request, out var plan).IsValid);
        Assert.False(plan!.RequireExecutionAuthority().IsValid);
        Assert.Equal("article_package_import_authority_unavailable", plan.RequireExecutionAuthority().ReasonCode);
    }

    [Fact]
    public void ExplicitEmptyV2IsDistinctFromNullAndLegacyAndOldEntrypointsStillRefuseAssets()
    {
        Package package = CreatePackage(assetCount: 0);
        Assert.True(ArticlePackageImportAssetCandidateValidator.Validate(
            package.Bytes.Inventory, package.Bytes.Files, package.Assets, out var empty).IsValid);
        Assert.NotNull(empty!.Manifest.Assets);
        Assert.Empty(empty.Manifest.Assets.Assets);
        RejectBytes(package, assets: null, "article_package_manifest_asset_root_input_invalid");
        Assert.False(ArticlePackageImportAssetCandidateValidator.TryReadCandidate(
            CreateArchive(package).Bytes, null, out var missing).IsValid);
        Assert.Null(missing);
        var legacy = ArticlePackageImportCandidateByteTests.CreatePackage();
        var legacyAssets = Collection([], [], legacy.Inventory);
        Assert.False(ArticlePackageImportAssetCandidateValidator.Validate(
            legacy.Inventory, legacy.Files, legacyAssets, out var legacyCandidate).IsValid);
        Assert.Null(legacyCandidate);
        package = CreatePackage();
        Assert.False(ArticlePackageImportCandidateBytes.Validate(package.Bytes.Inventory, package.Bytes.Files, out _).IsValid);
        Assert.False(ArticlePackageImportZipCandidateReader.TryReadCandidate(CreateArchive(package).Bytes, out _).IsValid);
    }

    [Theory]
    [InlineData("mime", "article_package_manifest_asset_media_binding_mismatch")]
    [InlineData("width", "article_package_manifest_asset_media_binding_mismatch")]
    [InlineData("height", "article_package_manifest_asset_media_binding_mismatch")]
    [InlineData("extension", "article_package_manifest_asset_media_inspection_unavailable")]
    [InlineData("hash", "article_package_import_asset_byte_binding_mismatch")]
    public void ResealedRootAndValidChecksumsCannotMakeFalseAssetAssertionsTrue(string field, string reason)
    {
        Package package = CreatePackage(change: metadata => field switch
        {
            "mime" => metadata with { MimeType = "image/gif" },
            "width" => metadata with { WidthPixels = 2 },
            "height" => metadata with { HeightPixels = 2 },
            "extension" => metadata with
            {
                Extension = ".gif",
                PackagePath = "assets/" + metadata.PortableAsset.FileNameToken + ".gif"
            },
            _ => metadata with { Sha256 = new string('f', 64) }
        });
        Assert.True(ArticlePackageChecksums.Verify(package.Bytes.Inventory, package.Bytes.Files).IsValid);
        if (field != "hash")
        {
            Assert.True(ArticlePackageImportCandidateBytes.Validate(
                package.Bytes.Inventory, package.Bytes.Files, package.Assets, out _).IsValid);
        }
        RejectBytes(package, package.Assets, reason);
        Archive archive = CreateArchive(package, CompressionLevel.Optimal);
        RejectZip(archive.Bytes, archive.Assets, reason);
    }

    [Theory]
    [InlineData("svg")]
    [InlineData("pdf")]
    [InlineData("corrupt")]
    public void UnsupportedAndMalformedMediaCannotUseAManifestOrExportRecordFallback(string kind)
    {
        byte[] bytes = kind switch
        {
            "svg" => "<svg width=\"1\" height=\"1\"></svg>"u8.ToArray(),
            "pdf" => "%PDF-1.7\n"u8.ToArray(),
            _ => [0, 1, 2, 3]
        };
        string extension = kind == "corrupt" ? ".png" : "." + kind;
        Package package = CreatePackage(assetBytes: bytes, change: metadata => metadata with
        {
            Extension = extension,
            MimeType = kind switch
            {
                "svg" => "image/svg+xml",
                "pdf" => "application/pdf",
                _ => "image/png"
            },
            WidthPixels = kind == "pdf" ? null : 1,
            HeightPixels = kind == "pdf" ? null : 1,
            PackagePath = "assets/" + metadata.PortableAsset.FileNameToken + extension
        });
        RejectBytes(package, package.Assets, "article_package_manifest_asset_media_inspection_unavailable");
        Archive archive = CreateArchive(package);
        RejectZip(archive.Bytes, archive.Assets, "article_package_manifest_asset_media_inspection_unavailable");
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("extra")]
    [InlineData("size")]
    [InlineData("duplicate")]
    [InlineData("checksums")]
    public void ActualFileAndInventoryClosureRejectsMissingExtraSizeDuplicateAndChecksumFaults(string fault)
    {
        Package package = CreatePackage();
        ArticlePackageFileBytes[] content = package.Bytes.Files.Where(file => file.Path != "checksums.json").ToArray();
        int assetIndex = Array.FindIndex(content, file => file.Path.StartsWith("assets/", StringComparison.Ordinal));
        if (fault == "duplicate")
        {
            ArticlePackageFileBytes[] duplicate = [.. package.Bytes.Files, content[assetIndex]];
            Assert.False(ArticlePackageImportAssetCandidateValidator.Validate(
                [.. package.Bytes.Inventory, package.Bytes.Inventory.Single(entry => entry.Path == content[assetIndex].Path)],
                duplicate, package.Assets, out var invalid).IsValid);
            Assert.Null(invalid);
            RejectZip(WriteArchive(duplicate), package.Assets);
            return;
        }
        if (fault == "checksums")
        {
            package.Bytes.Buffers[assetIndex][^1] ^= 1;
            RejectBytes(package, package.Assets, "article_package_file_digest_mismatch");
            RejectZip(WriteArchive(package.Bytes.Files), package.Assets);
            return;
        }
        content = fault switch
        {
            "missing" => content.Where(file => file.Path != content[assetIndex].Path).ToArray(),
            "extra" => [.. content, new("assets/00000101-0000-4000-8000-000000000001.png", Png())],
            _ => content.Select((file, index) => index == assetIndex ? file with { Bytes = file.Bytes[..^1] } : file).ToArray()
        };
        var changed = ArticlePackageImportCandidateByteTests.BuildPackage(content);
        Assert.True(ArticlePackageChecksums.Verify(changed.Inventory, changed.Files).IsValid);
        Assert.False(ArticlePackageImportAssetCandidateValidator.Validate(
            changed.Inventory, changed.Files, package.Assets, out var candidate).IsValid);
        Assert.Null(candidate);
        RejectZip(WriteArchive(changed.Files), package.Assets);
    }

    [Theory]
    [InlineData("orphan")]
    [InlineData("missing-reference")]
    [InlineData("foreign-article")]
    [InlineData("duplicate-edge")]
    public void RootReparsesNestedCollectionAndRejectsBrokenEdgesWithActualChecksums(string fault)
    {
        Package package = CreatePackage();
        JsonObject document = Document(package);
        JsonArray edges = document["assets"]!["references"]!.AsArray();
        switch (fault)
        {
            case "orphan":
                edges.Clear();
                break;
            case "missing-reference":
                edges[0]!["portableAsset"] = "portable-asset:00000999-0000-4000-8000-000000000001";
                break;
            case "foreign-article":
                edges[0]!["portableArticle"] = "article:00000999-0000-4000-8000-000000000001";
                break;
            default:
                edges.Add(edges[0]!.DeepClone());
                break;
        }
        Package changed = ReplaceManifest(package, document);
        Assert.True(ArticlePackageChecksums.Verify(changed.Bytes.Inventory, changed.Bytes.Files).IsValid);
        RejectBytes(changed, changed.Assets);
        Archive archive = CreateArchive(changed);
        RejectZip(archive.Bytes, archive.Assets);
    }

    [Theory]
    [InlineData("schemaVersion")]
    [InlineData("canonicalHashVersion")]
    [InlineData("propertySchemaVersion")]
    public void FrozenInputRejectsEveryFutureRootVersionWithoutGuessing(string field)
    {
        Package package = CreatePackage();
        JsonObject document = Document(package);
        document[field] = 3;
        Package changed = ReplaceManifest(package, document);
        RejectBytes(changed, changed.Assets, "article_package_manifest_version_unsupported");
        Archive archive = CreateArchive(changed);
        RejectZip(archive.Bytes, archive.Assets, "article_package_manifest_version_unsupported");
    }

    [Theory]
    [InlineData("assets")]
    [InlineData("rights")]
    [InlineData("ownerAdminPrincipalId")]
    [InlineData("state")]
    [InlineData("storageKey")]
    [InlineData("propertySnapshot")]
    public void MissingAssetCollectionAndUnknownAuthorityFieldsAreNeverDefaulted(string field)
    {
        Package package = CreatePackage();
        JsonObject document = Document(package);
        if (field == "assets")
        {
            document.Remove(field);
        }
        else
        {
            document[field] = "untrusted";
        }
        Package changed = ReplaceManifest(package, document);
        RejectBytes(changed, changed.Assets);
        Archive archive = CreateArchive(changed);
        RejectZip(archive.Bytes, archive.Assets);
    }

    [Fact]
    public void IndependentlySuppliedInventoryIsUsedIncludingOriginalCompressedFacts()
    {
        Package package = CreatePackage();
        ArticlePackageInventoryEntry[] foreign = package.Bytes.Inventory.Select(entry => entry with
        {
            CompressedBytes = entry.CompressedBytes + 1
        }).ToArray();
        var foreignCollection = Collection(package.Metadata, package.Assets.References, foreign);
        RejectBytes(package, foreignCollection, "article_package_manifest_asset_root_inventory_mismatch");
        Archive archive = CreateArchive(package, CompressionLevel.Optimal);
        Assert.NotEqual(package.Assets.Inventory.ToArray(), archive.Assets.Inventory.ToArray());
        RejectZip(archive.Bytes, package.Assets, "article_package_manifest_asset_root_inventory_mismatch");
        Assert.True(ArticlePackageImportAssetCandidateValidator.TryReadCandidate(archive.Bytes, archive.Assets, out _).IsValid);
    }

    [Fact]
    public void IndependentlySuppliedCollectionCannotReplaceTheManifestCollection()
    {
        Package package = CreatePackage();
        var changed = package.Metadata.Select(metadata => metadata with
        {
            SourceAssetId = "00000999-0000-4000-8000-000000000001"
        }).ToArray();
        var different = Collection(changed, package.Assets.References, package.Bytes.Inventory);
        RejectBytes(package, different, "article_package_manifest_asset_root_collection_mismatch");
        RejectZip(WriteArchive(package.Bytes.Files), different, "article_package_manifest_asset_root_collection_mismatch");
    }

    [Fact]
    public void AssertedAssetLengthMustMatchActualFileBeforeChecksumOrManifestParsing()
    {
        Package package = CreatePackage();
        var inventory = package.Bytes.Inventory.Select(entry => entry.Path.StartsWith("assets/", StringComparison.Ordinal)
            ? entry with
            {
                UncompressedBytes = entry.UncompressedBytes + 1
            } : entry).ToArray();
        var result = ArticlePackageImportAssetCandidateValidator.Validate(inventory, package.Bytes.Files, package.Assets, out var candidate);
        Assert.False(result.IsValid);
        Assert.Equal("article_package_file_length_mismatch", result.ReasonCode);
        Assert.Null(candidate);
    }

    [Theory]
    [InlineData("payload")]
    [InlineData("crc")]
    [InlineData("length")]
    [InlineData("deflate")]
    public void AssetPayloadCrcLengthAndDecompressionFaultsLeaveNoCandidate(string fault)
    {
        Package package = CreatePackage();
        Archive archive = CreateArchive(package, fault == "deflate" ? CompressionLevel.Optimal : CompressionLevel.NoCompression);
        byte[] bytes = archive.Bytes;
        int central = FindAssetCentral(bytes);
        int local = checked((int)Read32(bytes, central + 42));
        int payload = local + 30 + Read16(bytes, local + 26) + Read16(bytes, local + 28);
        if (fault is "payload" or "deflate")
        {
            bytes[payload] ^= 0xff;
        }
        else if (fault == "crc")
        {
            uint wrong = Read32(bytes, central + 16) ^ 1;
            Write32(bytes, central + 16, wrong);
            Write32(bytes, local + 14, wrong);
        }
        else
        {
            Write32(bytes, central + 24, Read32(bytes, central + 24) - 1);
            Write32(bytes, local + 22, Read32(bytes, local + 22) - 1);
        }
        RejectZip(bytes, archive.Assets);
    }

    [Theory]
    [InlineData("symlink")]
    [InlineData("traversal")]
    [InlineData("ratio")]
    [InlineData("total")]
    public void AssetZipSafetyAndOriginalBudgetsRemainFailClosed(string fault)
    {
        Package package = CreatePackage(assetBytes: fault == "ratio" ? new byte[1024 * 1024] : null);
        var archive = new Archive(WriteArchive(package.Bytes.Files,
            fault == "ratio" ? CompressionLevel.Optimal : CompressionLevel.NoCompression), package.Assets);
        byte[] bytes = archive.Bytes;
        int central = FindAssetCentral(bytes);
        int local = checked((int)Read32(bytes, central + 42));
        if (fault == "symlink")
        {
            BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(central + 4, 2), 0x0314);
            Write32(bytes, central + 38, 0xa1ff0000);
        }
        else if (fault == "traversal")
        {
            "../"u8.CopyTo(bytes.AsSpan(central + 46, 3));
            "../"u8.CopyTo(bytes.AsSpan(local + 30, 3));
        }
        else if (fault == "total")
        {
            Write32(bytes, central + 24, checked((uint)ArticlePackageImportCandidateBytes.MaxTotalBytes));
            Write32(bytes, local + 22, checked((uint)ArticlePackageImportCandidateBytes.MaxTotalBytes));
        }
        RejectZip(bytes, archive.Assets, fault == "ratio" ? "article_package_compression_ratio_exceeded" : null);
    }

    [Fact]
    public void AggregateBudgetRejectsBeforeTouchingAnyAssetByteProvider()
    {
        int reads = 0;
        using var memory = new CallbackMemory(new byte[32 * 1024 * 1024], () => reads++);
        ReadOnlyMemory<byte> data = memory.Memory;
        ArticlePackageFileBytes[] files =
        [
            new("manifest.json", "{}"u8.ToArray()), new("checksums.json", "{}"u8.ToArray()),
            new("articles/00000001-0000-4000-8000-000000000001.md", "x"u8.ToArray()),
            new("assets/00000001-0000-4000-8000-000000000001.png", data),
            new("assets/00000002-0000-4000-8000-000000000001.png", data)
        ];
        Package package = CreatePackage();
        reads = 0;
        var result = ArticlePackageImportAssetCandidateValidator.Validate(
            files.Select(file => new ArticlePackageInventoryEntry(file.Path, ArticlePackageEntryKind.RegularFile,
                file.Bytes.Length, file.Bytes.Length)).ToArray(), files, package.Assets, out var candidate);
        Assert.False(result.IsValid);
        Assert.Equal("article_package_import_byte_budget_exceeded", result.ReasonCode);
        Assert.Null(candidate);
        Assert.Equal(0, reads);
    }

    [Fact]
    public void OriginalPerAssetMediaBudgetIsNotExpandedToTheByteBudget()
    {
        Package package = CreatePackage(assetBytes: new byte[ArticlePackageAssetMetadataMapper.MaxCandidateAssetBytes + 1]);
        RejectBytes(package, package.Assets, "article_package_import_asset_media_budget_exceeded");
    }

    [Theory]
    [InlineData(999, true)]
    [InlineData(1000, false)]
    public void AssetEntriesShareTheOriginalFiniteFileCountBudget(int articleCount, bool accepted)
    {
        Package package = CreatePackage(articleCount: articleCount);
        var result = ArticlePackageImportAssetCandidateValidator.Validate(
            package.Bytes.Inventory, package.Bytes.Files, package.Assets, out var candidate);
        Assert.Equal(accepted, result.IsValid);
        Archive archive = CreateArchive(package, CompressionLevel.Optimal);
        var zipResult = ArticlePackageImportAssetCandidateValidator.TryReadCandidate(archive.Bytes, archive.Assets, out var zip);
        Assert.Equal(accepted, zipResult.IsValid);
        if (accepted)
        {
            Assert.Equal(articleCount, candidate!.Manifest.Articles.Count);
            Assert.Equal(ArticlePackageImportCandidateBytes.MaxFiles, zip!.Candidate.FilePaths.Count);
        }
        else
        {
            Assert.Null(candidate);
            Assert.Null(zip);
            Assert.Equal("article_package_zip_entry_budget_exceeded", zipResult.ReasonCode);
        }
    }

    [Theory]
    [InlineData("sha256")]
    [InlineData("bom")]
    [InlineData("lf")]
    [InlineData("crlf")]
    [InlineData("cr")]
    [InlineData("final")]
    [InlineData("spaces")]
    [InlineData("tabs")]
    public void V2StillRechecksActualMarkdownMetadataAfterResealingRootAndChecksums(string field)
    {
        Package package = CreatePackage();
        Assert.True(ArticlePackageImportCandidateBytes.Validate(
            package.Bytes.Inventory, package.Bytes.Files, package.Assets, out var valid).IsValid);
        var articles = valid!.Manifest.Articles.ToArray();
        ArticlePackageByteMetadata original = articles[0].SourceBytes;
        ArticlePackageByteMetadata changed = field switch
        {
            "sha256" => original with { Sha256 = new string('f', 64) },
            "bom" => original with { HasUtf8Bom = false },
            "lf" => original with { LfCount = original.LfCount + 1 },
            "crlf" => original with { CrLfCount = original.CrLfCount + 1 },
            "cr" => original with { BareCrCount = original.BareCrCount + 1 },
            "final" => original with { FinalNewline = ArticlePackageFinalNewline.None },
            "spaces" => original with { TrailingSpaceCount = original.TrailingSpaceCount + 1 },
            _ => original with { TrailingTabCount = original.TrailingTabCount + 1 }
        };
        articles[0] = articles[0] with
        {
            SourceBytes = changed
        };
        Assert.True(ArticlePackageManifestCandidateCodec.TryCreateCandidate(
            articles, package.Assets, package.Bytes.Inventory, out var manifest).IsValid);
        JsonObject document = JsonNode.Parse(ArticlePackageManifestCandidateCodec.WriteCandidate(
            manifest!, package.Assets, package.Bytes.Inventory))!.AsObject();
        Package altered = ReplaceManifest(package, document);
        RejectBytes(altered, altered.Assets, "article_package_source_byte_metadata_mismatch");
        Archive archive = CreateArchive(altered);
        RejectZip(archive.Bytes, archive.Assets, "article_package_source_byte_metadata_mismatch");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void CancellationBeforeInputAndDuringActualAssetCopyNeverReturnsPartialCandidate(bool duringCopy)
    {
        Package package = CreatePackage();
        using var cancellation = new CancellationTokenSource();
        int index = Array.FindIndex(package.Bytes.Files, file => file.Path.StartsWith("assets/", StringComparison.Ordinal));
        using var memory = new CallbackMemory(package.Bytes.Files[index].Bytes.ToArray(), cancellation.Cancel);
        if (duringCopy)
        {
            package.Bytes.Files[index] = new(package.Bytes.Files[index].Path, memory.Memory);
        }
        else
        {
            cancellation.Cancel();
        }
        var result = ArticlePackageImportAssetCandidateValidator.Validate(
            package.Bytes.Inventory, package.Bytes.Files, package.Assets, out var candidate, cancellation.Token);
        Assert.False(result.IsValid);
        Assert.Equal("article_package_import_cancelled", result.ReasonCode);
        Assert.Null(candidate);
        Archive archive = CreateArchive(CreatePackage());
        RejectZip(archive.Bytes, archive.Assets, "article_package_import_cancelled", cancellation.Token);
    }

    [Fact]
    public void OneBadAssetBlocksTheWholeMultiArticleMultiAssetCandidate()
    {
        Package package = CreatePackage(assetCount: 2, change: metadata => metadata.PortableAsset.FileNameToken.StartsWith("00000101", StringComparison.Ordinal)
            ? metadata with
            {
                WidthPixels = 2
            } : metadata);
        RejectBytes(package, package.Assets, "article_package_manifest_asset_media_binding_mismatch");
        Archive archive = CreateArchive(package);
        RejectZip(archive.Bytes, archive.Assets, "article_package_manifest_asset_media_binding_mismatch");
    }

    private static Package CreatePackage(
        Func<ArticlePackageManifestAssetMetadata, ArticlePackageManifestAssetMetadata>? change = null,
        byte[]? assetBytes = null,
        int assetCount = 1,
        int articleCount = 2)
    {
        var legacy = ArticlePackageImportCandidateByteTests.CreatePackage(articleCount, Encoding.UTF8.GetBytes("\ufeff原文 😀  \t\r\n"));
        Assert.True(ArticlePackageManifestCandidateCodec.TryParseCandidate(legacy.Files[0].Bytes.Span, out var root).IsValid);
        var metadata = new List<ArticlePackageManifestAssetMetadata>();
        var edges = new List<ArticlePackageManifestAssetReference>();
        var content = legacy.Files.Where(file => file.Path.StartsWith("articles/", StringComparison.Ordinal)).ToList();
        for (int index = 0; index < assetCount; index++)
        {
            byte[] actual = assetBytes?.ToArray() ?? Png();
            actual[^1] ^= checked((byte)index);
            Assert.True(ArticlePackageIdentity.TryCreate(ArticlePackageIdentityKind.Asset,
                $"portable-asset:{index + 256:x8}-0000-4000-8000-000000000001", out var id).IsValid);
            var row = new ArticlePackageManifestAssetMetadata(id, $"{index + 512:x8}-0000-4000-8000-000000000001",
                Hash(actual), "image/png", ".png", actual.Length, 1, 1, "assets/" + id.FileNameToken + ".png");
            row = change?.Invoke(row) ?? row;
            metadata.Add(row);
            content.Add(new(row.PackagePath, actual));
            edges.AddRange(root!.Articles.Select(article => new ArticlePackageManifestAssetReference(article.PortableArticle, id)));
        }
        ArticlePackageInventoryEntry[] provisional =
        [
            new("manifest.json", ArticlePackageEntryKind.RegularFile, 1, 1),
            new("checksums.json", ArticlePackageEntryKind.RegularFile, 1, 1),
            .. content.Select(file => new ArticlePackageInventoryEntry(file.Path, ArticlePackageEntryKind.RegularFile, file.Bytes.Length, file.Bytes.Length))
        ];
        var collection = Collection(metadata, edges, provisional);
        Assert.True(ArticlePackageManifestCandidateCodec.TryCreateCandidate(root!.Articles, collection, provisional, out var manifest).IsValid);
        content.Insert(0, new("manifest.json", ArticlePackageManifestCandidateCodec.WriteCandidate(manifest!, collection, provisional)));
        var bytes = ArticlePackageImportCandidateByteTests.BuildPackage(content.ToArray());
        return new(bytes, metadata.ToArray(), Collection(metadata, edges, bytes.Inventory));
    }

    private static Package ReplaceManifest(Package package, JsonObject document)
    {
        var bytes = ArticlePackageImportCandidateByteTests.BuildPackage(package.Bytes.Files
            .Where(file => file.Path != "checksums.json")
            .Select(file => file.Path == "manifest.json" ? file with { Bytes = Encoding.UTF8.GetBytes(document.ToJsonString()) } : file).ToArray());
        return package with
        {
            Bytes = bytes,
            Assets = Collection(package.Metadata, package.Assets.References, bytes.Inventory)
        };
    }

    private static ArticlePackageManifestAssetCollectionCandidate Collection(
        IReadOnlyList<ArticlePackageManifestAssetMetadata> metadata,
        IReadOnlyList<ArticlePackageManifestAssetReference> edges,
        IReadOnlyList<ArticlePackageInventoryEntry> inventory)
    {
        var result = ArticlePackageManifestCandidateCodec.TryCreateAssetCollectionCandidate(metadata, edges, inventory, out var collection);
        Assert.True(result.IsValid, result.ReasonCode);
        return collection!;
    }

    private static Archive CreateArchive(Package package, CompressionLevel compression = CompressionLevel.NoCompression)
    {
        byte[] bytes = WriteArchive(package.Bytes.Files, compression);
        using var memory = new MemoryStream(bytes, writable: false);
        using var zip = new ZipArchive(memory, ZipArchiveMode.Read);
        var inventory = zip.Entries.Select(entry => new ArticlePackageInventoryEntry(entry.FullName,
            ArticlePackageEntryKind.RegularFile, entry.Length, entry.CompressedLength)).ToArray();
        return new(bytes, Collection(package.Metadata, package.Assets.References, inventory));
    }

    private static byte[] WriteArchive(IReadOnlyList<ArticlePackageFileBytes> files, CompressionLevel compression = CompressionLevel.NoCompression)
    {
        using var memory = new MemoryStream();
        using (var zip = new ZipArchive(memory, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (ArticlePackageFileBytes file in files)
            {
                ZipArchiveEntry entry = zip.CreateEntry(file.Path, compression);
                entry.LastWriteTime = new(2026, 10, 8, 1, 2, 4, TimeSpan.Zero);
                entry.ExternalAttributes = 0;
                using Stream output = entry.Open();
                output.Write(file.Bytes.Span);
            }
        }
        return memory.ToArray();
    }

    private static void RejectBytes(Package package, ArticlePackageManifestAssetCollectionCandidate? assets, string? reason = null)
    {
        var result = ArticlePackageImportAssetCandidateValidator.Validate(package.Bytes.Inventory, package.Bytes.Files, assets, out var candidate);
        Assert.False(result.IsValid);
        Assert.Null(candidate);
        Assert.NotNull(result.ReasonCode);
        if (reason is not null)
        {
            Assert.Equal(reason, result.ReasonCode);
        }
    }

    private static void RejectZip(byte[] bytes, ArticlePackageManifestAssetCollectionCandidate assets, string? reason = null,
        CancellationToken cancellationToken = default)
    {
        var result = ArticlePackageImportAssetCandidateValidator.TryReadCandidate(bytes, assets, out var candidate, cancellationToken);
        Assert.False(result.IsValid);
        Assert.Null(candidate);
        Assert.NotNull(result.ReasonCode);
        if (reason is not null)
        {
            Assert.Equal(reason, result.ReasonCode);
        }
    }

    private static JsonObject Document(Package package)
        => JsonNode.Parse(package.Bytes.Files.Single(file => file.Path == "manifest.json").Bytes.Span)!.AsObject();

    private static int FindAssetCentral(byte[] bytes)
    {
        for (int offset = 0; offset + 46 < bytes.Length; offset++)
        {
            if (Read32(bytes, offset) == 0x02014b50 && Encoding.ASCII.GetString(bytes, offset + 46, Read16(bytes, offset + 28))
                .StartsWith("assets/", StringComparison.Ordinal))
            {
                return offset;
            }
        }
        throw new InvalidOperationException("asset central record missing");
    }

    private static uint Read32(byte[] bytes, int offset) => BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(offset, 4));
    private static ushort Read16(byte[] bytes, int offset) => BinaryPrimitives.ReadUInt16LittleEndian(bytes.AsSpan(offset, 2));
    private static void Write32(byte[] bytes, int offset, uint value) => BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(offset, 4), value);
    private static string Hash(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));
    private static byte[] Png() => Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/ZgAAAABJRU5ErkJggg==");

    private sealed record Package(ArticlePackageImportCandidateByteTests.PackageCase Bytes,
        ArticlePackageManifestAssetMetadata[] Metadata, ArticlePackageManifestAssetCollectionCandidate Assets);
    private sealed record Archive(byte[] Bytes, ArticlePackageManifestAssetCollectionCandidate Assets);

    private sealed class CallbackMemory(byte[] bytes, Action callback) : MemoryManager<byte>
    {
        public override Memory<byte> Memory => CreateMemory(bytes.Length);

        public override Span<byte> GetSpan()
        {
            callback();
            return bytes;
        }

        public override MemoryHandle Pin(int elementIndex = 0) => throw new NotSupportedException();
        public override void Unpin()
        {
        }
        protected override void Dispose(bool disposing)
        {
        }
    }
}
