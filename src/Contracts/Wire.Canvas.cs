namespace FsusBlog.V2.Contracts;

public readonly record struct CanvasViewport(int X, int Y, int Zoom)
{
    public static CanvasViewport Default => new(0, 0, 1000);
}

public enum CanvasGraphAction
{
    Create = 0,
    Edit = 1,
    Delete = 2,
    // Tags 3 and 4 are reserved for internal graph events.
    Undo = 5,
    Redo = 6
}

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
public sealed record CanvasGraphHistory(long Revision, long? UndoRevision, long? RedoRevision);

public sealed record CanvasBundleReference(int Slot, int Kind, bool Pinned, string? Anchor);
public sealed record CanvasBundlePlan(string Digest, long SourceRevision, string Title, int NodeCount, int EdgeCount,
    IReadOnlyList<CanvasBundleReference> References);
public sealed record CanvasBundleMapping(int Slot, int ArticleId, long? PinnedRevision);
public sealed record CanvasBundleExecute(Guid CanvasId, Guid CommandId, string Digest,
    IReadOnlyList<CanvasBundleMapping> Mappings, byte[] Bundle);

public enum CanvasReferenceState { Unavailable = 0, Resolved = 1, MissingAnchor = 2, DuplicateAnchor = 3, StaleRevision = 4 }
public sealed record CanvasReferenceResolution(Guid CanvasId, Guid NodeId, long CanvasRevision, CanvasReferenceState State,
    int? ArticleId, long? ArticleRevision, bool Pinned, string? Title, string? Excerpt, int? SourceOffset);

public static partial class Wire
{
    private const int CanvasBundleDigestBytes = 64;
    public const string CanvasBundleContentType = "application/vnd.fsus.canvas+json";

    internal static void Validate(CanvasCreate input) =>
        Check(input.CanvasId != Guid.Empty && input.EdgeId != Guid.Empty &&
            input.HostArticleId > 0 && input.TargetArticleId > 0 && input.HostArticleId != input.TargetArticleId,
            "Invalid Canvas identities.");

    internal static void Validate(CanvasCreated input) =>
        Check(input.CanvasId != Guid.Empty && input.EdgeId != Guid.Empty && input.CanvasRevision > 0, "Invalid Canvas coordinates.");

    internal static void Validate(CanvasPreview input) =>
        Check(input.CanvasId != Guid.Empty && input.EdgeId != Guid.Empty && input.CanvasRevision > 0 &&
            input.HostRevision > 0 && input.TargetRevision > 0 && input.SourceOffset >= 0, "Invalid Canvas preview coordinates.");

    internal static void Validate(CanvasLinkPlan input) =>
        Check(input.PlanId != Guid.Empty && input.CanvasRevision > 0 && input.HostArticleId > 0 &&
            input.TargetArticleId > 0 && input.HostArticleId != input.TargetArticleId && input.HostRevision > 0 &&
            input.TargetRevision > 0 && input.SourceOffset >= 0 && input.InsertedMarkdown.Length != 0 &&
            input.ExpiresAtUnixSeconds > 0, "Invalid Canvas link plan.");

    internal static void Validate(CanvasConfirm input) => Check(input.PlanId != Guid.Empty, "Invalid Canvas link plan identity.");

    internal static void Validate(CanvasLinked input) =>
        Check(input.PlanId != Guid.Empty && input.ArticleId > 0 && input.ArticleRevision > 0 && input.CanvasRevision > 0,
            "Invalid Canvas link receipt.");

    // Frames encode variants by their elected fields. Domain validation runs after strict framing.
    public static CanvasGraphCommand DecodeCanvasGraphCommand(ReadOnlySpan<byte> frame) =>
        DecodeRecord<CanvasGraphCommand>(FrameType.CanvasGraphCommand, frame, CanvasGraphCommandBytes, CanvasProtocolError,
            static (ref Reader r) => new(r.Uuid(), r.Uuid(), r.I64(), (CanvasGraphAction)r.I32(),
                r.Text(TitleBytes), r.OptionalValue(ReadViewport),
                r.Items(0, CanvasGraphMaxChanges, CanvasProtocolError, static (ref Reader cr) => cr.I32() switch
                {
                    0 => (CanvasChangeFrame)new CanvasChangeFrame.PutNode(ReadCanvasNode(ref cr)),
                    1 => new CanvasChangeFrame.DropNode(cr.Uuid()),
                    2 => new CanvasChangeFrame.PutEdge(ReadCanvasEdge(ref cr)),
                    3 => new CanvasChangeFrame.DropEdge(cr.Uuid()),
                    _ => throw CanvasProtocolError()
                })), ValidateCanvasCommand);

