using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

using FsusBlog.Shared.Contracts.ArticlePackages;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticlePackageChecksumTests
{
    private const string Token = "01991e72-9a2c-7b60-8f47-b339f58e4a11";
    private const string ArticlePath = "articles/" + Token + ".md";
    private const string AssetPath = "assets/" + Token + ".png";

    [Fact]
    public void Verify_UsesActualManifestMarkdownAssetAndChecksumDocumentBytes()
    {
        PackageCase package = CreatePackage();
        ArticlePackageChecksumValidationResult result = ArticlePackageChecksums.Verify(package.Inventory, package.Files);

        Assert.True(result.IsValid, result.ReasonCode);
        Assert.Equal(package.Digest, result.ComponentDigest);
        Assert.Equal(3, package.Rows.Length);
        Assert.DoesNotContain(package.Rows, row => row.Path == ArticlePackageInventory.ChecksumsPath);
    }

    [Fact]
    public void ComponentDigest_MatchesIndependentLengthFramedBigEndianGoldenVector()
    {
        ArticlePackageInventoryEntry[] inventory =
        [
            InventoryEntry(ArticlePackageInventory.ManifestPath, 1),
            InventoryEntry(ArticlePath, 1),
            InventoryEntry(ArticlePackageInventory.ChecksumsPath, 0)
        ];
        ArticlePackageChecksumEntry[] rows =
        [
            new(ArticlePackageInventory.ManifestPath, 1, Hash("m"u8)),
            new(ArticlePath, 1, Hash("a"u8))
        ];

        ArticlePackageChecksumValidationResult result = ArticlePackageChecksums.ComputeComponentDigest(inventory, rows);

        Assert.True(result.IsValid, result.ReasonCode);
        Assert.Equal("20c72759df412af3580013d0361e0481aa4f1c90994da83356d9c50978a940b7", result.ComponentDigest);
    }

    [Fact]
    public void ComponentDigest_IsStableAcrossOrderWhitespaceAndRepeatedVerification()
    {
        PackageCase package = CreatePackage();
        ArticlePackageChecksumValidationResult forward = ArticlePackageChecksums.ComputeComponentDigest(package.Inventory, package.Rows);
        ArticlePackageChecksumValidationResult reverse = ArticlePackageChecksums.ComputeComponentDigest(package.Inventory.Reverse().ToArray(), package.Rows.Reverse().ToArray());
        byte[] document = WriteDocument(package.Rows.Reverse().ToArray(), package.Digest, true);
        PackageCase reordered = ReplaceDocument(package, document);

        Assert.Equal(forward, reverse);
        for (int attempt = 0; attempt < 3; attempt++)
        {
            ArticlePackageChecksumValidationResult actual = ArticlePackageChecksums.Verify(reordered.Inventory.Reverse().ToArray(), reordered.Files.Reverse().ToArray());
            Assert.True(actual.IsValid, actual.ReasonCode);
            Assert.Equal(package.Digest, actual.ComponentDigest);
        }
        Assert.NotEqual(package.Files[^1].Bytes.Length, document.Length);
    }

    [Fact]
    public void ComponentDigest_ExcludesOnlyChecksumDocumentAndCompressedMetadata()
    {
        PackageCase package = CreatePackage();
        ArticlePackageInventoryEntry[] changed = package.Inventory.Select(entry => entry with
        {
            CompressedBytes = entry.UncompressedBytes + 1
        }).ToArray();
        changed[^1] = InventoryEntry(ArticlePackageInventory.ChecksumsPath, 100);

        ArticlePackageChecksumValidationResult result = ArticlePackageChecksums.ComputeComponentDigest(changed, package.Rows);

        Assert.True(result.IsValid, result.ReasonCode);
        Assert.Equal(package.Digest, result.ComponentDigest);
        AssertFalse(ArticlePackageChecksums.Verify(changed, package.Files), "article_package_file_length_mismatch");
    }

    [Theory]
    [InlineData(ArticlePackageInventory.ManifestPath)]
    [InlineData(ArticlePath)]
    [InlineData(AssetPath)]
    public void Verify_RejectsSameLengthByteTamperInEveryCoveredRole(string path)
    {
        PackageCase package = CreatePackage();
        ArticlePackageFileBytes[] files = package.Files.ToArray();
        int index = Array.FindIndex(files, file => file.Path == path);
        byte[] bytes = files[index].Bytes.ToArray();
        bytes[^1] ^= 1;
        files[index] = new(path, bytes);

        AssertFalse(ArticlePackageChecksums.Verify(package.Inventory, files), "article_package_file_digest_mismatch");
    }

    [Fact]
    public void Verify_RejectsForgedRowsEvenWhenTheirComponentDigestIsRecomputed()
    {
        PackageCase package = CreatePackage();
        ArticlePackageChecksumEntry[] forgedRows = package.Rows.ToArray();
        forgedRows[0] = forgedRows[0] with
        {
            Sha256 = new string('0', 64)
        };
        ArticlePackageChecksumValidationResult metadataOnly = ArticlePackageChecksums.ComputeComponentDigest(package.Inventory, forgedRows);
        Assert.True(metadataOnly.IsValid);
        PackageCase forged = ReplaceDocument(package, WriteDocument(forgedRows, metadataOnly.ComponentDigest!));

        AssertFalse(ArticlePackageChecksums.Verify(forged.Inventory, forged.Files), "article_package_file_digest_mismatch");
    }

    [Fact]
    public void Verify_RejectsComponentDigestTamper()
    {
        PackageCase package = CreatePackage();
        PackageCase forged = ReplaceDocument(package, WriteDocument(package.Rows, new string('0', 64)));

        AssertFalse(ArticlePackageChecksums.Verify(forged.Inventory, forged.Files), "article_package_checksum_component_digest_mismatch");
    }

    [Fact]
    public void Verify_RejectsMissingExtraDuplicateAndAliasedActualFiles()
    {
        PackageCase package = CreatePackage();
        AssertFalse(ArticlePackageChecksums.Verify(package.Inventory, package.Files[..^1]), "article_package_file_closure_mismatch");
        AssertFalse(ArticlePackageChecksums.Verify(package.Inventory, [.. package.Files, package.Files[0]]), "article_package_file_closure_mismatch");
        ArticlePackageFileBytes[] duplicate = package.Files.ToArray();
        duplicate[1] = duplicate[0];
        AssertFalse(ArticlePackageChecksums.Verify(package.Inventory, duplicate), "article_package_file_duplicate");
        ArticlePackageFileBytes[] extra = package.Files.ToArray();
        extra[1] = new("extra.json", extra[1].Bytes);
        AssertFalse(ArticlePackageChecksums.Verify(package.Inventory, extra), "article_package_file_closure_mismatch");
        extra[1] = new("Manifest.json", extra[0].Bytes);
        AssertFalse(ArticlePackageChecksums.Verify(package.Inventory, extra), "article_package_file_closure_mismatch");
        extra[1] = null!;
        AssertFalse(ArticlePackageChecksums.Verify(package.Inventory, extra), "article_package_file_closure_mismatch");
    }

    [Fact]
    public void Verify_RejectsActualSizeDrift()
    {
        PackageCase package = CreatePackage();
        ArticlePackageFileBytes[] files = package.Files.ToArray();
        files[1] = new(files[1].Path, files[1].Bytes[..^1]);

        AssertFalse(ArticlePackageChecksums.Verify(package.Inventory, files), "article_package_file_length_mismatch");
    }

    [Fact]
    public void ComponentDigest_RejectsMissingExtraDuplicateSelfAndAliasedChecksumRows()
    {
        PackageCase package = CreatePackage();
        AssertFalse(ArticlePackageChecksums.ComputeComponentDigest(package.Inventory, package.Rows[..^1]), "article_package_checksum_closure_mismatch");
        AssertFalse(ArticlePackageChecksums.ComputeComponentDigest(package.Inventory, [.. package.Rows, package.Rows[0]]), "article_package_checksum_closure_mismatch");
        ArticlePackageChecksumEntry[] rows = package.Rows.ToArray();
        rows[1] = rows[0];
        AssertFalse(ArticlePackageChecksums.ComputeComponentDigest(package.Inventory, rows), "article_package_checksum_duplicate");
        rows[1] = new(ArticlePackageInventory.ChecksumsPath, package.Files[^1].Bytes.Length, Hash(package.Files[^1].Bytes.Span));
        AssertFalse(ArticlePackageChecksums.ComputeComponentDigest(package.Inventory, rows), "article_package_checksum_closure_mismatch");
        rows[1] = new("Manifest.json", 1, Hash("x"u8));
        AssertFalse(ArticlePackageChecksums.ComputeComponentDigest(package.Inventory, rows), "article_package_checksum_closure_mismatch");
        rows[1] = new("articles/caf\u00e9.md", 1, Hash("x"u8));
        AssertFalse(ArticlePackageChecksums.ComputeComponentDigest(package.Inventory, rows), "article_package_checksum_closure_mismatch");
        rows[1] = null!;
        AssertFalse(ArticlePackageChecksums.ComputeComponentDigest(package.Inventory, rows), "article_package_checksum_closure_mismatch");
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCD")]
    [InlineData("0x0123456789abcdef")]
    [InlineData("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")]
    public void ComponentDigest_RejectsNoncanonicalFileDigests(string? digest)
    {
        PackageCase package = CreatePackage();
        ArticlePackageChecksumEntry[] rows = package.Rows.ToArray();
        rows[0] = rows[0] with
        {
            Sha256 = digest!
        };

        AssertFalse(ArticlePackageChecksums.ComputeComponentDigest(package.Inventory, rows), "article_package_checksum_row_invalid");
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(0)]
    [InlineData(long.MaxValue)]
    public void ComponentDigest_RejectsRowSizesThatDoNotMatchInventory(long byteLength)
    {
        PackageCase package = CreatePackage();
        ArticlePackageChecksumEntry[] rows = package.Rows.ToArray();
        rows[0] = rows[0] with
        {
            ByteLength = byteLength
        };

        AssertFalse(ArticlePackageChecksums.ComputeComponentDigest(package.Inventory, rows), "article_package_checksum_row_invalid");
    }

    [Theory]
    [InlineData("[]")]
    [InlineData("null")]
    [InlineData("{}")]
    [InlineData("{\"schema\":")]
    [InlineData("{\"schema\":\"unknown\"}")]
    public void Verify_RejectsMalformedChecksumDocumentsWithoutThrowing(string document)
    {
        PackageCase package = ReplaceDocument(CreatePackage(), Encoding.UTF8.GetBytes(document));

        AssertFalse(ArticlePackageChecksums.Verify(package.Inventory, package.Files), "article_package_checksum_document_invalid");
    }

    [Theory]
    [InlineData("version", "\"1\"")]
    [InlineData("version", "null")]
    [InlineData("version", "{}")]
    [InlineData("version", "1.5")]
    [InlineData("version", "2")]
    [InlineData("version", "-1")]
    [InlineData("version", "99999999999999999999999999")]
    [InlineData("schema", "\"legacy\"")]
    [InlineData("algorithm", "\"sha256\"")]
    [InlineData("componentDigest", "null")]
    [InlineData("componentDigest", "\"ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCD\"")]
    [InlineData("files", "{}")]
    [InlineData("files", "[]")]
    public void Verify_RejectsUnsupportedOrMistypedDocumentFields(string field, string jsonValue)
    {
        PackageCase package = CreatePackage();
        JsonObject document = JsonNode.Parse(package.Files[^1].Bytes.Span)!.AsObject();
        document[field] = JsonNode.Parse(jsonValue);
        package = ReplaceDocument(package, JsonSerializer.SerializeToUtf8Bytes(document));

        AssertFalse(ArticlePackageChecksums.Verify(package.Inventory, package.Files), "article_package_checksum_document_invalid");
    }

    [Theory]
    [InlineData("byteLength", "\"1\"")]
    [InlineData("byteLength", "null")]
    [InlineData("byteLength", "{}")]
    [InlineData("byteLength", "1.5")]
    [InlineData("byteLength", "99999999999999999999999999")]
    [InlineData("path", "null")]
    [InlineData("path", "[]")]
    [InlineData("sha256", "false")]
    public void Verify_RejectsMistypedChecksumRowFields(string field, string jsonValue)
    {
        PackageCase package = CreatePackage();
        JsonObject document = JsonNode.Parse(package.Files[^1].Bytes.Span)!.AsObject();
        document["files"]![0]![field] = JsonNode.Parse(jsonValue);
        package = ReplaceDocument(package, JsonSerializer.SerializeToUtf8Bytes(document));

        AssertFalse(ArticlePackageChecksums.Verify(package.Inventory, package.Files), "article_package_checksum_document_invalid");
    }

    [Fact]
    public void Verify_RejectsUnknownAndDuplicateFieldsIncludingEscapedNames()
    {
        PackageCase package = CreatePackage();
        string original = Encoding.UTF8.GetString(package.Files[^1].Bytes.Span);
        string[] mutated =
        [
            original.Insert(1, "\"token\":\"private-fixture\","),
            original.Insert(1, "\"schema\":\"duplicate\","),
            original.Insert(1, "\"\\u0073chema\":\"duplicate\","),
            original.Replace("\"byteLength\":", "\"unknown\":0,\"byteLength\":", StringComparison.Ordinal),
            original.Replace("\"byteLength\":", "\"byteLength\":0,\"byteLength\":", StringComparison.Ordinal)
        ];
        foreach (string document in mutated)
        {
            PackageCase changed = ReplaceDocument(package, Encoding.UTF8.GetBytes(document));
            AssertFalse(ArticlePackageChecksums.Verify(changed.Inventory, changed.Files), "article_package_checksum_document_invalid");
        }
    }

    [Fact]
    public void Verify_RejectsDeepObjectsTrailingCommasCommentsAndInvalidUtf8()
    {
        PackageCase package = CreatePackage();
        string original = Encoding.UTF8.GetString(package.Files[^1].Bytes.Span);
        byte[][] invalid =
        [
            Encoding.UTF8.GetBytes(original[..^1] + ",}"),
            Encoding.UTF8.GetBytes("/*comment*/" + original),
            Encoding.UTF8.GetBytes("{\"deep\":{\"a\":{\"b\":{\"c\":{\"d\":0}}}}}"),
            [0xff, 0xfe],
            [.. Encoding.UTF8.GetBytes("{\"schema\":\""), 0xff, .. Encoding.UTF8.GetBytes("\"}")]
        ];
        foreach (byte[] bytes in invalid)
        {
            PackageCase changed = ReplaceDocument(package, bytes);
            AssertFalse(ArticlePackageChecksums.Verify(changed.Inventory, changed.Files), "article_package_checksum_document_invalid");
        }
    }

    [Theory]
    [InlineData("schema-value")]
    [InlineData("path-value")]
    [InlineData("sha256-value")]
    [InlineData("property-name")]
    public void Verify_RejectsInvalidUtf8InOtherwiseCompleteDocumentWithoutEscapingExceptions(string location)
    {
        PackageCase package = CreatePackage();
        byte[] bytes = package.Files[^1].Bytes.ToArray();
        string text = Encoding.UTF8.GetString(bytes);
        int index = location switch
        {
            "schema-value" => text.IndexOf(ArticlePackageChecksums.Schema, StringComparison.Ordinal),
            "path-value" => text.IndexOf(ArticlePackageInventory.ManifestPath, StringComparison.Ordinal),
            "sha256-value" => text.IndexOf(package.Rows[0].Sha256, StringComparison.Ordinal),
            _ => text.IndexOf("schema", StringComparison.Ordinal)
        };
        Assert.True(index >= 0);
        bytes[index] = 0xff;
        package = ReplaceDocument(package, bytes);

        AssertFalse(ArticlePackageChecksums.Verify(package.Inventory, package.Files), "article_package_checksum_document_invalid");
    }

    [Fact]
    public void ChecksumOperations_RejectNullInputsWithoutThrowing()
    {
        PackageCase package = CreatePackage();
        Assert.False(ArticlePackageChecksums.ComputeComponentDigest(null, null).IsValid);
        AssertFalse(ArticlePackageChecksums.ComputeComponentDigest(package.Inventory, null), "article_package_checksum_closure_mismatch");
        Assert.False(ArticlePackageChecksums.Verify(null, null).IsValid);
        AssertFalse(ArticlePackageChecksums.Verify(package.Inventory, null), "article_package_file_closure_mismatch");
    }

    [Fact]
    public void Verify_EnforcesExistingInventoryPathAndSizeBudgetsBeforeHashing()
    {
        PackageCase package = CreatePackage();
        ArticlePackageInventoryEntry[] inventory = package.Inventory.ToArray();
        inventory[1] = inventory[1] with
        {
            Path = "../secret.md"
        };
        Assert.False(ArticlePackageChecksums.Verify(inventory, package.Files).IsValid);
        inventory[1] = package.Inventory[1] with
        {
            Kind = ArticlePackageEntryKind.SymbolicLink
        };
        Assert.False(ArticlePackageChecksums.Verify(inventory, package.Files).IsValid);
        inventory[1] = package.Inventory[1] with
        {
            UncompressedBytes = long.MaxValue,
            CompressedBytes = long.MaxValue
        };
        Assert.False(ArticlePackageChecksums.Verify(inventory, package.Files).IsValid);
        inventory[1] = package.Inventory[0];
        Assert.False(ArticlePackageChecksums.Verify(inventory, package.Files).IsValid);
    }

    [Fact]
    public void Verify_ChecksActualMarkdownUtf8EvenWithMatchingHash()
    {
        PackageCase package = CreatePackage([0xff, 0xfe]);

        AssertFalse(ArticlePackageChecksums.Verify(package.Inventory, package.Files), "article_package_source_invalid_utf8");
    }

    [Theory]
    [InlineData("line\n")]
    [InlineData("line\r\n")]
    [InlineData("\ufeffline\n")]
    [InlineData("line \t\n")]
    [InlineData("line")]
    public void ComponentDigest_PreservesExactMarkdownByteDifferences(string markdown)
    {
        PackageCase original = CreatePackage(Encoding.UTF8.GetBytes("line\noriginal"));
        PackageCase changed = CreatePackage(Encoding.UTF8.GetBytes(markdown));

        Assert.True(ArticlePackageChecksums.Verify(changed.Inventory, changed.Files).IsValid);
        Assert.NotEqual(original.Digest, changed.Digest);
        Assert.Equal(Hash(Encoding.UTF8.GetBytes(markdown)), changed.Rows.Single(row => row.Path == ArticlePath).Sha256);
    }

    [Fact]
    public void Verify_AcceptsOneThousandActualArticlesAndRejectsAChangedArticle()
    {
        var files = new List<ArticlePackageFileBytes>
        {
            new(ArticlePackageInventory.ManifestPath, "{}"u8.ToArray())
        };
        for (int index = 0; index < 1000; index++)
        {
            string path = $"articles/{index:x8}-0000-4000-8000-000000000001.md";
            files.Add(new(path, Encoding.UTF8.GetBytes($"article {index}\r\n")));
        }
        PackageCase package = BuildPackage(files);
        ArticlePackageChecksumValidationResult result = ArticlePackageChecksums.Verify(package.Inventory, package.Files);

        Assert.True(result.IsValid, result.ReasonCode);
        Assert.Equal(1001, package.Rows.Length);
        ArticlePackageFileBytes[] changed = package.Files.ToArray();
        byte[] bytes = changed[900].Bytes.ToArray();
        bytes[0] = (byte)'A';
        changed[900] = new(changed[900].Path, bytes);
        AssertFalse(ArticlePackageChecksums.Verify(package.Inventory, changed), "article_package_file_digest_mismatch");
    }

    [Fact]
    public void ComputeAndVerify_FreezeCallerListsOnceWithoutEnumerationOrCountRereads()
    {
        PackageCase package = CreatePackage();
        var inventory = new BoundedIndexList<ArticlePackageInventoryEntry>(package.Inventory, package.Inventory.Length);
        var rows = new BoundedIndexList<ArticlePackageChecksumEntry>(package.Rows, package.Rows.Length);

        ArticlePackageChecksumValidationResult computed = ArticlePackageChecksums.ComputeComponentDigest(inventory, rows);

        Assert.True(computed.IsValid, computed.ReasonCode);
        Assert.Equal(package.Digest, computed.ComponentDigest);
        Assert.Equal(1, inventory.CountReads);
        Assert.Equal(package.Inventory.Length, inventory.IndexReads);
        Assert.Equal(1, rows.CountReads);
        Assert.Equal(package.Rows.Length, rows.IndexReads);

        inventory = new(package.Inventory, package.Inventory.Length);
        var files = new BoundedIndexList<ArticlePackageFileBytes>(package.Files, package.Files.Length);
        ArticlePackageChecksumValidationResult verified = ArticlePackageChecksums.Verify(inventory, files);

        Assert.True(verified.IsValid, verified.ReasonCode);
        Assert.Equal(package.Digest, verified.ComponentDigest);
        Assert.Equal(1, inventory.CountReads);
        Assert.Equal(package.Inventory.Length, inventory.IndexReads);
        Assert.Equal(1, files.CountReads);
        Assert.Equal(package.Files.Length, files.IndexReads);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(ArticlePackageInventory.MaxEntries + 1)]
    public void ComputeAndVerify_RejectInvalidCallerCountsBeforeIndexing(int count)
    {
        PackageCase package = CreatePackage();
        var inventory = new BoundedIndexList<ArticlePackageInventoryEntry>([], count);
        Assert.False(ArticlePackageChecksums.ComputeComponentDigest(inventory, package.Rows).IsValid);
        Assert.Equal(1, inventory.CountReads);
        Assert.Equal(0, inventory.IndexReads);
        inventory = new([], count);
        Assert.False(ArticlePackageChecksums.Verify(inventory, package.Files).IsValid);
        Assert.Equal(1, inventory.CountReads);
        Assert.Equal(0, inventory.IndexReads);

        var rows = new BoundedIndexList<ArticlePackageChecksumEntry>([], count);
        Assert.False(ArticlePackageChecksums.ComputeComponentDigest(package.Inventory, rows).IsValid);
        Assert.Equal(1, rows.CountReads);
        Assert.Equal(0, rows.IndexReads);
        var files = new BoundedIndexList<ArticlePackageFileBytes>([], count);
        Assert.False(ArticlePackageChecksums.Verify(package.Inventory, files).IsValid);
        Assert.Equal(1, files.CountReads);
        Assert.Equal(0, files.IndexReads);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    public void ComputeAndVerify_RejectIndexedCopyFailureForEveryInputRole(int failure)
    {
        PackageCase package = CreatePackage();
        var inventory = new BoundedIndexList<ArticlePackageInventoryEntry>(package.Inventory, package.Inventory.Length, failure);
        Assert.False(ArticlePackageChecksums.ComputeComponentDigest(inventory, package.Rows).IsValid);
        Assert.Equal(1, inventory.CountReads);
        Assert.Equal(1, inventory.IndexReads);
        inventory = new(package.Inventory, package.Inventory.Length, failure);
        Assert.False(ArticlePackageChecksums.Verify(inventory, package.Files).IsValid);
        Assert.Equal(1, inventory.CountReads);
        Assert.Equal(1, inventory.IndexReads);

        var rows = new BoundedIndexList<ArticlePackageChecksumEntry>(package.Rows, package.Rows.Length, failure);
        Assert.False(ArticlePackageChecksums.ComputeComponentDigest(package.Inventory, rows).IsValid);
        Assert.Equal(1, rows.CountReads);
        Assert.Equal(1, rows.IndexReads);
        var files = new BoundedIndexList<ArticlePackageFileBytes>(package.Files, package.Files.Length, failure);
        Assert.False(ArticlePackageChecksums.Verify(package.Inventory, files).IsValid);
        Assert.Equal(1, files.CountReads);
        Assert.Equal(1, files.IndexReads);
    }

    [Theory]
    [InlineData("field-name")]
    [InlineData("schema-value")]
    [InlineData("path-value")]
    [InlineData("sha256-value")]
    public void Verify_RejectsEscapedUnpairedSurrogatesInOtherwiseCompleteDocument(string location)
    {
        PackageCase package = CreatePackage();
        string text = Encoding.UTF8.GetString(package.Files[^1].Bytes.Span);
        string oldValue = location switch
        {
            "field-name" => "schema",
            "schema-value" => ArticlePackageChecksums.Schema,
            "path-value" => ArticlePackageInventory.ManifestPath,
            _ => package.Rows[0].Sha256
        };
        string document = text.Replace("\"" + oldValue + "\"", "\"\\ud800\"", StringComparison.Ordinal);
        PackageCase changed = ReplaceDocument(package, Encoding.UTF8.GetBytes(document));

        AssertFalse(ArticlePackageChecksums.Verify(changed.Inventory, changed.Files), "article_package_checksum_document_invalid");
    }

    private sealed class BoundedIndexList<T>(IReadOnlyList<T> values, int firstCount, int failure = 0) : IReadOnlyList<T>
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

        public int Count => ++CountReads == 1 ? firstCount : int.MaxValue;

        public T this[int index]
        {
            get
            {
                IndexReads++;
                if (failure == 1)
                {
                    throw new ArgumentOutOfRangeException(nameof(index));
                }
                if (failure == 2)
                {
                    throw new IndexOutOfRangeException();
                }
                return values[index];
            }
        }

        public IEnumerator<T> GetEnumerator() => throw new InvalidOperationException("Input enumeration is forbidden.");

        System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();
    }

    private static PackageCase CreatePackage(byte[]? markdown = null)
        => BuildPackage(
        [
            new(ArticlePackageInventory.ManifestPath, "{\"fixture\":\"not-a-full-manifest\"}"u8.ToArray()),
            new(ArticlePath, markdown ?? Encoding.UTF8.GetBytes("\ufeff## Title\r\nline \t\r\n")),
            new(AssetPath, new byte[] { 0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3 })
        ]);

    private static PackageCase BuildPackage(IEnumerable<ArticlePackageFileBytes> source)
    {
        ArticlePackageFileBytes[] files = source.ToArray();
        ArticlePackageInventoryEntry[] inventory = [.. files.Select(file => InventoryEntry(file.Path, file.Bytes.Length)), InventoryEntry(ArticlePackageInventory.ChecksumsPath, 0)];
        ArticlePackageChecksumEntry[] rows = files.Select(file => new ArticlePackageChecksumEntry(file.Path, file.Bytes.Length, Hash(file.Bytes.Span))).ToArray();
        ArticlePackageChecksumValidationResult digest = ArticlePackageChecksums.ComputeComponentDigest(inventory, rows);
        Assert.True(digest.IsValid, digest.ReasonCode);
        var package = new PackageCase(inventory, [.. files, new(ArticlePackageInventory.ChecksumsPath, ReadOnlyMemory<byte>.Empty)], rows, digest.ComponentDigest!);
        return ReplaceDocument(package, WriteDocument(rows, package.Digest));
    }

    private static PackageCase ReplaceDocument(PackageCase package, byte[] document)
    {
        ArticlePackageFileBytes[] files = package.Files.ToArray();
        ArticlePackageInventoryEntry[] inventory = package.Inventory.ToArray();
        files[^1] = new(ArticlePackageInventory.ChecksumsPath, document);
        inventory[^1] = InventoryEntry(ArticlePackageInventory.ChecksumsPath, document.Length);
        return package with
        {
            Files = files,
            Inventory = inventory
        };
    }

    private static byte[] WriteDocument(IReadOnlyList<ArticlePackageChecksumEntry> rows, string digest, bool indented = false)
        => JsonSerializer.SerializeToUtf8Bytes(new
        {
            schema = ArticlePackageChecksums.Schema,
            version = ArticlePackageChecksums.Version,
            algorithm = ArticlePackageChecksums.Algorithm,
            componentDigest = digest,
            files = rows.Select(row => new
            {
                path = row.Path,
                byteLength = row.ByteLength,
                sha256 = row.Sha256
            })
        }, new JsonSerializerOptions
        {
            WriteIndented = indented
        });

    private static ArticlePackageInventoryEntry InventoryEntry(string path, int bytes)
        => new(path, ArticlePackageEntryKind.RegularFile, bytes, bytes);

    private static string Hash(ReadOnlySpan<byte> bytes)
        => Convert.ToHexStringLower(SHA256.HashData(bytes));

    private static void AssertFalse(ArticlePackageChecksumValidationResult result, string reason)
    {
        Assert.False(result.IsValid);
        Assert.Equal(reason, result.ReasonCode);
        Assert.Null(result.ComponentDigest);
    }

    private sealed record PackageCase(
        ArticlePackageInventoryEntry[] Inventory,
        ArticlePackageFileBytes[] Files,
        ArticlePackageChecksumEntry[] Rows,
        string Digest);
}
