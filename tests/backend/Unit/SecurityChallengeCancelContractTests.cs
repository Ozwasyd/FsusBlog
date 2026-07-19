using FsusBlog.Core.Cache;
using FsusBlog.Shared.Contracts.Security;

namespace FsusBlog.Server.Tests;

public sealed class SecurityChallengeCancelContractTests
{
    [Fact]
    public void CancellationRequest_RoundTripsAllServerBindings()
    {
        var request = new SecurityChallengeCancelBinaryRequest(
            "019b4b71-6300-7000-8000-000000000001",
            "notification.subscribe",
            "notification.subscribe",
            "device-123456",
            "risk-policy-v2");

        byte[] encoded = PodBinaryCodec.EncodeSecurityChallengeCancelRequest(request);

        Assert.True(PodBinaryCodec.TryDecodeSecurityChallengeCancelRequest(encoded, out SecurityChallengeCancelBinaryRequest decoded));
        Assert.Equal(request, decoded);
    }

    [Fact]
    public void CancellationRequest_RejectsTruncatedPayload()
    {
        var request = new SecurityChallengeCancelBinaryRequest(
            "019b4b71-6300-7000-8000-000000000001",
            "public.read",
            "article:42",
            "device-123456",
            "risk-policy-v2");
        byte[] encoded = PodBinaryCodec.EncodeSecurityChallengeCancelRequest(request);

        Assert.False(PodBinaryCodec.TryDecodeSecurityChallengeCancelRequest(encoded.AsMemory(0, encoded.Length - 1), out _));
    }
}
