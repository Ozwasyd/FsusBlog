using static CanvasFixture;

internal static class CanvasFixture
{
    internal static Guid Id(int n) => new(n, 0, 0, new byte[8]);
    internal static void Reject(Action act, Rejection expected = Rejection.Invalid) => Assert.Equal(expected, Assert.Throws<BusinessException>(act).Rejection);
    internal static CanvasNode Note(int id, CanvasGeometry g, string text) => new(Id(id), CanvasNodeKind.PlainTextNote, g, Text: text);
    internal static CanvasNode ArticleRef(int id, CanvasGeometry g, int articleId, long? pinned = null) =>
        new(Id(id), CanvasNodeKind.ArticleReference, g, ArticleId: articleId, PinnedRevision: pinned);
    internal static CanvasNode Frame(int id, CanvasGeometry g, string text, ImmutableArray<Guid> members) =>
        new(Id(id), CanvasNodeKind.GroupFrame, g, Text: text, MemberIds: members);
    internal static CanvasGraphEdge VisualEdge(int id, Guid source, Guid target, int order, string? label = null) =>
        new(Id(id), CanvasGraphEdgeKind.VisualOnly, source, target, order, label);
    internal static CanvasGraphChange.UpsertNode Upsert(CanvasNode node) => new(node);
}

public sealed class CanvasGraphTests
{
    private static readonly CanvasGeometry Geometry = new(-100, 200, 16_000, 9_000);

    [Fact]
    public void SnapshotAdmitsExactlyThePinnedKindsAndImmutableStableCoordinates()
    {
        CanvasNode[] nodes =
        [
            ArticleRef(1, Geometry, 91),
            new(Id(2), CanvasNodeKind.HeadingReference, Geometry, ArticleId: 91, Anchor: "title-2", PinnedRevision: 10),
            new(Id(3), CanvasNodeKind.BlockReference, Geometry, ArticleId: 10, Anchor: "quote"),
            Note(4, Geometry, "A note\nwith tabs\tand Unicode 🐈."),
            Frame(5, Geometry, "Loose collection", [Id(1), Id(4)]),
        ];
        var visual = VisualEdge(10, Id(4), Id(4), 1);
        var reference = new CanvasGraphEdge(Id(11), CanvasGraphEdgeKind.ExplicitReferenceNote, Id(1), Id(2), 0, "For later");
        var graph = CanvasGraph.Empty.Apply([.. nodes.Select(Upsert), new CanvasGraphChange.UpsertEdge(visual), new CanvasGraphChange.UpsertEdge(reference)]);
        graph.Validate();
        Assert.Equal(nodes, graph.Nodes);
        Assert.Equal(new[] { reference, visual }, graph.Edges);
        Assert.Empty(CanvasGraph.Empty.Nodes);
        Assert.Empty(CanvasGraph.Empty.Edges);
    }

    [Fact]
    public void InvalidKindsCoordinatesAndCrossTypeFieldsAreRejectedBeforeApplyingAnything()
    {
        var valid = Note(1, Geometry, "Private note");
        CanvasNode[] invalid =
        [
            valid with { Kind = (CanvasNodeKind)5 }, valid with { Id = Guid.Empty },
            valid with { Text = "<em>Rich text</em>" }, valid with { Text = "Bad\u0001control" },
            valid with { Text = new string('a', CanvasGraph.MaxNoteLength + 1) }, valid with { Text = "\uD800" },
            valid with { Geometry = Geometry with { X = int.MinValue } }, valid with { Geometry = Geometry with { Width = 2_399 } },
            valid with { ArticleId = 99 }, valid with { MemberIds = [Id(2)] },
            new(Id(2), CanvasNodeKind.ArticleReference, Geometry, ArticleId: 91, Anchor: "not-allowed"),
            new(Id(2), CanvasNodeKind.ArticleReference, Geometry, ArticleId: 91, PinnedRevision: 0),
            new(Id(2), CanvasNodeKind.HeadingReference, Geometry, ArticleId: 91, Anchor: "Capital"),
            new(Id(2), CanvasNodeKind.BlockReference, Geometry, ArticleId: 91, Anchor: "valid-looking\n"),
            new(Id(2), CanvasNodeKind.BlockReference, Geometry, ArticleId: 91),
        ];

        foreach (var node in invalid) Reject(() => CanvasGraph.Empty.Apply([Upsert(node)]));
        var store = CanvasGraph.Empty.Apply([Upsert(valid)]);
        Reject(() => store.Apply([Upsert(valid with { Kind = CanvasNodeKind.ArticleReference, ArticleId = 1, Text = null })]));
        Assert.Same(valid, Assert.Single(store.Nodes));
    }

