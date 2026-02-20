using FsusBlog.Server.Infrastructure.Security;

namespace FsusBlog.Server.Infrastructure.Middlewares;

/// <summary>
/// 零容忍防御中间件 (The Shield)
/// 职责：在请求进入 Pipeline 最前端时，直接过滤非法特征
/// </summary>
public class ShieldMiddleware(RequestDelegate next, AdaptivePowGovernor governor)
{
    // 简单过滤常见脚本和爬虫工具
    private static readonly string[] _blockedUserAgents =
    [
        "python", "java", "curl", "wget", "httpclient", "axios", "spider", "bot"
    ];

    public async Task InvokeAsync(HttpContext context)
    {
        // 1. 流量计数 (喂给治理器，用于自适应难度动态计算)
        // 必须放在最前端，以感知最真实的进站压力（Raw Traffic）
        governor.RecordInboundRequest();

        // 2. 协议指纹检查 (User-Agent)
        string ua = context.Request.Headers.UserAgent.ToString();

        // 安全性保障：拒绝空 UA 或包含黑名单特征的 UA
        if (string.IsNullOrWhiteSpace(ua) || _blockedUserAgents.Any(bad => ua.Contains(bad, StringComparison.OrdinalIgnoreCase)))
        {
            //  性能最大化：隐身模式。直接断开 TCP 连接，不返回任何响应，不消耗带宽。
            // 由于在异常处理中间件之前，该操作直接由 Kestrel 终端处理。
            context.Abort();
            return;
        }

        // 3. 安全性加固：路径合法性初步扫描
        // 拦截明显的目录穿越攻击或非法路径字符
        var path = context.Request.Path.Value;
        if (path != null && (path.Contains("..") || path.Contains("//")))
        {
            context.Abort();
            return;
        }

        // 4. 静态模式切换 (熔断机制)
        // 如果治理器判定进入 WAR_MODE (难度7)，且当前请求涉及数据库写操作 (POST/PUT/DELETE)
        if (governor.CurrentGlobalDifficulty >= 7 &&
            !HttpMethods.IsGet(context.Request.Method) &&
            !HttpMethods.IsOptions(context.Request.Method))
        {
            // 逻辑自洽：由于在 GlobalException 之前，必须手动配置响应内容
            context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
            context.Response.ContentType = "text/plain; charset=utf-8";
            await context.Response.WriteAsync("System is under heavy load. Read-only mode enabled.");
            return;
        }

        // 5. 移交控制权
        await next(context);
    }
}