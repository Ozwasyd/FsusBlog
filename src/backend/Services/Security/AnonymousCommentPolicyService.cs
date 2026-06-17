using FsusBlog.Server.Models.CommentIdentity;

namespace FsusBlog.Server.Services.Security;

public interface IAnonymousCommentPolicyService
{
    AnonymousCommentPolicySnapshot Current { get; }

    AnonymousCommentPolicySnapshot UpdatePolicy(AnonymousCommentPolicyUpdateRequest request, long? adminPrincipalId = null);

    CommentAuthorModeDecision EvaluateAuthorMode(string? requestedAuthorMode, bool publicSendExplicitlySelected);
}

public sealed class AnonymousCommentPolicyService(IConfiguration configuration) : IAnonymousCommentPolicyService
{
    private readonly object _gate = new();
    private AnonymousCommentPolicySnapshot? _current;

    public AnonymousCommentPolicySnapshot Current
    {
        get
        {
            lock (_gate)
            {
                return _current ??= BuildInitialPolicy();
            }
        }
    }

    public AnonymousCommentPolicySnapshot UpdatePolicy(AnonymousCommentPolicyUpdateRequest request, long? adminPrincipalId = null)
    {
        lock (_gate)
        {
            AnonymousCommentPolicySnapshot current = Current;
            _current = new AnonymousCommentPolicySnapshot(
                request.AnonymousCommentsEnabled ?? current.AnonymousCommentsEnabled,
                request.PublicCommentsEnabled ?? current.PublicCommentsEnabled,
                request.ZkAnonymousEnabled ?? current.ZkAnonymousEnabled,
                NormalizeAuthorMode(request.DefaultAuthorMode, current.DefaultAuthorMode),
                NormalizeLanguages(request.SupportedDisplayLanguages, current.SupportedDisplayLanguages));
            return _current;
        }
    }

    public CommentAuthorModeDecision EvaluateAuthorMode(string? requestedAuthorMode, bool publicSendExplicitlySelected)
    {
        AnonymousCommentPolicySnapshot policy = Current;
        string mode = NormalizeAuthorMode(requestedAuthorMode, policy.DefaultAuthorMode);
        if (string.Equals(mode, CommentAuthorModes.Public, StringComparison.Ordinal))
        {
            if (!publicSendExplicitlySelected)
            {
                return CommentAuthorModeDecision.Reject(mode, "public_opt_in_required", "Public author mode requires explicit opt-in");
            }

            return policy.PublicCommentsEnabled
                ? CommentAuthorModeDecision.Allow(mode)
                : CommentAuthorModeDecision.Reject(mode, "public_comments_disabled", "Public comments are disabled");
        }

        if (string.Equals(mode, CommentAuthorModes.ZkAnonymous, StringComparison.Ordinal))
        {
            if (!policy.AnonymousCommentsEnabled)
            {
                return CommentAuthorModeDecision.Reject(mode, "anonymous_comments_disabled", "Anonymous comments are disabled");
            }

            return policy.ZkAnonymousEnabled
                ? CommentAuthorModeDecision.Allow(mode)
                : CommentAuthorModeDecision.Reject(mode, "zk_anonymous_disabled", "ZK anonymous comments are disabled");
        }

        if (IsAnonymousMode(mode) && !policy.AnonymousCommentsEnabled)
        {
            return CommentAuthorModeDecision.Reject(mode, "anonymous_comments_disabled", "Anonymous comments are disabled");
        }

        return CommentAuthorModeDecision.Allow(mode);
    }

    private AnonymousCommentPolicySnapshot BuildInitialPolicy()
        => new(
            configuration.GetValue("AnonymousIdentity:AnonymousCommentsEnabled", true),
            configuration.GetValue("AnonymousIdentity:PublicCommentsEnabled", true),
            configuration.GetValue("AnonymousIdentity:ZkAnonymousCommentsEnabled", false),
            NormalizeAuthorMode(configuration["AnonymousIdentity:DefaultAuthorMode"], CommentAuthorModes.Anonymous),
            NormalizeLanguages(
                configuration.GetSection("AnonymousIdentity:SupportedDisplayLanguages").Get<string[]>(),
                AnonymousCommentPolicySnapshot.DefaultDisplayLanguages));

    private static string NormalizeAuthorMode(string? value, string fallback)
    {
        string normalized = (value ?? string.Empty).Trim().ToLowerInvariant().Replace('-', '_');
        return normalized is CommentAuthorModes.Anonymous or
            CommentAuthorModes.Pseudonymous or
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

    private static bool IsAnonymousMode(string mode)
        => string.Equals(mode, CommentAuthorModes.Anonymous, StringComparison.Ordinal) ||
            string.Equals(mode, CommentAuthorModes.Pseudonymous, StringComparison.Ordinal);
}
