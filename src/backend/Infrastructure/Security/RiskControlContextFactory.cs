using System.Net;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;

namespace FsusBlog.Server.Infrastructure.Security;

/// <summary>
/// Builds a normalized risk-control context from trusted request and principal state.
/// </summary>
public interface IRiskControlContextFactory
{
    RiskControlContext Create(HttpContext context);
}

/// <summary>
/// Defines resolution states used by request-derived risk-control fields.
/// </summary>
public static class RiskControlContextStatuses
{
    public const string Resolved = "resolved";
    public const string Present = "present";
    public const string Missing = "missing";
    public const string Invalid = "invalid";
}

/// <summary>
/// Defines the authenticated-principal categories exposed to risk policy evaluation.
/// </summary>
public static class RiskControlActorStatuses
{
    public const string Anonymous = "anonymous";
    public const string Authenticated = "authenticated";
    public const string AdminPrincipal = "admin_principal";
}

/// <summary>
/// Defines the supported user identity domains used in risk proof binding.
/// </summary>
public static class RiskControlIdentityKinds
{
    public const string Anonymous = "anonymous";
    public const string LegacyUser = "legacy_user";
}

/// <summary>
/// Captures normalized request, actor, device, and region inputs consumed by risk policy decisions.
/// </summary>
/// <param name="ActionName">Registered action identifier, or an empty value when endpoint metadata is missing.</param>
/// <param name="RouteKey">Resolved route-specific policy key.</param>
/// <param name="ActionStatus">Resolution status for action metadata.</param>
/// <param name="ClientIp">Normalized client IP identity.</param>
/// <param name="UserAgent">Request user-agent value.</param>
/// <param name="UserAgentStatus">Presence status for the user-agent signal.</param>
/// <param name="Actor">Normalized authenticated or anonymous actor context.</param>
/// <param name="DeviceFingerprint">Validated device-fingerprint context.</param>
/// <param name="Region">Normalized region hint and provenance.</param>
/// <param name="VerifiedCrawler">Whether crawler verification succeeded.</param>
/// <param name="SocialPreviewBot">Whether the request represents a recognized social preview bot.</param>
public sealed record RiskControlContext(
    string ActionName,
    string RouteKey,
    string ActionStatus,
    string ClientIp,
    string UserAgent,
    string UserAgentStatus,
    RiskControlActorContext Actor,
    RiskControlDeviceFingerprintContext DeviceFingerprint,
    RiskControlRegionContext Region,
    bool VerifiedCrawler,
    bool SocialPreviewBot)
{
    public bool DevelopmentLocalBypass
    {
        get; init;
    }
}

/// <summary>
/// Describes the principal identity material allowed to influence a risk decision or proof binding.
/// </summary>
/// <param name="Status">Actor authentication category.</param>
/// <param name="IdentityKind">User identity domain, or anonymous when no user identity is present.</param>
/// <param name="UserId">Legacy user identifier when available.</param>
/// <param name="AccountSubjectHash">Stable account subject hash when available.</param>
/// <param name="SessionId">User session identifier when available.</param>
/// <param name="AdminPrincipalId">Administrative principal identifier when applicable.</param>
/// <param name="AdminSessionId">Administrative session identifier when applicable.</param>
public sealed record RiskControlActorContext(
    string Status,
    string IdentityKind,
    string? UserId,
    string? AccountSubjectHash,
    string? SessionId,
    string? AdminPrincipalId,
    string? AdminSessionId);

/// <summary>
/// Carries validation status and privacy-safe digest material for a device fingerprint.
/// </summary>
/// <param name="Status">Whether a usable fingerprint was present.</param>
/// <param name="Length">Length of the submitted fingerprint before hashing.</param>
/// <param name="Sha256Hash">Lowercase SHA-256 digest for a valid fingerprint.</param>
/// <param name="Reason">Machine-readable reason when validation fails.</param>
public sealed record RiskControlDeviceFingerprintContext(
    string Status,
    int Length,
    string? Sha256Hash,
    string? Reason);

/// <summary>
/// Describes a normalized region hint together with its source and validation state.
/// </summary>
/// <param name="Status">Whether a usable region was resolved.</param>
/// <param name="Region">Normalized region value.</param>
/// <param name="Source">Trusted header or platform source that supplied the value.</param>
/// <param name="Reason">Machine-readable reason when resolution fails.</param>
public sealed record RiskControlRegionContext(
    string Status,
    string Region,
    string? Source,
    string? Reason);

