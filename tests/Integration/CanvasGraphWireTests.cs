namespace FsusBlog.V2.Integration.Tests;

public sealed class CanvasGraphWireTests
{
    [Fact]
    public void SharedGraphVectorsPreserveFiveNodeKindsExactRevisionsAndPageCoordinates()
    {
        static Guid Id(int value) => Guid.Parse($"7a7a7a7a-0000-4000-8000-{value:D12}");
        const long revision = 9_007_199_254_740_993;

        var commandVector = Fixture("canvas-graph-command");
        var command = Wire.DecodeCanvasGraphCommand(commandVector);
        if (command.Id != Id(1) || command.CommandId != Id(2) || command.ExpectedRevision != revision ||
            command.Action != CanvasGraphAction.Edit || command.Title != "Private graph 🐈" ||
            command.Viewport != new CanvasViewport(-300, 400, 1250) || command.Changes.Count != 7 ||
            command.Changes[0] is not CanvasChangeFrame.PutNode({ Kind: 3, Text: "note\n行" }) ||
            command.Changes[1] is not CanvasChangeFrame.PutNode({ Kind: 4, Text: "Review", MemberIds: [var member] }) || member != Id(3) ||
            command.Changes[2] is not CanvasChangeFrame.PutNode({ Kind: 0, ArticleId: 17, PinnedRevision: revision }) ||
            command.Changes[3] is not CanvasChangeFrame.PutNode({ Kind: 1, ArticleId: 17, PinnedRevision: null, Anchor: "stable-anchor" }) ||
            command.Changes[4] is not CanvasChangeFrame.PutNode({ Kind: 2, ArticleId: 18, PinnedRevision: 1, Anchor: "sub-block" }) ||
            command.Changes[5] is not CanvasChangeFrame.PutEdge({ Kind: 1, SourceNodeId: var source, TargetNodeId: var target, Label: "Cite" }) ||
            source != Id(5) || target != Id(6) || command.Changes[6] != new CanvasChangeFrame.DropEdge(Id(8)))
            throw new InvalidOperationException("Canvas graph command differs from independent structural vector.");
        Equal(commandVector, Wire.EncodeCanvasGraphCommand(command));

        var nodeBytes = Fixture("canvas-graph-page-node");
        var nodePage = Wire.DecodeCanvasGraphPage(nodeBytes);
        if (nodePage.Document.Id != Id(1) || nodePage.Document.Revision != revision || nodePage.NextOffset != 1 ||
            nodePage.Nodes is not [{ Kind: 4, Text: "Review" }] || nodePage.Edges.Count != 0)
            throw new InvalidOperationException("Canvas graph node page differs from independent vector.");
        Equal(nodeBytes, Wire.EncodeCanvasGraphPage(nodePage));

        var edgeBytes = Fixture("canvas-graph-page-edge");
        var edgePage = Wire.DecodeCanvasGraphPage(edgeBytes);
        if (edgePage.Document != nodePage.Document || edgePage.NextOffset != -1 || edgePage.Nodes.Count != 0 ||
            edgePage.Edges is not [{ Label: "Cite" }])
            throw new InvalidOperationException("Canvas graph edge page differs from independent vector.");
        Equal(edgeBytes, Wire.EncodeCanvasGraphPage(edgePage));

        Assert.Throws<ProtocolException>(() => Wire.DecodeCanvasGraphPage(nodeBytes.AsSpan(0, nodeBytes.Length - 1)));
    }

    [Theory]
    [InlineData(CanvasGraphAction.Undo, "canvas-graph-undo")]
    [InlineData(CanvasGraphAction.Redo, "canvas-graph-redo")]
    public void SharedHistoryCommandVectorsUseReservedGapsAndRejectEditFields(CanvasGraphAction action, string fixture)
    {
        var bytes = Fixture(fixture);
        var command = Wire.DecodeCanvasGraphCommand(bytes);
        Assert.Equal((action, 9_007_199_254_740_993L, Guid.Parse("7a7a7a7a-0000-4000-8000-000000000001"),
            Guid.Parse("7a7a7a7a-0000-4000-8000-000000000002")), (command.Action, command.ExpectedRevision, command.Id, command.CommandId));
        Equal(bytes, Wire.EncodeCanvasGraphCommand(command));

        var edit = command with { Action = CanvasGraphAction.Edit, Title = "Changed" };
        foreach (var bad in new[]
        {
            command with { ExpectedRevision = 0 }, edit with { Action = action },
            command with { Viewport = new(0, 0, 1000) },
            command with { Changes = [new CanvasChangeFrame.DropNode(command.Id)] }
        })
            Assert.Throws<ProtocolException>(() => Wire.EncodeCanvasGraphCommand(bad));

        var payload = Aeds.Decode(Wire.EncodeCanvasGraphCommand(edit), FrameType.CanvasGraphCommand).ToArray();
        const int actionOffset = 16 + 16 + sizeof(long);
        foreach (var tag in new[] { 3, 4, (int)action })
        {
            BinaryPrimitives.WriteInt32LittleEndian(payload.AsSpan(actionOffset), tag);
            Assert.Throws<ProtocolException>(() => Wire.DecodeCanvasGraphCommand(Aeds.Encode(FrameType.CanvasGraphCommand, payload)));
        }
    }

