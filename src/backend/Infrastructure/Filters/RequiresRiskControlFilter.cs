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
    public const string ChallengeProofOutcomeHeaderName = "X-Fsus-Challenge-Proof-Outcome";
    public const string ChallengeActionHeaderName = "X-Fsus-Challenge-Action";
    public const string ChallengeRouteKeyHeaderName = "X-Fsus-Challenge-Route-Key";
    public const string ChallengePolicyVersionHeaderName = "X-Fsus-Challenge-Policy-Version";
    public const string RiskDecisionHeaderName = "X-Fsus-Risk-Decision";

    private static readonly TimeSpan s_riskSignalTtl = TimeSpan.FromMinutes(10);

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
        SecurityRiskPolicy policy = riskPolicyProvider.CurrentRiskPolicy;
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
            WriteChallengeHandoffHeaders(httpContext, decision);
            return Error(httpContext, StatusCodes.Status428PreconditionRequired, ErrorCode.Forbidden, "MFA_PROOF_REQUIRED");
        }

        if (!TryReadSingleHeader(httpContext, ChallengeProofHeaderName, out string proofToken)
            || !TryReadSingleHeader(httpContext, ChallengeIdHeaderName, out string challengeId)
            || !TryReadSingleHeader(httpContext, ChallengeKindHeaderName, out string challengeKind))
        {
            // Missing proof is the normal first leg of a challenge handshake.
            // Rejected or replayed proof is the risky signal, not requesting the challenge.
            await RecordRiskAsync(httpContext, "challenge_proof_missing", decision.ActionName, httpContext.RequestAborted, score: 0);
            WriteChallengeHandoffHeaders(httpContext, decision);
            return Error(httpContext, StatusCodes.Status428PreconditionRequired, ErrorCode.Forbidden, "RISK_CHALLENGE_PROOF_REQUIRED");
        }

        string canonicalChallengeKind = CanonicalChallengeKind(challengeKind);
        if (decision.RequiredChallenges.Count > 0
            && !decision.RequiredChallenges.Any(required => string.Equals(CanonicalChallengeKind(required), canonicalChallengeKind, StringComparison.Ordinal)))
        {
            await RecordRiskAsync(httpContext, $"challenge_kind_mismatch:{challengeKind}", decision.ActionName, httpContext.RequestAborted);
            WriteChallengeHandoffHeaders(httpContext, decision);
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
                decision.PolicyVersion,
                decision.RequiredChallenges.Select(CanonicalChallengeKind).ToArray()),
            httpContext.RequestAborted);

        if (proof.Accepted)
        {
            return await next(context);
        }

        string rejectionReason = proof.Reason;
        LogChallengeRejected(logger, httpContext.TraceIdentifier, decision.ActionName, rejectionReason);
        await RecordRiskAsync(httpContext, $"challenge_proof_rejected:{rejectionReason}", decision.ActionName, httpContext.RequestAborted);
        httpContext.Response.Headers[ChallengeProofOutcomeHeaderName] = proof.Outcome;
        WriteChallengeHandoffHeaders(httpContext, decision);
        return Error(
            httpContext,
            StatusCodes.Status428PreconditionRequired,
            ErrorCode.Forbidden,
            PublicProofError(proof.Outcome));
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
        httpContext.Response.Headers[RiskDecisionHeaderName] = decision.Kind switch
        {
            RiskDecisionKind.Block => "block",
            RiskDecisionKind.Throttle => "throttle",
            _ => "reject"
        };
        httpContext.Response.Headers[ChallengePolicyVersionHeaderName] = decision.PolicyVersion;
        return Error(httpContext, statusCode, ErrorCode.Forbidden, message);
    }

    private static void WriteChallengeHandoffHeaders(HttpContext context, RiskDecision decision)
    {
        context.Response.Headers[RiskDecisionHeaderName] = decision.Kind == RiskDecisionKind.StepUp ? "stepUp" : "challenge";
        context.Response.Headers[ChallengeActionHeaderName] = decision.ActionName;
        context.Response.Headers[ChallengeRouteKeyHeaderName] = decision.RouteKey;
        context.Response.Headers[ChallengePolicyVersionHeaderName] = decision.PolicyVersion;
    }

    private ValueTask RecordRiskAsync(HttpContext context, string detail, string action, CancellationToken cancellationToken, int score = 10)
        => riskSignalSink.AddRiskAsync(new SecurityRiskSignal(
            context,
            SecurityRiskReason.SecurityChallengeRejected,
            score,
            s_riskSignalTtl,
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

    private static string PublicProofError(string outcome)
        => outcome switch
        {
            SecurityChallengeProofOutcomes.Expired => "RISK_CHALLENGE_PROOF_EXPIRED",
            SecurityChallengeProofOutcomes.ReplayedOrMissing => "RISK_CHALLENGE_PROOF_REPLAYED",
            SecurityChallengeProofOutcomes.BindingMismatch => "RISK_CHALLENGE_PROOF_BINDING_MISMATCH",
            SecurityChallengeProofOutcomes.Revoked => "RISK_CHALLENGE_PROOF_REVOKED",
            _ => "RISK_CHALLENGE_PROOF_REJECTED"
        };

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
