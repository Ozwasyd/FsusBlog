using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Infrastructure.Security;

using Microsoft.Extensions.Configuration;
namespace FsusBlog.Server.Tests.Unit;

public sealed class VisitLogIpPseudonymizerTests
{
    private static readonly DateTimeOffset s_now = DateTimeOffset.Parse("2026-07-15T12:00:00Z");
    private static readonly byte[] s_currentKey = Enumerable.Range(1, 32).Select(static value => (byte)value).ToArray();
    private static readonly byte[] s_differentKey = Enumerable.Range(33, 32).Select(static value => (byte)value).ToArray();

    [Fact]
    public void PseudonymizeCurrent_IsTruncatedKeyedPurposeAndWindowBound()
    {
        var pseudonymizer = new VisitLogIpPseudonymizer(7, s_currentKey);

        VisitLogIpPseudonym first = pseudonymizer.PseudonymizeCurrent(
            VisitLogIpPseudonymScope.Analytics,
            "198.51.100.7",
            s_now);
        VisitLogIpPseudonym repeated = pseudonymizer.PseudonymizeCurrent(
            VisitLogIpPseudonymScope.Analytics,
            "198.51.100.7",
            s_now.AddHours(1));
        VisitLogIpPseudonym securityLog = pseudonymizer.PseudonymizeCurrent(
            VisitLogIpPseudonymScope.SecurityLog,
            "198.51.100.7",
            s_now);
        VisitLogIpPseudonym nextDay = pseudonymizer.PseudonymizeCurrent(
            VisitLogIpPseudonymScope.Analytics,
            "198.51.100.7",
            s_now.AddDays(1));
        VisitLogIpPseudonym otherKey = new VisitLogIpPseudonymizer(7, s_differentKey)
            .PseudonymizeCurrent(VisitLogIpPseudonymScope.Analytics, "198.51.100.7", s_now);
        string unkeyedSha256 = Convert.ToHexStringLower(
            SHA256.HashData(Encoding.UTF8.GetBytes("198.51.100.7")));

        Assert.Equal(first, repeated);
        Assert.Equal(7, first.KeyEpoch);
        Assert.Equal(20260715, first.WindowUtc);
        Assert.Matches("^[0-9a-f]{32}$", first.Hash);
        Assert.NotEqual(first.Hash, securityLog.Hash);
        Assert.NotEqual(first.Hash, nextDay.Hash);
        Assert.NotEqual(first.Hash, otherKey.Hash);
        Assert.NotEqual(unkeyedSha256, first.Hash);
    }

    [Fact]
    public void PseudonymizeCurrent_NormalizesIpv4MappedIpv6()
    {
        var pseudonymizer = new VisitLogIpPseudonymizer(3, s_currentKey);

        string mapped = pseudonymizer.PseudonymizeCurrent(
            VisitLogIpPseudonymScope.Analytics,
            "::ffff:192.0.2.44",
            s_now).Hash;
        string ipv4 = pseudonymizer.PseudonymizeCurrent(
            VisitLogIpPseudonymScope.Analytics,
            "192.0.2.44",
            s_now).Hash;

        Assert.Equal(ipv4, mapped);
    }

    [Fact]
    public void PseudonymizeForRead_ReturnsOnlyBoundedCurrentAndPreviousEpochs()
    {
        var pseudonymizer = new VisitLogIpPseudonymizer(
            8,
            s_currentKey,
            previousEpoch: 7,
            previousKey: s_differentKey,
            previousAcceptUntilUtc: s_now.AddDays(7),
            timeProvider: new FixedTimeProvider(s_now));

        IReadOnlyList<VisitLogIpPseudonym> values = pseudonymizer.PseudonymizeForRead(
            VisitLogIpPseudonymScope.Analytics,
            "203.0.113.9",
            s_now);

        Assert.Collection(
            values,
            current => Assert.Equal(8, current.KeyEpoch),
            previous => Assert.Equal(7, previous.KeyEpoch));
    }

    [Fact]
    public void ValidateConfiguration_FailsClosedForWeakLegacyAndReusedKeys()
    {
        Assert.Contains(
            VisitLogIpPseudonymizer.ValidateConfiguration(Configuration([]), true, s_now),
            static error => error.Contains(VisitLogIpPseudonymizer.CurrentKeyKey, StringComparison.Ordinal));

        IConfiguration weak = Configuration(new Dictionary<string, string?>
        {
            [VisitLogIpPseudonymizer.CurrentEpochKey] = "1",
            [VisitLogIpPseudonymizer.CurrentKeyKey] = Convert.ToBase64String(new byte[32])
        });
        Assert.Contains(
            VisitLogIpPseudonymizer.ValidateConfiguration(weak, true, s_now),
            static error => error.Contains("strong base64", StringComparison.Ordinal));

        string encoded = Convert.ToBase64String(s_currentKey);
        IConfiguration reused = Configuration(new Dictionary<string, string?>
        {
            [VisitLogIpPseudonymizer.CurrentEpochKey] = "2",
            [VisitLogIpPseudonymizer.CurrentKeyKey] = encoded,
            [SecurityRiskPseudonymizer.CurrentKeyKey] = encoded,
            [VisitLogIpPseudonymizer.LegacyPepperKey] = "retired-pepper"
        });
        IReadOnlyList<string> errors = VisitLogIpPseudonymizer.ValidateConfiguration(reused, true, s_now);
        Assert.Contains(errors, static error => error.Contains("must not reuse Security:RiskPseudonymization:CurrentKey", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("is retired", StringComparison.Ordinal));
    }

    [Fact]
    public void ValidateConfiguration_AcceptsIndependentBoundedRotationWindow()
    {
        IConfiguration configuration = Configuration(new Dictionary<string, string?>
        {
            [VisitLogIpPseudonymizer.CurrentEpochKey] = "2",
            [VisitLogIpPseudonymizer.CurrentKeyKey] = Convert.ToBase64String(s_currentKey),
            [VisitLogIpPseudonymizer.PreviousEpochKey] = "1",
            [VisitLogIpPseudonymizer.PreviousKeyKey] = Convert.ToBase64String(s_differentKey),
            [VisitLogIpPseudonymizer.PreviousAcceptUntilUtcKey] = s_now.AddDays(7).ToString("O")
        });

        Assert.Empty(VisitLogIpPseudonymizer.ValidateConfiguration(configuration, true, s_now));
    }

    private static IConfiguration Configuration(IEnumerable<KeyValuePair<string, string?>> values)
        => new ConfigurationBuilder().AddInMemoryCollection(values).Build();

    private sealed class FixedTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => utcNow;
    }
}
