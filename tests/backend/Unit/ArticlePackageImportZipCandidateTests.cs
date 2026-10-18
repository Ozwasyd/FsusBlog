using System.Buffers.Binary;
using System.IO.Compression;
using System.Security.Cryptography;

using FsusBlog.Shared.Contracts.ArticlePackages;
using FsusBlog.Shared.Contracts.ArticleRelations;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Actual in-memory classic ZIP controls; component candidates never grant archive or import authority.</summary>
[Trait("Category", "Unit")]
public sealed class ArticlePackageImportZipCandidateTests
{
    private const uint LocalSignature = 0x04034b50;
    private const uint CentralSignature = 0x02014b50;
    private const uint EndSignature = 0x06054b50;
    private static readonly DateTimeOffset s_zipTime = new(2026, 10, 8, 1, 2, 4, TimeSpan.Zero);

    [Theory]
    [InlineData(CompressionLevel.NoCompression)]
    [InlineData(CompressionLevel.Optimal)]
    public void Reader_ConsumesActualStoredAndDeflatedClosedPackageBytes(CompressionLevel compression)
    {
        ArticlePackageImportCandidateByteTests.PackageCase package = ArticlePackageImportCandidateByteTests.CreatePackage();
        byte[] zip = Archive(package.Files, compression);
        ArticlePackageImportZipCandidate read = Read(zip);

        Assert.Equal(zip.Length, read.ArchiveByteLength);
        Assert.Equal(Hash(zip), read.ArchiveSha256);
        Assert.Equal(package.ComponentDigest, read.Candidate.ChecksumComponentDigest);
        foreach (ArticlePackageFileBytes file in package.Files)
        {
            Assert.Equal(file.Bytes.ToArray(), read.Candidate.CopyFileBytes(file.Path));
        }
        Assert.False(read.RequireArchiveAuthority().IsValid);
        Assert.Equal("article_package_zip_authority_unavailable", read.RequireArchiveAuthority().ReasonCode);
    }

    [Theory]
    [InlineData("line\r\n", false)]
    [InlineData("line  \t\r\n", true)]
    [InlineData("原文 😀 שלום\n", true)]
    [InlineData("no final newline  ", false)]
    public void Reader_PreservesBomCrLfWhitespaceAndUnicodeOriginalBytes(string markdown, bool bom)
    {
        byte[] raw = System.Text.Encoding.UTF8.GetBytes(markdown);
        if (bom)
        {
            raw = [0xef, 0xbb, 0xbf, .. raw];
        }
        ArticlePackageImportCandidateByteTests.PackageCase package = ArticlePackageImportCandidateByteTests.CreatePackage(markdown: raw);
        ArticlePackageImportZipCandidate read = Read(Archive(package.Files));
        string path = Assert.Single(read.Candidate.FilePaths, value => value.StartsWith("articles/", StringComparison.Ordinal));

        Assert.Equal(raw, read.Candidate.CopyFileBytes(path));
        Assert.True(ArticlePackageSourceBytes.Verify(raw, read.Candidate.Manifest.Articles[0].SourceBytes).IsValid);
        Assert.Equal(bom, read.Candidate.Manifest.Articles[0].SourceBytes.HasUtf8Bom);
    }

    [Fact]
    public void Reader_ArchiveCompressionOrderAndTimeDoNotRewriteFinitePackageDigest()
    {
        ArticlePackageImportCandidateByteTests.PackageCase package = ArticlePackageImportCandidateByteTests.CreatePackage();
        byte[] first = Archive(package.Files, CompressionLevel.NoCompression);
        byte[] second = Archive(package.Files.Reverse().ToArray(), CompressionLevel.Optimal, s_zipTime.AddDays(1));
        ArticlePackageImportZipCandidate stored = Read(first);
        ArticlePackageImportZipCandidate compressed = Read(second);

        Assert.NotEqual(stored.ArchiveSha256, compressed.ArchiveSha256);
        Assert.Equal(stored.Candidate.PackageBytesDigest, compressed.Candidate.PackageBytesDigest);
        Assert.Equal(stored.Candidate.Manifest.SemanticDigest, compressed.Candidate.Manifest.SemanticDigest);
        Assert.Equal(stored.Candidate.ChecksumComponentDigest, compressed.Candidate.ChecksumComponentDigest);
    }

