using static CanvasFixture;

public sealed class CanvasHistoryPatchTests
{
    private static readonly CanvasGeometry Geometry = new(100, 200, 16_000, 9_000);

    [Fact]
    public void RestoresNodeIncidentEdgesAndFrameMembershipAsOneGraph()
    {
        var note = Note(1, Geometry, "Private note");
        var article = ArticleRef(2, Geometry, 9);
        var frame = Frame(3, Geometry, "Frame", [article.Id, note.Id]);
        var prior = new CanvasGraph([frame, article, note], [VisualEdge(5, article.Id, note.Id, 1), VisualEdge(4, note.Id, note.Id, 0)]);
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
        var first = Note(1, Geometry, "First");
        var second = Note(2, Geometry, "Second");
        var frame = Frame(3, Geometry, "Frame", [first.Id, second.Id]);
        var prior = new CanvasGraph([first, second, frame], []);
        var same = new CanvasGraph([first with { MemberIds = [] }, second, frame with { MemberIds = ImmutableArray.Create(first.Id, second.Id) }], []);
        var empty = CanvasHistoryPatch.Between(prior, same);
        Assert.Empty(empty.Nodes);
        Assert.Empty(empty.Edges);
        Assert.Empty(CanvasHistoryPatch.Between(prior, empty.Apply(same, forward: false)).Nodes);

        var after = prior.Apply([new CanvasGraphChange.UpsertNode(frame with { Geometry = Geometry with { Y = 777 } })]);
        var patch = CanvasHistoryPatch.Between(prior, after);
        Assert.Equal(777, patch.Apply(same, forward: true).Nodes[^1].Geometry.Y);
        Reject(() => patch.Apply(new([first, second, frame with { MemberIds = [second.Id, first.Id] }], []), forward: true), Rejection.Conflict);
    }

    [Fact]
    public void RejectsMissingStaleAndUnexpectedPairedFactsInBothDirections()
    {
        var note = Note(1, Geometry, "Original");
        var prior = new CanvasGraph([note], []);
        var edge = VisualEdge(2, note.Id, note.Id, 0, "Loop");
        var after = new CanvasGraph([note with { Text = "Renamed" }], [edge]);
        var patch = CanvasHistoryPatch.Between(prior, after);

        foreach (var stale in new[] { CanvasGraph.Empty, new([note with { Text = "Changed elsewhere" }], []), new(prior.Nodes, [edge]) })
            Reject(() => patch.Apply(stale, forward: true), Rejection.Conflict);
        foreach (var stale in new[] { new CanvasGraph(after.Nodes, []), new CanvasGraph(after.Nodes, [edge with { Order = 1 }]) })
            Reject(() => patch.Apply(stale, forward: false), Rejection.Conflict);
        Assert.Equal(("Original", "Renamed"), (Assert.Single(prior.Nodes).Text, Assert.Single(after.Nodes).Text));
        Assert.Same(edge, Assert.Single(after.Edges));
    }

    [Fact]
    public void RejectsMalformedNonCanonicalAndPartialCascadeFacts()
    {
        var note = Note(1, Geometry, "A");
        var another = Note(2, Geometry, "B");
        var edge = VisualEdge(3, note.Id, another.Id, 0);
        var prior = new CanvasGraph([note, another], [edge]);
        var wrongKind = ArticleRef(1, Geometry, 9);
        CanvasHistoryPatch[] invalid =
        [
            new(default, []),
            new([new(note.Id, note, note with { MemberIds = [] })], []),
            new([new(note.Id, note, another)], []),
            new([new(note.Id, note, wrongKind)], []),
            new([new(note.Id, note, null), new(note.Id, note, null)], []),
            new([new(another.Id, another, null), new(note.Id, note, null)], [new(edge.Id, edge, null)]),
            new([new(note.Id, note, null)], []),
        ];
        foreach (var patch in invalid) Reject(() => patch.Apply(prior, forward: true));
        Reject(() => CanvasHistoryPatch.Between(prior, new([wrongKind, another], [edge])));
    }

    [Fact]
    public void SerializedFactsRetainAbsenceStableIdsAndMembership()
    {
        var note = Note(1, Geometry, "Private note");
        var frame = Frame(2, Geometry, "Frame", [note.Id]);
        var edge = VisualEdge(3, note.Id, frame.Id, 0, "A link");
        var prior = new CanvasGraph([note, frame], [edge]);
        var after = prior.Apply([new CanvasGraphChange.RemoveNode(note.Id)]);
        var loaded = JsonSerializer.Deserialize<CanvasHistoryPatch>(JsonSerializer.SerializeToUtf8Bytes(CanvasHistoryPatch.Between(prior, after)));
        Assert.NotNull(loaded);
        Assert.Null(loaded.Nodes[0].After);
        Assert.Equal(note.Id, Assert.Single(loaded.Nodes[1].Before!.MemberIds));
        Assert.Equal(edge, Assert.Single(loaded.Edges).Before);
        var difference = CanvasHistoryPatch.Between(prior, loaded.Apply(after, forward: false));
        Assert.Empty(difference.Nodes);
        Assert.Empty(difference.Edges);
    }

    [Fact]
    public void ADeletionCanAffectMoreRowsThanAnOrdinaryCommandMayProvide()
    {
        var note = Note(1, Geometry, "Hub");
        var oldEdges = Enumerable.Range(2, CanvasGraph.MaxChanges + 1)
            .Select(index => VisualEdge(index, note.Id, note.Id, index)).ToImmutableArray();
        var prior = new CanvasGraph([note], oldEdges);
        var after = prior.Apply([new CanvasGraphChange.RemoveNode(note.Id)]);
        var patch = CanvasHistoryPatch.Between(prior, after);
        Assert.Equal(CanvasGraph.MaxChanges + 1, patch.Edges.Length);
        Assert.Equal(oldEdges.ToArray(), patch.Apply(after, forward: false).Edges.ToArray());
        Assert.Empty(patch.Apply(prior, forward: true).Edges);
    }
}
