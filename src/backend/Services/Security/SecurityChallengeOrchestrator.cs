using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Models.Security;
using FsusBlog.Shared.Contracts.Security;

using Microsoft.Extensions.Logging;

namespace FsusBlog.Server.Services.Security;

public interface ISecurityChallengeProvider
{
    string Kind
    {
        get;
    }

    // Provider IssueAsync must persist the one reserved member before returning its assignment.
    // SecurityChallengeOrchestrator invokes exactly one provider per authoritative issuance transition.
    Task<SecurityChallengeProviderIssueResult> IssueAsync(SecurityChallengeProviderIssueRequest request, CancellationToken cancellationToken = default);

    Task<SecurityChallengeProviderVerifyResult> VerifyAsync(SecurityChallengeProviderVerifyRequest request, CancellationToken cancellationToken = default);
}

public enum SecurityChallengeCostClass : byte
{
    Credential = 1,
    CheapProof = 2,
    MemoryProof = 3,
    ScarceArtifact = 4
}

public interface ISecurityChallengeOrchestrator
{
    Task<SecurityChallengeOrchestrationIssueResult> IssueAsync(SecurityChallengeOrchestrationIssueRequest request, CancellationToken cancellationToken = default);

    Task<SecurityChallengeOrchestrationVerifyResult> VerifyAsync(SecurityChallengeOrchestrationVerifyRequest request, CancellationToken cancellationToken = default);
}

public sealed record SecurityChallengeProviderIssueRequest(
    HttpContext Context,
    string Kind,
    string Action,
    string RouteKey,
    string TenantId,
    string SubjectHash,
    string ClientIpHash,
    string DeviceFpHash,
    string PolicyVersion,
    int EscalationLevel,
    string Traceparent)
{
    public string EnvelopeId { get; init; } = string.Empty;
    public string ChallengeId { get; init; } = string.Empty;
    public string Representation { get; init; } = "visual";
    public int RiskScore
    {
        get; init;
    }

    public int EffectiveRiskScore
    {
        get; init;
    }

    public PerceptionChallengeGeneratorDistributionPolicy GeneratorDistributionPolicy
    {
        get; init;
    } =
        PerceptionChallengeGeneratorDistributionPolicy.Default;
}

public sealed record SecurityChallengeProviderVerifyRequest(
    HttpContext Context,
    string Kind,
    string ChallengeId,
    string Action,
    string RouteKey,
    string SubjectHash,
    string ClientIpHash,
    string DeviceFpHash,
    string PolicyVersion,
    IReadOnlyDictionary<string, string> ProviderPayload)
{
    public string EnvelopeId { get; init; } = string.Empty;
    public PerceptionCharacterV3VerifyPayload? PerceptionCharacterV3
    {
        get; init;
    }
}

public sealed record SecurityChallengeProviderIssueResult(
    bool Succeeded,
    string Reason,
    SecurityChallengeAssignment? Assignment,
    IReadOnlyDictionary<string, string> ProviderPayload)
{
    public PerceptionCharacterV3IssuePayload? PerceptionCharacterV3
    {
        get; init;
    }
    private static readonly IReadOnlyDictionary<string, string> s_emptyProviderPayload = new Dictionary<string, string>(0, StringComparer.Ordinal);

    public static SecurityChallengeProviderIssueResult Success(SecurityChallengeAssignment assignment, IReadOnlyDictionary<string, string>? providerPayload = null)
        => new(true, "ok", assignment, providerPayload ?? s_emptyProviderPayload);

    public static SecurityChallengeProviderIssueResult Failed(string reason)
        => new(false, NormalizeReason(reason), null, s_emptyProviderPayload);

    private static string NormalizeReason(string reason)
        => string.IsNullOrWhiteSpace(reason) ? "provider_failed" : reason.Trim();
}

public sealed record SecurityChallengeProviderVerifyResult(
    bool Succeeded,
    string Reason,
    DateTimeOffset? ProofExpiresAt)
{
    public static SecurityChallengeProviderVerifyResult Success(DateTimeOffset? proofExpiresAt = null)
        => new(true, "ok", proofExpiresAt);

    public static SecurityChallengeProviderVerifyResult Failed(string reason)
        => new(false, string.IsNullOrWhiteSpace(reason) ? "provider_verify_failed" : reason.Trim(), null);
}

public sealed record SecurityChallengeOrchestrationIssueRequest(
    HttpContext Context,
    RiskDecision Decision,
    string TenantId,
    string SubjectHash,
    string ClientIpHash,
    string DeviceFpHash,
    string Traceparent);

public sealed record SecurityChallengeOrchestrationVerifyRequest(
    HttpContext Context,
    string EnvelopeId,
    string Kind,
    string ChallengeId,
    string Action,
    string RouteKey,
    string SubjectHash,
    string ClientIpHash,
    string DeviceFpHash,
    string PolicyVersion,
    IReadOnlyDictionary<string, string> ProviderPayload)
{
    public PerceptionCharacterV3VerifyPayload? PerceptionCharacterV3
    {
        get; init;
    }
}