    [Fact]
    public void Reader_EntryAndArchiveCommentsPreserveCandidateButChangeArchiveHash()
    {
        byte[] zip = ValidArchive();
        ArticlePackageImportZipCandidate original = Read(zip);
        byte[] comment = "bounded entry comment"u8.ToArray();
        int central = Find(zip, CentralSignature);
        int insertion = central + 46 + Read16(zip, central + 28);
        byte[] withEntryComment = [.. zip.AsSpan(0, insertion), .. comment, .. zip.AsSpan(insertion)];
        Write16(withEntryComment, central + 32, checked((ushort)comment.Length));
        int end = Find(withEntryComment, EndSignature);
        Write32(withEntryComment, end + 12, Read32(withEntryComment, end + 12) + (uint)comment.Length);
        byte[] archiveComment = "bounded archive comment"u8.ToArray();
        Write16(withEntryComment, end + 20, checked((ushort)archiveComment.Length));
        byte[] commented = [.. withEntryComment, .. archiveComment];

        ArticlePackageImportZipCandidate read = Read(commented);

        Assert.Equal(original.Candidate.PackageBytesDigest, read.Candidate.PackageBytesDigest);
        Assert.NotEqual(original.ArchiveSha256, read.ArchiveSha256);
        Assert.Equal(Hash(commented), read.ArchiveSha256);
        Assert.False(read.RequireArchiveAuthority().IsValid);
    }

    [Theory]
    [InlineData(3, 0)]
    [InlineData(1003, 0)]
    [InlineData(3, 8)]
    public void Reader_RejectsAmbiguousNearestEndRecordInsideOtherwiseBoundedArchiveComment(int fakeCount, int fakeCommentLength)
    {
        byte[] zip = ValidArchive();
        int realEnd = Find(zip, EndSignature);
        // The real EOCD still advertises an exact 23-byte comment. Its comment embeds a
        // second complete footer with plausible original directory coordinates and one tail byte.
        byte[] fakeEnd = zip.AsSpan(realEnd, 22).ToArray();
        Write16(fakeEnd, 8, checked((ushort)fakeCount));
        Write16(fakeEnd, 10, checked((ushort)fakeCount));
        Write16(fakeEnd, 20, checked((ushort)fakeCommentLength));
        Write16(zip, realEnd + 20, 23);
        byte[] ambiguous = [.. zip, .. fakeEnd, 0];
        Assert.Equal(23, ambiguous.Length - realEnd - 22);
        Assert.Equal(EndSignature, Read32(ambiguous, realEnd + 22));
        Assert.Equal(Read32(zip, realEnd + 16), Read32(fakeEnd, 16));
        if (fakeCount == 3 && fakeCommentLength == 0)
        {
            // Actual library compatibility control: the tiny embedded footer can materialize
            // the original three entries. The stricter reader must reject before this path.
            using var memory = new MemoryStream(ambiguous, writable: false);
            using var official = new ZipArchive(memory, ZipArchiveMode.Read);
            Assert.Equal(3, official.Entries.Count);
        }

        ArticlePackageManifestCandidateResult result = ArticlePackageImportZipCandidateReader.TryReadCandidate(ambiguous, out var candidate);

        Assert.False(result.IsValid);
        Assert.Equal("article_package_zip_structure_invalid", result.ReasonCode);
        Assert.Null(candidate);
    }

