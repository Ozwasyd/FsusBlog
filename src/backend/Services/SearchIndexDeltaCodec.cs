using System.Buffers;
using System.Buffers.Binary;

using FsusBlog.Core.Common;

namespace FsusBlog.Server.Services;

internal static class SearchIndexDeltaCodec
{
    private const uint PatchMagic = 0x54505346; // FSPT
    private const uint PatchVersion = 3;
    private const int HeaderSize = 24;

    public static byte[] CreatePatch(ReadOnlySpan<uint> tombstones, ReadOnlySpan<byte> appendedShardBytes)
    {
        using var tombstoneWriter = new PooledByteBufferWriter(Math.Max(256, tombstones.Length * 3));
        uint previous = 0;
        foreach (uint articleId in tombstones)
        {
            WriteVInt(tombstoneWriter, articleId - previous);
            previous = articleId;
        }

        using var writer = new PooledByteBufferWriter(HeaderSize + tombstoneWriter.WrittenCount + appendedShardBytes.Length + 64);
        WriteUInt32(writer, PatchMagic);
        WriteUInt32(writer, PatchVersion);
        WriteUInt32(writer, (uint)tombstones.Length);
        WriteUInt32(writer, (uint)tombstoneWriter.WrittenCount);
        WriteUInt32(writer, (uint)appendedShardBytes.Length);
        WriteUInt32(writer, 0);
        writer.Write(tombstoneWriter.WrittenSpan);
        writer.Write(appendedShardBytes);
        return writer.ToArray();
    }

    private static void WriteUInt32(IBufferWriter<byte> destination, uint value)
    {
        Span<byte> span = destination.GetSpan(sizeof(uint));
        BinaryPrimitives.WriteUInt32LittleEndian(span, value);
        destination.Advance(sizeof(uint));
    }

    private static void WriteVInt(IBufferWriter<byte> writer, uint value)
    {
        while (value >= 0x80)
        {
            Span<byte> span = writer.GetSpan(1);
            span[0] = (byte)(value | 0x80);
            writer.Advance(1);
            value >>= 7;
        }

        Span<byte> final = writer.GetSpan(1);
        final[0] = (byte)value;
        writer.Advance(1);
    }
}
