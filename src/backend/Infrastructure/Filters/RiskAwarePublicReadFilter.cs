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
    IRiskControlContextFactory riskContextFactory,
    IRiskDecisionService riskDecisionService,
    ILogger<RiskAwarePublicReadFilter> logger,
    IPowService powService,
    AdaptivePowGovernor governor) : IEndpointFilter
{
    private const string PowHeaderName = "X-Fsus-Pow-Proof";

    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        HttpContext httpContext = context.HttpContext;
        RiskControlContext riskContext = riskContextFactory.Create(httpContext);
        SecurityRiskPolicySnapshotV2 riskPolicy = riskPolicyProvider.CurrentRiskPolicyV2;
        if (riskContext.VerifiedCrawler || riskContext.SocialPreviewBot)
        {
            RiskDecision crawlerDecision = riskDecisionService.Decide(riskContext, riskPolicy, 0);
            if (crawlerDecision.Kind == RiskDecisionKind.Allow)
            {
                return await next(context);
            }
        }

        int riskScore = await riskScoreReader.GetRiskScoreAsync(httpContext, httpContext.RequestAborted);
        RiskDecision decision = riskDecisionService.Decide(riskContext, riskPolicy, riskScore);
        if (decision.Kind == RiskDecisionKind.Allow)
        {
            return await next(context);
        }

        if (decision.Kind == RiskDecisionKind.Block)
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

        if (decision.Kind is RiskDecisionKind.QueueForModeration or RiskDecisionKind.Throttle)
        {
            await riskSignalSink.AddRiskAsync(new SecurityRiskSignal(
                httpContext,
                SecurityRiskReason.PublicReadBlocked,
                5,
                TimeSpan.FromMinutes(10),
                SecurityRiskSources.PublicRead,
                "public_read_throttled",
                string.Join(',', decision.Reasons)), httpContext.RequestAborted);
            return EndpointFilterResults.FromActionResult(
                new ObjectResult(ErrorDetail.Create(ErrorCode.Forbidden, "公开读取请求已被风险策略延迟", traceId: httpContext.TraceIdentifier))
                {
                    StatusCode = StatusCodes.Status429TooManyRequests
                },
                httpContext);
        }

        if (!httpContext.Request.Headers.TryGetValue(PowHeaderName, out var proof) || proof.Count != 1)
        {
            // Requiring a PoW challenge is part of the normal public-read handshake.
            // Only failed proof validation should raise crawler risk.
            await riskSignalSink.AddRiskAsync(new SecurityRiskSignal(
                httpContext,
                SecurityRiskReason.PublicReadChallengeRequired,
                0,
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
            return EndpointFilterResults.FromActionResult(validation, httpContext);
        }

        return await next(context);
    }
}
