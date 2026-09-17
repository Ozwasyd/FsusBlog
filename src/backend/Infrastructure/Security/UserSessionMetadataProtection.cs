using System.Net;

namespace FsusBlog.Server.Infrastructure.Security;

/// <summary>
/// Configuration bounds for how long user-session device and network metadata may be retained.
/// </summary>
public static class UserSessionMetadataRetentionPolicy
{
    public const string RetentionDaysConfigurationKey = "Security:UserSessions:MetadataRetentionDays";
    public const string RiskSignalsEnabledConfigurationKey = "Security:UserSessions:MetadataRiskSignalsEnabled";
    public const int DefaultRetentionDays = 30;
    public const int MinimumRetentionDays = 1;
    public const int MaximumRetentionDays = 90;

    /// <summary>
    /// Resolves retention days from configuration, clamped to the supported range.
    /// </summary>
    public static int ResolveRetentionDays(IConfiguration? configuration)
        => Math.Clamp(
            configuration?.GetValue<int?>(RetentionDaysConfigurationKey) ?? DefaultRetentionDays,
            MinimumRetentionDays,
            MaximumRetentionDays);
}

/// <summary>
/// Account-scoped, minimized device and network labels captured at session creation time.
/// </summary>
public readonly record struct UserSessionMetadataSnapshot(
    string? DeviceSignalHash,
    int? DeviceSignalEpoch,
    string? NetworkSignalHash,
    int? NetworkSignalEpoch,
    string BrowserFamily,
    string OperatingSystemFamily,
    string FormFactor)
{
    /// <summary>
    /// Low-cardinality display label built from browser, OS, and form-factor families.
    /// </summary>
    public string DeviceLabel => $"{BrowserFamily} / {OperatingSystemFamily} / {FormFactor}";
}

/// <summary>
/// Captures and re-protects request-boundary session metadata without retaining raw signals.
/// </summary>
public interface IUserSessionMetadataProtector
{
    /// <summary>
    /// Captures minimized device and network risk pseudonyms plus display labels for a session.
    /// </summary>
    UserSessionMetadataSnapshot Capture(int accountId, string? clientIp, string? deviceSignal, string? userAgent);

    /// <summary>
    /// Re-protects a stored device signal for read paths under the current rotation epoch.
    /// </summary>
    IReadOnlyList<SecurityRiskPseudonym> ProtectDeviceForRead(int accountId, string? deviceSignal);

    /// <summary>
    /// Re-protects a stored network signal for read paths under the current rotation epoch.
    /// </summary>
    IReadOnlyList<SecurityRiskPseudonym> ProtectNetworkForRead(int accountId, string? clientIp);
}

