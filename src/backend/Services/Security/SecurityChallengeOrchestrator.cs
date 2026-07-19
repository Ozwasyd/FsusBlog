using FsusBlog.Server.Infrastructure.Observability;
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

    // Provider IssueAsync must persist the challenge before returning a successful assignment.
    // SecurityChallengeOrchestrator only builds the client envelope after every provider succeeds.
    Task<SecurityChallengeProviderIssueResult> IssueAsync(SecurityChallengeProviderIssueRequest request, CancellationToken cancellationToken = default);

    Task<SecurityChallengeProviderVerifyResult> VerifyAsync(SecurityChallengeProviderVerifyRequest request, CancellationToken cancellationToken = default);
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
    IReadOnlyDictionary<string, string> ProviderPayload);

public sealed record SecurityChallengeProviderIssueResult(
    bool Succeeded,
    string Reason,
    SecurityChallengeAssignment? Assignment,
    IReadOnlyDictionary<string, string> ProviderPayload)
{
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
    string Kind,
    string ChallengeId,
    string Action,
    string RouteKey,
    string SubjectHash,
    string ClientIpHash,
    string DeviceFpHash,
    string PolicyVersion,
    IReadOnlyDictionary<string, string> ProviderPayload);

public sealed record SecurityChallengeOrchestrationIssueResult(
    bool Succeeded,
    string Reason,
    SecurityChallengeEnvelope? Envelope,
    IReadOnlyDictionary<string, IReadOnlyDictionary<string, string>> ProviderPayloads)
{
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
    string? ProofToken,
    DateTimeOffset? ProofExpiresAt)
{
    public static SecurityChallengeOrchestrationVerifyResult Success(SecurityChallengeProofMintResult proof)
        => new(true, "ok", proof.ProofToken, proof.Claims.ExpiresAt);

    public static SecurityChallengeOrchestrationVerifyResult Failed(string reason)
        => new(false, string.IsNullOrWhiteSpace(reason) ? "challenge_verify_failed" : reason.Trim(), null, null);
}

