using System.Net;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Models.Moderation;
using NetIPNetwork = System.Net.IPNetwork;

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
        bool trustedProxyRemote = trustedProxy && IsConfiguredTrustedProxy(remoteIp);
        string? rawRegion = null;
        string provider = "connection_ip";
        double confidence = 0.35d;

        if (loopback || trustedProxyRemote)
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

    private bool IsConfiguredTrustedProxy(IPAddress? remoteIp)
    {
        if (remoteIp is null)
        {
            return false;
        }

        foreach (string value in ReverseProxyForwardedHeaders.ReadConfiguredList(configuration, ReverseProxyForwardedHeaders.KnownProxiesKey))
        {
            if (ReverseProxyForwardedHeaders.TryParseKnownProxy(value, out IPAddress? proxy)
                && proxy is not null
                && proxy.Equals(remoteIp))
            {
                return true;
            }
        }

        foreach (string value in ReverseProxyForwardedHeaders.ReadConfiguredList(configuration, ReverseProxyForwardedHeaders.KnownNetworksKey))
        {
            if (ReverseProxyForwardedHeaders.TryParseKnownNetwork(value, out NetIPNetwork network)
                && network.Contains(remoteIp))
            {
                return true;
            }
        }

        return false;
    }

    private string HashIp(string ip)
    {
        string? key = configuration["Moderation:RegionPolicy:IpHashKey"];
        if (string.IsNullOrWhiteSpace(key) || key.Trim().Length < 32)
        {
            throw new InvalidOperationException("Moderation:RegionPolicy:IpHashKey must be configured with at least 32 characters.");
        }

        byte[] bytes = HMACSHA256.HashData(Encoding.UTF8.GetBytes(key.Trim()), Encoding.UTF8.GetBytes(ip));
        return Convert.ToHexStringLower(bytes);
    }
}
