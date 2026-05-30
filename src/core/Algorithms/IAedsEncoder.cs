using System.Buffers;
using FsusBlog.Core.Common;

namespace FsusBlog.Core.Algorithms;

public readonly record struct AedsDecodeResult(AedsFrameHeader Header, ReadOnlyMemory<byte> Payload, AedsFrameType FrameType);

public interface IAedsEncoder
{
    byte[] Encode(AedsFrameType frameType, ReadOnlySpan<byte> payload, ushort version = AedsFrameHeader.CurrentVersion, uint flags = 0);

    void WriteFrame(AedsFrameType frameType, ReadOnlySpan<byte> payload, IBufferWriter<byte> destination, ushort version = AedsFrameHeader.CurrentVersion, uint flags = 0);

    void WriteHeader(AedsFrameType frameType, ReadOnlySpan<byte> payload, IBufferWriter<byte> destination, ushort version = AedsFrameHeader.CurrentVersion, uint flags = 0);

    Result<AedsDecodeResult> TryDecode(ReadOnlyMemory<byte> frame);
}
