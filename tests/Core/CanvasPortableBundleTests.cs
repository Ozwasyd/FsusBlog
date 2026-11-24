public sealed class CanvasPortableBundleTests
{
    private static readonly CanvasGeometry Geometry = new(-20, 20, 12_000, 8_000);
    private static readonly CanvasPortableViewport Viewport = new(1234, -5678, 2200);

    [Fact]
    public void ExportsAllGraphKindsWithoutLocalIdentityAndImportsWithExplicitMappings()
    {
        var nodes = new CanvasNode[]
        {
            new(Id(1), CanvasNodeKind.ArticleReference, Geometry, ArticleId: 715938),
            new(Id(2), CanvasNodeKind.HeadingReference, Geometry, ArticleId: 715938, Anchor: "heading", PinnedRevision: 81234281),
            new(Id(3), CanvasNodeKind.BlockReference, Geometry, ArticleId: 856392, Anchor: "block"),
            new(Id(4), CanvasNodeKind.PlainTextNote, Geometry, Text: "🚢 Note\r\nSecond line\rFinal"),
            new(Id(5), CanvasNodeKind.GroupFrame, Geometry, Text: "Group", MemberIds: [Id(4), Id(2)]),
        };
        var edges = new CanvasGraphEdge[]
        {
            new(Id(6), CanvasGraphEdgeKind.VisualOnly, Id(4), Id(4), 1, "Self-loop"),
            new(Id(7), CanvasGraphEdgeKind.ExplicitReferenceNote, Id(1), Id(2), 0, "Manual"),
        };
        var shuffled = new CanvasGraph(nodes.Reverse().ToImmutableArray(), edges.ToImmutableArray());
        var export = CanvasPortableBundle.Export("Portable survey", Viewport, 13, shuffled);
        var bytes = export.Encode();
        string text = Encoding.UTF8.GetString(bytes);
        Assert.DoesNotContain("715938", text);
        Assert.DoesNotContain("856392", text);
        Assert.DoesNotContain("81234281", text);
        foreach (var sourceId in nodes.Select(node => node.Id).Concat(edges.Select(edge => edge.Id)))
            Assert.DoesNotContain(sourceId.ToString(), text);

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
        Guid destination = Guid.NewGuid();
        var imported = migrated.Materialize(mapping, destination);
        var replay = migrated.Materialize(mapping, destination);
        Assert.Equal(imported.Nodes.Select(node => node.Id), replay.Nodes.Select(node => node.Id));
        Assert.Equal(imported.Edges.ToArray(), replay.Edges.ToArray());
        Assert.Equal(((int?)193, (long?)27), (imported.Nodes[1].ArticleId, imported.Nodes[1].PinnedRevision));
        Assert.Equal(nodes[3].Text, imported.Nodes[3].Text);
        Assert.Equal(new[] { imported.Nodes[3].Id, imported.Nodes[1].Id }, imported.Nodes[4].MemberIds.ToArray());
        Assert.Equal(imported.Nodes[1].Id, imported.Edges[0].TargetNodeId);
        Assert.Equal(imported.Edges[1].SourceNodeId, imported.Edges[1].TargetNodeId);
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
        var graph = new CanvasGraph([
            new(Id(1), CanvasNodeKind.ArticleReference, Geometry, ArticleId: 5),
            new(Id(2), CanvasNodeKind.ArticleReference, Geometry, ArticleId: 5, PinnedRevision: 6)
        ], []);
        var export = CanvasPortableBundle.Export("Mapping", Viewport, 18, graph);
        var bad = new Dictionary<int, CanvasPortableTarget>[]
        {
            [],
            new() { [1] = new(1, null), [3] = new(1, 2) },
            new() { [1] = new(1, null), [2] = new(1, null) },
            new() { [1] = new(1, 2), [2] = new(1, 2) },
            new() { [1] = new(-1, null), [2] = new(1, 2) },
            new() { [1] = new(1, null), [2] = new(1, 0) },
        };
        foreach (var mapping in bad)
            Assert.Equal(Rejection.Invalid, Assert.Throws<BusinessException>(() => export.Materialize(mapping, Guid.NewGuid())).Rejection);
    }

    [Fact]
    public void RejectsAChangedChecksumAndAValidDigestOverInvalidOrNoncanonicalPayload()
    {
        var graph = new CanvasGraph([
            new(Id(1), CanvasNodeKind.HeadingReference, Geometry, ArticleId: 5, Anchor: "title", PinnedRevision: 12),
            new(Id(2), CanvasNodeKind.PlainTextNote, Geometry, Text: "Ordinary note")
        ], [new(Id(3), CanvasGraphEdgeKind.VisualOnly, Id(1), Id(2), 0, null)]);
        var bundle = CanvasPortableBundle.Export("Metadata", Viewport, 9, graph);
        var payload = bundle.Encode();
        string text = Encoding.UTF8.GetString(payload);
        var altered = Encoding.UTF8.GetBytes(text.Replace("Ordinary note", "Different note", StringComparison.Ordinal));
        Assert.Throws<BusinessException>(() => CanvasPortableBundle.Decode(altered));

        string preimage = text[..text.IndexOf(",\"sha256\":", StringComparison.Ordinal)];
        Assert.Equal(bundle.Checksum, Digest(preimage));
        var invalid = new[]
        {
            preimage.Replace("authoring-canvas", "article-package", StringComparison.Ordinal),
            preimage.Replace("\"version\":1", "\"version\":2", StringComparison.Ordinal),
            preimage.Replace("\"version\":1", "\"version\":1,\"version\":1", StringComparison.Ordinal),
            preimage.Replace("\"encoding\":", "\"path\":\"../../outside\",\"encoding\":", StringComparison.Ordinal),
            preimage.Replace("\"encoding\":", "\"plugin\":{},\"encoding\":", StringComparison.Ordinal),
            preimage.Replace("\"sourceRevision\":9", "\"sourceRevision\":09", StringComparison.Ordinal),
            preimage.Replace("\"sourceRevision\":9", "\"sourceRevision\":9e0", StringComparison.Ordinal),
            preimage.Replace("\"title\":", "\"articleBody\":\"private\",\"title\":", StringComparison.Ordinal),
            preimage.Replace("Ordinary note", "<b>Markup</b>", StringComparison.Ordinal),
            preimage.Replace("Ordinary note", "\\u0000", StringComparison.Ordinal),
            preimage.Replace("Ordinary note", "\\uD800", StringComparison.Ordinal),
            preimage.Replace("Ordinary note", "Ordinary\\u0020note", StringComparison.Ordinal),
            preimage.Replace(",1,\"title\",true,", ",2,\"title\",true,", StringComparison.Ordinal),
            preimage.Replace(",1,\"title\",true,", ",1,\"Title\",true,", StringComparison.Ordinal),
            preimage.Replace("[0,1,2,0,null]", "[0,1,3,0,null]", StringComparison.Ordinal),
            preimage.Replace("[0,1,2,0,null]", "[9,1,2,0,null]", StringComparison.Ordinal),
            preimage.Replace("[1,-20,20,", "[9,-20,20,", StringComparison.Ordinal),
            preimage.Replace("8000,0,null,false,\"Ordinary note\",[]", "8000,0,null,false,\"Ordinary note\",[1]", StringComparison.Ordinal),
        };
        foreach (string variant in invalid)
        {
            Assert.NotEqual(preimage, variant);
            var raw = Encoding.UTF8.GetBytes(Seal(variant));
            Assert.Equal(Rejection.Invalid, Assert.Throws<BusinessException>(() => CanvasPortableBundle.Decode(raw)).Rejection);
        }

        byte[] leadingSpace = Encoding.UTF8.GetBytes($" {text}");
        byte[] trailingBytes = Encoding.UTF8.GetBytes($"{text}\n");
        Assert.Throws<BusinessException>(() => CanvasPortableBundle.Decode(leadingSpace));
        Assert.Throws<BusinessException>(() => CanvasPortableBundle.Decode(trailingBytes));
        Assert.Throws<BusinessException>(() => CanvasPortableBundle.Decode([0x50, 0x4b, 0x03, 0x04]));
        Assert.Throws<BusinessException>(() => CanvasPortableBundle.Decode(payload[..^4]));
    }

    [Fact]
    public void TenThousandNodesAndEdgesRoundTripWithinTheRawPackageLimit()
    {
        var graph = new CanvasGraph(Enumerable.Range(1, CanvasGraph.MaxNodes)
            .Select(index => new CanvasNode(Id(index), CanvasNodeKind.ArticleReference, Geometry, ArticleId: 2_000_000 + index))
            .ToImmutableArray(),
            Enumerable.Range(1, CanvasGraph.MaxEdges)
                .Select(index => new CanvasGraphEdge(Id(index + CanvasGraph.MaxNodes), CanvasGraphEdgeKind.ExplicitReferenceNote,
                    Id(index), Id(Math.Min(index + 1, CanvasGraph.MaxNodes)), index, null))
                .ToImmutableArray());
        var bundle = CanvasPortableBundle.Export("Full graph", Viewport, 8, graph);
        var bytes = bundle.Encode();
        Assert.InRange(bytes.Length, 1, CanvasPortableBundle.MaxBytes);
        var copies = CanvasPortableBundle.Decode(bytes);
        Assert.Equal((10_000, 10_000, 10_000), (copies.NodeCount, copies.EdgeCount, copies.References.Length));
        var targets = copies.References.ToDictionary(reference => reference.Slot, reference => new CanvasPortableTarget(reference.Slot, null));
        var local = copies.Materialize(targets, Guid.NewGuid());
        Assert.Equal((int?)10_000, local.Nodes[^1].ArticleId);
        Assert.Equal(local.Nodes[^1].Id, local.Edges[^1].TargetNodeId);
        Assert.Equal(bytes, CanvasPortableBundle.Export(copies.Title, copies.Viewport, copies.SourceRevision, local).Encode());
    }

    [Fact]
    public void EmptyGraphRoundTripsAndOversizeRawOrExpandedPackagesFailClosed()
    {
        var empty = CanvasPortableBundle.Decode(CanvasPortableBundle.Export("Empty", Viewport, 1, CanvasGraph.Empty).Encode());
        Assert.Empty(empty.Materialize(new Dictionary<int, CanvasPortableTarget>(), Guid.NewGuid()).Nodes);
        Assert.Throws<BusinessException>(() => CanvasPortableBundle.Decode(new byte[CanvasPortableBundle.MaxBytes + 1]));
        string note = new('x', CanvasGraph.MaxNoteLength);
        var large = new CanvasGraph(Enumerable.Range(1, 440)
            .Select(index => new CanvasNode(Id(index), CanvasNodeKind.PlainTextNote, Geometry, Text: note)).ToImmutableArray(), []);
        large.Validate();
        Assert.Throws<BusinessException>(() => CanvasPortableBundle.Export("Too much text", Viewport, 4, large));
        Assert.Throws<BusinessException>(() => CanvasPortableBundle.Export("Bad view", Viewport with { Zoom = 99 }, 1, CanvasGraph.Empty));
        Assert.Throws<BusinessException>(() => CanvasPortableBundle.Export("Bad revision", Viewport, 0, CanvasGraph.Empty));
        Assert.Throws<BusinessException>(() => CanvasPortableBundle.Export(new string('界', 86), Viewport, 1, CanvasGraph.Empty));
    }

    private static Guid Id(int index) => new(index, 0, 0, new byte[8]);
    private static string Digest(string input) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(input)));
    private static string Seal(string input) => $"{input},\"sha256\":\"{Digest(input)}\"}}";
}