/// <summary>
/// Resolves endpoint metadata and privacy-bounded request signals into a policy-ready context.
/// </summary>
/// <param name="environment">Host environment used to constrain development-only local bypasses.</param>
/// <param name="configuration">Configuration used to opt local test fixtures into the development bypass.</param>
public sealed class RiskControlContextFactory(
    IWebHostEnvironment? environment = null,
    IConfiguration? configuration = null) : IRiskControlContextFactory
{
    private const int MinDeviceFingerprintLength = 8;
    private const int MaxDeviceFingerprintLength = 128;
    private const int MaxRegionHintLength = 64;
    private const string DeviceFingerprintHeader = "X-Fsus-Device-Fp";
    private const string AllowLocalAuthFixtureConfigurationKey = "fsus:allowLocalAuthFixture";

    /// <summary>
    /// Creates an immutable risk-control view of the current request without retaining raw device fingerprint data.
    /// </summary>
    /// <param name="context">HTTP request and principal state to normalize.</param>
    /// <returns>The action, actor, device, region, and crawler signals used by risk policy evaluation.</returns>
    public RiskControlContext Create(HttpContext context)
    {
        ArgumentNullException.ThrowIfNull(context);

        RiskActionEndpointMetadata? action = ResolveAction(context, out string actionStatus);

        return new RiskControlContext(
            action?.ActionName ?? string.Empty,
            action?.RouteKey ?? string.Empty,
            actionStatus,
            context.GetClientIp(),
            context.GetUserAgent(),
            ResolveUserAgentStatus(context),
            ResolveActor(context.User),
            ResolveDeviceFingerprint(context),
            ResolveRegion(context),
            IsItemTrue(context, "VerifiedCrawler"),
            IsItemTrue(context, "SocialPreviewBot"))
        {
            DevelopmentLocalBypass = ShouldBypassForDevelopmentLocalRequest(context)
        };
    }

    private bool ShouldBypassForDevelopmentLocalRequest(HttpContext context)
    {
        bool enabled = environment?.IsDevelopment() == true
            || configuration?.GetValue<bool>(AllowLocalAuthFixtureConfigurationKey) == true;
        return enabled && IsLocalOrPrivateAddress(context.Connection.RemoteIpAddress);
    }

    private static bool IsLocalOrPrivateAddress(IPAddress? address)
    {
        if (address is null)
        {
            return true;
        }

        if (IPAddress.IsLoopback(address))
        {
            return true;
        }

        if (address.IsIPv4MappedToIPv6)
        {
            address = address.MapToIPv4();
        }

        byte[] bytes = address.GetAddressBytes();
        if (address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork && bytes.Length == 4)
        {
            return bytes[0] == 10
                || (bytes[0] == 172 && bytes[1] is >= 16 and <= 31)
                || (bytes[0] == 192 && bytes[1] == 168)
                || (bytes[0] == 169 && bytes[1] == 254);
        }

        if (address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6 && bytes.Length == 16)
        {
            return (bytes[0] & 0xfe) == 0xfc || address.IsIPv6LinkLocal;
        }

        return false;
    }

    private static RiskActionEndpointMetadata? ResolveAction(HttpContext context, out string status)
    {
        if (context.Items.TryGetValue(RiskActionEndpointMetadata.HttpContextItemKey, out object? value)
            && value is RiskActionEndpointMetadata dynamicMetadata)
        {
            status = RiskControlContextStatuses.Resolved;
            return dynamicMetadata;
        }

        if (RiskActionRegistry.Default.TryGetEndpointMetadata(context.GetEndpoint(), out RiskActionEndpointMetadata metadata))
        {
            status = RiskControlContextStatuses.Resolved;
            return metadata;
        }

        status = RiskControlContextStatuses.Missing;
        return null;
    }

    private static string ResolveUserAgentStatus(HttpContext context)
        => context.Request.Headers.UserAgent.Count > 0 &&
           !string.IsNullOrWhiteSpace(context.Request.Headers.UserAgent[0])
            ? RiskControlContextStatuses.Present
            : RiskControlContextStatuses.Missing;

    private static RiskControlActorContext ResolveActor(ClaimsPrincipal? user)
    {
        bool authenticated = user?.Identity?.IsAuthenticated == true;
        string? userId = NormalizeClaim(user?.FindFirst(ClaimTypes.NameIdentifier)?.Value)
            ?? NormalizeClaim(user?.FindFirst("nameid")?.Value);
        string? identityKind = NormalizeClaim(user?.FindFirst("identity_kind")?.Value);
        string? accountSubjectHash = NormalizeAccountSubjectHash(
            user?.FindFirst(AnonymousIdentityRuntime.AccountSubjectHashClaim)?.Value);

        if (user.IsAdminPrincipal())
        {
            string? adminPrincipalId = user.TryGetAdminPrincipalId(out long parsedAdminId)
                ? parsedAdminId.ToString()
                : NormalizeClaim(user?.FindFirst("admin_id")?.Value);
            return new RiskControlActorContext(
                RiskControlActorStatuses.AdminPrincipal,
                AnonymousIdentityRuntime.AdminPrincipalKind,
                null,
                null,
                null,
                adminPrincipalId,
                NormalizeClaim(user?.GetAdminSessionId()));
        }

        if (!authenticated)
        {
            return new RiskControlActorContext(
                RiskControlActorStatuses.Anonymous,
                RiskControlIdentityKinds.Anonymous,
                null,
                null,
                null,
                null,
                null);
        }

        return new RiskControlActorContext(
            RiskControlActorStatuses.Authenticated,
            identityKind ?? RiskControlIdentityKinds.LegacyUser,
            userId,
            accountSubjectHash,
            NormalizeClaim(user?.GetSessionId()),
            null,
            null);
    }

    private static RiskControlDeviceFingerprintContext ResolveDeviceFingerprint(HttpContext context)
    {
        if (!context.Request.Headers.TryGetValue(DeviceFingerprintHeader, out var values))
        {
            return new RiskControlDeviceFingerprintContext(RiskControlContextStatuses.Missing, 0, null, "missing");
        }

        string fingerprint = values.ToString().Trim();
        if (fingerprint.Length == 0)
        {
            return new RiskControlDeviceFingerprintContext(RiskControlContextStatuses.Missing, 0, null, "missing");
        }

        if (fingerprint.Length is < MinDeviceFingerprintLength or > MaxDeviceFingerprintLength)
        {
            return new RiskControlDeviceFingerprintContext(RiskControlContextStatuses.Invalid, fingerprint.Length, null, "invalid_length");
        }

        if (!TextHelpers.HasOnlyAsciiTokenChars(fingerprint, "-_.:"))
        {
            return new RiskControlDeviceFingerprintContext(RiskControlContextStatuses.Invalid, fingerprint.Length, null, "invalid_charset");
        }

        return new RiskControlDeviceFingerprintContext(
            RiskControlContextStatuses.Present,
            fingerprint.Length,
            Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(fingerprint))),
            null);
    }

    private static RiskControlRegionContext ResolveRegion(HttpContext context)
    {
        foreach (string headerName in new[] { "X-Fsus-Region", "CF-IPCountry", "X-Geo-Country" })
        {
            if (!context.Request.Headers.TryGetValue(headerName, out var values))
            {
                continue;
            }

            string raw = values.ToString().Trim();
            if (raw.Length == 0)
            {
                continue;
            }

            if (!TryNormalizeRegion(raw, out string region))
            {
                return new RiskControlRegionContext(RiskControlContextStatuses.Invalid, "UNKNOWN", headerName, "invalid_region");
            }

            return new RiskControlRegionContext(RiskControlContextStatuses.Present, region, headerName, null);
        }

        return new RiskControlRegionContext(RiskControlContextStatuses.Missing, "UNKNOWN", null, "missing");
    }

    private static bool TryNormalizeRegion(string raw, out string region)
    {
        region = raw.Trim().ToUpperInvariant();
        if (region.Length == 0 || region.Length > MaxRegionHintLength)
        {
            region = "UNKNOWN";
            return false;
        }

        if (!TextHelpers.HasOnlyAsciiTokenChars(region, "-_"))
        {
            region = "UNKNOWN";
            return false;
        }

        region = region switch
        {
            "CN" or "MAINLAND" => "CN-MAINLAND",
            "HK" => "CN-HK",
            "MO" => "CN-MO",
            "TW" => "CN-TW",
            _ => region
        };
        return true;
    }

    private static bool IsItemTrue(HttpContext context, string key)
        => context.Items.TryGetValue(key, out object? value) && value is true;

    private static string? NormalizeClaim(string? value)
    {
        string normalized = (value ?? string.Empty).Trim();
        return normalized.Length == 0 ? null : normalized;
    }

    private static string? NormalizeAccountSubjectHash(string? value)
    {
        string normalized = (value ?? string.Empty).Trim();
        return TextHelpers.IsSha256Hex(normalized) ? normalized.ToLowerInvariant() : null;
    }
}
