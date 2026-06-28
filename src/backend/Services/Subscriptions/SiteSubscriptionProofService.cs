using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using FsusBlog.Server.Infrastructure.Cache;

namespace FsusBlog.Server.Services.Subscriptions;

public interface ISiteSubscriptionProofService
{
    Task<SiteSubscriptionUnsubscribeProofIssueResult> IssueUnsubscribeProofAsync(
        SiteSubscriptionUnsubscribeProofIssueRequest request,
        CancellationToken cancellationToken = default);

    Task<SiteSubscriptionUnsubscribeProofConsumeResult> ConsumeUnsubscribeProofAsync(
        SiteSubscriptionUnsubscribeProofConsumeRequest request,
        CancellationToken cancellationToken = default);

    Task<SiteSubscriptionUnsubscribeProofConsumeResult> ValidateUnsubscribeProofAsync(
        SiteSubscriptionUnsubscribeProofConsumeRequest request,
        CancellationToken cancellationToken = default);

    Task<SiteSubscriptionUnsubscribeProofConsumeResult> CommitUnsubscribeProofAsync(
        SiteSubscriptionUnsubscribeProofConsumeRequest request,
        CancellationToken cancellationToken = default);
}

public sealed record SiteSubscriptionUnsubscribeProofIssueRequest(
    string Email,
    string? Channel,
    TimeSpan Ttl);

public sealed record SiteSubscriptionUnsubscribeProofConsumeRequest(
    string ProofToken,
    string Email,
    string? Channel);

public sealed record SiteSubscriptionUnsubscribeProofIssueResult(
    string ProofToken,
    SiteSubscriptionUnsubscribeProofClaims Claims);

public sealed record SiteSubscriptionUnsubscribeProofConsumeResult(
    bool Accepted,
    string Reason,
    SiteSubscriptionUnsubscribeProofClaims? Claims)
{
    public static SiteSubscriptionUnsubscribeProofConsumeResult Success(SiteSubscriptionUnsubscribeProofClaims claims)
        => new(true, "ok", claims);

    public static SiteSubscriptionUnsubscribeProofConsumeResult Rejected(string reason, SiteSubscriptionUnsubscribeProofClaims? claims = null)
        => new(false, reason, claims);
}

public sealed record SiteSubscriptionUnsubscribeProofClaims(
    string EmailHash,
    string Channel,
    DateTimeOffset IssuedAt,
    DateTimeOffset ExpiresAt,
    string Nonce);

