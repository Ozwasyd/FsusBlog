using System.Buffers;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;

namespace FsusBlog.Server.Infrastructure.Binary;

public static class AedsBinaryWriter
{
    public static void WriteFrame(
        IAedsEncoder encoder,
        AedsFrameType frameType,
        ReadOnlySpan<byte> payload,
        IBufferWriter<byte> destination,
        ushort version = 1,
        uint flags = 0)
    {
        encoder.WriteFrame(frameType, payload, destination, version, flags);
    }

    public static byte[] WriteFrame(IAedsEncoder encoder, AedsFrameType frameType, ReadOnlySpan<byte> payload, ushort version = 1, uint flags = 0)
    {
        using var writer = new PooledByteBufferWriter(AedsFrameHeader.Size + payload.Length);
        encoder.WriteFrame(frameType, payload, writer, version, flags);
        return writer.ToArray();
    }
}
