using System.Collections.Immutable;

using FsusBlog.Server.Entities;

using static FsusBlog.Server.Services.Authoring.SqlAuthorRecentArticleHistoryPermissionAuthority;

namespace FsusBlog.Server.Services.Authoring;

public sealed partial class AuthorFullTextSearchQueryEvaluator
{
    /// <summary>
    /// Authenticates and revalidates actual SQL actor/session/ownership/lifecycle facts
    /// around the sole typed-AST inspector and original source verifier, including an
    /// empty corpus. Output remains bounded token evidence, not a complete ranked
    /// result, facet, snippet, cursor response or durable authorization receipt.
    /// </summary>
    public async Task<AuthorSearchTokenEvaluation> InspectIndexAsync(
        AuthorSearchQuery query, IReadOnlyDictionary<Guid, ArticlePropertyDefinition> definitions,
        IAuthorFullTextSearchIndexSource currentSource,
        SqlAuthorRecentArticleHistoryPermissionAuthority currentPermissionAuthority,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);
        ArgumentNullException.ThrowIfNull(definitions);
        ArgumentNullException.ThrowIfNull(currentSource);
        ArgumentNullException.ThrowIfNull(currentPermissionAuthority);
        cancellationToken.ThrowIfCancellationRequested();
        AuthorFullTextSearchContract.ValidateQuery(query, definitions);
        FullTextQueryPermissionObservation? initial = await currentPermissionAuthority.ObserveFullTextQueryPermissionAsync(
            new(new(query.UserId, query.SiteScope), query.QueryId, []), cancellationToken).ConfigureAwait(false);
        if (initial is null)
        {
            throw PermissionUnavailable();
        }
        var fence = new CurrentPermissionFence(query, currentPermissionAuthority, initial);
        fence.RequireIdentity(initial);
        AuthorSearchTokenEvaluation evaluation = await InspectIndexCoreAsync(query, definitions, fence, cancellationToken)
            .ConfigureAwait(false);
        await fence.CheckAsync(cancellationToken).ConfigureAwait(false);
        fence.RequireIndexCurrent(index);
        AuthorSearchIndexReadSnapshot snapshot = await index.ReadSnapshotAsync(query.UserId, query.SiteScope,
            query.IndexInstanceId, query.IndexGeneration, cancellationToken).ConfigureAwait(false);
        await fence.CheckAsync(cancellationToken).ConfigureAwait(false);
        fence.RequireIndexCurrent(index);
        if (evaluation.SourceGeneration != snapshot.SourceGeneration
            || evaluation.SnapshotDigest != SnapshotDigest(snapshot, cancellationToken))
        {
            throw new AuthorSearchContractException("author_search_index_source_snapshot_stale");
        }
        try
        {
            await AuthorFullTextSearchIndexVerifier.VerifyAsync(snapshot,
                new PermissionCheckedSource(currentSource, fence, index), cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            // Current authority/cancellation takes precedence on verifier errors too.
            // If these fences pass, the original verifier exception propagates intact.
            await fence.CheckAsync(cancellationToken).ConfigureAwait(false);
            fence.RequireIndexCurrent(index);
        }
        // The SQL owner performs its own final context/clock checks. No further await
        // follows this synchronous index/registry fence before bounded evidence returns.
        AuthorFullTextSearchContract.ValidateQuery(query, definitions);
        ValidatePropertyPredicates(query, definitions);
        foreach (AuthorSearchIndexedArticle article in snapshot.Articles.Values)
        {
            if (!fence.Allows(article))
            {
                continue;
            }
            foreach (AuthorSearchTokenizedDocument document in article.Documents)
            {
                cancellationToken.ThrowIfCancellationRequested();
                ValidatePropertyDocument(document.Document, article, definitions);
            }
        }
        cancellationToken.ThrowIfCancellationRequested();
        return evaluation;
    }

    private static AuthorSearchContractException PermissionUnavailable()
        => new("author_search_current_permission_unavailable");

