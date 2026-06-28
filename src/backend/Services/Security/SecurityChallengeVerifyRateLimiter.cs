using System.Security.Cryptography;
using System.Text;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Security;

namespace FsusBlog.Server.Services.Security;

public interface ISecurityChallengeVerifyRateLimiter
{
    Task<bool> TryAcquireAsync(
        HttpContext httpContext,
        string challengeId,
        string action,
        CancellationToken cancellationToken = default);
}

public sealed class SecurityChallengeVerifyRateLimiter(
    IUnifiedCache cache,
    IRiskControlContextFactory riskContextFactory,
    TimeProvider timeProvider) : ISecurityChallengeVerifyRateLimiter
{
    private const int MaxAttempts = 3;
    private const int MaxChallengeIdLength = 64;
    private const int MaxActionLength = 96;
    private static readonly TimeSpan CacheExpiry = TimeSpan.FromMinutes(2);

    public async Task<bool> TryAcquireAsync(
        HttpContext httpContext,
        string challengeId,
        string action,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(httpContext);
        cancellationToken.ThrowIfCancellationRequested();

        string identity = BuildIdentity(httpContext, challengeId, action);
        long count = await cache.IncrementWithExpiryAsync(
            CachePolicyId.SecurityChallengeVerifyRateLimit,
            identity,
            CacheExpiry,
            1,
            cancellationToken);

        return count <= MaxAttempts;
    }

    private string BuildIdentity(HttpContext httpContext, string challengeId, string action)
    {
        _ = timeProvider.GetUtcNow();
        RiskControlProofBinding binding = RiskControlProofBindingFactory.Create(riskContextFactory.Create(httpContext));
        string normalizedAction = NormalizeAction(action);
        string challengeHash = HashValue(string.Concat("challenge:", NormalizeRequired(challengeId, MaxChallengeIdLength)));

        return string.Join(
            ':',
            "verify",
            binding.ClientIpHash,
            binding.DeviceFpHash,
            normalizedAction,
            challengeHash);
    }

    private static string NormalizeRequired(string? value, int maxLength)
    {
        string normalized = (value ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            return "missing";
        }

        return normalized.Length <= maxLength ? normalized : normalized[..maxLength];
    }

    private static string NormalizeAction(string? value)
    {
        string normalized = NormalizeRequired(value, MaxActionLength).ToLowerInvariant();
        var builder = new StringBuilder(normalized.Length);
        for (int i = 0; i < normalized.Length; i++)
        {
            char c = normalized[i];
            builder.Append(c is ((>= 'a' and <= 'z') or (>= '0' and <= '9') or '.' or '_' or '-' or ':')
                ? c
                : '_');
        }

        return builder.ToString();
    }

    private static string HashValue(string value)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
}
