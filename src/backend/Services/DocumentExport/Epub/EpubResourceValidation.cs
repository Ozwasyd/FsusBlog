using System.Buffers;
using System.Buffers.Binary;
using System.IO.Compression;

namespace FsusBlog.Server.Services.DocumentExport;

/// <summary>
/// Checks bounded PNG framing/raster and WOFF2 directory/decompression integrity.
/// Complete font table semantics remain the required canonical resource verifier's
/// responsibility; these checks cannot independently certify a usable font.
/// </summary>
internal static class EpubResourceValidation
{
    internal static void Validate(DocumentExportAsset asset, long maximumBytes, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (asset.Bytes.IsDefaultOrEmpty || asset.Bytes.Length > maximumBytes
            || DocumentExportDigest.ComputeBytes(asset.Bytes.AsSpan()) != asset.Sha256)
        {
            throw new InvalidDataException("EPUB frozen resource is missing, over budget or tampered.");
        }
        if (asset.Role == "image" && asset.MediaType == "image/png")
        {
            ValidatePng(asset.Bytes.AsSpan(), maximumBytes, cancellationToken);
        }
        else if (asset.Role == "font" && asset.MediaType == "font/woff2")
        {
            ValidateWoff2(asset.Bytes.AsSpan(), maximumBytes, cancellationToken);
        }
        else
        {
            throw new InvalidDataException("EPUB media has no qualified closed decoder in this policy; format fallback is prohibited.");
        }
    }

