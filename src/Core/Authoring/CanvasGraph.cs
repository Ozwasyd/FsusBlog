using System.Collections.Immutable;
using System.Text;
using System.Text.RegularExpressions;

namespace FsusBlog.V2.Core.Authoring;

public enum CanvasNodeKind { ArticleReference, HeadingReference, BlockReference, PlainTextNote, GroupFrame }
public enum CanvasGraphEdgeKind { VisualOnly, ExplicitReferenceNote }

/// <summary>Positions and extents are hundredths of a logical canvas unit.</summary>
public readonly record struct CanvasGeometry(int X, int Y, int Width, int Height)
{
    public const int MaxCoordinate = 1_000_000_000;
    public const int MinExtent = 2_400;
    public const int MaxExtent = 409_600;
}

public sealed record CanvasNode(
    Guid Id,
    CanvasNodeKind Kind,
    CanvasGeometry Geometry,
    int? ArticleId = null,
    string? Anchor = null,
    long? PinnedRevision = null,
    string? Text = null,
    ImmutableArray<Guid> MemberIds = default);

public sealed record CanvasGraphEdge(Guid Id, CanvasGraphEdgeKind Kind, Guid SourceNodeId, Guid TargetNodeId,
    int Order, string? Label = null);

public abstract record CanvasGraphChange
{
    private CanvasGraphChange() { }

    public sealed record UpsertNode(CanvasNode Node) : CanvasGraphChange;
    public sealed record RemoveNode(Guid Id) : CanvasGraphChange;
    public sealed record UpsertEdge(CanvasGraphEdge Edge) : CanvasGraphChange;
    public sealed record RemoveEdge(Guid Id) : CanvasGraphChange;
}

public sealed partial record CanvasGraph(ImmutableArray<CanvasNode> Nodes, ImmutableArray<CanvasGraphEdge> Edges)
{
    public const int MaxNodes = 10_000;
    public const int MaxEdges = 10_000;
    public const int MaxChanges = 64;
    public const int MaxMemberships = 100_000;
    public const int MaxContentBytes = 8 * 1024 * 1024;
    public const int MaxNoteLength = 8_192;
    public const int MaxLabelLength = 128;
    private static readonly UTF8Encoding Utf8 = new(false, true);

    public static CanvasGraph Empty { get; } = new([], []);

    public void Validate()
    {
        var nodes = ReadNodes();
        var edges = ReadEdges(nodes);
        ValidateContentBudget(ContentBytes(nodes, edges));
    }

