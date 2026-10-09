using System.Data;
using System.Diagnostics;

using FsusBlog.Server.Entities;
using FsusBlog.Shared.Contracts.ArticleEmbeds;
using FsusBlog.Shared.Contracts.ArticleGraph;
using FsusBlog.Shared.Contracts.ArticleRelations;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

internal sealed record ArticleGraphNodeReadRequest(
    AuthorArticlePinOwner Owner,
    Guid RequestId,
    IReadOnlyList<ArticleRelationArticleCoordinate> Candidates,
    ArticleGraphScope Scope,
    ArticleGraphFilters Filters,
    int RemainingReadOperations,
    int RemainingMilliseconds);

/// <summary>
/// Consumes canonical article coordinates and the existing permission/article readers for bounded
/// current node facts. Coordinates and a root admission never grant a neighbor permission.
/// This adapter produces no edges, runtime epochs, metadata-filter facts, or complete graph receipt.
/// </summary>
/// <remarks>
/// The sole graph composer supplies its remaining operation/time allocation and must verify the
/// staged read immediately before publication, alongside the native adjacency lease. Coordinate
/// reads remain exact calls to the canonical authority; metadata is read in authorized batches.
/// Published-source selection and category/tag filters require their real producers and are refused.
/// </remarks>
public sealed class ArticleGraphNodeProjectionConsumer
{
    private readonly IAuthorArticlePinPermissionProjectionProvider _permissions;
    private readonly IAuthorArticlePinArticleProjectionSource _articles;
    private readonly Func<int, long, CancellationToken, Task<ArticleRelationRevisionCoordinate?>> _readCoordinate;
    private readonly Func<bool> _canReadFresh;

    /// <summary>Uses native readers without provisioning or caching canonical coordinates.</summary>
    public ArticleGraphNodeProjectionConsumer(
        ISqlSugarClient db,
        ArticleRelationSourceCoordinateAuthority coordinates,
        IAuthorArticlePinPermissionProjectionProvider permissions,
        IAuthorArticlePinArticleProjectionSource articles)
        : this(permissions, articles,
            (articleId, revisionId, token) => coordinates.ReadRevisionAsync(db, articleId, revisionId, token),
            () => db.Ado.Transaction is null || db.Ado.Transaction.IsolationLevel == IsolationLevel.ReadCommitted)
    {
    }

    internal ArticleGraphNodeProjectionConsumer(
        IAuthorArticlePinPermissionProjectionProvider permissions,
        IAuthorArticlePinArticleProjectionSource articles,
        Func<int, long, CancellationToken, Task<ArticleRelationRevisionCoordinate?>> readCoordinate,
        Func<bool> canReadFresh)
    {
        _permissions = permissions;
        _articles = articles;
        _readCoordinate = readCoordinate;
        _canReadFresh = canReadFresh;
    }

    internal async Task<NodeRead?> ReadAsync(ArticleGraphNodeReadRequest request, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        NodeRead? read = null;
        try
        {
            AuthorArticlePinContract.ValidateOwner(request.Owner);
            AuthorArticlePinContract.ValidateRequestId(request.RequestId);
            ArticleRelationArticleCoordinate[] candidates = Copy(request.Candidates, 1000);
            string[] categories = Copy(request.Filters.Categories, 32);
            string[] tags = Copy(request.Filters.Tags, 32);
            ArticleGraphEdgeKind[] kinds = Copy(request.Filters.Kinds, 4);
            if (request.Scope != ArticleGraphScope.CurrentEditable
                || categories.Length != 0 || tags.Length != 0
                || kinds.Length == 0 || kinds.Any(static kind => !Enum.IsDefined(kind))
                || kinds.Distinct().Count() != kinds.Length
                || request.RemainingReadOperations is < 1 or > 4096
                || request.RemainingMilliseconds is < 1 or > 250
                || candidates.Any(static value => value.ArticleId <= 0
                    || !ArticleEmbedTargetCodec.IsPortableArticleIdentity(value.ArticleIdentity))
                || candidates.Select(static value => value.ArticleId).Distinct().Count() != candidates.Length
                || candidates.Select(static value => value.ArticleIdentity).Distinct(StringComparer.Ordinal).Count() != candidates.Length)
            {
                return null;
            }
            read = new NodeRead(this, request with
            {
                Candidates = Array.AsReadOnly(candidates),
                Filters = new(Array.AsReadOnly(categories), Array.AsReadOnly(tags), Array.AsReadOnly(kinds))
            });
            Snapshot snapshot = await CaptureAsync(read, cancellationToken).ConfigureAwait(false);
            read.Snapshot = snapshot;
            read.Projected = Project(snapshot);
            read.Check();
            cancellationToken.ThrowIfCancellationRequested();
            return read;
        }
        catch (Exception)
        {
            read?.Invalidate();
            cancellationToken.ThrowIfCancellationRequested();
            return null;
        }
    }

