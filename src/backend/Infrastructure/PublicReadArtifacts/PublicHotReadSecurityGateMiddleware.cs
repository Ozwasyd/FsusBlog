using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Security;

using Microsoft.AspNetCore.Mvc;

namespace FsusBlog.Server.Infrastructure.PublicReadArtifacts;

public sealed class PublicReadSecurityGate(
    IPublicHotReadRiskProjection riskProjection,
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

        bool isPublicHotReadL0 = httpContext.Features.Get<PublicHotReadRequestFeature>()?.RequiresSecurityGate == true;
        RiskControlContext riskContext = riskContextFactory.Create(httpContext);
        SecurityRiskPolicy riskPolicy = riskPolicyProvider.CurrentRiskPolicy;
        if (riskContext.VerifiedCrawler || riskContext.SocialPreviewBot)
        {
            RiskDecision crawlerDecision = riskDecisionService.Decide(riskContext, riskPolicy, 0);
            if (crawlerDecision.Kind == RiskDecisionKind.Allow)
            {
                if (isPublicHotReadL0)
                {
                    RecordProjectionSource(
                        httpContext,
                        riskContext.VerifiedCrawler
                            ? PublicHotReadRiskProjectionSources.VerifiedCrawler
                            : PublicHotReadRiskProjectionSources.SocialPreview);
                }

                return null;
            }
        }

        PublicHotReadRiskProjectionLookup projection = PublicHotReadRiskProjectionLookup.Unknown;
        RiskDecision decision;
        if (!riskPolicy.RequiresRiskScoreLookup(riskContext.ActionName))
        {
            if (isPublicHotReadL0)
            {
                RecordProjectionSource(httpContext, PublicHotReadRiskProjectionSources.PolicyDisabled);
            }

            decision = riskDecisionService.Decide(riskContext, riskPolicy, 0);
        }
        else if (isPublicHotReadL0)
        {
            // This lookup is intentionally synchronous and process-local. The
            // public hot-read admission boundary must never await Redis, SQL,
            // filesystem, or HTTP when risk state is missing or stale.
            projection = riskProjection.Lookup(httpContext);
            RecordProjectionSource(httpContext, projection.Source);
            decision = riskDecisionService.Decide(riskContext, riskPolicy, projection.Known ? projection.Score : 0);
            if (!projection.Known && IsEnforcingRiskMode(riskPolicy, riskContext.ActionName))
            {
                decision = FailClosedForUnknownProjection(
                    riskContext,
                    riskPolicy,
                    riskDecisionService,
                    decision);
            }
        }
        else
        {
            // Dynamic public reads (for example comment queries) do not belong
            // to the L0 artifact data plane. Keep their existing strong Redis /
            // durable fallback semantics and do not weaken them to the local
            // eventually-convergent projection.
            int riskScore = await riskScoreReader.GetRiskScoreAsync(
                httpContext,
                httpContext.RequestAborted);
            decision = riskDecisionService.Decide(riskContext, riskPolicy, riskScore);
        }

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

    private static bool IsEnforcingRiskMode(SecurityRiskPolicy policy, string actionName)
    {
        SecurityRiskActionPolicy actionPolicy = policy.ResolveActionPolicy(actionName);
        string mode = SecuritySystemModes.Normalize(actionPolicy.ModeOverride ?? policy.GlobalMode);
        return SecuritySystemModes.IsEnforcing(mode);
    }

    private static RiskDecision FailClosedForUnknownProjection(
        RiskControlContext context,
        SecurityRiskPolicy policy,
        IRiskDecisionService decisionService,
        RiskDecision resolved)
    {
        int failClosedScore = Math.Max(
            policy.MaxRiskScore,
            policy.ResolveActionPolicy(context.ActionName).Thresholds.BlockScore);
        RiskDecision fallback = decisionService.Decide(context, policy, failClosedScore);
        if (fallback.Kind == RiskDecisionKind.Allow)
        {
            // A policy with challenge subsystems disabled must still not turn
            // an unprovable score into an allow. The normal PoW branch below
            // remains the fail-closed response.
            fallback = resolved with
            {
                Kind = RiskDecisionKind.Challenge,
                Reasons = [.. resolved.Reasons, "risk_projection_unknown_fail_closed"]
            };
        }
        else
        {
            fallback = fallback with
            {
                Reasons = [.. fallback.Reasons, "risk_projection_unknown_fail_closed"]
            };
        }

        return fallback;
    }

    private static void RecordProjectionSource(HttpContext httpContext, string source)
    {
        httpContext.Items[PublicHotReadRiskProjectionItemKeys.Source] = source;
        FsusObservability.RecordPublicHotReadRiskProjection(source);
    }
}

public static class PublicHotReadRiskProjectionItemKeys
{
    public const string Source = "__fsus_public_hot_read_risk_projection_source";
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

        httpContext.Features.Set(PublicReadSecurityGateResultFeature.s_allowed);
        await _next(httpContext);
    }
}

public static class PublicHotReadSecurityGateExtensions
{
    public static IApplicationBuilder UseFsusPublicHotReadSecurityGate(this IApplicationBuilder app)
        => app.UseMiddleware<PublicHotReadSecurityGateMiddleware>();
}
