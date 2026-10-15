using FsusBlog.Shared.Contracts.ArticleGraph;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>Integration port owned by the canonical relation query. It must filter permissions before expansion/counts/budgets.</summary>
public interface IArticleGraphRelationProjection
{
    /// <summary>Returns an actor-bound bounded projection, or null when the real source is unavailable. Never scan source text.</summary>
    Task<ArticleGraphProjection?> ReadAsync(ArticleGraphRequest request, CancellationToken cancellationToken);
}

/// <summary>Default until the original owner supplies the real relation API; unavailable never falls back to a scanner.</summary>
public sealed class ArticleGraphUnavailableRelationProjection : IArticleGraphRelationProjection
{
    public Task<ArticleGraphProjection?> ReadAsync(ArticleGraphRequest request, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult<ArticleGraphProjection?>(null);
    }
}

/// <summary>Bounded read-only admission around the sole relation source. This class has no index, cache, writer or transport registration.</summary>
public sealed class ArticleGraphQueryService(IArticleGraphRelationProjection source)
{
    public async Task<ArticleGraphResult> QueryAsync(ArticleGraphRequest request, CancellationToken cancellationToken)
    {
        IReadOnlyList<string>? categories = Snapshot(request.Filters.Categories, 32);
        IReadOnlyList<string>? tags = Snapshot(request.Filters.Tags, 32);
        IReadOnlyList<ArticleGraphEdgeKind>? kinds = Snapshot(request.Filters.Kinds, 4);
        request = request with
        {
            Filters = request.Filters with
            {
                Categories = categories ?? Array.Empty<string>(),
                Tags = tags ?? Array.Empty<string>(),
                // An empty kind set keeps a failed snapshot invalid through refusal sealing.
                Kinds = categories is null || tags is null || kinds is null ? Array.Empty<ArticleGraphEdgeKind>() : kinds
            }
        };
        string? reason = ArticleGraphContract.Validate(request);
        if (reason is not null)
        {
            return Empty(request, ArticleGraphStatus.Refused, reason);
        }
        using CancellationTokenSource deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(request.Budget.QueryMilliseconds);
        try
        {
            ArticleGraphProjection? projection = await source.ReadAsync(request, deadline.Token).WaitAsync(deadline.Token);
            deadline.Token.ThrowIfCancellationRequested();
            if (projection is null)
            {
                return Empty(request, ArticleGraphStatus.Unavailable, "relation-api-unavailable");
            }
            IReadOnlyList<ArticleGraphNode>? nodes = Snapshot(projection.Nodes, request.Budget.Nodes);
            IReadOnlyList<ArticleGraphEdge>? edges = Snapshot(projection.Edges, request.Budget.Edges);
            if (nodes is null || edges is null)
            {
                return Empty(request, ArticleGraphStatus.Refused, "source-budget");
            }
            // Freeze the source-owned lists before validating and sealing; callers cannot mutate returned facts.
            projection = projection with
            {
                Nodes = nodes,
                Edges = edges
            };
            reason = ArticleGraphContract.Validate(request, projection);
            return reason is null ? ArticleGraphContract.Seal(request, projection)
                : Empty(request, reason == "stale-identity" ? ArticleGraphStatus.Stale : ArticleGraphStatus.Refused, reason);
        }
        catch (OperationCanceledException) when (deadline.IsCancellationRequested)
        {
            return Empty(request, ArticleGraphStatus.Cancelled, cancellationToken.IsCancellationRequested ? "cancelled" : "time-budget");
        }
    }

    private static IReadOnlyList<T>? Snapshot<T>(IReadOnlyList<T> values, int maximum)
    {
        int count = values.Count;
        if (count < 0 || count > maximum)
        {
            return null;
        }
        T[] snapshot = new T[count];
        for (int index = 0; index < count; index++)
        {
            snapshot[index] = values[index];
        }
        return values.Count == count ? Array.AsReadOnly(snapshot) : null;
    }

    private static ArticleGraphResult Empty(ArticleGraphRequest request, ArticleGraphStatus status, string reason)
    {
        if (ArticleGraphContract.Validate(request) is not null)
        {
            // Refusal must not serialize an invalid, potentially unbounded request back to the caller.
            request = request with
            {
                SchemaVersion = 0,
                SessionId = "invalid-request",
                Identity = new(new("invalid", "invalid", ""), "invalid", "invalid", "invalid", "invalid")
            };
        }
        return ArticleGraphContract.Seal(request, new(request.Identity, request.RequestedDepth ?? 1, 0, status, reason,
            Array.Empty<ArticleGraphNode>(), Array.Empty<ArticleGraphEdge>(), new(0, 0, 0, 0), ""));
    }
}
