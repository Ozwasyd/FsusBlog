using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace FsusBlog.Shared.Contracts.AuthoringCanvas;

public static partial class AuthoringCanvasReferenceContract
{
    public const int SchemaVersion = 1;
    public const int MaxBatchSize = AuthoringCanvasContract.MaxNodesPerCanvas;
    public const int MaxTitleLength = 256;
    public const int MaxContextSnippetLength = 320;
    public const int MaxRouteLength = 512;
    public const int MaxPermissionFingerprintLength = 128;
    public const int MaxWorkspaceGroupIdLength = 128;
    public const int DefaultCacheCapacity = 4_096;

    [GeneratedRegex("^[0-9a-f]{64}$", RegexOptions.CultureInvariant)]
    private static partial Regex DigestPattern();

    public static void ValidateRequest(AuthoringCanvasReferenceResolutionRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (request.CanvasId == Guid.Empty
            || request.RequestId == Guid.Empty
            || request.CanvasRevision <= 0
            || !DigestPattern().IsMatch(request.CanvasContentDigest))
        {
            throw new AuthoringCanvasValidationException("canvas_reference_request_invalid");
        }

        AuthoringCanvasContract.ValidateOwner(request.Owner);
        if (!Enum.IsDefined(request.Permission))
        {
            throw new AuthoringCanvasValidationException("canvas_reference_permission_invalid");
        }
        ValidateOptionalWorkspaceGroupId(request.TargetWorkspaceGroupId);
        if (request.Nodes.Count > MaxBatchSize)
        {
            throw new AuthoringCanvasBudgetExceededException("canvas_reference_batch_budget_exceeded");
        }

        var nodeIds = new HashSet<Guid>();
        foreach (AuthoringCanvasNode node in request.Nodes)
        {
            AuthoringCanvasContract.ValidateNode(node);
            if (node.Type is not (AuthoringCanvasNodeType.ArticleReference
                or AuthoringCanvasNodeType.HeadingReference
                or AuthoringCanvasNodeType.BlockReference))
            {
                throw new AuthoringCanvasValidationException("canvas_reference_node_required");
            }
            if (!nodeIds.Add(node.Id))
            {
                throw new AuthoringCanvasValidationException("canvas_reference_node_duplicate");
            }
        }
    }

    public static void ValidateAuthorityCoordinate(AuthoringCanvasReferenceAuthorityCoordinate coordinate)
    {
        if (coordinate.Generation <= 0 || !DigestPattern().IsMatch(coordinate.ContentDigest))
        {
            throw new AuthoringCanvasValidationException("canvas_reference_authority_coordinate_invalid");
        }
        ValidatePermissionFingerprint(coordinate.PermissionFingerprint);
    }

    public static void ValidateFact(AuthoringCanvasReferenceTarget target, AuthoringCanvasReferenceFact fact)
    {
        ArgumentNullException.ThrowIfNull(fact);
        if (fact.NodeId != target.NodeId
            || fact.TargetArticleId != target.TargetArticleId
            || !Enum.IsDefined(fact.ArticleState)
            || !Enum.IsDefined(fact.CoordinateState)
            || fact.CurrentRevision < 0
            || fact.ResolvedRevision < 0)
        {
            throw new AuthoringCanvasValidationException("canvas_reference_fact_invalid");
        }

        bool authorized = fact.ArticleState is not AuthoringCanvasArticleState.PermissionDeniedOrUnknown;
        if (!authorized)
        {
            if (fact.Title is not null
                || fact.ContextSnippet is not null
                || fact.StableRoute is not null
                || fact.DisplayProjectionReference is not null
                || fact.CurrentRevision != 0
                || fact.ResolvedRevision != 0)
            {
                throw new AuthoringCanvasValidationException("canvas_reference_permission_fact_leak");
            }
            return;
        }

        if (fact.ArticleState == AuthoringCanvasArticleState.Current
            && fact.CoordinateState is AuthoringCanvasReferenceCoordinateState.Current
                or AuthoringCanvasReferenceCoordinateState.SourceStale)
        {
            if (fact.CurrentRevision <= 0 || fact.ResolvedRevision <= 0)
            {
                throw new AuthoringCanvasValidationException("canvas_reference_revision_invalid");
            }
            long expectedResolvedRevision = target.PinnedTargetRevision ?? fact.CurrentRevision;
            if (fact.ResolvedRevision != expectedResolvedRevision)
            {
                throw new AuthoringCanvasValidationException("canvas_reference_resolved_revision_mismatch");
            }
        }

        ValidateOptionalDisplayText(fact.Title, MaxTitleLength, "canvas_reference_title_invalid");
        ValidateOptionalDisplayText(
            fact.ContextSnippet,
            MaxContextSnippetLength,
            "canvas_reference_context_invalid");
        ValidateOptionalRoute(fact.StableRoute);
        if (fact.DisplayProjectionReference is not null
            && !DigestPattern().IsMatch(fact.DisplayProjectionReference))
        {
            throw new AuthoringCanvasValidationException("canvas_reference_display_projection_invalid");
        }
    }