    [Fact]
    public void Reader_PreservesActualZeroLengthMarkdownEntry()
    {
        ArticlePackageImportCandidateByteTests.PackageCase package = ArticlePackageImportCandidateByteTests.CreatePackage(markdown: []);
        ArticlePackageImportZipCandidate read = Read(Archive(package.Files, CompressionLevel.Optimal));

        Assert.Empty(read.Candidate.CopyFileBytes(package.Files[1].Path));
        Assert.Equal(0, read.Candidate.Manifest.Articles[0].SourceBytes.ByteLength);
        Assert.Equal(ArticlePackageFinalNewline.None, read.Candidate.Manifest.Articles[0].SourceBytes.FinalNewline);
    }

    [Fact]
    public void Reader_FreezesArchiveStorageAndDetachedBytesButNeverQualifiesImportPlan()
    {
        ArticlePackageImportCandidateByteTests.PackageCase package = ArticlePackageImportCandidateByteTests.CreatePackage();
        byte[] archive = Archive(package.Files);
        string originalHash = Hash(archive);
        ArticlePackageImportZipCandidate read = Read(archive);
        Array.Fill(archive, (byte)0);
        byte[] detached = read.Candidate.CopyFileBytes(package.Files[1].Path);
        Array.Fill(detached, (byte)0);
        var request = new ArticlePackageImportCandidateRequest(new ArticleRelationActorContext("actor:importer", "site:primary", new string('a', 64)),
            ArticlePackageImportCandidateMode.CreateNew, new string('b', 64),
            new DateTime(2026, 10, 8, 1, 2, 3, DateTimeKind.Utc), new DateTime(2026, 10, 8, 2, 2, 3, DateTimeKind.Utc), null);

        Assert.Equal(originalHash, read.ArchiveSha256);
        Assert.Equal(package.Files[1].Bytes.ToArray(), read.Candidate.CopyFileBytes(package.Files[1].Path));
        Assert.True(ArticlePackageImportCandidatePlanner.TryCreatePlan(read.Candidate, request, out var plan).IsValid);
        Assert.False(plan!.RequireExecutionAuthority().IsValid);
        Assert.False(read.RequireArchiveAuthority().IsValid);
    }

    [Fact]
    public void Reader_AcceptsOneThousandActualArticlesWithoutTruncation()
    {
        ArticlePackageImportCandidateByteTests.PackageCase package = ArticlePackageImportCandidateByteTests.CreatePackage(1000);
        ArticlePackageImportZipCandidate read = Read(Archive(package.Files, CompressionLevel.Optimal));

        Assert.Equal(1000, read.Candidate.Manifest.Articles.Count);
        Assert.Equal(1002, read.Candidate.FilePaths.Count);
        Assert.Equal(package.Files[^1].Bytes.ToArray(), read.Candidate.CopyFileBytes(package.Files[^1].Path));
        Assert.False(read.RequireArchiveAuthority().IsValid);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(1003)]
    public void Reader_RejectsPhysicalEntryCountsOutsideClosedBudget(int count)
    {
        ArticlePackageFileBytes[] files = Enumerable.Range(0, count).Select(index =>
            new ArticlePackageFileBytes($"articles/{index + 1:x8}-0000-4000-8000-000000000001.md", "x"u8.ToArray())).ToArray();

        Reject(Archive(files));
    }

    [Theory]
    [InlineData("empty")]
    [InlineData("not-zip")]
    [InlineData("truncated-end")]
    [InlineData("truncated-local")]
    [InlineData("prefix")]
    [InlineData("trailing")]
    public void Reader_RejectsMalformedAndIncompleteArchiveEnvelope(string fault)
    {
        byte[] zip = ValidArchive();
        byte[] changed = fault switch
        {
            "empty" => [],
            "not-zip" => "ordinary Markdown"u8.ToArray(),
            "truncated-end" => zip[..^1],
            "truncated-local" => zip[..20],
            "prefix" => [0, .. zip],
            _ => [.. zip, 0]
        };

        Reject(changed);
    }

