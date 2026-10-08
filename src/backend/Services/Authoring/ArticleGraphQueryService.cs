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
        string? reason = ArticleGraphContract.Validate(request);
        if (reason is not null)
        {
            return Empty(request, ArticleGraphStatus.Refused, reason);
        }
        request = request with
        {
            Filters = request.Filters with
            {
                Categories = Array.AsReadOnly(request.Filters.Categories.ToArray()),
                Tags = Array.AsReadOnly(request.Filters.Tags.ToArray()),
                Kinds = Array.AsReadOnly(request.Filters.Kinds.ToArray())
            }
        };
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
            if (projection.Nodes.Count > request.Budget.Nodes || projection.Edges.Count > request.Budget.Edges)
            {
                return Empty(request, ArticleGraphStatus.Refused, "source-budget");
            }
            // Freeze the source-owned lists before validating and sealing; callers cannot mutate returned facts.
            projection = projection with
            {
                Nodes = Array.AsReadOnly(projection.Nodes.ToArray()),
                Edges = Array.AsReadOnly(projection.Edges.ToArray())
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
