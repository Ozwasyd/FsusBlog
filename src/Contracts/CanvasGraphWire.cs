namespace FsusBlog.V2.Contracts;

public readonly record struct CanvasViewport(int X, int Y, int Zoom)
{
    public static CanvasViewport Default => new(0, 0, 1000);
}
public enum CanvasGraphAction { Create, Edit, Delete }

public sealed record CanvasNodeFrame(Guid Id, int Kind, int X, int Y, int Width, int Height,
    int? ArticleId = null, string? Anchor = null, long? PinnedRevision = null,
    string? Text = null, IReadOnlyList<Guid>? MemberIds = null);
public sealed record CanvasEdgeFrame(Guid Id, int Kind, Guid SourceNodeId, Guid TargetNodeId, int Order, string? Label);

public abstract record CanvasChangeFrame
{
    private CanvasChangeFrame() { }
    public sealed record PutNode(CanvasNodeFrame Node) : CanvasChangeFrame;
    public sealed record DropNode(Guid Id) : CanvasChangeFrame;
    public sealed record PutEdge(CanvasEdgeFrame Edge) : CanvasChangeFrame;
    public sealed record DropEdge(Guid Id) : CanvasChangeFrame;
}

public sealed record CanvasGraphCommand(Guid Id, Guid CommandId, long ExpectedRevision, CanvasGraphAction Action,
    string Title, CanvasViewport? Viewport, IReadOnlyList<CanvasChangeFrame> Changes);
public sealed record CanvasGraphReceipt(Guid Id, long Revision, string Title, CanvasViewport Viewport, bool Deleted,
    int NodeCount, int EdgeCount, DateTimeOffset TouchedAt);
public sealed record CanvasGraphPage(CanvasGraphReceipt Document, int NextOffset, IReadOnlyList<CanvasNodeFrame> Nodes,
    IReadOnlyList<CanvasEdgeFrame> Edges);

public static partial class Wire
{
    // Frames encode variants by their elected fields. Domain validation runs after strict framing.
    public static CanvasGraphCommand DecodeCanvasGraphCommand(ReadOnlySpan<byte> frame)
    {
        if (frame.Length > WireLimits.CanvasGraphCommandBytes) throw CanvasProtocolError();
        var r = new Reader(Aeds.Decode(frame, FrameType.CanvasGraphCommand));
        var id = r.Uuid();
        var key = r.Uuid();
        var expected = r.I64();
        var action = (CanvasGraphAction)r.I32();
        var title = r.Text(WireLimits.TitleBytes);
        CanvasViewport? viewport = r.Bool() ? ReadViewport(ref r) : null;
        var changes = new CanvasChangeFrame[ReadCount(ref r, WireLimits.CanvasGraphMaxChanges)];
        for (var i = 0; i < changes.Length; i++)
        {
            changes[i] = r.I32() switch
            {
                0 => new CanvasChangeFrame.PutNode(ReadCanvasNode(ref r)),
                1 => new CanvasChangeFrame.DropNode(r.Uuid()),
                2 => new CanvasChangeFrame.PutEdge(ReadCanvasEdge(ref r)),
                3 => new CanvasChangeFrame.DropEdge(r.Uuid()),
                _ => throw CanvasProtocolError()
            };
        }
        r.Finish();
        var command = new CanvasGraphCommand(id, key, expected, action, title, viewport, changes);
        ValidateCanvasCommand(command);
        return command;
    }

    public static byte[] EncodeCanvasGraphCommand(CanvasGraphCommand command)
    {
        ValidateCanvasCommand(command);
        var w = new Writer();
        w.Uuid(command.Id);
        w.Uuid(command.CommandId);
        w.I64(command.ExpectedRevision);
        w.I32((int)command.Action);
        w.Text(command.Title, WireLimits.TitleBytes);
        w.Bool(command.Viewport.HasValue);
        if (command.Viewport.HasValue) WriteViewport(w, command.Viewport.Value);
        w.I32(command.Changes.Count);
        foreach (var item in command.Changes)
        {
            switch (item)
            {
                case CanvasChangeFrame.PutNode(var node): w.I32(0); WriteCanvasNode(w, node); break;
                case CanvasChangeFrame.DropNode(var id): w.I32(1); w.Uuid(id); break;
                case CanvasChangeFrame.PutEdge(var edge): w.I32(2); WriteCanvasEdge(w, edge); break;
                case CanvasChangeFrame.DropEdge(var id): w.I32(3); w.Uuid(id); break;
                default: throw CanvasProtocolError();
            }
        }
        if (w.Written.Length + Aeds.HeaderSize > WireLimits.CanvasGraphCommandBytes) throw CanvasProtocolError();
        return Aeds.Encode(FrameType.CanvasGraphCommand, w.Written);
    }

