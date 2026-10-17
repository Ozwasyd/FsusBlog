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
/// A SourceGeneration identifies one stable complete source view across every page; any
/// article, permission, definition or taxonomy change requires a different source generation.
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
    int UserId, string SiteScope, Guid IndexInstanceId, long IndexGeneration, long SourceGeneration,
    string RegistryDigest, ImmutableSortedDictionary<int, AuthorSearchIndexedArticle> Articles);

/// <summary>One derived position in the sole index; source text is never copied into a posting.</summary>
public sealed record AuthorSearchIndexPosting(
    int ArticleId, string DocumentDigest, AuthorSearchFieldKind Field, string? HeadingIdentity,
    int TokenPosition, AuthorSearchSourceRange Source);

/// <summary>
/// Bounded, immutable storage input for the separate query owner. The offset is valid only
/// within this actor/site/index incarnation and publication generation. It is not a query result or authorization receipt.
/// </summary>
public sealed record AuthorSearchIndexPostingPage(
    int UserId, string SiteScope, Guid IndexInstanceId, long IndexGeneration, long SourceGeneration, string RegistryDigest, string Term,
    int NextOffset, bool HasMore, ImmutableArray<AuthorSearchIndexPosting> Postings);

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
    public const int MaxPostingPageSize = 1_000;
    public const int MaxStoredTermCharacters = 32 * 1_024 * 1_024;
    public const int MaxBatchSourceCharacters = 8 * 1_024 * 1_024;
    public const long MaxEstimatedIndexBytes = 256L * 1_024 * 1_024;

    private readonly SemaphoreSlim _gate = new(1, 1);
    private ImmutableSortedDictionary<int, AuthorSearchIndexedArticle> _articles =
        ImmutableSortedDictionary<int, AuthorSearchIndexedArticle>.Empty;
    private ImmutableSortedDictionary<int, AuthorSearchIndexedArticle> _staged =
        ImmutableSortedDictionary<int, AuthorSearchIndexedArticle>.Empty;
    private ImmutableDictionary<string, ImmutableArray<AuthorSearchIndexPosting>> _postings =
        ImmutableDictionary<string, ImmutableArray<AuthorSearchIndexPosting>>.Empty.WithComparers(StringComparer.Ordinal);
    private int _afterArticleId;
    private long? _sourceGeneration;
    private long _indexGeneration;
    private AuthorSearchIndexStatus _status = AuthorSearchIndexStatus.RebuildRequired;

    /// <summary>
    /// Identity of this immutable index incarnation, separate from its local publication
    /// sequence. Every read and cursor must bind both; a restarted writer gets a new ID.
    /// This identity is not a permission or durable-storage admission receipt.
    /// </summary>
    public Guid IndexInstanceId { get; } = Guid.NewGuid();

    public AuthorSearchIndexStatus Status => _status;

    public async Task<AuthorSearchIndexCheckpoint?> RebuildStepAsync(CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            ValidateScope();
            if (_status != AuthorSearchIndexStatus.Rebuilding)
            {
                BeginRebuild();
            }
            AuthorSearchIndexSourcePage page = await source.ReadAsync(userId, siteScope, _afterArticleId,
                BatchSize, _sourceGeneration, cancellationToken).ConfigureAwait(false);
            return StageRebuildPage(page, cancellationToken);
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
            // The first bounded page can also seed a complete refresh when the source
            // generation advances. A single-article read cannot prove that other articles
            // or permission facts stayed unchanged across that transition.
            AuthorSearchIndexSourcePage page = await source.ReadAsync(userId, siteScope, 0,
                BatchSize, null, cancellationToken).ConfigureAwait(false);
            ValidatePage(page, 0, BatchSize);
            if (page.SourceGeneration != _sourceGeneration)
            {
                BeginRebuild();
                AuthorSearchIndexArticleSource? eventArticle = null;
                while (true)
                {
                    eventArticle ??= page.Articles.FirstOrDefault(article => article.ArticleId == articleId);
                    if (!page.HasMore)
                    {
                        ValidateEventArticle(eventArticle, articleId, eventSourceSequence);
                    }
                    if (StageRebuildPage(page, cancellationToken) is null)
                    {
                        return;
                    }
                    page = await source.ReadAsync(userId, siteScope, _afterArticleId,
                        BatchSize, _sourceGeneration, cancellationToken).ConfigureAwait(false);
                }
            }
            AuthorSearchIndexArticleSource? current =
                page.Articles.FirstOrDefault(article => article.ArticleId == articleId);
            if (current is null && page.HasMore)
            {
                page = await source.ReadAsync(userId, siteScope, articleId - 1,
                    1, _sourceGeneration, cancellationToken).ConfigureAwait(false);
                ValidatePage(page, articleId - 1, 1);
                if (page.SourceGeneration != _sourceGeneration)
                {
                    throw new AuthorSearchContractException("author_search_source_generation_or_page_invalid");
                }
                current = page.Articles.FirstOrDefault(article => article.ArticleId == articleId);
            }
            ValidateEventArticle(current, articleId, eventSourceSequence);
            cancellationToken.ThrowIfCancellationRequested();
            long candidateGeneration = checked(_indexGeneration + 1);
            AuthorSearchIndexedArticle projected = Project(current!, candidateGeneration);
            ImmutableSortedDictionary<int, AuthorSearchIndexedArticle> candidate =
                RebindGeneration(_articles, candidateGeneration).SetItem(articleId, projected);
            ValidateBudget(candidate);
            ImmutableDictionary<string, ImmutableArray<AuthorSearchIndexPosting>> postings =
                BuildPostings(candidate, cancellationToken);
            _articles = candidate;
            _postings = postings;
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

    private void BeginRebuild()
    {
        _staged = ImmutableSortedDictionary<int, AuthorSearchIndexedArticle>.Empty;
        _afterArticleId = 0;
        _sourceGeneration = null;
        _status = AuthorSearchIndexStatus.Rebuilding;
    }

    private AuthorSearchIndexCheckpoint? StageRebuildPage(
        AuthorSearchIndexSourcePage page, CancellationToken cancellationToken)
    {
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
        ImmutableDictionary<string, ImmutableArray<AuthorSearchIndexPosting>> postings =
            BuildPostings(_staged, cancellationToken);
        _articles = _staged;
        _postings = postings;
        _staged = ImmutableSortedDictionary<int, AuthorSearchIndexedArticle>.Empty;
        _indexGeneration = candidateGeneration;
        _status = AuthorSearchIndexStatus.Current;
        return null;
    }

    private static void ValidateEventArticle(
        AuthorSearchIndexArticleSource? article, int articleId, long eventSourceSequence)
    {
        if (article is null || article.ArticleId != articleId || article.SourceSequence < eventSourceSequence)
        {
            throw new AuthorSearchContractException("author_search_current_source_unavailable_or_late");
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

    /// <summary>
    /// Reads one complete published view only when actor, site, writer incarnation and
    /// local generation all match. Permission and current-source revalidation remain
    /// mandatory for the separate query executor.
    /// </summary>
    public async Task<AuthorSearchIndexReadSnapshot> ReadSnapshotAsync(
        int queryUserId, string querySiteScope, Guid expectedIndexInstanceId, long expectedIndexGeneration,
        CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            long generation = RequireCurrentGeneration();
            if (queryUserId != userId || querySiteScope != siteScope
                || expectedIndexInstanceId != IndexInstanceId || expectedIndexGeneration != generation)
            {
                throw new AuthorSearchContractException("author_search_index_read_scope_or_generation_stale");
            }
            return new(userId, siteScope, IndexInstanceId, generation, _sourceGeneration!.Value,
                AuthorFullTextSearchVerifier.CaptureRegistry().ContentDigest, _articles);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// Reads only the writer-maintained inverted storage representation. The caller supplies
    /// one term normalized by the sole tokenizer; grammar, phrase/ranking, current source and
    /// permission revalidation, snippets and client delivery remain with the query owner.
    /// No source corpus scan or source-provider call occurs while opening or paging a lookup.
    /// </summary>
    public async Task<AuthorSearchIndexPostingPage> ReadPostingsAsync(
        int queryUserId, string querySiteScope, Guid expectedIndexInstanceId, long expectedIndexGeneration, string normalizedTerm,
        int offset, int pageSize, CancellationToken cancellationToken = default)
    {
        if (offset is < 0 or > MaxStoredTokens || pageSize is <= 0 or > MaxPostingPageSize)
        {
            throw new AuthorSearchContractException("author_search_posting_page_budget_invalid");
        }
        ImmutableArray<string> terms = AuthorFullTextSearchTokenizer.TokenizeQueryValue(normalizedTerm);
        if (terms.Length != 1 || terms[0] != normalizedTerm)
        {
            throw new AuthorSearchContractException("author_search_posting_term_not_normalized");
        }
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            long generation = RequireCurrentGeneration();
            if (queryUserId != userId || querySiteScope != siteScope
                || expectedIndexInstanceId != IndexInstanceId || expectedIndexGeneration != generation)
            {
                throw new AuthorSearchContractException("author_search_index_read_scope_or_generation_stale");
            }
            ImmutableArray<AuthorSearchIndexPosting> all = _postings.TryGetValue(normalizedTerm, out var stored)
                ? stored : [];
            if (offset > all.Length)
            {
                throw new AuthorSearchContractException("author_search_posting_offset_invalid");
            }
            int count = Math.Min(pageSize, all.Length - offset);
            var page = ImmutableArray.CreateBuilder<AuthorSearchIndexPosting>(count);
            for (int index = offset; index < offset + count; index++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                page.Add(all[index]);
            }
            cancellationToken.ThrowIfCancellationRequested();
            return new(userId, siteScope, IndexInstanceId, generation, _sourceGeneration!.Value,
                AuthorFullTextSearchVerifier.CaptureRegistry().ContentDigest, normalizedTerm, offset + count, offset + count < all.Length, page.MoveToImmutable());
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
        var reusable = new Dictionary<string, AuthorSearchTokenizedDocument>(StringComparer.Ordinal);
        if (_articles.TryGetValue(article.ArticleId, out AuthorSearchIndexedArticle? previous))
        {
            foreach (AuthorSearchTokenizedDocument cached in previous.Documents)
            {
                AuthorSearchTokenizedDocument rebound = RebindDocument(cached, generation);
                reusable.Add(rebound.Document.ContentDigest, rebound);
            }
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
            if (reusable.TryGetValue(document.ContentDigest, out AuthorSearchTokenizedDocument? cached))
            {
                // Reuse immutable tokens only after validating the newly supplied raw,
                // permission, definition and range facts through the original authority.
                AuthorFullTextSearchContract.ValidateDocument(document, field.RawSource,
                    article.Definitions, field.ParserVersion, field.DocumentEpoch);
                documents.Add(cached);
            }
            else
            {
                documents.Add(AuthorFullTextSearchVerifier.CreateTokenDocument(document, field.RawSource,
                    article.Definitions, field.ParserVersion, field.DocumentEpoch));
            }
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
                [.. article.Documents.Select(document => RebindDocument(document, generation))];
            rebound[article.ArticleId] = article with
            {
                Documents = documents
            };
        }
        return rebound.ToImmutable();
    }

    private static AuthorSearchTokenizedDocument RebindDocument(AuthorSearchTokenizedDocument document, long generation)
        => AuthorFullTextSearchVerifier.SealTokenDocument(document with
        {
            Document = AuthorFullTextSearchContract.SealDocument(document.Document with
            {
                Identity = document.Document.Identity with
                {
                    IndexGeneration = generation
                }
            })
        });

    private static ImmutableDictionary<string, ImmutableArray<AuthorSearchIndexPosting>> BuildPostings(
        ImmutableSortedDictionary<int, AuthorSearchIndexedArticle> articles, CancellationToken cancellationToken)
    {
        var terms = new Dictionary<string, ImmutableArray<AuthorSearchIndexPosting>.Builder>(StringComparer.Ordinal);
        foreach (AuthorSearchIndexedArticle article in articles.Values)
        {
            foreach (AuthorSearchTokenizedDocument document in article.Documents)
            {
                foreach (AuthorSearchToken token in document.Tokens)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (!terms.TryGetValue(token.Term, out var postings))
                    {
                        postings = ImmutableArray.CreateBuilder<AuthorSearchIndexPosting>();
                        terms.Add(token.Term, postings);
                    }
                    postings.Add(new(article.ArticleId, document.Document.ContentDigest, document.Document.Field.Kind,
                        document.Document.Field.HeadingIdentity, token.Position, token.Source));
                }
            }
        }
        cancellationToken.ThrowIfCancellationRequested();
        return terms.ToImmutableDictionary(static pair => pair.Key,
            static pair => pair.Value.ToImmutable(), StringComparer.Ordinal);
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
            || articles.Count * 128L + documents * 1_024L + tokens * 320L + characters * 2L > MaxEstimatedIndexBytes)
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