public sealed partial class SecurityChallengeOrchestrator(
    IEnumerable<ISecurityChallengeProvider> providers,
    ISecurityChallengeProofService proofService,
    ISecurityRiskSignalSink riskSignalSink,
    ILogger<SecurityChallengeOrchestrator>? logger = null,
    TimeProvider? timeProvider = null) : ISecurityChallengeOrchestrator
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

        var assignments = new List<SecurityChallengeAssignment>(request.Decision.RequiredChallenges.Count);
        var providerPayloads = new Dictionary<string, IReadOnlyDictionary<string, string>>(StringComparer.Ordinal);
        foreach (string rawKind in request.Decision.RequiredChallenges)
        {
            string kind = NormalizeKind(rawKind);
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

            SecurityChallengeProviderIssueResult providerResult;
            try
            {
                providerResult = await provider.IssueAsync(
                    new SecurityChallengeProviderIssueRequest(
                        request.Context,
                        kind,
                        request.Decision.ActionName,
                        request.Decision.RouteKey,
                        NormalizeRequired(request.TenantId, nameof(request.TenantId), 64),
                        NormalizeHash(request.SubjectHash, nameof(request.SubjectHash)),
                        NormalizeHash(request.ClientIpHash, nameof(request.ClientIpHash)),
                        NormalizeHash(request.DeviceFpHash, nameof(request.DeviceFpHash)),
                        request.Decision.PolicyVersion,
                        request.Decision.EscalationLevel,
                        NormalizeRequired(request.Traceparent, nameof(request.Traceparent), 128))
                    {
                        RiskScore = request.Decision.RiskScore,
                        EffectiveRiskScore = request.Decision.EffectiveRiskScore,
                        GeneratorDistributionPolicy = request.Decision.PerceptionGeneratorPolicy
                    },
                    cancellationToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                RecordChallengeFailure("issue", kind, request.Decision.ActionName, request.Decision.PolicyVersion, "provider_exception", ex);
                await RecordRiskAsync(request.Context, request.Decision.ActionName, $"provider_exception:{kind}", cancellationToken);
                return SecurityChallengeOrchestrationIssueResult.Failed("provider_exception");
            }

            if (!providerResult.Succeeded || providerResult.Assignment is null)
            {
                string reason = providerResult.Reason;
                RecordChallengeFailure("issue", kind, request.Decision.ActionName, request.Decision.PolicyVersion, reason);
                await RecordRiskAsync(request.Context, request.Decision.ActionName, $"provider_failure:{kind}:{reason}", cancellationToken);
                return SecurityChallengeOrchestrationIssueResult.Failed(reason);
            }

            SecurityChallengeValidationResult validation = ValidateProviderAssignment(providerResult.Assignment, kind);
            if (!validation.IsValid)
            {
                RecordChallengeFailure("issue", kind, request.Decision.ActionName, request.Decision.PolicyVersion, validation.ErrorCode);
                await RecordRiskAsync(request.Context, request.Decision.ActionName, $"provider_assignment_invalid:{kind}:{validation.ErrorCode}", cancellationToken);
                return SecurityChallengeOrchestrationIssueResult.Failed(validation.ErrorCode);
            }

            assignments.Add(providerResult.Assignment);
            if (providerResult.ProviderPayload.Count > 0)
            {
                providerPayloads[providerResult.Assignment.ChallengeId] = providerResult.ProviderPayload;
            }
        }

        var envelope = new SecurityChallengeEnvelope(
            SecurityChallengeContracts.CreateChallengeId(),
            NormalizeRequired(request.Decision.PolicyVersion, nameof(request.Decision.PolicyVersion), 64),
            assignments);
        if (logger is not null)
        {
            LogChallengeIssueSucceeded(logger, request.Decision.ActionName, assignments.Count, request.Decision.PolicyVersion);
        }

        return SecurityChallengeOrchestrationIssueResult.Success(envelope, providerPayloads);
    }

    public async Task<SecurityChallengeOrchestrationVerifyResult> VerifyAsync(SecurityChallengeOrchestrationVerifyRequest request, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        cancellationToken.ThrowIfCancellationRequested();

        string kind = NormalizeKind(request.Kind);
        if (!_providers.TryGetValue(kind, out ISecurityChallengeProvider? provider))
        {
            RecordChallengeFailure("verify", kind, request.Action, request.PolicyVersion, "provider_missing");
            await RecordRiskAsync(request.Context, request.Action, $"provider_missing:{kind}", cancellationToken);
            return SecurityChallengeOrchestrationVerifyResult.Failed("provider_missing");
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
                    NormalizeHash(request.DeviceFpHash, nameof(request.DeviceFpHash)),
                    NormalizeRequired(request.PolicyVersion, nameof(request.PolicyVersion), 64),
                    request.ProviderPayload),
                cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            RecordChallengeFailure("verify", kind, request.Action, request.PolicyVersion, "provider_exception", ex);
            await RecordRiskAsync(request.Context, request.Action, $"provider_exception:{kind}", cancellationToken);
            return SecurityChallengeOrchestrationVerifyResult.Failed("provider_exception");
        }

        if (!providerResult.Succeeded)
        {
            RecordChallengeFailure("verify", kind, request.Action, request.PolicyVersion, providerResult.Reason);
            await RecordRiskAsync(request.Context, request.Action, $"provider_verify_failed:{kind}:{providerResult.Reason}", cancellationToken);
            return SecurityChallengeOrchestrationVerifyResult.Failed(providerResult.Reason);
        }

        DateTimeOffset issuedAt = _timeProvider.GetUtcNow();
        DateTimeOffset expiresAt = providerResult.ProofExpiresAt is { } proofExpiresAt && proofExpiresAt > issuedAt
            ? proofExpiresAt
            : issuedAt.Add(s_defaultProofTtl);
        try
        {
            SecurityChallengeProofMintResult proof = await proofService.MintProofAsync(
                new SecurityChallengeProofMintRequest(
                    request.ChallengeId,
                    kind,
                    request.Action,
                    request.RouteKey,
                    request.SubjectHash,
                    request.ClientIpHash,
                    request.DeviceFpHash,
                    request.PolicyVersion,
                    issuedAt,
                    expiresAt),
                cancellationToken);
            if (logger is not null)
            {
                LogChallengeVerifySucceeded(logger, request.Action, kind, request.PolicyVersion);
            }

            return SecurityChallengeOrchestrationVerifyResult.Success(proof);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            RecordChallengeFailure("verify", kind, request.Action, request.PolicyVersion, "proof_mint_failed", ex);
            await RecordRiskAsync(request.Context, request.Action, $"proof_mint_failed:{kind}", cancellationToken);
            return SecurityChallengeOrchestrationVerifyResult.Failed("proof_mint_failed");
        }
    }

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
