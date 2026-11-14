using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.V2.Core;

public enum ArticleAction { Save, Publish, Retract, Delete }
public enum Rejection { Invalid, NotFound, Conflict, Unauthorized, Forbidden }
public sealed class BusinessException(Rejection rejection, string message) : Exception(message)
{
    public Rejection Rejection { get; } = rejection;
}

public sealed record Identity(Guid Id, string Name, long Generation, bool CanAuthor, DateTimeOffset ExpiresAt);
public sealed record Edit(int Id, long ExpectedRevision, Guid Key, string Title, string Body);
public sealed record ArticleState(int Id, Guid Owner, long Revision, string Title, string Body, long? PublishedRevision, bool Deleted);

public static class Publishing
{
    private static readonly UTF8Encoding Utf8 = new(false, true);

    public static Edit Validate(ArticleAction action, Edit edit)
    {
        if (edit.Id < 0 || edit.ExpectedRevision < 0 || (edit.Id == 0) != (edit.ExpectedRevision == 0) || edit.Key == Guid.Empty)
            throw new BusinessException(Rejection.Invalid, "Invalid article identity, revision, or command key.");
        if (action != ArticleAction.Save)
        {
            if (edit.Id == 0 || edit.Title.Length != 0 || edit.Body.Length != 0)
                throw new BusinessException(Rejection.Invalid, "This command requires a saved revision and no content.");
            return edit;
        }

        var title = edit.Title.Trim();
        try
        {
            if (title.Length == 0 || title.Any(char.IsControl) || Utf8.GetByteCount(title) > 256 ||
                edit.Body.Length > 200_000 || edit.Body.Contains('\0') || Utf8.GetByteCount(edit.Body) > 1_048_576)
                throw new BusinessException(Rejection.Invalid, "Title or article content exceeds the supported limits.");
        }
        catch (EncoderFallbackException)
        {
            throw new BusinessException(Rejection.Invalid, "Title and article content must be valid Unicode text.");
        }
        return edit with { Title = title };
    }

    public static byte[] Fingerprint(ArticleAction action, Edit edit) => SHA256.HashData(Utf8.GetBytes(string.Create(
        CultureInfo.InvariantCulture, $"{(int)action}\0{edit.Id}\0{edit.ExpectedRevision}\0{edit.Title}\0{edit.Body}")));

    public static ArticleState Change(ArticleAction action, Edit edit, ArticleState current, Identity actor)
    {
        if (!actor.CanAuthor)
            throw new BusinessException(Rejection.Forbidden, "This account cannot write articles.");
        if (current.Id != edit.Id || current.Owner != actor.Id || current.Deleted)
            throw new BusinessException(Rejection.NotFound, "Article not found.");
        if (current.Revision != edit.ExpectedRevision)
            throw new BusinessException(Rejection.Conflict, "The article changed. Reload its current revision.");

        var revision = checked(current.Revision + 1);
        return action switch
        {
            ArticleAction.Save => current with { Revision = revision, Title = edit.Title, Body = edit.Body },
            ArticleAction.Publish => current with { Revision = revision, PublishedRevision = revision },
            ArticleAction.Retract => current with { Revision = revision, PublishedRevision = null },
            ArticleAction.Delete => current with { Revision = revision, PublishedRevision = null, Deleted = true },
            _ => throw new ArgumentOutOfRangeException(nameof(action))
        };
    }
}
