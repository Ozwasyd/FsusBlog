using System.Reflection;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Tests.Unit;

public sealed class UserSessionMetadataProtectionTests
{
    private static readonly byte[] s_firstKey = Enumerable.Range(1, 32).Select(static value => (byte)value).ToArray();
    private static readonly byte[] s_secondKey = Enumerable.Range(33, 32).Select(static value => (byte)value).ToArray();

    [Fact]
    public void Capture_StoresOnlyAccountScopedRotatingPseudonymsAndCoarseLabels()
    {
        var protector = new UserSessionMetadataProtector(new SecurityRiskPseudonymizer(7, s_firstKey));

        UserSessionMetadataSnapshot first = protector.Capture(
            42,
            "203.0.113.187",
            "Client-Supplied-Fingerprint",
            "Mozilla/5.0 (Windows NT 10.0) AppleWebKit Chrome/124.0 Safari/537.36");
        UserSessionMetadataSnapshot repeated = protector.Capture(
            42,
            "203.0.113.9",
            " client-supplied-fingerprint ",
            "Mozilla/5.0 (Windows NT 10.0) AppleWebKit Chrome/124.0 Safari/537.36");
        UserSessionMetadataSnapshot otherAccount = protector.Capture(
            43,
            "203.0.113.187",
            "Client-Supplied-Fingerprint",
            "Mozilla/5.0 (Windows NT 10.0) AppleWebKit Chrome/124.0 Safari/537.36");

        Assert.Equal(7, first.DeviceSignalEpoch);
        Assert.Equal(first.DeviceSignalHash, repeated.DeviceSignalHash);
        Assert.Equal(first.NetworkSignalHash, repeated.NetworkSignalHash);
        Assert.NotEqual(first.DeviceSignalHash, otherAccount.DeviceSignalHash);
        Assert.NotEqual(first.NetworkSignalHash, otherAccount.NetworkSignalHash);
        Assert.NotEqual("Client-Supplied-Fingerprint", first.DeviceSignalHash);
        Assert.NotEqual("203.0.113.187", first.NetworkSignalHash);
        Assert.Equal("Chrome / Windows / Desktop", first.DeviceLabel);
    }

    [Fact]
    public void ProtectForRead_AcceptsBoundedPreviousEpochThenExpiresIt()
    {
        DateTimeOffset now = new(2026, 7, 20, 0, 0, 0, TimeSpan.Zero);
        var oldProtector = new UserSessionMetadataProtector(new SecurityRiskPseudonymizer(1, s_firstKey));
        string oldHash = Assert.IsType<string>(oldProtector.Capture(9, null, "device-a", null).DeviceSignalHash);
        var overlapProtector = new UserSessionMetadataProtector(new SecurityRiskPseudonymizer(
            2,
            s_secondKey,
            previousEpoch: 1,
            previousKey: s_firstKey,
            previousAcceptUntilUtc: now.AddDays(7),
            timeProvider: new FixedTimeProvider(now)));
        var expiredProtector = new UserSessionMetadataProtector(new SecurityRiskPseudonymizer(
            2,
            s_secondKey,
            previousEpoch: 1,
            previousKey: s_firstKey,
            previousAcceptUntilUtc: now.AddDays(-1),
            timeProvider: new FixedTimeProvider(now)));

        Assert.Contains(overlapProtector.ProtectDeviceForRead(9, "device-a"), value => value.Epoch == 1 && value.Hash == oldHash);
        Assert.DoesNotContain(expiredProtector.ProtectDeviceForRead(9, "device-a"), value => value.Epoch == 1);
    }

    [Theory]
    [InlineData("203.0.113.187", "203.0.113.0/24")]
    [InlineData("::ffff:203.0.113.187", "203.0.113.0/24")]
    [InlineData("2001:db8:abcd:1234::1", "2001:db8:abcd::/48")]
    [InlineData("not-an-ip", null)]
    public void MinimizeNetwork_AppliesConsistentIpv4AndIpv6Prefixes(string input, string? expected)
        => Assert.Equal(expected, UserSessionMetadataProtector.MinimizeNetwork(input));

