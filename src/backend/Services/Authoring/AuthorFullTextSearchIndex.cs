using System.Collections.Immutable;
using System.Globalization;
using System.Text;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>Source fields are supplied only by the original canonical source/property adapter.</summary>
public sealed record AuthorSearchIndexFieldSource(
    AuthorSearchDocument Document, string RawSource, string ParserVersion, string DocumentEpoch);

/// <summary>
/// A batch projection of current facts, not a new article/value/parse snapshot authority.
/// SourceSequence orders original lifecycle observations; deletion is an explicit tombstone.
/// The adapter must provide the complete eligible field set and real typed-value projections.
/// </summary>
public sealed record AuthorSearchIndexArticleSource(
    int ArticleId, long SourceSequence, bool Deleted,
    ImmutableArray<AuthorSearchIndexFieldSource> Fields,
    IReadOnlyDictionary<Guid, ArticlePropertyDefinition> Definitions);

public sealed record AuthorSearchIndexSourcePage(
    long SourceGeneration, ImmutableArray<AuthorSearchIndexArticleSource> Articles, bool HasMore);

/// <summary>
/// Read-only consumption port for the original canonical current article/parse/typed-value
/// authorities. An adapter is required before production use; this port grants no source,
/// permission, parser or value admission and has no frontend/public-search provider.
/// </summary>
public interface IAuthorFullTextSearchIndexSource
{
    Task<AuthorSearchIndexSourcePage> ReadAsync(
        int userId, string siteScope, int afterArticleId, int pageSize,
        long? expectedSourceGeneration, CancellationToken cancellationToken);
}

public enum AuthorSearchIndexLifecycleEvent
{
    Create = 1,
    Edit = 2,
    Publish = 3,
    Schedule = 4,
    Archive = 5,
    Delete = 6,
    Restore = 7,
    Rollback = 8,
    Import = 9,
    Migration = 10,
    PermissionChange = 11,
    LocaleChange = 12,
    TaxonomyChange = 13,
    PropertyChange = 14
}

public enum AuthorSearchIndexStatus
{
    RebuildRequired = 1,
    Rebuilding = 2,
    Current = 3
}

public sealed record AuthorSearchIndexedArticle(
    int ArticleId, long SourceSequence, bool Deleted, ImmutableArray<AuthorSearchTokenizedDocument> Documents);

/// <summary>
/// Immutable author-private input for the separate query owner. It contains indexed
/// terms/ranges, never the raw field corpus. The query owner must revalidate current
/// permission/source facts and use the original source reader for snippet context.
/// </summary>
public sealed record AuthorSearchIndexReadSnapshot(
    int UserId, string SiteScope, long IndexGeneration, long SourceGeneration,
    string RegistryDigest, ImmutableSortedDictionary<int, AuthorSearchIndexedArticle> Articles);

/// <summary>
/// In-memory algorithm checkpoint. It is not durable storage, a trusted receipt, or native
/// crash qualification. Resume rederives all source facts rather than admitting serialized
/// staged terms as authority. A durable transaction/checkpoint adapter remains required.
/// </summary>
public sealed record AuthorSearchIndexCheckpoint(long SourceGeneration, int AfterArticleId, int ArticleCount);

