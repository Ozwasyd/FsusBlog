using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using Microsoft.AspNetCore.Mvc;

namespace FsusBlog.Server.Infrastructure.Filters;

public sealed class RiskAwarePublicReadFilter(
    ICrawlerRiskService crawlerRisk,
    ILogger<RiskAwarePublicReadFilter> logger,
    IPowService powService,
    AdaptivePowGovernor governor) : IEndpointFilter
{
    private const string PowHeaderName = "X-Fsus-Pow-Proof";

    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        HttpContext httpContext = context.HttpContext;
        if (httpContext.Items.TryGetValue("VerifiedCrawler", out object? verifiedCrawler) && verifiedCrawler is true)
        {
            return await next(context);
        }

        if (httpContext.Items.TryGetValue("SocialPreviewBot", out object? socialPreview) && socialPreview is true)
        {
            return await next(context);
        }

        int riskScore = await crawlerRisk.GetRiskScoreAsync(httpContext, httpContext.RequestAborted);
        if (riskScore >= CrawlerRiskService.BlockScore)
        {
            await crawlerRisk.AddRiskAsync(httpContext, CrawlerRiskReason.PublicReadBlocked, 5, TimeSpan.FromMinutes(10), httpContext.RequestAborted);
            return EndpointFilterResults.FromActionResult(
                new ObjectResult(ErrorDetail.Create(ErrorCode.Forbidden, "公开读取请求已被风险策略限速", traceId: httpContext.TraceIdentifier))
                {
                    StatusCode = StatusCodes.Status429TooManyRequests
                },
                httpContext);
        }

        if (riskScore < CrawlerRiskService.RequirePowScore)
        {
            return await next(context);
        }

        if (!httpContext.Request.Headers.TryGetValue(PowHeaderName, out var proof) || proof.Count != 1)
        {
            await crawlerRisk.AddRiskAsync(httpContext, CrawlerRiskReason.PublicReadPowRequired, 5, TimeSpan.FromMinutes(10), httpContext.RequestAborted);
            return EndpointFilterResults.FromActionResult(
                new ObjectResult(ErrorDetail.Create(ErrorCode.Forbidden, "公开读取请求需要 PoW 凭证", traceId: httpContext.TraceIdentifier))
                {
                    StatusCode = StatusCodes.Status428PreconditionRequired
                },
                httpContext);
        }

        IActionResult? validation = await PowValidationLogic.ValidateAsync(httpContext, logger, powService, governor);
        if (validation is not null)
        {
            await crawlerRisk.AddRiskAsync(httpContext, CrawlerRiskReason.PowInvalid, 10, TimeSpan.FromMinutes(10), httpContext.RequestAborted);
            return EndpointFilterResults.FromActionResult(validation, httpContext);
        }

        return await next(context);
    }
}
