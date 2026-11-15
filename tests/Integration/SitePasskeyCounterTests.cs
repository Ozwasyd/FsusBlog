using FsusBlog.V2.Server.Passkeys;

namespace FsusBlog.V2.Integration.Tests;

public sealed class SitePasskeyCounterTests
{
    [Theory]
    [InlineData(0u, 0u, true)]
    [InlineData(0u, 1u, true)]
    [InlineData(1u, 2u, true)]
    [InlineData(1u, 0u, false)]
    [InlineData(2u, 2u, false)]
    [InlineData(2u, 1u, false)]
    [InlineData(uint.MaxValue - 1, uint.MaxValue, true)]
    [InlineData(uint.MaxValue, uint.MaxValue, false)]
    public void AcceptsOnlyUnsupportedOrStrictlyIncreasingCounters(uint stored, uint verified, bool accepted)
    {
        Assert.Equal(accepted, PasskeyStore.AcceptsSignatureCounter(stored, verified));
    }
}
