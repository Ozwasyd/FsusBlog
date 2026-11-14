using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core.Authoring;
using Npgsql;

namespace FsusBlog.V2.Server.Authoring;

internal static class CanvasReferenceStore
{
    internal static async Task<CanvasReferenceResolution> Resolve(NpgsqlConnection db, NpgsqlTransaction tx,
        Guid owner, Guid canvasId, Guid nodeId, long revision, CancellationToken ct)
    {
        CanvasReferenceResolution Empty(CanvasReferenceState state) =>
            new(canvasId, nodeId, revision, state, null, null, false, null, null, null);

        // The owning document is already locked for share. Read target facts from that exact
        // stored node; the request never supplies an article ID, anchor, or revision to query.
        CanvasNodeKind kind;
        int articleId;
        string? anchor;
        long? pin;
        await using (var query = Store.Sql(db, tx, """
            select kind,article_id,anchor,pinned_revision from public.canvas_node where canvas_id=$1 and id=$2
            """, canvasId, nodeId))
        await using (var row = await query.ExecuteReaderAsync(ct))
        {
            if (!await row.ReadAsync(ct) || row.IsDBNull(1)) return Empty(CanvasReferenceState.Unavailable);
            kind = (CanvasNodeKind)row.GetInt32(0);
            articleId = row.GetInt32(1);
            anchor = row.IsDBNull(2) ? null : row.GetString(2);
            pin = row.IsDBNull(3) ? null : row.GetInt64(3);
        }
        if (kind is not (CanvasNodeKind.ArticleReference or CanvasNodeKind.HeadingReference or CanvasNodeKind.BlockReference))
            return Empty(CanvasReferenceState.Unavailable);

        // Match article commands' ordering (Canvas first, then article). Holding the
        // article share lock prevents ACL/lifecycle and current revision changes mid-read.
        long current;
        await using (var authority = Store.Sql(db, tx, """
            select revision from public.article where id=$1 and owner_id=$2 and not deleted for share
            """, articleId, owner))
        {
            if (await authority.ExecuteScalarAsync(ct) is not long active)
                return Empty(CanvasReferenceState.Unavailable);
            current = active;
        }

        long target = pin ?? current;
        bool inspectSource = kind != CanvasNodeKind.ArticleReference;
        await using var source = Store.Sql(db, tx, inspectSource ? """
            select title,case when octet_length(body)<=$3 and char_length(body)<=$4 then body end
            from public.article_revision where article_id=$1 and revision=$2
            """ : """
            select title from public.article_revision where article_id=$1 and revision=$2
            """, inspectSource ? [articleId, target, WireLimits.BodyBytes, CanvasAnchor.MaxSourceCharacters] : [articleId, target]);
        await using var immutable = await source.ExecuteReaderAsync(ct);
        if (!await immutable.ReadAsync(ct)) return Empty(CanvasReferenceState.StaleRevision);
        var title = immutable.GetString(0).Trim();
        if (title.Length == 0 || title.Any(char.IsControl) || Encoding.UTF8.GetByteCount(title) > WireLimits.TitleBytes)
            return Empty(CanvasReferenceState.StaleRevision);
        if (!inspectSource)
            return new(canvasId, nodeId, revision, CanvasReferenceState.Resolved, articleId, target, pin.HasValue, title, null, null);

        if (immutable.IsDBNull(1) || anchor is null) return Empty(CanvasReferenceState.StaleRevision);
        string body = immutable.GetString(1);
        if (body.Length > CanvasAnchor.MaxSourceCharacters) return Empty(CanvasReferenceState.StaleRevision);
        var coordinate = CanvasAnchor.Find(body, anchor, kind == CanvasNodeKind.HeadingReference, ct);
        ct.ThrowIfCancellationRequested();
        var state = coordinate.State switch
        {
            CanvasAnchorState.Resolved => CanvasReferenceState.Resolved,
            CanvasAnchorState.Missing => CanvasReferenceState.MissingAnchor,
            CanvasAnchorState.Duplicate => CanvasReferenceState.DuplicateAnchor,
            _ => throw new InvalidOperationException("Unexpected Canvas anchor state.")
        };
        return new(canvasId, nodeId, revision, state, articleId, target, pin.HasValue,
            title, string.IsNullOrEmpty(coordinate.Excerpt) ? null : coordinate.Excerpt, coordinate.SourceOffset);
    }
}
