using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Closed server-side contract for one private authoring canvas document.
/// The contract intentionally excludes rendered content, article source, plug-in payloads,
/// and relation or graph facts.
/// </summary>
public static partial class AuthoringCanvasContract
{
    public const int SchemaVersion = 1;
    public const int MaxCanvasesPerOwner = 100;
    public const int MaxNodesPerCanvas = 10_000;
    public const int MaxEdgesPerCanvas = 10_000;
    public const int MaxPageSize = 256;
    public const int MaxTitleLength = 128;
    public const int MaxReferenceIdentityLength = 128;
    public const int MaxProjectionReferenceLength = 128;
    public const int MaxNoteSourceLength = 8_192;
    public const int MaxFrameLabelLength = 128;
    public const int MaxEdgeLabelLength = 128;
    public const int MaxSiteScopeLength = 128;
    public const double MaxCoordinateMagnitude = 10_000_000;
    public const double MinNodeExtent = 24;
    public const double MaxNodeExtent = 4_096;
    public const double MinZoom = 0.1;
    public const double MaxZoom = 4;

    [GeneratedRegex("<[\\s\\S]*?>", RegexOptions.CultureInvariant)]
    private static partial Regex HtmlLikePayloadPattern();

    public static void ValidateOwner(AuthoringCanvasOwner owner)
    {
        if (owner.AdminPrincipalId <= 0
            || string.IsNullOrWhiteSpace(owner.SiteScope)
            || owner.SiteScope.Length > MaxSiteScopeLength)
        {
            throw new AuthoringCanvasValidationException("canvas_owner_invalid");
        }
    }

    public static void ValidateViewport(AuthoringCanvasViewport viewport)
    {
        ValidateCoordinate(viewport.X, "canvas_viewport_x_invalid");
        ValidateCoordinate(viewport.Y, "canvas_viewport_y_invalid");
        if (!double.IsFinite(viewport.Zoom) || viewport.Zoom < MinZoom || viewport.Zoom > MaxZoom)
        {
            throw new AuthoringCanvasValidationException("canvas_viewport_zoom_invalid");
        }
    }

    public static void ValidateNode(AuthoringCanvasNode node)
    {
        ArgumentNullException.ThrowIfNull(node);
        if (node.Id == Guid.Empty || node.Order < 0)
        {
            throw new AuthoringCanvasValidationException("canvas_node_identity_invalid");
        }

        ValidateCoordinate(node.Geometry.X, "canvas_node_x_invalid");
        ValidateCoordinate(node.Geometry.Y, "canvas_node_y_invalid");
        ValidateExtent(node.Geometry.Width, "canvas_node_width_invalid");
        ValidateExtent(node.Geometry.Height, "canvas_node_height_invalid");

        if (!Enum.IsDefined(node.Type))
        {
            throw new AuthoringCanvasValidationException("canvas_node_type_unknown");
        }

        ValidateNodeShape(node);
    }

    public static void ValidateEdge(AuthoringCanvasEdge edge)
    {
        ArgumentNullException.ThrowIfNull(edge);
        if (edge.Id == Guid.Empty
            || edge.SourceNodeId == Guid.Empty
            || edge.TargetNodeId == Guid.Empty
            || edge.Order < 0)
        {
            throw new AuthoringCanvasValidationException("canvas_edge_identity_invalid");
        }

        if (!Enum.IsDefined(edge.Type))
        {
            throw new AuthoringCanvasValidationException("canvas_edge_type_unknown");
        }

        ValidateOptionalPlainText(edge.Label, MaxEdgeLabelLength, "canvas_edge_label_invalid");
    }

    public static string ComputeNodeDigest(AuthoringCanvasNode node)
    {
        ValidateNode(node);
        string members = string.Join(',', node.MemberNodeIds.Order());
        return HashCanonical(
            SchemaVersion,
            node.Id,
            (int)node.Type,
            node.Order,
            node.Geometry.X,
            node.Geometry.Y,
            node.Geometry.Width,
            node.Geometry.Height,
            node.TargetArticleId,
            node.TargetHeadingIdentity,
            node.TargetBlockIdentity,
            node.PinnedTargetRevision,
            node.DisplayProjectionReference,
            node.ReferenceState,
            node.NoteSource,
            node.FrameLabel,
            members);
    }

