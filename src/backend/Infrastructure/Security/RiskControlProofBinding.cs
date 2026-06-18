using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Server.Infrastructure.Security;

internal sealed record RiskControlProofBinding(
    string SubjectHash,
    string ClientIpHash,
    string DeviceFpHash);

internal static class RiskControlProofBindingFactory
{
    public static RiskControlProofBinding Create(RiskControlContext context)
    {
        ArgumentNullException.ThrowIfNull(context);

        return new RiskControlProofBinding(
            HashValue(BuildSubjectMaterial(context.Actor)),
            HashValue(string.Concat("ip:", context.ClientIp)),
            ResolveDeviceFingerprintHash(context.DeviceFingerprint));
    }

    private static string BuildSubjectMaterial(RiskControlActorContext actor)
        => actor.Status switch
        {
            RiskControlActorStatuses.AdminPrincipal => string.Join(
                ':',
                "admin",
                Normalize(actor.AdminPrincipalId),
                Normalize(actor.AdminSessionId)),
            RiskControlActorStatuses.Authenticated => string.Join(
                ':',
                "user",
                Normalize(actor.IdentityKind),
                Normalize(actor.UserId),
                Normalize(actor.SessionId)),
            _ => "anonymous"
        };

    private static string ResolveDeviceFingerprintHash(RiskControlDeviceFingerprintContext fingerprint)
        => IsSha256Hex(fingerprint.Sha256Hash)
            ? fingerprint.Sha256Hash!.ToLowerInvariant()
            : HashValue(string.Concat("device:", fingerprint.Status, ':', fingerprint.Reason ?? "none"));

    private static string Normalize(string? value)
        => string.IsNullOrWhiteSpace(value) ? "missing" : value.Trim();

    private static bool IsSha256Hex(string? value)
    {
        string normalized = (value ?? string.Empty).Trim();
        if (normalized.Length != 64)
        {
            return false;
        }

        for (int i = 0; i < normalized.Length; i++)
        {
            char c = normalized[i];
            if (c is not ((>= '0' and <= '9') or (>= 'a' and <= 'f') or (>= 'A' and <= 'F')))
            {
                return false;
            }
        }

        return true;
    }

    private static string HashValue(string value)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
}