/// <summary>
/// One bounded author-private index writer/rebuild algorithm. It always tokenizes through
/// the existing registry, replaces complete article document sets atomically, and rereads
/// current facts for incremental events. It has no query/snippet executor or registration.
/// </summary>
public sealed class AuthorFullTextSearchIndex(
    IAuthorFullTextSearchIndexSource source, int userId, string siteScope) : IDisposable
{
    public const int BatchSize = 100;
    public const int MaxArticles = 10_000;
    public const int MaxDocuments = 100_000;
    public const int MaxStoredTokens = 1_000_000;
    public const int MaxStoredTermCharacters = 32 * 1_024 * 1_024;
    public const int MaxBatchSourceCharacters = 8 * 1_024 * 1_024;
    public const long MaxEstimatedIndexBytes = 256L * 1_024 * 1_024;

    private readonly SemaphoreSlim _gate = new(1, 1);
    private ImmutableSortedDictionary<int, AuthorSearchIndexedArticle> _articles =
        ImmutableSortedDictionary<int, AuthorSearchIndexedArticle>.Empty;
    private ImmutableSortedDictionary<int, AuthorSearchIndexedArticle> _staged =
        ImmutableSortedDictionary<int, AuthorSearchIndexedArticle>.Empty;
    private int _afterArticleId;
    private long? _sourceGeneration;
    private long _indexGeneration;
    private AuthorSearchIndexStatus _status = AuthorSearchIndexStatus.RebuildRequired;

    public AuthorSearchIndexStatus Status => _status;

    public async Task<AuthorSearchIndexCheckpoint?> RebuildStepAsync(CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            ValidateScope();
            if (_status != AuthorSearchIndexStatus.Rebuilding)
            {
                _staged = ImmutableSortedDictionary<int, AuthorSearchIndexedArticle>.Empty;
                _afterArticleId = 0;
                _sourceGeneration = null;
                _status = AuthorSearchIndexStatus.Rebuilding;
            }
            AuthorSearchIndexSourcePage page = await source.ReadAsync(userId, siteScope, _afterArticleId,
                BatchSize, _sourceGeneration, cancellationToken).ConfigureAwait(false);
            ValidatePage(page, _afterArticleId, BatchSize);
            cancellationToken.ThrowIfCancellationRequested();
            long candidateGeneration = checked(_indexGeneration + 1);
            ImmutableSortedDictionary<int, AuthorSearchIndexedArticle> candidate = _staged;
            foreach (AuthorSearchIndexArticleSource article in page.Articles)
            {
                cancellationToken.ThrowIfCancellationRequested();
                candidate = candidate.Add(article.ArticleId, Project(article, candidateGeneration));
            }
            ValidateBudget(candidate);
            _staged = candidate;
            _sourceGeneration = page.SourceGeneration;
            if (!page.Articles.IsEmpty)
            {
                _afterArticleId = page.Articles[^1].ArticleId;
            }
            if (page.HasMore)
            {
                return new(page.SourceGeneration, _afterArticleId, _staged.Count);
            }
            _articles = _staged;
            _staged = ImmutableSortedDictionary<int, AuthorSearchIndexedArticle>.Empty;
            _indexGeneration = candidateGeneration;
            _status = AuthorSearchIndexStatus.Current;
            return null;
        }
        catch
        {
            _status = AuthorSearchIndexStatus.RebuildRequired;
            throw;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// Resumes after a lost algorithm instance by replaying the original bounded source
    /// generation from the beginning. No checkpoint body or existing index is trusted.
    /// </summary>
    public async Task ResumeRebuildAsync(AuthorSearchIndexCheckpoint checkpoint, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(checkpoint);
        if (checkpoint.SourceGeneration <= 0 || checkpoint.AfterArticleId < 0
            || checkpoint.ArticleCount is < 0 or > MaxArticles)
        {
            throw new AuthorSearchContractException("author_search_checkpoint_invalid");
        }
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            _staged = ImmutableSortedDictionary<int, AuthorSearchIndexedArticle>.Empty;
            _afterArticleId = 0;
            _sourceGeneration = checkpoint.SourceGeneration;
            _status = AuthorSearchIndexStatus.Rebuilding;
        }
        finally
        {
            _gate.Release();
        }
        while (await RebuildStepAsync(cancellationToken).ConfigureAwait(false) is not null)
        {
        }
    }

    public async Task ApplyAsync(
        int articleId, long eventSourceSequence, AuthorSearchIndexLifecycleEvent lifecycleEvent,
        CancellationToken cancellationToken = default)
    {
        if (articleId <= 0 || eventSourceSequence <= 0 || !Enum.IsDefined(lifecycleEvent))
        {
            throw new AuthorSearchContractException("author_search_lifecycle_event_invalid");
        }
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            ValidateScope();
            RequireCurrentGeneration();
            if (_articles.TryGetValue(articleId, out AuthorSearchIndexedArticle? existing)
                && existing.SourceSequence >= eventSourceSequence)
            {
                return;
            }
            AuthorSearchIndexSourcePage page = await source.ReadAsync(userId, siteScope, articleId - 1,
                1, null, cancellationToken).ConfigureAwait(false);
            ValidatePage(page, articleId - 1, 1);
            if (page.Articles.Length != 1 || page.Articles[0].ArticleId != articleId
                || page.Articles[0].SourceSequence < eventSourceSequence)
            {
                throw new AuthorSearchContractException("author_search_current_source_unavailable_or_late");
            }
            cancellationToken.ThrowIfCancellationRequested();
            long candidateGeneration = checked(_indexGeneration + 1);
            AuthorSearchIndexedArticle projected = Project(page.Articles[0], candidateGeneration);
            ImmutableSortedDictionary<int, AuthorSearchIndexedArticle> candidate =
                RebindGeneration(_articles, candidateGeneration).SetItem(articleId, projected);
            ValidateBudget(candidate);
            _articles = candidate;
            _indexGeneration = candidateGeneration;
            _sourceGeneration = page.SourceGeneration;
        }
        catch
        {
            _status = AuthorSearchIndexStatus.RebuildRequired;
            throw;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Returns generation facts only. Permission-safe query execution remains unimplemented.</summary>
    public long RequireCurrentGeneration()
    {
        if (_status != AuthorSearchIndexStatus.Current)
        {
            throw new AuthorSearchContractException("author_search_index_rebuild_required");
        }
        return _indexGeneration;
    }

    public async Task<AuthorSearchIndexReadSnapshot> ReadSnapshotAsync(
        int queryUserId, string querySiteScope, long expectedIndexGeneration,
        CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            long generation = RequireCurrentGeneration();
            if (queryUserId != userId || querySiteScope != siteScope || expectedIndexGeneration != generation)
            {
                throw new AuthorSearchContractException("author_search_index_read_scope_or_generation_stale");
            }
            return new(userId, siteScope, generation, _sourceGeneration!.Value,
                AuthorFullTextSearchVerifier.CaptureRegistry().ContentDigest, _articles);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Derives generation-independent parity evidence without logging or returning source text.</summary>
    public string SemanticDigest()
    {
        RequireCurrentGeneration();
        var builder = new StringBuilder();
        foreach (AuthorSearchIndexedArticle article in _articles.Values)
        {
            builder.Append(article.ArticleId.ToString(CultureInfo.InvariantCulture)).Append(':')
                .Append(article.SourceSequence.ToString(CultureInfo.InvariantCulture)).Append(':')
                .Append(article.Deleted ? '1' : '0').Append('\n');
            foreach (AuthorSearchTokenizedDocument document in article.Documents)
            {
                AuthorSearchDocument normalized = AuthorFullTextSearchContract.SealDocument(document.Document with
                {
                    Identity = document.Document.Identity with
                    {
                        IndexGeneration = 1
                    }
                });
                builder.Append(AuthorFullTextSearchVerifier.SealTokenDocument(document with
                {
                    Document = normalized
                }).ContentDigest).Append('\n');
            }
        }
        return AuthorFullTextSearchContract.Digest(builder.ToString());
    }

    private AuthorSearchIndexedArticle Project(AuthorSearchIndexArticleSource article, long generation)
    {
        if (article.ArticleId <= 0 || article.SourceSequence <= 0 || article.Fields.IsDefault
            || article.Fields.Length > 1_000 || article.Definitions is null
            || article.Deleted != article.Fields.IsEmpty)
        {
            throw new AuthorSearchContractException("author_search_article_source_invalid");
        }
        var documents = ImmutableArray.CreateBuilder<AuthorSearchTokenizedDocument>();
        foreach (AuthorSearchIndexFieldSource field in article.Fields)
        {
            if (field.Document.Identity.ArticleId != article.ArticleId
                || field.Document.Identity.UserId != userId || field.Document.Identity.SiteScope != siteScope)
            {
                throw new AuthorSearchContractException("author_search_article_source_scope_mismatch");
            }
            AuthorSearchDocument document = AuthorFullTextSearchContract.SealDocument(field.Document with
            {
                Identity = field.Document.Identity with
                {
                    IndexGeneration = generation
                }
            });
            documents.Add(AuthorFullTextSearchVerifier.CreateTokenDocument(document, field.RawSource,
                article.Definitions, field.ParserVersion, field.DocumentEpoch));
        }
        ImmutableArray<AuthorSearchTokenizedDocument> ordered =
            [.. documents.OrderBy(static document => document.Document.Field.Kind)
                .ThenBy(static document => document.Document.Source.Utf16Start)
                .ThenBy(static document => document.Document.ContentDigest, StringComparer.Ordinal)];
        if (ordered.Select(static document => document.Document.ContentDigest).Distinct().Count() != ordered.Length
            || ordered.Select(static document => document.Document.Identity.CurrentRevision).Distinct().Count() > 1)
        {
            throw new AuthorSearchContractException("author_search_article_document_set_invalid");
        }
        return new(article.ArticleId, article.SourceSequence, article.Deleted, ordered);
    }

    /// <summary>
    /// Every published replacement invalidates prior query/cursor generations, including
    /// untouched article documents. This reseals only existing immutable index facts; it
    /// does not reread or parse the source corpus. Counts remain within the index budgets.
    /// </summary>
    private static ImmutableSortedDictionary<int, AuthorSearchIndexedArticle> RebindGeneration(
        ImmutableSortedDictionary<int, AuthorSearchIndexedArticle> articles, long generation)
    {
        var rebound = articles.ToBuilder();
        foreach (AuthorSearchIndexedArticle article in articles.Values)
        {
            ImmutableArray<AuthorSearchTokenizedDocument> documents =
                [.. article.Documents.Select(document => AuthorFullTextSearchVerifier.SealTokenDocument(document with
                {
                    Document = AuthorFullTextSearchContract.SealDocument(document.Document with
                    {
                        Identity = document.Document.Identity with
                        {
                            IndexGeneration = generation
                        }
                    })
                }))];
            rebound[article.ArticleId] = article with
            {
                Documents = documents
            };
        }
        return rebound.ToImmutable();
    }

    private void ValidatePage(AuthorSearchIndexSourcePage page, int afterArticleId, int pageSize)
    {
        if (page.SourceGeneration <= 0 || page.Articles.IsDefault || page.Articles.Length > pageSize
            || page.HasMore && page.Articles.IsEmpty
            || _status == AuthorSearchIndexStatus.Rebuilding && _sourceGeneration.HasValue
                && _sourceGeneration != page.SourceGeneration)
        {
            throw new AuthorSearchContractException("author_search_source_generation_or_page_invalid");
        }
        long sourceCharacters = 0;
        foreach (AuthorSearchIndexArticleSource article in page.Articles)
        {
            if (article.ArticleId <= afterArticleId || article.Fields.IsDefault || article.Fields.Length > 1_000)
            {
                throw new AuthorSearchContractException("author_search_source_page_order_invalid");
            }
            foreach (AuthorSearchIndexFieldSource field in article.Fields)
            {
                sourceCharacters += field.RawSource.Length;
            }
            afterArticleId = article.ArticleId;
        }
        if (sourceCharacters > MaxBatchSourceCharacters)
        {
            throw new AuthorSearchContractException("author_search_source_batch_budget_exceeded");
        }
    }

    private static void ValidateBudget(ImmutableSortedDictionary<int, AuthorSearchIndexedArticle> articles)
    {
        long documents = 0;
        long tokens = 0;
        long characters = 0;
        foreach (AuthorSearchIndexedArticle article in articles.Values)
        {
            documents += article.Documents.Length;
            foreach (AuthorSearchTokenizedDocument document in article.Documents)
            {
                tokens += document.Tokens.Length;
                foreach (AuthorSearchToken token in document.Tokens)
                {
                    characters += token.Term.Length;
                }
            }
        }
        if (articles.Count > MaxArticles || documents > MaxDocuments
            || tokens > MaxStoredTokens || characters > MaxStoredTermCharacters
            || articles.Count * 128L + documents * 1_024L + tokens * 192L + characters * 2L > MaxEstimatedIndexBytes)
        {
            throw new AuthorSearchContractException("author_search_index_budget_exceeded");
        }
    }

    private void ValidateScope()
    {
        if (userId <= 0 || string.IsNullOrWhiteSpace(siteScope) || siteScope.Length > 128)
        {
            throw new AuthorSearchContractException("author_search_index_scope_invalid");
        }
    }

    public void Dispose()
        => _gate.Dispose();
}
