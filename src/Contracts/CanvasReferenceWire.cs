namespace FsusBlog.V2.Contracts;

public enum CanvasReferenceState { Unavailable = 0, Resolved = 1, MissingAnchor = 2, DuplicateAnchor = 3, StaleRevision = 4 }

public sealed record CanvasReferenceResolution(Guid CanvasId, Guid NodeId, long CanvasRevision, CanvasReferenceState State,
    int? ArticleId, long? ArticleRevision, bool Pinned, string? Title, string? Excerpt, int? SourceOffset);

public static partial class Wire
{
    public static byte[] EncodeCanvasReferenceResolution(CanvasReferenceResolution resolution)
    {
        ValidateCanvasReference(resolution);
        var w = new Writer();
        w.Uuid(resolution.CanvasId);
        w.Uuid(resolution.NodeId);
        w.I64(resolution.CanvasRevision);
        w.I32((int)resolution.State);
        w.I32(resolution.ArticleId ?? 0);
        w.I64(resolution.ArticleRevision ?? 0);
        w.Bool(resolution.Pinned);
        w.Text(resolution.Title ?? "", WireLimits.TitleBytes);
        w.Text(resolution.Excerpt ?? "", WireLimits.CanvasReferenceExcerptBytes);
        w.I32(resolution.SourceOffset ?? -1);
        return Aeds.Encode(FrameType.CanvasReferenceResolution, w.Written);
    }

    public static CanvasReferenceResolution DecodeCanvasReferenceResolution(ReadOnlySpan<byte> frame)
    {
        var r = new Reader(Aeds.Decode(frame, FrameType.CanvasReferenceResolution));
        var canvasId = r.Uuid();
        var nodeId = r.Uuid();
        var canvasRevision = r.I64();
        var state = (CanvasReferenceState)r.I32();
        var articleId = r.I32();
        var articleRevision = r.I64();
        var pinned = r.Bool();
        var title = r.Text(WireLimits.TitleBytes);
        var excerpt = r.Text(WireLimits.CanvasReferenceExcerptBytes);
        var sourceOffset = r.I32();
        r.Finish();
        var resolution = new CanvasReferenceResolution(canvasId, nodeId, canvasRevision, state,
            articleId == 0 ? null : articleId, articleRevision == 0 ? null : articleRevision, pinned,
            title.Length == 0 ? null : title, excerpt.Length == 0 ? null : excerpt, sourceOffset == -1 ? null : sourceOffset);
        ValidateCanvasReference(resolution);
        return resolution;
    }

    private static void ValidateCanvasReference(CanvasReferenceResolution value)
    {
        if (value.CanvasId == Guid.Empty || value.NodeId == Guid.Empty || value.CanvasRevision <= 0 || !Enum.IsDefined(value.State))
            throw InvalidCanvasReference();
        if (value.State is CanvasReferenceState.Unavailable or CanvasReferenceState.StaleRevision)
        {
            if (value.ArticleId is not null || value.ArticleRevision is not null || value.Pinned || value.Title is not null ||
                value.Excerpt is not null || value.SourceOffset is not null)
                throw InvalidCanvasReference();
            return;
        }
        if (value.ArticleId is null or <= 0 || value.ArticleRevision is null or <= 0 ||
            value.Title is null or "" || value.Title != value.Title.Trim() || value.Title.Any(char.IsControl))
            throw InvalidCanvasReference();
        if (value.State != CanvasReferenceState.Resolved && (value.Excerpt is not null || value.SourceOffset is not null))
            throw InvalidCanvasReference();
        if (value.SourceOffset < 0 || (value.Excerpt is not null && (value.SourceOffset is null ||
            value.Excerpt.Any(c => char.IsControl(c) && c is not ('\n' or '\r' or '\t')))))
            throw InvalidCanvasReference();
    }

    private static ProtocolException InvalidCanvasReference() => new("Invalid Canvas reference resolution");
}
