using System.Collections.Immutable;
using FsusBlog.V2.Core.Authoring;

namespace FsusBlog.V2.Integration.Tests;

public sealed class CanvasPatchPlanTests
{
    [Fact]
    public void ForwardAndReversePlansPreserveSortedWritesAndReferenceCoordinates()
    {
        var geometry = new CanvasGeometry(0, 0, 3000, 3000);
        CanvasNode Node(int id) => new(Id(id), CanvasNodeKind.HeadingReference, geometry, id, "alpha", 1, MemberIds: []);
        var old = Enumerable.Range(1, 5).Select(Node).ToArray();
        var desired = new[]
        {
            old[0] with { Geometry = geometry with { X = 100 } },
            old[1] with { Anchor = "beta" },
            old[2] with { PinnedRevision = 2 },
            old[3] with { ArticleId = 42 },
            Node(6)
        };
        CanvasGraphEdge Edge(int id, int target) => new(Id(id), CanvasGraphEdgeKind.VisualOnly, Id(1), Id(target), id);
        var removed = Edge(11, 5);
        var changed = Edge(12, 2);
        var added = Edge(13, 6);
        var before = new CanvasGraph(old.Reverse().ToImmutableArray(), [changed, removed]);
        var after = new CanvasGraph(desired.Reverse().ToImmutableArray(), [added, changed with { Label = "new" }]);
        var patch = CanvasHistoryPatch.Between(before, after);
        var forward = CanvasPatchPlan.From(patch, forward: true);
        Assert.Equal(desired.Skip(1), forward.References);
        Assert.Equal([Id(11)], forward.RemovedEdges);
        Assert.Equal(desired, forward.WrittenNodes);
        Assert.Equal([changed with { Label = "new" }, added], forward.WrittenEdges);
        Assert.Equal([Id(5)], forward.RemovedNodes);
        AssertApplied(before, after, forward);

        var reverse = CanvasPatchPlan.From(patch, forward: false);
        Assert.Equal(old.Skip(1), reverse.References);
        Assert.Equal([Id(13)], reverse.RemovedEdges);
        Assert.Equal(old, reverse.WrittenNodes);
        Assert.Equal([removed, changed], reverse.WrittenEdges);
        Assert.Equal([Id(6)], reverse.RemovedNodes);
        AssertApplied(after, before, reverse);
        Assert.Equal(old[0].Geometry, before.Nodes.Single(node => node.Id == Id(1)).Geometry);
    }

    [Fact]
    public void EmptyGraphPatchProducesNoWritesOrReferenceChecksInEitherDirection()
    {
        foreach (var forward in new[] { false, true })
        {
            var plan = CanvasPatchPlan.From(CanvasHistoryPatch.Between(CanvasGraph.Empty, CanvasGraph.Empty), forward);
            Assert.Empty(plan.References);
            Assert.Empty(plan.RemovedEdges);
            Assert.Empty(plan.WrittenNodes);
            Assert.Empty(plan.WrittenEdges);
            Assert.Empty(plan.RemovedNodes);
        }
    }

    private static void AssertApplied(CanvasGraph before, CanvasGraph expected, CanvasPatchPlan plan)
    {
        var nodes = before.Nodes.ToDictionary(node => node.Id);
        var edges = before.Edges.ToDictionary(edge => edge.Id);
        foreach (var id in plan.RemovedEdges) Assert.True(edges.Remove(id));
        foreach (var node in plan.WrittenNodes) nodes[node.Id] = node;
        foreach (var edge in plan.WrittenEdges) edges[edge.Id] = edge;
        foreach (var id in plan.RemovedNodes) Assert.True(nodes.Remove(id));
        var actual = new CanvasGraph(nodes.Values.ToImmutableArray(), edges.Values.ToImmutableArray());
        actual.Validate();
        Assert.Equal(expected.Nodes.OrderBy(node => node.Id), actual.Nodes.OrderBy(node => node.Id));
        Assert.Equal(expected.Edges.OrderBy(edge => edge.Id), actual.Edges.OrderBy(edge => edge.Id));
    }

    private static Guid Id(int value) => Guid.Parse($"00000000-0000-0000-0000-{value:D12}");
}
