using System.Net;

namespace FsusBlog.Server.Infrastructure.Helpers;

/// <summary>
/// HttpContext 扩展：用于精准提取客户端请求元数据
/// </summary>
public static class HttpContextExtensions
{
    /// <summary>
    /// 获取客户端真实 IP 地址 (深度适配代理穿透与 IPv6)
    /// </summary>
    public static string GetClientIp(this HttpContext context)
    {
        string? ip = string.Empty;

        // 1. 优先尝试从 X-Forwarded-For 获取 (由 Nginx/CDN 设置)
        var forwardedHeader = context.Request.Headers["X-Forwarded-For"].FirstOrDefault();
        if (!string.IsNullOrEmpty(forwardedHeader))
        {
            // 性能优化：使用 IndexOf 替代 Split，避免高并发下的数组内存分配
            int commaIndex = forwardedHeader.IndexOf(',');
            if (commaIndex > 0)
            {
                ip = forwardedHeader[..commaIndex].Trim();
            }
            else
            {
                ip = forwardedHeader.Trim();
            }
        }

        // 2. 备选：从 X-Real-IP 获取
        if (string.IsNullOrWhiteSpace(ip))
        {
            ip = context.Request.Headers["X-Real-IP"].FirstOrDefault();
        }

        // 3. 兜底：获取直接连接的远程地址 (SignalR WebSocket 常走此分支)
        if (string.IsNullOrWhiteSpace(ip))
        {
            ip = context.Connection.RemoteIpAddress?.ToString();
        }

        if (string.IsNullOrWhiteSpace(ip))
        {
            return "127.0.0.1";
        }

        // 4. 鲁棒性重构：剥离端口号 (移除 LINQ 操作以提升性能)
        int closeBracket = ip.IndexOf(']');
        if (closeBracket > 0 && ip[0] == '[')
        {
            ip = ip[1..closeBracket];
        }
        else
        {
            int firstColon = ip.IndexOf(':');
            if (firstColon != -1 && firstColon == ip.LastIndexOf(':'))
            {
                ip = ip[..firstColon];
            }
        }

        // 5. 核心修复 (修复日期: 2026-02-21)：根治 Docker/Kestrel 下的 IP 字符串漂移问题
        // 强制将 IPv4-Mapped-IPv6 (如 ::ffff:172.19.0.5) 降维转换回纯 IPv4 (172.19.0.5)
        // 确保 HTTP 获取 Challenge 和 SignalR 验证 Challenge 时，提取到的 IP 字符串绝对一致
        if (IPAddress.TryParse(ip, out var parsedAddress))
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

        return ip;
    }

    /// <summary>
    /// 获取客户端 User-Agent (用于统计访问设备与浏览器)
    /// </summary>
    public static string GetUserAgent(this HttpContext context) => context.Request.Headers.UserAgent.ToString() ?? "Unknown";
}