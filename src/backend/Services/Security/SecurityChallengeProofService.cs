using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;

namespace FsusBlog.Server.Services.Security;

public interface ISecurityChallengeProofService
{
    Task<SecurityChallengeProofMintResult> MintProofAsync(SecurityChallengeProofMintRequest request, CancellationToken cancellationToken = default);

    Task<SecurityChallengeProofConsumeResult> ConsumeProofAsync(SecurityChallengeProofConsumeRequest request, CancellationToken cancellationToken = default);
}

public sealed record SecurityChallengeProofMintRequest(
    string ChallengeId,
    string Kind,
    string Action,
    string RouteKey,
    string SubjectHash,
    string ClientIpHash,
    string DeviceFpHash,
    string PolicyVersion,
    DateTimeOffset IssuedAt,
    DateTimeOffset ExpiresAt);

public sealed record SecurityChallengeProofConsumeRequest(
    string ProofToken,
    string ChallengeId,
    string Kind,
    string Action,
    string RouteKey,
    string SubjectHash,
    string ClientIpHash,
    string DeviceFpHash,
    string PolicyVersion);

public sealed record SecurityChallengeProofMintResult(
    string ProofToken,
    SecurityChallengeProofClaims Claims);

public sealed record SecurityChallengeProofConsumeResult(
    bool Accepted,
    string Reason,
    SecurityChallengeProofClaims? Claims)
{
    public static SecurityChallengeProofConsumeResult Success(SecurityChallengeProofClaims claims)
        => new(true, "ok", claims);

    public static SecurityChallengeProofConsumeResult Rejected(string reason, SecurityChallengeProofClaims? claims = null)
        => new(false, reason, claims);
}

public sealed record SecurityChallengeProofClaims(
    string ChallengeId,
    string Kind,
    string Action,
    string RouteKey,
    string SubjectHash,
    string ClientIpHash,
    string DeviceFpHash,
    DateTimeOffset IssuedAt,
    DateTimeOffset ExpiresAt,
    string Nonce,
    string PolicyVersion);