    internal async Task<bool> VerifyAsync(NodeRead read, CancellationToken cancellationToken = default)
    {
        if (read.Creator != this || !read.TryEnter())
        {
            read.Invalidate();
            cancellationToken.ThrowIfCancellationRequested();
            return false;
        }
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            Snapshot fresh = await CaptureAsync(read, cancellationToken).ConfigureAwait(false);
            bool current = SamePermission(read.Snapshot!.Permission, fresh.Permission)
                && read.Snapshot.Articles.SequenceEqual(fresh.Articles)
                && read.Snapshot.Sources.SequenceEqual(fresh.Sources)
                && read.Projected.SequenceEqual(Project(fresh));
            read.Check();
            if (!current)
            {
                read.Invalidate();
            }
            return current;
        }
        catch (Exception)
        {
            read.Invalidate();
            cancellationToken.ThrowIfCancellationRequested();
            return false;
        }
        finally
        {
            read.Exit();
        }
    }

    private async Task<Snapshot> CaptureAsync(NodeRead read, CancellationToken callerToken)
    {
        using CancellationTokenSource deadline = CancellationTokenSource.CreateLinkedTokenSource(callerToken);
        deadline.CancelAfter(read.RemainingTime());
        CancellationToken token = deadline.Token;
        ArticleGraphNodeReadRequest request = read.Request;
        AuthorArticlePinPermissionSnapshot preflight = await PermissionAsync(read, [], token).ConfigureAwait(false);
        int[] ids = request.Candidates.Select(static candidate => candidate.ArticleId).ToArray();
        AuthorArticlePinPermissionSnapshot permission = await PermissionAsync(read, ids, token).ConfigureAwait(false);
        Require(SameContext(preflight, permission));
        HashSet<int> allowed = permission.Decisions.Where(static decision => decision.CanProject && decision.CanOpen)
            .Select(static decision => decision.ArticleId).ToHashSet();
        ArticleRelationArticleCoordinate[] candidates = request.Candidates.Where(candidate => allowed.Contains(candidate.ArticleId))
            .OrderBy(static candidate => candidate.ArticleId).ToArray();
        int[] authorizedIds = candidates.Select(static candidate => candidate.ArticleId).ToArray();
        read.RequireCapacity(candidates.Length == 0 ? 1 : 2 * candidates.Length + 3);
        AuthorArticlePinArticleFact[] articles = await ArticlesAsync(read, authorizedIds, token).ConfigureAwait(false);
        ArticleRelationRevisionCoordinate[] sources = await CoordinatesAsync(read, candidates, articles, token).ConfigureAwait(false);
        AuthorArticlePinArticleFact[] freshArticles = await ArticlesAsync(read, authorizedIds, token).ConfigureAwait(false);
        Require(articles.SequenceEqual(freshArticles));
        ArticleRelationRevisionCoordinate[] freshSources = await CoordinatesAsync(read, candidates, freshArticles, token).ConfigureAwait(false);
        Require(sources.SequenceEqual(freshSources));
        AuthorArticlePinPermissionSnapshot freshPermission = await PermissionAsync(read, ids, token).ConfigureAwait(false);
        Require(SamePermission(permission, freshPermission));
        read.Check();
        token.ThrowIfCancellationRequested();
        return new Snapshot(freshPermission, freshArticles, freshSources);
    }

    private async Task<AuthorArticlePinPermissionSnapshot> PermissionAsync(NodeRead read, IReadOnlyList<int> ids, CancellationToken token)
    {
        read.Take();
        AuthorArticlePinPermissionSnapshot value = await _permissions.ResolveAsync(
            new(read.Request.Owner, read.Request.RequestId, Array.AsReadOnly(ids.ToArray())), token).WaitAsync(token).ConfigureAwait(false);
        value = value with
        {
            Decisions = Array.AsReadOnly(Copy(value.Decisions, ids.Count))
        };
        Require(value.Status == AuthorArticlePinPermissionSnapshotStatus.Current && value.Owner == read.Request.Owner
            && AuthorArticlePinProjectionContract.IsRequiredRevisionReference(value.PermissionRevision)
            && AuthorArticlePinProjectionContract.IsRequiredRevisionReference(value.SiteRevision)
            && AuthorArticlePinProjectionContract.IsRequiredRevisionReference(value.SessionRevision)
            && value.Decisions.Count == ids.Count
            && value.Decisions.Select(static decision => decision.ArticleId).Order().SequenceEqual(ids.Order())
            && value.Decisions.All(static decision => AuthorArticlePinProjectionContract.IsRequiredRevisionReference(decision.PermissionReference))
            && value.ContentDigest == AuthorArticlePinProjectionContract.ComputePermissionDigest(value));
        token.ThrowIfCancellationRequested();
        return value;
    }

    private async Task<AuthorArticlePinArticleFact[]> ArticlesAsync(NodeRead read, int[] ids, CancellationToken token)
    {
        if (ids.Length == 0)
        {
            return [];
        }
        read.Take();
        AuthorArticlePinArticleFact[] articles = Copy(await _articles.ReadCurrentBatchAsync(Array.AsReadOnly(ids), token)
            .WaitAsync(token).ConfigureAwait(false), ids.Length).OrderBy(static article => article.ArticleId).ToArray();
        Require(articles.Length == ids.Length && articles.Select(static article => article.ArticleId).SequenceEqual(ids)
            && articles.All(static article => article.Exists && !article.IsDeleted && Enum.IsDefined(article.Status)
                && article.Status != ArticleStatus.Deleted && article.Title is { Length: <= 256 }
                && article.CurrentRevisionId > 0 && article.RevisionNo > 0
                && AuthorArticlePinProjectionContract.IsRequiredRevisionReference(article.ArticleVersionReference)
                && AuthorArticlePinProjectionContract.IsRequiredRevisionReference(article.RevisionVersionReference)
                && article.ContentDigest == AuthorArticlePinProjectionContract.ComputeArticleFactDigest(article)));
        token.ThrowIfCancellationRequested();
        return articles;
    }

    private async Task<ArticleRelationRevisionCoordinate[]> CoordinatesAsync(NodeRead read,
        ArticleRelationArticleCoordinate[] candidates, AuthorArticlePinArticleFact[] articles, CancellationToken token)
    {
        var sources = new ArticleRelationRevisionCoordinate[candidates.Length];
        for (int index = 0; index < candidates.Length; index++)
        {
            read.Take();
            ArticleRelationRevisionCoordinate? source = await _readCoordinate(candidates[index].ArticleId,
                articles[index].CurrentRevisionId, token).WaitAsync(token).ConfigureAwait(false);
            Require(source is not null && source.ArticleId == candidates[index].ArticleId
                && source.ArticleIdentity == candidates[index].ArticleIdentity
                && source.RevisionId == articles[index].CurrentRevisionId && source.RevisionNo == articles[index].RevisionNo
                && source.SourceEpoch != Guid.Empty && IsRevisionIdentity(source.RevisionIdentity));
            sources[index] = source!;
            token.ThrowIfCancellationRequested();
        }
        return sources;
    }

    private static bool SameContext(AuthorArticlePinPermissionSnapshot first, AuthorArticlePinPermissionSnapshot second)
        => first.Owner == second.Owner && first.PermissionRevision == second.PermissionRevision
            && first.SiteRevision == second.SiteRevision && first.SessionRevision == second.SessionRevision;

    private static bool SamePermission(AuthorArticlePinPermissionSnapshot first, AuthorArticlePinPermissionSnapshot second)
        => SameContext(first, second) && first.ContentDigest == second.ContentDigest && first.Decisions.SequenceEqual(second.Decisions);

    private static bool IsRevisionIdentity(string identity)
        => identity is not null && identity.StartsWith("revision:", StringComparison.Ordinal)
            && Guid.TryParseExact(identity[9..], "D", out Guid value) && value != Guid.Empty && identity == $"revision:{value:D}";

    private static ArticleRelationLifecycleState Lifecycle(ArticleStatus status)
        => status switch
        {
            ArticleStatus.Draft => ArticleRelationLifecycleState.Draft,
            ArticleStatus.Scheduled => ArticleRelationLifecycleState.Scheduled,
            ArticleStatus.Published => ArticleRelationLifecycleState.Published,
            ArticleStatus.Archived => ArticleRelationLifecycleState.Archived,
            _ => throw new InvalidOperationException("graph_node_unavailable")
        };

    private static IReadOnlyList<ArticleGraphNode> Project(Snapshot snapshot)
        => Array.AsReadOnly(snapshot.Sources.Select((source, index) => new ArticleGraphNode(
            source.ArticleIdentity, source.RevisionIdentity, snapshot.Articles[index].Title,
            Lifecycle(snapshot.Articles[index].Status))).OrderBy(static node => node.ArticleIdentity, StringComparer.Ordinal).ToArray());

    private static T[] Copy<T>(IReadOnlyList<T> values, int maximum)
    {
        int count = values.Count;
        Require(count >= 0 && count <= maximum);
        var copy = new T[count];
        for (int index = 0; index < count; index++)
        {
            copy[index] = values[index];
        }
        Require(values.Count == count);
        return copy;
    }

    private static void Require(bool condition)
    {
        if (!condition)
        {
            throw new InvalidOperationException("graph_node_unavailable");
        }
    }

    internal sealed record Snapshot(AuthorArticlePinPermissionSnapshot Permission,
        AuthorArticlePinArticleFact[] Articles, ArticleRelationRevisionCoordinate[] Sources);

    internal sealed class NodeRead(ArticleGraphNodeProjectionConsumer creator, ArticleGraphNodeReadRequest request)
    {
        private readonly long _started = Stopwatch.GetTimestamp();
        private int _operations;
        private int _entered;
        private bool _valid = true;

        internal ArticleGraphNodeProjectionConsumer Creator { get; } = creator;
        internal ArticleGraphNodeReadRequest Request { get; } = request;
        internal Snapshot? Snapshot
        {
            get; set;
        }
        internal IReadOnlyList<ArticleGraphNode> Projected { get; set; } = [];
        internal IReadOnlyList<ArticleGraphNode> Nodes => _valid ? Projected : [];
        internal int ReadOperations => _operations;

        internal bool TryEnter() => _valid && Interlocked.CompareExchange(ref _entered, 1, 0) == 0;
        internal void Exit() => Interlocked.Exchange(ref _entered, 0);
        internal void Invalidate() => _valid = false;
        internal TimeSpan RemainingTime()
        {
            TimeSpan remaining = TimeSpan.FromMilliseconds(Request.RemainingMilliseconds) - Stopwatch.GetElapsedTime(_started);
            Require(_valid && remaining > TimeSpan.Zero);
            return remaining;
        }
        internal void Check()
        {
            Require(Creator._canReadFresh());
            _ = RemainingTime();
        }
        internal void RequireCapacity(int operations)
        {
            Check();
            Require(operations <= Request.RemainingReadOperations - _operations);
        }
        internal void Take()
        {
            RequireCapacity(1);
            _operations++;
        }
    }
}
