using static CanvasFixture;

public sealed class CanvasPortableBundleTests
{
    private static readonly CanvasGeometry Geometry = new(-20, 20, 12_000, 8_000);
    private static readonly CanvasPortableViewport Viewport = new(1234, -5678, 2200);

    [Fact]
    public void ExportsAllGraphKindsWithoutLocalIdentityAndImportsWithExplicitMappings()
    {
        CanvasNode[] nodes =
        [
            ArticleRef(1, Geometry, 715938),
            new(Id(2), CanvasNodeKind.HeadingReference, Geometry, ArticleId: 715938, Anchor: "heading", PinnedRevision: 81234281),
            new(Id(3), CanvasNodeKind.BlockReference, Geometry, ArticleId: 856392, Anchor: "block"),
            Note(4, Geometry, "🚢 Note\r\nSecond line\rFinal"),
            Frame(5, Geometry, "Group", [Id(4), Id(2)]),
        ];
        CanvasGraphEdge[] edges =
        [
            VisualEdge(6, Id(4), Id(4), 1, "Self-loop"),
            new(Id(7), CanvasGraphEdgeKind.ExplicitReferenceNote, Id(1), Id(2), 0, "Manual"),
        ];
        var export = CanvasPortableBundle.Export("Portable survey", Viewport, 13, new(nodes.Reverse().ToImmutableArray(), edges.ToImmutableArray()));
        var bytes = export.Encode();
        var text = Encoding.UTF8.GetString(bytes);
        foreach (var secret in new[] { "715938", "856392", "81234281" }.Concat(nodes.Select(n => n.Id.ToString())).Concat(edges.Select(e => e.Id.ToString())))
            Assert.DoesNotContain(secret, text);

        var migrated = CanvasPortableBundle.Decode(bytes);
        Assert.Equal((export.Title, Viewport, 13L, 5, 2, export.Checksum),
            (migrated.Title, migrated.Viewport, migrated.SourceRevision, migrated.NodeCount, migrated.EdgeCount, migrated.Checksum));
        Assert.Equal(new[]
        {
            new CanvasPortableReference(1, CanvasNodeKind.ArticleReference, null, false),
            new CanvasPortableReference(2, CanvasNodeKind.HeadingReference, "heading", true),
            new CanvasPortableReference(3, CanvasNodeKind.BlockReference, "block", false),
        }, migrated.References.ToArray());

        var mapping = new Dictionary<int, CanvasPortableTarget> { [1] = new(91, null), [2] = new(193, 27), [3] = new(49, null) };
        var destination = Guid.NewGuid();
        var imported = migrated.Materialize(mapping, destination);
        var replay = migrated.Materialize(mapping, destination);
        Assert.Equal(imported.Nodes.Select(node => node.Id), replay.Nodes.Select(node => node.Id));
        Assert.Equal(imported.Edges.ToArray(), replay.Edges.ToArray());
        Assert.Equal(((int?)193, (long?)27, nodes[3].Text), (imported.Nodes[1].ArticleId, imported.Nodes[1].PinnedRevision, imported.Nodes[3].Text));
        Assert.Equal(new[] { imported.Nodes[3].Id, imported.Nodes[1].Id }, imported.Nodes[4].MemberIds.ToArray());
        Assert.Equal((imported.Nodes[1].Id, imported.Edges[1].SourceNodeId), (imported.Edges[0].TargetNodeId, imported.Edges[1].TargetNodeId));
        Assert.Empty(imported.Nodes.Select(node => node.Id).Intersect(nodes.Select(node => node.Id)));

        var elsewhere = migrated.Materialize(mapping, Guid.NewGuid());
        Assert.Empty(imported.Nodes.Select(node => node.Id).Intersect(elsewhere.Nodes.Select(node => node.Id)));
        Assert.Empty(imported.Edges.Select(edge => edge.Id).Intersect(elsewhere.Edges.Select(edge => edge.Id)));
        Assert.Equal(bytes, CanvasPortableBundle.Export(migrated.Title, migrated.Viewport, migrated.SourceRevision, imported).Encode());
        Assert.Equal(bytes, CanvasPortableBundle.Export(migrated.Title, migrated.Viewport, migrated.SourceRevision,
            new(nodes.ToImmutableArray(), edges.Reverse().ToImmutableArray())).Encode());
    }

    [Fact]
    public void MappingMustCoverEverySlotAndMatchPinnedIntentExactly()
    {
        var export = CanvasPortableBundle.Export("Mapping", Viewport, 18, new([ArticleRef(1, Geometry, 5), ArticleRef(2, Geometry, 5, 6)], []));
        foreach (var mapping in new Dictionary<int, CanvasPortableTarget>[]
        {
            [],
            new() { [1] = new(1, null), [3] = new(1, 2) },
            new() { [1] = new(1, null), [2] = new(1, null) },
            new() { [1] = new(1, 2), [2] = new(1, 2) },
            new() { [1] = new(-1, null), [2] = new(1, 2) },
            new() { [1] = new(1, null), [2] = new(1, 0) },
        }) Reject(() => export.Materialize(mapping, Guid.NewGuid()));
    }

