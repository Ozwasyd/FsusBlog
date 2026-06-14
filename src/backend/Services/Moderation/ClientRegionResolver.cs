using System.Net;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Moderation;

namespace FsusBlog.Server.Services.Moderation;

public sealed class ClientRegionResolver(
    IConfiguration configuration,
    IRegionLegalModerationService regionLegalModerationService) : IClientRegionResolver
{
    public ClientRegionResolution Resolve(HttpContext httpContext)
    {
        IPAddress? remoteIp = httpContext.Connection.RemoteIpAddress;
        bool trustedProxy = configuration.GetValue<bool>("Moderation:RegionPolicy:TrustedProxyEnabled");
        bool loopback = remoteIp is not null && IPAddress.IsLoopback(remoteIp);
        string? rawRegion = null;
        string provider = "connection_ip";
        double confidence = 0.35d;

        if (trustedProxy || loopback)
        {
            rawRegion = FirstHeader(httpContext, "X-Fsus-Region")
                ?? FirstHeader(httpContext, "CF-IPCountry")
                ?? FirstHeader(httpContext, "X-Geo-Country");
            if (!string.IsNullOrWhiteSpace(rawRegion))
            {
                provider = loopback ? "trusted_loopback_header" : "trusted_proxy_header";
                confidence = 0.95d;
            }
        }

        string region = regionLegalModerationService.NormalizeRegion(rawRegion);
        string? ip = remoteIp?.ToString();
        return new ClientRegionResolution(
            region,
            provider,
            confidence,
            ip,
            string.IsNullOrWhiteSpace(ip) ? null : HashIp(ip));
    }

    private static string? FirstHeader(HttpContext context, string name)
        => context.Request.Headers.TryGetValue(name, out var values)
            ? values.FirstOrDefault()
            : null;

    private string HashIp(string ip)
    {
        string key = configuration["Moderation:RegionPolicy:IpHashKey"] ?? "fsusblog-region-ip-hash-development-key";
        byte[] bytes = HMACSHA256.HashData(Encoding.UTF8.GetBytes(key), Encoding.UTF8.GetBytes(ip));
        return Convert.ToHexStringLower(bytes);
    }
}
