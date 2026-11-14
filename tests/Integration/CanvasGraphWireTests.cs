using System.Buffers.Binary;
using FsusBlog.V2.Contracts;

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
        Assert.Equal(action, command.Action);
        Assert.Equal(9_007_199_254_740_993, command.ExpectedRevision);
        Assert.Equal(Guid.Parse("7a7a7a7a-0000-4000-8000-000000000001"), command.Id);
        Assert.Equal(Guid.Parse("7a7a7a7a-0000-4000-8000-000000000002"), command.CommandId);
        Equal(bytes, Wire.EncodeCanvasGraphCommand(command));

        Assert.Throws<ProtocolException>(() => Wire.EncodeCanvasGraphCommand(command with { ExpectedRevision = 0 }));
        var edit = command with { Action = CanvasGraphAction.Edit, Title = "Changed" };
        Assert.Throws<ProtocolException>(() => Wire.EncodeCanvasGraphCommand(edit with { Action = action }));
        Assert.Throws<ProtocolException>(() => Wire.EncodeCanvasGraphCommand(command with { Viewport = new(0, 0, 1000) }));
        Assert.Throws<ProtocolException>(() => Wire.EncodeCanvasGraphCommand(command with
        {
            Changes = [new CanvasChangeFrame.DropNode(command.Id)]
        }));

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
        Assert.Throws<ProtocolException>(() => Wire.EncodeCanvasGraphHistory(history with { Revision = 0 }));
        Assert.Throws<ProtocolException>(() => Wire.EncodeCanvasGraphHistory(history with { UndoRevision = 0 }));
        Assert.Throws<ProtocolException>(() => Wire.EncodeCanvasGraphHistory(history with { RedoRevision = revision }));
        Assert.Throws<ProtocolException>(() => Wire.EncodeCanvasGraphHistory(history with { UndoRevision = revision + 1 }));

        var payload = Aeds.Decode(fixture, FrameType.CanvasGraphHistory).ToArray();
        BinaryPrimitives.WriteInt64LittleEndian(payload.AsSpan(sizeof(long) * 2), -1);
        Assert.Throws<ProtocolException>(() => Wire.DecodeCanvasGraphHistory(Aeds.Encode(FrameType.CanvasGraphHistory, payload)));
        Assert.Throws<ProtocolException>(() => Wire.DecodeCanvasGraphHistory(Aeds.Encode(FrameType.CanvasGraphHistory, payload.AsSpan(0, 16))));
    }

    private static void Equal(ReadOnlySpan<byte> expected, ReadOnlySpan<byte> actual)
    {
        Assert.True(expected.SequenceEqual(actual), "Canvas graph AEDS bytes differ.");
    }

    private static byte[] Fixture(string name)
    {
        for (var at = new DirectoryInfo(AppContext.BaseDirectory); at is not null; at = at.Parent)
        {
            var path = Path.Combine(at.FullName, "tests", "Protocol", "fixtures", name + ".hex");
            if (File.Exists(path)) return Convert.FromHexString(File.ReadAllText(path).Trim());
        }
        throw new FileNotFoundException($"Missing independent Canvas fixture {name}.");
    }
}