    [Fact]
    public void RejectsAChangedChecksumAndAValidDigestOverInvalidOrNoncanonicalPayload()
    {
        var graph = new CanvasGraph([
            new(Id(1), CanvasNodeKind.HeadingReference, Geometry, ArticleId: 5, Anchor: "title", PinnedRevision: 12),
            Note(2, Geometry, "Ordinary note")
        ], [VisualEdge(3, Id(1), Id(2), 0)]);
        var bundle = CanvasPortableBundle.Export("Metadata", Viewport, 9, graph);
        var payload = bundle.Encode();
        var text = Encoding.UTF8.GetString(payload);
        Reject(() => CanvasPortableBundle.Decode(Encoding.UTF8.GetBytes(text.Replace("Ordinary note", "Different note", StringComparison.Ordinal))));

        var preimage = text[..text.IndexOf(",\"sha256\":", StringComparison.Ordinal)];
        Assert.Equal(bundle.Checksum, Digest(preimage));
        foreach (var (from, to) in new[]
        {
            ("authoring-canvas", "article-package"),
            ("\"version\":1", "\"version\":2"),
            ("\"version\":1", "\"version\":1,\"version\":1"),
            ("\"encoding\":", "\"path\":\"../../outside\",\"encoding\":"),
            ("\"encoding\":", "\"plugin\":{},\"encoding\":"),
            ("\"sourceRevision\":9", "\"sourceRevision\":09"),
            ("\"sourceRevision\":9", "\"sourceRevision\":9e0"),
            ("\"title\":", "\"articleBody\":\"private\",\"title\":"),
            ("Ordinary note", "<b>Markup</b>"),
            ("Ordinary note", "\\u0000"),
            ("Ordinary note", "\\uD800"),
            ("Ordinary note", "Ordinary\\u0020note"),
            (",1,\"title\",true,", ",2,\"title\",true,"),
            (",1,\"title\",true,", ",1,\"Title\",true,"),
            ("[0,1,2,0,null]", "[0,1,3,0,null]"),
            ("[0,1,2,0,null]", "[9,1,2,0,null]"),
            ("[1,-20,20,", "[9,-20,20,"),
            ("8000,0,null,false,\"Ordinary note\",[]", "8000,0,null,false,\"Ordinary note\",[1]"),
        })
        {
            var variant = preimage.Replace(from, to, StringComparison.Ordinal);
            Assert.NotEqual(preimage, variant);
            Reject(() => CanvasPortableBundle.Decode(Encoding.UTF8.GetBytes($"{variant},\"sha256\":\"{Digest(variant)}\"}}")));
        }

        foreach (var malformed in new[] { Encoding.UTF8.GetBytes($" {text}"), Encoding.UTF8.GetBytes($"{text}\n"), [0x50, 0x4b, 0x03, 0x04], payload[..^4] })
            Reject(() => CanvasPortableBundle.Decode(malformed));
    }

    [Fact]
    public void TenThousandNodesAndEdgesRoundTripWithinTheRawPackageLimit()
    {
        var graph = new CanvasGraph(
            Enumerable.Range(1, CanvasGraph.MaxNodes).Select(index => ArticleRef(index, Geometry, 2_000_000 + index)).ToImmutableArray(),
            Enumerable.Range(1, CanvasGraph.MaxEdges).Select(index => new CanvasGraphEdge(Id(index + CanvasGraph.MaxNodes),
                CanvasGraphEdgeKind.ExplicitReferenceNote, Id(index), Id(Math.Min(index + 1, CanvasGraph.MaxNodes)), index, null)).ToImmutableArray());
        var bytes = CanvasPortableBundle.Export("Full graph", Viewport, 8, graph).Encode();
        Assert.InRange(bytes.Length, 1, CanvasPortableBundle.MaxBytes);
        var copies = CanvasPortableBundle.Decode(bytes);
        Assert.Equal((10_000, 10_000, 10_000), (copies.NodeCount, copies.EdgeCount, copies.References.Length));
        var local = copies.Materialize(copies.References.ToDictionary(r => r.Slot, r => new CanvasPortableTarget(r.Slot, null)), Guid.NewGuid());
        Assert.Equal(((int?)10_000, local.Nodes[^1].Id), (local.Nodes[^1].ArticleId, local.Edges[^1].TargetNodeId));
        Assert.Equal(bytes, CanvasPortableBundle.Export(copies.Title, copies.Viewport, copies.SourceRevision, local).Encode());
    }

    [Fact]
    public void EmptyGraphRoundTripsAndOversizeRawOrExpandedPackagesFailClosed()
    {
        var empty = CanvasPortableBundle.Decode(CanvasPortableBundle.Export("Empty", Viewport, 1, CanvasGraph.Empty).Encode());
        Assert.Empty(empty.Materialize(new Dictionary<int, CanvasPortableTarget>(), Guid.NewGuid()).Nodes);
        Reject(() => CanvasPortableBundle.Decode(new byte[CanvasPortableBundle.MaxBytes + 1]));
        var note = new string('x', CanvasGraph.MaxNoteLength);
        var large = new CanvasGraph(Enumerable.Range(1, 440).Select(index => Note(index, Geometry, note)).ToImmutableArray(), []);
        large.Validate();
        Reject(() => CanvasPortableBundle.Export("Too much text", Viewport, 4, large));
        Reject(() => CanvasPortableBundle.Export("Bad view", Viewport with { Zoom = 99 }, 1, CanvasGraph.Empty));
        Reject(() => CanvasPortableBundle.Export("Bad revision", Viewport, 0, CanvasGraph.Empty));
        Reject(() => CanvasPortableBundle.Export(new string('界', 86), Viewport, 1, CanvasGraph.Empty));
    }

    private static string Digest(string input) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(input)));
}
