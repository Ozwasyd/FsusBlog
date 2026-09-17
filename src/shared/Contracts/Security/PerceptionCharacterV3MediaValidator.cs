using System.Buffers.Binary;
using System.IO.Compression;

namespace FsusBlog.Shared.Contracts.Security;

internal static class PerceptionCharacterV3MediaValidator
{
    private static ReadOnlySpan<byte> PngSignature => [137, 80, 78, 71, 13, 10, 26, 10];

    public static bool IsCanonicalVisualPng(byte[] media)
    {
        ReadOnlySpan<byte> bytes = media;
        if (bytes.Length < 57 || !bytes[..8].SequenceEqual(PngSignature))
            return false;
        int offset = 8;
        if (!TryChunk(bytes, ref offset, "IHDR"u8, out ReadOnlySpan<byte> header) || header.Length != 13 ||
            BinaryPrimitives.ReadUInt32BigEndian(header) != PerceptionCharacterV3Contracts.PhysicalWidth ||
            BinaryPrimitives.ReadUInt32BigEndian(header[4..]) != PerceptionCharacterV3Contracts.PhysicalHeight ||
            header[8] != 4 || header[9] != 0 || header[10] != 0 || header[11] != 0 || header[12] != 0)
            return false;
        if (!TryChunk(bytes, ref offset, "IDAT"u8, out ReadOnlySpan<byte> imageData) ||
            !ValidateCompressedImageData(imageData))
            return false;
        return TryChunk(bytes, ref offset, "IEND"u8, out ReadOnlySpan<byte> end) &&
               end.IsEmpty && offset == bytes.Length;
    }

    public static bool IsCanonicalOpusOgg(byte[] media)
    {
        ReadOnlySpan<byte> bytes = media;
        int offset = 0;
        uint? serial = null;
        uint sequence = 0;
        ulong previousGranule = 0;
        int pageCount = 0;
        bool sawTags = false;
        bool sawAudio = false;
        bool sawEos = false;
        while (offset < bytes.Length)
        {
            if (!TryOggPage(bytes, ref offset, serial, sequence, previousGranule, out OggPage page))
                return false;
            serial ??= page.Serial;
            previousGranule = page.Granule;
            sequence++;
            if (pageCount == 0)
            {
                if (page.HeaderType != 2 || !ValidateOpusHead(page.Body))
                    return false;
            }
            else if (pageCount == 1)
            {
                if (page.HeaderType != 0 || !ValidateOpusTags(page.Body))
                    return false;
                sawTags = true;
            }
            else
            {
                if ((page.HeaderType & ~4) != 0 || page.Body.IsEmpty || page.Granule == 0)
                    return false;
                sawAudio = true;
                sawEos = (page.HeaderType & 4) != 0;
                if (sawEos && offset != bytes.Length)
                    return false;
            }
            pageCount++;
        }
        return pageCount >= 3 && sawTags && sawAudio && sawEos;
    }

    private static bool ValidateCompressedImageData(ReadOnlySpan<byte> data)
    {
        int scanlineBytes = PerceptionCharacterV3Contracts.PhysicalHeight *
            (1 + PerceptionCharacterV3Contracts.PhysicalWidth / 2);
        if (data.Length < 6 || data[0] != 0x78 || data[1] != 0xda)
            return false;
        byte[] scanlines = new byte[scanlineBytes];
        try
        {
            using var input = new MemoryStream(data.ToArray(), writable: false);
            using var zlib = new ZLibStream(input, CompressionMode.Decompress, leaveOpen: true);
            zlib.ReadExactly(scanlines);
            if (zlib.ReadByte() != -1)
                return false;
        }
        catch (InvalidDataException)
        {
            return false;
        }
        catch (EndOfStreamException)
        {
            return false;
        }
        int stride = 1 + PerceptionCharacterV3Contracts.PhysicalWidth / 2;
        for (int row = 0; row < PerceptionCharacterV3Contracts.PhysicalHeight; row++)
            if (scanlines[row * stride] != 0)
                return false;
        return BinaryPrimitives.ReadUInt32BigEndian(data[^4..]) == Adler32(scanlines);
    }

    private static bool TryChunk(ReadOnlySpan<byte> bytes, ref int offset, ReadOnlySpan<byte> expectedType, out ReadOnlySpan<byte> data)
    {
        data = default;
        if (offset > bytes.Length - 12)
            return false;
        uint length = BinaryPrimitives.ReadUInt32BigEndian(bytes[offset..]);
        if (length > int.MaxValue || offset > bytes.Length - 12 - (int)length)
            return false;
        ReadOnlySpan<byte> type = bytes.Slice(offset + 4, 4);
        data = bytes.Slice(offset + 8, (int)length);
        uint expectedCrc = BinaryPrimitives.ReadUInt32BigEndian(bytes.Slice(offset + 8 + (int)length, 4));
        offset += 12 + (int)length;
        return type.SequenceEqual(expectedType) && expectedCrc == PngCrc(type, data);
    }