    /// <summary>Returns a new graph only if each ordered change validates against its current graph state.</summary>
    public CanvasGraph Apply(IReadOnlyList<CanvasGraphChange> changes)
    {
        if (changes is null || changes.Count is < 1 or > MaxChanges)
            throw Invalid("Invalid Canvas graph change count.");
        var nodes = ReadNodes();
        var edges = ReadEdges(nodes);
        int memberships = nodes.Values.Sum(MembershipCount);
        int content = ContentBytes(nodes, edges);
        ValidateContentBudget(content);
        var retiredNodes = new HashSet<Guid>();
        var retiredEdges = new HashSet<Guid>();

        foreach (var change in changes)
        {
            switch (change)
            {
                case CanvasGraphChange.UpsertNode(var node):
                    ValidateNode(node);
                    if (retiredNodes.Contains(node.Id)) throw Invalid("Canvas nodes cannot be recreated in the same change set.");
                    if (nodes.TryGetValue(node.Id, out var existing))
                    {
                        if (existing.Kind != node.Kind) throw Invalid("Canvas node kinds cannot change in place.");
                    }
                    else if (nodes.Count == MaxNodes)
                    {
                        throw Invalid("Canvas node limit reached.");
                    }
                    ValidateMembership(node, nodes);
                    memberships += MembershipCount(node) - (existing is null ? 0 : MembershipCount(existing));
                    content += TextBytes(node.Text) - TextBytes(existing?.Text);
                    if (memberships > MaxMemberships) throw Invalid("Canvas membership limit reached.");
                    nodes[node.Id] = node;
                    break;
                case CanvasGraphChange.RemoveNode(var nodeId):
                    if (!nodes.Remove(nodeId, out var removed)) throw Missing();
                    retiredNodes.Add(nodeId);
                    memberships -= MembershipCount(removed);
                    content -= TextBytes(removed.Text);
                    foreach (var edge in edges.Values.Where(edge => edge.SourceNodeId == nodeId || edge.TargetNodeId == nodeId).ToArray())
                    {
                        edges.Remove(edge.Id);
                        retiredEdges.Add(edge.Id);
                        content -= TextBytes(edge.Label);
                    }
                    foreach (var frame in nodes.Values.Where(node => node.Kind == CanvasNodeKind.GroupFrame &&
                        !node.MemberIds.IsDefaultOrEmpty && node.MemberIds.Contains(nodeId)).ToArray())
                    {
                        nodes[frame.Id] = frame with { MemberIds = frame.MemberIds.Remove(nodeId) };
                        memberships--;
                    }
                    break;
                case CanvasGraphChange.UpsertEdge(var edge):
                    ValidateEdge(edge, nodes);
                    if (retiredEdges.Contains(edge.Id)) throw Invalid("Canvas edges cannot be recreated in the same change set.");
                    if (edges.Count == MaxEdges && !edges.ContainsKey(edge.Id)) throw Invalid("Canvas edge limit reached.");
                    edges.TryGetValue(edge.Id, out var previousEdge);
                    content += TextBytes(edge.Label) - TextBytes(previousEdge?.Label);
                    edges[edge.Id] = edge;
                    break;
                case CanvasGraphChange.RemoveEdge(var edgeId):
                    if (!edges.Remove(edgeId, out var removedEdge)) throw Missing();
                    retiredEdges.Add(edgeId);
                    content -= TextBytes(removedEdge.Label);
                    break;
                default:
                    throw Invalid("Unsupported Canvas graph change.");
            }
            ValidateContentBudget(content);
        }

        return new(nodes.Values.OrderBy(node => node.Id).ToImmutableArray(),
            edges.Values.OrderBy(edge => edge.Order).ThenBy(edge => edge.Id).ToImmutableArray());
    }

    private Dictionary<Guid, CanvasNode> ReadNodes()
    {
        if (Nodes.IsDefault || Nodes.Length > MaxNodes) throw Invalid("Invalid Canvas node count.");
        var nodes = new Dictionary<Guid, CanvasNode>(Nodes.Length);
        foreach (var node in Nodes)
        {
            ValidateNode(node);
            if (!nodes.TryAdd(node.Id, node)) throw Invalid("Duplicate Canvas node.");
        }
        if (nodes.Values.Sum(MembershipCount) > MaxMemberships) throw Invalid("Canvas membership limit reached.");
        foreach (var node in nodes.Values) ValidateMembership(node, nodes);
        return nodes;
    }

    private Dictionary<Guid, CanvasGraphEdge> ReadEdges(Dictionary<Guid, CanvasNode> nodes)
    {
        if (Edges.IsDefault || Edges.Length > MaxEdges) throw Invalid("Invalid Canvas edge count.");
        var edges = new Dictionary<Guid, CanvasGraphEdge>(Edges.Length);
        foreach (var edge in Edges)
        {
            ValidateEdge(edge, nodes);
            if (!edges.TryAdd(edge.Id, edge)) throw Invalid("Duplicate Canvas edge.");
        }
        return edges;
    }

