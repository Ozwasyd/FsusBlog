using System.Diagnostics;
using System.Text;
using System.Text.Json;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Observability;
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
    private const int MaxSecurityChallengeProviderPayloadJsonChars = 48 * 1024;
    private const int MaxSecurityChallengeProviderPayloadJsonBytes = 48 * 1024;
    private const int MaxSecurityChallengeProviderPayloadEntries = 64;
    private const int MaxSecurityChallengeProviderPayloadValueChars = 16 * 1024;
    private const string SecurityChallengeTenantId = "tenant-main";
    private const string SecurityChallengeVerifyGenericFailure = "challenge_failed";

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
            IPoSpaceUnsupportedReissueService poSpaceUnsupportedReissueService,
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
                cancellationToken,
                poSpaceUnsupportedReissueService))
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

        group.MapPost("/security/challenge/cancel", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IAedsEncoder aeds,
            IRiskControlContextFactory riskContextFactory,
            ISecurityChallengeEnvelopeStateService envelopeStateService,
            ISecurityChallengePersistenceService challengePersistence,
            IPerceptionCharacterV3StateStore perceptionV3StateStore,
            CancellationToken cancellationToken) =>
            await HandleSecurityChallengeCancelAsync(
                httpContext,
                aeds,
                riskContextFactory,
                envelopeStateService,
                challengePersistence,
                cancellationToken,
                perceptionV3StateStore,
                httpContext.RequestServices.GetService<IPerceptionCharacterV3DeviceAuthority>(),
                httpContext.RequestServices.GetService<IPerceptionCharacterV3KeyRing>(),
                httpContext.RequestServices.GetService<IPerceptionCharacterV3AuditSink>()))
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
        CancellationToken cancellationToken,
        IPoSpaceUnsupportedReissueService? poSpaceUnsupportedReissueService = null)
    {
        if (!AcceptsBinaryResponse(httpContext.Request))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "binary_accept_required"), aeds, ApiErrorSemanticMapper.RequireTransportMappingId(StatusCodes.Status406NotAcceptable, ErrorCode.Validation));
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
            ActionStatus = RiskControlContextStatuses.Resolved
        };
        int riskScore = await riskScoreReader.GetRiskScoreAsync(httpContext, cancellationToken);
        SecurityRiskPolicy policy = riskPolicyProvider.CurrentRiskPolicy;
        RiskDecision decision = riskDecisionService.Decide(riskContext, policy, riskScore);
        RiskControlProofBinding binding = RiskControlProofBindingFactory.Create(riskContext);
        if (!PoSpaceUnsupportedReissueParser.TryParse(
                request.AttributesJson,
                action,
                routeKey,
                binding,
                httpContext,
                out PoSpaceUnsupportedReissueRequest? unsupportedReissue,
                out bool malformedReissue))
        {
            string error = malformedReissue
                ? "security_challenge_unsupported_reissue_invalid"
                : "security_challenge_unsupported_reissue_rejected";
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, error), aeds);
        }

        if (unsupportedReissue is not null)
        {
            if (poSpaceUnsupportedReissueService is null)
            {
                return BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.InfraFailure, "security_challenge_unsupported_reissue_unavailable"),
                    aeds, ApiErrorSemanticMapper.RequireTransportMappingId(StatusCodes.Status503ServiceUnavailable, ErrorCode.InfraFailure));
            }

            PoSpaceUnsupportedReissueResult reissued = await poSpaceUnsupportedReissueService.ReissueAsync(
                unsupportedReissue,
                decision,
                policy,
                cancellationToken);
            decision = reissued.Decision;
        }

        if (decision.Kind is RiskDecisionKind.Challenge or RiskDecisionKind.StepUp &&
            !ClientSupportsRequiredChallengeSet(request, decision))
        {
            return BinaryResults.FromError(
                ErrorDetail.Create(ErrorCode.Conflict, "security_challenge_client_capability_incompatible"),
                aeds, ApiErrorSemanticMapper.RequireTransportMappingId(StatusCodes.Status409Conflict, ErrorCode.Conflict));
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
            return DecisionRequiresPerceptionCharacterV3(decision)
                ? CreatePerceptionCharacterV3Failure(aeds, issued.Reason)
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Forbidden, issued.Reason), aeds, ApiErrorSemanticMapper.RequireTransportMappingId(StatusCodes.Status428PreconditionRequired, ErrorCode.Forbidden));
        }

        var providerPayloads = issued.ProviderPayloads
            .Select(static item => new SecurityChallengeProviderPayload(item.Key, JsonSerializer.Serialize(item.Value)))
            .Concat(issued.PerceptionCharacterV3Payloads.Select(static item =>
                new SecurityChallengeProviderPayload(item.Key, string.Empty) { PerceptionCharacterV3 = item.Value }))
            .ToArray();
        bool containsV3 = DecisionRequiresPerceptionCharacterV3(decision);
        var challengeResponse = new SecurityChallengeIssueBinaryResponse(
            ToChallengeDecisionKind(decision.Kind),
            containsV3 ? 0 : decision.RiskScore,
            containsV3 ? 0 : decision.EffectiveRiskScore,
            decision.EscalationLevel,
            decision.PolicyVersion,
            RetryAfterMs: 0,
            issued.Envelope,
            providerPayloads);
        return BinaryResults.Frame(aeds, AedsFrameType.SecurityChallengeIssueResponse, writer => PodBinaryCodec.WriteSecurityChallengeIssueResponse(challengeResponse, writer));
    }

    private static bool ClientSupportsRequiredChallengeSet(
        SecurityChallengeIssueBinaryRequest request,
        RiskDecision decision)
    {
        string manifestVersion = (request.CapabilityManifestVersion ?? string.Empty).Trim();
        if (!string.Equals(manifestVersion, SecurityChallengeCapabilityCatalog.ManifestVersion, StringComparison.Ordinal))
        {
            return false;
        }

        SecurityChallengeExecutionMode mode = SecurityChallengeCapabilityCatalog.ResolveMode(decision.ActionName);
        foreach (string requiredKind in decision.RequiredChallenges)
        {
            string normalized = (requiredKind ?? string.Empty).Trim();
            if (!SecurityChallengeContracts.TryParseKind(normalized, out SecurityChallengeKind kind) ||
                !string.Equals(normalized, SecurityChallengeContracts.ToWireName(kind), StringComparison.Ordinal))
            {
                return false;
            }

            SecurityChallengeCapabilityResolution capability = SecurityChallengeCapabilityCatalog.Resolve(
                kind,
                decision.ActionName,
                mode,
                manifestVersion);
            if (!capability.PolicyEligible)
            {
                return false;
            }
        }

        return true;
    }

    internal static async Task<BinaryFrameResult> HandleSecurityChallengeCancelAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        IRiskControlContextFactory riskContextFactory,
        ISecurityChallengeEnvelopeStateService envelopeStateService,
        ISecurityChallengePersistenceService challengePersistence,
        CancellationToken cancellationToken,
        IPerceptionCharacterV3StateStore? perceptionV3StateStore = null,
        IPerceptionCharacterV3DeviceAuthority? perceptionV3DeviceAuthority = null,
        IPerceptionCharacterV3KeyRing? perceptionV3KeyRing = null,
        IPerceptionCharacterV3AuditSink? perceptionV3Audit = null)
    {
        if (!AcceptsBinaryResponse(httpContext.Request))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "binary_accept_required"), aeds, ApiErrorSemanticMapper.RequireTransportMappingId(StatusCodes.Status406NotAcceptable, ErrorCode.Validation));
        }

        BinaryRequestPayload payload = await ReadBinaryRequestPayloadAsync(
            httpContext,
            aeds,
            AedsFrameType.SecurityChallengeCancelRequest,
            cancellationToken,
            SecurityChallengeMaxFrameBytes);
        if (!payload.IsSuccess)
        {
            return BinaryResults.FromError(payload.Error, aeds);
        }

        if (!PodBinaryCodec.TryDecodeSecurityChallengeCancelRequest(payload.Payload, out SecurityChallengeCancelBinaryRequest request))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "security_challenge_cancel_request_invalid"), aeds);
        }

        string envelopeId = NormalizeRequired(request.EnvelopeId, 64);
        string action = NormalizeRequired(request.Action, 96);
        string routeKey = NormalizeRequired(request.RouteKey, 256);
        string policyVersion = NormalizeRequired(request.PolicyVersion, 64);
        if (envelopeId.Length == 0 || action.Length == 0 || routeKey.Length == 0 || policyVersion.Length == 0)
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "security_challenge_cancel_fields_required"), aeds);
        }

        RiskControlContext baseContext = riskContextFactory.Create(httpContext);
        RiskControlContext riskContext = baseContext with
        {
            ActionName = action,
            RouteKey = routeKey,
            ActionStatus = RiskControlContextStatuses.Resolved
        };
        RiskControlProofBinding binding = RiskControlProofBindingFactory.Create(riskContext);
        string v3AuditChallengeId = string.Empty;
        try
        {
            SecurityChallengeEnvelopeState? state = await envelopeStateService.GetAsync(envelopeId, cancellationToken).ConfigureAwait(false);
            bool containsV3 = state?.RequiredKinds.Contains(PerceptionCharacterV3Contracts.WireName, StringComparer.Ordinal) == true;
            if (containsV3)
            {
                int[] v3MemberIndexes = state!.RequiredKinds
                    .Select(static (kind, index) => (kind, index))
                    .Where(static member => string.Equals(member.kind, PerceptionCharacterV3Contracts.WireName, StringComparison.Ordinal))
                    .Select(static member => member.index)
                    .Where(index => !string.Equals(
                        state.MemberStatuses[index],
                        SecurityChallengeEnvelopeMemberStatuses.Planned,
                        StringComparison.Ordinal))
                    .ToArray();
                if (v3MemberIndexes.Length > 0
                    && (perceptionV3StateStore is null || perceptionV3DeviceAuthority is null || perceptionV3KeyRing is null || perceptionV3Audit is null))
                    return CreatePerceptionCharacterV3Failure(aeds, "provider_missing");
                PerceptionCharacterV3DeviceAuthorityResult? device = v3MemberIndexes.Length == 0
                    ? null
                    : await perceptionV3DeviceAuthority!.ResolveAsync(httpContext, binding.ClientIpHash, cancellationToken).ConfigureAwait(false);
                foreach (int memberIndex in v3MemberIndexes)
                {
                    string challengeId = state.ChallengeIds[memberIndex];
                    v3AuditChallengeId = challengeId;
                    if (!device!.Succeeded)
                    {
                        string deviceOutcome = device.Reason.EndsWith("unavailable", StringComparison.Ordinal) ? "unavailable" : "rejected";
                        await perceptionV3Audit!.WriteAsync("cancel", challengeId, action, deviceOutcome, device.Reason, cancellationToken).ConfigureAwait(false);
                        return deviceOutcome == "unavailable"
                            ? CreatePerceptionCharacterV3Failure(aeds, "device_binding_unavailable")
                            : BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess);
                    }
                    PerceptionCharacterV3StateRecord? record = await perceptionV3StateStore!.ReadAsync(challengeId, cancellationToken).ConfigureAwait(false);
                    if (record is null)
                    {
                        await perceptionV3Audit!.WriteAsync("cancel", challengeId, action, "rejected", "state_missing", cancellationToken).ConfigureAwait(false);
                        continue;
                    }
                    if (!perceptionV3KeyRing!.TryGetAnswerKey(record.AnswerKeyVersion, out byte[] answerKey))
                    {
                        await perceptionV3Audit!.WriteAsync("cancel", challengeId, action, "unavailable", "answer_key_unavailable", cancellationToken).ConfigureAwait(false);
                        return CreatePerceptionCharacterV3Failure(aeds, "crypto_failure");
                    }
                    string currentDeviceBinding = PerceptionCharacterV3Crypto.DeriveDeviceBinding(answerKey, device.Binding);
                    PerceptionCharacterV3StateRecord expected = record with
                    {
                        EnvelopeId = envelopeId,
                        Action = action,
                        RouteKey = routeKey,
                        SubjectHash = binding.SubjectHash,
                        DeviceBindingHash = currentDeviceBinding,
                        ClientIpBindingHash = binding.ClientIpHash,
                        PolicyVersion = state.PolicyVersion
                    };
                    PerceptionCharacterV3Transition transition = await perceptionV3StateStore!.RevokeAsync(
                        expected,
                        DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                        cancellationToken).ConfigureAwait(false);
                    string transitionOutcome = transition.Kind switch
                    {
                        PerceptionCharacterV3TransitionKind.ReissueRequired when transition.InternalReason == "revoked_now" => "revoked",
                        PerceptionCharacterV3TransitionKind.ReissueRequired when transition.InternalReason == "expired_or_revoked" => "terminal",
                        PerceptionCharacterV3TransitionKind.Unavailable => "unavailable",
                        _ => "rejected"
                    };
                    await perceptionV3Audit!.WriteAsync("cancel", challengeId, action, transitionOutcome, transition.InternalReason, cancellationToken).ConfigureAwait(false);
                    if (transition.Kind == PerceptionCharacterV3TransitionKind.Unavailable)
                        return CreatePerceptionCharacterV3Failure(aeds, "state_unavailable");
                    if (transition.Kind != PerceptionCharacterV3TransitionKind.ReissueRequired
                        || transition.InternalReason is not ("revoked_now" or "expired_or_revoked"))
                        return BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess);
                }
            }
            string envelopeDeviceBinding = containsV3 ? state!.DeviceFpHash : binding.DeviceFpHash;
            string envelopePolicyVersion = containsV3 ? state!.PolicyVersion : policyVersion;
            bool revoked = await envelopeStateService.RevokeAsync(
                new SecurityChallengeEnvelopeBindingRequest(
                    envelopeId,
                    action,
                    routeKey,
                    binding.SubjectHash,
                    binding.ClientIpHash,
                    envelopeDeviceBinding,
                    envelopePolicyVersion),
                "client_cancelled",
                cancellationToken).ConfigureAwait(false);
            if (revoked && state is not null)
            {
                foreach (string challengeId in state.ChallengeIds)
                {
                    _ = await challengePersistence.RevokeAsync(challengeId, "envelope_client_cancelled", cancellationToken).ConfigureAwait(false);
                }
            }
        }
        catch (PerceptionCharacterV3StoreUnavailableException)
        {
            if (perceptionV3Audit is not null)
                await perceptionV3Audit.WriteAsync("cancel", v3AuditChallengeId, action, "unavailable", "redis_unavailable", CancellationToken.None).ConfigureAwait(false);
            return CreatePerceptionCharacterV3Failure(aeds, "state_unavailable");
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            if (perceptionV3Audit is not null)
                await perceptionV3Audit.WriteAsync("cancel", string.Empty, action, "unavailable", "state_exception", CancellationToken.None).ConfigureAwait(false);
            return CreatePerceptionCharacterV3Failure(aeds, "state_unavailable");
        }

        // Cancellation is deliberately idempotent and does not expose whether
        // an attacker guessed an envelope identifier or one of its bindings.
        return BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess);
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
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "binary_accept_required"), aeds, ApiErrorSemanticMapper.RequireTransportMappingId(StatusCodes.Status406NotAcceptable, ErrorCode.Validation));
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

        string envelopeId = NormalizeRequired(request.EnvelopeId, 64);
        string challengeId = NormalizeRequired(request.ChallengeId, 64);
        string action = NormalizeRequired(request.Action, 96);
        string routeKey = NormalizeRequired(request.RouteKey, 256);
        if (envelopeId.Length == 0 || challengeId.Length == 0 || action.Length == 0 || routeKey.Length == 0)
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "security_challenge_verify_fields_required"), aeds);
        }

        if (request.Kind == SecurityChallengeKind.Unknown || !SecurityChallengeContracts.SupportedKinds.Contains(request.Kind))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "security_challenge_kind_unsupported"), aeds);
        }

        bool isV3 = request.Kind == SecurityChallengeKind.PerceptionCharacterV3;
        if (!isV3 && !IsProviderPayloadJsonWithinCheapLimit(request.ProviderPayloadJson, out long rejectedPayloadBytes))
        {
            FsusObservability.RecordProviderPayloadRejectedBytes(rejectedPayloadBytes);
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "security_challenge_payload_invalid"), aeds);
        }

        if (!await verifyRateLimiter.TryAcquireAsync(httpContext, challengeId, action, cancellationToken))
        {
            FsusObservability.RecordChallengeVerifyRateLimitedBeforeJson();
            await RecordSecurityChallengeVerifyRejectedAsync(httpContext, riskSignalSink, action, "challenge_verify_rate_limited", cancellationToken);
            return CreateSecurityChallengeVerifyGenericFailure(aeds);
        }

        IReadOnlyDictionary<string, string> providerPayload = new Dictionary<string, string>(0, StringComparer.Ordinal);
        if (!isV3 && !TryDeserializeProviderPayload(request.ProviderPayloadJson, out providerPayload))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "security_challenge_payload_invalid"), aeds);
        }

        RiskControlContext baseContext = riskContextFactory.Create(httpContext);
        RiskControlContext riskContext = baseContext with
        {
            ActionName = action,
            RouteKey = routeKey,
            ActionStatus = RiskControlContextStatuses.Resolved
        };
        RiskControlProofBinding binding = RiskControlProofBindingFactory.Create(riskContext);
        string policyVersion = riskPolicyProvider.CurrentRiskPolicy.PolicyVersion;
        string kind = SecurityChallengeContracts.ToWireName(request.Kind);
        SecurityChallengeOrchestrationVerifyResult verified = await challengeOrchestrator.VerifyAsync(
            new SecurityChallengeOrchestrationVerifyRequest(
                httpContext,
                envelopeId,
                kind,
                challengeId,
                action,
                routeKey,
                binding.SubjectHash,
                binding.ClientIpHash,
                binding.DeviceFpHash,
                policyVersion,
                providerPayload)
            {
                PerceptionCharacterV3 = request.PerceptionCharacterV3
            },
            cancellationToken);
        if (!verified.Succeeded)
        {
            return isV3 ? CreatePerceptionCharacterV3Failure(aeds, verified.Reason) : CreateSecurityChallengeVerifyGenericFailure(aeds);
        }

        var response = new SecurityChallengeVerifyBinaryResponse(
            true,
            verified.EnvelopeId,
            verified.ChallengeId,
            request.Kind,
            verified.PolicyVersion.Length > 0 ? verified.PolicyVersion : policyVersion,
            verified.CompletedCount,
            verified.MemberCount,
            verified.EnvelopeCompleted,
            verified.ProofToken ?? string.Empty,
            verified.ProofExpiresAt?.ToUnixTimeMilliseconds() ?? 0,
            "ok",
            RetryAfterMs: 0)
        {
            NextAssignment = verified.NextAssignment,
            NextProviderPayload = verified.NextAssignment is null
                ? null
                : new SecurityChallengeProviderPayload(
                    verified.NextAssignment.ChallengeId,
                    verified.NextProviderPayload.Count == 0 ? "{}" : JsonSerializer.Serialize(verified.NextProviderPayload))
                {
                    PerceptionCharacterV3 = verified.NextPerceptionCharacterV3
                }
        };
        return BinaryResults.Frame(aeds, AedsFrameType.SecurityChallengeVerifyResponse, writer => PodBinaryCodec.WriteSecurityChallengeVerifyResponse(response, writer));
    }

    private static BinaryFrameResult CreateSecurityChallengeVerifyGenericFailure(IAedsEncoder aeds)
        => BinaryResults.FromError(
            ErrorDetail.Create(ErrorCode.Forbidden, SecurityChallengeVerifyGenericFailure),
            aeds, ApiErrorSemanticMapper.RequireTransportMappingId(StatusCodes.Status428PreconditionRequired, ErrorCode.Forbidden));

    private static BinaryFrameResult CreatePerceptionCharacterV3Failure(IAedsEncoder aeds, string reason)
    {
        string coarse = reason is "retryable" or "reissueRequired" or "rejected" ? reason
            : reason is "unavailable" or "provider_exception" or "provider_missing" or "envelope_state_unavailable" or "state_unavailable" or "device_binding_unavailable" or "crypto_failure" or "redis_failure"
                ? "unavailable"
                : "rejected";
        int status = coarse == "unavailable" ? StatusCodes.Status503ServiceUnavailable : StatusCodes.Status428PreconditionRequired;
        return BinaryResults.FromError(ErrorDetail.Create(coarse == "unavailable" ? ErrorCode.InfraFailure : ErrorCode.Forbidden, coarse), aeds, ApiErrorSemanticMapper.RequireTransportMappingId(status, coarse == "unavailable" ? ErrorCode.InfraFailure : ErrorCode.Forbidden));
    }

    private static bool AcceptsBinaryResponse(HttpRequest request)
        => HttpAcceptNegotiation.Accepts(request.Headers.Accept, BinaryContentType);

    private static string NormalizeRequired(string? value, int maxLength)
    {
        string normalized = (value ?? string.Empty).Trim();
        return normalized.Length <= maxLength ? normalized : normalized[..maxLength];
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

    private static bool DecisionRequiresPerceptionCharacterV3(RiskDecision decision)
        => decision.Kind is RiskDecisionKind.Challenge or RiskDecisionKind.StepUp
            && decision.RequiredChallenges.Any(static challengeKind =>
                SecurityChallengeContracts.TryParseKind(challengeKind, out SecurityChallengeKind parsed)
                && parsed == SecurityChallengeKind.PerceptionCharacterV3);

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

        long startedAt = Stopwatch.GetTimestamp();
        long allocatedBefore = GC.GetAllocatedBytesForCurrentThread();
        try
        {
            byte[] utf8 = Encoding.UTF8.GetBytes(payloadJson);
            var reader = new Utf8JsonReader(utf8, new JsonReaderOptions { MaxDepth = 32 });
            if (!reader.Read() || reader.TokenType != JsonTokenType.StartObject)
            {
                return false;
            }

            var bounded = new Dictionary<string, string>(StringComparer.Ordinal);
            int entries = 0;
            while (reader.Read())
            {
                if (reader.TokenType == JsonTokenType.EndObject)
                {
                    if (reader.Read())
                    {
                        return false;
                    }

                    payload = bounded;
                    return true;
                }

                if (reader.TokenType != JsonTokenType.PropertyName)
                {
                    return false;
                }

                if (++entries > MaxSecurityChallengeProviderPayloadEntries)
                {
                    return false;
                }

                string key = reader.GetString() ?? string.Empty;
                if (!reader.Read() || reader.TokenType != JsonTokenType.String)
                {
                    return false;
                }

                string? value = reader.GetString();
                if (value is null || value.Length > MaxSecurityChallengeProviderPayloadValueChars)
                {
                    return false;
                }

                bounded[key] = value;
            }

            return false;
        }
        catch (JsonException)
        {
            return false;
        }
        finally
        {
            FsusObservability.RecordProviderPayloadParse(FsusObservability.GetElapsed(startedAt));
            FsusObservability.RecordChallengeVerifyAllocationBytes(GC.GetAllocatedBytesForCurrentThread() - allocatedBefore);
        }
    }

    private static bool IsProviderPayloadJsonWithinCheapLimit(string payloadJson, out long payloadBytes)
    {
        payloadBytes = string.IsNullOrEmpty(payloadJson) ? 0 : Encoding.UTF8.GetByteCount(payloadJson);
        return payloadJson.Length <= MaxSecurityChallengeProviderPayloadJsonChars
            && payloadBytes <= MaxSecurityChallengeProviderPayloadJsonBytes;
    }
}
