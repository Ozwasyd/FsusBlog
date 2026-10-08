using System.Buffers.Binary;
using System.Text;

namespace FsusBlog.Shared.Contracts.ArticlePackages;

/// <summary>Advertised classic-ZIP directory facts, never proof of decompressed bytes or package authority.</summary>
internal sealed record ArticlePackageImportZipEntryDescriptor(
    string Path,
    int ExternalAttributes,
    long UncompressedBytes,
    long CompressedBytes,
    uint Crc32);

/// <summary>
/// Bounded classic single-disk ZIP header guard before the official ZipArchive reader. Layout follows
/// PKWARE APPNOTE 4.3.7, 4.3.9, 4.3.12 and 4.3.16. This limited profile refuses extra fields and
/// unsupported metadata; it performs no decompression, CRC calculation, extraction or full package admission.
/// </summary>
internal static class ArticlePackageImportZipDirectory
{
    private const uint EndSignature = 0x06054b50;
    private const uint CentralSignature = 0x02014b50;
    private const uint LocalSignature = 0x04034b50;
    private const uint DescriptorSignature = 0x08074b50;
    private const int EndHeaderBytes = 22;
    private const int CentralHeaderBytes = 46;
    private const int LocalHeaderBytes = 30;
    private const ushort DescriptorFlag = 0x0008;
    private const ushort Utf8Flag = 0x0800;
    private const ushort DeflateOptionFlags = 0x0006;

