using FsusBlog.Core.Common;

namespace FsusBlog.Core.Algorithms;

public sealed class AedsDecoderValidator(IAedsEncoder encoder)
{
    public Result ValidateRoundTrip(AedsFrameType frameType, ReadOnlySpan<byte> payload, ushort version = 1, uint flags = 0)
    {
        byte[] encoded = encoder.Encode(frameType, payload, version, flags);
        Result<AedsDecodeResult> decoded = encoder.TryDecode(encoded);

        if (!decoded.IsSuccess)
        {
            return Result.Failure(decoded.Error.Code, decoded.Error.Message);
        }

        if (decoded.Value.FrameType != frameType)
        {
            return Result.Failure(ErrorCode.Validation, "AEDS frame type round-trip mismatch");
        }

        if (decoded.Value.Header.Version != version)
        {
            return Result.Failure(ErrorCode.Validation, "AEDS version round-trip mismatch");
        }

        if (decoded.Value.Header.Flags != flags)
        {
            return Result.Failure(ErrorCode.Validation, "AEDS flags round-trip mismatch");
        }

        if (decoded.Value.Payload.Length != payload.Length)
        {
            return Result.Failure(ErrorCode.Validation, "AEDS payload size round-trip mismatch");
        }

        if (!decoded.Value.Payload.AsSpan().SequenceEqual(payload))
        {
            return Result.Failure(ErrorCode.Validation, "AEDS payload content round-trip mismatch");
        }

        return Result.Success();
    }
}
