using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Infrastructure.Security;

internal static class VisitLogIpHashing
{
    public const string PepperKey = "VisitLog:IpHashPepper";

    public static byte[] CreateKey(IConfiguration? configuration)
    {
        string? pepper = configuration?[PepperKey];
        if (string.IsNullOrWhiteSpace(pepper) || pepper.Trim().Length < 32)
        {
            throw new InvalidOperationException("VisitLog:IpHashPepper must be configured with at least 32 characters.");
        }

        return SHA256.HashData(Encoding.UTF8.GetBytes(pepper.Trim()));
    }

    public static string HashIp(string ip, byte[] key)
        => Convert.ToHexStringLower(HMACSHA256.HashData(key, Encoding.UTF8.GetBytes(ip)));

    public static string HashIp(string ip, IConfiguration? configuration)
        => HashIp(ip, CreateKey(configuration));
}
