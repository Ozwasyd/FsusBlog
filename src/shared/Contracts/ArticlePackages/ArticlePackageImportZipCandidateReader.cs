using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Shared.Contracts.ArticlePackages;

/// <summary>
/// Actual archive-byte coordinates and the owned finite file candidate. This is not an archive
/// safety, staging, persisted-source, permission or zero-write runtime qualification receipt.
/// </summary>
public sealed class ArticlePackageImportZipCandidate
{
    internal ArticlePackageImportZipCandidate(
        ArticlePackageValidatedImportCandidate candidate,
        int archiveByteLength,
        string archiveSha256)
    {
        Candidate = candidate;
        ArchiveByteLength = archiveByteLength;
        ArchiveSha256 = archiveSha256;
    }

    public ArticlePackageValidatedImportCandidate Candidate
    {
        get;
    }
    public int ArchiveByteLength
    {
        get;
    }
    public string ArchiveSha256
    {
        get;
    }

    /// <summary>The finite ZIP profile cannot establish complete archive or package authority.</summary>
    public ArticlePackageManifestCandidateResult RequireArchiveAuthority()
        => new(false, "article_package_zip_authority_unavailable");
}

/// <summary>
/// Reads a bounded, classic ZIP through the existing official System.IO.Compression owner,
/// then calls the sole finite-byte validator. No extraction, filesystem, store or network calls.
/// Unsupported ZIP metadata remains refused; this is not full import or staging acceptance.
/// </summary>
public static class ArticlePackageImportZipCandidateReader
{
    public const int MaxArchiveBytes = 128 * 1024 * 1024;

    private static readonly uint[] s_crcTable = CreateCrcTable();

    public static ArticlePackageManifestCandidateResult TryReadCandidate(
        ReadOnlySpan<byte> archiveBytes,
        out ArticlePackageImportZipCandidate? candidate,
        CancellationToken cancellationToken = default)
        => TryReadCore(archiveBytes, null, false, out candidate, cancellationToken);

    /// <summary>
    /// Reads the finite v2 asset-root profile against an explicitly supplied collection. The root
    /// codec receives inventory observed from this archive, including original compressed sizes,
    /// rather than trusting the collection's inventory. CRC and all actual bytes remain checked.
    /// Media, rights, complete archive and execution authority are not established here.
    /// </summary>
    public static ArticlePackageManifestCandidateResult TryReadCandidate(
        ReadOnlySpan<byte> archiveBytes,
        ArticlePackageManifestAssetCollectionCandidate? assets,
        out ArticlePackageImportZipCandidate? candidate,
        CancellationToken cancellationToken = default)
        => TryReadCore(archiveBytes, assets, true, out candidate, cancellationToken);