public sealed record SecurityChallengeOrchestrationIssueResult(
    bool Succeeded,
    string Reason,
    SecurityChallengeEnvelope? Envelope,
    IReadOnlyDictionary<string, IReadOnlyDictionary<string, string>> ProviderPayloads)
{
    public IReadOnlyDictionary<string, PerceptionCharacterV3IssuePayload> PerceptionCharacterV3Payloads
    {
        get; init;
    }
        = new Dictionary<string, PerceptionCharacterV3IssuePayload>(0, StringComparer.Ordinal);
    private static readonly IReadOnlyDictionary<string, IReadOnlyDictionary<string, string>> s_emptyProviderPayloads =
        new Dictionary<string, IReadOnlyDictionary<string, string>>(0, StringComparer.Ordinal);

    public static SecurityChallengeOrchestrationIssueResult Success(
        SecurityChallengeEnvelope envelope,
        IReadOnlyDictionary<string, IReadOnlyDictionary<string, string>>? providerPayloads = null)
        => new(true, "ok", envelope, providerPayloads ?? s_emptyProviderPayloads);

    public static SecurityChallengeOrchestrationIssueResult Failed(string reason)
        => new(false, string.IsNullOrWhiteSpace(reason) ? "challenge_issue_failed" : reason.Trim(), null, s_emptyProviderPayloads);
}

public sealed record SecurityChallengeOrchestrationVerifyResult(
    bool Succeeded,
    string Reason,
    string EnvelopeId,
    string ChallengeId,
    string Kind,
    int CompletedCount,
    int MemberCount,
    bool EnvelopeCompleted,
    string? ProofToken,
    DateTimeOffset? ProofExpiresAt)
{
    public string PolicyVersion { get; init; } = string.Empty;
    public SecurityChallengeAssignment? NextAssignment
    {
        get; init;
    }
    public IReadOnlyDictionary<string, string> NextProviderPayload
    {
        get; init;
    }
        = new Dictionary<string, string>(0, StringComparer.Ordinal);
    public PerceptionCharacterV3IssuePayload? NextPerceptionCharacterV3
    {
        get; init;
    }
    public static SecurityChallengeOrchestrationVerifyResult Progress(
        SecurityChallengeEnvelopeMemberResult member,
        string challengeId,
        string kind)
        => new(true, "ok", member.State?.EnvelopeId ?? string.Empty, challengeId, kind,
            member.CompletedCount, member.MemberCount, false, null, null)
        {
            PolicyVersion = member.State?.PolicyVersion ?? string.Empty
        };

    public static SecurityChallengeOrchestrationVerifyResult Completed(
        SecurityChallengeEnvelopeMemberResult member,
        string challengeId,
        string kind,
        SecurityChallengeProofMintResult proof)
        => new(true, "ok", member.State?.EnvelopeId ?? string.Empty, challengeId, kind,
            member.CompletedCount, member.MemberCount, true, proof.ProofToken, proof.Claims.ExpiresAt)
        {
            PolicyVersion = member.State?.PolicyVersion ?? proof.Claims.PolicyVersion
        };

    public static SecurityChallengeOrchestrationVerifyResult Failed(
        string reason,
        string envelopeId = "",
        string challengeId = "",
        string kind = "",
        int completedCount = 0,
        int memberCount = 0)
        => new(false, string.IsNullOrWhiteSpace(reason) ? "challenge_verify_failed" : reason.Trim(),
            envelopeId, challengeId, kind, completedCount, memberCount, false, null, null);
}