    [Fact]
    public void HistoryReadsOnlyExactPositiveRevisionsAndZeroSentinels()
    {
        const long revision = 9_007_199_254_740_993;
        var fixture = Fixture("canvas-graph-history");
        var history = Wire.DecodeCanvasGraphHistory(fixture);
        Assert.Equal(new CanvasGraphHistory(revision, revision, null), history);
        Equal(fixture, Wire.EncodeCanvasGraphHistory(history));
        var afterUndo = new CanvasGraphHistory(revision + 1, null, revision);
        Assert.Equal(afterUndo, Wire.DecodeCanvasGraphHistory(Wire.EncodeCanvasGraphHistory(afterUndo)));
        foreach (var bad in new[]
        {
            history with { Revision = 0 }, history with { UndoRevision = 0 },
            history with { RedoRevision = revision }, history with { UndoRevision = revision + 1 }
        })
            Assert.Throws<ProtocolException>(() => Wire.EncodeCanvasGraphHistory(bad));

        var payload = Aeds.Decode(fixture, FrameType.CanvasGraphHistory).ToArray();
        BinaryPrimitives.WriteInt64LittleEndian(payload.AsSpan(sizeof(long) * 2), -1);
        Assert.Throws<ProtocolException>(() => Wire.DecodeCanvasGraphHistory(Aeds.Encode(FrameType.CanvasGraphHistory, payload)));
        Assert.Throws<ProtocolException>(() => Wire.DecodeCanvasGraphHistory(Aeds.Encode(FrameType.CanvasGraphHistory, payload.AsSpan(0, 16))));
    }

    [Fact]
    public void SharedReferenceResolutionVectorsKeepPrivateStatesEmptyAndOffsetZero()
    {
        var canvas = Guid.Parse("7a7a7a7a-0000-4000-8000-000000000001");
        var node = Guid.Parse("7a7a7a7a-0000-4000-8000-000000000006");
        const long revision = 9_007_199_254_740_993;
        var resolved = new CanvasReferenceResolution(canvas, node, revision, CanvasReferenceState.Resolved,
            17, revision + 1, true, "Draft title 猫", "Heading\nPlain excerpt", 0);
        var unavailable = new CanvasReferenceResolution(canvas, node, revision, CanvasReferenceState.Unavailable,
            null, null, false, null, null, null);
        var missing = resolved with { State = CanvasReferenceState.MissingAnchor, Pinned = false, Excerpt = null, SourceOffset = null };
        foreach (var (name, value) in new[] { ("resolved", resolved), ("unavailable", unavailable), ("missing", missing) })
        {
            var bytes = Fixture("canvas-reference-" + name);
            Assert.Equal(value, Wire.DecodeCanvasReferenceResolution(bytes));
            Equal(bytes, Wire.EncodeCanvasReferenceResolution(value));
        }

        foreach (var state in new[] { CanvasReferenceState.Unavailable, CanvasReferenceState.StaleRevision })
        {
            var hidden = unavailable with { State = state };
            foreach (var bad in new[]
            {
                hidden with { ArticleId = 17 }, hidden with { ArticleRevision = revision }, hidden with { Pinned = true },
                hidden with { Title = "Sensitive title" }, hidden with { Excerpt = "Sensitive text", SourceOffset = 0 }
            })
                Assert.Throws<ProtocolException>(() => Wire.EncodeCanvasReferenceResolution(bad));
            var payload = Aeds.Decode(Fixture("canvas-reference-resolved"), FrameType.CanvasReferenceResolution).ToArray();
            BinaryPrimitives.WriteInt32LittleEndian(payload.AsSpan(16 + 16 + sizeof(long)), (int)state);
            Assert.Throws<ProtocolException>(() => Wire.DecodeCanvasReferenceResolution(Aeds.Encode(FrameType.CanvasReferenceResolution, payload)));
        }

        foreach (var state in new[] { CanvasReferenceState.MissingAnchor, CanvasReferenceState.DuplicateAnchor })
        {
            var unresolved = missing with { State = state };
            Assert.Equal(unresolved, Wire.DecodeCanvasReferenceResolution(Wire.EncodeCanvasReferenceResolution(unresolved)));
            Assert.Throws<ProtocolException>(() => Wire.EncodeCanvasReferenceResolution(unresolved with { SourceOffset = 0 }));
        }
        foreach (var valid in new[] { resolved with { Excerpt = null, SourceOffset = null }, resolved with { Excerpt = null } })
            Assert.Equal(valid, Wire.DecodeCanvasReferenceResolution(Wire.EncodeCanvasReferenceResolution(valid)));
        foreach (var bad in new[]
        {
            resolved with { SourceOffset = null }, resolved with { SourceOffset = -2 },
            resolved with { Title = "\nBad title" }, resolved with { Excerpt = new string('猫', 257) }
        })
            Assert.Throws<ProtocolException>(() => Wire.EncodeCanvasReferenceResolution(bad));
    }

    private static void Equal(ReadOnlySpan<byte> expected, ReadOnlySpan<byte> actual) =>
        Assert.True(expected.SequenceEqual(actual), "Canvas graph AEDS bytes differ.");

    private static byte[] Fixture(string name) => CanvasFixture.ProtocolFixture(name);
}
