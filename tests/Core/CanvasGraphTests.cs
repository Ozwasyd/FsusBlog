public sealed class CanvasGraphTests
{
    private static readonly CanvasGeometry Geometry = new(-100, 200, 16_000, 9_000);
    private static Guid Id(int n) => new(n, 0, 0, new byte[8]);

    [Fact]
    public void SnapshotAdmitsExactlyThePinnedKindsAndImmutableStableCoordinates()
    {
        var nodes = new CanvasNode[]
        {
            new(Id(1), CanvasNodeKind.ArticleReference, Geometry, ArticleId: 91),
            new(Id(2), CanvasNodeKind.HeadingReference, Geometry, ArticleId: 91, Anchor: "title-2", PinnedRevision: 10),
            new(Id(3), CanvasNodeKind.BlockReference, Geometry, ArticleId: 10, Anchor: "quote"),
            new(Id(4), CanvasNodeKind.PlainTextNote, Geometry, Text: "A note\nwith tabs\tand Unicode 🐈."),
            new(Id(5), CanvasNodeKind.GroupFrame, Geometry, Text: "Loose collection", MemberIds: [Id(1), Id(4)]),
        };
        var visual = new CanvasGraphEdge(Id(10), CanvasGraphEdgeKind.VisualOnly, Id(4), Id(4), 1);
        var reference = new CanvasGraphEdge(Id(11), CanvasGraphEdgeKind.ExplicitReferenceNote, Id(1), Id(2), 0, "For later");
        var graph = CanvasGraph.Empty.Apply([
            .. nodes.Select(node => new CanvasGraphChange.UpsertNode(node)),
            new CanvasGraphChange.UpsertEdge(visual),
            new CanvasGraphChange.UpsertEdge(reference),
        ]);

        graph.Validate();
        Assert.Equal(nodes, graph.Nodes);
        Assert.Equal(new[] { reference, visual }, graph.Edges);
        Assert.Empty(CanvasGraph.Empty.Nodes);
        Assert.Empty(CanvasGraph.Empty.Edges);
    }

    [Fact]
    public void InvalidKindsCoordinatesAndCrossTypeFieldsAreRejectedBeforeApplyingAnything()
    {
        var valid = new CanvasNode(Id(1), CanvasNodeKind.PlainTextNote, Geometry, Text: "Private note");
        var invalid = new[]
        {
            valid with { Kind = (CanvasNodeKind)5 },
            valid with { Id = Guid.Empty },
            valid with { Text = "<em>Rich text</em>" },
            valid with { Text = "Bad\u0001control" },
            valid with { Text = new string('a', CanvasGraph.MaxNoteLength + 1) },
            valid with { Text = "\uD800" },
            valid with { Geometry = Geometry with { X = int.MinValue } },
            valid with { Geometry = Geometry with { Width = 2_399 } },
            valid with { ArticleId = 99 },
            valid with { MemberIds = [Id(2)] },
            new(Id(2), CanvasNodeKind.ArticleReference, Geometry, ArticleId: 91, Anchor: "not-allowed"),
            new(Id(2), CanvasNodeKind.ArticleReference, Geometry, ArticleId: 91, PinnedRevision: 0),
            new(Id(2), CanvasNodeKind.HeadingReference, Geometry, ArticleId: 91, Anchor: "Capital"),
            new(Id(2), CanvasNodeKind.BlockReference, Geometry, ArticleId: 91, Anchor: "valid-looking\n"),
            new(Id(2), CanvasNodeKind.BlockReference, Geometry, ArticleId: 91),
        };

        foreach (var node in invalid)
            Assert.Equal(Rejection.Invalid, Assert.Throws<BusinessException>(() =>
                CanvasGraph.Empty.Apply([new CanvasGraphChange.UpsertNode(node)])).Rejection);
        var store = CanvasGraph.Empty.Apply([new CanvasGraphChange.UpsertNode(valid)]);
        Assert.Equal(Rejection.Invalid, Assert.Throws<BusinessException>(() =>
            store.Apply([new CanvasGraphChange.UpsertNode(valid with { Kind = CanvasNodeKind.ArticleReference, ArticleId = 1, Text = null })])).Rejection);
        Assert.Same(valid, Assert.Single(store.Nodes));
    }

    [Fact]
    public void ApplyOrderRequiresCurrentMembershipAndEdgesAndRemovesIncidentStateTogether()
    {
        var note = new CanvasNode(Id(1), CanvasNodeKind.PlainTextNote, Geometry, Text: "A");
        var article = new CanvasNode(Id(2), CanvasNodeKind.ArticleReference, Geometry, ArticleId: 51);
        var frame = new CanvasNode(Id(3), CanvasNodeKind.GroupFrame, Geometry, Text: "Frame", MemberIds: [note.Id, article.Id]);
        var edge = new CanvasGraphEdge(Id(4), CanvasGraphEdgeKind.VisualOnly, note.Id, article.Id, 0);
        Assert.Throws<BusinessException>(() => CanvasGraph.Empty.Apply([
            new CanvasGraphChange.UpsertEdge(edge), new CanvasGraphChange.UpsertNode(note), new CanvasGraphChange.UpsertNode(article),
        ]));
        var initial = CanvasGraph.Empty.Apply([
            new CanvasGraphChange.UpsertNode(note), new CanvasGraphChange.UpsertNode(article),
            new CanvasGraphChange.UpsertNode(frame), new CanvasGraphChange.UpsertEdge(edge),
        ]);
        foreach (var members in new ImmutableArray<Guid>[] { [frame.Id], [Id(9)], [note.Id, note.Id] })
            Assert.Throws<BusinessException>(() => initial.Apply([new CanvasGraphChange.UpsertNode(frame with { MemberIds = members })]));
        Assert.Throws<BusinessException>(() => initial.Apply([
            new CanvasGraphChange.UpsertNode(new(Id(5), CanvasNodeKind.GroupFrame, Geometry, Text: "Nested", MemberIds: [frame.Id])),
        ]));

        var removed = initial.Apply([new CanvasGraphChange.RemoveNode(note.Id)]);
        Assert.Empty(removed.Edges);
        Assert.Equal(article.Id, Assert.Single(removed.Nodes.Single(node => node.Id == frame.Id).MemberIds));
        Assert.Equal(note.Id, Assert.Single(initial.Edges).SourceNodeId);
        Assert.Equal(new[] { note.Id, article.Id }, initial.Nodes.Single(node => node.Id == frame.Id).MemberIds);
        Assert.Throws<BusinessException>(() => initial.Apply([
            new CanvasGraphChange.RemoveNode(note.Id), new CanvasGraphChange.UpsertNode(note),
        ]));
    }

    [Fact]
    public void RecordAndCommandBudgetsDoNotTruncate()
    {
        var nodes = Enumerable.Range(1, CanvasGraph.MaxNodes)
            .Select(index => new CanvasNode(Id(index), CanvasNodeKind.ArticleReference, Geometry, ArticleId: index))
            .ToImmutableArray();
        var full = new CanvasGraph(nodes, []);
        full.Validate();
        Assert.Throws<BusinessException>(() => full.Apply([
            new CanvasGraphChange.UpsertNode(new(Id(CanvasGraph.MaxNodes + 1), CanvasNodeKind.ArticleReference, Geometry, ArticleId: 999)),
        ]));
        var limit = new CanvasGraphChange[CanvasGraph.MaxChanges + 1];
        Array.Fill(limit, new CanvasGraphChange.UpsertNode(nodes[0]));
        Assert.Throws<BusinessException>(() => full.Apply(limit));
        Assert.Throws<BusinessException>(() => full.Apply([]));
        Assert.Throws<BusinessException>(() => new CanvasGraph([nodes[0], nodes[0]], []).Validate());

        var memberships = nodes.Take(1_000).Select(node => node.Id).ToImmutableArray();
        var crowdedNodes = nodes.Take(1_000).Concat(Enumerable.Range(1_001, 100).Select(index =>
            new CanvasNode(Id(index), CanvasNodeKind.GroupFrame, Geometry, Text: "Frame", MemberIds: memberships))).ToImmutableArray();
        var crowded = new CanvasGraph(crowdedNodes, []);
        crowded.Validate();
        Assert.Throws<BusinessException>(() => crowded.Apply([
            new CanvasGraphChange.UpsertNode(new(Id(1_101), CanvasNodeKind.GroupFrame, Geometry, Text: "Overflow", MemberIds: [nodes[0].Id])),
        ]));

        var note = new string('é', CanvasGraph.MaxNoteLength);
        int maxNotes = CanvasGraph.MaxContentBytes / (note.Length * 2);
        var notes = Enumerable.Range(1, maxNotes)
            .Select(index => new CanvasNode(Id(index), CanvasNodeKind.PlainTextNote, Geometry, Text: note))
            .ToImmutableArray();
        var fullOfText = new CanvasGraph(notes, []);
        var newNote = new CanvasGraphChange.UpsertNode(new(Id(maxNotes + 1), CanvasNodeKind.PlainTextNote, Geometry, Text: "a"));
        fullOfText.Validate();
        Assert.Throws<BusinessException>(() => fullOfText.Apply([newNote]));
        Assert.Equal(maxNotes, fullOfText.Apply([new CanvasGraphChange.RemoveNode(notes[0].Id), newNote]).Nodes.Length);
    }
}