    public static string ComputeEdgeDigest(AuthoringCanvasEdge edge)
    {
        ValidateEdge(edge);
        return HashCanonical(
            SchemaVersion,
            edge.Id,
            (int)edge.Type,
            edge.Order,
            edge.SourceNodeId,
            edge.TargetNodeId,
            edge.Label);
    }

    public static string ComputeCommandDigest(params object?[] values)
        => HashCanonical(values);

    public static string ComputeTransitionDigest(
        string previousDigest,
        long revision,
        string commandKind,
        string commandDigest,
        int nodeCount,
        int edgeCount)
        => HashCanonical(
            SchemaVersion,
            previousDigest,
            revision,
            commandKind,
            commandDigest,
            nodeCount,
            edgeCount);

    private static void ValidateNodeShape(AuthoringCanvasNode node)
    {
        bool isReference = node.Type is AuthoringCanvasNodeType.ArticleReference
            or AuthoringCanvasNodeType.HeadingReference
            or AuthoringCanvasNodeType.BlockReference;
        if (isReference)
        {
            if (node.TargetArticleId is not > 0
                || node.NoteSource is not null
                || node.FrameLabel is not null
                || node.MemberNodeIds.Count != 0)
            {
                throw new AuthoringCanvasValidationException("canvas_reference_shape_invalid");
            }

            ValidateOptionalIdentity(
                node.DisplayProjectionReference,
                MaxProjectionReferenceLength,
                "canvas_projection_reference_invalid");
            if (node.ReferenceState is null || !Enum.IsDefined(node.ReferenceState.Value))
            {
                throw new AuthoringCanvasValidationException("canvas_reference_state_invalid");
            }

            if (node.Type == AuthoringCanvasNodeType.ArticleReference
                && (node.TargetHeadingIdentity is not null || node.TargetBlockIdentity is not null))
            {
                throw new AuthoringCanvasValidationException("canvas_article_reference_shape_invalid");
            }

            if (node.Type == AuthoringCanvasNodeType.HeadingReference)
            {
                ValidateRequiredIdentity(
                    node.TargetHeadingIdentity,
                    MaxReferenceIdentityLength,
                    "canvas_heading_identity_invalid");
                if (node.TargetBlockIdentity is not null)
                {
                    throw new AuthoringCanvasValidationException("canvas_heading_reference_shape_invalid");
                }
            }

            if (node.Type == AuthoringCanvasNodeType.BlockReference)
            {
                ValidateRequiredIdentity(
                    node.TargetBlockIdentity,
                    MaxReferenceIdentityLength,
                    "canvas_block_identity_invalid");
                if (node.TargetHeadingIdentity is not null)
                {
                    throw new AuthoringCanvasValidationException("canvas_block_reference_shape_invalid");
                }
            }

            return;
        }

        if (node.TargetArticleId is not null
            || node.TargetHeadingIdentity is not null
            || node.TargetBlockIdentity is not null
            || node.PinnedTargetRevision is not null
            || node.DisplayProjectionReference is not null
            || node.ReferenceState is not null)
        {
            throw new AuthoringCanvasValidationException("canvas_non_reference_shape_invalid");
        }

        if (node.Type == AuthoringCanvasNodeType.PlainTextNote)
        {
            ValidateRequiredPlainText(node.NoteSource, MaxNoteSourceLength, "canvas_note_source_invalid");
            if (node.FrameLabel is not null || node.MemberNodeIds.Count != 0)
            {
                throw new AuthoringCanvasValidationException("canvas_note_shape_invalid");
            }
            return;
        }

        if (node.Type == AuthoringCanvasNodeType.GroupFrame)
        {
            ValidateRequiredPlainText(node.FrameLabel, MaxFrameLabelLength, "canvas_frame_label_invalid");
            if (node.NoteSource is not null
                || node.MemberNodeIds.Count > MaxNodesPerCanvas
                || node.MemberNodeIds.Any(static memberId => memberId == Guid.Empty)
                || node.MemberNodeIds.Count != node.MemberNodeIds.Distinct().Count()
                || node.MemberNodeIds.Contains(node.Id))
            {
                throw new AuthoringCanvasValidationException("canvas_frame_members_invalid");
            }
            return;
        }

        throw new AuthoringCanvasValidationException("canvas_node_type_unknown");
    }