    [Fact]
    public void ApplyOrderRequiresCurrentMembershipAndEdgesAndRemovesIncidentStateTogether()
    {
        var note = Note(1, Geometry, "A");
        var article = ArticleRef(2, Geometry, 51);
        var frame = Frame(3, Geometry, "Frame", [note.Id, article.Id]);
        var edge = VisualEdge(4, note.Id, article.Id, 0);
        Reject(() => CanvasGraph.Empty.Apply([new CanvasGraphChange.UpsertEdge(edge), Upsert(note), Upsert(article)]));
        var initial = CanvasGraph.Empty.Apply([Upsert(note), Upsert(article), Upsert(frame), new CanvasGraphChange.UpsertEdge(edge)]);
        foreach (var members in new ImmutableArray<Guid>[] { [frame.Id], [Id(9)], [note.Id, note.Id] })
            Reject(() => initial.Apply([Upsert(frame with { MemberIds = members })]));
        Reject(() => initial.Apply([Upsert(Frame(5, Geometry, "Nested", [frame.Id]))]));

        var removed = initial.Apply([new CanvasGraphChange.RemoveNode(note.Id)]);
        Assert.Empty(removed.Edges);
        Assert.Equal(article.Id, Assert.Single(removed.Nodes.Single(node => node.Id == frame.Id).MemberIds));
        Assert.Equal(note.Id, Assert.Single(initial.Edges).SourceNodeId);
        Assert.Equal(new[] { note.Id, article.Id }, initial.Nodes.Single(node => node.Id == frame.Id).MemberIds);
        Reject(() => initial.Apply([new CanvasGraphChange.RemoveNode(note.Id), Upsert(note)]));
    }

    [Fact]
    public void RecordAndCommandBudgetsDoNotTruncate()
    {
        var nodes = Enumerable.Range(1, CanvasGraph.MaxNodes).Select(index => ArticleRef(index, Geometry, index)).ToImmutableArray();
        var full = new CanvasGraph(nodes, []);
        full.Validate();
        Reject(() => full.Apply([Upsert(ArticleRef(CanvasGraph.MaxNodes + 1, Geometry, 999))]));
        var limit = new CanvasGraphChange[CanvasGraph.MaxChanges + 1];
        Array.Fill(limit, Upsert(nodes[0]));
        Reject(() => full.Apply(limit));
        Reject(() => full.Apply([]));
        Reject(() => new CanvasGraph([nodes[0], nodes[0]], []).Validate());

        var memberships = nodes.Take(1_000).Select(node => node.Id).ToImmutableArray();
        var crowded = new CanvasGraph(nodes.Take(1_000).Concat(Enumerable.Range(1_001, 100)
            .Select(index => Frame(index, Geometry, "Frame", memberships))).ToImmutableArray(), []);
        crowded.Validate();
        Reject(() => crowded.Apply([Upsert(Frame(1_101, Geometry, "Overflow", [nodes[0].Id]))]));

        var note = new string('é', CanvasGraph.MaxNoteLength);
        int maxNotes = CanvasGraph.MaxContentBytes / (note.Length * 2);
        var notes = Enumerable.Range(1, maxNotes).Select(index => Note(index, Geometry, note)).ToImmutableArray();
        var fullOfText = new CanvasGraph(notes, []);
        var newNote = Upsert(Note(maxNotes + 1, Geometry, "a"));
        fullOfText.Validate();
        Reject(() => fullOfText.Apply([newNote]));
        Assert.Equal(maxNotes, fullOfText.Apply([new CanvasGraphChange.RemoveNode(notes[0].Id), newNote]).Nodes.Length);
    }
}
