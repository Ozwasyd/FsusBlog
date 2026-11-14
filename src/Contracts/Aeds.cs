using System.Buffers.Binary;

namespace FsusBlog.V2.Contracts;

public sealed class ProtocolException(string message) : Exception(message);

public static class Aeds
{
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
        ushort crc = WireHeader.CrcInitial;
        foreach (byte value in payload)
            crc = (ushort)((crc >> 8) ^ CrcTable[(crc ^ value) & 255]);
        return crc;
    }

    private static ushort[] BuildCrcTable()
    {
        var table = new ushort[256];
        for (var index = 0; index < table.Length; index++)
        {
            var value = index;
            for (var bit = 0; bit < 8; bit++)
                value = (value >> 1) ^ ((value & 1) == 0 ? 0 : WireHeader.CrcPolynomial);
            table[index] = (ushort)value;
        }
        return table;
    }
}