    public static byte[] EncodeCanvasGraphReceipt(CanvasGraphReceipt receipt)
    {
        var w = new Writer();
        WriteCanvasReceipt(w, receipt);
        return Aeds.Encode(FrameType.CanvasGraphReceipt, w.Written);
    }

    public static CanvasGraphReceipt DecodeCanvasGraphReceipt(ReadOnlySpan<byte> frame)
    {
        var r = new Reader(Aeds.Decode(frame, FrameType.CanvasGraphReceipt));
        var receipt = ReadCanvasReceipt(ref r);
        r.Finish();
        return receipt;
    }

    public static byte[] EncodeCanvasGraphList(IReadOnlyList<CanvasGraphReceipt> documents)
    {
        if (documents.Count > WireLimits.CanvasGraphMaxDocuments) throw CanvasProtocolError();
        var w = new Writer();
        w.I32(documents.Count);
        foreach (var document in documents) WriteCanvasReceipt(w, document);
        return Aeds.Encode(FrameType.CanvasGraphList, w.Written);
    }

    public static IReadOnlyList<CanvasGraphReceipt> DecodeCanvasGraphList(ReadOnlySpan<byte> frame)
    {
        var r = new Reader(Aeds.Decode(frame, FrameType.CanvasGraphList));
        var documents = new CanvasGraphReceipt[ReadCount(ref r, WireLimits.CanvasGraphMaxDocuments)];
        for (var i = 0; i < documents.Length; i++) documents[i] = ReadCanvasReceipt(ref r);
        r.Finish();
        return documents;
    }

    public static byte[] EncodeCanvasGraphPage(CanvasGraphPage page)
    {
        if (page.Nodes.Count > WireLimits.CanvasGraphMaxPageNodes || page.Edges.Count > WireLimits.CanvasGraphMaxPageEdges)
            throw CanvasProtocolError();
        var w = new Writer();
        WriteCanvasReceipt(w, page.Document);
        w.I32(page.NextOffset);
        w.I32(page.Nodes.Count);
        foreach (var node in page.Nodes) WriteCanvasNode(w, node);
        w.I32(page.Edges.Count);
        foreach (var edge in page.Edges) WriteCanvasEdge(w, edge);
        return Aeds.Encode(FrameType.CanvasGraphPage, w.Written);
    }

    public static CanvasGraphPage DecodeCanvasGraphPage(ReadOnlySpan<byte> frame)
    {
        var r = new Reader(Aeds.Decode(frame, FrameType.CanvasGraphPage));
        var document = ReadCanvasReceipt(ref r);
        var next = r.I32();
        if (next < -1 || next > document.NodeCount + document.EdgeCount) throw CanvasProtocolError();
        var nodes = new CanvasNodeFrame[ReadCount(ref r, WireLimits.CanvasGraphMaxPageNodes)];
        for (var i = 0; i < nodes.Length; i++) nodes[i] = ReadCanvasNode(ref r);
        var edges = new CanvasEdgeFrame[ReadCount(ref r, WireLimits.CanvasGraphMaxPageEdges)];
        for (var i = 0; i < edges.Length; i++) edges[i] = ReadCanvasEdge(ref r);
        r.Finish();
        return new(document, next, nodes, edges);
    }

    private static void ValidateCanvasCommand(CanvasGraphCommand command)
    {
        if (command.Id == Guid.Empty || command.CommandId == Guid.Empty || !Enum.IsDefined(command.Action)
            || command.ExpectedRevision < 0 || (command.ExpectedRevision == 0) != (command.Action == CanvasGraphAction.Create)
            || command.Changes.Count > WireLimits.CanvasGraphMaxChanges)
            throw CanvasProtocolError();
    }

    private static void WriteCanvasReceipt(Writer w, CanvasGraphReceipt receipt)
    {
        w.Uuid(receipt.Id);
        w.I64(receipt.Revision);
        w.Text(receipt.Title, WireLimits.TitleBytes);
        WriteViewport(w, receipt.Viewport);
        w.Bool(receipt.Deleted);
        w.I32(receipt.NodeCount);
        w.I32(receipt.EdgeCount);
        w.I64(receipt.TouchedAt.ToUnixTimeMilliseconds());
    }