    public static byte[] EncodeCanvasGraphCommand(CanvasGraphCommand command) =>
        EncodeRecord(FrameType.CanvasGraphCommand, command, ValidateCanvasCommand, static (w, value) =>
        {
            w.Uuid(value.Id).Uuid(value.CommandId).I64(value.ExpectedRevision).I32((int)value.Action)
                .Text(value.Title, TitleBytes).Optional(value.Viewport, WriteViewport)
                .Items(value.Changes, static (cw, item) =>
                {
                    switch (item)
                    {
                        case CanvasChangeFrame.PutNode(var node): cw.I32(0); WriteCanvasNode(cw, node); break;
                        case CanvasChangeFrame.DropNode(var id): cw.I32(1).Uuid(id); break;
                        case CanvasChangeFrame.PutEdge(var edge): cw.I32(2); WriteCanvasEdge(cw, edge); break;
                        case CanvasChangeFrame.DropEdge(var id): cw.I32(3).Uuid(id); break;
                        default: throw CanvasProtocolError();
                    }
                });
            if (w.Written.Length + Aeds.HeaderSize > CanvasGraphCommandBytes) throw CanvasProtocolError();
        });

    public static byte[] EncodeCanvasGraphReceipt(CanvasGraphReceipt receipt) =>
        EncodeFrame(FrameType.CanvasGraphReceipt, w => WriteCanvasReceipt(w, receipt));

    public static CanvasGraphReceipt DecodeCanvasGraphReceipt(ReadOnlySpan<byte> frame) =>
        DecodeFrame(FrameType.CanvasGraphReceipt, frame, ReadCanvasReceipt);

    public static byte[] EncodeCanvasGraphList(IReadOnlyList<CanvasGraphReceipt> documents)
    {
        if (documents.Count > CanvasGraphMaxDocuments) throw CanvasProtocolError();
        return EncodeFrame(FrameType.CanvasGraphList, w => w.Items(documents, WriteCanvasReceipt));
    }

    public static IReadOnlyList<CanvasGraphReceipt> DecodeCanvasGraphList(ReadOnlySpan<byte> frame) =>
        DecodeFrame(FrameType.CanvasGraphList, frame,
            static (ref Reader r) => r.Items(0, CanvasGraphMaxDocuments, CanvasProtocolError, ReadCanvasReceipt));

    public static byte[] EncodeCanvasGraphPage(CanvasGraphPage page)
    {
        if (page.Nodes.Count > CanvasGraphMaxPageNodes || page.Edges.Count > CanvasGraphMaxPageEdges) throw CanvasProtocolError();
        return EncodeFrame(FrameType.CanvasGraphPage, w =>
        {
            WriteCanvasReceipt(w, page.Document);
            w.I32(page.NextOffset).Items(page.Nodes, WriteCanvasNode).Items(page.Edges, WriteCanvasEdge);
        });
    }

    public static CanvasGraphPage DecodeCanvasGraphPage(ReadOnlySpan<byte> frame) =>
        DecodeFrame(FrameType.CanvasGraphPage, frame, static (ref Reader r) =>
        {
            var document = ReadCanvasReceipt(ref r);
            var next = r.I32();
            if (next < -1 || next > document.NodeCount + document.EdgeCount) throw CanvasProtocolError();
            return new CanvasGraphPage(document, next,
                r.Items(0, CanvasGraphMaxPageNodes, CanvasProtocolError, ReadCanvasNode),
                r.Items(0, CanvasGraphMaxPageEdges, CanvasProtocolError, ReadCanvasEdge));
        });

    public static byte[] EncodeCanvasGraphHistory(CanvasGraphHistory history) =>
        EncodeRecord(FrameType.CanvasGraphHistory, history, ValidateCanvasHistory, static (w, value) =>
            w.I64(value.Revision).I64(value.UndoRevision ?? 0).I64(value.RedoRevision ?? 0));

    public static CanvasGraphHistory DecodeCanvasGraphHistory(ReadOnlySpan<byte> frame) =>
        DecodeRecord<CanvasGraphHistory>(FrameType.CanvasGraphHistory, frame, static (ref Reader r) =>
            new(r.I64(), NullIf(r.I64(), 0L), NullIf(r.I64(), 0L)), ValidateCanvasHistory);

