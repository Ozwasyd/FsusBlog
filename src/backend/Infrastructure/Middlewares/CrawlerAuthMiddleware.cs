using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Services.Security;

namespace FsusBlog.Server.Infrastructure.Middlewares;

public class CrawlerAuthMiddleware(
    RequestDelegate _next,
    CrawlerDetectorService _detector)
{
    public async Task InvokeAsync(HttpContext context)
    {
        string userAgent = context.GetUserAgent();

        // 性能优化：只有 UA 包含 "bot" 或 "spider" 关键字时才触发昂贵的验证逻辑
        if (userAgent.Contains("bot", StringComparison.OrdinalIgnoreCase) ||
            userAgent.Contains("spider", StringComparison.OrdinalIgnoreCase))
        {
            string clientIp = context.GetClientIp();

            // 调用核心大脑进行验证
            bool isVerified = await _detector.IsVerifiedCrawlerAsync(clientIp, userAgent);

            if (isVerified)
            {
                // 核心动作：打上 "VerifiedCrawler" 标记
                // 后续的 RateLimiting 限流器可以检查这个 Metadata 并豁免拦截
                context.Items["VerifiedCrawler"] = true;

                // 也可以设置 Header 方便 Nginx 或日志识别
                context.Response.Headers.Append("X-Crawler-Auth", "Pass");
            }
        }

        await _next(context);
    }
}
