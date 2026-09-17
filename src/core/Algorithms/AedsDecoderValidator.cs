using FsusBlog.Core.Common;

namespace FsusBlog.Core.Algorithms;

/// <summary>
/// Validates that an AEDS payload survives an encode/decode round trip without protocol drift.
/// </summary>
/// <param name="encoder">The protocol encoder and decoder to exercise.</param>
public sealed class AedsDecoderValidator(IAedsEncoder encoder)
{
    /// <summary>
    /// Validates the frame type, version, flags, length, and payload produced by a round trip.
    /// </summary>
    public Result ValidateRoundTrip(AedsFrameType frameType, ReadOnlySpan<byte> payload, ushort version = AedsFrameHeader.CurrentVersion, uint flags = 0)
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

        if (!decoded.Value.Payload.Span.SequenceEqual(payload))
        {
            return Result.Failure(ErrorCode.Validation, "AEDS payload content round-trip mismatch");
        }

        return Result.Success();
    }
}