    private static void ValidateCanvasHistory(CanvasGraphHistory history) =>
        Check(history.Revision > 0 && history.UndoRevision is not <= 0 && history.RedoRevision is not <= 0 &&
            !(history.UndoRevision > history.Revision) && !(history.RedoRevision > history.Revision) &&
            !(history.UndoRevision.HasValue && history.UndoRevision == history.RedoRevision), CanvasProtocolError);

    private static void ValidateCanvasCommand(CanvasGraphCommand command) =>
        Check(command.Id != Guid.Empty && command.CommandId != Guid.Empty && Enum.IsDefined(command.Action) &&
            command.ExpectedRevision >= 0 && (command.ExpectedRevision == 0) == (command.Action == CanvasGraphAction.Create) &&
            command.Changes.Count <= CanvasGraphMaxChanges &&
            !(command.Action is CanvasGraphAction.Undo or CanvasGraphAction.Redo &&
                (command.Title.Length != 0 || command.Viewport.HasValue || command.Changes.Count != 0)), CanvasProtocolError);

    private static void WriteCanvasReceipt(Writer w, CanvasGraphReceipt receipt)
    {
        w.Uuid(receipt.Id).I64(receipt.Revision).Text(receipt.Title, TitleBytes);
        WriteViewport(w, receipt.Viewport);
        w.Bool(receipt.Deleted).I32(receipt.NodeCount).I32(receipt.EdgeCount).I64(receipt.TouchedAt.ToUnixTimeMilliseconds());
    }

    private static CanvasGraphReceipt ReadCanvasReceipt(ref Reader r)
    {
        var id = r.Uuid();
        var revision = r.I64();
        var title = r.Text(TitleBytes);
        var viewport = ReadViewport(ref r);
        var deleted = r.Bool();
        var nodes = r.I32();
        var edges = r.I32();
        var milliseconds = r.I64();
        if (id == Guid.Empty || revision <= 0 || nodes < 0 || edges < 0 || !IsValidUnixMs(milliseconds))
            throw CanvasProtocolError();
        return new(id, revision, title, viewport, deleted, nodes, edges, DateTimeOffset.FromUnixTimeMilliseconds(milliseconds));
    }

    private static void WriteViewport(Writer w, CanvasViewport value) => w.I32(value.X).I32(value.Y).I32(value.Zoom);
    private static CanvasViewport ReadViewport(ref Reader r) => new(r.I32(), r.I32(), r.I32());

    private static CanvasNodeFrame ReadCanvasNode(ref Reader r)
    {
        var node = new CanvasNodeFrame(r.Uuid(), r.I32(), r.I32(), r.I32(), r.I32(), r.I32());
        if (node.Kind is >= 0 and <= 2)
        {
            var article = r.I32();
            var anchor = node.Kind == 0 ? null : r.Text(CanvasGraphAnchorBytes);
            var pin = NullIf(r.I64(), 0L);
            return node with { ArticleId = article, Anchor = anchor, PinnedRevision = pin };
        }
        if (node.Kind == 3) return node with { Text = r.Text(CanvasGraphNoteBytes) };
        if (node.Kind != 4) throw CanvasProtocolError();
        return node with
        {
            Text = r.Text(CanvasGraphLabelBytes),
            MemberIds = r.Items(0, 10_000, CanvasProtocolError, static (ref Reader mr) => mr.Uuid())
        };
    }

    private static void WriteCanvasNode(Writer w, CanvasNodeFrame node)
    {
        w.Uuid(node.Id).I32(node.Kind).I32(node.X).I32(node.Y).I32(node.Width).I32(node.Height);
        switch (node.Kind)
        {
            case >= 0 and <= 2:
                w.I32(node.ArticleId ?? throw CanvasProtocolError());
                if (node.Kind != 0) w.Text(node.Anchor ?? throw CanvasProtocolError(), CanvasGraphAnchorBytes);
                w.I64(node.PinnedRevision ?? 0);
                break;
            case 3: w.Text(node.Text ?? throw CanvasProtocolError(), CanvasGraphNoteBytes); break;
            case 4:
                w.Text(node.Text ?? throw CanvasProtocolError(), CanvasGraphLabelBytes);
                var members = node.MemberIds ?? [];
                if (members.Count > 10_000) throw CanvasProtocolError();
                w.Items(members, static (mw, id) => mw.Uuid(id));
                break;
            default: throw CanvasProtocolError();
        }
    }

    private static CanvasEdgeFrame ReadCanvasEdge(ref Reader r) =>
        new(r.Uuid(), r.I32(), r.Uuid(), r.Uuid(), r.I32(), r.Optional(static (ref Reader lr) => lr.Text(CanvasGraphLabelBytes)));