    internal static ArticlePackageManifestCandidateResult TryInspect(
        ReadOnlySpan<byte> archive,
        out ArticlePackageImportZipEntryDescriptor[] entries,
        CancellationToken cancellationToken = default)
    {
        entries = [];
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (archive.Length > ArticlePackageImportZipCandidateReader.MaxArchiveBytes)
            {
                return Invalid("article_package_zip_archive_budget_exceeded");
            }
            int endOffset = FindEndRecord(archive, cancellationToken);
            if (endOffset < 0)
            {
                return StructureInvalid();
            }
            ReadOnlySpan<byte> end = archive.Slice(endOffset, EndHeaderBytes);
            ushort disk = ReadUInt16(end, 4);
            ushort centralDisk = ReadUInt16(end, 6);
            ushort diskCount = ReadUInt16(end, 8);
            ushort count = ReadUInt16(end, 10);
            uint centralSize = ReadUInt32(end, 12);
            uint centralOffset = ReadUInt32(end, 16);
            if (disk != 0 || centralDisk != 0 || diskCount != count
                || count == ushort.MaxValue || centralSize == uint.MaxValue || centralOffset == uint.MaxValue)
            {
                return MetadataUnsupported();
            }
            if (count is < 3 or > ArticlePackageImportCandidateBytes.MaxFiles)
            {
                return Invalid("article_package_zip_entry_budget_exceeded");
            }
            if ((long)centralOffset + centralSize != endOffset
                || centralSize < (long)count * CentralHeaderBytes)
            {
                return StructureInvalid();
            }

            // Count and byte extent are checked before any count-dependent allocation.
            var heldEntries = new ArticlePackageImportZipEntryDescriptor[count];
            var inventory = new ArticlePackageInventoryEntry[count];
            var localRanges = new LocalRange[count];
            int centralPosition = (int)centralOffset;
            long advertisedBytes = 0;
            for (int index = 0; index < count; index++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (!Fits(centralPosition, CentralHeaderBytes, endOffset))
                {
                    return StructureInvalid();
                }
                ReadOnlySpan<byte> header = archive.Slice(centralPosition, CentralHeaderBytes);
                if (ReadUInt32(header, 0) != CentralSignature)
                {
                    return StructureInvalid();
                }
                ushort madeBy = ReadUInt16(header, 4);
                ushort needed = ReadUInt16(header, 6);
                ushort flags = ReadUInt16(header, 8);
                ushort method = ReadUInt16(header, 10);
                uint crc = ReadUInt32(header, 16);
                uint compressed = ReadUInt32(header, 20);
                uint uncompressed = ReadUInt32(header, 24);
                ushort nameLength = ReadUInt16(header, 28);
                ushort extraLength = ReadUInt16(header, 30);
                ushort commentLength = ReadUInt16(header, 32);
                ushort startDisk = ReadUInt16(header, 34);
                ushort internalAttributes = ReadUInt16(header, 36);
                uint attributes = ReadUInt32(header, 38);
                uint localOffset = ReadUInt32(header, 42);
                int host = madeBy >> 8;
                if (host is not (0 or 3) || (madeBy & 0xff) is not (10 or 20)
                    || !SupportsCompression(needed, flags, method)
                    || extraLength != 0 || startDisk != 0 || (internalAttributes & ~1) != 0
                    || compressed == uint.MaxValue || uncompressed == uint.MaxValue || localOffset == uint.MaxValue)
                {
                    return MetadataUnsupported();
                }
                if (nameLength is 0 or > ArticlePackageInventory.MaxPathCharacters)
                {
                    return Invalid("article_package_path_length_invalid");
                }
                int recordLength = CentralHeaderBytes + nameLength + commentLength;
                if (!Fits(centralPosition, recordLength, endOffset))
                {
                    return StructureInvalid();
                }
                ReadOnlySpan<byte> name = archive.Slice(centralPosition + CentralHeaderBytes, nameLength);
                foreach (byte character in name)
                {
                    if (character > 0x7f)
                    {
                        return Invalid("article_package_path_noncanonical");
                    }
                }
                int unixType = (int)(attributes >> 16) & 0xf000;
                if ((attributes & 0x0418) != 0 || name[^1] == (byte)'/'
                    || host == 3 && unixType is not (0 or 0x8000))
                {
                    return Invalid("article_package_entry_not_regular");
                }
                if (host == 0 && (attributes >> 16) != 0)
                {
                    return MetadataUnsupported();
                }
                if (uncompressed > ArticlePackageImportCandidateBytes.MaxTotalBytes - advertisedBytes)
                {
                    return Invalid("article_package_import_byte_budget_exceeded");
                }
                advertisedBytes += uncompressed;
                ArticlePackageManifestCandidateResult localResult = InspectLocal(
                    archive, (int)centralOffset, localOffset, name, needed, flags, method,
                    crc, compressed, uncompressed, out LocalRange localRange);
                if (!localResult.IsValid)
                {
                    return localResult;
                }
                string path = Encoding.ASCII.GetString(name);
                heldEntries[index] = new(path, unchecked((int)attributes), uncompressed, compressed, crc);
                inventory[index] = new(path, ArticlePackageEntryKind.RegularFile, uncompressed, compressed);
                localRanges[index] = localRange;
                centralPosition += recordLength;
            }
            if (centralPosition != endOffset)
            {
                return MetadataUnsupported();
            }

            // Central order is preserved for comparison with ZipArchive. Only private ranges are sorted.
            Array.Sort(localRanges, static (left, right) => left.Start.CompareTo(right.Start));
            int nextLocal = 0;
            foreach (LocalRange range in localRanges)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (range.Start < nextLocal)
                {
                    return StructureInvalid();
                }
                if (range.Start != nextLocal)
                {
                    return MetadataUnsupported();
                }
                nextLocal = range.End;
            }
            if (nextLocal != centralOffset)
            {
                return MetadataUnsupported();
            }
            ArticlePackageValidationResult inventoryResult = ArticlePackageInventory.Validate(inventory);
            if (!inventoryResult.IsValid)
            {
                return Invalid(inventoryResult.ReasonCode!);
            }
            cancellationToken.ThrowIfCancellationRequested();
            entries = heldEntries;
            return new(true, null);
        }
        catch (OperationCanceledException)
        {
            return Invalid("article_package_import_cancelled");
        }
    }

    private static int FindEndRecord(ReadOnlySpan<byte> archive, CancellationToken cancellationToken)
    {
        int earliest = Math.Max(0, archive.Length - EndHeaderBytes - ushort.MaxValue);
        for (int offset = archive.Length - EndHeaderBytes; offset >= earliest; offset--)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (ReadUInt32(archive, offset) == EndSignature)
            {
                // Match the official reader's nearest-signature selection. A forged later footer
                // must fail here, never fall back to an earlier directory with different bounds.
                return ReadUInt16(archive, offset + 20) == archive.Length - offset - EndHeaderBytes
                    ? offset
                    : -1;
            }
        }
        return -1;
    }

    private static ArticlePackageManifestCandidateResult InspectLocal(
        ReadOnlySpan<byte> archive,
        int centralOffset,
        uint localOffset,
        ReadOnlySpan<byte> centralName,
        ushort needed,
        ushort flags,
        ushort method,
        uint crc,
        uint compressed,
        uint uncompressed,
        out LocalRange range)
    {
        range = default;
        if (localOffset > int.MaxValue || !Fits((int)localOffset, LocalHeaderBytes, centralOffset))
        {
            return StructureInvalid();
        }
        int start = (int)localOffset;
        ReadOnlySpan<byte> header = archive.Slice(start, LocalHeaderBytes);
        if (ReadUInt32(header, 0) != LocalSignature)
        {
            return StructureInvalid();
        }
        ushort localNeeded = ReadUInt16(header, 4);
        ushort localFlags = ReadUInt16(header, 6);
        ushort localMethod = ReadUInt16(header, 8);
        uint localCrc = ReadUInt32(header, 14);
        uint localCompressed = ReadUInt32(header, 18);
        uint localUncompressed = ReadUInt32(header, 22);
        ushort nameLength = ReadUInt16(header, 26);
        ushort extraLength = ReadUInt16(header, 28);
        if (extraLength != 0 || !SupportsCompression(localNeeded, localFlags, localMethod)
            || localCompressed == uint.MaxValue || localUncompressed == uint.MaxValue)
        {
            return MetadataUnsupported();
        }
        if (localNeeded != needed || localFlags != flags || localMethod != method
            || nameLength != centralName.Length || !Fits(start, LocalHeaderBytes + nameLength, centralOffset))
        {
            return StructureInvalid();
        }
        if (!archive.Slice(start + LocalHeaderBytes, nameLength).SequenceEqual(centralName))
        {
            return StructureInvalid();
        }
        bool exactSizes = localCrc == crc && localCompressed == compressed && localUncompressed == uncompressed;
        bool descriptorZeros = (flags & DescriptorFlag) != 0
            && localCrc == 0 && localCompressed == 0 && localUncompressed == 0;
        if (!exactSizes && !descriptorZeros || method == 0 && compressed != uncompressed)
        {
            return StructureInvalid();
        }
        int payloadStart = start + LocalHeaderBytes + nameLength;
        if (compressed > int.MaxValue || !Fits(payloadStart, (int)compressed, centralOffset))
        {
            return StructureInvalid();
        }
        int payloadEnd = payloadStart + (int)compressed;
        int end = payloadEnd;
        if ((flags & DescriptorFlag) != 0)
        {
            // Both standard 12-byte and signature-prefixed 16-byte descriptors are supported.
            if (Fits(payloadEnd, 16, centralOffset) && ReadUInt32(archive, payloadEnd) == DescriptorSignature
                && DescriptorMatches(archive.Slice(payloadEnd + 4, 12), crc, compressed, uncompressed))
            {
                end += 16;
            }
            else if (Fits(payloadEnd, 12, centralOffset)
                && DescriptorMatches(archive.Slice(payloadEnd, 12), crc, compressed, uncompressed))
            {
                end += 12;
            }
            else
            {
                return StructureInvalid();
            }
        }
        range = new(start, end);
        return new(true, null);
    }

    private static bool DescriptorMatches(ReadOnlySpan<byte> bytes, uint crc, uint compressed, uint uncompressed)
        => ReadUInt32(bytes, 0) == crc
            && ReadUInt32(bytes, 4) == compressed
            && ReadUInt32(bytes, 8) == uncompressed;

    private static bool SupportsCompression(ushort needed, ushort flags, ushort method)
        => needed is 10 or 20
            && method is 0 or 8
            && (method != 8 || needed == 20)
            && (flags & ~(DescriptorFlag | Utf8Flag | (method == 8 ? DeflateOptionFlags : 0))) == 0;

    private static bool Fits(int start, int length, int limit)
        => start >= 0 && length >= 0 && start <= limit && length <= limit - start;

    private static ushort ReadUInt16(ReadOnlySpan<byte> bytes, int offset)
        => BinaryPrimitives.ReadUInt16LittleEndian(bytes.Slice(offset, 2));

    private static uint ReadUInt32(ReadOnlySpan<byte> bytes, int offset)
        => BinaryPrimitives.ReadUInt32LittleEndian(bytes.Slice(offset, 4));

    private static ArticlePackageManifestCandidateResult StructureInvalid()
        => Invalid("article_package_zip_structure_invalid");

    private static ArticlePackageManifestCandidateResult MetadataUnsupported()
        => Invalid("article_package_zip_metadata_unsupported");

    private static ArticlePackageManifestCandidateResult Invalid(string reason) => new(false, reason);

    private readonly record struct LocalRange(int Start, int End);
}