    [Theory]
    [InlineData(null, "Unknown", "Unknown", "Unknown")]
    [InlineData("", "Unknown", "Unknown", "Unknown")]
    [InlineData("Mozilla/5.0 (X11; Linux x86_64) Firefox/126.0", "Firefox", "Linux", "Desktop")]
    [InlineData("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5) AppleWebKit Safari/604.1 Mobile", "Safari", "iOS", "Mobile")]
    [InlineData("Mozilla/5.0 (Linux; Android 14; Tablet) Chrome/124.0", "Chrome", "Android", "Tablet")]
    public void ParseUserAgent_ReturnsOnlyLowCardinalityFamilies(
        string? userAgent,
        string browser,
        string operatingSystem,
        string formFactor)
        => Assert.Equal(
            (browser, operatingSystem, formFactor),
            UserSessionMetadataProtector.ParseUserAgent(userAgent));

    [Fact]
    public void MissingSignals_RemainOptionalForPasskeyCompatibleLogin()
    {
        var protector = new UserSessionMetadataProtector(new SecurityRiskPseudonymizer(1, s_firstKey));

        UserSessionMetadataSnapshot snapshot = protector.Capture(42, null, null, null);

        Assert.Null(snapshot.DeviceSignalHash);
        Assert.Null(snapshot.NetworkSignalHash);
        Assert.Empty(protector.ProtectDeviceForRead(42, null));
        Assert.Empty(protector.ProtectNetworkForRead(42, null));
    }

    [Fact]
    public void PersistenceAndResponseShapes_CannotReintroduceRawSessionMetadata()
    {
        string[] forbiddenProperties = ["DeviceFingerprint", "LastIp", "UserAgent"];
        PropertyInfo[] sessionProperties = typeof(UserSession).GetProperties(BindingFlags.Public | BindingFlags.Instance);
        PropertyInfo[] responseProperties = typeof(UserSessionSummaryDto).GetProperties(BindingFlags.Public | BindingFlags.Instance);

        Assert.DoesNotContain(sessionProperties, property => forbiddenProperties.Contains(property.Name, StringComparer.Ordinal));
        Assert.DoesNotContain(responseProperties, property => forbiddenProperties.Contains(property.Name, StringComparer.Ordinal));

        string loginSource = File.ReadAllText(BackendTestPaths.FromRoot("src", "backend", "Services", "UserLoginWorkflowService.cs"));
        string enrollmentSource = File.ReadAllText(BackendTestPaths.FromRoot("src", "backend", "Services", "Security", "AccountEnrollmentService.cs"));
        string sessionCommandSource = File.ReadAllText(BackendTestPaths.FromRoot("src", "backend", "Services", "UserSessionCommandService.cs"));
        string migrationSource = File.ReadAllText(BackendTestPaths.FromRoot(
            "src", "backend", "Infrastructure", "SchemaMigration", "Definitions", "UserSessionMetadataMinimizationMigrationDefinitions.cs"));

        foreach (string source in new[] { loginSource, enrollmentSource })
        {
            Assert.DoesNotContain("DeviceFingerprint =", source, StringComparison.Ordinal);
            Assert.DoesNotContain("LastIp =", source, StringComparison.Ordinal);
            Assert.DoesNotContain("UserAgent =", source, StringComparison.Ordinal);
        }
        Assert.DoesNotContain("devicefingerprint IS NOT DISTINCT", sessionCommandSource, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("SET devicefingerprint = NULL", migrationSource, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("SET lastip = NULL", migrationSource, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("SET useragent = NULL", migrationSource, StringComparison.OrdinalIgnoreCase);
    }

    private sealed class FixedTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => utcNow;
    }
}