    private static void WriteCanvasEdge(Writer w, CanvasEdgeFrame edge) =>
        w.Uuid(edge.Id).I32(edge.Kind).Uuid(edge.SourceNodeId).Uuid(edge.TargetNodeId).I32(edge.Order)
            .Optional(edge.Label, static (lw, label) => lw.Text(label, CanvasGraphLabelBytes));

    private static ProtocolException CanvasProtocolError() => new("Invalid Canvas document frame.");

    public static byte[] EncodeCanvasBundleIntake(ReadOnlySpan<byte> bundle)
    {
        ValidateCanvasBundleSize(bundle.Length);
        return Aeds.Encode(FrameType.CanvasBundleIntake, bundle);
    }

    public static byte[] DecodeCanvasBundleIntake(ReadOnlySpan<byte> frame)
    {
        var bundle = Aeds.Decode(frame, FrameType.CanvasBundleIntake);
        ValidateCanvasBundleSize(bundle.Length);
        return bundle.ToArray();
    }

    public static byte[] EncodeCanvasBundlePlan(CanvasBundlePlan plan) =>
        EncodeRecord(FrameType.CanvasBundlePlan, plan, ValidateCanvasBundlePlan, static (w, value) =>
            w.Text(value.Digest, CanvasBundleDigestBytes).I64(value.SourceRevision).Text(value.Title, TitleBytes)
                .I32(value.NodeCount).I32(value.EdgeCount).Items(value.References, static (rw, reference) =>
                    rw.I32(reference.Slot).I32(reference.Kind).Bool(reference.Pinned).Text(reference.Anchor ?? "", CanvasGraphAnchorBytes)));

    public static CanvasBundlePlan DecodeCanvasBundlePlan(ReadOnlySpan<byte> frame) =>
        DecodeRecord<CanvasBundlePlan>(FrameType.CanvasBundlePlan, frame, static (ref Reader input) =>
            new(input.Text(CanvasBundleDigestBytes), input.I64(), input.Text(TitleBytes), input.I32(), input.I32(),
                input.Items(0, CanvasBundleMaxReferences, CanvasProtocolError, static (ref Reader r) =>
                    new CanvasBundleReference(r.I32(), r.I32(), r.Bool(), NullIfEmpty(r.Text(CanvasGraphAnchorBytes))))),
            ValidateCanvasBundlePlan);

    public static byte[] EncodeCanvasBundleExecute(CanvasBundleExecute execute) =>
        EncodeRecord(FrameType.CanvasBundleExecute, execute, ValidateCanvasBundleExecute, static (w, value) =>
            w.Uuid(value.CanvasId).Uuid(value.CommandId).Text(value.Digest, CanvasBundleDigestBytes)
                .Items(value.Mappings, static (mw, mapping) =>
                    mw.I32(mapping.Slot).I32(mapping.ArticleId).I64(mapping.PinnedRevision ?? 0)).Bytes(value.Bundle));

    public static CanvasBundleExecute DecodeCanvasBundleExecute(ReadOnlySpan<byte> frame) =>
        DecodeRecord<CanvasBundleExecute>(FrameType.CanvasBundleExecute, frame, CanvasBundleExecuteFrameBytes, InvalidCanvasBundle,
            static (ref Reader input) => new(input.Uuid(), input.Uuid(), input.Text(CanvasBundleDigestBytes),
                input.Items(0, CanvasBundleMaxReferences, CanvasProtocolError, static (ref Reader r) =>
                    new CanvasBundleMapping(r.I32(), r.I32(), NullIf(r.I64(), 0L))),
                input.Bytes(CanvasBundleBytes).ToArray()), ValidateCanvasBundleExecute);

    private static void ValidateCanvasBundlePlan(CanvasBundlePlan plan)
    {
        if (!IsLowerHex(plan.Digest, CanvasBundleDigestBytes)) throw InvalidCanvasBundle();
        int openAngle = plan.Title.IndexOf('<');
        if (plan.SourceRevision <= 0 || plan.NodeCount is < 0 or > 10_000 || plan.EdgeCount is < 0 or > 10_000 ||
            plan.References.Count > plan.NodeCount || plan.References.Count > CanvasBundleMaxReferences ||
            plan.Title.Length is < 1 or > 128 || plan.Title != plan.Title.Trim() || plan.Title.Any(char.IsControl) ||
            (openAngle >= 0 && plan.Title.IndexOf('>', openAngle + 1) >= 0))
            throw InvalidCanvasBundle();
        for (var i = 0; i < plan.References.Count; i++)
        {
            var reference = plan.References[i];
            if (reference.Slot != i + 1 || reference.Kind is < 0 or > 2 ||
                (reference.Kind == 0 ? reference.Anchor is not null : !ValidCanvasBundleAnchor(reference.Anchor)))
                throw InvalidCanvasBundle();
        }
    }