    private static CanvasGraphReceipt ReadCanvasReceipt(ref Reader r)
    {
        var id = r.Uuid();
        var revision = r.I64();
        var title = r.Text(WireLimits.TitleBytes);
        var viewport = ReadViewport(ref r);
        var deleted = r.Bool();
        var nodes = r.I32();
        var edges = r.I32();
        var milliseconds = r.I64();
        if (id == Guid.Empty || revision <= 0 || nodes < 0 || edges < 0
            || milliseconds is < -62135596800000 or > 253402300799999)
            throw CanvasProtocolError();
        return new(id, revision, title, viewport, deleted, nodes, edges, DateTimeOffset.FromUnixTimeMilliseconds(milliseconds));
    }

    private static void WriteViewport(Writer w, CanvasViewport value)
    {
        w.I32(value.X);
        w.I32(value.Y);
        w.I32(value.Zoom);
    }

    private static CanvasViewport ReadViewport(ref Reader r) => new(r.I32(), r.I32(), r.I32());

    private static CanvasNodeFrame ReadCanvasNode(ref Reader r)
    {
        var id = r.Uuid();
        var node = new CanvasNodeFrame(id, r.I32(), r.I32(), r.I32(), r.I32(), r.I32());
        if (node.Kind is >= 0 and <= 2)
        {
            var article = r.I32();
            var anchor = node.Kind == 0 ? null : r.Text(WireLimits.CanvasGraphAnchorBytes);
            var pin = r.I64();
            return node with { ArticleId = article, Anchor = anchor, PinnedRevision = pin == 0 ? null : pin };
        }
        if (node.Kind == 3) return node with { Text = r.Text(WireLimits.CanvasGraphNoteBytes) };
        if (node.Kind != 4) throw CanvasProtocolError();
        var label = r.Text(WireLimits.CanvasGraphLabelBytes);
        var members = new Guid[ReadCount(ref r, 10_000)];
        for (var i = 0; i < members.Length; i++) members[i] = r.Uuid();
        return node with { Text = label, MemberIds = members };
    }

    private static void WriteCanvasNode(Writer w, CanvasNodeFrame node)
    {
        w.Uuid(node.Id);
        w.I32(node.Kind);
        w.I32(node.X);
        w.I32(node.Y);
        w.I32(node.Width);
        w.I32(node.Height);
        switch (node.Kind)
        {
            case >= 0 and <= 2:
                w.I32(node.ArticleId ?? throw CanvasProtocolError());
                if (node.Kind != 0) w.Text(node.Anchor ?? throw CanvasProtocolError(), WireLimits.CanvasGraphAnchorBytes);
                w.I64(node.PinnedRevision ?? 0);
                break;
            case 3:
                w.Text(node.Text ?? throw CanvasProtocolError(), WireLimits.CanvasGraphNoteBytes);
                break;
            case 4:
                w.Text(node.Text ?? throw CanvasProtocolError(), WireLimits.CanvasGraphLabelBytes);
                var members = node.MemberIds ?? [];
                if (members.Count > 10_000) throw CanvasProtocolError();
                w.I32(members.Count);
                foreach (var id in members) w.Uuid(id);
                break;
            default: throw CanvasProtocolError();
        }
    }

    private static CanvasEdgeFrame ReadCanvasEdge(ref Reader r) =>
        new(r.Uuid(), r.I32(), r.Uuid(), r.Uuid(), r.I32(), r.Bool() ? r.Text(WireLimits.CanvasGraphLabelBytes) : null);

    private static void WriteCanvasEdge(Writer w, CanvasEdgeFrame edge)
    {
        w.Uuid(edge.Id);
        w.I32(edge.Kind);
        w.Uuid(edge.SourceNodeId);
        w.Uuid(edge.TargetNodeId);
        w.I32(edge.Order);
        w.Bool(edge.Label is not null);
        if (edge.Label is not null) w.Text(edge.Label, WireLimits.CanvasGraphLabelBytes);
    }

    private static int ReadCount(ref Reader reader, int maximum)
    {
        var count = reader.I32();
        return count >= 0 && count <= maximum ? count : throw CanvasProtocolError();
    }

    private static ProtocolException CanvasProtocolError() => new("Invalid Canvas document frame.");
}
