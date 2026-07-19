using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Services.Security;

namespace FsusBlog.Server.Infrastructure.NotificationStream;

internal interface INotificationStreamPreflightGrantService
{
    Task<string> MintAsync(SecurityChallengeProofClaims proof, CancellationToken cancellationToken);

    NotificationStreamPreflightGrantExchange CreateExchangeTarget(
        string proofToken,
        SecurityChallengeProofClaims proof);

    Task<string?> TryResumeExchangeAsync(
        string proofToken,
        NotificationStreamPreflightGrantBinding binding,
        CancellationToken cancellationToken);

    Task<NotificationStreamPreflightGrantConsumeResult> ConsumeAsync(
        string token,
        NotificationStreamPreflightGrantBinding binding,
        CancellationToken cancellationToken);
}

internal sealed record NotificationStreamPreflightGrantExchange(
    string Token,
    string CacheIdentity,
    byte[] Payload,
    TimeSpan Ttl);

internal sealed record NotificationStreamPreflightGrantBinding(
    string Action,
    string RouteKey,
    string SubjectHash,
    string ClientIpHash,
    string DeviceFpHash,
    string PolicyVersion);

internal sealed record NotificationStreamPreflightGrantConsumeResult(bool Accepted, string Outcome)
{
    public static NotificationStreamPreflightGrantConsumeResult Success { get; } = new(true, SecurityChallengeProofOutcomes.Accepted);

    public static NotificationStreamPreflightGrantConsumeResult Reject(string outcome) => new(false, outcome);
}

internal sealed record NotificationStreamPreflightGrantClaims(
    string Action,
    string RouteKey,
    string SubjectHash,
    string ClientIpHash,
    string DeviceFpHash,
    string PolicyVersion,
    long ExpiresAtUnixMs);

