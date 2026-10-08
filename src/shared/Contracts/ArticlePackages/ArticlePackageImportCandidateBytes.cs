using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Shared.Contracts.ArticlePackages;

/// <summary>
/// Owned bytes bound to a finite manifest and checksum component. This candidate proves neither
/// archive-reader safety, observed source authority nor permission to execute an import.
/// </summary>
public sealed class ArticlePackageValidatedImportCandidate
{
    private readonly Dictionary<string, ReadOnlyMemory<byte>> _files;

    internal ArticlePackageValidatedImportCandidate(
        ArticlePackageManifestCandidate manifest,
        string checksumComponentDigest,
        string packageBytesDigest,
        ArticlePackageFileBytes[] ownedFiles)
    {
        Manifest = manifest;
        ChecksumComponentDigest = checksumComponentDigest;
        PackageBytesDigest = packageBytesDigest;
        // Validation transfers these private byte copies; none is exposed as ReadOnlyMemory.
        _files = ownedFiles.ToDictionary(file => file.Path, file => file.Bytes, StringComparer.Ordinal);
        FilePaths = Array.AsReadOnly(ownedFiles.Select(file => file.Path).ToArray());
    }

    public ArticlePackageManifestCandidate Manifest
    {
        get;
    }
    public string ChecksumComponentDigest
    {
        get;
    }
    public string PackageBytesDigest
    {
        get;
    }
    public IReadOnlyList<string> FilePaths
    {
        get;
    }

    /// <summary>Returns a detached copy of a validated file; unknown paths are rejected.</summary>
    public byte[] CopyFileBytes(string path)
    {
        if (path is null || !_files.TryGetValue(path, out ReadOnlyMemory<byte> bytes))
        {
            throw new ArgumentException("article_package_import_file_unknown");
        }
        return bytes.ToArray();
    }
}

/// <summary>
/// Validates already-read package bytes through the sole inventory, checksum, manifest and raw-byte
/// owners. It reads no archive or filesystem and grants no syntax, asset, privacy or source authority.
/// </summary>
public static class ArticlePackageImportCandidateBytes
{
    public const int MaxFiles = ArticlePackageManifestCandidateCodec.MaxArticles + 2;
    public const long MaxTotalBytes = 64L * 1024 * 1024;
    public const string DigestDomain = "fsusblog.article-package.import-candidate.bytes.v1";

