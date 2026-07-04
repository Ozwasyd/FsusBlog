using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Security;
using Microsoft.AspNetCore.Mvc;

namespace FsusBlog.Server.Infrastructure.PublicReadArtifacts;

public sealed class PublicHotReadSecurityGateMiddleware(RequestDelegate next)
{
    private const string PowHeaderName = "X-Fsus-Pow-Proof";
    private readonly RequestDelegate _next = next;

    public async Task InvokeAsync(
        HttpContext httpContext,
        ISecurityRiskScoreReader riskScoreReader,
        ISecurityRiskSignalSink riskSignalSink,
        ISecurityRiskPolicyProvider riskPolicyProvider,
        IRiskControlContextFactory riskContextFactory,
        IRiskDecisionService riskDecisionService,
        ILogger<PublicHotReadSecurityGateMiddleware> logger,
        IPowService powService,
        AdaptivePowGovernor governor)
    {
        if (!PublicHotReadFastPath.RequiresSecurityGateForRequest(httpContext.Request.Path.Value))
        {
            await _next(httpContext);
            return;
        }

        EnsurePublicReadRiskMetadata(httpContext);

        RiskControlContext riskContext = riskContextFactory.Create(httpContext);
        SecurityRiskPolicySnapshotV2 riskPolicy = riskPolicyProvider.CurrentRiskPolicyV2;
        if (riskContext.VerifiedCrawler || riskContext.SocialPreviewBot)
        {
            RiskDecision crawlerDecision = riskDecisionService.Decide(riskContext, riskPolicy, 0);
            if (crawlerDecision.Kind == RiskDecisionKind.Allow)
            {
                await _next(httpContext);
                return;
            }
        }

        int riskScore = await riskScoreReader.GetRiskScoreAsync(httpContext, httpContext.RequestAborted);
        RiskDecision decision = riskDecisionService.Decide(riskContext, riskPolicy, riskScore);
        if (decision.Kind == RiskDecisionKind.Allow)
        {
            await _next(httpContext);
            return;
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
                "hot_read_risk_policy_block"), httpContext.RequestAborted);
            await WriteErrorAsync(
                httpContext,
                StatusCodes.Status429TooManyRequests,
                ErrorCode.Forbidden,
                "公开读取请求已被风险策略限速");
            return;
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
            await WriteErrorAsync(
                httpContext,
                StatusCodes.Status429TooManyRequests,
                ErrorCode.Forbidden,
                "公开读取请求已被风险策略延迟");
            return;
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
            await WriteErrorAsync(
                httpContext,
                StatusCodes.Status428PreconditionRequired,
                ErrorCode.Forbidden,
                "公开读取请求需要 PoW 凭证");
            return;
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
                "public_hot_read_challenge"), httpContext.RequestAborted);
            await EndpointFilterResults.FromActionResult(validation, httpContext).ExecuteAsync(httpContext);
            return;
        }

        await _next(httpContext);
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

    private static Task WriteErrorAsync(HttpContext httpContext, int statusCode, ErrorCode code, string message)
        => EndpointFilterResults.FromActionResult(
                new ObjectResult(ErrorDetail.Create(code, message, traceId: httpContext.TraceIdentifier))
                {
                    StatusCode = statusCode
                },
                httpContext)
            .ExecuteAsync(httpContext);
}

public static class PublicHotReadSecurityGateExtensions
{
    public static IApplicationBuilder UseFsusPublicHotReadSecurityGate(this IApplicationBuilder app)
        => app.UseMiddleware<PublicHotReadSecurityGateMiddleware>();
}
