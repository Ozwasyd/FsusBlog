using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Security;

using Microsoft.AspNetCore.Mvc;

namespace FsusBlog.Server.Infrastructure.PublicReadArtifacts;

public sealed class PublicReadSecurityGate(
    ISecurityRiskScoreReader riskScoreReader,
    ISecurityRiskSignalSink riskSignalSink,
    ISecurityRiskPolicyProvider riskPolicyProvider,
    IRiskControlContextFactory riskContextFactory,
    IRiskDecisionService riskDecisionService,
    ILogger<PublicReadSecurityGate> logger,
    IPowService powService,
    AdaptivePowGovernor governor)
{
    private const string PowHeaderName = "X-Fsus-Pow-Proof";

    public async ValueTask<IResult?> EvaluateAsync(HttpContext httpContext)
    {
        EnsurePublicReadRiskMetadata(httpContext);

        RiskControlContext riskContext = riskContextFactory.Create(httpContext);
        SecurityRiskPolicySnapshotV2 riskPolicy = riskPolicyProvider.CurrentRiskPolicyV2;
        if (riskContext.VerifiedCrawler || riskContext.SocialPreviewBot)
        {
            RiskDecision crawlerDecision = riskDecisionService.Decide(riskContext, riskPolicy, 0);
            if (crawlerDecision.Kind == RiskDecisionKind.Allow)
            {
                return null;
            }
        }

        int riskScore = riskPolicy.RequiresRiskScoreLookup(riskContext.ActionName)
            ? await riskScoreReader.GetRiskScoreAsync(httpContext, httpContext.RequestAborted)
            : 0;
        RiskDecision decision = riskDecisionService.Decide(riskContext, riskPolicy, riskScore);
        if (decision.Kind == RiskDecisionKind.Allow)
        {
            return null;
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
                httpContext.Features.Get<PublicHotReadRequestFeature>() is null
                    ? "risk_policy_block"
                    : "hot_read_risk_policy_block"), httpContext.RequestAborted);
            return CreateError(
                httpContext,
                StatusCodes.Status429TooManyRequests,
                ErrorCode.Forbidden,
                "公开读取请求已被风险策略限速");
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
            return CreateError(
                httpContext,
                StatusCodes.Status429TooManyRequests,
                ErrorCode.Forbidden,
                "公开读取请求已被风险策略延迟");
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
            return CreateError(
                httpContext,
                StatusCodes.Status428PreconditionRequired,
                ErrorCode.Forbidden,
                "公开读取请求需要 PoW 凭证");
        }

        IActionResult? validation = await PowValidationLogic.ValidateAsync(httpContext, logger, powService, governor);
        return validation is null
            ? null
            : EndpointFilterResults.FromActionResult(validation, httpContext);
    }

    private static void EnsurePublicReadRiskMetadata(HttpContext httpContext)
    {
        if (RiskActionRegistry.Default.TryGetEndpointMetadata(httpContext.GetEndpoint(), out _)
            || httpContext.Items.ContainsKey(RiskActionEndpointMetadata.HttpContextItemKey))
        {
            return;
        }

        httpContext.Items[RiskActionEndpointMetadata.HttpContextItemKey] =
            RiskActionRegistry.Default.CreateMetadata(RiskActionNames.PublicRead, BuildFallbackRouteKey(httpContext));
    }

    private static string BuildFallbackRouteKey(HttpContext httpContext)
        => httpContext.Request.Path.Value is { Length: > 0 } path && path.StartsWith("/api/binary/", StringComparison.Ordinal)
            ? "public.hot-read.binary"
            : "public.hot-read.html";

    private static IResult CreateError(HttpContext httpContext, int statusCode, ErrorCode code, string message)
        => EndpointFilterResults.FromActionResult(
                new ObjectResult(ErrorDetail.Create(code, message, traceId: httpContext.TraceIdentifier))
                {
                    StatusCode = statusCode
                },
                httpContext);
}

public sealed class PublicHotReadSecurityGateMiddleware(RequestDelegate next)
{
    private readonly RequestDelegate _next = next;

    public async Task InvokeAsync(HttpContext httpContext, PublicReadSecurityGate gate)
    {
        PublicHotReadRequestFeature? feature = httpContext.Features.Get<PublicHotReadRequestFeature>();
        if (feature?.RequiresSecurityGate != true)
        {
            await _next(httpContext);
            return;
        }

        IResult? rejection = await gate.EvaluateAsync(httpContext);
        if (rejection is not null)
        {
            await rejection.ExecuteAsync(httpContext);
            return;
        }

        httpContext.Features.Set(PublicReadSecurityGateResultFeature.Allowed);
        await _next(httpContext);
    }
}

public static class PublicHotReadSecurityGateExtensions
{
    public static IApplicationBuilder UseFsusPublicHotReadSecurityGate(this IApplicationBuilder app)
        => app.UseMiddleware<PublicHotReadSecurityGateMiddleware>();
}
