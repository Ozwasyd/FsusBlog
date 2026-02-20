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

        // 1. 尝试从 X-Forwarded-For 获取 (由 Nginx/CDN 设置，格式: client, proxy1, proxy2)
        var forwardedHeader = context.Request.Headers["X-Forwarded-For"].FirstOrDefault();
        if (!string.IsNullOrEmpty(forwardedHeader))
        {
            // 取列表中的第一个，即为原始客户端 IP
            ip = forwardedHeader.Split(',', StringSplitOptions.RemoveEmptyEntries)
                                .FirstOrDefault()?.Trim();
        }

        // 2. 备选：从 X-Real-IP 获取 (部分反向代理配置)
        if (string.IsNullOrWhiteSpace(ip))
        {
            ip = context.Request.Headers["X-Real-IP"].FirstOrDefault();
        }

        // 3. 兜底：获取直接连接的远程地址
        if (string.IsNullOrWhiteSpace(ip))
        {
            ip = context.Connection.RemoteIpAddress?.ToString();
        }

        // 4. 归一化处理
        if (ip == "::1") ip = "127.0.0.1";

        // 5. 鲁棒性重构：安全裁剪端口号
        // IPv4 示例: 192.168.1.1:5000 -> 192.168.1.1
        // IPv6 示例: [2001:db8::1]:5000 -> 2001:db8::1
        // 纯 IPv6 不处理: 2001:db8::1
        if (!string.IsNullOrWhiteSpace(ip))
        {
            if (ip.Contains(']')) // 处理带端口的 IPv6
            {
                ip = ip.Split(']').First().TrimStart('[');
            }
            else if (ip.Count(c => c == ':') == 1) // 处理带端口的 IPv4 (排除不带端口的 IPv6)
            {
                ip = ip.Split(':').First();
            }
        }

        return string.IsNullOrWhiteSpace(ip) ? "127.0.0.1" : ip;
    }

    /// <summary>
    /// 获取客户端 User-Agent (用于统计访问设备与浏览器)
    /// </summary>
    public static string GetUserAgent(this HttpContext context) => context.Request.Headers.UserAgent.ToString() ?? "Unknown";
}