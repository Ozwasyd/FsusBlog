using System.Buffers;
using FsusBlog.Core.Algorithms;

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
        byte[] encoded = encoder.Encode(frameType, payload, version, flags);
        destination.Write(encoded);
    }

    public static byte[] WriteFrame(IAedsEncoder encoder, AedsFrameType frameType, ReadOnlySpan<byte> payload, ushort version = 1, uint flags = 0)
    {
        return encoder.Encode(frameType, payload, version, flags);
    }
}