    /// <summary>
    /// Freezes both collections and every byte buffer before parsing or checksum verification.
    /// Cancellation and any invalid row leave candidate null; advertised archive sizes are assertions.
    /// </summary>
    public static ArticlePackageManifestCandidateResult Validate(
        IReadOnlyList<ArticlePackageInventoryEntry>? inventory,
        IReadOnlyList<ArticlePackageFileBytes>? files,
        out ArticlePackageValidatedImportCandidate? candidate,
        CancellationToken cancellationToken = default)
    {
        candidate = null;
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!TryCopy(inventory, cancellationToken, out ArticlePackageInventoryEntry[] heldInventory)
                || !TryCopy(files, cancellationToken, out ArticlePackageFileBytes[] heldFiles)
                || heldInventory.Length != heldFiles.Length)
            {
                return Invalid("article_package_import_input_invalid");
            }
            ArticlePackageValidationResult inventoryResult = ArticlePackageInventory.Validate(heldInventory);
            if (!inventoryResult.IsValid)
            {
                return Invalid(inventoryResult.ReasonCode!);
            }
            var expected = heldInventory.ToDictionary(entry => entry.Path, StringComparer.Ordinal);
            var actualPaths = new HashSet<string>(StringComparer.Ordinal);
            long totalBytes = 0;
            foreach (ArticlePackageFileBytes file in heldFiles)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (file is null || file.Path is null || !expected.TryGetValue(file.Path, out var entry)
                    || !actualPaths.Add(file.Path))
                {
                    return Invalid("article_package_file_closure_mismatch");
                }
                if (file.Bytes.Length != entry.UncompressedBytes)
                {
                    return Invalid("article_package_file_length_mismatch");
                }
                if (file.Bytes.Length > MaxTotalBytes - totalBytes)
                {
                    return Invalid("article_package_import_byte_budget_exceeded");
                }
                totalBytes += file.Bytes.Length;
                if (file.Path.StartsWith("assets/", StringComparison.Ordinal))
                {
                    return Invalid("article_package_manifest_assets_authority_unavailable");
                }
            }
            var ownedFiles = new ArticlePackageFileBytes[heldFiles.Length];
            for (int index = 0; index < heldFiles.Length; index++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                ArticlePackageFileBytes file = heldFiles[index];
                ownedFiles[index] = new(file.Path, file.Bytes.ToArray());
            }
            cancellationToken.ThrowIfCancellationRequested();
            ArticlePackageChecksumValidationResult checksumResult = ArticlePackageChecksums.Verify(heldInventory, ownedFiles);
            cancellationToken.ThrowIfCancellationRequested();
            if (!checksumResult.IsValid)
            {
                return Invalid(checksumResult.ReasonCode!);
            }
            var byPath = ownedFiles.ToDictionary(file => file.Path, StringComparer.Ordinal);
            ArticlePackageManifestCandidateResult manifestResult = ArticlePackageManifestCandidateCodec.TryParseCandidate(
                byPath[ArticlePackageInventory.ManifestPath].Bytes.Span, out var manifest);
            cancellationToken.ThrowIfCancellationRequested();
            if (!manifestResult.IsValid || manifest is null)
            {
                return manifestResult;
            }
            if (ownedFiles.Length != manifest.Articles.Count + 2)
            {
                return Invalid("article_package_import_article_closure_mismatch");
            }
            foreach (ArticlePackageManifestArticle article in manifest.Articles)
            {
                cancellationToken.ThrowIfCancellationRequested();
                string path = $"articles/{article.PortableArticle.FileNameToken}.md";
                if (!byPath.TryGetValue(path, out var file))
                {
                    return Invalid("article_package_import_article_closure_mismatch");
                }
                ArticlePackageByteValidationResult byteResult = ArticlePackageSourceBytes.Verify(file.Bytes.Span, article.SourceBytes);
                if (!byteResult.IsValid)
                {
                    return Invalid(byteResult.ReasonCode!);
                }
            }
            Array.Sort(ownedFiles, static (left, right) => string.CompareOrdinal(left.Path, right.Path));
            string packageDigest = ComputePackageDigest(ownedFiles, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            var completed = new ArticlePackageValidatedImportCandidate(manifest, checksumResult.ComponentDigest!, packageDigest, ownedFiles);
            cancellationToken.ThrowIfCancellationRequested();
            candidate = completed;
            return new(true, null);
        }
        catch (OperationCanceledException)
        {
            return Invalid("article_package_import_cancelled");
        }
        catch (Exception)
        {
            // Caller collection/index/memory providers are untrusted. Never return a partial candidate
            // or expose their exception text, which can contain paths or private package contents.
            return Invalid(cancellationToken.IsCancellationRequested
                ? "article_package_import_cancelled"
                : "article_package_import_input_invalid");
        }
    }

    private static bool TryCopy<T>(IReadOnlyList<T>? source, CancellationToken cancellationToken, out T[] held)
    {
        held = [];
        if (source is null)
        {
            return false;
        }
        int count = source.Count;
        if (count is < 3 or > MaxFiles)
        {
            return false;
        }
        var copy = new T[count];
        for (int index = 0; index < count; index++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            copy[index] = source[index];
        }
        held = copy;
        return true;
    }

    /// <summary>
    /// Domain frame and file count use big-endian UInt32; each sorted path uses a UInt32 UTF-8
    /// length followed by its bytes, then a UInt64 data length and the exact file bytes, including
    /// checksums.json. This digest is independent of the finite manifest semantic digest.
    /// </summary>
    private static string ComputePackageDigest(ArticlePackageFileBytes[] files, CancellationToken cancellationToken)
    {
        using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        byte[] domain = Encoding.UTF8.GetBytes(DigestDomain);
        AppendLength(hash, domain.Length);
        hash.AppendData(domain);
        AppendLength(hash, files.Length);
        Span<byte> dataLength = stackalloc byte[8];
        foreach (ArticlePackageFileBytes file in files)
        {
            cancellationToken.ThrowIfCancellationRequested();
            byte[] path = Encoding.UTF8.GetBytes(file.Path);
            AppendLength(hash, path.Length);
            hash.AppendData(path);
            BinaryPrimitives.WriteUInt64BigEndian(dataLength, (ulong)file.Bytes.Length);
            hash.AppendData(dataLength);
            hash.AppendData(file.Bytes.Span);
        }
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    private static void AppendLength(IncrementalHash hash, int length)
    {
        Span<byte> bytes = stackalloc byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(bytes, (uint)length);
        hash.AppendData(bytes);
    }

    private static ArticlePackageManifestCandidateResult Invalid(string reason) => new(false, reason);
}
