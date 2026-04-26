using System.Buffers;
using FsusBlog.Core.Common;

namespace FsusBlog.Core.Algorithms;

public readonly record struct AedsDecodeResult(AedsFrameHeader Header, ReadOnlyMemory<byte> Payload, AedsFrameType FrameType);

public interface IAedsEncoder
{
    byte[] Encode(AedsFrameType frameType, ReadOnlySpan<byte> payload, ushort version = 1, uint flags = 0);

    void WriteFrame(AedsFrameType frameType, ReadOnlySpan<byte> payload, IBufferWriter<byte> destination, ushort version = 1, uint flags = 0);

    Result<AedsDecodeResult> TryDecode(ReadOnlyMemory<byte> frame);
}
