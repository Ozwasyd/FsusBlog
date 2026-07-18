using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Security;

using Microsoft.AspNetCore.Mvc;

namespace FsusBlog.Server.Infrastructure.Filters;

public sealed partial class RequiresRiskControlFilter(
    ISecurityRiskScoreReader riskScoreReader,
    ISecurityRiskSignalSink riskSignalSink,
    ISecurityRiskPolicyProvider riskPolicyProvider,
    IRiskControlContextFactory riskContextFactory,
    IRiskDecisionService riskDecisionService,
    ISecurityChallengeProofService challengeProofService,
    ILogger<RequiresRiskControlFilter> logger) : IEndpointFilter
{
    public const string ChallengeProofHeaderName = SecurityChallengeProofService.HeaderName;
    public const string ChallengeIdHeaderName = "X-Fsus-Challenge-Id";
    public const string ChallengeKindHeaderName = "X-Fsus-Challenge-Kind";

    private static readonly TimeSpan RiskSignalTtl = TimeSpan.FromMinutes(10);

    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        HttpContext httpContext = context.HttpContext;
        RiskControlContext riskContext = riskContextFactory.Create(httpContext);
        if (riskContext.ActionStatus != RiskControlContextStatuses.Resolved)
        {
            await RecordRiskAsync(httpContext, "risk_action_metadata_missing", riskContext.ActionName, httpContext.RequestAborted);
            return Error(httpContext, StatusCodes.Status500InternalServerError, ErrorCode.InfraFailure, "Risk action metadata is required");
        }

        int riskScore = await riskScoreReader.GetRiskScoreAsync(httpContext, httpContext.RequestAborted);
        SecurityRiskPolicySnapshotV2 policy = riskPolicyProvider.CurrentRiskPolicyV2;
        RiskDecision decision = riskDecisionService.Decide(riskContext, policy, riskScore);

        return decision.Kind switch
        {
            RiskDecisionKind.Allow => await next(context),
            RiskDecisionKind.Challenge or RiskDecisionKind.StepUp => await HandleChallengeAsync(context, next, riskContext, decision),
            RiskDecisionKind.Block => await RejectAsync(httpContext, decision, StatusCodes.Status429TooManyRequests, "risk_control_blocked", "请求已被风险策略拦截"),
            RiskDecisionKind.QueueForModeration => await QueueForModerationAsync(context, next, decision),
            RiskDecisionKind.Throttle => await RejectAsync(httpContext, decision, StatusCodes.Status429TooManyRequests, "risk_control_throttled", "请求已被风险策略延迟"),
            _ => await RejectAsync(httpContext, decision, StatusCodes.Status429TooManyRequests, "risk_control_rejected", "请求未通过风险策略")
        };
    }

    private async ValueTask<object?> HandleChallengeAsync(
        EndpointFilterInvocationContext context,
        EndpointFilterDelegate next,
        RiskControlContext riskContext,
        RiskDecision decision)
    {
        HttpContext httpContext = context.HttpContext;
        if (IsAdminSensitiveRiskAction(decision.ActionName))
        {
            await RecordRiskAsync(
                httpContext,
                "ordinary_challenge_proof_not_allowed_for_admin_sensitive",
                decision.ActionName,
                httpContext.RequestAborted);
            return Error(httpContext, StatusCodes.Status428PreconditionRequired, ErrorCode.Forbidden, "MFA_PROOF_REQUIRED");
        }

        if (decision.RequiredChallenges.Count > 1)
        {
            await RecordRiskAsync(
                httpContext,
                $"challenge_set_incomplete:{decision.RequiredChallenges.Count}",
                decision.ActionName,
                httpContext.RequestAborted);
            return Error(httpContext, StatusCodes.Status428PreconditionRequired, ErrorCode.Forbidden, "RISK_CHALLENGE_SET_INCOMPLETE");
        }

        if (!TryReadSingleHeader(httpContext, ChallengeProofHeaderName, out string proofToken)
            || !TryReadSingleHeader(httpContext, ChallengeIdHeaderName, out string challengeId)
            || !TryReadSingleHeader(httpContext, ChallengeKindHeaderName, out string challengeKind))
        {
            // Missing proof is the normal first leg of a challenge handshake.
            // Rejected or replayed proof is the risky signal, not requesting the challenge.
            await RecordRiskAsync(httpContext, "challenge_proof_missing", decision.ActionName, httpContext.RequestAborted, score: 0);
            return Error(httpContext, StatusCodes.Status428PreconditionRequired, ErrorCode.Forbidden, "RISK_CHALLENGE_PROOF_REQUIRED");
        }

        string canonicalChallengeKind = CanonicalChallengeKind(challengeKind);
        if (decision.RequiredChallenges.Count > 0
            && !decision.RequiredChallenges.Any(required => string.Equals(CanonicalChallengeKind(required), canonicalChallengeKind, StringComparison.Ordinal)))
        {
            await RecordRiskAsync(httpContext, $"challenge_kind_mismatch:{challengeKind}", decision.ActionName, httpContext.RequestAborted);
            return Error(httpContext, StatusCodes.Status428PreconditionRequired, ErrorCode.Forbidden, "RISK_CHALLENGE_KIND_MISMATCH");
        }

        RiskControlProofBinding binding = RiskControlProofBindingFactory.Create(riskContext);
        SecurityChallengeProofConsumeResult proof = await challengeProofService.ConsumeProofAsync(
            new SecurityChallengeProofConsumeRequest(
                proofToken,
                challengeId,
                canonicalChallengeKind,
                decision.ActionName,
                decision.RouteKey,
                binding.SubjectHash,
                binding.ClientIpHash,
                binding.DeviceFpHash,
                decision.PolicyVersion),
            httpContext.RequestAborted);

        if (proof.Accepted)
        {
            return await next(context);
        }

        string rejectionReason = proof.Reason;
        LogChallengeRejected(logger, httpContext.TraceIdentifier, decision.ActionName, rejectionReason);
        await RecordRiskAsync(httpContext, $"challenge_proof_rejected:{rejectionReason}", decision.ActionName, httpContext.RequestAborted);
        return Error(httpContext, StatusCodes.Status428PreconditionRequired, ErrorCode.Forbidden, "RISK_CHALLENGE_PROOF_REJECTED");
    }

    private async ValueTask<object?> QueueForModerationAsync(
        EndpointFilterInvocationContext context,
        EndpointFilterDelegate next,
        RiskDecision decision)
    {
        HttpContext httpContext = context.HttpContext;
        if (decision.ActionName is not (RiskActionNames.CommentCreate or RiskActionNames.CommentReply))
        {
            return await RejectAsync(httpContext, decision, StatusCodes.Status429TooManyRequests, "risk_control_throttled", "请求已被风险策略延迟");
        }

        httpContext.Items[RiskControlDecisionContext.HttpContextItemKey] = new RiskControlDecisionContext(decision);
        await RecordRiskAsync(httpContext, string.Join(',', decision.Reasons.Prepend("risk_control_queue")), decision.ActionName, httpContext.RequestAborted);
        return await next(context);
    }

    private async ValueTask<object?> RejectAsync(
        HttpContext httpContext,
        RiskDecision decision,
        int statusCode,
        string detail,
        string message)
    {
        await RecordRiskAsync(httpContext, string.Join(',', decision.Reasons.Prepend(detail)), decision.ActionName, httpContext.RequestAborted);
        return Error(httpContext, statusCode, ErrorCode.Forbidden, message);
    }

    private ValueTask RecordRiskAsync(HttpContext context, string detail, string action, CancellationToken cancellationToken, int score = 10)
        => riskSignalSink.AddRiskAsync(new SecurityRiskSignal(
            context,
            SecurityRiskReason.SecurityChallengeRejected,
            score,
            RiskSignalTtl,
            SecurityRiskSources.RiskControl,
            string.IsNullOrWhiteSpace(action) ? "risk_control" : action,
            detail), cancellationToken);

    private static bool TryReadSingleHeader(HttpContext context, string headerName, out string value)
    {
        value = string.Empty;
        if (!context.Request.Headers.TryGetValue(headerName, out var values) || values.Count != 1)
        {
            return false;
        }

        value = values[0]?.Trim() ?? string.Empty;
        return value.Length > 0;
    }

    private static string CanonicalChallengeKind(string kind)
        => SecurityChallengeContracts.TryParseKind(kind, out SecurityChallengeKind parsed)
            ? SecurityChallengeContracts.ToWireName(parsed)
            : kind.Trim();

    private static bool IsAdminSensitiveRiskAction(string action)
        => string.Equals(action, RiskActionNames.AdminSecurityWrite, StringComparison.Ordinal)
            || string.Equals(action, RiskActionNames.AdminCommentBatch, StringComparison.Ordinal);

    private static IResult Error(HttpContext context, int statusCode, ErrorCode code, string message)
        => EndpointFilterResults.FromActionResult(
            new ObjectResult(ErrorDetail.Create(code, message, traceId: context.TraceIdentifier))
            {
                StatusCode = statusCode
            },
            context);

    [LoggerMessage(EventId = 151, Level = LogLevel.Information, Message = "RiskControl challenge rejected | TraceId: {TraceId} | Action: {Action} | Reason: {Reason}")]
    private static partial void LogChallengeRejected(ILogger logger, string traceId, string action, string reason);
}
