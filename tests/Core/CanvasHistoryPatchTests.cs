using System.Collections.Immutable;
using System.Text.Json;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Authoring;

public sealed class CanvasHistoryPatchTests
{
    private static readonly CanvasGeometry Geometry = new(100, 200, 16_000, 9_000);
    private static Guid Id(int n) => new(n, 0, 0, new byte[8]);

    [Fact]
    public void RestoresNodeIncidentEdgesAndFrameMembershipAsOneGraph()
    {
        var note = new CanvasNode(Id(1), CanvasNodeKind.PlainTextNote, Geometry, Text: "Private note");
        var article = new CanvasNode(Id(2), CanvasNodeKind.ArticleReference, Geometry, ArticleId: 9);
        var frame = new CanvasNode(Id(3), CanvasNodeKind.GroupFrame, Geometry, Text: "Frame", MemberIds: [article.Id, note.Id]);
        var prior = new CanvasGraph([frame, article, note],
            [new(Id(5), CanvasGraphEdgeKind.VisualOnly, article.Id, note.Id, 1),
             new(Id(4), CanvasGraphEdgeKind.VisualOnly, note.Id, note.Id, 0)]);
        var deleted = prior.Apply([new CanvasGraphChange.RemoveNode(note.Id)]);
        var patch = CanvasHistoryPatch.Between(prior, deleted);

        Assert.Equal(new[] { note.Id, frame.Id }, patch.Nodes.Select(entry => entry.Id));
        Assert.Equal(new[] { Id(4), Id(5) }, patch.Edges.Select(entry => entry.Id));
        Assert.Null(patch.Nodes[0].After);
        Assert.Equal(article.Id, Assert.Single(patch.Nodes[1].After!.MemberIds));
        var restored = patch.Apply(deleted, forward: false);
        Assert.Equal(new[] { note.Id, article.Id, frame.Id }, restored.Nodes.Select(node => node.Id));
        Assert.Equal(new[] { Id(4), Id(5) }, restored.Edges.Select(edge => edge.Id));
        Assert.Equal(new[] { article.Id, note.Id }, restored.Nodes[2].MemberIds.ToArray());
        Assert.True(CanvasHistoryPatch.SameNode(note, restored.Nodes[0]));
        var deletedAgain = patch.Apply(restored, forward: true);
        Assert.Empty(CanvasHistoryPatch.Between(deletedAgain, deleted).Nodes);
        Assert.Empty(deletedAgain.Edges);
    }

    [Fact]
    public void ComparesMembershipContentsAndIgnoresCollectionBackingIdentity()
    {
        var first = new CanvasNode(Id(1), CanvasNodeKind.PlainTextNote, Geometry, Text: "First");
        var second = new CanvasNode(Id(2), CanvasNodeKind.PlainTextNote, Geometry, Text: "Second");
        var frame = new CanvasNode(Id(3), CanvasNodeKind.GroupFrame, Geometry, Text: "Frame", MemberIds: [first.Id, second.Id]);
        var prior = new CanvasGraph([first, second, frame], []);
        var same = new CanvasGraph([first with { MemberIds = [] }, second,
            frame with { MemberIds = ImmutableArray.Create(first.Id, second.Id) }], []);
        var empty = CanvasHistoryPatch.Between(prior, same);
        Assert.Empty(empty.Nodes);
        Assert.Empty(empty.Edges);
        Assert.Empty(CanvasHistoryPatch.Between(prior, empty.Apply(same, forward: false)).Nodes);

        var updatedFrame = frame with { Geometry = Geometry with { Y = 777 } };
        var after = prior.Apply([new CanvasGraphChange.UpsertNode(updatedFrame)]);
        var patch = CanvasHistoryPatch.Between(prior, after);
        Assert.Equal(777, patch.Apply(same, forward: true).Nodes[^1].Geometry.Y);
        var wrongMembers = new CanvasGraph([first, second, frame with { MemberIds = [second.Id, first.Id] }], []);
        Assert.Equal(Rejection.Conflict, Assert.Throws<BusinessException>(() => patch.Apply(wrongMembers, forward: true)).Rejection);
    }

