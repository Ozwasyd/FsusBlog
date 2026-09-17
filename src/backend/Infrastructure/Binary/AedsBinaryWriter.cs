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
        ushort version = AedsFrameHeader.CurrentVersion,
        uint flags = 0)
    {
        encoder.WriteFrame(frameType, payload, destination, version, flags);
    }
}