public sealed partial class SecurityChallengeOrchestrator(
    IEnumerable<ISecurityChallengeProvider> providers,
    ISecurityChallengeProofService proofService,
    ISecurityRiskSignalSink riskSignalSink,
    ISecurityChallengeEnvelopeStateService envelopeStateService,
    ILogger<SecurityChallengeOrchestrator>? logger = null,
    TimeProvider? timeProvider = null,
    ISecurityChallengeProtocolActivationGuard? protocolActivationGuard = null) : ISecurityChallengeOrchestrator
{
    private static readonly TimeSpan s_riskSignalTtl = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan s_defaultProofTtl = TimeSpan.FromMinutes(5);
    private readonly TimeProvider _timeProvider = timeProvider ?? TimeProvider.System;
    private readonly IReadOnlyDictionary<string, ISecurityChallengeProvider> _providers = providers
        .Where(static provider => !string.IsNullOrWhiteSpace(provider.Kind))
        .GroupBy(static provider => NormalizeKind(provider.Kind), StringComparer.Ordinal)
        .ToDictionary(static group => group.Key, static group => group.Last(), StringComparer.Ordinal);

    public async Task<SecurityChallengeOrchestrationIssueResult> IssueAsync(SecurityChallengeOrchestrationIssueRequest request, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        cancellationToken.ThrowIfCancellationRequested();

        if (protocolActivationGuard is not null
            && request.Decision.RequiredChallenges.Any(static kind =>
                SecurityChallengeContracts.TryParseKind(kind, out SecurityChallengeKind parsed)
                && parsed == SecurityChallengeKind.PerceptionCharacterV3)
            && !await protocolActivationGuard.IsOpenAsync(cancellationToken).ConfigureAwait(false))
        {
            return SecurityChallengeOrchestrationIssueResult.Failed("challenge_protocol_unavailable");
        }

        if (request.Decision.RequiredChallenges.Count is <= 0 or > SecurityChallengeContracts.MaxAssignmentsPerEnvelope)
        {
            RecordChallengeFailure(
                "issue",
                "none",
                request.Decision.ActionName,
                request.Decision.PolicyVersion,
                "challenge_count_invalid");
            await RecordRiskAsync(request.Context, request.Decision.ActionName, "challenge_count_invalid", cancellationToken);
            return SecurityChallengeOrchestrationIssueResult.Failed("challenge_count_invalid");
        }

        string envelopeId = SecurityChallengeContracts.CreateChallengeId();
        string representation = ResolveRepresentation(request.Context);
        string[] orderedPlan = request.Decision.RequiredChallenges
            .Select(NormalizeKind)
            .OrderBy(ResolveCostClass)
            .ToArray();
        if (orderedPlan.Distinct(StringComparer.Ordinal).Count() != orderedPlan.Length)
        {
            await RecordRiskAsync(request.Context, request.Decision.ActionName, "challenge_plan_duplicate", cancellationToken).ConfigureAwait(false);
            return SecurityChallengeOrchestrationIssueResult.Failed("challenge_plan_duplicate");
        }
        string[] kinds = new string[orderedPlan.Length];
        string[] challengeIds = new string[kinds.Length];
        // Validate the complete plan before materializing even its first member.
        for (int index = 0; index < orderedPlan.Length; index++)
        {
            string kind = orderedPlan[index];
            if (!SecurityChallengeContracts.TryParseKind(kind, out SecurityChallengeKind parsedKind))
            {
                RecordChallengeFailure("issue", kind, request.Decision.ActionName, request.Decision.PolicyVersion, "kind_unknown");
                await RecordRiskAsync(request.Context, request.Decision.ActionName, $"kind_unknown:{kind}", cancellationToken);
                return SecurityChallengeOrchestrationIssueResult.Failed("kind_unknown");
            }
            if (!_providers.TryGetValue(kind, out ISecurityChallengeProvider? provider))
            {
                RecordChallengeFailure("issue", kind, request.Decision.ActionName, request.Decision.PolicyVersion, "provider_missing");
                await RecordRiskAsync(request.Context, request.Decision.ActionName, $"provider_missing:{kind}", cancellationToken);
                return SecurityChallengeOrchestrationIssueResult.Failed("provider_missing");
            }

            SecurityChallengeCapabilityResolution capability = SecurityChallengeCapabilityCatalog.Resolve(
                parsedKind,
                request.Decision.ActionName,
                SecurityChallengeCapabilityCatalog.ResolveMode(request.Decision.ActionName),
                providerAvailable: true);
            if (!capability.PolicyEligible)
            {
                string reason = capability.UnavailableReason ?? "capability_unavailable";
                RecordChallengeFailure("issue", kind, request.Decision.ActionName, request.Decision.PolicyVersion, reason);
                await RecordRiskAsync(request.Context, request.Decision.ActionName, $"capability_unavailable:{kind}:{reason}", cancellationToken);
                return SecurityChallengeOrchestrationIssueResult.Failed(reason);
            }

            kinds[index] = kind;
            challengeIds[index] = SecurityChallengeContracts.CreateChallengeId();
        }

        SecurityChallengeProviderIssueResult providerResult = await IssueMemberAsync(
            request.Context, envelopeId, challengeIds[0], kinds[0], request.Decision.ActionName,
            request.Decision.RouteKey, request.TenantId, request.SubjectHash, request.ClientIpHash,
            request.DeviceFpHash, request.Decision.PolicyVersion, request.Decision.EscalationLevel,
            request.Traceparent, request.Decision.RiskScore, request.Decision.EffectiveRiskScore,
            request.Decision.PerceptionGeneratorPolicy, representation, cancellationToken).ConfigureAwait(false);
        if (!providerResult.Succeeded || providerResult.Assignment is null)
        {
            RecordChallengeFailure("issue", kinds[0], request.Decision.ActionName, request.Decision.PolicyVersion, providerResult.Reason);
            await RecordRiskAsync(request.Context, request.Decision.ActionName, $"provider_failure:{kinds[0]}:{providerResult.Reason}", cancellationToken).ConfigureAwait(false);
            return SecurityChallengeOrchestrationIssueResult.Failed(providerResult.Reason);
        }

        SecurityChallengeAssignment firstAssignment = providerResult.Assignment;

        var envelope = new SecurityChallengeEnvelope(
            envelopeId,
            NormalizeRequired(request.Decision.PolicyVersion, nameof(request.Decision.PolicyVersion), 64),
            [firstAssignment]);
        var envelopeState = new SecurityChallengeEnvelopeState(
            envelope.EnvelopeId,
            request.Decision.ActionName,
            request.Decision.RouteKey,
            request.SubjectHash,
            request.ClientIpHash,
            request.DeviceFpHash,
            envelope.PolicyVersion,
            challengeIds,
            kinds,
            kinds.Select((_, index) => index == 0
                ? SecurityChallengeEnvelopeMemberStatuses.Issued
                : SecurityChallengeEnvelopeMemberStatuses.Planned).ToArray(),
            firstAssignment.IssuedAtUnixMs,
            firstAssignment.ExpiresAtUnixMs,
            SecurityChallengeEnvelopeStatuses.Active,
            Version: 0)
        {
            TenantId = NormalizeRequired(request.TenantId, nameof(request.TenantId), 64),
            Traceparent = NormalizeRequired(request.Traceparent, nameof(request.Traceparent), 128),
            EscalationLevel = request.Decision.EscalationLevel,
            RiskScore = request.Decision.RiskScore,
            EffectiveRiskScore = request.Decision.EffectiveRiskScore,
            GeneratorDistributionPolicy = request.Decision.PerceptionGeneratorPolicy,
            Representation = representation
        };
        if (!await envelopeStateService.CreateAsync(envelopeState, cancellationToken).ConfigureAwait(false))
        {
            RecordChallengeFailure("issue", "envelope", request.Decision.ActionName, request.Decision.PolicyVersion, "envelope_state_unavailable");
            await RecordRiskAsync(request.Context, request.Decision.ActionName, "envelope_state_unavailable", cancellationToken);
            return SecurityChallengeOrchestrationIssueResult.Failed("envelope_state_unavailable");
        }
        if (logger is not null)
        {
            LogChallengeIssueSucceeded(logger, request.Decision.ActionName, 1, request.Decision.PolicyVersion);
        }

        var providerPayloads = providerResult.ProviderPayload.Count == 0
            ? null
            : new Dictionary<string, IReadOnlyDictionary<string, string>>(StringComparer.Ordinal)
            {
                [firstAssignment.ChallengeId] = providerResult.ProviderPayload
            };
        return SecurityChallengeOrchestrationIssueResult.Success(envelope, providerPayloads) with
        {
            PerceptionCharacterV3Payloads = providerResult.PerceptionCharacterV3 is null
                ? new Dictionary<string, PerceptionCharacterV3IssuePayload>(0, StringComparer.Ordinal)
                : new Dictionary<string, PerceptionCharacterV3IssuePayload>(StringComparer.Ordinal)
                {
                    [firstAssignment.ChallengeId] = providerResult.PerceptionCharacterV3
                }
        };
    }

    private async Task<SecurityChallengeProviderIssueResult> IssueMemberAsync(
        HttpContext context,
        string envelopeId,
        string challengeId,
        string kind,
        string action,
        string routeKey,
        string tenantId,
        string subjectHash,
        string clientIpHash,
        string deviceFpHash,
        string policyVersion,
        int escalationLevel,
        string traceparent,
        int riskScore,
        int effectiveRiskScore,
        PerceptionChallengeGeneratorDistributionPolicy generatorDistributionPolicy,
        string representation,
        CancellationToken cancellationToken)
    {
        if (!_providers.TryGetValue(kind, out ISecurityChallengeProvider? provider))
            return SecurityChallengeProviderIssueResult.Failed("provider_missing");
        try
        {
            SecurityChallengeProviderIssueResult result = await provider.IssueAsync(
                new SecurityChallengeProviderIssueRequest(
                    context, kind, action, routeKey,
                    NormalizeRequired(tenantId, nameof(tenantId), 64),
                    NormalizeHash(subjectHash, nameof(subjectHash)),
                    NormalizeHash(clientIpHash, nameof(clientIpHash)),
                    NormalizeHash(deviceFpHash, nameof(deviceFpHash)),
                    policyVersion, escalationLevel,
                    NormalizeRequired(traceparent, nameof(traceparent), 128))
                {
                    EnvelopeId = envelopeId,
                    ChallengeId = challengeId,
                    RiskScore = riskScore,
                    EffectiveRiskScore = effectiveRiskScore,
                    GeneratorDistributionPolicy = generatorDistributionPolicy,
                    Representation = representation
                }, cancellationToken).ConfigureAwait(false);
            if (!result.Succeeded || result.Assignment is null)
                return SecurityChallengeProviderIssueResult.Failed(result.Reason);
            SecurityChallengeValidationResult validation = ValidateProviderAssignment(result.Assignment, kind);
            if (!validation.IsValid || !string.Equals(result.Assignment.ChallengeId, challengeId, StringComparison.Ordinal))
                return SecurityChallengeProviderIssueResult.Failed(validation.IsValid ? "challenge_id_mismatch" : validation.ErrorCode);
            return result;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            RecordChallengeFailure("issue", kind, action, policyVersion, "provider_exception", ex);
            await RecordRiskAsync(context, action, $"provider_exception:{kind}", cancellationToken).ConfigureAwait(false);
            return SecurityChallengeProviderIssueResult.Failed("provider_exception");
        }
    }

    internal static SecurityChallengeCostClass ResolveCostClass(string kind)
        => NormalizeKind(kind) switch
        {
            "passkeyStepUpV1" or "adminPasskeyStepUpV1" or "recoveryKeyProofV1"
                or "anonymousCredentialProofV1" or "zkAnonymousCommentProofV1" => SecurityChallengeCostClass.Credential,
            "argon2idPoSpaceV1" => SecurityChallengeCostClass.MemoryProof,
            "perceptionCharacterV3" => SecurityChallengeCostClass.ScarceArtifact,
            _ => SecurityChallengeCostClass.CheapProof
        };

    public async Task<SecurityChallengeOrchestrationVerifyResult> VerifyAsync(SecurityChallengeOrchestrationVerifyRequest request, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        cancellationToken.ThrowIfCancellationRequested();

        string kind = NormalizeKind(request.Kind);
        if (protocolActivationGuard is not null
            && SecurityChallengeContracts.TryParseKind(kind, out SecurityChallengeKind parsedKind)
            && parsedKind == SecurityChallengeKind.PerceptionCharacterV3
            && !await protocolActivationGuard.IsOpenAsync(cancellationToken).ConfigureAwait(false))
        {
            return SecurityChallengeOrchestrationVerifyResult.Failed("challenge_protocol_unavailable");
        }
        string issuedPolicyVersion = NormalizeRequired(request.PolicyVersion, nameof(request.PolicyVersion), 64);
        string issuedDeviceBinding = NormalizeHash(request.DeviceFpHash, nameof(request.DeviceFpHash));
        if (request.PerceptionCharacterV3 is not null)
        {
            SecurityChallengeEnvelopeState? issuedState = await envelopeStateService.GetAsync(request.EnvelopeId, cancellationToken).ConfigureAwait(false);
            if (issuedState is not null)
            {
                issuedPolicyVersion = issuedState.PolicyVersion;
                issuedDeviceBinding = issuedState.DeviceFpHash;
            }
        }
        var memberRequest = new SecurityChallengeEnvelopeMemberRequest(
            NormalizeRequired(request.EnvelopeId, nameof(request.EnvelopeId), 64),
            NormalizeRequired(request.ChallengeId, nameof(request.ChallengeId), 64),
            kind,
            NormalizeRequired(request.Action, nameof(request.Action), 96),
            NormalizeRequired(request.RouteKey, nameof(request.RouteKey), 256),
            NormalizeHash(request.SubjectHash, nameof(request.SubjectHash)),
            NormalizeHash(request.ClientIpHash, nameof(request.ClientIpHash)),
            issuedDeviceBinding,
            issuedPolicyVersion);
        SecurityChallengeEnvelopeMemberResult validation = await envelopeStateService.ValidateMemberAsync(memberRequest, cancellationToken).ConfigureAwait(false);
        if (!validation.Accepted)
        {
            RecordChallengeFailure("verify", kind, request.Action, request.PolicyVersion, validation.Reason);
            await RecordRiskAsync(request.Context, request.Action, $"envelope_member_rejected:{kind}:{validation.Reason}", cancellationToken);
            return SecurityChallengeOrchestrationVerifyResult.Failed(
                validation.Reason,
                request.EnvelopeId,
                request.ChallengeId,
                kind,
                validation.CompletedCount,
                validation.MemberCount);
        }
        if (validation.State is not null
            && (string.Equals(validation.State.Status, SecurityChallengeEnvelopeStatuses.ProofMinting, StringComparison.Ordinal)
                || string.Equals(validation.State.Status, SecurityChallengeEnvelopeStatuses.Completed, StringComparison.Ordinal)))
        {
            return await FinalizePreparedProofAsync(request, memberRequest, kind, validation, cancellationToken).ConfigureAwait(false);
        }
        if (!_providers.TryGetValue(kind, out ISecurityChallengeProvider? provider))
        {
            RecordChallengeFailure("verify", kind, request.Action, request.PolicyVersion, "provider_missing");
            await RecordRiskAsync(request.Context, request.Action, $"provider_missing:{kind}", cancellationToken);
            await envelopeStateService.FailAsync(memberRequest, "provider_missing", cancellationToken).ConfigureAwait(false);
            return SecurityChallengeOrchestrationVerifyResult.Failed("provider_missing", request.EnvelopeId, request.ChallengeId, kind, validation.CompletedCount, validation.MemberCount);
        }

        SecurityChallengeEnvelopeMemberResult reservation = await envelopeStateService.ReserveMemberAsync(
            memberRequest,
            cancellationToken).ConfigureAwait(false);
        if (!reservation.Accepted || reservation.State is null)
        {
            RecordChallengeFailure("verify", kind, request.Action, request.PolicyVersion, reservation.Reason);
            await RecordRiskAsync(request.Context, request.Action, $"envelope_reservation_failed:{kind}:{reservation.Reason}", cancellationToken);
            return SecurityChallengeOrchestrationVerifyResult.Failed(
                reservation.Reason,
                request.EnvelopeId,
                request.ChallengeId,
                kind,
                reservation.CompletedCount,
                reservation.MemberCount);
        }

        SecurityChallengeProviderVerifyResult providerResult;
        try
        {
            providerResult = await provider.VerifyAsync(
                new SecurityChallengeProviderVerifyRequest(
                    request.Context,
                    kind,
                    NormalizeRequired(request.ChallengeId, nameof(request.ChallengeId), 64),
                    NormalizeRequired(request.Action, nameof(request.Action), 96),
                    NormalizeRequired(request.RouteKey, nameof(request.RouteKey), 256),
                    NormalizeHash(request.SubjectHash, nameof(request.SubjectHash)),
                    NormalizeHash(request.ClientIpHash, nameof(request.ClientIpHash)),
                    issuedDeviceBinding,
                    issuedPolicyVersion,
                    request.ProviderPayload)
                {
                    EnvelopeId = request.EnvelopeId,
                    PerceptionCharacterV3 = request.PerceptionCharacterV3
                },
                cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            await envelopeStateService.FailAsync(memberRequest, "provider_exception", cancellationToken).ConfigureAwait(false);
            RecordChallengeFailure("verify", kind, request.Action, request.PolicyVersion, "provider_exception", ex);
            await RecordRiskAsync(request.Context, request.Action, $"provider_exception:{kind}", cancellationToken);
            return SecurityChallengeOrchestrationVerifyResult.Failed("provider_exception", request.EnvelopeId, request.ChallengeId, kind, validation.CompletedCount, validation.MemberCount);
        }

        if (!providerResult.Succeeded)
        {
            await envelopeStateService.FailAsync(memberRequest, providerResult.Reason, cancellationToken).ConfigureAwait(false);
            RecordChallengeFailure("verify", kind, request.Action, request.PolicyVersion, providerResult.Reason);
            await RecordRiskAsync(request.Context, request.Action, $"provider_verify_failed:{kind}:{providerResult.Reason}", cancellationToken);
            return SecurityChallengeOrchestrationVerifyResult.Failed(providerResult.Reason, request.EnvelopeId, request.ChallengeId, kind, validation.CompletedCount, validation.MemberCount);
        }

        DateTimeOffset issuedAt = _timeProvider.GetUtcNow();
        DateTimeOffset envelopeExpiresAt = DateTimeOffset.FromUnixTimeMilliseconds(reservation.State.ExpiresAtUnixMs);
        DateTimeOffset expiresAt = providerResult.ProofExpiresAt is { } proofExpiresAt && proofExpiresAt > issuedAt
            ? proofExpiresAt
            : issuedAt.Add(s_defaultProofTtl);
        if (expiresAt > envelopeExpiresAt)
        {
            expiresAt = envelopeExpiresAt;
        }
        SecurityChallengeProofPreparation? proofPreparation = reservation.MemberIndex == reservation.MemberCount - 1
            ? new SecurityChallengeProofPreparation(issuedAt, expiresAt)
            : null;
        SecurityChallengeEnvelopeMemberResult member = await envelopeStateService.CompleteMemberAsync(
            memberRequest,
            proofPreparation,
            cancellationToken).ConfigureAwait(false);
        if (!member.Accepted || member.State is null)
        {
            RecordChallengeFailure("verify", kind, request.Action, request.PolicyVersion, member.Reason);
            await RecordRiskAsync(request.Context, request.Action, $"envelope_transition_failed:{kind}:{member.Reason}", cancellationToken);
            return SecurityChallengeOrchestrationVerifyResult.Failed(member.Reason, request.EnvelopeId, request.ChallengeId, kind, member.CompletedCount, member.MemberCount);
        }
        if (string.Equals(member.State.Status, SecurityChallengeEnvelopeStatuses.Active, StringComparison.Ordinal))
        {
            if (member.IssuanceIndex < 0 || member.IssuanceIndex >= member.State.MemberCount)
                return SecurityChallengeOrchestrationVerifyResult.Failed("challenge_envelope_issuance_not_reserved", request.EnvelopeId, request.ChallengeId, kind, member.CompletedCount, member.MemberCount);
            int nextIndex = member.IssuanceIndex;
            string nextKind = member.State.RequiredKinds[nextIndex];
            string nextChallengeId = member.State.ChallengeIds[nextIndex];
            SecurityChallengeProviderIssueResult issued = await IssueMemberAsync(
                request.Context,
                member.State.EnvelopeId,
                nextChallengeId,
                nextKind,
                member.State.Action,
                member.State.RouteKey,
                member.State.TenantId,
                member.State.SubjectHash,
                member.State.ClientIpHash,
                member.State.DeviceFpHash,
                member.State.PolicyVersion,
                member.State.EscalationLevel,
                member.State.Traceparent,
                member.State.RiskScore,
                member.State.EffectiveRiskScore,
                member.State.GeneratorDistributionPolicy,
                member.State.Representation,
                cancellationToken).ConfigureAwait(false);
            if (!issued.Succeeded || issued.Assignment is null)
            {
                var nextRequest = memberRequest with
                {
                    ChallengeId = nextChallengeId,
                    Kind = nextKind
                };
                await envelopeStateService.FailAsync(nextRequest, issued.Reason, cancellationToken).ConfigureAwait(false);
                RecordChallengeFailure("issue", nextKind, member.State.Action, member.State.PolicyVersion, issued.Reason);
                await RecordRiskAsync(request.Context, member.State.Action, $"provider_failure:{nextKind}:{issued.Reason}", cancellationToken).ConfigureAwait(false);
                return SecurityChallengeOrchestrationVerifyResult.Failed(issued.Reason, request.EnvelopeId, request.ChallengeId, kind, member.CompletedCount, member.MemberCount);
            }
            var issuedRequest = memberRequest with
            {
                ChallengeId = nextChallengeId,
                Kind = nextKind
            };
            SecurityChallengeEnvelopeMemberResult issuance = await envelopeStateService.CompleteIssuanceAsync(
                issuedRequest, nextIndex, cancellationToken).ConfigureAwait(false);
            if (!issuance.Accepted)
            {
                // The provider state may already exist. Never retry issuance after an ambiguous CAS.
                await envelopeStateService.FailAsync(issuedRequest, "challenge_issuance_ambiguous", CancellationToken.None).ConfigureAwait(false);
                return SecurityChallengeOrchestrationVerifyResult.Failed("challenge_issuance_ambiguous", request.EnvelopeId, request.ChallengeId, kind, member.CompletedCount, member.MemberCount);
            }
            if (logger is not null)
            {
                LogChallengeVerifySucceeded(logger, request.Action, kind, request.PolicyVersion);
            }
            return SecurityChallengeOrchestrationVerifyResult.Progress(issuance, request.ChallengeId, kind) with
            {
                NextAssignment = issued.Assignment,
                NextProviderPayload = issued.ProviderPayload,
                NextPerceptionCharacterV3 = issued.PerceptionCharacterV3
            };
        }
        return await FinalizePreparedProofAsync(request, memberRequest, kind, member, cancellationToken).ConfigureAwait(false);
    }

    private async Task<SecurityChallengeOrchestrationVerifyResult> FinalizePreparedProofAsync(
        SecurityChallengeOrchestrationVerifyRequest request,
        SecurityChallengeEnvelopeMemberRequest memberRequest,
        string kind,
        SecurityChallengeEnvelopeMemberResult member,
        CancellationToken cancellationToken)
    {
        SecurityChallengeEnvelopeState state = member.State
            ?? throw new InvalidOperationException("Prepared proof state is missing.");
        if (!state.HasPreparedProof)
        {
            return SecurityChallengeOrchestrationVerifyResult.Failed(
                "proof_state_missing",
                request.EnvelopeId,
                request.ChallengeId,
                kind,
                member.CompletedCount,
                member.MemberCount);
        }

        SecurityChallengeProofMintRequest mintRequest = CreatePreparedMintRequest(memberRequest, state);
        if (string.Equals(state.Status, SecurityChallengeEnvelopeStatuses.Completed, StringComparison.Ordinal))
        {
            return SecurityChallengeOrchestrationVerifyResult.Completed(
                member,
                request.ChallengeId,
                kind,
                CreatePreparedProofResult(mintRequest));
        }

        try
        {
            SecurityChallengeProofMintResult proof = await proofService.MintProofAsync(mintRequest, cancellationToken).ConfigureAwait(false);
            if (!string.Equals(proof.ProofToken, state.ProofToken, StringComparison.Ordinal))
            {
                throw new InvalidOperationException("Proof service changed the prepared proof token.");
            }
            SecurityChallengeEnvelopeMemberResult completed = await envelopeStateService.CompleteProofAsync(
                memberRequest,
                proof.ProofToken,
                cancellationToken).ConfigureAwait(false);
            if (!completed.Accepted || !completed.EnvelopeCompleted)
            {
                return SecurityChallengeOrchestrationVerifyResult.Failed(
                    completed.Reason,
                    request.EnvelopeId,
                    request.ChallengeId,
                    kind,
                    completed.CompletedCount,
                    completed.MemberCount);
            }
            if (logger is not null)
            {
                LogChallengeVerifySucceeded(logger, request.Action, kind, request.PolicyVersion);
            }

            return SecurityChallengeOrchestrationVerifyResult.Completed(completed, request.ChallengeId, kind, proof);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            RecordChallengeFailure("verify", kind, request.Action, request.PolicyVersion, "proof_mint_failed", ex);
            await RecordRiskAsync(request.Context, request.Action, $"proof_mint_failed:{kind}", cancellationToken);
            return SecurityChallengeOrchestrationVerifyResult.Failed("proof_mint_failed", request.EnvelopeId, request.ChallengeId, kind, member.CompletedCount, member.MemberCount);
        }
    }

    private static SecurityChallengeProofMintRequest CreatePreparedMintRequest(
        SecurityChallengeEnvelopeMemberRequest request,
        SecurityChallengeEnvelopeState state)
        => new(
            request.ChallengeId,
            request.Kind,
            request.Action,
            request.RouteKey,
            request.SubjectHash,
            request.ClientIpHash,
            request.DeviceFpHash,
            request.PolicyVersion,
            DateTimeOffset.FromUnixTimeMilliseconds(state.ProofIssuedAtUnixMs!.Value),
            DateTimeOffset.FromUnixTimeMilliseconds(state.ProofExpiresAtUnixMs!.Value),
            EnvelopeId: state.EnvelopeId,
            RequiredKinds: state.RequiredKinds,
            OrderedMemberChallengeIds: state.ChallengeIds,
            ProofToken: state.ProofToken,
            Nonce: state.ProofNonce);

    private static SecurityChallengeProofMintResult CreatePreparedProofResult(SecurityChallengeProofMintRequest request)
        => new(
            request.ProofToken!,
            new SecurityChallengeProofClaims(
                request.ChallengeId,
                request.Kind,
                request.Action,
                request.RouteKey,
                request.SubjectHash,
                request.ClientIpHash,
                request.DeviceFpHash,
                request.IssuedAt,
                request.ExpiresAt,
                request.Nonce!,
                request.PolicyVersion,
                request.EnvelopeId,
                request.RequiredKinds,
                request.OrderedMemberChallengeIds));

    private static SecurityChallengeValidationResult ValidateProviderAssignment(SecurityChallengeAssignment assignment, string kind)
        => SecurityChallengeContracts.TryParseKind(kind, out SecurityChallengeKind expectedKind)
            ? SecurityChallengeContracts.ValidateAssignment(assignment, expectedKind)
            : SecurityChallengeContracts.ValidateAssignment(assignment);

    private ValueTask RecordRiskAsync(HttpContext context, string action, string detail, CancellationToken cancellationToken)
        => riskSignalSink.AddRiskAsync(new SecurityRiskSignal(
            context,
            SecurityRiskReason.SecurityChallengeRejected,
            10,
            s_riskSignalTtl,
            SecurityRiskSources.RiskControl,
            string.IsNullOrWhiteSpace(action) ? "security_challenge" : action,
            detail), cancellationToken);

    private void RecordChallengeFailure(
        string phase,
        string kind,
        string action,
        string policyVersion,
        string reason,
        Exception? exception = null)
    {
        FsusObservability.RecordSecurityChallengeFailed(kind, action, reason, policyVersion);
        if (logger is null)
        {
            return;
        }

        if (string.Equals(phase, "issue", StringComparison.Ordinal))
        {
            LogChallengeIssueFailed(logger, exception, action, kind, reason, policyVersion);
            return;
        }

        LogChallengeVerifyFailed(logger, exception, action, kind, reason, policyVersion);
    }

    [LoggerMessage(EventId = 1701, Level = LogLevel.Warning, Message = "security challenge issue failed action={Action} kind={Kind} reason={Reason} policyVersion={PolicyVersion}")]
    private static partial void LogChallengeIssueFailed(ILogger logger, Exception? exception, string action, string kind, string reason, string policyVersion);

    [LoggerMessage(EventId = 1702, Level = LogLevel.Warning, Message = "security challenge verify failed action={Action} kind={Kind} reason={Reason} policyVersion={PolicyVersion}")]
    private static partial void LogChallengeVerifyFailed(ILogger logger, Exception? exception, string action, string kind, string reason, string policyVersion);

    [LoggerMessage(EventId = 1703, Level = LogLevel.Information, Message = "security challenge issue succeeded action={Action} challengeCount={ChallengeCount} policyVersion={PolicyVersion}")]
    private static partial void LogChallengeIssueSucceeded(ILogger logger, string action, int challengeCount, string policyVersion);

    [LoggerMessage(EventId = 1704, Level = LogLevel.Information, Message = "security challenge verify succeeded action={Action} kind={Kind} policyVersion={PolicyVersion}")]
    private static partial void LogChallengeVerifySucceeded(ILogger logger, string action, string kind, string policyVersion);

    private static string ResolveRepresentation(HttpContext context)
        => string.Equals(
            context.Request.Headers["X-Fsus-Challenge-Representation"].ToString(),
            "audio",
            StringComparison.Ordinal)
            ? "audio"
            : "visual";

    private static string NormalizeKind(string? value)
    {
        string normalized = NormalizeRequired(value, nameof(value), 64);
        return SecurityChallengeContracts.TryParseKind(normalized, out SecurityChallengeKind kind)
            ? SecurityChallengeContracts.ToWireName(kind)
            : normalized;
    }

    private static string NormalizeRequired(string? value, string name, int maxLength)
    {
        string normalized = (value ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            throw new ArgumentException($"{name} is required", name);
        }

        if (normalized.Length > maxLength)
        {
            throw new ArgumentException($"{name} exceeds {maxLength} characters", name);
        }

        return normalized;
    }

    private static string NormalizeHash(string? value, string name)
    {
        string normalized = NormalizeRequired(value, name, 64).ToLowerInvariant();
        if (normalized.Length != 64 || !IsHex(normalized))
        {
            throw new ArgumentException($"{name} must be a 64-character hex hash", name);
        }

        return normalized;
    }

    private static bool IsHex(string value)
    {
        for (int i = 0; i < value.Length; i++)
        {
            char c = value[i];
            if (c is not ((>= '0' and <= '9') or (>= 'a' and <= 'f')))
            {
                return false;
            }
        }

        return true;
    }
}