    private static void ValidateCoordinate(double value, string code)
    {
        if (!double.IsFinite(value) || Math.Abs(value) > MaxCoordinateMagnitude)
        {
            throw new AuthoringCanvasValidationException(code);
        }
    }

    private static void ValidateExtent(double value, string code)
    {
        if (!double.IsFinite(value) || value < MinNodeExtent || value > MaxNodeExtent)
        {
            throw new AuthoringCanvasValidationException(code);
        }
    }

    private static void ValidateRequiredIdentity(string? value, int maxLength, string code)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > maxLength || ContainsControlCharacter(value))
        {
            throw new AuthoringCanvasValidationException(code);
        }
    }

    private static void ValidateOptionalIdentity(string? value, int maxLength, string code)
    {
        if (value is not null)
        {
            ValidateRequiredIdentity(value, maxLength, code);
        }
    }

    private static void ValidateRequiredPlainText(string? value, int maxLength, string code)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new AuthoringCanvasValidationException(code);
        }
        ValidateOptionalPlainText(value, maxLength, code);
    }

    private static void ValidateOptionalPlainText(string? value, int maxLength, string code)
    {
        if (value is null)
        {
            return;
        }

        if (value.Length > maxLength
            || ContainsControlCharacter(value)
            || HtmlLikePayloadPattern().IsMatch(value))
        {
            throw new AuthoringCanvasValidationException(code);
        }
    }

    private static bool ContainsControlCharacter(string value)
        => value.Any(static character => char.IsControl(character)
            && character is not '\n' and not '\r' and not '\t');

    private static string HashCanonical(params object?[] values)
    {
        var canonical = new StringBuilder();
        foreach (object? value in values)
        {
            string text = value switch
            {
                null => "null",
                double number => number.ToString("R", System.Globalization.CultureInfo.InvariantCulture),
                IFormattable formattable => formattable.ToString(null, System.Globalization.CultureInfo.InvariantCulture),
                _ => value.ToString() ?? string.Empty
            };
            canonical.Append(text.Length).Append(':').Append(text).Append(';');
        }

        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(canonical.ToString())));
    }
}

public readonly record struct AuthoringCanvasOwner(long AdminPrincipalId, string SiteScope);

public readonly record struct AuthoringCanvasViewport(double X, double Y, double Zoom);

public readonly record struct AuthoringCanvasGeometry(double X, double Y, double Width, double Height);

public enum AuthoringCanvasNodeType
{
    ArticleReference = 0,
    HeadingReference = 1,
    BlockReference = 2,
    PlainTextNote = 3,
    GroupFrame = 4
}

public enum AuthoringCanvasEdgeType
{
    VisualOnly = 0,
    ExplicitReferenceNote = 1
}

public enum AuthoringCanvasReferenceState
{
    Unresolved = 0,
    Current = 1,
    Pinned = 2,
    Stale = 3,
    Missing = 4,
    PermissionDenied = 5
}

public sealed record AuthoringCanvasNode(
    Guid Id,
    AuthoringCanvasNodeType Type,
    int Order,
    AuthoringCanvasGeometry Geometry,
    int? TargetArticleId = null,
    string? TargetHeadingIdentity = null,
    string? TargetBlockIdentity = null,
    long? PinnedTargetRevision = null,
    string? DisplayProjectionReference = null,
    AuthoringCanvasReferenceState? ReferenceState = null,
    string? NoteSource = null,
    string? FrameLabel = null,
    IReadOnlyList<Guid>? Members = null)
{
    public IReadOnlyList<Guid> MemberNodeIds { get; } = Members is null ? [] : [.. Members];
}

