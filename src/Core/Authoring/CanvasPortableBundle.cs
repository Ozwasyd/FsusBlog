using System.Buffers.Binary;
using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.V2.Core.Authoring;

public readonly record struct CanvasPortableViewport(int X, int Y, int Zoom);
public sealed record CanvasPortableReference(int Slot, CanvasNodeKind Kind, string? Anchor, bool RequiresPin);
public readonly record struct CanvasPortableTarget(int ArticleId, long? PinnedRevision);

/// <summary>A closed Canvas artifact addressed only by document-local node and reference slots.</summary>
public sealed partial class CanvasPortableBundle
{
    public const string Kind = "authoring-canvas";
    public const int Version = 1;
    public const int MaxBytes = 3_500_000;
    private const int MaxTitleCharacters = 128;
    private const int MaxTitleBytes = 256;
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);

    private readonly ImmutableArray<PortableNode> _nodes;
    private readonly ImmutableArray<PortableEdge> _edges;

    private CanvasPortableBundle(string title, CanvasPortableViewport viewport, long sourceRevision,
        ImmutableArray<PortableNode> nodes, ImmutableArray<PortableEdge> edges)
    {
        ValidateMetadata(title, viewport, sourceRevision);
        Title = title;
        Viewport = viewport;
        SourceRevision = sourceRevision;
        _nodes = nodes;
        _edges = edges;
        References = ReadReferences();
    }

    public string Title { get; }
    public CanvasPortableViewport Viewport { get; }
    public long SourceRevision { get; }
    public int NodeCount => _nodes.Length;
    public int EdgeCount => _edges.Length;
    public ImmutableArray<CanvasPortableReference> References { get; }
    public string Checksum { get; private set; } = "";

    public static CanvasPortableBundle Export(string title, CanvasPortableViewport viewport, long sourceRevision, CanvasGraph graph)
    {
        graph.Validate();

        var nodes = graph.Nodes.OrderBy(node => node.Id).ToArray();
        var slots = new Dictionary<Guid, int>(nodes.Length);
        for (int index = 0; index < nodes.Length; index++)
            slots.Add(nodes[index].Id, index + 1);

        int reference = 0;
        var portableNodes = nodes.Select(node => new PortableNode(
            node.Kind,
            node.Geometry,
            IsReference(node.Kind) ? ++reference : 0,
            node.Anchor,
            node.PinnedRevision.HasValue,
            node.Text,
            node.MemberIds.IsDefaultOrEmpty ? [] : node.MemberIds.Select(member => slots[member]).ToImmutableArray()
        )).ToImmutableArray();
        var portableEdges = graph.Edges.OrderBy(edge => edge.Order).ThenBy(edge => edge.Id)
            .Select(edge => new PortableEdge(edge.Kind, slots[edge.SourceNodeId], slots[edge.TargetNodeId], edge.Order, edge.Label))
            .ToImmutableArray();
        var bundle = new CanvasPortableBundle(title, viewport, sourceRevision, portableNodes, portableEdges);
        bundle.Checksum = Convert.ToHexStringLower(bundle.WriteBody().Hash);
        return bundle;
    }

    /// <summary>
    /// Bind every package reference to an explicit caller-supplied local coordinate.
    /// The caller remains responsible for verifying authorization and the exact article revision or anchor.
    /// </summary>
    public CanvasGraph Materialize(IReadOnlyDictionary<int, CanvasPortableTarget> references, Guid canvasId)
    {
        if (references is null || canvasId == Guid.Empty || references.Count != References.Length)
            throw Invalid("Map each Canvas reference to one local article.");

        var mapping = new CanvasPortableTarget[References.Length];
        foreach (var reference in References)
        {
            if (!references.TryGetValue(reference.Slot, out var match) || match.ArticleId <= 0
                || match.PinnedRevision.HasValue != reference.RequiresPin || match.PinnedRevision is <= 0)
                throw Invalid("Map each Canvas reference to an exact local coordinate.");
            mapping[reference.Slot - 1] = match;
        }

        return Graph(mapping, canvasId);
    }

    private ImmutableArray<CanvasPortableReference> ReadReferences()
    {
        if (_nodes.IsDefault || _nodes.Length > CanvasGraph.MaxNodes || _edges.IsDefault
            || _edges.Length > CanvasGraph.MaxEdges)
            throw Invalid("Canvas package graph exceeds its size limit.");

        var references = ImmutableArray.CreateBuilder<CanvasPortableReference>();
        int memberships = 0;
        foreach (var node in _nodes)
        {
            if (node.Members.IsDefault || node.Members.Length > CanvasGraph.MaxNodes
                || (memberships += node.Members.Length) > CanvasGraph.MaxMemberships)
                throw Invalid("Canvas package membership exceeds its size limit.");

            if (IsReference(node.Kind))
            {
                if (node.Reference != references.Count + 1)
                    throw Invalid("Invalid Canvas package reference slot.");
                references.Add(new(node.Reference, node.Kind, node.Anchor, node.Pinned));
            }
            else if (node.Reference != 0 || node.Pinned || node.Anchor is not null)
            {
                throw Invalid("Canvas package node has unexpected reference fields.");
            }
        }

        int previousOrder = -1;
        foreach (var edge in _edges)
        {
            if (edge.Order < previousOrder) throw Invalid("Canvas package edges are out of order.");
            previousOrder = edge.Order;
        }

        return references.ToImmutable();
    }

    private void ValidateGraph()
    {
        // A temporary graph checks the shared structural and plain-text rules independently of
        // local article identity. The values below never leave this validation call.
        var synthetic = References.Select(reference => new CanvasPortableTarget(
            reference.Slot, reference.RequiresPin ? 1 : null)).ToArray();
        Graph(synthetic, Guid.Empty);
    }

    private CanvasGraph Graph(CanvasPortableTarget[] targets, Guid canvasId)
    {
        var ids = Slots(canvasId, discriminator: 0, _nodes.Length);
        var edgeIds = Slots(canvasId, discriminator: 1, _edges.Length);
        var nodes = ImmutableArray.CreateBuilder<CanvasNode>(_nodes.Length);
        foreach (var node in _nodes)
        {
            var mapped = node.Reference == 0 ? default : targets[node.Reference - 1];
            nodes.Add(new(ids[nodes.Count], node.Kind, node.Geometry, node.Reference == 0 ? null : mapped.ArticleId,
                node.Anchor, mapped.PinnedRevision, node.Text, node.Members.Select(slot => ResolveSlot(ids, slot)).ToImmutableArray()));
        }
        var edges = ImmutableArray.CreateBuilder<CanvasGraphEdge>(_edges.Length);
        foreach (var edge in _edges)
            edges.Add(new(edgeIds[edges.Count], edge.Kind, ResolveSlot(ids, edge.From), ResolveSlot(ids, edge.To), edge.Order, edge.Label));

        var graph = new CanvasGraph(nodes.MoveToImmutable(), edges.MoveToImmutable());
        graph.Validate();
        return graph;
    }

    private static Guid[] Slots(Guid canvasId, byte discriminator, int count)
    {
        Span<byte> input = stackalloc byte[17];
        canvasId.TryWriteBytes(input[..16], bigEndian: true, out _);
        input[^1] = discriminator;
        Span<byte> digest = stackalloc byte[32];
        SHA256.HashData(input, digest);

        // A version 8 UUID namespaces IDs by destination and by row kind. A final
        // portable ordinal preserves order after importing into a fresh destination.
        digest[6] = (byte)((digest[6] & 0x0f) | 0x80);
        digest[8] = (byte)((digest[8] & 0x3f) | 0x80);
        var result = new Guid[count];
        for (int index = 0; index < count; index++)
        {
            BinaryPrimitives.WriteInt16BigEndian(digest[14..], checked((short)(index + 1)));
            result[index] = new(digest[..16], bigEndian: true);
        }
        return result;
    }

    private static Guid ResolveSlot(Guid[] ids, int slot)
    {
        if (slot < 1 || slot > ids.Length) throw Invalid("Invalid Canvas package node slot.");
        return ids[slot - 1];
    }

    private static void ValidateMetadata(string title, CanvasPortableViewport viewport, long sourceRevision)
    {
        if (title is not { Length: >= 1 and <= MaxTitleCharacters } || title.Trim() != title
            || title.Any(char.IsControl) || HasMarkup(title)
            || viewport.X is < -CanvasGeometry.MaxCoordinate or > CanvasGeometry.MaxCoordinate
            || viewport.Y is < -CanvasGeometry.MaxCoordinate or > CanvasGeometry.MaxCoordinate
            || viewport.Zoom is < 100 or > 4000 || sourceRevision <= 0)
            throw Invalid("Invalid Canvas package document metadata.");

        try { if (StrictUtf8.GetByteCount(title) > MaxTitleBytes) throw Invalid("Canvas package title exceeds its byte limit."); }
        catch (EncoderFallbackException) { throw Invalid("Invalid Canvas package title encoding."); }
    }

    internal static bool HasMarkup(string text) { int angle = text.IndexOf('<'); return angle >= 0 && text.IndexOf('>', angle + 1) >= 0; }

    private static bool IsReference(CanvasNodeKind kind) => kind is CanvasNodeKind.ArticleReference or
        CanvasNodeKind.HeadingReference or CanvasNodeKind.BlockReference;

    private static BusinessException Invalid(string message) => new(Rejection.Invalid, message);

    private sealed record PortableNode(CanvasNodeKind Kind, CanvasGeometry Geometry, int Reference, string? Anchor,
        bool Pinned, string? Text, ImmutableArray<int> Members);

    private sealed record PortableEdge(CanvasGraphEdgeKind Kind, int From, int To, int Order, string? Label);
}
