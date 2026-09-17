using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Server.Infrastructure.Privacy;

internal static class MessageAdminSessionAuditReference
{
    internal const string KeyName = "Messages:AdminSessionAuditReferenceKey";
    private const string LocalFallbackKey = "fsusblog-local-message-admin-session-audit-reference-v1";

    internal static string Create(IConfiguration configuration, string adminSessionId)
    {
        string? configuredValue = configuration[KeyName];
        string configuredKey = string.IsNullOrWhiteSpace(configuredValue)
            ? LocalFallbackKey
            : configuredValue.Trim();
        byte[] key = SHA256.HashData(Encoding.UTF8.GetBytes(configuredKey));
        byte[] material = Encoding.UTF8.GetBytes(string.Concat(
            "fsusblog.message.admin-session-audit-reference.v1\n",
            adminSessionId));
        return Convert.ToHexStringLower(HMACSHA256.HashData(key, material));
    }
}
