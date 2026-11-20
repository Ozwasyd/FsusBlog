using Fido2NetLib;

namespace FsusBlog.V2.Server.Passkeys;

internal sealed record PasskeyConfiguration(Uri Origin, string RpId)
{
    internal static PasskeyConfiguration? Read(IConfiguration config, string? publicOrigin = null)
    {
        var explicitOrigin = config["FSUSBLOG_PASSKEY_ORIGIN"];
        var explicitRp = config["FSUSBLOG_PASSKEY_RP_ID"];
        if (explicitOrigin is not null || explicitRp is not null)
        {
            if (string.IsNullOrWhiteSpace(explicitOrigin) && string.IsNullOrWhiteSpace(explicitRp))
                return null;
            return Read(config, "FSUSBLOG_PASSKEY_ORIGIN", "FSUSBLOG_PASSKEY_RP_ID");
        }
        if (string.IsNullOrWhiteSpace(publicOrigin) ||
            !Uri.TryCreate(publicOrigin, UriKind.Absolute, out var derived) ||
            !string.Equals(publicOrigin, derived.GetLeftPart(UriPartial.Authority), StringComparison.Ordinal) ||
            (derived.HostNameType != UriHostNameType.Dns && !derived.IsLoopback))
            return null;
        return new(derived, derived.IdnHost);
    }

    internal static PasskeyConfiguration? Read(IConfiguration config, string originKey, string rpIdKey)
    {
        var originValue = config[originKey];
        var rpIdValue = config[rpIdKey];
        if (string.IsNullOrWhiteSpace(originValue) && string.IsNullOrWhiteSpace(rpIdValue)) return null;
        if (!Uri.TryCreate(originValue, UriKind.Absolute, out var origin) ||
            !string.Equals(originValue, origin.GetLeftPart(UriPartial.Authority), StringComparison.Ordinal) ||
            (origin.Scheme != "https" && (origin.Scheme != "http" || !origin.IsLoopback)) ||
            !string.IsNullOrEmpty(origin.UserInfo))
            throw new InvalidOperationException("Passkey requires an explicit canonical origin and matching RP ID. Use HTTPS outside loopback.");
        var effectiveRp = string.IsNullOrWhiteSpace(rpIdValue) ? origin.IdnHost : rpIdValue;
        if (effectiveRp is not { Length: > 0 and <= 253 } ||
            !string.Equals(effectiveRp, origin.IdnHost, StringComparison.Ordinal) ||
            (origin.HostNameType != UriHostNameType.Dns && !origin.IsLoopback))
            throw new InvalidOperationException("Passkey requires an explicit canonical origin and matching RP ID. Use HTTPS outside loopback.");
        return new(origin, effectiveRp);
    }

    internal Fido2 CreateVerifier(string name = "FsusBlog") => new(new Fido2Configuration
    {
        ServerDomain = RpId,
        ServerName = name,
        Origins = new HashSet<string>(StringComparer.Ordinal) { Origin.GetLeftPart(UriPartial.Authority) },
        ChallengeSize = FsusBlog.V2.Contracts.WireLimits.PasskeyChallengeBytes,
        Timeout = 120_000
    });
}
