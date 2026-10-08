using System.Buffers;
using System.Collections;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Shared.Contracts.ArticlePackages;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticlePackageImportCandidateByteTests
{
    [Fact]
    public void Validate_MatchesIndependentPythonByteGoldenIncludingChecksumWhitespace()
    {
        PackageCase package = CreatePackage();
        Assert.True(ArticlePackageImportCandidateBytes.Validate(package.Inventory, package.Files, out var candidate).IsValid);
        Assert.Equal("3a9b9b9ab8a63dda9bd0ceca3cf897ba7ed7d4bd99987e8b59288b648b95da40", candidate!.Manifest.SemanticDigest);
        Assert.Equal("acddaf1366c766697e4604b0a271c539a043a063acbfe13f9b1b14e4880b8cc1", candidate.ChecksumComponentDigest);
        Assert.Equal("e66cb246e7b3ac99d86c24196ec69927eda8467b58d158634f12333c960a28e4", candidate.PackageBytesDigest);
        byte[] checksumWhitespace = [.. package.Files[^1].Bytes.ToArray(), (byte)' '];
        package.Files[^1] = new("checksums.json", checksumWhitespace);
        package.Inventory[^1] = Entry(package.Files[^1]);
        Assert.True(ArticlePackageImportCandidateBytes.Validate(package.Inventory, package.Files, out var whitespace).IsValid);
        Assert.Equal("88277312d76430b02d3816b5a953a6542fe65d9ef039e578e2448b4b4a3a7a2b", whitespace!.PackageBytesDigest);
        Assert.Equal(candidate.Manifest.SemanticDigest, whitespace.Manifest.SemanticDigest);
        Assert.Equal(candidate.ChecksumComponentDigest, whitespace.ChecksumComponentDigest);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(1000)]
    public void Validate_BindsExactArticleSetAndFreezesSortedBytes(int count)
    {
        PackageCase package = CreatePackage(count);
        var inventory = new IndexOnlyList<ArticlePackageInventoryEntry>(package.Inventory);
        var files = new IndexOnlyList<ArticlePackageFileBytes>(package.Files);
        ArticlePackageManifestCandidateResult result = ArticlePackageImportCandidateBytes.Validate(inventory, files, out var candidate);

        Assert.True(result.IsValid, result.ReasonCode);
        Assert.NotNull(candidate);
        Assert.Equal(count, candidate.Manifest.Articles.Count);
        Assert.Equal(package.ComponentDigest, candidate.ChecksumComponentDigest);
        Assert.Equal(ReferenceDigest(package.Files), candidate.PackageBytesDigest);
        Assert.NotEqual(candidate.Manifest.SemanticDigest, candidate.PackageBytesDigest);
        Assert.Equal(package.Files.Select(file => file.Path).Order(StringComparer.Ordinal), candidate.FilePaths);
        Assert.Equal(1, inventory.CountReads);
        Assert.Equal(package.Inventory.Length, inventory.IndexReads);
        Assert.Equal(1, files.CountReads);
        Assert.Equal(package.Files.Length, files.IndexReads);
        byte[] expected = package.Files[1].Bytes.ToArray();
        byte[] exposed = candidate.CopyFileBytes(package.Files[1].Path);
        exposed[0] ^= 1;
        package.Buffers[1][0] ^= 1;
        package.Files[1] = new("caller-replaced", new byte[] { 1 });
        Assert.Equal(expected, candidate.CopyFileBytes(candidate.FilePaths[0]));
        Assert.Throws<NotSupportedException>(() => ((IList<string>)candidate.FilePaths)[0] = "changed");
        Assert.Throws<ArgumentException>(() => candidate.CopyFileBytes("absent"));
    }

    [Fact]
    public void Validate_RejectsEmptyNullAndOutOfBudgetListsWithoutIndexing()
    {
        PackageCase package = CreatePackage();
        AssertInvalid(null, package.Files);
        AssertInvalid(package.Inventory, null);
        AssertInvalid([], []);
        foreach (int count in new[] { -1, 0, 2, ArticlePackageImportCandidateBytes.MaxFiles + 1, int.MaxValue })
        {
            var inventory = new IndexOnlyList<ArticlePackageInventoryEntry>([], count);
            AssertInvalid(inventory, package.Files);
            Assert.Equal(1, inventory.CountReads);
            Assert.Equal(0, inventory.IndexReads);
            var files = new IndexOnlyList<ArticlePackageFileBytes>([], count);
            AssertInvalid(package.Inventory, files);
            Assert.Equal(1, files.CountReads);
            Assert.Equal(0, files.IndexReads);
        }
    }

    [Fact]
    public void Validate_RejectsZeroArticlePackageThroughActualInventoryOwner()
    {
        AssertInvalid(
            [new("manifest.json", ArticlePackageEntryKind.RegularFile, 2, 2), new("checksums.json", ArticlePackageEntryKind.RegularFile, 2, 2)],
            [new("manifest.json", "{}"u8.ToArray()), new("checksums.json", "{}"u8.ToArray())]);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    public void Validate_FailsClosedOnHostileCountAndIndexProviders(int failure)
    {
        PackageCase package = CreatePackage();
        AssertInvalid(new IndexOnlyList<ArticlePackageInventoryEntry>(package.Inventory, failure: failure), package.Files);
        AssertInvalid(package.Inventory, new IndexOnlyList<ArticlePackageFileBytes>(package.Files, failure: failure));
    }

    [Theory]
    [InlineData("null")]
    [InlineData("duplicate")]
    [InlineData("extra")]
    [InlineData("alias")]
    [InlineData("length")]
    [InlineData("tamper")]
    [InlineData("inventory-null")]
    [InlineData("symlink")]
    public void Validate_RejectsEveryBadRowWithoutPartialCandidate(string mutation)
    {
        PackageCase package = CreatePackage();
        switch (mutation)
        {
            case "null":
                package.Files[1] = null!;
                break;
            case "duplicate":
                package.Files[1] = package.Files[0];
                break;
            case "extra":
                package.Files[1] = new("articles/00000009-0000-4000-8000-000000000001.md", package.Files[1].Bytes);
                break;
            case "alias":
                package.Files[0] = new("Manifest.json", package.Files[0].Bytes);
                break;
            case "length":
                package.Files[1] = new(package.Files[1].Path, package.Files[1].Bytes[..^1]);
                break;
            case "tamper":
                package.Buffers[1][0] ^= 1;
                break;
            case "inventory-null":
                package.Inventory[1] = null!;
                break;
            default:
                package.Inventory[1] = package.Inventory[1] with
                {
                    Kind = ArticlePackageEntryKind.SymbolicLink
                };
                break;
        }
        AssertInvalid(package.Inventory, package.Files);
    }

    [Fact]
    public void Validate_RejectsManifestArticleClosureEvenWithValidChecksums()
    {
        PackageCase package = CreatePackage();
        ArticlePackageFileBytes[] files = package.Files[..^1].ToArray();
        files[1] = files[1] with
        {
            Path = "articles/00000009-0000-4000-8000-000000000001.md"
        };
        PackageCase renamed = BuildPackage(files);
        Assert.True(ArticlePackageChecksums.Verify(renamed.Inventory, renamed.Files).IsValid);
        AssertInvalid(renamed.Inventory, renamed.Files, "article_package_import_article_closure_mismatch");
        PackageCase extra = BuildPackage([.. package.Files[..^1], new("articles/00000009-0000-4000-8000-000000000001.md", "extra"u8.ToArray())]);
        Assert.True(ArticlePackageChecksums.Verify(extra.Inventory, extra.Files).IsValid);
        AssertInvalid(extra.Inventory, extra.Files, "article_package_import_article_closure_mismatch");
    }

    [Fact]
    public void Validate_RefusesAssetsWithoutInventingAnAssetMapping()
    {
        PackageCase package = CreatePackage();
        PackageCase assets = BuildPackage([.. package.Files[..^1], new("assets/00000009-0000-4000-8000-000000000001.png", new byte[] { 1, 2 })]);
        Assert.True(ArticlePackageChecksums.Verify(assets.Inventory, assets.Files).IsValid);
        AssertInvalid(assets.Inventory, assets.Files, "article_package_manifest_assets_authority_unavailable");
    }

    [Theory]
    [InlineData("length")]
    [InlineData("hash")]
    [InlineData("bom")]
    [InlineData("lf")]
    [InlineData("crlf")]
    [InlineData("cr")]
    [InlineData("final")]
    [InlineData("spaces")]
    [InlineData("tabs")]
    public void Validate_RechecksAllRawMetadataAfterMatchingManifestAndFileChecksums(string field)
    {
        PackageCase package = CreatePackage();
        Assert.True(ArticlePackageManifestCandidateCodec.TryParseCandidate(package.Files[0].Bytes.Span, out var manifest).IsValid);
        ArticlePackageManifestArticle article = manifest!.Articles[0];
        ArticlePackageByteMetadata bytes = article.SourceBytes;
        ArticlePackageByteMetadata changed = field switch
        {
            "length" => bytes with { ByteLength = bytes.ByteLength + 1 },
            "hash" => bytes with { Sha256 = new string('f', 64) },
            "bom" => bytes with { HasUtf8Bom = !bytes.HasUtf8Bom },
            "lf" => bytes with { LfCount = bytes.LfCount + 1 },
            "crlf" => bytes with { CrLfCount = bytes.CrLfCount + 1 },
            "cr" => bytes with { BareCrCount = bytes.BareCrCount + 1 },
            "final" => bytes with { FinalNewline = ArticlePackageFinalNewline.None },
            "spaces" => bytes with { TrailingSpaceCount = bytes.TrailingSpaceCount + 1 },
            _ => bytes with { TrailingTabCount = bytes.TrailingTabCount + 1 }
        };
        Assert.True(ArticlePackageManifestCandidateCodec.TryCreateCandidate([article with { SourceBytes = changed }], out var altered).IsValid);
        PackageCase modified = BuildPackage([new("manifest.json", ArticlePackageManifestCandidateCodec.WriteCandidate(altered!)), package.Files[1]]);
        Assert.True(ArticlePackageChecksums.Verify(modified.Inventory, modified.Files).IsValid);
        AssertInvalid(modified.Inventory, modified.Files, "article_package_source_byte_metadata_mismatch");
    }

    [Theory]
    [InlineData("line\n")]
    [InlineData("line\r\n")]
    [InlineData("\ufeffline\r\n")]
    [InlineData("e\u0301  \t\r\n")]
    public void Validate_RetainsExactUnicodeBomAndWhitespaceBytes(string markdown)
    {
        PackageCase package = CreatePackage(markdown: Encoding.UTF8.GetBytes(markdown));
        Assert.True(ArticlePackageImportCandidateBytes.Validate(package.Inventory, package.Files, out var candidate).IsValid);
        Assert.Equal(Encoding.UTF8.GetBytes(markdown), candidate!.CopyFileBytes(package.Files[1].Path));
        Assert.Equal(ReferenceDigest(package.Files), candidate.PackageBytesDigest);
    }

    [Fact]
    public void Validate_PackageDigestIncludesActualChecksumDocumentBytes()
    {
        PackageCase first = CreatePackage();
        Assert.True(ArticlePackageImportCandidateBytes.Validate(first.Inventory, first.Files, out var original).IsValid);
        byte[] changedDocument = [.. first.Files[^1].Bytes.Span.ToArray(), (byte)' '];
        first.Files[^1] = new("checksums.json", changedDocument);
        first.Inventory[^1] = Entry(first.Files[^1]);
        Assert.True(ArticlePackageImportCandidateBytes.Validate(first.Inventory, first.Files, out var changed).IsValid);
        Assert.Equal(original!.Manifest.SemanticDigest, changed!.Manifest.SemanticDigest);
        Assert.Equal(original.ChecksumComponentDigest, changed.ChecksumComponentDigest);
        Assert.NotEqual(original.PackageBytesDigest, changed.PackageBytesDigest);
        Assert.Equal(ReferenceDigest(first.Files), changed.PackageBytesDigest);
    }

    [Fact]
    public void Validate_RefusesMalformedManifestEvenWithMatchingChecksumRows()
    {
        PackageCase package = CreatePackage();
        PackageCase malformed = BuildPackage([new("manifest.json", "{}"u8.ToArray()), package.Files[1]]);
        Assert.True(ArticlePackageChecksums.Verify(malformed.Inventory, malformed.Files).IsValid);
        AssertInvalid(malformed.Inventory, malformed.Files);
    }

    [Fact]
    public void Validate_PreCancelledDoesNotReadInputsAndMidCopyCancellationReturnsNoCandidate()
    {
        PackageCase package = CreatePackage();
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        var inventory = new IndexOnlyList<ArticlePackageInventoryEntry>(package.Inventory);
        AssertInvalid(inventory, package.Files, "article_package_import_cancelled", cancelled.Token);
        Assert.Equal(0, inventory.CountReads);
        using var duringCopy = new CancellationTokenSource();
        var files = new IndexOnlyList<ArticlePackageFileBytes>(package.Files, onIndex: index =>
        {
            if (index == 1)
            {
                duringCopy.Cancel();
            }
        });
        AssertInvalid(package.Inventory, files, "article_package_import_cancelled", duringCopy.Token);
    }

    [Fact]
    public void Validate_RejectsPostBufferCopyCancellationAndThrowingMemoryProviders()
    {
        PackageCase package = CreatePackage();
        using var cancellation = new CancellationTokenSource();
        using var memory = new CallbackMemory(package.Files[1].Bytes.ToArray(), () => cancellation.Cancel());
        package.Files[1] = new(package.Files[1].Path, memory.Memory);
        AssertInvalid(package.Inventory, package.Files, "article_package_import_cancelled", cancellation.Token);
        using var broken = new CallbackMemory(package.Buffers[1], () => throw new IOException("private content"));
        package.Files[1] = new(package.Files[1].Path, broken.Memory);
        AssertInvalid(package.Inventory, package.Files, "article_package_import_input_invalid");
    }

    [Fact]
    public void Validate_AggregateBudgetRefusesBeforeAccessingAnyByteSpan()
    {
        byte[] data = new byte[ArticlePackageSourceBytes.MaximumByteLength];
        int spanReads = 0;
        using var memory = new CallbackMemory(data, () => spanReads++);
        ReadOnlyMemory<byte> held = memory.Memory;
        ArticlePackageFileBytes[] files =
        [
            new("manifest.json", "{}"u8.ToArray()),
            new("checksums.json", "{}"u8.ToArray()),
            new("articles/00000001-0000-4000-8000-000000000001.md", held),
            new("articles/00000002-0000-4000-8000-000000000001.md", held)
        ];
        spanReads = 0;
        AssertInvalid(files.Select(Entry).ToArray(), files, "article_package_import_byte_budget_exceeded");
        Assert.Equal(0, spanReads);
    }

    internal static PackageCase CreatePackage(int count = 1, byte[]? markdown = null)
    {
        byte[] data = markdown ?? "line  \t\r\n"u8.ToArray();
        Assert.True(ArticlePackageSourceBytes.Inspect(data, out var metadata).IsValid);
        var articles = new ArticlePackageManifestArticle[count];
        var files = new ArticlePackageFileBytes[count + 1];
        for (int index = 0; index < count; index++)
        {
            Assert.True(ArticlePackageIdentity.TryCreate(ArticlePackageIdentityKind.Article,
                $"article:{index + 1:x8}-0000-4000-8000-000000000001", out var identity).IsValid);
            articles[index] = new(identity, new(index + 1, index + 10, 1, new string('a', 64), "site", 1, null, null, null),
                "Title", null, new string('b', 64), new string('c', 64), new string('d', 64), metadata!, new(0, null, null));
            files[index + 1] = new($"articles/{identity.FileNameToken}.md", data.ToArray());
        }
        Assert.True(ArticlePackageManifestCandidateCodec.TryCreateCandidate(articles, out var manifest).IsValid);
        files[0] = new("manifest.json", ArticlePackageManifestCandidateCodec.WriteCandidate(manifest!));
        return BuildPackage(files);
    }

    internal static PackageCase BuildPackage(ArticlePackageFileBytes[] content)
    {
        ArticlePackageInventoryEntry[] inventory = [.. content.Select(Entry), new("checksums.json", ArticlePackageEntryKind.RegularFile, 1, 1)];
        ArticlePackageChecksumEntry[] rows = content.Select(file => new ArticlePackageChecksumEntry(
            file.Path, file.Bytes.Length, Convert.ToHexStringLower(SHA256.HashData(file.Bytes.Span)))).ToArray();
        ArticlePackageChecksumValidationResult digest = ArticlePackageChecksums.ComputeComponentDigest(inventory, rows);
        Assert.True(digest.IsValid, digest.ReasonCode);
        byte[] document = JsonSerializer.SerializeToUtf8Bytes(new
        {
            schema = ArticlePackageChecksums.Schema,
            version = ArticlePackageChecksums.Version,
            algorithm = ArticlePackageChecksums.Algorithm,
            componentDigest = digest.ComponentDigest,
            files = rows.Select(row => new { path = row.Path, byteLength = row.ByteLength, sha256 = row.Sha256 })
        });
        ArticlePackageFileBytes[] files = [.. content, new("checksums.json", document)];
        inventory[^1] = Entry(files[^1]);
        byte[][] buffers = files.Select(file => file.Bytes.ToArray()).ToArray();
        files = files.Select((file, index) => new ArticlePackageFileBytes(file.Path, buffers[index])).ToArray();
        return new(inventory, files, buffers, digest.ComponentDigest!);
    }

    internal sealed record PackageCase(ArticlePackageInventoryEntry[] Inventory, ArticlePackageFileBytes[] Files, byte[][] Buffers, string ComponentDigest);

    private static ArticlePackageInventoryEntry Entry(ArticlePackageFileBytes file)
        => new(file.Path, ArticlePackageEntryKind.RegularFile, file.Bytes.Length, file.Bytes.Length);

    private static void AssertInvalid(
        IReadOnlyList<ArticlePackageInventoryEntry>? inventory,
        IReadOnlyList<ArticlePackageFileBytes>? files,
        string? expectedReason = null,
        CancellationToken cancellationToken = default)
    {
        ArticlePackageManifestCandidateResult result = ArticlePackageImportCandidateBytes.Validate(inventory, files, out var candidate, cancellationToken);
        Assert.False(result.IsValid);
        Assert.Null(candidate);
        Assert.NotNull(result.ReasonCode);
        if (expectedReason is not null)
        {
            Assert.Equal(expectedReason, result.ReasonCode);
        }
    }

    private static string ReferenceDigest(IEnumerable<ArticlePackageFileBytes> source)
    {
        using var stream = new MemoryStream();
        ArticlePackageFileBytes[] files = source.OrderBy(file => file.Path, StringComparer.Ordinal).ToArray();
        byte[] domain = Encoding.UTF8.GetBytes(ArticlePackageImportCandidateBytes.DigestDomain);
        WriteNumber(stream, (ulong)domain.Length, 4);
        stream.Write(domain);
        WriteNumber(stream, (ulong)files.Length, 4);
        foreach (ArticlePackageFileBytes file in files)
        {
            byte[] path = Encoding.UTF8.GetBytes(file.Path);
            WriteNumber(stream, (ulong)path.Length, 4);
            stream.Write(path);
            WriteNumber(stream, (ulong)file.Bytes.Length, 8);
            stream.Write(file.Bytes.Span);
        }
        return Convert.ToHexStringLower(SHA256.HashData(stream.ToArray()));
    }

    private static void WriteNumber(Stream stream, ulong number, int width)
    {
        for (int shift = (width - 1) * 8; shift >= 0; shift -= 8)
        {
            stream.WriteByte((byte)(number >> shift));
        }
    }

    private sealed class IndexOnlyList<T>(T[] values, int? count = null, int failure = 0, Action<int>? onIndex = null) : IReadOnlyList<T>
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
        public int Count => failure == 3 ? throw new IOException("private count") : ++CountReads == 1 ? count ?? values.Length : int.MaxValue;
        public T this[int index]
        {
            get
            {
                IndexReads++;
                if (failure == 1)
                {
                    throw new IndexOutOfRangeException();
                }
                if (failure == 2)
                {
                    throw new IOException("private index");
                }
                onIndex?.Invoke(index);
                return values[index];
            }
        }
        public IEnumerator<T> GetEnumerator() => throw new InvalidOperationException("Enumeration forbidden.");
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }

    private sealed class CallbackMemory(byte[] bytes, Action onRead) : MemoryManager<byte>
    {
        public override Memory<byte> Memory => CreateMemory(bytes.Length);

        public override Span<byte> GetSpan()
        {
            onRead();
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
