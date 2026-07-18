using System.Net;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Infrastructure.Security;
using Microsoft.Extensions.Configuration;
namespace FsusBlog.Server.Tests.Unit;

public sealed class SecurityRiskPseudonymizerTests
{
    private static readonly DateTimeOffset s_now = DateTimeOffset.Parse("2026-07-15T00:00:00Z");
    private static readonly byte[] s_currentKey = Enumerable.Range(1, 32).Select(static value => (byte)value).ToArray();
    private static readonly byte[] s_differentKey = Enumerable.Range(33, 32).Select(static value => (byte)value).ToArray();

    [Fact]
    public void PseudonymizeCurrent_IsDeterministicDomainSeparatedAndKeyed()
    {
        var pseudonymizer = new SecurityRiskPseudonymizer(7, s_currentKey);

        SecurityRiskPseudonym first = pseudonymizer.PseudonymizeCurrent(
            SecurityRiskIdentityDomain.ClientIp,
            "198.51.100.7");
        SecurityRiskPseudonym repeated = pseudonymizer.PseudonymizeCurrent(
            SecurityRiskIdentityDomain.ClientIp,
            "198.51.100.7");
        SecurityRiskPseudonym device = pseudonymizer.PseudonymizeCurrent(
            SecurityRiskIdentityDomain.DeviceFingerprint,
            "198.51.100.7");
        SecurityRiskPseudonym otherKey = new SecurityRiskPseudonymizer(7, s_differentKey)
            .PseudonymizeCurrent(SecurityRiskIdentityDomain.ClientIp, "198.51.100.7");
        string unkeyedSha256 = Convert.ToHexStringLower(
            SHA256.HashData(Encoding.UTF8.GetBytes("198.51.100.7")));

        Assert.Equal(first, repeated);
        Assert.Equal(7, first.Epoch);
        Assert.NotEqual(first.Hash, device.Hash);
        Assert.NotEqual(first.Hash, otherKey.Hash);
        Assert.NotEqual(unkeyedSha256, first.Hash);
    }

    [Fact]
    public void PseudonymizeCurrent_NormalizesIpv4MappedIpv6()
    {
        var pseudonymizer = new SecurityRiskPseudonymizer(3, s_currentKey);
        string mapped = pseudonymizer.PseudonymizeCurrent(
            SecurityRiskIdentityDomain.ClientIp,
            "::ffff:192.0.2.44").Hash;
        string ipv4 = pseudonymizer.PseudonymizeCurrent(
            SecurityRiskIdentityDomain.ClientIp,
            IPAddress.Parse("192.0.2.44").ToString()).Hash;

        Assert.Equal(ipv4, mapped);
    }

    [Fact]
    public void PseudonymizeForRead_ReturnsCurrentAndUnexpiredPreviousEpoch()
    {
        var clock = new FixedTimeProvider(s_now);
        var pseudonymizer = new SecurityRiskPseudonymizer(
            8,
            s_currentKey,
            previousEpoch: 7,
            previousKey: s_differentKey,
            previousAcceptUntilUtc: s_now.AddDays(7),
            timeProvider: clock);

        IReadOnlyList<SecurityRiskPseudonym> values = pseudonymizer.PseudonymizeForRead(
            SecurityRiskIdentityDomain.AccountSubject,
            "ANONYMOUS\0ABCDEF");

        Assert.Collection(
            values,
            current => Assert.Equal(8, current.Epoch),
            previous => Assert.Equal(7, previous.Epoch));
    }

    [Fact]
    public void PseudonymizeForRead_DropsExpiredPreviousEpoch()
    {
        var pseudonymizer = new SecurityRiskPseudonymizer(
            8,
            s_currentKey,
            previousEpoch: 7,
            previousKey: s_differentKey,
            previousAcceptUntilUtc: s_now.AddSeconds(-1),
            timeProvider: new FixedTimeProvider(s_now));

        SecurityRiskPseudonym value = Assert.Single(pseudonymizer.PseudonymizeForRead(
            SecurityRiskIdentityDomain.ClientIp,
            "203.0.113.9"));

        Assert.Equal(8, value.Epoch);
    }

    [Fact]
    public void ValidateConfiguration_FailsClosedForMissingWeakTemplateAndReusedKeys()
    {
        Assert.Contains(
            SecurityRiskPseudonymizer.ValidateConfiguration(Configuration([]), true, s_now),
            static error => error.Contains(SecurityRiskPseudonymizer.CurrentKeyKey, StringComparison.Ordinal));

        IConfiguration weak = Configuration(new Dictionary<string, string?>
        {
            [SecurityRiskPseudonymizer.CurrentEpochKey] = "1",
            [SecurityRiskPseudonymizer.CurrentKeyKey] = Convert.ToBase64String(new byte[32])
        });
        Assert.Contains(
            SecurityRiskPseudonymizer.ValidateConfiguration(weak, true, s_now),
            static error => error.Contains("strong base64", StringComparison.Ordinal));

        IConfiguration template = Configuration(new Dictionary<string, string?>
        {
            [SecurityRiskPseudonymizer.CurrentEpochKey] = "1",
            [SecurityRiskPseudonymizer.CurrentKeyKey] = Convert.ToBase64String(Encoding.UTF8.GetBytes("replace-this-example-key-123456789"))
        });
        Assert.Contains(
            SecurityRiskPseudonymizer.ValidateConfiguration(template, true, s_now),
            static error => error.Contains("strong base64", StringComparison.Ordinal));

        string encoded = Convert.ToBase64String(s_currentKey);
        IConfiguration reused = Configuration(new Dictionary<string, string?>
        {
            [SecurityRiskPseudonymizer.CurrentEpochKey] = "2",
            [SecurityRiskPseudonymizer.CurrentKeyKey] = encoded,
            ["Jwt:SecretKey"] = encoded
        });
        Assert.Contains(
            SecurityRiskPseudonymizer.ValidateConfiguration(reused, true, s_now),
            static error => error.Contains("must not reuse Jwt:SecretKey", StringComparison.Ordinal));
    }

    [Fact]
    public void ValidateConfiguration_AcceptsBoundedIndependentRotationWindow()
    {
        IConfiguration configuration = Configuration(new Dictionary<string, string?>
        {
            [SecurityRiskPseudonymizer.CurrentEpochKey] = "2",
            [SecurityRiskPseudonymizer.CurrentKeyKey] = Convert.ToBase64String(s_currentKey),
            [SecurityRiskPseudonymizer.PreviousEpochKey] = "1",
            [SecurityRiskPseudonymizer.PreviousKeyKey] = Convert.ToBase64String(s_differentKey),
            [SecurityRiskPseudonymizer.PreviousAcceptUntilUtcKey] = s_now.AddDays(30).ToString("O")
        });

        Assert.Empty(SecurityRiskPseudonymizer.ValidateConfiguration(configuration, true, s_now));
    }

    private static IConfiguration Configuration(IEnumerable<KeyValuePair<string, string?>> values)
        => new ConfigurationBuilder().AddInMemoryCollection(values).Build();

    private sealed class FixedTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => utcNow;
    }
}
