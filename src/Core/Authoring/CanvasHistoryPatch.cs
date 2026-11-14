using System.Collections.Immutable;

namespace FsusBlog.V2.Core.Authoring;

public sealed record CanvasHistoryNode(Guid Id, CanvasNode? Before, CanvasNode? After);
public sealed record CanvasHistoryEdge(Guid Id, CanvasGraphEdge? Before, CanvasGraphEdge? After);

/// <summary>Changed Canvas rows in ascending ID order. A null fact means the row is absent.</summary>
public sealed record CanvasHistoryPatch(ImmutableArray<CanvasHistoryNode> Nodes, ImmutableArray<CanvasHistoryEdge> Edges)
{
    public static CanvasHistoryPatch Between(CanvasGraph before, CanvasGraph after)
    {
        before.Validate();
        after.Validate();

        var beforeNodes = before.Nodes.ToDictionary(node => node.Id);
        var afterNodes = after.Nodes.ToDictionary(node => node.Id);
        var nodes = ImmutableArray.CreateBuilder<CanvasHistoryNode>();
        foreach (var id in beforeNodes.Keys.Union(afterNodes.Keys).Order())
        {
            var left = beforeNodes.GetValueOrDefault(id);
            var right = afterNodes.GetValueOrDefault(id);
            EnsureNodeKind(left, right);
            if (!SameNode(left, right))
                nodes.Add(new(id, CanonicalNode(left), CanonicalNode(right)));
        }

        var beforeEdges = before.Edges.ToDictionary(edge => edge.Id);
        var afterEdges = after.Edges.ToDictionary(edge => edge.Id);
        var edges = ImmutableArray.CreateBuilder<CanvasHistoryEdge>();
        foreach (var id in beforeEdges.Keys.Union(afterEdges.Keys).Order())
        {
            var left = beforeEdges.GetValueOrDefault(id);
            var right = afterEdges.GetValueOrDefault(id);
            if (left != right)
                edges.Add(new(id, left, right));
        }

        return new(nodes.ToImmutable(), edges.ToImmutable());
    }

    /// <summary>Checks the paired facts, applies all changes together, and admits the resulting graph.</summary>
    public CanvasGraph Apply(CanvasGraph graph, bool forward)
    {
        if (Nodes.IsDefault || Edges.IsDefault || Nodes.Length > 2 * CanvasGraph.MaxNodes
            || Edges.Length > 2 * CanvasGraph.MaxEdges)
            throw InvalidPatch();

        graph.Validate();
        if (Nodes.IsEmpty && Edges.IsEmpty) return graph;

        var nodes = graph.Nodes.ToDictionary(node => node.Id);
        var edges = graph.Edges.ToDictionary(edge => edge.Id);
        Guid previous = Guid.Empty;
        foreach (var entry in Nodes)
        {
            if (entry is null || entry.Id.CompareTo(previous) <= 0
                || entry.Before is { } before && before.Id != entry.Id
                || entry.After is { } after && after.Id != entry.Id
                || SameNode(entry.Before, entry.After))
                throw InvalidPatch();

            EnsureNodeKind(entry.Before, entry.After);
            var expected = forward ? entry.Before : entry.After;
            if (!SameNode(nodes.GetValueOrDefault(entry.Id), expected))
                throw StaleFacts();
            previous = entry.Id;
        }

        previous = Guid.Empty;
        foreach (var entry in Edges)
        {
            if (entry is null || entry.Id.CompareTo(previous) <= 0
                || entry.Before is { } before && before.Id != entry.Id
                || entry.After is { } after && after.Id != entry.Id
                || entry.Before == entry.After)
                throw InvalidPatch();

            var expected = forward ? entry.Before : entry.After;
            if (edges.GetValueOrDefault(entry.Id) != expected)
                throw StaleFacts();
            previous = entry.Id;
        }

        foreach (var entry in Nodes)
            Replace(nodes, entry.Id, CanonicalNode(forward ? entry.After : entry.Before));
        foreach (var entry in Edges)
            Replace(edges, entry.Id, forward ? entry.After : entry.Before);

        var result = new CanvasGraph(nodes.Values.OrderBy(node => node.Id).ToImmutableArray(),
            edges.Values.OrderBy(edge => edge.Order).ThenBy(edge => edge.Id).ToImmutableArray());
        result.Validate();
        return result;
    }

    public static bool SameNode(CanvasNode? left, CanvasNode? right) =>
        ReferenceEquals(left, right) ||
        left is not null && right is not null
            && left with { MemberIds = default } == right with { MemberIds = default }
            && left.MemberIds.AsSpan().SequenceEqual(right.MemberIds.AsSpan());

    private static CanvasNode? CanonicalNode(CanvasNode? node) =>
        node is not null && node.MemberIds.IsDefault ? node with { MemberIds = [] } : node;

    private static void EnsureNodeKind(CanvasNode? before, CanvasNode? after)
    {
        if (before is not null && after is not null && before.Kind != after.Kind)
            throw InvalidPatch();
    }

    private static void Replace<T>(Dictionary<Guid, T> rows, Guid id, T? value) where T : class
    {
        if (value is null)
            rows.Remove(id);
        else
            rows[id] = value;
    }

    private static BusinessException InvalidPatch() => new(Rejection.Invalid, "Invalid Canvas history facts.");
    private static BusinessException StaleFacts() => new(Rejection.Conflict, "Canvas history does not match its current rows.");
}
