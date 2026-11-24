namespace FsusBlog.V2.Server.Authoring;

// Projects an already validated history patch. It neither authorizes references nor writes storage.
internal sealed record CanvasPatchPlan(CanvasNode[] References, Guid[] RemovedEdges, CanvasNode[] WrittenNodes,
    CanvasGraphEdge[] WrittenEdges, Guid[] RemovedNodes)
{
    internal static CanvasPatchPlan From(CanvasHistoryPatch patch, bool forward)
    {
        var nodes = patch.Nodes.Select(entry => (Expected: forward ? entry.Before : entry.After,
            Desired: forward ? entry.After : entry.Before)).ToArray();
        var edges = patch.Edges.Select(entry => (entry.Id, Desired: forward ? entry.After : entry.Before)).ToArray();
        return new(
            nodes.Where(pair => pair.Desired?.ArticleId is not null &&
                (pair.Expected?.ArticleId, pair.Expected?.Anchor, pair.Expected?.PinnedRevision) !=
                (pair.Desired.ArticleId, pair.Desired.Anchor, pair.Desired.PinnedRevision))
                .Select(pair => pair.Desired!).ToArray(),
            edges.Where(pair => pair.Desired is null).Select(pair => pair.Id).ToArray(),
            nodes.Where(pair => pair.Desired is not null).Select(pair => pair.Desired!).ToArray(),
            edges.Where(pair => pair.Desired is not null).Select(pair => pair.Desired!).ToArray(),
            nodes.Where(pair => pair.Desired is null).Select(pair => pair.Expected!.Id).ToArray());
    }
}
