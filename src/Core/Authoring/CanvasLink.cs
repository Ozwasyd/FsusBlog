using System.Globalization;
using System.Text;

namespace FsusBlog.V2.Core.Authoring;

public sealed record CanvasEdge(Guid CanvasId, Guid EdgeId, long Revision, int HostArticleId, int TargetArticleId,
    bool ExplicitReference);
public sealed record CanvasLinkIntent(Guid CanvasId, Guid EdgeId, long CanvasRevision, long HostRevision,
    long TargetRevision, int SourceOffset, bool VisualOnly = false);
public sealed record CanvasTarget(int Id, Guid Owner, long Revision, string Title);

public static class CanvasLink
{
    public static void Validate(CanvasLinkIntent intent)
    {
        if (intent.CanvasId == Guid.Empty || intent.EdgeId == Guid.Empty || intent.CanvasRevision <= 0 ||
            intent.HostRevision <= 0 || intent.TargetRevision <= 0 || intent.SourceOffset < 0)
            throw new BusinessException(Rejection.Invalid, "Invalid Canvas link coordinates.");
    }

    public static (string Inserted, string Body) Build(CanvasEdge edge, CanvasLinkIntent intent, ArticleState host,
        CanvasTarget target, Identity actor)
    {
        Validate(intent);
        if (!actor.CanAuthor) throw new BusinessException(Rejection.Forbidden, "Canvas write permission is required.");
        if (edge.CanvasId != intent.CanvasId || edge.EdgeId != intent.EdgeId ||
            host.Id != edge.HostArticleId || target.Id != edge.TargetArticleId || host.Id == target.Id ||
            host.Owner != actor.Id || target.Owner != actor.Id || host.Deleted)
            throw new BusinessException(Rejection.NotFound, "Canvas link is unavailable.");
        if (edge.ExplicitReference == intent.VisualOnly)
            throw new BusinessException(Rejection.Invalid, "Choose a conversion that matches the selected Canvas edge.");
        if (edge.Revision != intent.CanvasRevision || host.Revision != intent.HostRevision ||
            target.Revision != intent.TargetRevision || host.Body.Length != intent.SourceOffset)
            throw new BusinessException(Rejection.Conflict, "A Canvas link coordinate changed. Review it again.");

        var label = new StringBuilder();
        foreach (var letter in target.Title.Trim())
        {
            if (char.IsControl(letter))
                throw new BusinessException(Rejection.Conflict, "The referenced article has no usable link title.");
            if (letter is >= '!' and <= '/' or >= ':' and <= '@' or >= '[' and <= '`' or >= '{' and <= '~')
                label.Append('\\');
            label.Append(letter);
        }
        if (label.Length == 0)
            throw new BusinessException(Rejection.Conflict, "The referenced article has no usable link title.");

        var index = host.Body.IndexOfAny(['\r', '\n']);
        var newline = index < 0 ? "\n" : host.Body[index] == '\n' ? "\n"
            : index + 1 < host.Body.Length && host.Body[index + 1] == '\n' ? "\r\n" : "\r";
        var link = string.Create(CultureInfo.InvariantCulture, $"[{label}](/article/{target.Id})");
        var inserted = host.Body.Length == 0 ? link : string.Concat(newline, newline, link);
        return (inserted, host.Body + inserted);
    }
}
