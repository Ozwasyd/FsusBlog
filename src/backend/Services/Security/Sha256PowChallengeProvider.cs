using System.Globalization;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Shared.Contracts.Outputs;
using FsusBlog.Shared.Contracts.Security;

namespace FsusBlog.Server.Services.Security;

public sealed class Sha256PowChallengeProvider(
    IPowService powService,
    AdaptivePowGovernor governor,
    ISecurityChallengePersistenceService persistence,
    TimeProvider timeProvider) : ISecurityChallengeProvider
{
    public const string WireKind = "sha256PowV1";
    public const string Algorithm = "sha256-pow-v1";
    public const string ProofPayloadKey = "proof";

    private const int ChallengeTtlSeconds = 300;

    public string Kind => WireKind;

    public async Task<SecurityChallengeProviderIssueResult> IssueAsync(SecurityChallengeProviderIssueRequest request, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        cancellationToken.ThrowIfCancellationRequested();

        string challengeId = SecurityChallengeContracts.CreateChallengeId();
        string clientIp = request.Context.GetClientIp();
        string bindingContext = BuildPowBindingContext(
            challengeId,
            request.Action,
            request.RouteKey,
            request.SubjectHash,
            request.ClientIpHash,
            request.DeviceFpHash,
            request.PolicyVersion);
        PowChallenge challenge = await powService.GenerateChallengeAsync(clientIp, bindingContext);
        DateTimeOffset issuedAt = timeProvider.GetUtcNow();
        DateTimeOffset challengeIssuedAt = DateTimeOffset.FromUnixTimeSeconds(challenge.Timestamp);
        if (challengeIssuedAt > issuedAt.AddSeconds(5))
        {
            issuedAt = challengeIssuedAt;
        }

        DateTimeOffset expiresAt = challengeIssuedAt.AddSeconds(ChallengeTtlSeconds);
        if (expiresAt <= issuedAt)
        {
            expiresAt = issuedAt.AddSeconds(ChallengeTtlSeconds);
        }

        var payload = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["salt"] = challenge.Salt,
            ["difficulty"] = challenge.Difficulty.ToString(CultureInfo.InvariantCulture),
            ["timestamp"] = challenge.Timestamp.ToString(CultureInfo.InvariantCulture),
            ["signature"] = challenge.Signature
        };

        await persistence.IssueAsync(
            new SecurityChallengeIssueRequest(
                challengeId,
                WireKind,
                Algorithm,
                request.Action,
                request.RouteKey,
                request.SubjectHash,
                request.ClientIpHash,
                request.DeviceFpHash,
                request.PolicyVersion,
                HashPayload(payload),
                request.Context.TraceIdentifier,
                request.Traceparent,
                issuedAt.UtcDateTime,
                expiresAt.UtcDateTime),
            cancellationToken);

        var assignment = new SecurityChallengeAssignment(
            challengeId,
            request.Traceparent,
            request.TenantId,
            SecurityChallengeKind.Sha256PowV1,
            request.EscalationLevel,
            request.Action,
            request.RouteKey,
            request.SubjectHash,
            request.ClientIpHash,
            request.DeviceFpHash,
            issuedAt.ToUnixTimeMilliseconds(),
            expiresAt.ToUnixTimeMilliseconds());

        return SecurityChallengeProviderIssueResult.Success(assignment, payload);
    }

    public async Task<SecurityChallengeProviderVerifyResult> VerifyAsync(SecurityChallengeProviderVerifyRequest request, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        cancellationToken.ThrowIfCancellationRequested();

        if (!request.ProviderPayload.TryGetValue(ProofPayloadKey, out string? encodedProof)
            || !PowProofCodec.TryDecodeBase64Proof(encodedProof, out VirtualPowRequest proof))
        {
            await RecordAttemptAsync(request, SecurityChallengeAttemptOutcomes.Failed, "proof_invalid", encodedProof, cancellationToken);
            return SecurityChallengeProviderVerifyResult.Failed("proof_invalid");
        }

        string clientIp = request.Context.GetClientIp();
        int requiredDifficulty = await governor.GetDifficultyForIpAsync(clientIp);
        if (proof.Difficulty < requiredDifficulty)
        {
            await RecordAttemptAsync(request, SecurityChallengeAttemptOutcomes.Failed, "difficulty_insufficient", encodedProof, cancellationToken);
            return SecurityChallengeProviderVerifyResult.Failed("difficulty_insufficient");
        }

        string bindingContext = BuildPowBindingContext(
            request.ChallengeId,
            request.Action,
            request.RouteKey,
            request.SubjectHash,
            request.ClientIpHash,
            request.DeviceFpHash,
            request.PolicyVersion);
        bool verified = await powService.VerifyAsync(proof, clientIp, bindingContext);
        if (!verified)
        {
            await RecordAttemptAsync(request, SecurityChallengeAttemptOutcomes.Failed, "pow_verify_failed", encodedProof, cancellationToken);
            return SecurityChallengeProviderVerifyResult.Failed("pow_verify_failed");
        }

        await RecordAttemptAsync(request, SecurityChallengeAttemptOutcomes.Verified, "ok", encodedProof, cancellationToken);
        DateTimeOffset proofExpiresAt = DateTimeOffset.FromUnixTimeSeconds(proof.PowTimestamp).AddSeconds(ChallengeTtlSeconds);
        if (proofExpiresAt <= timeProvider.GetUtcNow())
        {
            proofExpiresAt = timeProvider.GetUtcNow().AddSeconds(ChallengeTtlSeconds);
        }

        return SecurityChallengeProviderVerifyResult.Success(proofExpiresAt);
    }

    private Task RecordAttemptAsync(
        SecurityChallengeProviderVerifyRequest request,
        string outcome,
        string reason,
        string? encodedProof,
        CancellationToken cancellationToken)
        => persistence.RecordAttemptAsync(
            new SecurityChallengeAttemptRequest(
                request.ChallengeId,
                outcome,
                reason,
                string.IsNullOrWhiteSpace(encodedProof) ? null : HashValue(encodedProof),
                request.ClientIpHash,
                request.DeviceFpHash,
                request.Context.TraceIdentifier,
                ResolveTraceparent(request.Context),
                DateTime.UtcNow),
            cancellationToken);

    private static string? ResolveTraceparent(HttpContext context)
        => context.Request.Headers.TryGetValue("traceparent", out var values)
            ? values.ToString()
            : null;

    private static string HashPayload(IReadOnlyDictionary<string, string> payload)
    {
        var builder = new StringBuilder();
        foreach (KeyValuePair<string, string> item in payload.OrderBy(static item => item.Key, StringComparer.Ordinal))
        {
            builder.Append(item.Key);
            builder.Append('\0');
            builder.Append(item.Value);
            builder.Append('\n');
        }

        return HashValue(builder.ToString());
    }

    private static string HashValue(string value)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    private static string BuildPowBindingContext(
        string challengeId,
        string action,
        string routeKey,
        string subjectHash,
        string clientIpHash,
        string deviceFpHash,
        string policyVersion)
    {
        var builder = new StringBuilder();
        builder.Append("challenge=").Append(challengeId).Append('\n');
        builder.Append("action=").Append(action).Append('\n');
        builder.Append("route=").Append(routeKey).Append('\n');
        builder.Append("subject=").Append(subjectHash).Append('\n');
        builder.Append("client=").Append(clientIpHash).Append('\n');
        builder.Append("device=").Append(deviceFpHash).Append('\n');
        builder.Append("policy=").Append(policyVersion);
        return "risk:" + HashValue(builder.ToString());
    }
}
