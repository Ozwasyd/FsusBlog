using System.Net;
using System.Runtime.CompilerServices;

namespace FsusBlog.Server.Infrastructure.Helpers;

/// <summary>
/// HttpContext 扩展：用于精准提取客户端请求元数据
/// </summary>
public static class HttpContextExtensions
{
    /// <summary>
    /// 获取客户端真实 IP 地址 (深度适配代理穿透与 IPv6)
    /// 修复日期: 2026-02-23 (引入 ReadOnlySpan<char> 零分配解析管道，拦截 RemoteIpAddress 序列化开销，修复 UserAgent 空值判断)
    /// </summary>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static string GetClientIp(this HttpContext context)
    {
        ReadOnlySpan<char> ipSpan = default;

        // 1. 优先尝试从 X-Forwarded-For 获取 (由 Nginx/CDN 设置)
        // 性能优化：直接提取 StringValues 的第一个元素，避免隐式分配拼接字符串
        var forwardedHeaders = context.Request.Headers["X-Forwarded-For"];
        if (forwardedHeaders.Count > 0)
        {
            var firstHeader = forwardedHeaders[0];
            if (!string.IsNullOrEmpty(firstHeader))
            {
                ipSpan = firstHeader.AsSpan();

                // 性能优化：使用 Span.IndexOf 替代 Split，完全在栈内存上切割
                int commaIndex = ipSpan.IndexOf(',');
                if (commaIndex > 0)
                {
                    ipSpan = ipSpan[..commaIndex];
                }
                ipSpan = ipSpan.Trim();
            }
        }

        // 2. 备选：从 X-Real-IP 获取
        if (ipSpan.IsEmpty || ipSpan.IsWhiteSpace())
        {
            var realIpHeaders = context.Request.Headers["X-Real-IP"];
            if (realIpHeaders.Count > 0)
            {
                var firstHeader = realIpHeaders[0];
                if (!string.IsNullOrEmpty(firstHeader))
                {
                    ipSpan = firstHeader.AsSpan().Trim();
                }
            }
        }

        // 3. 兜底与短路优化：获取直接连接的远程地址 (SignalR WebSocket 常走此分支)
        if (ipSpan.IsEmpty || ipSpan.IsWhiteSpace())
        {
            var remoteIp = context.Connection.RemoteIpAddress;
            if (remoteIp != null)
            {
                // 核心物理级优化：如果我们直接从 Connection 拿到了底层的 IPAddress 对象，
                // 直接进行归一化并返回。彻底斩断 ToString() -> 字符串处理 -> 重新 TryParse 的巨大开销。
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

        // 4. 鲁棒性重构：剥离端口号 (完全在 Span 上进行指针级操作，绝对零分配)
        int closeBracket = ipSpan.IndexOf(']');
        if (closeBracket > 0 && ipSpan[0] == '[')
        {
            ipSpan = ipSpan[1..closeBracket];
        }
        else
        {
            int firstColon = ipSpan.IndexOf(':');
            if (firstColon != -1 && firstColon == ipSpan.LastIndexOf(':'))
            {
                ipSpan = ipSpan[..firstColon];
            }
        }

        // 5. 核心修复 (修复日期: 2026-02-21)：根治 Docker/Kestrel 下的 IP 字符串漂移问题
        // 性能升级 (2026-02-23)：利用 .NET 8+ 支持的 IPAddress.TryParse(ReadOnlySpan<char>) 进行零分配解析
        if (IPAddress.TryParse(ipSpan, out var parsedAddress))
        {
            if (parsedAddress.IsIPv4MappedToIPv6)
            {
                return parsedAddress.MapToIPv4().ToString();
            }
            if (parsedAddress.Equals(IPAddress.IPv6Loopback))
            {
                return "127.0.0.1";
            }
            return parsedAddress.ToString();
        }

        // 万一解析失败，返回剥离了端口后的字符串结果
        return ipSpan.ToString();
    }

    /// <summary>
    /// 获取客户端 User-Agent (用于统计访问设备与浏览器)
    /// </summary>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static string GetUserAgent(this HttpContext context)
    {
        // 逻辑 Bug 修复：StringValues.ToString() 在没有值时会返回 string.Empty，
        // 导致原有的 ?? "Unknown" 永远不会触发。这里改用显式判断。
        string ua = context.Request.Headers.UserAgent.ToString();
        return string.IsNullOrEmpty(ua) ? "Unknown" : ua;
    }
}