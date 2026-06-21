using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;

namespace FsusBlog.Server.Infrastructure.Security;

public interface IRiskControlContextFactory
{
    RiskControlContext Create(HttpContext context);
}

public static class RiskControlContextStatuses
{
    public const string Resolved = "resolved";
    public const string Present = "present";
    public const string Missing = "missing";
    public const string Invalid = "invalid";
}

public static class RiskControlActorStatuses
{
    public const string Anonymous = "anonymous";
    public const string Authenticated = "authenticated";
    public const string AdminPrincipal = "admin_principal";
}

public static class RiskControlIdentityKinds
{
    public const string Anonymous = "anonymous";
    public const string LegacyUser = "legacy_user";
}

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
    bool SocialPreviewBot);

public sealed record RiskControlActorContext(
    string Status,
    string IdentityKind,
    string? UserId,
    string? AccountSubjectHash,
    string? SessionId,
    string? AdminPrincipalId,
    string? AdminSessionId);

public sealed record RiskControlDeviceFingerprintContext(
    string Status,
    int Length,
    string? Sha256Hash,
    string? Reason);

public sealed record RiskControlRegionContext(
    string Status,
    string Region,
    string? Source,
    string? Reason);

public sealed class RiskControlContextFactory : IRiskControlContextFactory
{
    private const int MinDeviceFingerprintLength = 8;
    private const int MaxDeviceFingerprintLength = 128;
    private const int MaxRegionHintLength = 64;
    private const string DeviceFingerprintHeader = "X-Fsus-Device-Fp";

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
            IsItemTrue(context, "SocialPreviewBot"));
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

        for (int i = 0; i < fingerprint.Length; i++)
        {
            char ch = fingerprint[i];
            if (!(char.IsLetterOrDigit(ch) || ch is '-' or '_' or '.' or ':'))
            {
                return new RiskControlDeviceFingerprintContext(RiskControlContextStatuses.Invalid, fingerprint.Length, null, "invalid_charset");
            }
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

        for (int i = 0; i < region.Length; i++)
        {
            char ch = region[i];
            if (!(char.IsLetterOrDigit(ch) || ch is '-' or '_'))
            {
                region = "UNKNOWN";
                return false;
            }
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
        if (normalized.Length != 64)
        {
            return null;
        }

        for (int i = 0; i < normalized.Length; i++)
        {
            char c = normalized[i];
            if (c is not ((>= '0' and <= '9') or (>= 'a' and <= 'f') or (>= 'A' and <= 'F')))
            {
                return null;
            }
        }

        return normalized.ToLowerInvariant();
    }
}
