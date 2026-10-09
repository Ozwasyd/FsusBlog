using System.Data;
using System.Diagnostics;

using FsusBlog.Shared.Contracts.ArticleEmbeds;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

internal sealed record ArticleGraphNodeCandidates(
    IReadOnlyList<ArticleRelationArticleCoordinate> Coordinates,
    int ReadOperations,
    int RemainingMilliseconds);

/// <summary>
/// Resolves portable identities supplied by the original permission-filtered adjacency source
/// through the sole canonical coordinate reader. These internal coordinates grant no node access;
/// the node consumer must independently authorize every neighbor before reading metadata.
/// No graph, relation index, source scanner, host, cache or publication proof is created here.
/// </summary>
public sealed class ArticleGraphNodeCandidateResolver
{
    private readonly IAuthorArticlePinPermissionProjectionProvider _permissions;
    private readonly Func<string, CancellationToken, Task<ArticleRelationArticleCoordinate?>> _findArticle;
    private readonly Func<bool> _canReadFresh;

    /// <summary>Delegates mapping to the original coordinate authority without provisioning or writing.</summary>
    public ArticleGraphNodeCandidateResolver(ISqlSugarClient db, ArticleRelationSourceCoordinateAuthority coordinates,
        IAuthorArticlePinPermissionProjectionProvider permissions)
        : this(permissions, (identity, token) => coordinates.FindArticleAsync(db, identity, token),
            () => db.Ado.Transaction is null || db.Ado.Transaction.IsolationLevel == IsolationLevel.ReadCommitted)
    {
    }

    internal ArticleGraphNodeCandidateResolver(IAuthorArticlePinPermissionProjectionProvider permissions,
        Func<string, CancellationToken, Task<ArticleRelationArticleCoordinate?>> findArticle, Func<bool> canReadFresh)
    {
        _permissions = permissions;
        _findArticle = findArticle;
        _canReadFresh = canReadFresh;
    }

    internal async Task<ArticleGraphNodeCandidates?> ResolveAsync(AuthorArticlePinOwner owner, Guid requestId,
        IReadOnlyList<string> nativeArticleIdentities, int remainingReadOperations, int remainingMilliseconds,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        long started = Stopwatch.GetTimestamp();
        try
        {
            AuthorArticlePinContract.ValidateOwner(owner);
            AuthorArticlePinContract.ValidateRequestId(requestId);
            int count = nativeArticleIdentities.Count;
            if (count is < 0 or > 1000 || remainingReadOperations is < 1 or > 4096
                || remainingMilliseconds is < 1 or > 250 || count + 2 > remainingReadOperations)
            {
                return null;
            }
            var identities = new string[count];
            for (int index = 0; index < count; index++)
            {
                identities[index] = nativeArticleIdentities[index];
            }
            if (nativeArticleIdentities.Count != count || identities.Any(static identity => !ArticleEmbedTargetCodec.IsPortableArticleIdentity(identity))
                || identities.Distinct(StringComparer.Ordinal).Count() != count)
            {
                return null;
            }
            Array.Sort(identities, StringComparer.Ordinal);
            using CancellationTokenSource deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            TimeSpan remainingTime = TimeSpan.FromMilliseconds(remainingMilliseconds) - Stopwatch.GetElapsedTime(started);
            if (remainingTime <= TimeSpan.Zero)
            {
                return null;
            }
            deadline.CancelAfter(remainingTime);
            CancellationToken token = deadline.Token;
            CheckFresh();
            AuthorArticlePinPermissionSnapshot before = await ContextAsync(owner, requestId, token).ConfigureAwait(false);
            var coordinates = new ArticleRelationArticleCoordinate[count];
            var numericIds = new HashSet<int>();
            for (int index = 0; index < count; index++)
            {
                CheckFresh();
                ArticleRelationArticleCoordinate? coordinate = await _findArticle(identities[index], token)
                    .WaitAsync(token).ConfigureAwait(false);
                if (coordinate is null || coordinate.ArticleId <= 0 || coordinate.ArticleIdentity != identities[index]
                    || !numericIds.Add(coordinate.ArticleId))
                {
                    return null;
                }
                coordinates[index] = coordinate;
                token.ThrowIfCancellationRequested();
            }
            AuthorArticlePinPermissionSnapshot after = await ContextAsync(owner, requestId, token).ConfigureAwait(false);
            CheckFresh();
            token.ThrowIfCancellationRequested();
            int remaining = (int)Math.Floor(remainingMilliseconds - Stopwatch.GetElapsedTime(started).TotalMilliseconds);
            if (before.ContentDigest != after.ContentDigest || remaining < 1)
            {
                return null;
            }
            return new(Array.AsReadOnly(coordinates), count + 2, remaining);
        }
        catch (Exception)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return null;
        }
    }

    private async Task<AuthorArticlePinPermissionSnapshot> ContextAsync(AuthorArticlePinOwner owner, Guid requestId, CancellationToken token)
    {
        AuthorArticlePinPermissionSnapshot value = await _permissions.ResolveAsync(new(owner, requestId, []), token)
            .WaitAsync(token).ConfigureAwait(false);
        // An empty context snapshot authenticates the lookup call, never any neighbor or metadata.
        if (value.Status != AuthorArticlePinPermissionSnapshotStatus.Current || value.Owner != owner || value.Decisions.Count != 0
            || !AuthorArticlePinProjectionContract.IsRequiredRevisionReference(value.PermissionRevision)
            || !AuthorArticlePinProjectionContract.IsRequiredRevisionReference(value.SiteRevision)
            || !AuthorArticlePinProjectionContract.IsRequiredRevisionReference(value.SessionRevision))
        {
            throw new InvalidOperationException("graph_candidate_unavailable");
        }
        value = value with
        {
            Decisions = Array.Empty<AuthorArticlePinPermissionDecision>()
        };
        if (value.ContentDigest != AuthorArticlePinProjectionContract.ComputePermissionDigest(value))
        {
            throw new InvalidOperationException("graph_candidate_unavailable");
        }
        token.ThrowIfCancellationRequested();
        return value;
    }

    private void CheckFresh()
    {
        if (!_canReadFresh())
        {
            throw new InvalidOperationException("graph_candidate_unavailable");
        }
    }
}
