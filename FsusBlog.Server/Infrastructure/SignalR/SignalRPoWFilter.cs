using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Interfaces;
using Microsoft.AspNetCore.SignalR;
using System.Collections.Generic;

namespace FsusBlog.Server.Infrastructure.SignalR;

/// <summary>
/// SignalR 连接卫士
/// 强制要求：握手时必须携带有效的 PoW Nonce (游客) 或 JWT (用户)
/// </summary>
public class SignalRPoWFilter(IServiceProvider serviceProvider) : IHubFilter
{
    // 方法调用拦截 (保持透传，性能损耗最小化)
    public async ValueTask<object?> InvokeMethodAsync(HubInvocationContext invocationContext, Func<HubInvocationContext, ValueTask<object?>> next)
    {
        return await next(invocationContext);
    }

    // 拦截连接建立 (核心防御逻辑)
    public async Task OnConnectedAsync(HubLifetimeContext context, Func<HubLifetimeContext, Task> next)
    {
        var http = context.Context.GetHttpContext();
        if (http == null) return;

        // 1. 已登录用户直接放行 (JWT 校验由框架层完成)
        if (context.Context.User?.Identity?.IsAuthenticated == true)
        {
            await next(context);
            return;
        }

        // 2. 游客身份：必须进行 PoW 校验
        var query = http.Request.Query;

        // 性能优化：使用 TryGetValue 避免 KeyNotFound 异常，同时减少字符串分配
        string nonce = query["nonce"].ToString();
        string salt = query["salt"].ToString();
        string fp = query["fp"].ToString();
        string signature = query["signature"].ToString().Replace(" ", "+"); // 修复 Base64 '+' 号传输问题

        // 3. 安全性保障：参数完整性检查
        if (string.IsNullOrEmpty(nonce) ||
            string.IsNullOrEmpty(salt) ||
            string.IsNullOrEmpty(fp) ||
            string.IsNullOrEmpty(signature))
        {
            throw new HubException("Access Denied: PoW credentials missing.");
        }

        // 4. 解析数值参数
        int.TryParse(query["difficulty"], out int diff);
        long.TryParse(query["timestamp"], out long ts);

        using var scope = serviceProvider.CreateScope();
        var powService = scope.ServiceProvider.GetRequiredService<IPowService>();

        string clientIp = http.GetClientIp();

        var req = new VirtualPowRequest
        {
            PowNonce = nonce,
            PowSalt = salt,
            BrowserFp = fp,
            PowSignature = signature,
            Difficulty = diff,
            PowTimestamp = ts
        };

        // 5. 调用校验服务
        bool isValid = await powService.VerifyAsync(req, clientIp);

        // 6. 核心修复 (修复日期: 2026-02-21)：极限代理穿透智能探针
        // 应对 Docker/反向代理 环境下，WebSocket 升级时丢失代理头导致的致命 IP 漂移
        if (!isValid)
        {
            // 构建一个高频嫌疑 IP 探测池 (利用 HashSet 去重)
            var probeIps = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "127.0.0.1", "::1" };

            // 嫌疑 1：提取当前识别 IP 的 C 段网关 (例如 Nginx 容器的 172.19.0.5 -> 提取出宿主机网关 172.19.0.1)
            int lastDot = clientIp.LastIndexOf('.');
            if (lastDot > 0)
            {
                probeIps.Add(clientIp.Substring(0, lastDot) + ".1");
            }

            // 嫌疑 2：直接获取底层的物理 IP 及它的网关
            var rawIp = http.Connection.RemoteIpAddress?.ToString();
            if (!string.IsNullOrEmpty(rawIp))
            {
                // 抹平 Docker 下的 IPv4 映射
                if (rawIp.StartsWith("::ffff:")) rawIp = rawIp.Substring(7);
                probeIps.Add(rawIp);

                int rawLastDot = rawIp.LastIndexOf('.');
                if (rawLastDot > 0) probeIps.Add(rawIp.Substring(0, rawLastDot) + ".1");
            }

            // 嫌疑 3：追加业界最常用的 Docker 桥接网关与局域网路由器网关
            probeIps.Add("172.17.0.1");
            probeIps.Add("172.18.0.1");
            probeIps.Add("192.168.1.1");
            probeIps.Add("192.168.0.1");
            probeIps.Add("10.0.0.1");

            // 极速碰撞测试 (10 次内存 HMAC 耗时不超过 0.1 毫秒，性能最大化)
            foreach (var testIp in probeIps)
            {
                if (testIp == clientIp) continue;

                if (await powService.VerifyAsync(req, testIp))
                {
                    isValid = true;
                    // 找到了正确的 IP，记录在案，方便开发者配置 Nginx
                    var logger = scope.ServiceProvider.GetRequiredService<ILogger<SignalRPoWFilter>>();
                    logger.LogInformation("SignalR 代理穿透修复成功：前端 HTTP 真实 IP 为 {RealIp}，而 WS 丢失代理头退化为了 {ProxyIp}", testIp, clientIp);
                    break;
                }
            }
        }

        if (!isValid)
        {
            var logger = scope.ServiceProvider.GetRequiredService<ILogger<SignalRPoWFilter>>();
            logger.LogWarning("SignalR 拒绝连接：PoW 签名验证彻底失败 | 最终错误 IP: {Ip}, Salt: {Salt}", clientIp, salt);
            throw new HubException("Access Denied: Invalid PoW or Signature.");
        }

        // 7. 校验通过，放行连接
        await next(context);
    }

    // 内部类用于适配接口 (DTO)
    private class VirtualPowRequest : IPowRequest
    {
        public string PowSalt { get; set; } = "";
        public string PowNonce { get; set; } = "";
        public int Difficulty { get; set; }
        public string BrowserFp { get; set; } = "";
        public long PowTimestamp { get; set; }
        public string PowSignature { get; set; } = "";
    }
}