    public static string ComputeTargetDigest(AuthoringCanvasReferenceTarget target)
        => HashCanonical(
            SchemaVersion,
            target.NodeId,
            (int)target.NodeType,
            target.TargetArticleId,
            target.TargetHeadingIdentity,
            target.TargetBlockIdentity,
            target.PinnedTargetRevision,
            target.DisplayProjectionReference);

    public static string ComputeProjectionDigest(AuthoringCanvasReferenceProjection projection)
        => HashCanonical(
            SchemaVersion,
            projection.NodeId,
            (int)projection.NodeType,
            projection.TargetArticleId,
            projection.TargetHeadingIdentity,
            projection.TargetBlockIdentity,
            projection.DisplayProjectionReference,
            (int)projection.Status,
            projection.Title,
            projection.ContextSnippet,
            projection.TargetRevision,
            projection.CurrentTargetRevision,
            projection.OpenIntent?.ArticleId,
            projection.OpenIntent?.Revision,
            projection.OpenIntent?.HeadingIdentity,
            projection.OpenIntent?.BlockIdentity,
            projection.OpenIntent?.StableRoute,
            projection.OpenIntent?.TargetGroupId,
            projection.OpenIntent is null ? null : (int)projection.OpenIntent.Mode,
            projection.UpdateAvailable);

    public static string ComputeBatchDigest(
        AuthoringCanvasReferenceResolutionRequest request,
        AuthoringCanvasReferenceAuthorityCoordinate coordinate,
        IEnumerable<AuthoringCanvasReferenceProjection> projections)
        => HashCanonical(
            SchemaVersion,
            request.CanvasId,
            request.CanvasRevision,
            request.CanvasContentDigest,
            request.Owner.AdminPrincipalId,
            request.Owner.SiteScope,
            (int)request.Permission,
            request.TargetWorkspaceGroupId,
            coordinate.Generation,
            coordinate.ContentDigest,
            coordinate.PermissionFingerprint,
            string.Join(',', projections.Select(static projection => projection.ContentDigest)));

    public static string ComputeReceiptDigest(
        AuthoringCanvasReferenceResolutionRequest request,
        AuthoringCanvasReferenceAuthorityCoordinate coordinate,
        IEnumerable<AuthoringCanvasReferenceResolutionReceiptItem> items,
        string batchDigest,
        int targetCount,
        int cacheHitCount,
        long elapsedMilliseconds)
        => HashCanonical(
            SchemaVersion,
            request.RequestId,
            request.CanvasId,
            request.CanvasRevision,
            request.CanvasContentDigest,
            request.Owner.AdminPrincipalId,
            request.Owner.SiteScope,
            (int)request.Permission,
            request.TargetWorkspaceGroupId,
            coordinate.Generation,
            coordinate.ContentDigest,
            coordinate.PermissionFingerprint,
            string.Join(',', items.Select(static item => HashCanonical(
                item.NodeId,
                item.TargetArticleId,
                item.TargetHeadingIdentity,
                item.TargetBlockIdentity,
                item.TargetRevision,
                (int)item.Status,
                item.Title,
                item.ContextSnippet,
                item.OpenIntent?.ArticleId,
                item.OpenIntent?.Revision,
                item.OpenIntent?.HeadingIdentity,
                item.OpenIntent?.BlockIdentity,
                item.OpenIntent?.StableRoute,
                item.OpenIntent?.TargetGroupId,
                item.OpenIntent is null ? null : (int)item.OpenIntent.Mode,
                item.ContentDigest))),
            batchDigest,
            targetCount,
            cacheHitCount,
            elapsedMilliseconds);