    [Theory]
    [InlineData("disk")]
    [InlineData("central-disk")]
    [InlineData("disk-count")]
    [InlineData("total-count")]
    [InlineData("central-size")]
    [InlineData("central-offset")]
    [InlineData("zip64-count")]
    [InlineData("zip64-offset")]
    public void Reader_RejectsEndDirectoryDriftMultidiskAndZip64Sentinels(string fault)
    {
        byte[] zip = ValidArchive();
        int end = Find(zip, EndSignature);
        switch (fault)
        {
            case "disk":
                Write16(zip, end + 4, 1);
                break;
            case "central-disk":
                Write16(zip, end + 6, 1);
                break;
            case "disk-count":
                Write16(zip, end + 8, 2);
                break;
            case "total-count":
                Write16(zip, end + 10, 4);
                break;
            case "central-size":
                Write32(zip, end + 12, Read32(zip, end + 12) - 1);
                break;
            case "central-offset":
                Write32(zip, end + 16, Read32(zip, end + 16) + 1);
                break;
            case "zip64-count":
                Write16(zip, end + 8, ushort.MaxValue);
                Write16(zip, end + 10, ushort.MaxValue);
                break;
            default:
                Write32(zip, end + 16, uint.MaxValue);
                break;
        }

        Reject(zip);
    }

    [Theory]
    [InlineData("name")]
    [InlineData("flags")]
    [InlineData("method")]
    [InlineData("crc")]
    [InlineData("compressed-size")]
    [InlineData("raw-size")]
    [InlineData("offset")]
    public void Reader_RejectsLocalCentralDisagreementBeforeAdmittingAnyEntry(string fault)
    {
        byte[] zip = ValidArchive();
        int local = Find(zip, LocalSignature);
        int central = Find(zip, CentralSignature);
        switch (fault)
        {
            case "name":
                zip[local + 30] ^= 1;
                break;
            case "flags":
                Write16(zip, local + 6, 1);
                break;
            case "method":
                Write16(zip, local + 8, 8);
                break;
            case "crc":
                Write32(zip, local + 14, Read32(zip, local + 14) ^ 1);
                break;
            case "compressed-size":
                Write32(zip, local + 18, Read32(zip, local + 18) + 1);
                break;
            case "raw-size":
                Write32(zip, local + 22, Read32(zip, local + 22) + 1);
                break;
            default:
                Write32(zip, central + 42, 1);
                break;
        }

        Reject(zip);
    }

