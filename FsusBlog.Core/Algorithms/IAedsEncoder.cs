using FsusBlog.Core.Common;

namespace FsusBlog.Core.Algorithms;

public readonly record struct AedsDecodeResult(AedsFrameHeader Header, byte[] Payload, AedsFrameType FrameType);

public interface IAedsEncoder
{
    byte[] Encode(AedsFrameType frameType, ReadOnlySpan<byte> payload, ushort version = 1, uint flags = 0);

    Result<AedsDecodeResult> TryDecode(ReadOnlySpan<byte> frame);
}