public sealed class SiteSubscriptionProofService(
    IUnifiedCache cache,
    TimeProvider timeProvider) : ISiteSubscriptionProofService
{
    public const string HeaderName = "X-Fsus-Subscription-Proof";

    private const int ProofTokenRandomBytes = 32;
    private const int NonceRandomBytes = 16;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    public async Task<SiteSubscriptionUnsubscribeProofIssueResult> IssueUnsubscribeProofAsync(
        SiteSubscriptionUnsubscribeProofIssueRequest request,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (request.Ttl <= TimeSpan.Zero)
        {
            throw new ArgumentException("ttl must be positive", nameof(request));
        }

        string emailHash = SiteSubscriptionIdentity.HashEmail(request.Email);
        if (emailHash.Length == 0)
        {
            throw new ArgumentException("email is invalid", nameof(request));
        }

        DateTimeOffset issuedAt = timeProvider.GetUtcNow();
        DateTimeOffset expiresAt = issuedAt.Add(request.Ttl);
        string proofToken = GenerateProofToken();
        var claims = new SiteSubscriptionUnsubscribeProofClaims(
            emailHash,
            SiteSubscriptionIdentity.NormalizeChannel(request.Channel),
            issuedAt,
            expiresAt,
            GenerateNonce());

        byte[] payload = JsonSerializer.SerializeToUtf8Bytes(claims, JsonOptions);
        await cache.SetRawAsync(
            CachePolicyId.SiteSubscriptionUnsubscribeProof,
            BuildProofIdentity(proofToken),
            payload,
            request.Ttl,
            cancellationToken);

        return new SiteSubscriptionUnsubscribeProofIssueResult(proofToken, claims);
    }

    public async Task<SiteSubscriptionUnsubscribeProofConsumeResult> ConsumeUnsubscribeProofAsync(
        SiteSubscriptionUnsubscribeProofConsumeRequest request,
        CancellationToken cancellationToken = default)
    {
        SiteSubscriptionUnsubscribeProofConsumeResult validated = await ValidateUnsubscribeProofAsync(request, cancellationToken);
        return !validated.Accepted
            ? validated
            : await CommitUnsubscribeProofAsync(request, cancellationToken);
    }

    public async Task<SiteSubscriptionUnsubscribeProofConsumeResult> ValidateUnsubscribeProofAsync(
        SiteSubscriptionUnsubscribeProofConsumeRequest request,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string emailHash = SiteSubscriptionIdentity.HashEmail(request.Email);
        if (emailHash.Length == 0)
        {
            return SiteSubscriptionUnsubscribeProofConsumeResult.Rejected("email_invalid");
        }

        string proofToken = (request.ProofToken ?? string.Empty).Trim();
        if (proofToken.Length == 0 || proofToken.Length > 256)
        {
            return SiteSubscriptionUnsubscribeProofConsumeResult.Rejected("proof_replayed_or_missing");
        }

        CacheReadResult<SiteSubscriptionUnsubscribeProofClaims> cached = await cache.TryGetAsync(
            CachePolicyId.SiteSubscriptionUnsubscribeProof,
            BuildProofIdentity(proofToken),
            DecodeClaims,
            cancellationToken);

        if (!cached.Hit || cached.Value is null)
        {
            return SiteSubscriptionUnsubscribeProofConsumeResult.Rejected("proof_replayed_or_missing");
        }

        SiteSubscriptionUnsubscribeProofClaims claims = cached.Value;
        string? rejection = ValidateClaims(claims, emailHash, SiteSubscriptionIdentity.NormalizeChannel(request.Channel), timeProvider.GetUtcNow());
        return rejection is null
            ? SiteSubscriptionUnsubscribeProofConsumeResult.Success(claims)
            : SiteSubscriptionUnsubscribeProofConsumeResult.Rejected(rejection, claims);
    }

    public async Task<SiteSubscriptionUnsubscribeProofConsumeResult> CommitUnsubscribeProofAsync(
        SiteSubscriptionUnsubscribeProofConsumeRequest request,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string emailHash = SiteSubscriptionIdentity.HashEmail(request.Email);
        if (emailHash.Length == 0)
        {
            return SiteSubscriptionUnsubscribeProofConsumeResult.Rejected("email_invalid");
        }

        string proofToken = (request.ProofToken ?? string.Empty).Trim();
        if (proofToken.Length == 0 || proofToken.Length > 256)
        {
            return SiteSubscriptionUnsubscribeProofConsumeResult.Rejected("proof_replayed_or_missing");
        }

        CacheReadResult<SiteSubscriptionUnsubscribeProofClaims> cached = await cache.ConsumeOnceAndGetAsync(
            CachePolicyId.SiteSubscriptionUnsubscribeProof,
            BuildProofIdentity(proofToken),
            DecodeClaims,
            cancellationToken);

        if (!cached.Hit || cached.Value is null)
        {
            return SiteSubscriptionUnsubscribeProofConsumeResult.Rejected("proof_replayed_or_missing");
        }

        SiteSubscriptionUnsubscribeProofClaims claims = cached.Value;
        string? rejection = ValidateClaims(claims, emailHash, SiteSubscriptionIdentity.NormalizeChannel(request.Channel), timeProvider.GetUtcNow());
        return rejection is null
            ? SiteSubscriptionUnsubscribeProofConsumeResult.Success(claims)
            : SiteSubscriptionUnsubscribeProofConsumeResult.Rejected(rejection, claims);
    }

    private static (bool Success, SiteSubscriptionUnsubscribeProofClaims? Value) DecodeClaims(ReadOnlyMemory<byte> payload)
    {
        try
        {
            SiteSubscriptionUnsubscribeProofClaims? claims = JsonSerializer.Deserialize<SiteSubscriptionUnsubscribeProofClaims>(payload.Span, JsonOptions);
            return claims is null ? (false, null) : (true, claims);
        }
        catch (JsonException)
        {
            return (false, null);
        }
    }

    private static string? ValidateClaims(
        SiteSubscriptionUnsubscribeProofClaims claims,
        string emailHash,
        string channel,
        DateTimeOffset now)
    {
        if (claims.ExpiresAt <= now)
        {
            return "proof_expired";
        }

        if (!FixedEquals(claims.EmailHash, emailHash))
        {
            return "email_hash_mismatch";
        }

        if (!FixedEquals(claims.Channel, channel))
        {
            return "channel_mismatch";
        }

        return null;
    }

    private static string BuildProofIdentity(string proofToken)
        => string.Concat("v1:", HashProofToken(proofToken));

    private static string HashProofToken(string proofToken)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(proofToken))).ToLowerInvariant();

    private static string GenerateProofToken()
        => "fsu_unsub_" + Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(ProofTokenRandomBytes));

    private static string GenerateNonce()
        => Convert.ToHexString(RandomNumberGenerator.GetBytes(NonceRandomBytes)).ToLowerInvariant();

    private static bool FixedEquals(string left, string right)
    {
        byte[] leftBytes = Encoding.UTF8.GetBytes(left);
        byte[] rightBytes = Encoding.UTF8.GetBytes(right);
        return leftBytes.Length == rightBytes.Length && CryptographicOperations.FixedTimeEquals(leftBytes, rightBytes);
    }
}

internal static class SiteSubscriptionIdentity
{
    public static string HashEmail(string? email)
    {
        string normalized = email?.Trim().ToLowerInvariant() ?? string.Empty;
        if (normalized.Length < 5 || !normalized.Contains('@', StringComparison.Ordinal))
        {
            return string.Empty;
        }

        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(normalized)));
    }

    public static string NormalizeChannel(string? channel)
        => string.Equals(channel, "email", StringComparison.OrdinalIgnoreCase) ? "email" : "rss";
}