public sealed record AuthoringCanvasEdge(
    Guid Id,
    AuthoringCanvasEdgeType Type,
    int Order,
    Guid SourceNodeId,
    Guid TargetNodeId,
    string? Label = null);

public sealed record AuthoringCanvasDocumentHeader(
    Guid Id,
    AuthoringCanvasOwner Owner,
    int SchemaVersion,
    long Revision,
    string Title,
    AuthoringCanvasViewport Viewport,
    int NodeCount,
    int EdgeCount,
    DateTime CreatedAtUtc,
    DateTime UpdatedAtUtc,
    string ContentDigest);

public readonly record struct AuthoringCanvasPageCursor(long Order, Guid Id);

public sealed record AuthoringCanvasPage<T>(
    IReadOnlyList<T> Items,
    AuthoringCanvasPageCursor? NextCursor);

public sealed record CreateAuthoringCanvasCommand(
    Guid CanvasId,
    AuthoringCanvasOwner Owner,
    string Title,
    AuthoringCanvasViewport Viewport,
    Guid RequestId);

public sealed record PutAuthoringCanvasNodeCommand(
    Guid CanvasId,
    AuthoringCanvasOwner Owner,
    long ExpectedRevision,
    Guid RequestId,
    AuthoringCanvasNode Node);

public sealed record DeleteAuthoringCanvasNodeCommand(
    Guid CanvasId,
    AuthoringCanvasOwner Owner,
    long ExpectedRevision,
    Guid RequestId,
    Guid NodeId);

public sealed record PutAuthoringCanvasEdgeCommand(
    Guid CanvasId,
    AuthoringCanvasOwner Owner,
    long ExpectedRevision,
    Guid RequestId,
    AuthoringCanvasEdge Edge);

public sealed record DeleteAuthoringCanvasEdgeCommand(
    Guid CanvasId,
    AuthoringCanvasOwner Owner,
    long ExpectedRevision,
    Guid RequestId,
    Guid EdgeId);

public sealed record UpdateAuthoringCanvasMetadataCommand(
    Guid CanvasId,
    AuthoringCanvasOwner Owner,
    long ExpectedRevision,
    Guid RequestId,
    string Title,
    AuthoringCanvasViewport Viewport);

public sealed record DeleteAuthoringCanvasCommand(
    Guid CanvasId,
    AuthoringCanvasOwner Owner,
    long ExpectedRevision,
    Guid RequestId);

public sealed record AuthoringCanvasWriteReceipt(
    Guid ReceiptId,
    Guid CanvasId,
    long Revision,
    string CommandKind,
    int NodeCount,
    int EdgeCount,
    bool IdempotentReplay,
    string CommandDigest,
    string ContentDigest,
    DateTime CreatedAtUtc);

public sealed record AuthoringCanvasVerificationResult(
    Guid CanvasId,
    long Revision,
    int VerifiedNodeCount,
    int VerifiedEdgeCount,
    string ContentDigest,
    bool Valid,
    IReadOnlyList<string> Reasons);

public sealed class AuthoringCanvasValidationException(string code) : Exception(code)
{
    public string Code { get; } = code;
}

public sealed class AuthoringCanvasAccessDeniedException()
    : Exception("authoring_canvas_unavailable");

public sealed class AuthoringCanvasRevisionConflictException(long expectedRevision, long actualRevision)
    : Exception("authoring_canvas_revision_conflict")
{
    public long ExpectedRevision { get; } = expectedRevision;

    public long ActualRevision { get; } = actualRevision;
}

public sealed class AuthoringCanvasIdempotencyConflictException()
    : Exception("authoring_canvas_idempotency_conflict");

public sealed class AuthoringCanvasBudgetExceededException(string code) : Exception(code)
{
    public string Code { get; } = code;
}
