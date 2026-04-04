using System.Buffers;
using FsusBlog.Core.Algorithms;

namespace FsusBlog.Server.Infrastructure.Binary;

public static class AedsBinaryWriter
{
    public static byte[] WriteFrame(IAedsEncoder encoder, AedsFrameType frameType, ReadOnlySpan<byte> payload, ushort version = 1, uint flags = 0)
    {
        byte[] encoded = encoder.Encode(frameType, payload, version, flags);
        var writer = new ArrayBufferWriter<byte>(encoded.Length);
        writer.Write(encoded);
        return writer.WrittenSpan.ToArray();
    }
}