    [Theory]
    [InlineData("encrypted")]
    [InlineData("unknown-flags")]
    [InlineData("missing-descriptor")]
    [InlineData("unsupported-method")]
    public void Reader_RejectsUnsupportedOrIncompleteHeaderMetadata(string fault)
    {
        byte[] zip = ValidArchive();
        int local = Find(zip, LocalSignature);
        int central = Find(zip, CentralSignature);
        ushort flags = fault switch
        {
            "encrypted" => 1,
            "unknown-flags" => 0x4000,
            "missing-descriptor" => 8,
            _ => 0
        };
        Write16(zip, local + 6, flags);
        Write16(zip, central + 8, flags);
        if (fault == "unsupported-method")
        {
            Write16(zip, local + 8, 99);
            Write16(zip, central + 10, 99);
        }

        Reject(zip);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Reader_ConsumesActualSignedAndUnsignedStandardDataDescriptors(bool omitFirstSignature)
    {
        ArticlePackageImportCandidateByteTests.PackageCase package = ArticlePackageImportCandidateByteTests.CreatePackage();
        byte[] zip = DescriptorArchive(package.Files);
        int local = Find(zip, LocalSignature);
        Assert.Equal(8, Read16(zip, local + 6) & 8);
        Assert.Equal(0u, Read32(zip, local + 14));
        if (omitFirstSignature)
        {
            int descriptor = Find(zip, 0x08074b50);
            byte[] changed = [.. zip.AsSpan(0, descriptor), .. zip.AsSpan(descriptor + 4)];
            int end = Find(changed, EndSignature);
            Write32(changed, end + 16, Read32(changed, end + 16) - 4);
            foreach (int central in FindAll(changed, CentralSignature))
            {
                uint offset = Read32(changed, central + 42);
                if (offset > descriptor)
                {
                    Write32(changed, central + 42, offset - 4);
                }
            }
            zip = changed;
        }

        ArticlePackageImportZipCandidate read = Read(zip);

        Assert.Equal(package.ComponentDigest, read.Candidate.ChecksumComponentDigest);
        Assert.Equal(package.Files[1].Bytes.ToArray(), read.Candidate.CopyFileBytes(package.Files[1].Path));
        Assert.Equal(Hash(zip), read.ArchiveSha256);
    }

    [Theory]
    [InlineData(4)]
    [InlineData(8)]
    [InlineData(12)]
    public void Reader_RejectsDescriptorCrcAndSizeDriftWithUnchangedCentralFacts(int descriptorField)
    {
        byte[] zip = DescriptorArchive(ArticlePackageImportCandidateByteTests.CreatePackage().Files);
        int descriptor = Find(zip, 0x08074b50);
        Write32(zip, descriptor + descriptorField, Read32(zip, descriptor + descriptorField) ^ 1);

        Reject(zip);
    }

    [Theory]
    [InlineData("local-extra")]
    [InlineData("central-extra")]
    [InlineData("hardlink-extra")]
    [InlineData("symlink")]
    [InlineData("dos-reparse")]
    [InlineData("dos-directory")]
    public void Reader_RejectsExtraFieldsAndNonregularEntryAttributes(string fault)
    {
        byte[] zip = ValidArchive();
        int central = Find(zip, CentralSignature);
        if (fault == "local-extra")
        {
            zip = AddLocalExtra(zip, new byte[] { 0xfe, 0xca, 0, 0 });
        }
        else if (fault is "central-extra" or "hardlink-extra")
        {
            zip = AddCentralExtra(zip, fault == "hardlink-extra"
                ? new byte[] { 0x0d, 0, 19, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 116, 97, 114, 103, 101, 116, 0 }
                : new byte[] { 0xfe, 0xca, 0, 0 });
        }
        else if (fault == "symlink")
        {
            Write16(zip, central + 4, 0x0314);
            Write32(zip, central + 38, 0xa1ff0000);
        }
        else
        {
            Write32(zip, central + 38, fault == "dos-reparse" ? 0x400u : 0x10u);
        }

        Reject(zip);
    }

    [Theory]
    [InlineData("../escape.md")]
    [InlineData("/absolute.md")]
    [InlineData("C:/absolute.md")]
    [InlineData("articles\\escape.md")]
    [InlineData("Manifest.json")]
    [InlineData("articles/caf\u00e9.md")]
    [InlineData("articles/cafe\u0301.md")]
    [InlineData("articles/")]
    public void Reader_RejectsNoncanonicalTraversalCaseUnicodeAndDirectoryPaths(string path)
    {
        ArticlePackageImportCandidateByteTests.PackageCase package = ArticlePackageImportCandidateByteTests.CreatePackage();
        ArticlePackageFileBytes[] files = package.Files.ToArray();
        files[1] = new(path, files[1].Bytes);

        Reject(Archive(files));
    }

    [Fact]
    public void Reader_RejectsDuplicateAndUnexpectedArchiveEntriesAsWholeSet()
    {
        ArticlePackageImportCandidateByteTests.PackageCase package = ArticlePackageImportCandidateByteTests.CreatePackage();
        Reject(Archive([.. package.Files, package.Files[1]]));
        Reject(Archive([.. package.Files, new("unexpected.txt", "x"u8.ToArray())]));
        Reject(Archive(package.Files[..^1]));
    }

    [Theory]
    [InlineData("actual-crc")]
    [InlineData("forged-crc")]
    [InlineData("deflate-corrupt")]
    public void Reader_RejectsActualDataCorruptionEvenWhenHeadersAgree(string fault)
    {
        byte[] zip = ValidArchive(fault == "deflate-corrupt" ? CompressionLevel.Optimal : CompressionLevel.NoCompression);
        int local = Find(zip, LocalSignature);
        int central = Find(zip, CentralSignature);
        if (fault == "forged-crc")
        {
            uint crc = Read32(zip, local + 14) ^ 1;
            Write32(zip, local + 14, crc);
            Write32(zip, central + 16, crc);
        }
        else
        {
            int data = local + 30 + Read16(zip, local + 26) + Read16(zip, local + 28);
            zip[data] ^= 0xff;
        }

        Reject(zip);
    }

    [Theory]
    [InlineData("manifest")]
    [InlineData("markdown")]
    [InlineData("checksum")]
    public void Reader_ValidZipWithStaleChecksumsOrMetadataStillHasNoCandidate(string role)
    {
        ArticlePackageImportCandidateByteTests.PackageCase package = ArticlePackageImportCandidateByteTests.CreatePackage();
        ArticlePackageFileBytes[] files = package.Files.ToArray();
        int index = role switch
        {
            "manifest" => 0,
            "markdown" => 1,
            _ => files.Length - 1
        };
        byte[] changed = files[index].Bytes.ToArray();
        changed[^1] ^= 1;
        files[index] = new(files[index].Path, changed);

        Reject(Archive(files));
    }

    [Fact]
    public void Reader_RejectsCompressionBombAndActualAggregateOverflowBeforeCandidate()
    {
        byte[] zeros = new byte[2 * 1024 * 1024];
        ArticlePackageFileBytes[] bomb =
        [
            new("manifest.json", zeros),
            new("checksums.json", "{}"u8.ToArray()),
            new("articles/00000001-0000-4000-8000-000000000001.md", "x"u8.ToArray())
        ];
        Reject(Archive(bomb, CompressionLevel.Optimal));
        byte[] large = new byte[22 * 1024 * 1024];
        ArticlePackageFileBytes[] overflow =
        [
            new("manifest.json", large),
            new("checksums.json", large),
            new("articles/00000001-0000-4000-8000-000000000001.md", large)
        ];
        Reject(Archive(overflow, CompressionLevel.NoCompression));
    }

    [Fact]
    public void Reader_RejectsActualArchiveByteOverflowBeforeParsingOrCopying()
    {
        byte[] oversized = new byte[ArticlePackageImportZipCandidateReader.MaxArchiveBytes + 1];

        ArticlePackageManifestCandidateResult result = ArticlePackageImportZipCandidateReader.TryReadCandidate(oversized, out var candidate);

        Assert.False(result.IsValid);
        Assert.Equal("article_package_zip_byte_budget_exceeded", result.ReasonCode);
        Assert.Null(candidate);
    }

    [Fact]
    public void Reader_CancelledAndRepeatedFailuresReturnNoPartialCandidateAndLaterRunWorks()
    {
        byte[] zip = ValidArchive();
        string hash = Hash(zip);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        ArticlePackageManifestCandidateResult result = ArticlePackageImportZipCandidateReader.TryReadCandidate(zip, out var candidate, cancellation.Token);
        Assert.False(result.IsValid);
        Assert.Null(candidate);
        for (int attempt = 0; attempt < 2; attempt++)
        {
            Reject(zip[..^1]);
            Assert.Equal(hash, Read(zip).ArchiveSha256);
        }
    }

    private static ArticlePackageImportZipCandidate Read(byte[] archive)
    {
        ArticlePackageManifestCandidateResult result = ArticlePackageImportZipCandidateReader.TryReadCandidate(archive, out var candidate);
        Assert.True(result.IsValid, result.ReasonCode);
        return Assert.IsType<ArticlePackageImportZipCandidate>(candidate);
    }

    private static void Reject(byte[] archive)
    {
        ArticlePackageManifestCandidateResult result = ArticlePackageImportZipCandidateReader.TryReadCandidate(archive, out var candidate);
        Assert.False(result.IsValid);
        Assert.False(string.IsNullOrWhiteSpace(result.ReasonCode));
        Assert.Null(candidate);
    }

    private static byte[] ValidArchive(CompressionLevel compression = CompressionLevel.NoCompression)
        => Archive(ArticlePackageImportCandidateByteTests.CreatePackage().Files, compression);

    private static byte[] DescriptorArchive(IReadOnlyList<ArticlePackageFileBytes> files)
    {
        using var memory = new MemoryStream();
        using var output = new NonSeekableWriteStream(memory);
        using (var zip = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (ArticlePackageFileBytes file in files)
            {
                ZipArchiveEntry entry = zip.CreateEntry(file.Path, CompressionLevel.Optimal);
                entry.LastWriteTime = s_zipTime;
                using Stream content = entry.Open();
                content.Write(file.Bytes.Span);
            }
        }
        return memory.ToArray();
    }

    private static byte[] Archive(IReadOnlyList<ArticlePackageFileBytes> files,
        CompressionLevel compression = CompressionLevel.NoCompression, DateTimeOffset? timestamp = null)
    {
        using var memory = new MemoryStream();
        using (var zip = new ZipArchive(memory, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (ArticlePackageFileBytes file in files)
            {
                ZipArchiveEntry entry = zip.CreateEntry(file.Path, compression);
                entry.LastWriteTime = timestamp ?? s_zipTime;
                using Stream output = entry.Open();
                output.Write(file.Bytes.Span);
            }
        }
        return memory.ToArray();
    }

    // Standard classic-ZIP offsets patch official writer output; this is not a second reader.
    private static byte[] AddLocalExtra(byte[] zip, byte[] extra)
    {
        int local = Find(zip, LocalSignature);
        int insertion = local + 30 + Read16(zip, local + 26);
        byte[] changed = [.. zip.AsSpan(0, insertion), .. extra, .. zip.AsSpan(insertion)];
        Write16(changed, local + 28, checked((ushort)extra.Length));
        int end = Find(changed, EndSignature);
        Write32(changed, end + 16, Read32(changed, end + 16) + (uint)extra.Length);
        foreach (int central in FindAll(changed, CentralSignature))
        {
            uint offset = Read32(changed, central + 42);
            if (offset >= insertion)
            {
                Write32(changed, central + 42, offset + (uint)extra.Length);
            }
        }
        return changed;
    }

    private static byte[] AddCentralExtra(byte[] zip, byte[] extra)
    {
        int central = Find(zip, CentralSignature);
        int insertion = central + 46 + Read16(zip, central + 28);
        byte[] changed = [.. zip.AsSpan(0, insertion), .. extra, .. zip.AsSpan(insertion)];
        Write16(changed, central + 30, checked((ushort)extra.Length));
        int end = Find(changed, EndSignature);
        Write32(changed, end + 12, Read32(changed, end + 12) + (uint)extra.Length);
        return changed;
    }

    private static int Find(byte[] bytes, uint signature)
        => Assert.Single(FindAll(bytes, signature).Take(1));

    private static IEnumerable<int> FindAll(byte[] bytes, uint signature)
    {
        for (int index = 0; index <= bytes.Length - 4; index++)
        {
            if (Read32(bytes, index) == signature)
            {
                yield return index;
            }
        }
    }

    private static ushort Read16(byte[] bytes, int offset)
        => BinaryPrimitives.ReadUInt16LittleEndian(bytes.AsSpan(offset, 2));

    private static uint Read32(byte[] bytes, int offset)
        => BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(offset, 4));

    private static void Write16(byte[] bytes, int offset, ushort value)
        => BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(offset, 2), value);

    private static void Write32(byte[] bytes, int offset, uint value)
        => BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(offset, 4), value);

    // A real nonseekable writer forces the official ZIP owner to emit standard descriptors.
    private sealed class NonSeekableWriteStream(MemoryStream memory) : Stream
    {
        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException();
        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }
        public override void Flush() => memory.Flush();
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => memory.Write(buffer, offset, count);
        public override void Write(ReadOnlySpan<byte> buffer) => memory.Write(buffer);
    }

    private static string Hash(byte[] bytes)
        => Convert.ToHexStringLower(SHA256.HashData(bytes));
}