    /// <summary>
    /// Fences every real page read, including a throwing or terminal read, before the
    /// verifier can consume that page or request another. This delegates unchanged
    /// source coordinates and never manufactures source data or authorization facts.
    /// </summary>
    private sealed class PermissionCheckedSource(
        IAuthorFullTextSearchIndexSource source, CurrentPermissionFence fence, AuthorFullTextSearchIndex index)
        : IAuthorFullTextSearchIndexSource
    {
        public async Task<AuthorSearchIndexSourcePage> ReadAsync(int userId, string siteScope, int afterArticleId,
            int pageSize, long? expectedSourceGeneration, CancellationToken cancellationToken)
        {
            await fence.CheckAsync(cancellationToken).ConfigureAwait(false);
            fence.RequireIndexCurrent(index);
            try
            {
                return await source.ReadAsync(userId, siteScope, afterArticleId, pageSize,
                    expectedSourceGeneration, cancellationToken).ConfigureAwait(false);
            }
            finally
            {
                await fence.CheckAsync(cancellationToken).ConfigureAwait(false);
                fence.RequireIndexCurrent(index);
            }
        }
    }

    private sealed class CurrentPermissionFence(
        AuthorSearchQuery query, SqlAuthorRecentArticleHistoryPermissionAuthority authority,
        FullTextQueryPermissionObservation initial)
    {
        private FullTextQueryPermissionObservation _current = initial;
        private ImmutableDictionary<int, FullTextArticleState> _articles = ImmutableDictionary<int, FullTextArticleState>.Empty;
        private string? _registryDigest;

        public void RequireIdentity(FullTextQueryPermissionObservation observation)
        {
            AuthorSearchPermissionIdentity identity = AuthorFullTextSearchContract.EncodePermissionIdentity(observation);
            if (identity.UserId != query.UserId || identity.SiteScope != query.SiteScope
                || identity.PermissionRevision != query.PermissionRevision
                || identity.PermissionPolicyDigest != query.PermissionPolicyDigest
                || observation.RequestId != query.QueryId)
            {
                throw PermissionUnavailable();
            }
        }

        public async Task BindAsync(AuthorSearchIndexReadSnapshot snapshot, CancellationToken cancellationToken)
        {
            await CheckAsync(cancellationToken).ConfigureAwait(false);
            FullTextQueryPermissionObservation? observed = await authority.ObserveFullTextQueryPermissionAsync(
                new(new(query.UserId, query.SiteScope), query.QueryId, [.. snapshot.Articles.Keys]), cancellationToken)
                .ConfigureAwait(false);
            if (observed is null || observed.ActorContext != initial.ActorContext
                || observed.ActorState != initial.ActorState)
            {
                throw PermissionUnavailable();
            }
            RequireIdentity(observed);
            _current = observed;
            _articles = observed.Articles.ToImmutableDictionary(static article => article.ArticleId);
            _registryDigest = snapshot.RegistryDigest;
            await CheckAsync(cancellationToken).ConfigureAwait(false);
        }

        public async Task CheckAsync(CancellationToken cancellationToken)
        {
            if (!await authority.RevalidateFullTextQueryPermissionAsync(_current, cancellationToken).ConfigureAwait(false))
            {
                throw PermissionUnavailable();
            }
            RequireIdentity(_current);
        }

        public bool Allows(AuthorSearchIndexedArticle article)
        {
            if (!_articles.TryGetValue(article.ArticleId, out FullTextArticleState? current))
            {
                return false;
            }
            if (article.Deleted || article.Documents.Any(document =>
                document.Document.Identity.CurrentRevision != current.CurrentRevisionId
                || document.Document.Identity.Status != current.Status
                || document.Document.Identity.VisibilityScope != AuthorSearchVisibilityScope.AuthorOnly))
            {
                throw PermissionUnavailable();
            }
            return true;
        }

        public void RequireIndexCurrent(AuthorFullTextSearchIndex current)
        {
            if (current.IndexInstanceId != query.IndexInstanceId || current.RequireCurrentGeneration() != query.IndexGeneration
                || _registryDigest != AuthorFullTextSearchVerifier.CaptureRegistry().ContentDigest)
            {
                throw new AuthorSearchContractException("author_search_index_source_snapshot_stale");
            }
        }
    }
}
