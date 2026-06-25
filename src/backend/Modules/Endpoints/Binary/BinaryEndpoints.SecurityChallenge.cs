using System.Text.Json;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Security;

namespace FsusBlog.Server.Modules.Endpoints.Binary;

public static partial class BinaryEndpoints
{
    private const int SecurityChallengeMaxFrameBytes = 64 * 1024;
    private const int MaxSecurityChallengeProviderPayloadEntries = 64;
    private const int MaxSecurityChallengeProviderPayloadValueChars = 16 * 1024;
    private const string SecurityChallengeTenantId = "tenant-main";
    private const string SecurityChallengeVerifyGenericFailure = "challenge_failed";
    private static readonly JsonSerializerOptions SecurityChallengeProviderPayloadJsonOptions = new(JsonSerializerDefaults.Web)
    {
        MaxDepth = 32
    };

    private static void MapBinarySecurityChallengeEndpoints(IEndpointRouteBuilder group)
    {
        group.MapPost("/security/challenge", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IAedsEncoder aeds,
            ISecurityRiskScoreReader riskScoreReader,
            ISecurityRiskPolicyProvider riskPolicyProvider,
            IRiskControlContextFactory riskContextFactory,
            IRiskDecisionService riskDecisionService,
            ISecurityChallengeOrchestrator challengeOrchestrator,
            ISecurityRiskSignalSink riskSignalSink,
            CancellationToken cancellationToken) =>
            await HandleSecurityChallengeIssueAsync(
                httpContext,
                aeds,
                riskScoreReader,
                riskPolicyProvider,
                riskContextFactory,
                riskDecisionService,
                challengeOrchestrator,
                riskSignalSink,
                cancellationToken))
        .AllowAnonymous()
        .RequireRateLimiting("fixed_ip")
        .RequireNoStoreResponse();

