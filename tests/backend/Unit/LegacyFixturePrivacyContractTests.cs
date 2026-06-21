using System.Text.RegularExpressions;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed partial class LegacyFixturePrivacyContractTests
{
    [Fact]
    public void Legacy20260517MinimalFixture_UsesAnonymizedIdentitySamples()
    {
        string fixture = BackendTestPaths.ReadAllTextFromRoot(
            "tests/backend/Fixtures/legacy-20260517-minimal.sql");

        Assert.DoesNotContain("legacy-user", fixture, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("plaintext-refresh-token", fixture, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("127.0.0.1", fixture, StringComparison.Ordinal);
        Assert.DoesNotContain("'hash'", fixture, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("'guest'", fixture, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotMatch(LoopbackIpv4Pattern(), fixture);
    }

    [GeneratedRegex(@"'127(?:\.\d{1,3}){3}'", RegexOptions.CultureInvariant)]
    private static partial Regex LoopbackIpv4Pattern();
}