/// <summary>
/// Converts request-lifetime device metadata into account-scoped, rotating risk pseudonyms and
/// low-cardinality display labels. Raw IP, user agent, and caller-provided fingerprints never leave
/// this request-boundary service.
/// </summary>
public sealed class UserSessionMetadataProtector(
    ISecurityRiskPseudonymizer pseudonymizer) : IUserSessionMetadataProtector
{
    private const int MaximumDeviceSignalLength = 128;
    private const int MaximumUserAgentInspectionLength = 1024;

    /// <inheritdoc />
    public UserSessionMetadataSnapshot Capture(
        int accountId,
        string? clientIp,
        string? deviceSignal,
        string? userAgent)
    {
        SecurityRiskPseudonym? device = ProtectCurrent(
            accountId,
            SecurityRiskIdentityDomain.DeviceFingerprint,
            NormalizeDeviceSignal(deviceSignal));
        SecurityRiskPseudonym? network = ProtectCurrent(
            accountId,
            SecurityRiskIdentityDomain.ClientIp,
            MinimizeNetwork(clientIp));
        (string browser, string operatingSystem, string formFactor) = ParseUserAgent(userAgent);
        return new UserSessionMetadataSnapshot(
            device?.Hash,
            device?.Epoch,
            network?.Hash,
            network?.Epoch,
            browser,
            operatingSystem,
            formFactor);
    }

    /// <inheritdoc />
    public IReadOnlyList<SecurityRiskPseudonym> ProtectDeviceForRead(int accountId, string? deviceSignal)
        => ProtectForRead(
            accountId,
            SecurityRiskIdentityDomain.DeviceFingerprint,
            NormalizeDeviceSignal(deviceSignal));

    /// <inheritdoc />
    public IReadOnlyList<SecurityRiskPseudonym> ProtectNetworkForRead(int accountId, string? clientIp)
        => ProtectForRead(
            accountId,
            SecurityRiskIdentityDomain.ClientIp,
            MinimizeNetwork(clientIp));

    internal static string? MinimizeNetwork(string? clientIp)
    {
        if (!IPAddress.TryParse(clientIp?.Trim(), out IPAddress? address))
        {
            return null;
        }

        if (address.IsIPv4MappedToIPv6)
        {
            address = address.MapToIPv4();
        }

        byte[] bytes = address.GetAddressBytes();
        if (bytes.Length == 4)
        {
            bytes[3] = 0;
            return $"{new IPAddress(bytes)}/24";
        }

        Array.Clear(bytes, 6, bytes.Length - 6);
        return $"{new IPAddress(bytes)}/48";
    }

    internal static (string BrowserFamily, string OperatingSystemFamily, string FormFactor) ParseUserAgent(
        string? userAgent)
    {
        if (string.IsNullOrWhiteSpace(userAgent))
        {
            return ("Unknown", "Unknown", "Unknown");
        }

        string value = userAgent.Trim();
        if (value.Length > MaximumUserAgentInspectionLength)
        {
            value = value[..MaximumUserAgentInspectionLength];
        }

        string browser = value.Contains("Edg/", StringComparison.OrdinalIgnoreCase)
            || value.Contains("EdgiOS/", StringComparison.OrdinalIgnoreCase)
            || value.Contains("EdgA/", StringComparison.OrdinalIgnoreCase)
                ? "Edge"
                : value.Contains("Firefox/", StringComparison.OrdinalIgnoreCase)
                    || value.Contains("FxiOS/", StringComparison.OrdinalIgnoreCase)
                        ? "Firefox"
                        : value.Contains("Chrome/", StringComparison.OrdinalIgnoreCase)
                            || value.Contains("CriOS/", StringComparison.OrdinalIgnoreCase)
                                ? "Chrome"
                                : value.Contains("Safari/", StringComparison.OrdinalIgnoreCase)
                                    ? "Safari"
                                    : "Browser";
        string operatingSystem = value.Contains("Android", StringComparison.OrdinalIgnoreCase)
            ? "Android"
            : value.Contains("iPhone", StringComparison.OrdinalIgnoreCase)
                || value.Contains("iPad", StringComparison.OrdinalIgnoreCase)
                    ? "iOS"
                    : value.Contains("Windows", StringComparison.OrdinalIgnoreCase)
                        ? "Windows"
                        : value.Contains("CrOS", StringComparison.OrdinalIgnoreCase)
                            ? "ChromeOS"
                            : value.Contains("Mac OS", StringComparison.OrdinalIgnoreCase)
                                || value.Contains("Macintosh", StringComparison.OrdinalIgnoreCase)
                                    ? "macOS"
                                    : value.Contains("Linux", StringComparison.OrdinalIgnoreCase)
                                        ? "Linux"
                                        : "Other";
        string formFactor = value.Contains("iPad", StringComparison.OrdinalIgnoreCase)
            || value.Contains("Tablet", StringComparison.OrdinalIgnoreCase)
                ? "Tablet"
                : value.Contains("iPhone", StringComparison.OrdinalIgnoreCase)
                    || value.Contains("Mobile", StringComparison.OrdinalIgnoreCase)
                        ? "Mobile"
                        : "Desktop";
        return (browser, operatingSystem, formFactor);
    }

    private SecurityRiskPseudonym? ProtectCurrent(
        int accountId,
        SecurityRiskIdentityDomain domain,
        string? normalizedSignal)
        => accountId <= 0 || string.IsNullOrEmpty(normalizedSignal)
            ? null
            : pseudonymizer.PseudonymizeCurrent(domain, Scope(accountId, normalizedSignal));

    private IReadOnlyList<SecurityRiskPseudonym> ProtectForRead(
        int accountId,
        SecurityRiskIdentityDomain domain,
        string? normalizedSignal)
        => accountId <= 0 || string.IsNullOrEmpty(normalizedSignal)
            ? []
            : pseudonymizer.PseudonymizeForRead(domain, Scope(accountId, normalizedSignal));

    private static string? NormalizeDeviceSignal(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        string normalized = value.Trim();
        if (normalized.Length > MaximumDeviceSignalLength)
        {
            normalized = normalized[..MaximumDeviceSignalLength];
        }

        return normalized.ToLowerInvariant();
    }

    private static string Scope(int accountId, string signal)
        => $"account:{accountId}\0{signal}";
}