    private static void ValidatePermissionFingerprint(string value)
    {
        if (string.IsNullOrWhiteSpace(value)
            || value.Length > MaxPermissionFingerprintLength
            || value.Any(static character => char.IsControl(character)))
        {
            throw new AuthoringCanvasValidationException("canvas_reference_permission_invalid");
        }
    }

    private static void ValidateOptionalDisplayText(string? value, int maximumLength, string code)
    {
        if (value is null)
        {
            return;
        }
        if (value.Length == 0
            || value.Length > maximumLength
            || value.Any(static character => char.IsControl(character)
                && character is not '\n' and not '\r' and not '\t')
            || value.Contains('<', StringComparison.Ordinal)
            || value.Contains('>', StringComparison.Ordinal))
        {
            throw new AuthoringCanvasValidationException(code);
        }
    }

    private static void ValidateOptionalRoute(string? route)
    {
        if (route is null)
        {
            return;
        }
        if (route.Length == 0
            || route.Length > MaxRouteLength
            || !route.StartsWith("/", StringComparison.Ordinal)
            || route.StartsWith("//", StringComparison.Ordinal)
            || route.Any(static character => char.IsControl(character)))
        {
            throw new AuthoringCanvasValidationException("canvas_reference_route_invalid");
        }
    }

    private static void ValidateOptionalWorkspaceGroupId(string? value)
    {
        if (value is null)
        {
            return;
        }
        if (string.IsNullOrWhiteSpace(value)
            || value.Length > MaxWorkspaceGroupIdLength
            || value.Any(static character => char.IsControl(character)))
        {
            throw new AuthoringCanvasValidationException("canvas_reference_workspace_group_invalid");
        }
    }

    private static string HashCanonical(params object?[] values)
    {
        var canonical = new StringBuilder();
        foreach (object? value in values)
        {
            string text = value switch
            {
                null => "null",
                IFormattable formattable => formattable.ToString(null, System.Globalization.CultureInfo.InvariantCulture),
                _ => value.ToString() ?? string.Empty
            };
            canonical.Append(text.Length).Append(':').Append(text).Append(';');
        }
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(canonical.ToString())));
    }
}

public enum AuthoringCanvasReferenceProjectionStatus
{
    Current = 0,
    PinnedCurrent = 1,
    PinnedStale = 2,
    TargetUpdated = 3,
    Missing = 4,
    Deleted = 5,
    Archived = 6,
    PermissionDeniedOrUnknown = 7,
    HeadingMissing = 8,
    HeadingDuplicate = 9,
    HeadingInvalid = 10,
    BlockMissing = 11,
    BlockDuplicate = 12,
    BlockInvalid = 13,
    SourceStale = 14
}

public enum AuthoringCanvasArticleState
{
    Current = 0,
    Missing = 1,
    Deleted = 2,
    Archived = 3,
    PermissionDeniedOrUnknown = 4
}

public enum AuthoringCanvasReferenceCoordinateState
{
    Current = 0,
    Missing = 1,
    Duplicate = 2,
    Invalid = 3,
    SourceStale = 4
}

public sealed record AuthoringCanvasReferenceResolutionRequest(
    Guid RequestId,
    Guid CanvasId,
    long CanvasRevision,
    string CanvasContentDigest,
    AuthoringCanvasOwner Owner,
    AuthoringCanvasReferencePermission Permission,
    IReadOnlyList<AuthoringCanvasNode> Nodes,
    string? TargetWorkspaceGroupId = null);

public enum AuthoringCanvasReferencePermission
{
    ArticleRead = 0
}

public sealed record AuthoringCanvasReferenceTarget(
    Guid NodeId,
    AuthoringCanvasNodeType NodeType,
    int TargetArticleId,
    string? TargetHeadingIdentity,
    string? TargetBlockIdentity,
    long? PinnedTargetRevision,
    string? DisplayProjectionReference);

