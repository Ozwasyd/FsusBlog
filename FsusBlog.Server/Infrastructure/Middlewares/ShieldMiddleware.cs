using System.Buffers;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Services.Security;

namespace FsusBlog.Server.Infrastructure.Middlewares;

/// <summary>
/// 零容忍防御中间件 (The Shield)
/// 修复日期: 2026-02-22 (引入 SearchValues 实现 Aho-Corasick 自动机，消除 String 驻留与 GC Alloc，实现极速清洗)
/// 职责：在请求进入 Pipeline 最前端时，直接过滤非法特征，但为真爬虫通过 VIP 通道
/// </summary>
public class ShieldMiddleware(
    RequestDelegate next,
    AdaptivePowGovernor governor,
    CrawlerDetectorService crawlerDetector,
    IWebHostEnvironment env)
{
    // 核心性能优化：使用新一代 SearchValues<string> 进行字符串多模式极速扫描，复杂度降至极限
    private static readonly SearchValues<string> _blockedUserAgents = SearchValues.Create(
    [
        "python", "java", "curl", "wget", "httpclient", "axios", "go-http-client", "censys", "zgrab"
    ], StringComparison.OrdinalIgnoreCase);

    private static readonly SearchValues<string> _botKeywords = SearchValues.Create(
    [
        "bot", "spider"
    ], StringComparison.OrdinalIgnoreCase);

    public async Task InvokeAsync(HttpContext context)
    {
        if (context.Request.Path.StartsWithSegments("/health", StringComparison.OrdinalIgnoreCase))
        {
            await next(context);
            return;
        }

        if (env.IsDevelopment())
        {
            await next(context);
            return;
        }

        // 1. 流量计数 (喂给治理器，用于自适应难度动态计算)
        governor.RecordInboundRequest();

        string? ua = context.Request.Headers.UserAgent;

        // 2. 协议指纹检查 (User-Agent)
        if (string.IsNullOrWhiteSpace(ua))
        {
            // 开发阶段兼容：部分本地代理/健康检查不会带 User-Agent。
            // 若直接 Abort 会让上游看到 502（连接被重置）。
            if (env.IsDevelopment())
            {
                await next(context);
                return;
            }
            context.Abort();
            return;
        }

        var uaSpan = ua.AsSpan();

        // 3. 智能爬虫鉴别 (逻辑自洽的核心)
        // 极速自动机扫描代替耗时的 || 与 .Contains()
        bool isClaimingToBeBot = uaSpan.ContainsAny(_botKeywords);

        if (isClaimingToBeBot)
        {
            string clientIp = context.GetClientIp();

            // 调用内存级极速验证
            bool isVerified = await crawlerDetector.IsVerifiedCrawlerAsync(clientIp, ua);

            if (!isVerified)
            {
                // 伪造的爬虫！冒充 Googlebot 但 IP 不对 -> 立即斩立决
                context.Abort();
                return;
            }

            // 真爬虫：打上 VIP 标记，供后续中间件（如 PoW 校验、限流器）豁免
            context.Items["VerifiedCrawler"] = true;
        }
        else
        {
            // 不是爬虫，通过自动机状态库极速检查是否在工具黑名单中
            if (uaSpan.ContainsAny(_blockedUserAgents))
            {
                context.Abort();
                return;
            }
        }

        // 4. 路径合法性初步扫描 (Span 零分配切割优化)
        string? path = context.Request.Path.Value;
        if (path != null)
        {
            var pathSpan = path.AsSpan();
            if (pathSpan.IndexOf("..") >= 0 || pathSpan.IndexOf("//") >= 0)
            {
                context.Abort();
                return;
            }
        }

        // 5. 静态模式切换 (熔断机制)
        // 逻辑自洽：真爬虫通常只发起 GET 请求，不受此写操作熔断的影响
        if (governor.CurrentGlobalDifficulty >= 7 &&
            !HttpMethods.IsGet(context.Request.Method) &&
            !HttpMethods.IsOptions(context.Request.Method))
        {
            context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
            context.Response.ContentType = "text/plain; charset=utf-8";
            await context.Response.WriteAsync("System is under heavy load. Read-only mode enabled.");
            return;
        }

        await next(context);
    }
}