        group.MapPost("/security/challenge/verify", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IAedsEncoder aeds,
            ISecurityRiskPolicyProvider riskPolicyProvider,
            IRiskControlContextFactory riskContextFactory,
            ISecurityChallengeOrchestrator challengeOrchestrator,
            ISecurityChallengeVerifyRateLimiter verifyRateLimiter,
            ISecurityRiskSignalSink riskSignalSink,
            CancellationToken cancellationToken) =>
            await HandleSecurityChallengeVerifyAsync(
                httpContext,
                aeds,
                riskPolicyProvider,
                riskContextFactory,
                challengeOrchestrator,
                verifyRateLimiter,
                riskSignalSink,
                cancellationToken))
        .AllowAnonymous()
        .RequireRateLimiting("fixed_ip")
        .RequireNoStoreResponse();
    }

    internal static async Task<BinaryFrameResult> HandleSecurityChallengeIssueAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        ISecurityRiskScoreReader riskScoreReader,
        ISecurityRiskPolicyProvider riskPolicyProvider,
        IRiskControlContextFactory riskContextFactory,
        IRiskDecisionService riskDecisionService,
        ISecurityChallengeOrchestrator challengeOrchestrator,
        ISecurityRiskSignalSink riskSignalSink,
        CancellationToken cancellationToken)
    {
        if (!AcceptsBinaryResponse(httpContext.Request))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "binary_accept_required"), aeds, StatusCodes.Status406NotAcceptable);
        }

        BinaryRequestPayload payload = await ReadBinaryRequestPayloadAsync(
            httpContext,
            aeds,
            AedsFrameType.SecurityChallengeIssueRequest,
            cancellationToken,
            SecurityChallengeMaxFrameBytes);
        if (!payload.IsSuccess)
        {
            return BinaryResults.FromError(payload.Error, aeds);
        }

        if (!PodBinaryCodec.TryDecodeSecurityChallengeIssueRequest(payload.Payload, out SecurityChallengeIssueBinaryRequest request))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "security_challenge_issue_request_invalid"), aeds);
        }

        string action = NormalizeRequired(request.Action, 96);
        string routeKey = NormalizeRequired(request.RouteKey, 256);
        if (action.Length == 0 || routeKey.Length == 0)
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "security_challenge_action_route_required"), aeds);
        }

        RiskControlContext baseContext = riskContextFactory.Create(httpContext);
        RiskControlContext riskContext = baseContext with
        {
            ActionName = action,
            RouteKey = routeKey,
            ActionStatus = RiskControlContextStatuses.Resolved,
            DeviceFingerprint = ResolveDeviceFingerprint(request.DeviceFingerprint, baseContext.DeviceFingerprint)
        };
        int riskScore = await riskScoreReader.GetRiskScoreAsync(httpContext, cancellationToken);
        SecurityRiskPolicySnapshotV2 policy = riskPolicyProvider.CurrentRiskPolicyV2;
        RiskDecision decision = riskDecisionService.Decide(riskContext, policy, riskScore);
        if (DecisionRequiresCaptcha(decision))
        {
            await RecordCaptchaRequiredAsync(httpContext, riskSignalSink, decision, cancellationToken);
        }

        if (decision.Kind is not (RiskDecisionKind.Challenge or RiskDecisionKind.StepUp))
        {
            var response = new SecurityChallengeIssueBinaryResponse(
                ToChallengeDecisionKind(decision.Kind),
                decision.RiskScore,
                decision.EffectiveRiskScore,
                decision.EscalationLevel,
                decision.PolicyVersion,
                RetryAfterMs: 0,
                Envelope: null,
                ProviderPayloads: []);
            return BinaryResults.Frame(aeds, AedsFrameType.SecurityChallengeIssueResponse, writer => PodBinaryCodec.WriteSecurityChallengeIssueResponse(response, writer));
        }

        RiskControlProofBinding binding = RiskControlProofBindingFactory.Create(riskContext);
        SecurityChallengeOrchestrationIssueResult issued = await challengeOrchestrator.IssueAsync(
            new SecurityChallengeOrchestrationIssueRequest(
                httpContext,
                decision,
                SecurityChallengeTenantId,
                binding.SubjectHash,
                binding.ClientIpHash,
                binding.DeviceFpHash,
                ResolveTraceparent(httpContext)),
            cancellationToken);
        if (!issued.Succeeded || issued.Envelope is null)
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Forbidden, issued.Reason), aeds, StatusCodes.Status428PreconditionRequired);
        }

        var providerPayloads = issued.ProviderPayloads
            .Select(static item => new SecurityChallengeProviderPayload(item.Key, JsonSerializer.Serialize(item.Value)))
            .ToArray();
        var challengeResponse = new SecurityChallengeIssueBinaryResponse(
            ToChallengeDecisionKind(decision.Kind),
            decision.RiskScore,
            decision.EffectiveRiskScore,
            decision.EscalationLevel,
            decision.PolicyVersion,
            RetryAfterMs: 0,
            issued.Envelope,
            providerPayloads);
        return BinaryResults.Frame(aeds, AedsFrameType.SecurityChallengeIssueResponse, writer => PodBinaryCodec.WriteSecurityChallengeIssueResponse(challengeResponse, writer));
    }

    internal static async Task<BinaryFrameResult> HandleSecurityChallengeVerifyAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        ISecurityRiskPolicyProvider riskPolicyProvider,
        IRiskControlContextFactory riskContextFactory,
        ISecurityChallengeOrchestrator challengeOrchestrator,
        ISecurityChallengeVerifyRateLimiter verifyRateLimiter,
        ISecurityRiskSignalSink riskSignalSink,
        CancellationToken cancellationToken)
    {
        if (!AcceptsBinaryResponse(httpContext.Request))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "binary_accept_required"), aeds, StatusCodes.Status406NotAcceptable);
        }

        BinaryRequestPayload payload = await ReadBinaryRequestPayloadAsync(
            httpContext,
            aeds,
            AedsFrameType.SecurityChallengeVerifyRequest,
            cancellationToken,
            SecurityChallengeMaxFrameBytes);
        if (!payload.IsSuccess)
        {
            return BinaryResults.FromError(payload.Error, aeds);
        }

        if (!PodBinaryCodec.TryDecodeSecurityChallengeVerifyRequest(payload.Payload, out SecurityChallengeVerifyBinaryRequest request))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "security_challenge_verify_request_invalid"), aeds);
        }

        string challengeId = NormalizeRequired(request.ChallengeId, 64);
        string action = NormalizeRequired(request.Action, 96);
        string routeKey = NormalizeRequired(request.RouteKey, 256);
        if (challengeId.Length == 0 || action.Length == 0 || routeKey.Length == 0)
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "security_challenge_verify_fields_required"), aeds);
        }

        if (request.Kind == SecurityChallengeKind.Unknown || !SecurityChallengeContracts.SupportedKinds.Contains(request.Kind))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "security_challenge_kind_unsupported"), aeds);
        }

        if (!TryDeserializeProviderPayload(request.ProviderPayloadJson, out IReadOnlyDictionary<string, string> providerPayload))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "security_challenge_payload_invalid"), aeds);
        }

        if (!await verifyRateLimiter.TryAcquireAsync(httpContext, challengeId, action, cancellationToken))
        {
            await RecordSecurityChallengeVerifyRejectedAsync(httpContext, riskSignalSink, action, "challenge_verify_rate_limited", cancellationToken);
            return CreateSecurityChallengeVerifyGenericFailure(aeds);
        }

        RiskControlContext baseContext = riskContextFactory.Create(httpContext);
        RiskControlContext riskContext = baseContext with
        {
            ActionName = action,
            RouteKey = routeKey,
            ActionStatus = RiskControlContextStatuses.Resolved
        };
        RiskControlProofBinding binding = RiskControlProofBindingFactory.Create(riskContext);
        string policyVersion = riskPolicyProvider.CurrentRiskPolicyV2.PolicyVersion;
        string kind = SecurityChallengeContracts.ToWireName(request.Kind);
        SecurityChallengeOrchestrationVerifyResult verified = await challengeOrchestrator.VerifyAsync(
            new SecurityChallengeOrchestrationVerifyRequest(
                httpContext,
                kind,
                challengeId,
                action,
                routeKey,
                binding.SubjectHash,
                binding.ClientIpHash,
                binding.DeviceFpHash,
                policyVersion,
                providerPayload),
            cancellationToken);
        if (!verified.Succeeded || string.IsNullOrWhiteSpace(verified.ProofToken))
        {
            return CreateSecurityChallengeVerifyGenericFailure(aeds);
        }

        var response = new SecurityChallengeVerifyBinaryResponse(
            true,
            challengeId,
            request.Kind,
            policyVersion,
            verified.ProofToken,
            "ok",
            RetryAfterMs: 0);
        return BinaryResults.Frame(aeds, AedsFrameType.SecurityChallengeVerifyResponse, writer => PodBinaryCodec.WriteSecurityChallengeVerifyResponse(response, writer));
    }

    private static BinaryFrameResult CreateSecurityChallengeVerifyGenericFailure(IAedsEncoder aeds)
        => BinaryResults.FromError(
            ErrorDetail.Create(ErrorCode.Forbidden, SecurityChallengeVerifyGenericFailure),
            aeds,
            StatusCodes.Status428PreconditionRequired);

    private static bool AcceptsBinaryResponse(HttpRequest request)
        => HttpAcceptNegotiation.Accepts(request.Headers.Accept, BinaryContentType);

    private static string NormalizeRequired(string? value, int maxLength)
    {
        string normalized = (value ?? string.Empty).Trim();
        return normalized.Length <= maxLength ? normalized : normalized[..maxLength];
    }

    private static RiskControlDeviceFingerprintContext ResolveDeviceFingerprint(string? raw, RiskControlDeviceFingerprintContext fallback)
    {
        string fingerprint = (raw ?? string.Empty).Trim();
        if (fingerprint.Length == 0)
        {
            return fallback;
        }

        var context = new DefaultHttpContext();
        context.Request.Headers["X-Fsus-Device-Fp"] = fingerprint;
        return new RiskControlContextFactory().Create(context).DeviceFingerprint;
    }

    private static string ResolveTraceparent(HttpContext context)
        => context.Request.Headers.TryGetValue("traceparent", out var values) && !string.IsNullOrWhiteSpace(values.ToString())
            ? values.ToString().Trim()
            : context.TraceIdentifier;

    private static SecurityChallengeDecisionKind ToChallengeDecisionKind(RiskDecisionKind kind)
        => kind switch
        {
            RiskDecisionKind.Allow => SecurityChallengeDecisionKind.Allow,
            RiskDecisionKind.Challenge => SecurityChallengeDecisionKind.Challenge,
            RiskDecisionKind.StepUp => SecurityChallengeDecisionKind.StepUp,
            RiskDecisionKind.QueueForModeration => SecurityChallengeDecisionKind.QueueForModeration,
            RiskDecisionKind.Throttle => SecurityChallengeDecisionKind.Throttle,
            RiskDecisionKind.Block => SecurityChallengeDecisionKind.Block,
            _ => SecurityChallengeDecisionKind.Unknown
        };

    private static bool DecisionRequiresCaptcha(RiskDecision decision)
        => decision.Kind is RiskDecisionKind.Challenge or RiskDecisionKind.StepUp
            && decision.RequiredChallenges.Any(static challengeKind =>
                SecurityChallengeContracts.TryParseKind(challengeKind, out SecurityChallengeKind parsed)
                && parsed == SecurityChallengeKind.CaptchaV1);

    private static ValueTask RecordCaptchaRequiredAsync(
        HttpContext httpContext,
        ISecurityRiskSignalSink riskSignalSink,
        RiskDecision decision,
        CancellationToken cancellationToken)
        => riskSignalSink.AddRiskAsync(new SecurityRiskSignal(
            httpContext,
            SecurityRiskReason.CaptchaChallengeRequired,
            5,
            TimeSpan.FromMinutes(10),
            SecurityRiskSources.RiskControl,
            string.IsNullOrWhiteSpace(decision.ActionName) ? "risk_control" : decision.ActionName,
            string.Join("+", decision.RequiredChallenges)), cancellationToken);

    private static ValueTask RecordSecurityChallengeVerifyRejectedAsync(
        HttpContext httpContext,
        ISecurityRiskSignalSink riskSignalSink,
        string action,
        string detail,
        CancellationToken cancellationToken)
        => riskSignalSink.AddRiskAsync(new SecurityRiskSignal(
            httpContext,
            SecurityRiskReason.SecurityChallengeRejected,
            10,
            TimeSpan.FromMinutes(10),
            SecurityRiskSources.RiskControl,
            string.IsNullOrWhiteSpace(action) ? "security_challenge" : action,
            detail), cancellationToken);

    private static bool TryDeserializeProviderPayload(string payloadJson, out IReadOnlyDictionary<string, string> payload)
    {
        payload = new Dictionary<string, string>(StringComparer.Ordinal);
        if (string.IsNullOrWhiteSpace(payloadJson))
        {
            return false;
        }

        try
        {
            Dictionary<string, string>? parsed = JsonSerializer.Deserialize<Dictionary<string, string>>(payloadJson, SecurityChallengeProviderPayloadJsonOptions);
            if (parsed is null || parsed.Count > MaxSecurityChallengeProviderPayloadEntries)
            {
                return false;
            }

            var bounded = new Dictionary<string, string>(parsed.Count, StringComparer.Ordinal);
            foreach (KeyValuePair<string, string> item in parsed)
            {
                if (item.Value is null || item.Value.Length > MaxSecurityChallengeProviderPayloadValueChars)
                {
                    return false;
                }

                bounded[item.Key] = item.Value;
            }

            payload = bounded;
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }
}
