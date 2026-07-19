using System.Globalization;

namespace FsusBlog.Server.Services.Security;

public enum AnonymousCommentScopeKind
{
    TopLevel = 1,
    ThreadReply = 2
}

public readonly record struct AnonymousCommentScopeDescriptor(
    int Version,
    int ArticleId,
    AnonymousCommentScopeKind Kind,
    long? RootId,
    int MaxUsesPerCredential);

/// <summary>
/// Server-authoritative anonymous comment scope contract. A policy change that
/// changes quota ownership must introduce a new version instead of reusing v1.
/// </summary>
public static class AnonymousCommentScopePolicy
{
    public const int CurrentVersion = 1;
    public const int TopLevelUsesPerCredential = 1;
    public const int ThreadReplyUsesPerCredential = 3;
    private const string Prefix = "comment:v1:article:";

    public static string CreateTopLevelScope(int articleId)
        => articleId > 0
            ? $"{Prefix}{articleId}:top"
            : throw new ArgumentOutOfRangeException(nameof(articleId));

    public static string CreateThreadScope(int articleId, long rootId)
        => articleId > 0 && rootId > 0
            ? $"{Prefix}{articleId}:thread:{rootId}"
            : throw new ArgumentOutOfRangeException(articleId <= 0 ? nameof(articleId) : nameof(rootId));

    public static bool TryParse(string? scope, out AnonymousCommentScopeDescriptor descriptor)
    {
        descriptor = default;
        if (string.IsNullOrWhiteSpace(scope) || !scope.StartsWith(Prefix, StringComparison.Ordinal))
        {
            return false;
        }

        ReadOnlySpan<char> remainder = scope.AsSpan(Prefix.Length);
        int separator = remainder.IndexOf(':');
        if (separator <= 0 ||
            !int.TryParse(remainder[..separator], NumberStyles.None, CultureInfo.InvariantCulture, out int articleId) ||
            articleId <= 0)
        {
            return false;
        }

        ReadOnlySpan<char> kind = remainder[(separator + 1)..];
        if (kind.SequenceEqual("top"))
        {
            descriptor = new AnonymousCommentScopeDescriptor(
                CurrentVersion,
                articleId,
                AnonymousCommentScopeKind.TopLevel,
                null,
                TopLevelUsesPerCredential);
            return true;
        }

        const string ThreadPrefix = "thread:";
        if (!kind.StartsWith(ThreadPrefix, StringComparison.Ordinal) ||
            !long.TryParse(kind[ThreadPrefix.Length..], NumberStyles.None, CultureInfo.InvariantCulture, out long rootId) ||
            rootId <= 0)
        {
            return false;
        }

        descriptor = new AnonymousCommentScopeDescriptor(
            CurrentVersion,
            articleId,
            AnonymousCommentScopeKind.ThreadReply,
            rootId,
            ThreadReplyUsesPerCredential);
        return true;
    }

    public static bool TryCreateTicketScope(
        int articleId,
        long? parentId,
        long? rootId,
        long? replyToCommentId,
        out string scope)
    {
        scope = string.Empty;
        if (articleId <= 0 ||
            parentId is not null ||
            replyToCommentId is not null ||
            rootId is <= 0)
        {
            return false;
        }

        scope = rootId is > 0
            ? CreateThreadScope(articleId, rootId.Value)
            : CreateTopLevelScope(articleId);
        return true;
    }
}
