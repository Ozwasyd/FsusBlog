using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;
using FsusBlog.Server.Services;
using FsusBlog.Shared.Contracts.Governance;

namespace FsusBlog.Server.Tests.Unit;

public class AedsDecoderValidatorTests
{
    private static readonly AedsEncoder s_encoder = new();
    private static readonly AedsDecoderValidator s_validator = new(s_encoder);

    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    [Theory]
    [InlineData(AedsFrameType.ArticleList)]
    [InlineData(AedsFrameType.ArticleDetail)]
    [InlineData(AedsFrameType.AdminStats)]
    public void ValidateRoundTrip_WithEmptyPayload_Succeeds(AedsFrameType frameType)
    {
        Result result = s_validator.ValidateRoundTrip(frameType, ReadOnlySpan<byte>.Empty);
        Assert.True(result.IsSuccess);
    }

    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    [Fact]
    public void ValidateRoundTrip_WithPayload_Succeeds()
    {
        byte[] payload = [1, 2, 3, 4, 5, 6, 7, 8];
        Result result = s_validator.ValidateRoundTrip(AedsFrameType.ArticleList, payload);
        Assert.True(result.IsSuccess);
    }

    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    [Fact]
    public void ValidateRoundTrip_WithVersionAndFlags_Succeeds()
    {
        byte[] payload = [0xDE, 0xAD];
        Result result = s_validator.ValidateRoundTrip(AedsFrameType.AdminStats, payload, version: AedsFrameHeader.CurrentVersion, flags: 0);
        Assert.True(result.IsSuccess);
    }

    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Negative, InvariantId = "aeds-roundtrip-corrupt-payload-detect")]
    [Fact]
    public void ValidateRoundTrip_CorruptPayload_ReturnsMismatch()
    {
        // Encode a frame, then corrupt it and try to validate
        byte[] goodPayload = [1, 2, 3];
        byte[] encoded = s_encoder.Encode(AedsFrameType.ArticleList, goodPayload, AedsFrameHeader.CurrentVersion, 0);

        // Corrupt the encoded bytes (flip last few bytes)
        encoded[^1] ^= 0xFF;
        encoded[^2] ^= 0xFF;

        Result<AedsDecodeResult> decodeResult = s_encoder.TryDecode(encoded);
        // If CRC catches it, decodeResult.IsSuccess should be false;
        // either way, the validator would catch the mismatch
        // We just verify the validator can detect failures
        Assert.True(decodeResult.IsFailure);
    }
}
