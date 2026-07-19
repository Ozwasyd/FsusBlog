using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Services.Security;

namespace FsusBlog.Server.Infrastructure.NotificationStream;

internal interface INotificationStreamPreflightGrantService
{
    Task<string> MintAsync(SecurityChallengeProofClaims proof, CancellationToken cancellationToken);

    Task<NotificationStreamPreflightGrantConsumeResult> ConsumeAsync(
        string token,
        NotificationStreamPreflightGrantBinding binding,
        CancellationToken cancellationToken);
}

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
    IUnifiedCache cache,
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
        await cache.SetRawAsync(
            CachePolicyId.SecurityChallengeProof,
            Identity(token),
            JsonSerializer.SerializeToUtf8Bytes(claims, s_jsonOptions),
            expiresAt - now,
            cancellationToken);
        return token;
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

        CacheReadResult<NotificationStreamPreflightGrantClaims> cached = await cache.ConsumeOnceAndGetAsync(
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

        bool matches = FixedEquals(claims.Action, binding.Action)
            && FixedEquals(claims.RouteKey, binding.RouteKey)
            && FixedEquals(claims.SubjectHash, binding.SubjectHash)
            && FixedEquals(claims.ClientIpHash, binding.ClientIpHash)
            && FixedEquals(claims.DeviceFpHash, binding.DeviceFpHash)
            && FixedEquals(claims.PolicyVersion, binding.PolicyVersion);
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

    private static bool FixedEquals(string left, string right)
        => CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(left), Encoding.UTF8.GetBytes(right));
}
