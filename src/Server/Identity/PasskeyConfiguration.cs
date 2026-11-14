using Fido2NetLib;

namespace FsusBlog.V2.Server.Passkeys;

internal sealed record PasskeyConfiguration(Uri Origin, string RpId)
{
    internal static PasskeyConfiguration? Read(IConfiguration config)
        => Read(config, "FSUSBLOG_PASSKEY_ORIGIN", "FSUSBLOG_PASSKEY_RP_ID");

    internal static PasskeyConfiguration? Read(IConfiguration config, string originKey, string rpIdKey)
    {
        var originValue = config[originKey];
        var rpIdValue = config[rpIdKey];
        if (originValue is null && rpIdValue is null) return null;
        if (!Uri.TryCreate(originValue, UriKind.Absolute, out var origin) ||
            !string.Equals(originValue, origin.GetLeftPart(UriPartial.Authority), StringComparison.Ordinal) ||
            (origin.Scheme != "https" && (origin.Scheme != "http" || !origin.IsLoopback)) ||
            !string.IsNullOrEmpty(origin.UserInfo) ||
            rpIdValue is not { Length: > 0 and <= 253 } ||
            !string.Equals(rpIdValue, origin.IdnHost, StringComparison.Ordinal) ||
            (origin.HostNameType != UriHostNameType.Dns && !origin.IsLoopback))
            throw new InvalidOperationException("Passkey requires an explicit canonical origin and matching RP ID. Use HTTPS outside loopback.");
        return new(origin, rpIdValue);
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
