namespace FsusBlog.V2.Contracts;

public sealed class ProtocolException(string message) : Exception(message);

public static class Aeds
{
    private const int CrcBlockSize = sizeof(int);
    private const int CrcLongBlockSize = sizeof(long);
    private const int CrcLongPayloadSize = 64 * 1024;
    private const int CrcRowSize = byte.MaxValue + 1;
    private static readonly ushort[] CrcTable = BuildCrcTable();

    public const string ContentType = "application/octet-stream";
    public const int HeaderSize = WireHeader.HeaderSize;

    public static byte[] Encode(FrameType type, ReadOnlySpan<byte> payload)
    {
        if (!Enum.IsDefined(type) || payload.Length > WireLimits.MaxPayloadBytes)
            throw new ProtocolException("Unsupported AEDS type or payload size");

        var frame = new byte[HeaderSize + payload.Length];
        BinaryPrimitives.WriteInt32LittleEndian(frame, WireHeader.Magic);
        frame[WireHeader.VersionOffset] = WireHeader.Version;
        frame[WireHeader.LengthOffset] = HeaderSize;
        BinaryPrimitives.WriteUInt16LittleEndian(frame.AsSpan(WireHeader.TypeOffset), (ushort)type);
        BinaryPrimitives.WriteInt32LittleEndian(frame.AsSpan(WireHeader.PayloadLengthOffset), payload.Length);
        BinaryPrimitives.WriteUInt16LittleEndian(frame.AsSpan(WireHeader.CrcOffset), Crc16(payload));
        payload.CopyTo(frame.AsSpan(HeaderSize));
        return frame;
    }

    public static ReadOnlySpan<byte> Decode(ReadOnlySpan<byte> frame, FrameType expected)
    {
        var payload = Decode(frame, out var type);
        if (type != expected)
            throw new ProtocolException("Unexpected AEDS frame type");
        return payload;
    }

    public static ReadOnlySpan<byte> Decode(ReadOnlySpan<byte> frame, out FrameType type)
    {
        if (frame.Length < HeaderSize || frame.Length - HeaderSize > WireLimits.MaxPayloadBytes ||
            BinaryPrimitives.ReadInt32LittleEndian(frame) != WireHeader.Magic ||
            frame[WireHeader.VersionOffset] != WireHeader.Version ||
            frame[WireHeader.LengthOffset] != HeaderSize ||
            BinaryPrimitives.ReadUInt16LittleEndian(frame[WireHeader.FlagsOffset..]) != 0)
            throw new ProtocolException("Invalid AEDS header");

        type = (FrameType)BinaryPrimitives.ReadUInt16LittleEndian(frame[WireHeader.TypeOffset..]);
        var payload = frame[HeaderSize..];
        if (!Enum.IsDefined(type) ||
            BinaryPrimitives.ReadInt32LittleEndian(frame[WireHeader.PayloadLengthOffset..]) != payload.Length ||
            BinaryPrimitives.ReadUInt16LittleEndian(frame[WireHeader.CrcOffset..]) != Crc16(payload))
            throw new ProtocolException("Invalid AEDS type, length, or checksum");
        return payload;
    }

    private static ushort Crc16(ReadOnlySpan<byte> payload)
    {
        int crc = WireHeader.CrcInitial;
        if (payload.Length >= CrcLongPayloadSize)
        {
            crc = CrcLongBlocks(payload, crc);
            payload = payload[^(payload.Length % CrcLongBlockSize)..];
        }
        var table = CrcTable;
        for (; payload.Length >= CrcBlockSize; payload = payload[CrcBlockSize..])
        {
            // Each row advances a byte contribution by the number of bytes that follow it.
            int block = BinaryPrimitives.ReadInt32LittleEndian(payload) ^ crc;
            crc = table[3 * CrcRowSize + (block & byte.MaxValue)]
                ^ table[2 * CrcRowSize + ((block >> 8) & byte.MaxValue)]
                ^ table[CrcRowSize + ((block >> 16) & byte.MaxValue)]
                ^ table[block >>> 24];
        }
        foreach (byte value in payload)
            crc = (crc >> 8) ^ table[(crc ^ value) & byte.MaxValue];
        return (ushort)crc;
    }

    private static int CrcLongBlocks(ReadOnlySpan<byte> payload, int crc)
    {
        var table = LongCrc.Table;
        for (; payload.Length >= CrcLongBlockSize; payload = payload[CrcLongBlockSize..])
        {
            ulong block = BinaryPrimitives.ReadUInt64LittleEndian(payload) ^ (uint)crc;
            crc = table[7 * CrcRowSize + ((int)block & byte.MaxValue)]
                ^ table[6 * CrcRowSize + ((int)(block >> 8) & byte.MaxValue)]
                ^ table[5 * CrcRowSize + ((int)(block >> 16) & byte.MaxValue)]
                ^ table[4 * CrcRowSize + ((int)(block >> 24) & byte.MaxValue)]
                ^ table[3 * CrcRowSize + ((int)(block >> 32) & byte.MaxValue)]
                ^ table[2 * CrcRowSize + ((int)(block >> 40) & byte.MaxValue)]
                ^ table[CrcRowSize + ((int)(block >> 48) & byte.MaxValue)]
                ^ table[(int)(block >> 56)];
        }
        return crc;
    }

    private static ushort[] BuildCrcTable()
    {
        var table = new ushort[CrcBlockSize * CrcRowSize];
        for (var index = 0; index < CrcRowSize; index++)
        {
            var value = index;
            for (var bit = 0; bit < 8; bit++)
                value = (value >> 1) ^ ((value & 1) == 0 ? 0 : WireHeader.CrcPolynomial);
            table[index] = (ushort)value;
        }
        FillCrcRows(table, CrcRowSize);
        return table;
    }

    private static void FillCrcRows(ushort[] table, int start)
    {
        for (var index = start; index < table.Length; index++)
        {
            int previous = table[index - CrcRowSize];
            table[index] = (ushort)((previous >> 8) ^ table[previous & byte.MaxValue]);
        }
    }

    private static class LongCrc
    {
        public static readonly ushort[] Table = Build();

        private static ushort[] Build()
        {
            var table = new ushort[CrcLongBlockSize * CrcRowSize];
            CrcTable.CopyTo(table, 0);
            FillCrcRows(table, CrcTable.Length);
            return table;
        }
    }
}
