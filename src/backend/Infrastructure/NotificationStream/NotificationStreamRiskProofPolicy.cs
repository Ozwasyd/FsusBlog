using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Security;

using Microsoft.AspNetCore.Mvc;

namespace FsusBlog.Server.Infrastructure.NotificationStream;

internal interface INotificationStreamRiskProofPolicy
{
    Task<NotificationStreamRiskProofResult> ValidateAsync(
        HttpContext context,
        bool isAuthenticated,
        bool consumeProof,
        CancellationToken cancellationToken);
}

internal readonly record struct NotificationStreamRiskProofResult(
    bool IsAllowed,
    int StatusCode,
    string? ErrorCode,
    string? PreflightGrantToken)
{
    public static NotificationStreamRiskProofResult Allowed(string? preflightGrantToken = null)
        => new(true, StatusCodes.Status200OK, null, preflightGrantToken);

    public static NotificationStreamRiskProofResult Rejected(int statusCode, string errorCode)
        => new(false, statusCode, errorCode, null);
}

internal sealed class NotificationStreamRiskProofPolicy(
    IPowService powService,
    AdaptivePowGovernor powGovernor,
    ISecurityRiskScoreReader riskScoreReader,
    ISecurityRiskPolicyProvider riskPolicyProvider,
    IRiskControlContextFactory riskContextFactory,
    IRiskDecisionService riskDecisionService,
    ISecurityChallengeProofService challengeProofService,
    ISecurityRiskSignalSink riskSignalSink,
    ILoggerFactory loggerFactory,
    INotificationStreamPreflightGrantService? preflightGrantService = null) : INotificationStreamRiskProofPolicy
{
    internal const string PreflightGrantCookieName = "Fsus-Notification-Grant";
    private const string ChallengeProofHeaderName = "X-Fsus-Challenge-Proof";
    private const string ChallengeIdHeaderName = "X-Fsus-Challenge-Id";
    private const string ChallengeKindHeaderName = "X-Fsus-Challenge-Kind";
    private static readonly TimeSpan s_riskSignalTtl = TimeSpan.FromMinutes(10);

    public async Task<NotificationStreamRiskProofResult> ValidateAsync(
        HttpContext context,
        bool isAuthenticated,
        bool consumeProof,
        CancellationToken cancellationToken)
    {
        bool carriesRiskControlMaterial = context.Request.Headers.ContainsKey(ChallengeProofHeaderName)
            || context.Request.Cookies.ContainsKey(PreflightGrantCookieName);
        if (isAuthenticated && !carriesRiskControlMaterial)
        {
            return NotificationStreamRiskProofResult.Allowed();
        }

        NotificationStreamRiskProofResult? legacyPowFailure = null;
        if (context.Request.Query.ContainsKey("pow"))
        {
            if (!consumeProof)
            {
                return NotificationStreamRiskProofResult.Allowed();
            }

            Microsoft.Extensions.Logging.ILogger powLogger = loggerFactory.CreateLogger("FsusBlog.NotificationStream.Pow");
            IActionResult? powFailure = await PowValidationLogic.ValidateFromQueryAsync(context, powLogger, powService, powGovernor);
            if (powFailure is null)
            {
                return NotificationStreamRiskProofResult.Allowed();
            }

            legacyPowFailure = NotificationStreamRiskProofResult.Rejected(
                ResolveStatusCode(powFailure, StatusCodes.Status401Unauthorized),
                "pow_failed");
        }

        context.Items[RiskActionEndpointMetadata.HttpContextItemKey] =
            RiskActionRegistry.Default.CreateMetadata(RiskActionNames.NotificationSubscribe);
        RiskControlContext riskContext = riskContextFactory.Create(context);
        int riskScore = await riskScoreReader.GetRiskScoreAsync(context, cancellationToken);
        SecurityRiskPolicy policy = riskPolicyProvider.CurrentRiskPolicy;
        RiskDecision decision = riskDecisionService.Decide(riskContext, policy, riskScore);

        return decision.Kind switch
        {
            RiskDecisionKind.Allow => NotificationStreamRiskProofResult.Allowed(),
            RiskDecisionKind.Challenge or RiskDecisionKind.StepUp => await ValidateProofAsync(
                context,
                riskContext,
                decision,
                legacyPowFailure,
                consumeProof,
                cancellationToken),
            RiskDecisionKind.Block => await RejectRiskAsync(
                context,
                decision,
                "risk_control_blocked",
                "risk_control_blocked",
                cancellationToken),
            RiskDecisionKind.QueueForModeration or RiskDecisionKind.Throttle => await RejectRiskAsync(
                context,
                decision,
                "risk_control_throttled",
                "risk_control_throttled",
                cancellationToken),
            _ => await RejectRiskAsync(
                context,
                decision,
                "risk_control_rejected",
                "risk_control_rejected",
                cancellationToken)
        };
    }

    private async Task<NotificationStreamRiskProofResult> ValidateProofAsync(
        HttpContext context,
        RiskControlContext riskContext,
        RiskDecision decision,
        NotificationStreamRiskProofResult? legacyPowFailure,
        bool consumeProof,
        CancellationToken cancellationToken)
    {
        RiskControlProofBinding binding = RiskControlProofBindingFactory.Create(riskContext);
        if (consumeProof)
        {
            string grantToken = context.Request.Cookies[PreflightGrantCookieName]?.Trim() ?? string.Empty;
            if (preflightGrantService is null || grantToken.Length == 0)
            {
                await RecordRiskAsync(context, "challenge_grant_missing", decision.ActionName, cancellationToken, score: 0);
                return NotificationStreamRiskProofResult.Rejected(StatusCodes.Status428PreconditionRequired, "risk_challenge_required");
            }

            NotificationStreamPreflightGrantConsumeResult grant = await preflightGrantService.ConsumeAsync(
                grantToken,
                new NotificationStreamPreflightGrantBinding(
                    decision.ActionName,
                    decision.RouteKey,
                    binding.SubjectHash,
                    binding.ClientIpHash,
                    binding.DeviceFpHash,
                    decision.PolicyVersion),
                cancellationToken);
            if (grant.Accepted)
            {
                return NotificationStreamRiskProofResult.Allowed();
            }

            await RecordRiskAsync(context, $"challenge_grant_rejected:{grant.Outcome}", decision.ActionName, cancellationToken);
            return NotificationStreamRiskProofResult.Rejected(
                StatusCodes.Status428PreconditionRequired,
                PublicChallengeFailure(grant.Outcome));
        }

        if (!TryReadChallengeProofHeaders(context, out string proofToken, out string challengeId, out string challengeKind))
        {
            await RecordRiskAsync(context, "challenge_proof_missing", decision.ActionName, cancellationToken, score: 0);
            return legacyPowFailure
                ?? NotificationStreamRiskProofResult.Rejected(StatusCodes.Status428PreconditionRequired, "risk_challenge_required");
        }

        string canonicalChallengeKind = CanonicalChallengeKind(challengeKind);
        if (decision.RequiredChallenges.Count > 0
            && !decision.RequiredChallenges.Any(required => string.Equals(
                CanonicalChallengeKind(required),
                canonicalChallengeKind,
                StringComparison.Ordinal)))
        {
            await RecordRiskAsync(context, $"challenge_kind_mismatch:{challengeKind}", decision.ActionName, cancellationToken);
            return NotificationStreamRiskProofResult.Rejected(StatusCodes.Status428PreconditionRequired, "risk_challenge_kind_mismatch");
        }

        if (preflightGrantService is null)
        {
            return NotificationStreamRiskProofResult.Rejected(
                StatusCodes.Status503ServiceUnavailable,
                "risk_challenge_grant_unavailable");
        }

        var grantBinding = new NotificationStreamPreflightGrantBinding(
            decision.ActionName,
            decision.RouteKey,
            binding.SubjectHash,
            binding.ClientIpHash,
            binding.DeviceFpHash,
            decision.PolicyVersion);
        string? resumedGrant = await preflightGrantService.TryResumeExchangeAsync(
            proofToken,
            grantBinding,
            cancellationToken);
        if (resumedGrant is not null)
        {
            return NotificationStreamRiskProofResult.Allowed(resumedGrant);
        }

        var consumeRequest = new SecurityChallengeProofConsumeRequest(
            proofToken,
            challengeId,
            canonicalChallengeKind,
            decision.ActionName,
            decision.RouteKey,
            binding.SubjectHash,
            binding.ClientIpHash,
            binding.DeviceFpHash,
            decision.PolicyVersion,
            decision.RequiredChallenges.Select(CanonicalChallengeKind).ToArray());
        SecurityChallengeProofExchangeResult proof;
        try
        {
            proof = await challengeProofService.ExchangeProofAsync(
                consumeRequest,
                claims =>
                {
                    NotificationStreamPreflightGrantExchange target = preflightGrantService.CreateExchangeTarget(
                        proofToken,
                        claims);
                    return new SecurityChallengeProofExchangeTarget(
                        target.Token,
                        CachePolicyId.SecurityChallengeProof,
                        target.CacheIdentity,
                        target.Payload,
                        target.Ttl);
                },
                cancellationToken);
        }
        catch (InvalidOperationException)
        {
            return NotificationStreamRiskProofResult.Rejected(
                StatusCodes.Status503ServiceUnavailable,
                "risk_challenge_grant_unavailable");
        }

        if (proof.Accepted && proof.Target is not null)
        {
            return NotificationStreamRiskProofResult.Allowed(proof.Target.Token);
        }

        // The first preflight may have completed the atomic Redis exchange but
        // lost its HTTP response. Resolve that race to the same deterministic
        // grant instead of treating the one-time proof as a replay.
        resumedGrant = await preflightGrantService.TryResumeExchangeAsync(
            proofToken,
            grantBinding,
            cancellationToken);
        if (resumedGrant is not null)
        {
            return NotificationStreamRiskProofResult.Allowed(resumedGrant);
        }

        await RecordRiskAsync(context, $"challenge_proof_rejected:{proof.Reason}", decision.ActionName, cancellationToken);
        return NotificationStreamRiskProofResult.Rejected(
            StatusCodes.Status428PreconditionRequired,
            PublicChallengeFailure(proof.Outcome));
    }

    private async Task<NotificationStreamRiskProofResult> RejectRiskAsync(
        HttpContext context,
        RiskDecision decision,
        string errorCode,
        string detail,
        CancellationToken cancellationToken)
    {
        await RecordRiskAsync(context, string.Join(',', decision.Reasons.Prepend(detail)), decision.ActionName, cancellationToken);
        return NotificationStreamRiskProofResult.Rejected(StatusCodes.Status429TooManyRequests, errorCode);
    }

    private async ValueTask RecordRiskAsync(
        HttpContext context,
        string detail,
        string action,
        CancellationToken cancellationToken,
        int score = 10)
    {
        try
        {
            await riskSignalSink.AddRiskAsync(new SecurityRiskSignal(
                context,
                SecurityRiskReason.SecurityChallengeRejected,
                score,
                s_riskSignalTtl,
                SecurityRiskSources.RiskControl,
                string.IsNullOrWhiteSpace(action) ? RiskActionNames.NotificationSubscribe : action,
                detail), cancellationToken);
        }
        catch
        {
            // Admission must not depend on best-effort risk telemetry persistence.
        }
    }

    private static int ResolveStatusCode(IActionResult result, int fallback)
        => result switch
        {
            ObjectResult objectResult when objectResult.StatusCode.HasValue => objectResult.StatusCode.Value,
            StatusCodeResult statusCodeResult => statusCodeResult.StatusCode,
            _ => fallback
        };

    private static bool TryReadChallengeProofHeaders(
        HttpContext context,
        out string proofToken,
        out string challengeId,
        out string challengeKind)
    {
        proofToken = string.Empty;
        challengeId = string.Empty;
        challengeKind = string.Empty;
        return TryReadSingleHeader(context, ChallengeProofHeaderName, out proofToken)
            && TryReadSingleHeader(context, ChallengeIdHeaderName, out challengeId)
            && TryReadSingleHeader(context, ChallengeKindHeaderName, out challengeKind);
    }

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

    private static string PublicChallengeFailure(string outcome)
        => outcome switch
        {
            SecurityChallengeProofOutcomes.Expired => "risk_challenge_expired",
            SecurityChallengeProofOutcomes.ReplayedOrMissing => "risk_challenge_replayed",
            SecurityChallengeProofOutcomes.BindingMismatch => "risk_challenge_binding_mismatch",
            SecurityChallengeProofOutcomes.Revoked => "risk_challenge_revoked",
            _ => "risk_challenge_rejected"
        };
}