    private static ArticlePackageManifestCandidateResult TryReadCore(
        ReadOnlySpan<byte> archiveBytes,
        ArticlePackageManifestAssetCollectionCandidate? assets,
        bool withAssets,
        out ArticlePackageImportZipCandidate? candidate,
        CancellationToken cancellationToken)
    {
        candidate = null;
        if (cancellationToken.IsCancellationRequested)
        {
            return Invalid("article_package_import_cancelled");
        }
        if (withAssets && assets is null)
        {
            return Invalid("article_package_manifest_asset_root_input_invalid");
        }
        if (archiveBytes.Length < 22 || archiveBytes.Length > MaxArchiveBytes)
        {
            return Invalid("article_package_zip_byte_budget_exceeded");
        }
        try
        {
            // Freeze before structural inspection: caller storage cannot change between the
            // directory guard, official decompressor and exact archive-byte hash.
            byte[] ownedArchive = archiveBytes.ToArray();
            ArticlePackageManifestCandidateResult directoryResult = ArticlePackageImportZipDirectory.TryInspect(
                ownedArchive, out ArticlePackageImportZipEntryDescriptor[] descriptors, cancellationToken);
            if (!directoryResult.IsValid)
            {
                return directoryResult;
            }
            cancellationToken.ThrowIfCancellationRequested();
            using var source = new MemoryStream(ownedArchive, writable: false);
            using var archive = new ZipArchive(source, ZipArchiveMode.Read, leaveOpen: false, entryNameEncoding: new UTF8Encoding(false, true));
            // The directory guard already bounded the actual central-record count before this
            // official library materializes its Entries collection.
            if (archive.Entries.Count != descriptors.Length)
            {
                return Invalid("article_package_zip_structure_invalid");
            }
            var inventory = new ArticlePackageInventoryEntry[descriptors.Length];
            var files = new ArticlePackageFileBytes[descriptors.Length];
            long actualTotal = 0;
            for (int index = 0; index < descriptors.Length; index++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                ZipArchiveEntry entry = archive.Entries[index];
                ArticlePackageImportZipEntryDescriptor expected = descriptors[index];
                if (!string.Equals(entry.FullName, expected.Path, StringComparison.Ordinal)
                    || entry.Length != expected.UncompressedBytes
                    || entry.CompressedLength != expected.CompressedBytes
                    || entry.ExternalAttributes != expected.ExternalAttributes
                    || entry.Crc32 != expected.Crc32
                    || entry.IsEncrypted)
                {
                    return Invalid("article_package_zip_structure_invalid");
                }
                if (!withAssets && entry.FullName.StartsWith("assets/", StringComparison.Ordinal))
                {
                    return Invalid("article_package_manifest_assets_authority_unavailable");
                }
                if (entry.Length > ArticlePackageImportCandidateBytes.MaxTotalBytes - actualTotal)
                {
                    return Invalid("article_package_import_byte_budget_exceeded");
                }
                byte[] bytes = ReadExact(entry, cancellationToken);
                actualTotal += bytes.Length;
                inventory[index] = new(expected.Path, ArticlePackageEntryKind.RegularFile, bytes.Length, expected.CompressedBytes);
                files[index] = new(expected.Path, bytes);
            }
            cancellationToken.ThrowIfCancellationRequested();
            ArticlePackageValidatedImportCandidate? bytesCandidate;
            ArticlePackageManifestCandidateResult byteResult = withAssets
                ? ArticlePackageImportCandidateBytes.Validate(inventory, files, assets, out bytesCandidate, cancellationToken)
                : ArticlePackageImportCandidateBytes.Validate(inventory, files, out bytesCandidate, cancellationToken);
            if (!byteResult.IsValid)
            {
                return byteResult;
            }
            string archiveDigest = Convert.ToHexStringLower(SHA256.HashData(ownedArchive));
            cancellationToken.ThrowIfCancellationRequested();
            candidate = new(bytesCandidate!, ownedArchive.Length, archiveDigest);
            return new(true, null);
        }
        catch (OperationCanceledException)
        {
            return Invalid("article_package_import_cancelled");
        }
        catch (InvalidDataException)
        {
            return Invalid("article_package_zip_content_invalid");
        }
        catch (IOException)
        {
            return Invalid("article_package_zip_content_invalid");
        }
        catch (ArgumentException)
        {
            return Invalid("article_package_zip_structure_invalid");
        }
        catch (NotSupportedException)
        {
            return Invalid("article_package_zip_metadata_unsupported");
        }
    }

    private static byte[] ReadExact(ZipArchiveEntry entry, CancellationToken cancellationToken)
    {
        using Stream input = entry.Open();
        byte[] bytes = new byte[checked((int)entry.Length)];
        int position = 0;
        uint crc = uint.MaxValue;
        while (position < bytes.Length)
        {
            cancellationToken.ThrowIfCancellationRequested();
            int read = input.Read(bytes.AsSpan(position, Math.Min(64 * 1024, bytes.Length - position)));
            if (read == 0)
            {
                throw new InvalidDataException("article_package_zip_entry_length_mismatch");
            }
            foreach (byte value in bytes.AsSpan(position, read))
            {
                crc = (crc >> 8) ^ s_crcTable[(crc ^ value) & 0xff];
            }
            position += read;
        }
        cancellationToken.ThrowIfCancellationRequested();
        Span<byte> extra = stackalloc byte[1];
        if (input.Read(extra) != 0 || ~crc != entry.Crc32)
        {
            throw new InvalidDataException("article_package_zip_entry_content_mismatch");
        }
        return bytes;
    }

    private static uint[] CreateCrcTable()
    {
        // ZIP's standard reflected CRC-32 polynomial; independent fixture CRCs come from the
        // official ZIP writer, not this reader or the article-package checksum component.
        var table = new uint[256];
        for (uint index = 0; index < table.Length; index++)
        {
            uint value = index;
            for (int bit = 0; bit < 8; bit++)
            {
                value = (value & 1) != 0 ? (value >> 1) ^ 0xedb88320U : value >> 1;
            }
            table[index] = value;
        }
        return table;
    }

    private static ArticlePackageManifestCandidateResult Invalid(string reason) => new(false, reason);
}
