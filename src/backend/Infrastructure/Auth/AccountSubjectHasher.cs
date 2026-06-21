using System.Globalization;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.Server.Entities;

namespace FsusBlog.Server.Infrastructure.Auth;

public static class AccountSubjectHasher
{
    public const string ClaimType = "account_subject_hash";

    private const string HashPrefix = "fsus:account-subject:v1";
    private const string CacheKeyPrefix = "account:";

    public static string Create(User user)
    {
        string identityKind = string.IsNullOrWhiteSpace(user.IdentityKind)
            ? AnonymousIdentityRuntime.AnonymousAccountKind
            : user.IdentityKind.Trim();
        string? subject = NormalizeSubject(user.PasskeyUserHandle)
            ?? NormalizeSubject(user.PublicHandle);
        return Create(identityKind, subject ?? string.Concat("anonymous-account:", user.Id.ToString(CultureInfo.InvariantCulture)));
    }

    public static string Create(string identityKind, string subject)
    {
        string normalizedKind = string.IsNullOrWhiteSpace(identityKind)
            ? AnonymousIdentityRuntime.AnonymousAccountKind
            : identityKind.Trim();
        string normalizedSubject = NormalizeSubject(subject) ?? string.Empty;
        byte[] bytes = SHA256.HashData(Encoding.UTF8.GetBytes(
            string.Concat(HashPrefix, ':', normalizedKind, ':', normalizedSubject)));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    public static string FromPrincipalOrFallback(ClaimsPrincipal principal, int accountId)
    {
        string? claim = NormalizeSubject(principal.FindFirst(ClaimType)?.Value);
        if (claim is { Length: > 0 })
        {
            return claim;
        }

        string? identityKind = NormalizeSubject(principal.FindFirst("identity_kind")?.Value);
        return Create(
            identityKind ?? AnonymousIdentityRuntime.AnonymousAccountKind,
            string.Concat("anonymous-account:", accountId.ToString(CultureInfo.InvariantCulture)));
    }

    public static string BuildCacheKey(string accountSubjectHash)
        => string.Concat(CacheKeyPrefix, NormalizeSubject(accountSubjectHash) ?? string.Empty);

    private static string? NormalizeSubject(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        return value.Trim().ToLowerInvariant();
    }
}