public readonly record struct AuthoringCanvasReferenceAuthorityCoordinate(
    long Generation,
    string ContentDigest,
    string PermissionFingerprint);

public sealed record AuthoringCanvasReferenceFact(
    Guid NodeId,
    int TargetArticleId,
    AuthoringCanvasArticleState ArticleState,
    AuthoringCanvasReferenceCoordinateState CoordinateState,
    long CurrentRevision,
    long ResolvedRevision,
    bool TargetChangedSinceProjection,
    string? Title,
    string? ContextSnippet,
    string? StableRoute)
{
    public string? DisplayProjectionReference
    {
        get; init;
    }
}

public sealed record AuthoringCanvasReferenceFactQuery(
    Guid CanvasId,
    long CanvasRevision,
    string CanvasContentDigest,
    AuthoringCanvasOwner Owner,
    AuthoringCanvasReferencePermission Permission,
    AuthoringCanvasReferenceAuthorityCoordinate AuthorityCoordinate,
    IReadOnlyList<AuthoringCanvasReferenceTarget> Targets);

public interface IAuthoringCanvasReferenceFactSource
{
    Task<AuthoringCanvasReferenceAuthorityCoordinate> ReadAuthorityCoordinateAsync(
        AuthoringCanvasOwner owner,
        AuthoringCanvasReferencePermission permission,
        CancellationToken cancellationToken = default);

    Task<IReadOnlyList<AuthoringCanvasReferenceFact>> ReadBatchAsync(
        AuthoringCanvasReferenceFactQuery query,
        CancellationToken cancellationToken = default);
}

public sealed record AuthoringCanvasOpenIntent(
    int ArticleId,
    long Revision,
    string? HeadingIdentity,
    string? BlockIdentity,
    string StableRoute,
    AuthoringCanvasOpenIntentMode Mode = AuthoringCanvasOpenIntentMode.OpenOrActivate,
    string? TargetGroupId = null);

public enum AuthoringCanvasOpenIntentMode
{
    OpenOrActivate = 0
}

public sealed record AuthoringCanvasReferenceProjection(
    Guid NodeId,
    AuthoringCanvasNodeType NodeType,
    int TargetArticleId,
    string? TargetHeadingIdentity,
    string? TargetBlockIdentity,
    AuthoringCanvasReferenceProjectionStatus Status,
    string? Title,
    string? ContextSnippet,
    long? TargetRevision,
    long? CurrentTargetRevision,
    AuthoringCanvasOpenIntent? OpenIntent,
    bool UpdateAvailable,
    string ContentDigest)
{
    public string? DisplayProjectionReference
    {
        get; init;
    }
}

public sealed record AuthoringCanvasReferenceResolutionReceiptItem(
    Guid NodeId,
    int TargetArticleId,
    string? TargetHeadingIdentity,
    string? TargetBlockIdentity,
    long? TargetRevision,
    AuthoringCanvasReferenceProjectionStatus Status,
    string? Title,
    string? ContextSnippet,
    AuthoringCanvasOpenIntent? OpenIntent,
    string ContentDigest);

public sealed record AuthoringCanvasReferenceResolutionReceipt(
    Guid RequestId,
    Guid CanvasId,
    long CanvasRevision,
    string CanvasContentDigest,
    AuthoringCanvasReferencePermission Permission,
    string PermissionFingerprint,
    long AuthorityGeneration,
    string AuthorityContentDigest,
    int TargetCount,
    int CacheHitCount,
    long ElapsedMilliseconds,
    IReadOnlyList<AuthoringCanvasReferenceResolutionReceiptItem> Items,
    string ContentDigest);

public sealed record AuthoringCanvasReferenceResolutionBatch(
    Guid CanvasId,
    long CanvasRevision,
    string CanvasContentDigest,
    AuthoringCanvasReferenceAuthorityCoordinate AuthorityCoordinate,
    IReadOnlyList<AuthoringCanvasReferenceProjection> Projections,
    string ContentDigest,
    AuthoringCanvasReferenceResolutionReceipt Receipt);

public sealed record AuthoringCanvasReferenceVerificationResult(
    Guid CanvasId,
    long CanvasRevision,
    int VerifiedProjectionCount,
    string ContentDigest,
    bool Valid,
    IReadOnlyList<string> Reasons);
