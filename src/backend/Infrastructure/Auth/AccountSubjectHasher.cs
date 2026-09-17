using System.Globalization;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Helpers;

namespace FsusBlog.Server.Infrastructure.Auth;

/// <summary>Derives stable, non-reversible account subject identifiers used by claims and cache boundaries.</summary>
public static class AccountSubjectHasher
{
    public const string ClaimType = "account_subject_hash";

    private const string HashPrefix = "fsus:account-subject:v1";
    private const string CacheKeyPrefix = "account:";

    /// <summary>Derives the subject hash from the strongest stable identity material available on an account.</summary>
    public static string Create(User user)
    {
        string identityKind = TextHelpers.TrimOrNull(user.IdentityKind) ?? AnonymousIdentityRuntime.AnonymousAccountKind;
        string? subject = TextHelpers.LowerTrimmed(user.PasskeyUserHandle)
            ?? TextHelpers.LowerTrimmed(user.PublicHandle);
        return Create(identityKind, subject ?? string.Concat("anonymous-account:", user.Id.ToString(CultureInfo.InvariantCulture)));
    }

    /// <summary>Hashes a normalized identity kind and subject using the versioned account-subject domain separator.</summary>
    public static string Create(string identityKind, string subject)
    {
        string normalizedKind = TextHelpers.TrimOrNull(identityKind) ?? AnonymousIdentityRuntime.AnonymousAccountKind;
        string normalizedSubject = TextHelpers.LowerTrimmed(subject) ?? string.Empty;
        byte[] bytes = SHA256.HashData(Encoding.UTF8.GetBytes(
            string.Concat(HashPrefix, ':', normalizedKind, ':', normalizedSubject)));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    /// <summary>Builds the namespaced cache key for a previously validated account subject hash.</summary>
    public static string BuildCacheKey(string accountSubjectHash)
        => string.Concat(CacheKeyPrefix, TextHelpers.LowerTrimmed(accountSubjectHash) ?? string.Empty);
}
