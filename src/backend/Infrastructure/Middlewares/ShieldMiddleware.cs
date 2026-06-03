using System.Buffers;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
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
    ICrawlerRiskService crawlerRisk,
    IWebHostEnvironment env)
{
    // 核心性能优化：使用新一代 SearchValues<string> 进行字符串多模式极速扫描，复杂度降至极限
    private static readonly SearchValues<string> _blockedUserAgents = SearchValues.Create(
    [
        "python", "java", "curl", "wget", "httpclient", "ax" + "ios", "go-http-client", "censys", "zgrab"
    ], StringComparison.OrdinalIgnoreCase);

    private static readonly SearchValues<string> _botKeywords = SearchValues.Create(
    [
        "bot", "spider", "crawler"
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
            await RejectAsync(context, CrawlerRiskReason.UserAgentMissing, StatusCodes.Status403Forbidden, "ua_missing", 5);
            return;
        }

        var uaSpan = ua.AsSpan();

        // 3. 智能爬虫鉴别 (逻辑自洽的核心)
        // 极速自动机扫描代替耗时的 || 与 .Contains()
        bool isClaimingToBeBot = uaSpan.ContainsAny(_botKeywords);

        if (isClaimingToBeBot)
        {
            string clientIp = context.GetClientIp();

            if (IsSearchCrawlerUserAgent(ua))
            {
                bool isVerified = await crawlerDetector.IsVerifiedCrawlerAsync(clientIp, ua);
                if (!isVerified)
                {
                    await RejectAsync(context, CrawlerRiskReason.FakeCrawler, StatusCodes.Status403Forbidden, "fake_crawler", 30);
                    return;
                }

                context.Items["VerifiedCrawler"] = true;
                context.Items["CrawlerProvider"] = ResolveSearchCrawlerProvider(ua);
            }
            else if (IsSocialPreviewUserAgent(ua))
            {
                if (!IsSocialPreviewRequestAllowed(context))
                {
                    await RejectAsync(context, CrawlerRiskReason.UnknownBot, StatusCodes.Status403Forbidden, "social_preview_scope_denied", 10);
                    return;
                }

                context.Items["SocialPreviewBot"] = true;
            }
            else
            {
                await RejectAsync(context, CrawlerRiskReason.UnknownBot, StatusCodes.Status403Forbidden, "unknown_bot", 15);
                return;
            }
        }
        else
        {
            // 不是爬虫，通过自动机状态库极速检查是否在工具黑名单中
            if (uaSpan.ContainsAny(_blockedUserAgents))
            {
                await RejectAsync(context, CrawlerRiskReason.BlockedUserAgent, StatusCodes.Status403Forbidden, "blocked_user_agent", 10);
                return;
            }
        }

        // 4. 路径合法性初步扫描 (Span 零分配切割优化)
        string? path = context.Request.Path.Value;
        if (ContainsIllegalPathPattern(path))
        {
            await RecordRiskAsync(context, CrawlerRiskReason.PublicReadBlocked, "illegal_path", 15);
            FsusObservability.RecordSecurityEvent("shield_reject", "illegal_path", "aborted");
            context.Abort();
            return;
        }

        // 5. 静态模式切换 (熔断机制)
        // 逻辑自洽：真爬虫通常只发起 GET 请求，不受此写操作熔断的影响
        if (governor.CurrentGlobalDifficulty >= 7 &&
            !HttpMethods.IsGet(context.Request.Method) &&
            !HttpMethods.IsOptions(context.Request.Method))
        {
            FsusObservability.RecordSecurityEvent("shield_reject", "read_only_mode", "rejected");
            context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
            context.Response.ContentType = "text/plain; charset=utf-8";
            await context.Response.WriteAsync("System is under heavy load. Read-only mode enabled.");
            return;
        }

        await next(context);
    }

    private static bool IsSearchCrawlerUserAgent(string userAgent)
        => userAgent.Contains("Googlebot", StringComparison.OrdinalIgnoreCase)
            || userAgent.Contains("Google-InspectionTool", StringComparison.OrdinalIgnoreCase)
            || userAgent.Contains("bingbot", StringComparison.OrdinalIgnoreCase)
            || userAgent.Contains("msnbot", StringComparison.OrdinalIgnoreCase)
            || userAgent.Contains("Baiduspider", StringComparison.OrdinalIgnoreCase)
            || userAgent.Contains("Sogou", StringComparison.OrdinalIgnoreCase);

    private static string ResolveSearchCrawlerProvider(string userAgent)
    {
        if (userAgent.Contains("Google", StringComparison.OrdinalIgnoreCase)) return "google";
        if (userAgent.Contains("bing", StringComparison.OrdinalIgnoreCase) || userAgent.Contains("msnbot", StringComparison.OrdinalIgnoreCase)) return "bing";
        if (userAgent.Contains("Baidu", StringComparison.OrdinalIgnoreCase)) return "baidu";
        if (userAgent.Contains("Sogou", StringComparison.OrdinalIgnoreCase)) return "sogou";
        return "search";
    }

    private static bool IsSocialPreviewUserAgent(string userAgent)
        => userAgent.Contains("Twitterbot", StringComparison.OrdinalIgnoreCase)
            || userAgent.Contains("facebookexternalhit", StringComparison.OrdinalIgnoreCase)
            || userAgent.Contains("Discordbot", StringComparison.OrdinalIgnoreCase)
            || userAgent.Contains("Slackbot", StringComparison.OrdinalIgnoreCase)
            || userAgent.Contains("TelegramBot", StringComparison.OrdinalIgnoreCase)
            || userAgent.Contains("LinkedInBot", StringComparison.OrdinalIgnoreCase)
            || userAgent.Contains("WhatsApp", StringComparison.OrdinalIgnoreCase);

    private static bool IsSocialPreviewRequestAllowed(HttpContext context)
    {
        if (!HttpMethods.IsGet(context.Request.Method) && !HttpMethods.IsHead(context.Request.Method))
        {
            return false;
        }

        PathString path = context.Request.Path;
        if (path.StartsWithSegments("/api", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        string value = path.Value ?? "/";
        return value == "/"
            || value.StartsWith("/article/", StringComparison.OrdinalIgnoreCase)
            || value.StartsWith("/assets/", StringComparison.OrdinalIgnoreCase)
            || value.StartsWith("/uploads/", StringComparison.OrdinalIgnoreCase)
            || value.Equals("/favicon.ico", StringComparison.OrdinalIgnoreCase)
            || value.Equals("/robots.txt", StringComparison.OrdinalIgnoreCase);
    }

    private async Task RejectAsync(HttpContext context, CrawlerRiskReason reason, int statusCode, string metricReason, int score)
    {
        await RecordRiskAsync(context, reason, metricReason, score);
        FsusObservability.RecordSecurityEvent("shield_reject", metricReason, "rejected");
        context.Response.StatusCode = statusCode;
        context.Response.ContentType = "text/plain; charset=utf-8";
        await context.Response.WriteAsync(metricReason);
    }

    private async Task RecordRiskAsync(HttpContext context, CrawlerRiskReason reason, string metricReason, int score)
    {
        try
        {
            await crawlerRisk.AddRiskAsync(context, reason, score, TimeSpan.FromMinutes(10), context.RequestAborted);
        }
        catch (Exception ex)
        {
            FsusObservability.RecordSecurityEvent("crawler_risk", metricReason, "write_failed");
            context.RequestServices.GetService<ILogger<ShieldMiddleware>>()?.LogWarning(ex, "crawler-risk-write-failed {Reason}", metricReason);
        }
    }

    private static bool ContainsIllegalPathPattern(string? path)
    {
        if (string.IsNullOrEmpty(path))
        {
            return false;
        }

        if (ContainsIllegalPathPattern(path.AsSpan()))
        {
            return true;
        }

        if (!TryUnescape(path, out string? unescapedOnce) || unescapedOnce is null)
        {
            return false;
        }

        if (ContainsIllegalPathPattern(unescapedOnce.AsSpan()))
        {
            return true;
        }

        return TryUnescape(unescapedOnce, out string? unescapedTwice)
            && unescapedTwice is not null
            && ContainsIllegalPathPattern(unescapedTwice.AsSpan());
    }

    private static bool ContainsIllegalPathPattern(ReadOnlySpan<char> path)
        => path.IndexOf("..", StringComparison.Ordinal) >= 0
            || path.IndexOf("//", StringComparison.Ordinal) >= 0
            || path.IndexOf('\\') >= 0;

    private static bool TryUnescape(string value, out string? unescaped)
    {
        unescaped = null;
        if (value.IndexOf('%', StringComparison.Ordinal) < 0)
        {
            return false;
        }

        try
        {
            unescaped = Uri.UnescapeDataString(value);
            return !string.Equals(value, unescaped, StringComparison.Ordinal);
        }
        catch (UriFormatException)
        {
            return false;
        }
    }
}