    [Fact]
    public void RejectsMissingStaleAndUnexpectedPairedFactsInBothDirections()
    {
        var note = new CanvasNode(Id(1), CanvasNodeKind.PlainTextNote, Geometry, Text: "Original");
        var prior = new CanvasGraph([note], []);
        var edge = new CanvasGraphEdge(Id(2), CanvasGraphEdgeKind.VisualOnly, note.Id, note.Id, 0, "Loop");
        var after = new CanvasGraph([note with { Text = "Renamed" }], [edge]);
        var patch = CanvasHistoryPatch.Between(prior, after);

        var wrongNode = new CanvasGraph([note with { Text = "Changed elsewhere" }], []);
        var missingEdge = new CanvasGraph(after.Nodes, []);
        var wrongEdge = new CanvasGraph(after.Nodes, [edge with { Order = 1 }]);
        foreach (var stale in new[] { CanvasGraph.Empty, wrongNode, new CanvasGraph(prior.Nodes, [edge]) })
            Assert.Equal(Rejection.Conflict, Assert.Throws<BusinessException>(() => patch.Apply(stale, forward: true)).Rejection);
        foreach (var stale in new[] { missingEdge, wrongEdge })
            Assert.Equal(Rejection.Conflict, Assert.Throws<BusinessException>(() => patch.Apply(stale, forward: false)).Rejection);
        Assert.Equal("Original", Assert.Single(prior.Nodes).Text);
        Assert.Equal("Renamed", Assert.Single(after.Nodes).Text);
        Assert.Same(edge, Assert.Single(after.Edges));
    }

    [Fact]
    public void RejectsMalformedNonCanonicalAndPartialCascadeFacts()
    {
        var note = new CanvasNode(Id(1), CanvasNodeKind.PlainTextNote, Geometry, Text: "A");
        var another = new CanvasNode(Id(2), CanvasNodeKind.PlainTextNote, Geometry, Text: "B");
        var edge = new CanvasGraphEdge(Id(3), CanvasGraphEdgeKind.VisualOnly, note.Id, another.Id, 0);
        var prior = new CanvasGraph([note, another], [edge]);
        var wrongKind = new CanvasNode(note.Id, CanvasNodeKind.ArticleReference, Geometry, ArticleId: 9);
        var invalid = new CanvasHistoryPatch[]
        {
            new(default, []),
            new([new(note.Id, note, note with { MemberIds = [] })], []),
            new([new(note.Id, note, another)], []),
            new([new(note.Id, note, wrongKind)], []),
            new([new(note.Id, note, null), new(note.Id, note, null)], []),
            new([new(another.Id, another, null), new(note.Id, note, null)], [new(edge.Id, edge, null)]),
            new([new(note.Id, note, null)], []),
        };
        foreach (var patch in invalid)
            Assert.Equal(Rejection.Invalid, Assert.Throws<BusinessException>(() => patch.Apply(prior, forward: true)).Rejection);
        Assert.Throws<BusinessException>(() => CanvasHistoryPatch.Between(prior, new([wrongKind, another], [edge])));
    }

    [Fact]
    public void SerializedFactsRetainAbsenceStableIdsAndMembership()
    {
        var note = new CanvasNode(Id(1), CanvasNodeKind.PlainTextNote, Geometry, Text: "Private note");
        var frame = new CanvasNode(Id(2), CanvasNodeKind.GroupFrame, Geometry, Text: "Frame", MemberIds: [note.Id]);
        var edge = new CanvasGraphEdge(Id(3), CanvasGraphEdgeKind.VisualOnly, note.Id, frame.Id, 0, "A link");
        var prior = new CanvasGraph([note, frame], [edge]);
        var after = prior.Apply([new CanvasGraphChange.RemoveNode(note.Id)]);
        var patch = CanvasHistoryPatch.Between(prior, after);
        var persisted = JsonSerializer.SerializeToUtf8Bytes(patch);
        var loaded = JsonSerializer.Deserialize<CanvasHistoryPatch>(persisted);
        Assert.NotNull(loaded);
        Assert.Null(loaded.Nodes[0].After);
        Assert.Equal(note.Id, Assert.Single(loaded.Nodes[1].Before!.MemberIds));
        Assert.Equal(edge, Assert.Single(loaded.Edges).Before);
        var restored = loaded.Apply(after, forward: false);
        var difference = CanvasHistoryPatch.Between(prior, restored);
        Assert.Empty(difference.Nodes);
        Assert.Empty(difference.Edges);
    }

    [Fact]
    public void ADeletionCanAffectMoreRowsThanAnOrdinaryCommandMayProvide()
    {
        var note = new CanvasNode(Id(1), CanvasNodeKind.PlainTextNote, Geometry, Text: "Hub");
        var oldEdges = Enumerable.Range(2, CanvasGraph.MaxChanges + 1)
            .Select(index => new CanvasGraphEdge(Id(index), CanvasGraphEdgeKind.VisualOnly, note.Id, note.Id, index))
            .ToImmutableArray();
        var prior = new CanvasGraph([note], oldEdges);
        var after = prior.Apply([new CanvasGraphChange.RemoveNode(note.Id)]);
        var patch = CanvasHistoryPatch.Between(prior, after);
        Assert.Equal(CanvasGraph.MaxChanges + 1, patch.Edges.Length);
        Assert.Equal(oldEdges.ToArray(), patch.Apply(after, forward: false).Edges.ToArray());
        Assert.Empty(patch.Apply(prior, forward: true).Edges);
    }
}