internal sealed class NotificationStreamPreflightGrantService(
    ICacheRawWriter cacheWriter,
    ICacheRawReader cacheReader,
    ICacheOneTimeStore oneTimeStore,
    TimeProvider timeProvider) : INotificationStreamPreflightGrantService
{
    private static readonly TimeSpan s_maximumGrantTtl = TimeSpan.FromSeconds(30);
    private static readonly JsonSerializerOptions s_jsonOptions = new(JsonSerializerDefaults.Web);

    public async Task<string> MintAsync(SecurityChallengeProofClaims proof, CancellationToken cancellationToken)
    {
        DateTimeOffset now = timeProvider.GetUtcNow();
        DateTimeOffset expiresAt = proof.ExpiresAt < now.Add(s_maximumGrantTtl)
            ? proof.ExpiresAt
            : now.Add(s_maximumGrantTtl);
        if (expiresAt <= now)
        {
            throw new InvalidOperationException("notification_preflight_grant_expired");
        }

        string token = $"fnsg_{Base64Url(RandomNumberGenerator.GetBytes(32))}";
        var claims = new NotificationStreamPreflightGrantClaims(
            proof.Action,
            proof.RouteKey,
            proof.SubjectHash,
            proof.ClientIpHash,
            proof.DeviceFpHash,
            proof.PolicyVersion,
            expiresAt.ToUnixTimeMilliseconds());
        await cacheWriter.SetRawAsync(
            CachePolicyId.SecurityChallengeProof,
            Identity(token),
            JsonSerializer.SerializeToUtf8Bytes(claims, s_jsonOptions),
            expiresAt - now,
            cancellationToken);
        return token;
    }

    public NotificationStreamPreflightGrantExchange CreateExchangeTarget(
        string proofToken,
        SecurityChallengeProofClaims proof)
    {
        string normalizedProofToken = NormalizeProofToken(proofToken);
        DateTimeOffset now = timeProvider.GetUtcNow();
        DateTimeOffset expiresAt = proof.ExpiresAt < now.Add(s_maximumGrantTtl)
            ? proof.ExpiresAt
            : now.Add(s_maximumGrantTtl);
        if (expiresAt <= now)
        {
            throw new InvalidOperationException("notification_preflight_grant_expired");
        }

        string token = DeterministicToken(normalizedProofToken);
        NotificationStreamPreflightGrantClaims claims = CreateClaims(proof, expiresAt);
        return new NotificationStreamPreflightGrantExchange(
            token,
            Identity(token),
            JsonSerializer.SerializeToUtf8Bytes(claims, s_jsonOptions),
            expiresAt - now);
    }

    public async Task<string?> TryResumeExchangeAsync(
        string proofToken,
        NotificationStreamPreflightGrantBinding binding,
        CancellationToken cancellationToken)
    {
        string token;
        try
        {
            token = DeterministicToken(NormalizeProofToken(proofToken));
        }
        catch (ArgumentException)
        {
            return null;
        }

        CacheReadResult<byte[]> cached = await cacheReader.TryGetRawAsync(
            CachePolicyId.SecurityChallengeProof,
            Identity(token),
            cancellationToken).ConfigureAwait(false);
        if (!cached.Hit || cached.Value is null)
        {
            return null;
        }

        var (decoded, claims) = Decode(cached.Value);
        if (!decoded || claims is null || claims.ExpiresAtUnixMs <= timeProvider.GetUtcNow().ToUnixTimeMilliseconds())
        {
            return null;
        }

        return Matches(claims, binding) ? token : null;
    }

    public async Task<NotificationStreamPreflightGrantConsumeResult> ConsumeAsync(
        string token,
        NotificationStreamPreflightGrantBinding binding,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(token) || token.Length > 256)
        {
            return NotificationStreamPreflightGrantConsumeResult.Reject(SecurityChallengeProofOutcomes.ReplayedOrMissing);
        }

        CacheReadResult<NotificationStreamPreflightGrantClaims> cached = await oneTimeStore.ConsumeOnceAndGetAsync(
            CachePolicyId.SecurityChallengeProof,
            Identity(token),
            Decode,
            cancellationToken);
        if (!cached.Hit || cached.Value is null)
        {
            return NotificationStreamPreflightGrantConsumeResult.Reject(SecurityChallengeProofOutcomes.ReplayedOrMissing);
        }

        NotificationStreamPreflightGrantClaims claims = cached.Value;
        if (claims.ExpiresAtUnixMs <= timeProvider.GetUtcNow().ToUnixTimeMilliseconds())
        {
            return NotificationStreamPreflightGrantConsumeResult.Reject(SecurityChallengeProofOutcomes.Expired);
        }

        bool matches = Matches(claims, binding);
        return matches
            ? NotificationStreamPreflightGrantConsumeResult.Success
            : NotificationStreamPreflightGrantConsumeResult.Reject(SecurityChallengeProofOutcomes.BindingMismatch);
    }

    private static (bool Success, NotificationStreamPreflightGrantClaims? Value) Decode(ReadOnlyMemory<byte> payload)
    {
        try
        {
            NotificationStreamPreflightGrantClaims? value = JsonSerializer.Deserialize<NotificationStreamPreflightGrantClaims>(payload.Span, s_jsonOptions);
            return value is null ? (false, null) : (true, value);
        }
        catch (JsonException)
        {
            return (false, null);
        }
    }

    private static string Identity(string token)
        => $"notification-preflight:{Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(token)))}";

    private static string Base64Url(byte[] value)
        => Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static NotificationStreamPreflightGrantClaims CreateClaims(
        SecurityChallengeProofClaims proof,
        DateTimeOffset expiresAt)
        => new(
            proof.Action,
            proof.RouteKey,
            proof.SubjectHash,
            proof.ClientIpHash,
            proof.DeviceFpHash,
            proof.PolicyVersion,
            expiresAt.ToUnixTimeMilliseconds());

    private static string NormalizeProofToken(string proofToken)
    {
        string normalized = (proofToken ?? string.Empty).Trim();
        if (normalized.Length is <= 0 or > 256)
        {
            throw new ArgumentException("Proof token is invalid.", nameof(proofToken));
        }

        return normalized;
    }

    private static string DeterministicToken(string proofToken)
    {
        byte[] digest = SHA256.HashData(Encoding.UTF8.GetBytes(string.Concat("notification-preflight-v1\0", proofToken)));
        return $"fnsg_{Base64Url(digest)}";
    }

    private static bool Matches(
        NotificationStreamPreflightGrantClaims claims,
        NotificationStreamPreflightGrantBinding binding)
        => FixedEquals(claims.Action, binding.Action)
            && FixedEquals(claims.RouteKey, binding.RouteKey)
            && FixedEquals(claims.SubjectHash, binding.SubjectHash)
            && FixedEquals(claims.ClientIpHash, binding.ClientIpHash)
            && FixedEquals(claims.DeviceFpHash, binding.DeviceFpHash)
            && FixedEquals(claims.PolicyVersion, binding.PolicyVersion);

    private static bool FixedEquals(string left, string right)
        => CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(left), Encoding.UTF8.GetBytes(right));
}
