namespace FsusBlog.V2.Server.Authoring;

internal static class CanvasReferenceStore
{
    private const int MaxAnchorRevisions = 64;
    private const int MaxAnchorsPerRevision = 64;
    private const long MaxAnchorScanCharacters = 12_800_000;

    internal static async Task ValidateLockedAnchors(NpgsqlConnection db, NpgsqlTransaction tx,
        IReadOnlyList<CanvasNode> nodes, CancellationToken ct)
    {
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
                on r.article_id=a.id and r.revision=coalesce(nullif($2,0),a.revision) where a.id=$1
                """, target.Key.Article, target.Key.Pin, WireLimits.BodyBytes, CanvasAnchor.MaxSourceCharacters) is not string body || body.Length > CanvasAnchor.MaxSourceCharacters)
                throw Unavailable();
            var anchors = target.Select(node => (node.Anchor!, Heading: node.Kind == CanvasNodeKind.HeadingReference)).Distinct().ToArray();
            if (anchors.Length > MaxAnchorsPerRevision)
                throw new BusinessException(Rejection.Invalid, "A Canvas request can check at most 64 distinct anchors per article revision.");
            if ((scanned += (long)body.Length * anchors.Length) > MaxAnchorScanCharacters)
                throw new BusinessException(Rejection.Invalid, "The Canvas request exceeds its source scan budget.");
            foreach (var (anchor, heading) in anchors)
                if (CanvasAnchor.Find(body, anchor, heading, ct).State != CanvasAnchorState.Resolved) throw Unavailable();
        }
    }

    private static BusinessException Unavailable() => new(Rejection.NotFound, "Canvas reference is unavailable.");

    internal static async Task<CanvasReferenceResolution> Resolve(NpgsqlConnection db, NpgsqlTransaction tx,
        Guid owner, Guid canvasId, Guid nodeId, long revision, bool requireCurrent, CancellationToken ct)
    {
        CanvasReferenceResolution Empty(CanvasReferenceState state) =>
            new(canvasId, nodeId, revision, state, null, null, false, null, null, null);

        var node = await SqlCommands.QueryOneValue(db, tx, ct,
            "select kind,article_id,anchor,pinned_revision from public.canvas_node where canvas_id=$1 and id=$2",
            row => ((CanvasNodeKind)row.GetInt32(0), row.IsDBNull(1) ? (int?)null : row.GetInt32(1),
                row.IsDBNull(2) ? null : row.GetString(2), row.IsDBNull(3) ? (long?)null : row.GetInt64(3)),
            canvasId, nodeId);
        if (node is not (var kind, int articleId, var anchor, var pin) ||
            kind is not (CanvasNodeKind.ArticleReference or CanvasNodeKind.HeadingReference or CanvasNodeKind.BlockReference))
            return Empty(CanvasReferenceState.Unavailable);

        if (await OwnedArticleRead.TryLock(db, tx, owner, articleId, ct) is not { } head)
            return Empty(CanvasReferenceState.Unavailable);
        long target = pin ?? head.Revision;
        if (requireCurrent && target != head.Revision) return Empty(CanvasReferenceState.StaleRevision);
        bool inspectSource = kind != CanvasNodeKind.ArticleReference;
        object[] sourceArgs = inspectSource ? [articleId, target, WireLimits.BodyBytes, CanvasAnchor.MaxSourceCharacters] : [articleId, target];
        var sourceRow = await SqlCommands.QueryOneValue(db, tx, ct, inspectSource ? """
            select title,case when octet_length(body)<=$3 and char_length(body)<=$4 then body end
            from public.article_revision where article_id=$1 and revision=$2
            """ : "select title from public.article_revision where article_id=$1 and revision=$2",
            r => (r.GetString(0).Trim(), inspectSource && !r.IsDBNull(1) ? r.GetString(1) : null), sourceArgs);
        if (sourceRow is not var (title, body) || title.Length == 0 || title.Any(char.IsControl) || Encoding.UTF8.GetByteCount(title) > WireLimits.TitleBytes)
            return Empty(CanvasReferenceState.StaleRevision);
        if (!inspectSource)
            return new(canvasId, nodeId, revision, CanvasReferenceState.Resolved, articleId, target, pin.HasValue, title, null, null);
        if (body is null || anchor is null || body.Length > CanvasAnchor.MaxSourceCharacters || (requireCurrent && !HasConsistentLineEndings(body)))
            return Empty(CanvasReferenceState.StaleRevision);
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
        bool sawLf = false, sawCrLf = false;
        for (int i = 0; i < body.Length; i++)
        {
            if (body[i] == '\r')
            {
                if (sawLf || i + 1 == body.Length || body[i + 1] != '\n') return false;
                sawCrLf = true; i++;
            }
            else if (body[i] == '\n') { if (sawCrLf) return false; sawLf = true; }
        }
        return true;
    }
}

internal sealed record CanvasPatchPlan(CanvasNode[] References, Guid[] RemovedEdges, CanvasNode[] WrittenNodes,
    CanvasGraphEdge[] WrittenEdges, Guid[] RemovedNodes)
{
    internal static CanvasPatchPlan From(CanvasHistoryPatch patch, bool forward)
    {
        var nodes = patch.Nodes.Select(entry => (Expected: forward ? entry.Before : entry.After, Desired: forward ? entry.After : entry.Before)).ToArray();
        var edges = patch.Edges.Select(entry => (entry.Id, Desired: forward ? entry.After : entry.Before)).ToArray();
        return new(
            nodes.Where(pair => pair.Desired?.ArticleId is not null &&
                (pair.Expected?.ArticleId, pair.Expected?.Anchor, pair.Expected?.PinnedRevision) !=
                (pair.Desired.ArticleId, pair.Desired.Anchor, pair.Desired.PinnedRevision)).Select(pair => pair.Desired!).ToArray(),
            edges.Where(pair => pair.Desired is null).Select(pair => pair.Id).ToArray(),
            nodes.Where(pair => pair.Desired is not null).Select(pair => pair.Desired!).ToArray(),
            edges.Where(pair => pair.Desired is not null).Select(pair => pair.Desired!).ToArray(),
            nodes.Where(pair => pair.Desired is null).Select(pair => pair.Expected!.Id).ToArray());
    }
}

internal static class CanvasBundleStore
{
    internal static CanvasPortableBundle Read(byte[] data)
    {
        try { return CanvasPortableBundle.Decode(data); }
        catch (BusinessException) { throw new BusinessException(Rejection.Invalid, "The Canvas bundle is invalid or exceeds its size limit."); }
    }

    internal static CanvasBundlePlan Plan(byte[] data)
    {
        var parsed = Read(data);
        return new(Digest(data), parsed.SourceRevision, parsed.Title, parsed.NodeCount, parsed.EdgeCount,
            parsed.References.Select(reference => new CanvasBundleReference(reference.Slot, (int)reference.Kind, reference.RequiresPin, reference.Anchor)).ToArray());
    }

    internal static string Digest(byte[] data) => Convert.ToHexStringLower(SHA256.HashData(data));
}
