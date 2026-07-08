using System.Security.Cryptography;
using System.Text;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Dtos;

namespace FsusBlog.Server.Services.Security;

internal static class AnonymousCommentPolicySnapshotHash
{
    public static string Resolve(AnonymousCommentPolicySnapshot snapshot)
    {
        string normalized = NormalizeHash(snapshot.SnapshotHash);
        return normalized.Length > 0 ? normalized : Compute(snapshot);
    }

    public static string NormalizeHash(string? value)
    {
        string normalized = (value ?? string.Empty).Trim().ToLowerInvariant();
        if (normalized.Length != 64)
        {
            return string.Empty;
        }

        for (int i = 0; i < normalized.Length; i++)
        {
            if (!Uri.IsHexDigit(normalized[i]))
            {
                return string.Empty;
            }
        }

        return normalized;
    }

    public static string Compute(AnonymousCommentPolicySnapshot snapshot)
    {
        string payload = string.Join('|',
            snapshot.AnonymousCommentsEnabled ? "1" : "0",
            snapshot.PublicCommentsEnabled ? "1" : "0",
            snapshot.ZkAnonymousEnabled ? "1" : "0",
            NormalizeAuthorMode(snapshot.DefaultAuthorMode, CommentAuthorModes.Anonymous),
            CommentLimits.NormalizeMaxChars(snapshot.CommentMaxChars),
            CommentLimits.NormalizeMaxUtf8Bytes(snapshot.CommentMaxUtf8Bytes),
            string.Join(',', NormalizeLanguages(snapshot.SupportedDisplayLanguages, AnonymousCommentPolicySnapshot.DefaultDisplayLanguages)));
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(payload)));
    }

    private static string NormalizeAuthorMode(string? value, string fallback)
    {
        string normalized = (value ?? string.Empty).Trim().ToLowerInvariant().Replace('-', '_');
        return normalized is CommentAuthorModes.Anonymous or
            CommentAuthorModes.Public or
            CommentAuthorModes.ZkAnonymous
                ? normalized
                : fallback;
    }

    private static IReadOnlyList<string> NormalizeLanguages(IReadOnlyList<string>? values, IReadOnlyList<string> fallback)
    {
        string[] normalized = (values ?? [])
            .Select(static value => value.Trim())
            .Where(static value => string.Equals(value, "zh-CN", StringComparison.Ordinal) || string.Equals(value, "en", StringComparison.Ordinal))
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        return normalized.Length > 0 ? normalized : fallback;
    }
}