public sealed class SecurityChallengeProofService(
    IUnifiedCache cache,
    ISecurityChallengePersistenceService challengePersistence,
    TimeProvider timeProvider) : ISecurityChallengeProofService
{
    public const string HeaderName = "X-Fsus-Challenge-Proof";

    private const int ProofTokenRandomBytes = 32;
    private const int NonceRandomBytes = 16;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    public async Task<SecurityChallengeProofMintResult> MintProofAsync(SecurityChallengeProofMintRequest request, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        DateTimeOffset now = timeProvider.GetUtcNow();
        DateTimeOffset issuedAt = request.IssuedAt.ToUniversalTime();
        DateTimeOffset expiresAt = request.ExpiresAt.ToUniversalTime();
        if (expiresAt <= issuedAt)
        {
            throw new ArgumentException("expiresAt must be after issuedAt", nameof(request));
        }

        if (expiresAt <= now)
        {
            throw new ArgumentException("expiresAt must be in the future", nameof(request));
        }

        string proofToken = GenerateProofToken();
        var claims = new SecurityChallengeProofClaims(
            NormalizeRequired(request.ChallengeId, nameof(request.ChallengeId), 64),
            NormalizeRequired(request.Kind, nameof(request.Kind), 64),
            NormalizeRequired(request.Action, nameof(request.Action), 96),
            NormalizeRequired(request.RouteKey, nameof(request.RouteKey), 256),
            NormalizeHash(request.SubjectHash, nameof(request.SubjectHash)),
            NormalizeHash(request.ClientIpHash, nameof(request.ClientIpHash)),
            NormalizeHash(request.DeviceFpHash, nameof(request.DeviceFpHash)),
            issuedAt,
            expiresAt,
            GenerateNonce(),
            NormalizeRequired(request.PolicyVersion, nameof(request.PolicyVersion), 64));

        byte[] payload = JsonSerializer.SerializeToUtf8Bytes(claims, JsonOptions);
        await cache.SetRawAsync(
            CachePolicyId.SecurityChallengeProof,
            BuildProofIdentity(proofToken),
            payload,
            expiresAt - now,
            cancellationToken);

        return new SecurityChallengeProofMintResult(proofToken, claims);
    }

    public async Task<SecurityChallengeProofConsumeResult> ConsumeProofAsync(SecurityChallengeProofConsumeRequest request, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string proofToken = NormalizeRequired(request.ProofToken, nameof(request.ProofToken), 256);
        string proofHash = HashProofToken(proofToken);
        CacheReadResult<SecurityChallengeProofClaims> cached = await cache.ConsumeOnceAndGetAsync(
            CachePolicyId.SecurityChallengeProof,
            BuildProofIdentity(proofToken),
            DecodeClaims,
            cancellationToken);

        if (!cached.Hit || cached.Value is null)
        {
            await RecordAttemptAsync(request.ChallengeId, SecurityChallengeAttemptOutcomes.Replayed, "proof_replayed_or_missing", proofHash, request, cancellationToken);
            return SecurityChallengeProofConsumeResult.Rejected("proof_replayed_or_missing");
        }

        SecurityChallengeProofClaims claims = cached.Value;
        string? rejection = ValidateClaims(claims, request, timeProvider.GetUtcNow());
        if (rejection is not null)
        {
            string outcome = string.Equals(rejection, "proof_expired", StringComparison.Ordinal)
                ? SecurityChallengeAttemptOutcomes.Expired
                : SecurityChallengeAttemptOutcomes.Failed;
            await RecordAttemptAsync(claims.ChallengeId, outcome, rejection, proofHash, request, cancellationToken);
            return SecurityChallengeProofConsumeResult.Rejected(rejection, claims);
        }

        await RecordAttemptAsync(claims.ChallengeId, SecurityChallengeAttemptOutcomes.Verified, "ok", proofHash, request, cancellationToken);
        return SecurityChallengeProofConsumeResult.Success(claims);
    }

    private static (bool Success, SecurityChallengeProofClaims? Value) DecodeClaims(ReadOnlyMemory<byte> payload)
    {
        try
        {
            SecurityChallengeProofClaims? claims = JsonSerializer.Deserialize<SecurityChallengeProofClaims>(payload.Span, JsonOptions);
            return claims is null ? (false, null) : (true, claims);
        }
        catch (JsonException)
        {
            return (false, null);
        }
    }

    private static string? ValidateClaims(
        SecurityChallengeProofClaims claims,
        SecurityChallengeProofConsumeRequest request,
        DateTimeOffset now)
    {
        if (claims.ExpiresAt <= now)
        {
            return "proof_expired";
        }

        if (!FixedEquals(claims.ChallengeId, request.ChallengeId))
        {
            return "challenge_id_mismatch";
        }

        if (!FixedEquals(claims.Kind, request.Kind))
        {
            return "kind_mismatch";
        }

        if (!FixedEquals(claims.Action, request.Action))
        {
            return "action_mismatch";
        }

        if (!FixedEquals(claims.RouteKey, request.RouteKey))
        {
            return "route_key_mismatch";
        }

        if (!FixedEquals(claims.SubjectHash, NormalizeHash(request.SubjectHash, nameof(request.SubjectHash))))
        {
            return "subject_hash_mismatch";
        }

        if (!FixedEquals(claims.ClientIpHash, NormalizeHash(request.ClientIpHash, nameof(request.ClientIpHash))))
        {
            return "client_ip_hash_mismatch";
        }

        if (!FixedEquals(claims.DeviceFpHash, NormalizeHash(request.DeviceFpHash, nameof(request.DeviceFpHash))))
        {
            return "device_fp_hash_mismatch";
        }

        if (!FixedEquals(claims.PolicyVersion, request.PolicyVersion))
        {
            return "policy_version_mismatch";
        }

        return null;
    }

    private async Task RecordAttemptAsync(
        string challengeId,
        string outcome,
        string reason,
        string proofHash,
        SecurityChallengeProofConsumeRequest request,
        CancellationToken cancellationToken)
    {
        await challengePersistence.RecordAttemptAsync(
            new SecurityChallengeAttemptRequest(
                NormalizeRequired(challengeId, nameof(challengeId), 64),
                outcome,
                reason,
                proofHash,
                NormalizeHash(request.ClientIpHash, nameof(request.ClientIpHash)),
                NormalizeHash(request.DeviceFpHash, nameof(request.DeviceFpHash)),
                TraceId: null,
                Traceparent: null,
                DateTime.UtcNow),
            cancellationToken);
    }

    private static string BuildProofIdentity(string proofToken)
        => string.Concat("v1:", HashProofToken(proofToken));

    private static string HashProofToken(string proofToken)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(proofToken))).ToLowerInvariant();

    private static string GenerateProofToken()
        => "fcp_" + Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(ProofTokenRandomBytes));

    private static string GenerateNonce()
        => Convert.ToHexString(RandomNumberGenerator.GetBytes(NonceRandomBytes)).ToLowerInvariant();

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

    private static bool FixedEquals(string left, string right)
    {
        byte[] leftBytes = Encoding.UTF8.GetBytes(left);
        byte[] rightBytes = Encoding.UTF8.GetBytes(right);
        return leftBytes.Length == rightBytes.Length && CryptographicOperations.FixedTimeEquals(leftBytes, rightBytes);
    }
}