    private static void ValidatePng(ReadOnlySpan<byte> bytes, long maximumBytes, CancellationToken cancellationToken)
    {
        if (bytes.Length < 57 || !bytes[..8].SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }))
        {
            throw new InvalidDataException("EPUB PNG signature or length is invalid.");
        }
        int position = 8;
        int width = 0;
        int height = 0;
        int bytesPerPixel = 0;
        bool ended = false;
        bool dataEnded = false;
        using var compressed = new DocumentExportBoundedMemoryStream(Math.Min(maximumBytes, int.MaxValue), "PNG compressed data exceeds its budget.");
        while (position < bytes.Length)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (bytes.Length - position < 12)
            {
                throw new InvalidDataException("EPUB PNG chunk is truncated.");
            }
            uint rawLength = BinaryPrimitives.ReadUInt32BigEndian(bytes.Slice(position, 4));
            if (rawLength > int.MaxValue || rawLength > bytes.Length - position - 12)
            {
                throw new InvalidDataException("EPUB PNG chunk exceeds its envelope.");
            }
            int length = (int)rawLength;
            ReadOnlySpan<byte> type = bytes.Slice(position + 4, 4);
            ReadOnlySpan<byte> data = bytes.Slice(position + 8, length);
            if (EpubZipValidation.Crc32(bytes.Slice(position + 4, length + 4))
                != BinaryPrimitives.ReadUInt32BigEndian(bytes.Slice(position + 8 + length, 4)))
            {
                throw new InvalidDataException("EPUB PNG chunk CRC is corrupt.");
            }
            if (type.SequenceEqual("IHDR"u8))
            {
                if (position != 8 || length != 13)
                {
                    throw new InvalidDataException("EPUB PNG must have exactly one initial IHDR.");
                }
                uint rawWidth = BinaryPrimitives.ReadUInt32BigEndian(data[..4]);
                uint rawHeight = BinaryPrimitives.ReadUInt32BigEndian(data.Slice(4, 4));
                if (rawWidth is 0 or > 32768 || rawHeight is 0 or > 32768
                    || data[8] != 8 || data[9] is not (0 or 2 or 4 or 6)
                    || data[10] != 0 || data[11] != 0 || data[12] != 0)
                {
                    throw new InvalidDataException("EPUB PNG dimensions, bit depth, color or interlace are unsupported.");
                }
                width = (int)rawWidth;
                height = (int)rawHeight;
                bytesPerPixel = data[9] switch
                {
                    0 => 1,
                    2 => 3,
                    4 => 2,
                    _ => 4
                };
            }
            else if (type.SequenceEqual("IDAT"u8))
            {
                if (width == 0 || dataEnded)
                {
                    throw new InvalidDataException("EPUB PNG IDAT order is invalid.");
                }
                compressed.Write(data);
            }
            else if (type.SequenceEqual("IEND"u8))
            {
                if (length != 0 || compressed.Length == 0 || position + 12 != bytes.Length)
                {
                    throw new InvalidDataException("EPUB PNG end or data closure is invalid.");
                }
                ended = true;
            }
            else
            {
                // Ancillary metadata, animation and alternate color profiles need explicit policies.
                throw new InvalidDataException("EPUB PNG ancillary or unknown chunks are unsupported by the closed policy.");
            }
            if (!type.SequenceEqual("IDAT"u8) && compressed.Length > 0)
            {
                dataEnded = true;
            }
            position += length + 12;
        }
        long rasterBytes = ((long)width * bytesPerPixel + 1) * height;
        if (rasterBytes > maximumBytes)
        {
            throw new DocumentExportBudgetExceededException("EPUB PNG expanded raster exceeds its budget.", "file-budget");
        }
        if (!ended || rasterBytes <= 0)
        {
            throw new InvalidDataException("EPUB PNG expanded raster exceeds its budget or is incomplete.");
        }
        compressed.Position = 0;
        using var exactSource = new ExactReadStream(compressed);
        using var decoder = new ZLibStream(exactSource, CompressionMode.Decompress, leaveOpen: true);
        var row = new byte[width * bytesPerPixel + 1];
        try
        {
            for (int index = 0; index < height; index++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                decoder.ReadExactly(row);
                if (row[0] > 4)
                {
                    throw new InvalidDataException("EPUB PNG row filter is invalid.");
                }
            }
            if (decoder.ReadByte() != -1 || compressed.Position != compressed.Length)
            {
                throw new InvalidDataException("EPUB PNG raster has trailing bytes.");
            }
        }
        catch (EndOfStreamException exception)
        {
            throw new InvalidDataException("EPUB PNG raster is truncated.", exception);
        }
    }

    private static void ValidateWoff2(ReadOnlySpan<byte> bytes, long maximumBytes, CancellationToken cancellationToken)
    {
        if (bytes.Length < 48 || !bytes[..4].SequenceEqual("wOF2"u8)
            || BinaryPrimitives.ReadUInt32BigEndian(bytes.Slice(8, 4)) != bytes.Length
            || BinaryPrimitives.ReadUInt16BigEndian(bytes.Slice(14, 2)) != 0
            || BinaryPrimitives.ReadUInt32BigEndian(bytes.Slice(4, 4)) is not (0x00010000 or 0x4f54544f)
            || bytes.Slice(28, 20).ContainsAnyExcept((byte)0))
        {
            throw new InvalidDataException("EPUB WOFF2 header, collection or private metadata is invalid.");
        }
        int tableCount = BinaryPrimitives.ReadUInt16BigEndian(bytes.Slice(12, 2));
        uint compressedLength = BinaryPrimitives.ReadUInt32BigEndian(bytes.Slice(20, 4));
        long sfntLength = 12 + 16L * tableCount;
        long decodedLength = 0;
        int position = 48;
        var tags = new HashSet<uint>();
        if (tableCount is < 8 or > 256)
        {
            throw new InvalidDataException("EPUB WOFF2 table count exceeds its closed budget.");
        }
        for (int index = 0; index < tableCount; index++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (position >= bytes.Length)
            {
                throw new InvalidDataException("EPUB WOFF2 table directory is truncated.");
            }
            byte flags = bytes[position++];
            uint tag = (uint)(flags & 63);
            if (tag == 63)
            {
                if (bytes.Length - position < 4)
                {
                    throw new InvalidDataException("EPUB WOFF2 custom tag is truncated.");
                }
                tag = BinaryPrimitives.ReadUInt32BigEndian(bytes.Slice(position, 4));
                position += 4;
                if (tag < 64)
                {
                    throw new InvalidDataException("EPUB WOFF2 custom tag is invalid.");
                }
            }
            if (!tags.Add(tag))
            {
                throw new InvalidDataException("EPUB WOFF2 duplicate table tags are invalid.");
            }
            uint originalLength = ReadBase128(bytes, ref position);
            int transformVersion = flags >> 6;
            if (tag is 10 or 11 ? transformVersion is not (0 or 3)
                : tag == 3 ? transformVersion is not (0 or 1) : transformVersion != 0)
            {
                throw new InvalidDataException("EPUB WOFF2 table transformation is unsupported.");
            }
            bool transformed = tag is 10 or 11 ? flags >> 6 == 0 : flags >> 6 != 0;
            uint tableLength = transformed ? ReadBase128(bytes, ref position) : originalLength;
            if (tag == 11 && transformed && tableLength != 0)
            {
                throw new InvalidDataException("EPUB WOFF2 transformed loca length is invalid.");
            }
            sfntLength += (originalLength + 3L) & ~3L;
            decodedLength += tableLength;
        }
        if (!new uint[] { 0, 1, 2, 3, 4, 5 }.All(tags.Contains)
            || !(tags.Contains(10) && tags.Contains(11) || tags.Contains(13)))
        {
            throw new InvalidDataException("EPUB WOFF2 lacks required single-face font tables.");
        }
        if (sfntLength > maximumBytes || decodedLength > maximumBytes)
        {
            throw new DocumentExportBudgetExceededException("EPUB WOFF2 expanded tables exceed their budget.", "file-budget");
        }
        if (sfntLength != BinaryPrimitives.ReadUInt32BigEndian(bytes.Slice(16, 4))
            || decodedLength <= 0
            || compressedLength == 0 || compressedLength > bytes.Length - position)
        {
            throw new InvalidDataException("EPUB WOFF2 table or compressed length is invalid or over budget.");
        }
        int end = checked(position + (int)compressedLength);
        if (bytes.Length - end > 3 || bytes[end..].ContainsAnyExcept((byte)0))
        {
            throw new InvalidDataException("EPUB WOFF2 has unowned trailing content.");
        }
        var buffer = new byte[8192];
        long readBytes = 0;
        int consumedBytes = 0;
        var decoder = new BrotliDecoder();
        try
        {
            while (true)
            {
                cancellationToken.ThrowIfCancellationRequested();
                OperationStatus status = decoder.Decompress(bytes.Slice(position + consumedBytes,
                    (int)compressedLength - consumedBytes), buffer, out int consumed, out int written);
                consumedBytes += consumed;
                readBytes += written;
                if (readBytes > decodedLength || status is OperationStatus.InvalidData or OperationStatus.NeedMoreData)
                {
                    throw new InvalidDataException("EPUB WOFF2 compressed tables are invalid or incomplete.");
                }
                if (status == OperationStatus.Done)
                {
                    break;
                }
                if (consumed == 0 && written == 0)
                {
                    throw new InvalidDataException("EPUB WOFF2 decoder made no progress.");
                }
            }
        }
        finally
        {
            decoder.Dispose();
        }
        if (readBytes != decodedLength || consumedBytes != compressedLength)
        {
            throw new InvalidDataException("EPUB WOFF2 decompressed tables are incomplete.");
        }
    }

    private static uint ReadBase128(ReadOnlySpan<byte> bytes, ref int position)
    {
        uint result = 0;
        for (int count = 0; count < 5 && position < bytes.Length; count++)
        {
            byte value = bytes[position++];
            if (count == 0 && value == 0x80 || (result & 0xfe000000) != 0)
            {
                throw new InvalidDataException("EPUB WOFF2 Base128 integer is invalid.");
            }
            result = (result << 7) | (uint)(value & 127);
            if ((value & 128) == 0)
            {
                return result;
            }
        }
        throw new InvalidDataException("EPUB WOFF2 Base128 integer is truncated.");
    }

    // Single-byte reads prevent the zlib decoder from hiding unread compressed
    // suffixes in a read-ahead buffer. This runs only under bounded resource sizes.
    private sealed class ExactReadStream(Stream source) : Stream
    {
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => source.Length;
        public override long Position
        {
            get => source.Position;
            set => throw new NotSupportedException();
        }
        public override int Read(byte[] buffer, int offset, int count) => source.Read(buffer, offset, Math.Min(count, 1));
        public override int Read(Span<byte> buffer) => source.Read(buffer[..Math.Min(buffer.Length, 1)]);
        public override void Flush() => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