    private static bool TryOggPage(ReadOnlySpan<byte> bytes, ref int offset, uint? expectedSerial, uint expectedSequence, ulong previousGranule, out OggPage page)
    {
        page = default;
        if (offset > bytes.Length - 27 || !bytes.Slice(offset, 4).SequenceEqual("OggS"u8) || bytes[offset + 4] != 0)
            return false;
        int segmentCount = bytes[offset + 26];
        if (offset > bytes.Length - 27 - segmentCount)
            return false;
        int bodyLength = 0;
        for (int i = 0; i < segmentCount; i++)
            bodyLength += bytes[offset + 27 + i];
        int pageLength = 27 + segmentCount + bodyLength;
        if (offset > bytes.Length - pageLength)
            return false;
        ReadOnlySpan<byte> pageBytes = bytes.Slice(offset, pageLength);
        uint serial = BinaryPrimitives.ReadUInt32LittleEndian(pageBytes[14..]);
        uint sequence = BinaryPrimitives.ReadUInt32LittleEndian(pageBytes[18..]);
        ulong granule = BinaryPrimitives.ReadUInt64LittleEndian(pageBytes[6..]);
        uint checksum = BinaryPrimitives.ReadUInt32LittleEndian(pageBytes[22..]);
        if ((expectedSerial.HasValue && serial != expectedSerial) || sequence != expectedSequence ||
            granule < previousGranule || checksum != OggCrc(pageBytes))
            return false;
        page = new(pageBytes[5], serial, granule, pageBytes[(27 + segmentCount)..]);
        offset += pageLength;
        return true;
    }

    private static bool ValidateOpusHead(ReadOnlySpan<byte> packet)
        => packet.Length == 19 && packet[..8].SequenceEqual("OpusHead"u8) && packet[8] == 1 &&
           packet[9] == 1 && BinaryPrimitives.ReadUInt16LittleEndian(packet[10..]) == 312 &&
           BinaryPrimitives.ReadUInt32LittleEndian(packet[12..]) == 48_000 &&
           BinaryPrimitives.ReadInt16LittleEndian(packet[16..]) == 0 && packet[18] == 0;

    private static bool ValidateOpusTags(ReadOnlySpan<byte> packet)
    {
        if (packet.Length < 16 || !packet[..8].SequenceEqual("OpusTags"u8))
            return false;
        uint vendorLength = BinaryPrimitives.ReadUInt32LittleEndian(packet[8..]);
        return vendorLength <= int.MaxValue && packet.Length == 16 + (int)vendorLength &&
               BinaryPrimitives.ReadUInt32LittleEndian(packet.Slice(12 + (int)vendorLength, 4)) == 0;
    }

    private static uint Adler32(ReadOnlySpan<byte> data)
    {
        uint a = 1;
        uint b = 0;
        foreach (byte value in data)
        {
            a = (a + value) % 65521;
            b = (b + a) % 65521;
        }
        return (b << 16) | a;
    }

    private static uint PngCrc(ReadOnlySpan<byte> type, ReadOnlySpan<byte> data)
    {
        uint crc = 0xffffffff;
        foreach (byte value in type)
            crc = PngCrcByte(crc, value);
        foreach (byte value in data)
            crc = PngCrcByte(crc, value);
        return crc ^ 0xffffffff;
    }

    private static uint PngCrcByte(uint crc, byte value)
    {
        crc ^= value;
        for (int bit = 0; bit < 8; bit++)
            crc = (crc >> 1) ^ ((crc & 1) == 0 ? 0u : 0xedb88320u);
        return crc;
    }

    private static uint OggCrc(ReadOnlySpan<byte> page)
    {
        uint crc = 0;
        for (int index = 0; index < page.Length; index++)
        {
            byte value = index is >= 22 and <= 25 ? (byte)0 : page[index];
            crc ^= (uint)value << 24;
            for (int bit = 0; bit < 8; bit++)
                crc = (crc << 1) ^ ((crc & 0x80000000u) == 0 ? 0u : 0x04c11db7u);
        }
        return crc;
    }

    private readonly ref struct OggPage(byte headerType, uint serial, ulong granule, ReadOnlySpan<byte> body)
    {
        public byte HeaderType { get; } = headerType;
        public uint Serial { get; } = serial;
        public ulong Granule { get; } = granule;
        public ReadOnlySpan<byte> Body { get; } = body;
    }
}
