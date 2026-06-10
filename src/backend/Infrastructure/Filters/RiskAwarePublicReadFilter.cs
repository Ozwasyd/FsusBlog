using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Security;
using Microsoft.AspNetCore.Mvc;

namespace FsusBlog.Server.Infrastructure.Filters;

public sealed class RiskAwarePublicReadFilter(
    ISecurityRiskScoreReader riskScoreReader,
    ISecurityRiskSignalSink riskSignalSink,
    ISecurityRiskPolicyProvider riskPolicyProvider,
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

        SecurityRiskPolicySnapshot riskPolicy = riskPolicyProvider.CurrentRiskPolicy;
        if (!riskPolicy.PublicReadChallengeEnabled)
        {
            return await next(context);
        }

        int riskScore = await riskScoreReader.GetRiskScoreAsync(httpContext, httpContext.RequestAborted);
        if (riskScore >= riskPolicy.BlockScore)
        {
            await riskSignalSink.AddRiskAsync(new SecurityRiskSignal(
                httpContext,
                SecurityRiskReason.PublicReadBlocked,
                5,
                TimeSpan.FromMinutes(10),
                SecurityRiskSources.PublicRead,
                "public_read_blocked",
                "risk_policy_block"), httpContext.RequestAborted);
            return EndpointFilterResults.FromActionResult(
                new ObjectResult(ErrorDetail.Create(ErrorCode.Forbidden, "公开读取请求已被风险策略限速", traceId: httpContext.TraceIdentifier))
                {
                    StatusCode = StatusCodes.Status429TooManyRequests
                },
                httpContext);
        }

        if (riskScore < riskPolicy.RequireChallengeScore)
        {
            return await next(context);
        }

        if (!httpContext.Request.Headers.TryGetValue(PowHeaderName, out var proof) || proof.Count != 1)
        {
            await riskSignalSink.AddRiskAsync(new SecurityRiskSignal(
                httpContext,
                SecurityRiskReason.PublicReadChallengeRequired,
                5,
                TimeSpan.FromMinutes(10),
                SecurityRiskSources.PublicRead,
                "public_read_challenge_required",
                "security.pow"), httpContext.RequestAborted);
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
            await riskSignalSink.AddRiskAsync(new SecurityRiskSignal(
                httpContext,
                SecurityRiskReason.PowInvalid,
                10,
                TimeSpan.FromMinutes(10),
                SecurityRiskSources.Pow,
                "pow_invalid",
                "public_read_challenge"), httpContext.RequestAborted);
            return EndpointFilterResults.FromActionResult(validation, httpContext);
        }

        return await next(context);
    }
}
