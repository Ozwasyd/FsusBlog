namespace FsusBlog.V2.Server.Authoring;

internal static class CanvasReferenceStore
{
    private const int MaxAnchorRevisions = 64;
    private const int MaxAnchorsPerRevision = 64;
    private const long MaxAnchorScanCharacters = 12_800_000;

    internal static async Task ValidateLockedAnchors(NpgsqlConnection db, NpgsqlTransaction tx,
        IReadOnlyList<CanvasNode> nodes, CancellationToken ct)
    {
        // Article ownership and lifecycle have already been checked under sorted share locks.
        var targets = nodes.Where(node => node.Kind is CanvasNodeKind.HeadingReference or CanvasNodeKind.BlockReference)
            .GroupBy(node => (Article: node.ArticleId!.Value, Pin: node.PinnedRevision ?? 0))
            .OrderBy(group => group.Key.Article).ThenBy(group => group.Key.Pin).ToArray();
        if (targets.Length > MaxAnchorRevisions)
            throw new BusinessException(Rejection.Invalid, "A Canvas request can check anchors in at most 64 article revisions.");
        long scanned = 0;
        foreach (var target in targets)
        {
            ct.ThrowIfCancellationRequested();
            if (await SqlCommands.Scalar(db, tx, ct, """
                select case when octet_length(r.body)<=$3 and char_length(r.body)<=$4 then r.body end
                from public.article a join public.article_revision r
                on r.article_id=a.id and r.revision=coalesce(nullif($2,0),a.revision)
                where a.id=$1
                """, target.Key.Article, target.Key.Pin, WireLimits.BodyBytes, CanvasAnchor.MaxSourceCharacters) is not string body || body.Length > CanvasAnchor.MaxSourceCharacters)
                throw Unavailable();

            var anchors = target.Select(node => (node.Anchor!, Heading: node.Kind == CanvasNodeKind.HeadingReference))
                .Distinct().ToArray();
            if (anchors.Length > MaxAnchorsPerRevision)
                throw new BusinessException(Rejection.Invalid, "A Canvas request can check at most 64 distinct anchors per article revision.");
            scanned += (long)body.Length * anchors.Length;
            if (scanned > MaxAnchorScanCharacters)
                throw new BusinessException(Rejection.Invalid, "The Canvas request exceeds its source scan budget.");
            foreach (var (anchor, heading) in anchors)
                if (CanvasAnchor.Find(body, anchor, heading, ct).State != CanvasAnchorState.Resolved)
                    throw Unavailable();
        }
    }

    private static BusinessException Unavailable() => new(Rejection.NotFound, "Canvas reference is unavailable.");

    internal static async Task<CanvasReferenceResolution> Resolve(NpgsqlConnection db, NpgsqlTransaction tx,
        Guid owner, Guid canvasId, Guid nodeId, long revision, bool requireCurrent, CancellationToken ct)
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
        if (await OwnedArticleRead.TryLock(db, tx, owner, articleId, ct) is not { } head)
            return Empty(CanvasReferenceState.Unavailable);
        var current = head.Revision;

        long target = pin ?? current;
        if (requireCurrent && target != current) return Empty(CanvasReferenceState.StaleRevision);
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
        // The editor can map original UTF-16 offsets only for consistently LF- or CRLF-delimited source.
        if (requireCurrent && !HasConsistentLineEndings(body)) return Empty(CanvasReferenceState.StaleRevision);
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

    private static bool HasConsistentLineEndings(ReadOnlySpan<char> body)
    {
        bool sawLf = false;
        bool sawCrLf = false;
        for (int i = 0; i < body.Length; i++)
        {
            if (body[i] == '\r')
            {
                if (sawLf || i + 1 == body.Length || body[i + 1] != '\n') return false;
                sawCrLf = true;
                i++;
            }
            else if (body[i] == '\n')
            {
                if (sawCrLf) return false;
                sawLf = true;
            }
        }
        return true;
    }
}