    private static void ValidateNode(CanvasNode node)
    {
        if (node is null || node.Id == Guid.Empty || !Enum.IsDefined(node.Kind)) throw Invalid("Invalid Canvas node.");
        var geometry = node.Geometry;
        if (geometry.X is < -CanvasGeometry.MaxCoordinate or > CanvasGeometry.MaxCoordinate
            || geometry.Y is < -CanvasGeometry.MaxCoordinate or > CanvasGeometry.MaxCoordinate
            || geometry.Width is < CanvasGeometry.MinExtent or > CanvasGeometry.MaxExtent
            || geometry.Height is < CanvasGeometry.MinExtent or > CanvasGeometry.MaxExtent)
            throw Invalid("Invalid Canvas node geometry.");

        if (node.Kind is CanvasNodeKind.ArticleReference or CanvasNodeKind.HeadingReference or CanvasNodeKind.BlockReference)
        {
            bool validAnchor = node.Kind == CanvasNodeKind.ArticleReference
                ? node.Anchor is null
                : node.Anchor is { Length: >= 1 and <= 64 } anchor && AnchorPattern().IsMatch(anchor);
            if (node.ArticleId is not > 0 || node.PinnedRevision is <= 0 || !validAnchor
                || node.Text is not null || !node.MemberIds.IsDefaultOrEmpty)
                throw Invalid("Invalid Canvas article reference.");
            return;
        }

        if (node.ArticleId is not null || node.Anchor is not null || node.PinnedRevision is not null)
            throw Invalid("Invalid Canvas node fields.");
        if (node.Kind == CanvasNodeKind.PlainTextNote && !node.MemberIds.IsDefaultOrEmpty)
            throw Invalid("Canvas notes cannot contain other nodes.");
        if (MembershipCount(node) > MaxNodes) throw Invalid("Canvas frame member limit reached.");
        ValidatePlainText(node.Text, node.Kind == CanvasNodeKind.PlainTextNote ? MaxNoteLength : MaxLabelLength, required: true);
    }

    private static void ValidateMembership(CanvasNode node, Dictionary<Guid, CanvasNode> nodes)
    {
        if (node.MemberIds.IsDefaultOrEmpty) return;
        var members = new HashSet<Guid>();
        foreach (var id in node.MemberIds)
            if (id == node.Id || !members.Add(id) || !nodes.TryGetValue(id, out var member) || member.Kind == CanvasNodeKind.GroupFrame)
                throw Invalid("Invalid Canvas frame membership.");
    }

    private static int MembershipCount(CanvasNode node) => node.MemberIds.IsDefault ? 0 : node.MemberIds.Length;

    private static int ContentBytes(Dictionary<Guid, CanvasNode> nodes, Dictionary<Guid, CanvasGraphEdge> edges) =>
        nodes.Values.Sum(node => TextBytes(node.Text)) + edges.Values.Sum(edge => TextBytes(edge.Label));

    private static int TextBytes(string? text) => text is null ? 0 : Utf8.GetByteCount(text);

    private static void ValidateContentBudget(int bytes)
    {
        if (bytes > MaxContentBytes) throw Invalid("Canvas document text limit reached.");
    }

    private static void ValidateEdge(CanvasGraphEdge edge, Dictionary<Guid, CanvasNode> nodes)
    {
        if (edge is null || edge.Id == Guid.Empty || !Enum.IsDefined(edge.Kind) || edge.Order < 0
            || !nodes.ContainsKey(edge.SourceNodeId) || !nodes.ContainsKey(edge.TargetNodeId))
            throw Invalid("Invalid Canvas edge or missing endpoint.");
        ValidatePlainText(edge.Label, MaxLabelLength, required: false);
    }

    private static void ValidatePlainText(string? text, int limit, bool required)
    {
        if (required && string.IsNullOrWhiteSpace(text)) throw Invalid("Canvas text is required.");
        if (text is null) return;
        int angle = text.IndexOf('<');
        if (text.Length > limit || text.Any(character => char.IsControl(character) && character is not ('\n' or '\r' or '\t'))
            || angle >= 0 && text.IndexOf('>', angle + 1) >= 0)
            throw Invalid("Invalid Canvas plain text.");
        try { Utf8.GetByteCount(text); }
        catch (EncoderFallbackException) { throw Invalid("Invalid Canvas Unicode."); }
    }

    private static BusinessException Missing() => new(Rejection.NotFound, "Canvas graph record not found.");
    private static BusinessException Invalid(string message) => new(Rejection.Invalid, message);

    [GeneratedRegex(@"\A[a-z][a-z0-9-]{0,63}\z", RegexOptions.CultureInvariant)]
    private static partial Regex AnchorPattern();
}
