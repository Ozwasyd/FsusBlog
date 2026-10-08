using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Services.Security;

using Microsoft.Extensions.Configuration;
namespace FsusBlog.Server.Tests.Unit.SecurityHardening;

public sealed class CryptographyBoundaryTests
{
    [Fact]
    public void CryptographicRandomSource_ProducesRequestedLengthAndUniqueOutputs()
    {
        ISecurityRandomSource source = CryptographicSecurityRandomSource.Instance;
        byte[][] values = Enumerable.Range(0, 32).Select(_ => source.GetBytes(32)).ToArray();

        Assert.All(values, value => Assert.Equal(32, value.Length));
        Assert.Equal(values.Length, values.Select(Convert.ToHexString).Distinct(StringComparer.Ordinal).Count());
        Assert.Throws<ArgumentOutOfRangeException>(() => source.GetBytes(0));
    }

    [Fact]
    public void SecurityAdminPolicy_UsesInjectedSecurityRandomSourceForSnapshotIdentifiers()
    {
        var random = new RecordingRandomSource();

        var policy = new SecurityAdminPolicyService(CurrentRiskPolicyTestConfiguration.WithCurrentRiskPolicy(new ConfigurationBuilder().Build()), random);

        Assert.NotEmpty(policy.Current.SnapshotId);
        Assert.True(random.RequestedLengths.Count >= 4);
        Assert.All(random.RequestedLengths, length => Assert.Equal(8, length));
        Assert.Matches("^[a-z0-9-]+-[0-9]{17}-[0-9a-f]{16}$", policy.Current.SnapshotId);
    }

    [Theory]
    [InlineData("AABBCCDD", "aabbccdd", true)]
    [InlineData("AABBCCDD", "AABBCC00", false)]
    [InlineData("AABBCCDD", "AABBCC", false)]
    [InlineData("AABBCCDD", "not-hex!", false)]
    [InlineData(null, "AABBCCDD", false)]
    [InlineData("AABBCCDD", null, false)]
    public void FixedTimeHexComparison_FailsClosedAndAcceptsEquivalentHexCase(
        string? expected,
        string? actual,
        bool accepted)
        => Assert.Equal(accepted, SecurityStringComparisons.FixedTimeEqualsHex(expected, actual));

    [Theory]
    [InlineData("secret-token", "secret-token", true)]
    [InlineData("secret-token", "SECRET-TOKEN", false)]
    [InlineData("secret-token", "secret", false)]
    [InlineData(null, "secret-token", false)]
    [InlineData("secret-token", null, false)]
    public void FixedTimeUtf8Comparison_IsCaseSensitiveAndFailsClosed(
        string? expected,
        string? actual,
        bool accepted)
        => Assert.Equal(accepted, SecurityStringComparisons.FixedTimeEqualsUtf8(expected, actual));

    private sealed class RecordingRandomSource : ISecurityRandomSource
    {
        private byte _next = 1;
        internal List<int> RequestedLengths { get; } = [];

        public byte[] GetBytes(int length)
        {
            RequestedLengths.Add(length);
            return Enumerable.Repeat(_next++, length).ToArray();
        }
    }
}

