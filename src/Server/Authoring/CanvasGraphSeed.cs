using System.Collections.Immutable;
using FsusBlog.V2.Core.Authoring;
using NpgsqlTypes;

namespace FsusBlog.V2.Server.Authoring;

internal sealed partial class CanvasGraphStore
{
    private async Task CopySeedNodes(Guid canvas, ImmutableArray<CanvasNode> nodes, CancellationToken ct)
    {
        if (nodes.IsEmpty) return;
        await using var copy = await db.BeginBinaryImportAsync("""
            copy public.canvas_node(canvas_id,id,kind,x,y,width,height,article_id,anchor,pinned_revision,note,member_ids)
            from stdin (format binary)
            """, ct);
        foreach (var node in nodes)
        {
            var g = node.Geometry;
            await copy.StartRowAsync(ct);
            await copy.WriteAsync(canvas, NpgsqlDbType.Uuid, ct);
            await copy.WriteAsync(node.Id, NpgsqlDbType.Uuid, ct);
            await copy.WriteAsync((int)node.Kind, NpgsqlDbType.Integer, ct);
            await copy.WriteAsync(g.X, NpgsqlDbType.Integer, ct);
            await copy.WriteAsync(g.Y, NpgsqlDbType.Integer, ct);
            await copy.WriteAsync(g.Width, NpgsqlDbType.Integer, ct);
            await copy.WriteAsync(g.Height, NpgsqlDbType.Integer, ct);
            if (node.ArticleId.HasValue) await copy.WriteAsync(node.ArticleId.Value, NpgsqlDbType.Integer, ct);
            else await copy.WriteNullAsync(ct);
            if (node.Anchor is not null) await copy.WriteAsync(node.Anchor, NpgsqlDbType.Text, ct);
            else await copy.WriteNullAsync(ct);
            if (node.PinnedRevision.HasValue) await copy.WriteAsync(node.PinnedRevision.Value, NpgsqlDbType.Bigint, ct);
            else await copy.WriteNullAsync(ct);
            if (node.Text is not null) await copy.WriteAsync(node.Text, NpgsqlDbType.Text, ct);
            else await copy.WriteNullAsync(ct);
            await copy.WriteAsync(node.MemberIds.AsSpan().ToArray(), NpgsqlDbType.Array | NpgsqlDbType.Uuid, ct);
        }
        await copy.CompleteAsync(ct);
    }

    private async Task CopySeedEdges(Guid canvas, ImmutableArray<CanvasGraphEdge> edges, CancellationToken ct)
    {
        if (edges.IsEmpty) return;
        await using var copy = await db.BeginBinaryImportAsync("""
            copy public.canvas_edge(canvas_id,id,source_node_id,target_node_id,explicit_reference,sort_order,label)
            from stdin (format binary)
            """, ct);
        foreach (var edge in edges)
        {
            await copy.StartRowAsync(ct);
            await copy.WriteAsync(canvas, NpgsqlDbType.Uuid, ct);
            await copy.WriteAsync(edge.Id, NpgsqlDbType.Uuid, ct);
            await copy.WriteAsync(edge.SourceNodeId, NpgsqlDbType.Uuid, ct);
            await copy.WriteAsync(edge.TargetNodeId, NpgsqlDbType.Uuid, ct);
            await copy.WriteAsync(edge.Kind == CanvasGraphEdgeKind.ExplicitReferenceNote, NpgsqlDbType.Boolean, ct);
            await copy.WriteAsync(edge.Order, NpgsqlDbType.Integer, ct);
            if (edge.Label is not null) await copy.WriteAsync(edge.Label, NpgsqlDbType.Text, ct);
            else await copy.WriteNullAsync(ct);
        }
        await copy.CompleteAsync(ct);
    }
}