    private static bool ValidCanvasBundleAnchor(string? anchor) =>
        anchor is { Length: > 0 and <= CanvasGraphAnchorBytes } && anchor[0] is >= 'a' and <= 'z' &&
        anchor.All(c => c is >= 'a' and <= 'z' or >= '0' and <= '9' or '-');

    private static void ValidateCanvasBundleExecute(CanvasBundleExecute execute)
    {
        if (!IsLowerHex(execute.Digest, CanvasBundleDigestBytes)) throw InvalidCanvasBundle();
        ValidateCanvasBundleSize(execute.Bundle.Length);
        if (execute.CanvasId == Guid.Empty || execute.CommandId == Guid.Empty || execute.Mappings.Count > CanvasBundleMaxReferences)
            throw InvalidCanvasBundle();
        for (var i = 0; i < execute.Mappings.Count; i++)
        {
            var mapping = execute.Mappings[i];
            if (mapping.Slot != i + 1 || mapping.ArticleId <= 0 || mapping.PinnedRevision is <= 0) throw InvalidCanvasBundle();
        }
    }

    private static void ValidateCanvasBundleSize(int length)
    {
        if (length is <= 0 or > CanvasBundleBytes) throw InvalidCanvasBundle();
    }

    private static ProtocolException InvalidCanvasBundle() => new("Invalid Canvas bundle frame");

    public static byte[] EncodeCanvasReferenceResolution(CanvasReferenceResolution resolution) =>
        EncodeRecord(FrameType.CanvasReferenceResolution, resolution, ValidateCanvasReference, static (w, value) =>
            w.Uuid(value.CanvasId).Uuid(value.NodeId).I64(value.CanvasRevision).I32((int)value.State)
                .I32(value.ArticleId ?? 0).I64(value.ArticleRevision ?? 0).Bool(value.Pinned)
                .Text(value.Title ?? "", TitleBytes).Text(value.Excerpt ?? "", CanvasReferenceExcerptBytes)
                .I32(value.SourceOffset ?? -1));

    public static CanvasReferenceResolution DecodeCanvasReferenceResolution(ReadOnlySpan<byte> frame) =>
        DecodeRecord<CanvasReferenceResolution>(FrameType.CanvasReferenceResolution, frame, static (ref Reader r) =>
            new(r.Uuid(), r.Uuid(), r.I64(), (CanvasReferenceState)r.I32(),
                NullIf(r.I32(), 0), NullIf(r.I64(), 0L), r.Bool(), NullIfEmpty(r.Text(TitleBytes)),
                NullIfEmpty(r.Text(CanvasReferenceExcerptBytes)), NullIf(r.I32(), -1)), ValidateCanvasReference);

    private static T? NullIf<T>(T value, T sentinel) where T : struct, IEquatable<T> =>
        value.Equals(sentinel) ? null : value;

    private static string? NullIfEmpty(string value) => value.Length == 0 ? null : value;

    private static void ValidateCanvasReference(CanvasReferenceResolution value)
    {
        if (value.CanvasId == Guid.Empty || value.NodeId == Guid.Empty || value.CanvasRevision <= 0 || !Enum.IsDefined(value.State))
            throw InvalidCanvasReference();
        if (value.State is CanvasReferenceState.Unavailable or CanvasReferenceState.StaleRevision)
        {
            if (value.ArticleId is not null || value.ArticleRevision is not null || value.Pinned || value.Title is not null ||
                value.Excerpt is not null || value.SourceOffset is not null)
                throw InvalidCanvasReference();
            return;
        }
        if (value.ArticleId is null or <= 0 || value.ArticleRevision is null or <= 0 ||
            value.Title is null or "" || value.Title != value.Title.Trim() || value.Title.Any(char.IsControl))
            throw InvalidCanvasReference();
        if (value.State != CanvasReferenceState.Resolved && (value.Excerpt is not null || value.SourceOffset is not null))
            throw InvalidCanvasReference();
        if (value.SourceOffset < 0 || (value.Excerpt is not null && (value.SourceOffset is null ||
            value.Excerpt.Any(c => char.IsControl(c) && c is not ('\n' or '\r' or '\t')))))
            throw InvalidCanvasReference();
    }

    private static ProtocolException InvalidCanvasReference() => new("Invalid Canvas reference resolution");
}
