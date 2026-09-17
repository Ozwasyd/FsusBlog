using FsusBlog.Server.Infrastructure.Pagination;

using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Services;

public enum CommentCursorPolicyKind
{
    Threads,
    Replies,
    UserComments
}

public interface ICommentCursorPolicyResolver
{
    CursorPolicy Resolve(CommentCursorPolicyKind kind, string? tenantId = null);
}

public static class CommentCursorPolicies
{
    public static readonly CursorPolicy Threads = new(10, 5, 50);
    public static readonly CursorPolicy Replies = new(20, 5, 100);
    public static readonly CursorPolicy UserComments = new(10, 5, 50);
}

public sealed class ConfigurationCommentCursorPolicyResolver(IConfiguration configuration) : ICommentCursorPolicyResolver
{
    private const string SectionName = "CommentCursorPolicies";
    private const string TenantSectionName = "CommentCursorPolicies:Tenants";

    public CursorPolicy Resolve(CommentCursorPolicyKind kind, string? tenantId = null)
    {
        CursorPolicy fallback = GetDefaultPolicy(kind);
        CursorPolicy configured = ReadPolicy($"{SectionName}:{kind}", fallback);
        string normalizedTenant = NormalizeTenantId(tenantId);
        return normalizedTenant.Length == 0
            ? configured
            : ReadPolicy($"{TenantSectionName}:{normalizedTenant}:{kind}", configured);
    }

    private CursorPolicy ReadPolicy(string sectionKey, CursorPolicy fallback)
    {
        int defaultLimit = ReadInt($"{sectionKey}:DefaultLimit", fallback.DefaultLimit);
        int minLimit = Math.Max(1, ReadInt($"{sectionKey}:MinLimit", fallback.MinLimit));
        int maxLimit = Math.Max(minLimit, ReadInt($"{sectionKey}:MaxLimit", fallback.MaxLimit));
        defaultLimit = Math.Clamp(defaultLimit, minLimit, maxLimit);
        return fallback with
        {
            DefaultLimit = defaultLimit,
            MinLimit = minLimit,
            MaxLimit = maxLimit
        };
    }

    private int ReadInt(string key, int fallback)
        => int.TryParse(configuration[key], out int value) ? value : fallback;

    private static CursorPolicy GetDefaultPolicy(CommentCursorPolicyKind kind)
        => kind switch
        {
            CommentCursorPolicyKind.Threads => CommentCursorPolicies.Threads,
            CommentCursorPolicyKind.Replies => CommentCursorPolicies.Replies,
            CommentCursorPolicyKind.UserComments => CommentCursorPolicies.UserComments,
            _ => CommentCursorPolicies.Threads
        };

    private static string NormalizeTenantId(string? value)
    {
        string normalized = (value ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            return string.Empty;
        }

        Span<char> buffer = normalized.Length <= 64
            ? stackalloc char[normalized.Length]
            : stackalloc char[64];
        int written = 0;
        foreach (char c in normalized)
        {
            if (written >= buffer.Length)
            {
                break;
            }

            if (char.IsLetterOrDigit(c) || c is '-' or '_')
            {
                buffer[written++] = char.ToLowerInvariant(c);
            }
        }

        return written == 0 ? string.Empty : new string(buffer[..written]);
    }
}
