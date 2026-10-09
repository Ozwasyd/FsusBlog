using System.Diagnostics.CodeAnalysis;
using System.Text.Json;

using FsusBlog.Shared.Contracts.ArticleGraph;
using FsusBlog.Shared.Contracts.ArticleRelations;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Pure adapter to the existing articleGraphQuery.ts result vocabulary. Original seals cover the
/// server contracts, not this flattened view. Mapping does not grant permission or revalidate a source.
/// </summary>
internal static class ArticleGraphClientProjectionMapper
{
    private const long MaximumClientSequence = 9_007_199_254_740_991;

    internal static ClientResult Map(ArticleGraphRequest request, ArticleGraphResult result)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(result);
        Require(BoundedIdentity(request.Identity) && BoundedText(request.SessionId, 128)
            && request.Filters is not null && request.Budget is not null, "invalid-request", nameof(request));
        ArticleGraphFilters filters = request.Filters;
        request = request with
        {
            Filters = filters with
            {
                Categories = Freeze(filters.Categories, 32, nameof(request)),
                Tags = Freeze(filters.Tags, 32, nameof(request)),
                Kinds = Freeze(filters.Kinds, 4, nameof(request))
            }
        };
        Require(request.Filters.Categories.All(value => BoundedText(value, 128))
            && request.Filters.Tags.All(value => BoundedText(value, 128))
            && request.Sequence <= MaximumClientSequence, "invalid-request", nameof(request));
        Require(ArticleGraphContract.Validate(request) is null, "invalid-request", nameof(request));
        Require(JsonSerializer.SerializeToUtf8Bytes(request).Length <= request.Budget.PayloadBytes,
            "source-budget", nameof(request));

        ArticleGraphProjection projection = result.Projection;
        Require(projection is not null && BoundedIdentity(projection.Identity) && projection.Usage is not null
            && BoundedText(result.SessionId, 128) && BoundedText(result.RequestDigest, 64)
            && BoundedText(result.ContentDigest, 64) && BoundedText(projection.SourceDigest, 64)
            && (projection.Reason is null || BoundedText(projection.Reason, 128)), "invalid-result", nameof(result));
        projection = projection with
        {
            Nodes = Freeze(projection.Nodes, request.Budget.Nodes, nameof(result)),
            Edges = Freeze(projection.Edges, request.Budget.Edges, nameof(result))
        };
        Require(projection.Nodes.All(node => node is not null && BoundedText(node.ArticleIdentity, 128)
            && BoundedText(node.RevisionIdentity, 128) && BoundedText(node.Title, 256))
            && projection.Edges.All(edge => edge is not null && BoundedText(edge.RelationIdentity, 128)
                && BoundedText(edge.SourceArticle, 128) && (edge.TargetArticle is null || BoundedText(edge.TargetArticle, 128))
                && edge.Source is not null && BoundedText(edge.Source.ArticleIdentity, 128)
                && BoundedText(edge.Source.RevisionIdentity, 128) && BoundedText(edge.Source.DocumentEpoch, 128)
                && BoundedText(edge.Source.RecordDigest, 64)), "invalid-result", nameof(result));
        result = result with
        {
            Projection = projection
        };
        Require(result.SchemaVersion == request.SchemaVersion && result.SessionId == request.SessionId
            && result.Sequence == request.Sequence && projection.Identity == request.Identity
            && projection.RequestedDepth == (request.RequestedDepth ?? 1), "stale-identity", nameof(result));
        Require(JsonSerializer.SerializeToUtf8Bytes(result).Length <= request.Budget.PayloadBytes,
            "source-budget", nameof(result));
        Require(result.RequestDigest == ArticleGraphContract.ComputeRequestDigest(request), "request-digest", nameof(result));
        Require(result.ContentDigest == ArticleGraphContract.ComputeDigest(result), "content-digest", nameof(result));

        string status = MapStatus(projection.Status);
        if (projection.Status is ArticleGraphStatus.Complete or ArticleGraphStatus.Truncated)
        {
            Require(ArticleGraphContract.Validate(request, projection) is null, "invalid-projection", nameof(result));
            Require(projection.Edges.All(edge => edge.SourceArticle != request.Identity.RootArticle
                || edge.Source.DocumentEpoch == request.Identity.DocumentEpoch), "stale-identity", nameof(result));
        }
        else
        {
            Require(projection.Nodes.Count == 0 && projection.Edges.Count == 0 && projection.EffectiveDepth == 0
                && projection.Usage == new ArticleGraphUsage(0, 0, 0, 0) && projection.SourceDigest.Length == 0
                && !string.IsNullOrEmpty(projection.Reason), "nonempty-refusal", nameof(result));
        }

