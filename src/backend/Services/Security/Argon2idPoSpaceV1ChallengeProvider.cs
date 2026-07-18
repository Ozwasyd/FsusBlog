using System.Globalization;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Models.Security;
using FsusBlog.Shared.Contracts.Security;
using Konscious.Security.Cryptography;

namespace FsusBlog.Server.Services.Security;

public sealed class Argon2idPoSpaceV1ChallengeProvider(
    IUnifiedCache cache,
    ISecurityChallengePersistenceService persistence,
    ISecurityRiskSignalSink riskSignalSink,
    IConfiguration configuration,
    TimeProvider timeProvider) : ISecurityChallengeProvider
{
    public const string WireKind = "argon2idPoSpaceV1";
    public const string Algorithm = "fsu.pospace/argon2id@v1";

    private const int ChallengeTtlSeconds = 300;
    private const int SaltBytes = 16;
    private const int NonceBytes = 16;
    private const int ProofBytes = 32;
    private const int MinMemoryKib = 19_456;
    private const int MaxMemoryKib = 65_536;
    private const int MobileMaxMemoryKib = 8192;
    private const int MinIterations = 2;
    private const int MaxIterations = 6;
    private const int MinLanes = 1;
    private const int MaxLanes = 4;
    private const int MinTargetDurationMs = 100;
    private const int MaxTargetDurationMs = 5000;
    private static readonly TimeSpan RiskSignalTtl = TimeSpan.FromMinutes(10);

    public string Kind => WireKind;

    public async Task<SecurityChallengeProviderIssueResult> IssueAsync(SecurityChallengeProviderIssueRequest request, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        cancellationToken.ThrowIfCancellationRequested();

        PoSpaceOptions options = ResolveOptions(configuration);
        if (!SecuritySystemModes.IsEnforcing(options.Mode))
        {
            return SecurityChallengeProviderIssueResult.Failed("pospace_disabled");
        }

        if (!IsValidOptions(options))
        {
            return SecurityChallengeProviderIssueResult.Failed("pospace_parameters_invalid");
        }

        if (IsMobileUserAgent(request.Context.Request.Headers.UserAgent.ToString()) && options.MemoryKib > MobileMaxMemoryKib)
        {
            return SecurityChallengeProviderIssueResult.Failed("pospace_mobile_memory_limit");
        }

        DateTimeOffset issuedAt = timeProvider.GetUtcNow();
        DateTimeOffset expiresAt = issuedAt.AddSeconds(ChallengeTtlSeconds);
        string challengeId = SecurityChallengeContracts.CreateChallengeId();
        var payload = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["algorithm"] = Algorithm,
            ["saltHex"] = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(SaltBytes)),
            ["memoryKib"] = options.MemoryKib.ToString(CultureInfo.InvariantCulture),
            ["iterations"] = options.Iterations.ToString(CultureInfo.InvariantCulture),
            ["lanes"] = options.Lanes.ToString(CultureInfo.InvariantCulture),
            ["targetDurationMs"] = options.TargetDurationMs.ToString(CultureInfo.InvariantCulture)
        };
        string payloadHash = HashPayload(payload);

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
                payloadHash,
                request.Context.TraceIdentifier,
                request.Traceparent,
                issuedAt.UtcDateTime,
                expiresAt.UtcDateTime),
            cancellationToken);
        await cache.SetStringAsync(
            CachePolicyId.SecurityPoSpaceChallenge,
            challengeId,
            payloadHash,
            expiresAt - issuedAt,
            cancellationToken);

        var assignment = new SecurityChallengeAssignment(
            challengeId,
            request.Traceparent,
            request.TenantId,
            SecurityChallengeKind.Argon2IdPoSpaceV1,
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

        if (!TryParseVerifyPayload(request.ProviderPayload, out PoSpaceVerifyPayload payload))
        {
            await RecordRejectedAsync(request, SecurityChallengeAttemptOutcomes.Failed, "pospace_payload_invalid", "PoSpaceInvalid", null, cancellationToken);
            return SecurityChallengeProviderVerifyResult.Failed("pospace_payload_invalid");
        }

        bool consumed = await cache.ConsumeOnceAsync(CachePolicyId.SecurityPoSpaceChallenge, request.ChallengeId, cancellationToken);
        if (!consumed)
        {
            await RecordRejectedAsync(request, SecurityChallengeAttemptOutcomes.Replayed, "pospace_replayed", "PoSpaceReplay", payload.ProofHex, cancellationToken);
            return SecurityChallengeProviderVerifyResult.Failed("pospace_replayed");
        }

        string expectedProofHex = await ComputeProofHexAsync(request, payload.NonceHex, cancellationToken);
        if (!CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(payload.ProofHex),
                Encoding.ASCII.GetBytes(expectedProofHex)))
        {
            await RecordRejectedAsync(request, SecurityChallengeAttemptOutcomes.Failed, "pospace_proof_invalid", "PoSpaceInvalid", payload.ProofHex, cancellationToken);
            return SecurityChallengeProviderVerifyResult.Failed("pospace_proof_invalid");
        }

        await RecordAttemptAsync(request, SecurityChallengeAttemptOutcomes.Verified, "ok", payload.ProofHex, cancellationToken);
        return SecurityChallengeProviderVerifyResult.Success(timeProvider.GetUtcNow().AddSeconds(ChallengeTtlSeconds));
    }

    internal static Task<string> ComputeProofHexAsync(
        SecurityChallengeProviderVerifyRequest request,
        string nonceHex,
        CancellationToken cancellationToken)
    {
        if (!TryParseChallengeParameters(request.ProviderPayload, out PoSpaceChallengeParameters parameters)
            || !IsHex(nonceHex, NonceBytes))
        {
            throw new InvalidOperationException("PoSpace proof parameters are invalid.");
        }

        byte[] salt = Convert.FromHexString(parameters.SaltHex);
        byte[] material = Encoding.UTF8.GetBytes(string.Join('\n',
            "fsu.pospace.argon2id.v1",
            request.ChallengeId,
            request.Action,
            request.RouteKey,
            request.SubjectHash,
            request.ClientIpHash,
            request.DeviceFpHash,
            request.PolicyVersion,
            nonceHex,
            parameters.TargetDurationMs.ToString(CultureInfo.InvariantCulture)));

        return Task.Run(() =>
        {
            var argon = new Argon2id(material)
            {
                Salt = salt,
                MemorySize = parameters.MemoryKib,
                Iterations = parameters.Iterations,
                DegreeOfParallelism = parameters.Lanes
            };
            return Convert.ToHexStringLower(argon.GetBytes(ProofBytes));
        }, cancellationToken);
    }

    private static bool TryParseVerifyPayload(IReadOnlyDictionary<string, string> payload, out PoSpaceVerifyPayload parsed)
    {
        parsed = default;
        if (!TryParseChallengeParameters(payload, out PoSpaceChallengeParameters parameters)
            || !payload.TryGetValue("nonceHex", out string? nonceHex)
            || !payload.TryGetValue("proofHex", out string? proofHex)
            || !IsHex(nonceHex, NonceBytes)
            || !IsHex(proofHex, ProofBytes))
        {
            return false;
        }

        parsed = new PoSpaceVerifyPayload(
            parameters.SaltHex,
            parameters.MemoryKib,
            parameters.Iterations,
            parameters.Lanes,
            parameters.TargetDurationMs,
            TextHelpers.LowerTrimmed(nonceHex) ?? string.Empty,
            TextHelpers.LowerTrimmed(proofHex) ?? string.Empty);
        return true;
    }

    private static bool TryParseChallengeParameters(IReadOnlyDictionary<string, string> payload, out PoSpaceChallengeParameters parsed)
    {
        parsed = default;
        if (payload.TryGetValue("algorithm", out string? algorithm)
            && !string.Equals(algorithm, Algorithm, StringComparison.Ordinal))
        {
            return false;
        }

        if (!payload.TryGetValue("saltHex", out string? saltHex)
            || !payload.TryGetValue("memoryKib", out string? memoryValue)
            || !payload.TryGetValue("iterations", out string? iterationsValue)
            || !payload.TryGetValue("lanes", out string? lanesValue)
            || !payload.TryGetValue("targetDurationMs", out string? targetDurationValue)
            || !IsHex(saltHex, SaltBytes)
            || !int.TryParse(memoryValue, NumberStyles.None, CultureInfo.InvariantCulture, out int memoryKib)
            || !int.TryParse(iterationsValue, NumberStyles.None, CultureInfo.InvariantCulture, out int iterations)
            || !int.TryParse(lanesValue, NumberStyles.None, CultureInfo.InvariantCulture, out int lanes)
            || !int.TryParse(targetDurationValue, NumberStyles.None, CultureInfo.InvariantCulture, out int targetDurationMs))
        {
            return false;
        }

        var options = new PoSpaceOptions(SecuritySystemModes.Enforce, memoryKib, iterations, lanes, targetDurationMs);
        if (!IsValidOptions(options))
        {
            return false;
        }

        parsed = new PoSpaceChallengeParameters(
            TextHelpers.LowerTrimmed(saltHex) ?? string.Empty,
            memoryKib,
            iterations,
            lanes,
            targetDurationMs);
        return true;
    }

    private async Task RecordRejectedAsync(
        SecurityChallengeProviderVerifyRequest request,
        string outcome,
        string reason,
        string riskDetail,
        string? proofHex,
        CancellationToken cancellationToken)
    {
        await RecordAttemptAsync(request, outcome, reason, proofHex, cancellationToken);
        await riskSignalSink.AddRiskAsync(
            new SecurityRiskSignal(
                request.Context,
                SecurityRiskReason.SecurityChallengeRejected,
                10,
                RiskSignalTtl,
                SecurityRiskSources.RiskControl,
                string.IsNullOrWhiteSpace(request.Action) ? "security_challenge" : request.Action,
                riskDetail),
            cancellationToken);
    }

    private Task RecordAttemptAsync(
        SecurityChallengeProviderVerifyRequest request,
        string outcome,
        string reason,
        string? proofHex,
        CancellationToken cancellationToken)
        => persistence.RecordAttemptAsync(
            new SecurityChallengeAttemptRequest(
                request.ChallengeId,
                outcome,
                reason,
                string.IsNullOrWhiteSpace(proofHex) ? null : HashValue(proofHex),
                request.ClientIpHash,
                request.DeviceFpHash,
                request.Context.TraceIdentifier,
                ResolveTraceparent(request.Context),
                timeProvider.GetUtcNow().UtcDateTime),
            cancellationToken);

    private static string? ResolveTraceparent(HttpContext context)
        => context.Request.Headers.TryGetValue("traceparent", out var values)
            ? values.ToString()
            : null;

    private static PoSpaceOptions ResolveOptions(IConfiguration source)
        => new(
            SecuritySystemModes.Normalize(source["Security:PoSpaceV1:Mode"]),
            ReadInt(source, "MemoryKib", 8192),
            ReadInt(source, "Iterations", 2),
            ReadInt(source, "Lanes", 1),
            ReadInt(source, "TargetDurationMs", 750));

    private static int ReadInt(IConfiguration source, string key, int fallback)
        => int.TryParse(source[$"Security:PoSpaceV1:{key}"], NumberStyles.None, CultureInfo.InvariantCulture, out int value)
            ? value
            : fallback;

    private static bool IsValidOptions(PoSpaceOptions options)
        => options.MemoryKib is >= MinMemoryKib and <= MaxMemoryKib
            && options.Iterations is >= MinIterations and <= MaxIterations
            && options.Lanes is >= MinLanes and <= MaxLanes
            && options.TargetDurationMs is >= MinTargetDurationMs and <= MaxTargetDurationMs;

    private static bool IsMobileUserAgent(string userAgent)
    {
        string value = userAgent ?? string.Empty;
        return value.Contains("Android", StringComparison.OrdinalIgnoreCase)
            || value.Contains("iPhone", StringComparison.OrdinalIgnoreCase)
            || value.Contains("iPad", StringComparison.OrdinalIgnoreCase)
            || value.Contains("Mobile", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsHex(string? value, int expectedBytes)
    {
        string normalized = (value ?? string.Empty).Trim();
        if (normalized.Length != expectedBytes * 2)
        {
            return false;
        }

        for (int i = 0; i < normalized.Length; i++)
        {
            char ch = normalized[i];
            if (!((ch >= '0' && ch <= '9') ||
                  (ch >= 'a' && ch <= 'f') ||
                  (ch >= 'A' && ch <= 'F')))
            {
                return false;
            }
        }

        return true;
    }

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

    private readonly record struct PoSpaceOptions(
        string Mode,
        int MemoryKib,
        int Iterations,
        int Lanes,
        int TargetDurationMs);

    private readonly record struct PoSpaceChallengeParameters(
        string SaltHex,
        int MemoryKib,
        int Iterations,
        int Lanes,
        int TargetDurationMs);

    private readonly record struct PoSpaceVerifyPayload(
        string SaltHex,
        int MemoryKib,
        int Iterations,
        int Lanes,
        int TargetDurationMs,
        string NonceHex,
        string ProofHex);
}
