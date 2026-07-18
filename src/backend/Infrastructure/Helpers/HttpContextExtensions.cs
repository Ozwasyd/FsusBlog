using System.Net;
using System.Runtime.CompilerServices;

using FsusBlog.Server.Infrastructure;

namespace FsusBlog.Server.Infrastructure.Helpers;

/// <summary>
/// HttpContext 扩展：用于精准提取客户端请求元数据
/// </summary>
public static class HttpContextExtensions
{
    public const int MaxUserAgentLength = 512;

    /// <summary>
    /// Returns the remote address after trusted forwarded-header processing and normalizes IPv4-mapped IPv6.
    /// </summary>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static string GetClientIp(this HttpContext context)
    {
        var remoteIp = context.Connection.RemoteIpAddress;
        if (remoteIp != null)
        {
            // ForwardedHeadersMiddleware rewrites RemoteIpAddress only for
            // configured KnownProxies/KnownNetworks. Raw X-Forwarded-* headers
            // must not be trusted here because rate limiting and PoW bind to IP.
            if (remoteIp.IsIPv4MappedToIPv6)
            {
                return remoteIp.MapToIPv4().ToString();
            }
            if (remoteIp.Equals(IPAddress.IPv6Loopback))
            {
                return "127.0.0.1";
            }
            return remoteIp.ToString();
        }

        return "127.0.0.1";
    }

    /// <summary>
    /// 获取客户端 User-Agent (用于统计访问设备与浏览器)
    /// </summary>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static string GetUserAgent(this HttpContext context)
    {
        var values = context.Request.Headers.UserAgent;
        string? first = values.Count > 0 ? values[0] : null;
        if (string.IsNullOrWhiteSpace(first))
        {
            return "Unknown";
        }

        ReadOnlySpan<char> userAgent = first.AsSpan().Trim();
        if (userAgent.IsEmpty)
        {
            return "Unknown";
        }

        if (userAgent.Length > MaxUserAgentLength)
        {
            userAgent = userAgent[..MaxUserAgentLength];
        }

        return userAgent.ToString();
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static int GetUserId(this HttpContext? context)
        => FastUserIdProvider.GetOrParseUserIdAsInt(context);
}