        ArticleGraphIdentity identity = projection.Identity;
        ClientResult client = new(result.SchemaVersion,
            new(identity.Actor.ActorIdentity, identity.Actor.SiteIdentity, identity.Actor.PermissionContextDigest,
                identity.RootArticle, identity.RootRevision, identity.DocumentEpoch, identity.IndexGeneration),
            result.SessionId, result.Sequence, projection.RequestedDepth, projection.EffectiveDepth, status, projection.Reason,
            Array.AsReadOnly(projection.Nodes.Select(node => new ClientNode(node.ArticleIdentity, node.RevisionIdentity,
                node.Title, MapLifecycle(node.Lifecycle))).ToArray()),
            Array.AsReadOnly(projection.Edges.Select(edge => new ClientEdge(edge.RelationIdentity, edge.SourceArticle,
                edge.TargetArticle, MapKind(edge.Kind), MapResolution(edge.Resolution),
                new(edge.Source.ArticleIdentity, edge.Source.RevisionIdentity, edge.Source.DocumentEpoch,
                    edge.Source.Start, edge.Source.End, edge.Source.RecordDigest))).ToArray()),
            projection.SourceDigest, result.RequestDigest, result.ContentDigest);
        Require(JsonSerializer.SerializeToUtf8Bytes(client, JsonSerializerOptions.Web).Length <= request.Budget.PayloadBytes,
            "source-budget", nameof(result));
        return client;
    }

    private static IReadOnlyList<T> Freeze<T>(IReadOnlyList<T>? values, int maximum, string parameter)
    {
        Require(values is not null, "invalid-collection", parameter);
        int count = values!.Count;
        Require(count >= 0 && count <= maximum, "source-budget", parameter);
        T[] snapshot = new T[count];
        for (int index = 0; index < count; index++)
        {
            snapshot[index] = values[index];
        }
        Require(values.Count == count, "changed-collection", parameter);
        return Array.AsReadOnly(snapshot);
    }

    private static bool BoundedText(string? value, int maximum) => value is not null && value.Length <= maximum;

    private static bool BoundedIdentity(ArticleGraphIdentity? identity)
        => identity is not null && identity.Actor is not null && BoundedText(identity.Actor.ActorIdentity, 128)
            && BoundedText(identity.Actor.SiteIdentity, 128) && BoundedText(identity.Actor.PermissionContextDigest, 64)
            && BoundedText(identity.RootArticle, 128) && BoundedText(identity.RootRevision, 128)
            && BoundedText(identity.DocumentEpoch, 128) && BoundedText(identity.IndexGeneration, 128);

    private static void Require([DoesNotReturnIf(false)] bool condition, string reason, string parameter)
    {
        if (!condition)
        {
            throw new ArgumentException(reason, parameter);
        }
    }

    private static string MapStatus(ArticleGraphStatus value) => value switch
    {
        ArticleGraphStatus.Complete => "complete",
        ArticleGraphStatus.Truncated => "truncated",
        ArticleGraphStatus.Unavailable => "unavailable",
        ArticleGraphStatus.Refused => "refused",
        ArticleGraphStatus.Stale => "stale",
        ArticleGraphStatus.Cancelled => "cancelled",
        _ => throw new ArgumentException("invalid-status", nameof(value))
    };

    private static string MapKind(ArticleGraphEdgeKind value) => value switch
    {
        ArticleGraphEdgeKind.Link => "link",
        ArticleGraphEdgeKind.Embed => "embed",
        ArticleGraphEdgeKind.Broken => "broken",
        ArticleGraphEdgeKind.VisibilityRisk => "visibility-risk",
        _ => throw new ArgumentException("invalid-kind", nameof(value))
    };

    private static string MapLifecycle(ArticleRelationLifecycleState value) => value switch
    {
        ArticleRelationLifecycleState.Draft => "draft",
        ArticleRelationLifecycleState.Scheduled => "scheduled",
        ArticleRelationLifecycleState.Published => "published",
        ArticleRelationLifecycleState.Archived => "archived",
        ArticleRelationLifecycleState.Deleted => "deleted",
        _ => throw new ArgumentException("invalid-lifecycle", nameof(value))
    };

    private static string MapResolution(ArticleRelationResolutionStatus value) => value switch
    {
        ArticleRelationResolutionStatus.Resolved => "resolved",
        ArticleRelationResolutionStatus.MissingTarget => "missing-target",
        ArticleRelationResolutionStatus.MissingAnchor => "missing-anchor",
        ArticleRelationResolutionStatus.Deleted => "deleted",
        ArticleRelationResolutionStatus.Archived => "archived",
        ArticleRelationResolutionStatus.Unauthorized => "unauthorized",
        ArticleRelationResolutionStatus.Private => "private",
        ArticleRelationResolutionStatus.Draft => "draft",
        ArticleRelationResolutionStatus.Stale => "stale",
        ArticleRelationResolutionStatus.Ambiguous => "ambiguous",
        ArticleRelationResolutionStatus.Unsupported => "unsupported",
        _ => throw new ArgumentException("invalid-resolution", nameof(value))
    };

    // Internal views of the frontend's existing types; camel-case serialization is an adapter concern.
    internal sealed record ClientIdentity(string Actor, string Site, string PermissionDigest, string RootArticle,
        string RootRevision, string DocumentEpoch, string IndexGeneration);

    internal sealed record ClientNode(string ArticleIdentity, string RevisionIdentity, string Title, string Lifecycle);

    internal sealed record ClientSource(string ArticleIdentity, string RevisionIdentity, string DocumentEpoch,
        int Start, int End, string RecordDigest);

    internal sealed record ClientEdge(string RelationIdentity, string SourceArticle, string? TargetArticle,
        string Kind, string Resolution, ClientSource Source);

    internal sealed record ClientResult(int SchemaVersion, ClientIdentity Identity, string SessionId, long Sequence,
        int RequestedDepth, int EffectiveDepth, string Status, string? Reason, IReadOnlyList<ClientNode> Nodes,
        IReadOnlyList<ClientEdge> Edges, string SourceDigest, string RequestDigest, string ContentDigest);
}
