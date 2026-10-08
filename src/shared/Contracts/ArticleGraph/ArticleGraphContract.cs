using System.Security.Cryptography;
using System.Text.Json;

namespace FsusBlog.Shared.Contracts.ArticleGraph;

/// <summary>Admission and response guards do not reconstruct, filter, or index relations.</summary>
public static class ArticleGraphContract
{
    public const int Version = 1;

    public static string? Validate(ArticleGraphRequest request)
    {
        if (request.SchemaVersion != Version || !ValidIdentity(request.Identity)
            || !ValidId(request.SessionId) || request.Sequence < 0 || !Enum.IsDefined(request.Scope))
        {
            return "invalid-request";
        }
        if (request.RequestedDepth is not (null or 1 or 2)
            || request.RequestedDepth == 2 && !request.ExplicitExpansion)
        {
            return "invalid-depth";
        }
        ArticleGraphBudget budget = request.Budget;
        ArticleGraphBudget maximum = ArticleGraphBudget.Default;
        if (budget.Nodes is < 1 || budget.Nodes > maximum.Nodes || budget.Edges is < 1 || budget.Edges > maximum.Edges
            || budget.PayloadBytes is < 1024 || budget.PayloadBytes > maximum.PayloadBytes
            || budget.IndexOperations is < 1 || budget.IndexOperations > maximum.IndexOperations
            || budget.QueryMilliseconds is < 1 || budget.QueryMilliseconds > maximum.QueryMilliseconds)
        {
            return "invalid-budget";
        }
        ArticleGraphFilters filters = request.Filters;
        if (!ValidIds(filters.Categories) || !ValidIds(filters.Tags) || filters.Kinds.Count is < 1 or > 4
            || filters.Kinds.Distinct().Count() != filters.Kinds.Count || filters.Kinds.Any(kind => !Enum.IsDefined(kind)))
        {
            return "invalid-filter";
        }
        return null;
    }

    public static string? Validate(ArticleGraphRequest request, ArticleGraphProjection projection)
    {
        if (projection.Identity != request.Identity || projection.RequestedDepth != (request.RequestedDepth ?? 1))
        {
            return "stale-identity";
        }
        if (projection.Status is not (ArticleGraphStatus.Complete or ArticleGraphStatus.Truncated)
            || projection.EffectiveDepth < 1 || projection.EffectiveDepth > projection.RequestedDepth
            || projection.Status == ArticleGraphStatus.Complete && (projection.EffectiveDepth != projection.RequestedDepth || projection.Reason is not null)
            || projection.Status == ArticleGraphStatus.Truncated && projection.Reason is not ("node-budget" or "edge-budget" or "payload-budget" or "index-budget" or "time-budget")
            || !ValidDigest(projection.SourceDigest))
        {
            return "invalid-projection";
        }
        if (projection.Nodes.Count > request.Budget.Nodes || projection.Edges.Count > request.Budget.Edges
            || projection.Usage.Nodes != projection.Nodes.Count || projection.Usage.Edges != projection.Edges.Count
            || projection.Usage.IndexOperations < 0 || projection.Usage.IndexOperations > request.Budget.IndexOperations)
        {
            return "source-budget";
        }
        HashSet<string> identities = new(StringComparer.Ordinal);
        string? previous = null;
        foreach (ArticleGraphNode node in projection.Nodes)
        {
            if (!ValidId(node.ArticleIdentity) || !ValidId(node.RevisionIdentity) || node.Title.Length > 256
                || !Enum.IsDefined(node.Lifecycle) || !identities.Add(node.ArticleIdentity)
                || previous is not null && StringComparer.Ordinal.Compare(previous, node.ArticleIdentity) >= 0)
            {
                return "invalid-node";
            }
            previous = node.ArticleIdentity;
        }
        if (!identities.Contains(request.Identity.RootArticle))
        {
            return "missing-root";
        }
        Dictionary<string, string> revisions = projection.Nodes.ToDictionary(node => node.ArticleIdentity, node => node.RevisionIdentity, StringComparer.Ordinal);
        if (revisions[request.Identity.RootArticle] != request.Identity.RootRevision)
        {
            return "stale-identity";
        }
        previous = null;
        foreach (ArticleGraphEdge edge in projection.Edges)
        {
            if (!ValidId(edge.RelationIdentity) || !identities.Contains(edge.SourceArticle)
                || edge.TargetArticle is not null && !identities.Contains(edge.TargetArticle)
                || edge.TargetArticle is null && edge.Kind is not (ArticleGraphEdgeKind.Broken or ArticleGraphEdgeKind.VisibilityRisk)
                || !request.Filters.Kinds.Contains(edge.Kind) || !Enum.IsDefined(edge.Resolution)
                || edge.Source.ArticleIdentity != edge.SourceArticle || !ValidId(edge.Source.RevisionIdentity)
                || revisions[edge.SourceArticle] != edge.Source.RevisionIdentity
                || !ValidId(edge.Source.DocumentEpoch) || edge.Source.Start < 0 || edge.Source.End <= edge.Source.Start
                || !ValidDigest(edge.Source.RecordDigest)
                || previous is not null && StringComparer.Ordinal.Compare(previous, edge.RelationIdentity) >= 0)
            {
                return "invalid-edge";
            }
            previous = edge.RelationIdentity;
        }
        int payloadBytes = JsonSerializer.SerializeToUtf8Bytes(projection).Length;
        if (payloadBytes > request.Budget.PayloadBytes || projection.Usage.PayloadBytes < 0
            || projection.Usage.PayloadBytes > request.Budget.PayloadBytes)
        {
            return "source-budget";
        }
        return null;
    }

    public static ArticleGraphResult Seal(ArticleGraphRequest request, ArticleGraphProjection projection)
    {
        ArticleGraphResult unsigned = new(Version, request.SessionId, request.Sequence, ComputeRequestDigest(request), projection, "");
        return unsigned with
        {
            ContentDigest = ComputeDigest(unsigned)
        };
    }

    public static string ComputeDigest(ArticleGraphResult result)
        => Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(result with
        {
            ContentDigest = ""
        })));

    public static string ComputeRequestDigest(ArticleGraphRequest request)
        => Validate(request) is null
            ? Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(request)))
            : "";

    private static bool ValidIdentity(ArticleGraphIdentity identity)
        => ValidId(identity.Actor.ActorIdentity) && ValidId(identity.Actor.SiteIdentity)
            && ValidDigest(identity.Actor.PermissionContextDigest) && ValidId(identity.RootArticle)
            && ValidId(identity.RootRevision) && ValidId(identity.DocumentEpoch) && ValidId(identity.IndexGeneration);

    private static bool ValidIds(IReadOnlyList<string> values)
        => values.Count <= 32 && values.All(ValidId) && values.Distinct(StringComparer.Ordinal).Count() == values.Count;

    private static bool ValidId(string value)
        => value.Length is > 0 and <= 128 && value.All(character => char.IsAsciiLetterOrDigit(character) || character is ':' or '-' or '_' or '.');

    private static bool ValidDigest(string value)
        => value.Length == 64 && value.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');
}
