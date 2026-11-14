using FsusBlog.V2.Core.Authentication;

namespace FsusBlog.V2.Core.Tests;

public sealed class TotpTests
{
    [Fact]
    public void MatchesRfc6238Sha1VectorsAndRefusesOldSteps()
    {
        var secret = "12345678901234567890"u8;
        Assert.Equal("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", Totp.EncodeSecret(secret));
        // RFC 6238 Appendix B uses eight digits. The applicable six are the suffix.
        Assert.Equal(1L, Totp.Match(secret, "287082", DateTimeOffset.FromUnixTimeSeconds(59), -1));
        Assert.Equal(37037036L, Totp.Match(secret, "081804", DateTimeOffset.FromUnixTimeSeconds(1111111109L), -1));
        Assert.Equal(666666666L, Totp.Match(secret, "353130", DateTimeOffset.FromUnixTimeSeconds(20000000000L), -1));
        Assert.Null(Totp.Match(secret, "287082", DateTimeOffset.FromUnixTimeSeconds(59), 1));
        Assert.Null(Totp.Match(secret, "287082", DateTimeOffset.FromUnixTimeSeconds(90), -1));
        Assert.Null(Totp.Match(secret, "２８７０８２", DateTimeOffset.FromUnixTimeSeconds(59), -1));
    }
}
