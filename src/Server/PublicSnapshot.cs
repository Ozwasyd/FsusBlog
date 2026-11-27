using Microsoft.Net.Http.Headers;

namespace FsusBlog.V2.Server;

internal sealed class PublicSnapshot
{
    private static readonly byte[] SearchProfileDomain =
        Encoding.ASCII.GetBytes(FormattableString.Invariant($"public-search-bm25-v{WireLimits.SearchFas4Profile}\0"));
    private static readonly byte[] SearchAnalyzerDomain =
        Encoding.ASCII.GetBytes(FormattableString.Invariant($"public-search-analyzer-v{WireLimits.SearchAnalyzerVersion}\0"));
    private readonly byte[][] _index;
    private readonly LocalSearchCorpusSnapshot? _corpus;
    private readonly EntityTagHeaderValue[] _corpusTags;
    private readonly CorpusDelta? _corpusDelta;
    private readonly FrozenDictionary<int, Article> _byId;
    private readonly PublicArticleCache _details;
    private readonly PublicListProjection _listing;
    private readonly ArticleSearchIndex? _search;
    private readonly PublicSearchCursor _searchCursor;
    private readonly PublishedMediaProjection? _media;
    internal long Generation { get; }
    internal string GenerationHeader { get; }
    internal long Watermark { get; }
    internal long TaxonomyEpoch { get; }
    internal long SiteConfigRevision { get; }
    internal int SitePagesMask { get; }
    internal byte[] Home { get; }
    internal byte[] EnglishHome { get; }
    internal TaxonomyProjection Taxonomy { get; }
    internal RelatedReadingProjection RelatedReading { get; }
    internal DistributionSnapshot? Distribution { get; }
    internal int IndexPageCount => _index.Length;
    internal int CorpusPageCount => _corpus?.Pages.Count ?? 0;
    internal int ReusedCorpusPageCount => _corpus?.ReusedPageCount ?? 0;
    internal int PublicArticleCount => _byId.Count;
    internal IReadOnlyList<Article> WideSearchArticles => _byId.Values;
    internal bool HasSearchIndex => _search is not null;
    internal int SearchProfileVersion => _search?.ProfileVersion ?? SearchScoringProfile.ProfileVersion;
    internal int SearchAnalyzerVersion => _search?.AnalyzerVersion ?? SearchTextAnalyzer.Version;
    internal bool SearchUsesWideProfile => _search?.UsesWideProfile is true;
    internal int SearchSegmentCount => _search?.SegmentCount ?? 0;
    internal int SearchDeadDocumentSlots => _search?.DeadDocumentSlots ?? 0;
    internal SearchIndexBuildStats SearchBuildStats { get; }
    internal long SearchCursorNowUtcSeconds => _searchCursor.Now;

    internal PublicSnapshot(long watermark, IReadOnlyList<Article> articles, TaxonomyRows taxonomy, WebPages pages, PublicListCursor cursor,
        PublicSnapshot? previous, ILogger log, RuntimeEvidence? evidence, DistributionSettings? distribution, CancellationToken cancellationToken,
        long taxonomyEpoch = 0, PublishedMediaProjection? media = null, long siteConfigRevision = 0, int sitePagesMask = 0,
        PublicSearchCursor? searchCursor = null, bool buildLocalCorpus = true)
    {
        Watermark = watermark;
        TaxonomyEpoch = taxonomyEpoch;
        SiteConfigRevision = siteConfigRevision;
        SitePagesMask = sitePagesMask;
        _searchCursor = searchCursor ?? new PublicSearchCursor(TimeProvider.System);
        _corpus = buildLocalCorpus ? LocalSearchCorpus.BuildSnapshot(articles, previous?._corpus, cancellationToken) : null;
        _corpusTags = _corpus is null ? [] : CorpusTags(_corpus, previous, cancellationToken);
        _search = ArticleSearchIndex.BuildIncremental(articles, previous?._search, cancellationToken, out var searchBuildStats);
        SearchBuildStats = searchBuildStats;
        Generation = PublicGeneration(articles, taxonomyEpoch, _corpus?.Pages, buildLocalCorpus, _search?.UsesWideProfile is true, cancellationToken);
        GenerationHeader = Generation.ToString(CultureInfo.InvariantCulture);
        Taxonomy = new TaxonomyProjection(taxonomy, articles, pages);
        RelatedReading = new RelatedReadingProjection(articles, cancellationToken);
        _byId = articles.ToFrozenDictionary(article => article.Id);
        _corpusDelta = buildLocalCorpus ? BuildCorpusDelta(previous, cancellationToken) : null;
        _media = media;
        _details = new PublicArticleCache(_byId, pages, Generation, log, evidence, media, siteConfigRevision);
        _details.Warm(articles.Take(1200), previous?._details, cancellationToken);
        _listing = new PublicListProjection(Generation, articles, cursor);
        var first = articles.Take(10).ToArray();
        Home = pages.PublicPage(HomeContent(first, SiteLocale.Default), publicPath: "/");
        EnglishHome = pages.PublicPage(HomeContent(first, "en"), publicPath: "/", locale: "en");
        _index = articles.Count == 0 ? [PublicArticles.EncodeSearch([], 0)] : articles.Chunk(WireLimits.SearchIndexPageSize)
            .Select(part => PublicArticles.EncodeSearch(part, part.Length)).ToArray();
        Distribution = DistributionSnapshot.Build(distribution, articles, cancellationToken);
    }

    private static string HomeContent(IReadOnlyList<Article> articles, string locale)
    {
        var html = new StringBuilder($"<section class=\"reading-column editorial-page\"><h1 class=\"visually-hidden\">{SiteLocale.Html(locale, "reading.latestPosts")}</h1>");
        if (articles.Count == 0)
            html.Append($"<p class=\"muted\">{SiteLocale.Html(locale, "page.emptyArticles")}</p>");
        else
        {
            html.Append("<ol class=\"article-list\">");
            foreach (var article in articles)
            {
                html.Append($"<li><article><h2><a href=\"/article/{article.Id.ToString(CultureInfo.InvariantCulture)}\">{HtmlEncoder.Default.Encode(article.Title)}</a></h2><div class=\"article-taxonomy metadata\">");
                if (article.PublishedAt.ToUnixTimeMilliseconds() != 0)
                {
                    var date = article.PublishedAt.UtcDateTime.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
                    html.Append($"<time datetime=\"{date}\">{date}</time>");
                }
                if (article.Category is { Id: > 0 } category)
                    html.Append($"<a href=\"/category/{category.Id.ToString(CultureInfo.InvariantCulture)}\">{HtmlEncoder.Default.Encode(category.Name)}</a>");
                foreach (var tag in article.Tags ?? [])
                    html.Append($"<a href=\"/tag/{tag.Id.ToString(CultureInfo.InvariantCulture)}\">#{HtmlEncoder.Default.Encode(tag.Name)}</a>");
                html.Append("</div>");
                if (!string.IsNullOrEmpty(article.Summary))
                    html.Append($"<p>{HtmlEncoder.Default.Encode(article.Summary)}</p>");
                html.Append("</article></li>");
            }
            html.Append("</ol>");
        }
        return html.Append("</section>").ToString();
    }

    internal Article? Article(int id) => _byId.GetValueOrDefault(id);

    internal bool HasArticle(int id) => _byId.ContainsKey(id);

    internal bool HasPublishedImages(int id) => _media?.HasImages(id) is true;

    internal IReadOnlyList<PublishedArticleImage>? PublishedImages(int id, long publication) =>
        _byId.TryGetValue(id, out var article) && article.Publication == publication
            ? _media?.Images(id, publication) ?? [] : null;

    internal ValueTask<PublicArticleBytes?> Detail(int id, CancellationToken ct) => _details.Read(id, ct);

    internal byte[]? Index(int page) => page > 0 && page <= _index.Length ? _index[page - 1] : null;

    internal byte[]? Corpus(int page) => _corpus is not null && page > 0 && page <= _corpus.Pages.Count ? _corpus.Pages[page - 1] : null;

    internal EntityTagHeaderValue CorpusTag(int page) => _corpusTags[page - 1];

    internal byte[]? CorpusPatch(int page, string baseGeneration, string? baseTag) =>
        _corpusDelta is { } delta && delta.Page == page && delta.BaseGeneration == baseGeneration &&
        delta.BaseTag == baseTag ? delta.Bytes : null;

    internal byte[] List(string scope, int page, int size, string? keyword, string? sort, string? cursor,
        CancellationToken ct, Func<Article, bool>? filter = null) =>
        _listing.Read(PublicListQuery.Parse(scope, page, size, keyword, sort, cursor), ct, filter);

    internal byte[]? Search(string keyword, CancellationToken ct) =>
        SearchPage(keyword, ArticleSearchSort.Relevance, 1, 200, ct)?.Bytes;

    internal (byte[] Bytes, int Total)? SearchPage(string keyword, ArticleSearchSort sort, int page, int size,
        CancellationToken ct)
    {
        if (_search is null) return null;
        return SearchPageWithPlan(SearchQueryPlan.Build(keyword, ct), sort, page, size, ct);
    }

    internal (byte[] Bytes, int Total)? SearchPageWithPlan(SearchQueryPlan plan, ArticleSearchSort sort, int page, int size,
        CancellationToken ct)
    {
        if (_search is null) return null;
        var matching = _search.SearchPage(plan, sort, page, size, ct);
        return (PublicArticles.EncodeSearch(matching.Articles, matching.Articles.Length), matching.Total);
    }

    internal DecodedSearchCursor DecodeSearchCursor(SearchQueryPlan plan, ArticleSearchSort sort, int size, string cursor) =>
        _searchCursor.Decode(Generation, plan, sort, size, cursor);

    internal byte[] SearchV2(string keyword, ArticleSearchSort sort, int size, string? cursor, CancellationToken ct,
        int? countThreshold = null, int? workBudget = null)
    {
        if (_search is null) throw PublicSearchFailure.Unavailable();
        var plan = SearchQueryPlan.Build(keyword, ct);
        DecodedSearchCursor? decoded = cursor is null
            ? null
            : DecodeSearchCursor(plan, sort, size, cursor);
        return SearchV2WithPlan(plan, sort, size, decoded, ct, out _, countThreshold, workBudget);
    }

    internal byte[] SearchV2WithPlan(SearchQueryPlan plan, ArticleSearchSort sort, int size, DecodedSearchCursor? decoded,
        CancellationToken ct, out bool hasMore, int? countThreshold = null, int? workBudget = null)
    {
        if (_search is null) throw PublicSearchFailure.Unavailable();

        ArticleSearchCursorPage page;
        try
        {
            page = _search.SearchWithCursor(plan, sort, size, decoded?.Position, decoded?.ReturnedSoFar ?? 0, ct,
                countThreshold, workBudget);
        }
        catch (SearchBudgetExceededException)
        {
            throw PublicSearchFailure.BudgetExceeded();
        }

        var items = new PublicSearchHit[page.Hits.Length];
        for (var i = 0; i < page.Hits.Length; i++)
        {
            ct.ThrowIfCancellationRequested();
            var hit = page.Hits[i];
            var article = hit.Article;
            var snippet = SearchSnippetExtractor.Extract(article, plan, ct);
            var tags = article.Tags is { Count: > 0 } articleTags
                ? articleTags.Select(static t => new PublicSearchTag(t.Id, t.Name)).ToArray()
                : Array.Empty<PublicSearchTag>();
            items[i] = new PublicSearchHit(
                article.Id,
                article.Revision,
                article.RevisionNo,
                article.Publication,
                article.PublicationNo,
                article.PublishedAt.ToUnixTimeMilliseconds(),
                article.CreatedAt.ToUnixTimeMilliseconds(),
                0,
                article.Category?.Id ?? 0,
                article.Category?.Name ?? "",
                tags,
                article.Title,
                article.Summary ?? "",
                hit.Tier == SearchMatchTier.Relaxed ? PublicSearchMatchTier.Relaxed : PublicSearchMatchTier.Primary,
                snippet.Field,
                snippet.Text,
                snippet.Highlights);
        }

        hasMore = page.HasMore && page.LastHitPosition is not null;
        var nextCursor = hasMore && page.LastHitPosition is { } last
            ? _searchCursor.Encode(Generation, plan, sort, size, (decoded?.ReturnedSoFar ?? 0) + page.Hits.Length, last)
            : "";

        return Wire.EncodePublicSearchResult(new PublicSearchResult(
            Generation,
            _search.ProfileVersion,
            _search.AnalyzerVersion,
            page.TotalCount,
            page.TotalRelation,
            page.PrimaryCount,
            page.RelaxedCount,
            page.HasMore,
            nextCursor,
            items));
    }

    private static EntityTagHeaderValue[] CorpusTags(LocalSearchCorpusSnapshot corpus, PublicSnapshot? previous, CancellationToken ct)
    {
        var pages = corpus.Pages;
        var priorPages = previous?._corpus?.Pages;
        var tags = new EntityTagHeaderValue[pages.Count];
        for (var index = 0; index < tags.Length; index++)
        {
            ct.ThrowIfCancellationRequested();
            var reusedFrom = corpus.ReusedFromPageIndex(index);
            if (reusedFrom >= 0 && previous is not null && priorPages is not null &&
                reusedFrom < priorPages.Count && reusedFrom < previous._corpusTags.Length &&
                ReferenceEquals(pages[index], priorPages[reusedFrom]))
            {
                tags[index] = previous._corpusTags[reusedFrom];
                continue;
            }
            tags[index] = new($"\"{Convert.ToHexStringLower(SHA256.HashData(pages[index]))}\"");
        }
        return tags;
    }

    private CorpusDelta? BuildCorpusDelta(PublicSnapshot? previous, CancellationToken ct)
    {
        if (previous?._corpus?.Pages is not { } basis || _corpus?.Pages is not { } target || previous.Generation == Generation ||
            previous.PublicArticleCount != PublicArticleCount || basis.Count != target.Count || target.Count < 2 ||
            !previous._corpusTags[0].Equals(_corpusTags[0])) return null;

        var changed = -1;
        for (var index = 1; index < target.Count; index++)
        {
            ct.ThrowIfCancellationRequested();
            if (previous._corpusTags[index].Equals(_corpusTags[index])) continue;
            if (changed >= 0) return null;
            changed = index;
        }
        if (changed < 0) return null;

        var baseTag = previous._corpusTags[changed].Tag.ToString();
        var targetTag = _corpusTags[changed].Tag.ToString();
        var bytes = SearchCorpusPatch.TryCreate(previous.Generation, Generation, changed + 1, basis[changed], target[changed],
            Convert.FromHexString(baseTag[1..^1]), Convert.FromHexString(targetTag[1..^1]), ct);
        return bytes is null ? null : new CorpusDelta(changed + 1, previous.GenerationHeader, baseTag, bytes);
    }

    private sealed record CorpusDelta(int Page, string BaseGeneration, string BaseTag, byte[] Bytes);

    private static long PublicGeneration(IReadOnlyList<Article> articles, long taxonomyEpoch,
        IReadOnlyList<byte[]>? corpus, bool buildLocalCorpus, bool wideSearch, CancellationToken ct)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        Span<byte> coordinates = stackalloc byte[20];
        if (buildLocalCorpus)
        {
            // One coordinate covers every HTTP representation. A restart with unchanged
            // article rows still cannot serve changed corpus bytes at the old coordinate.
            hash.AppendData("public-generation-corpus-v1\0"u8);
            hash.AppendData(SearchProfileDomain);
            hash.AppendData(SearchAnalyzerDomain);
            if (wideSearch) hash.AppendData("public-search-bm25-wide-v1\0"u8);
            AppendNumber(corpus?.Count ?? -1);
            if (corpus is not null)
            {
                foreach (var page in corpus)
                {
                    ct.ThrowIfCancellationRequested();
                    AppendNumber(page.Length);
                    hash.AppendData(page);
                }
            }
            AppendNumber(articles.Count);
            foreach (var article in articles)
            {
                ct.ThrowIfCancellationRequested();
                BinaryPrimitives.WriteInt32LittleEndian(coordinates, article.Id);
                BinaryPrimitives.WriteInt64LittleEndian(coordinates[4..], article.Revision);
                BinaryPrimitives.WriteInt64LittleEndian(coordinates[12..], article.Publication);
                hash.AppendData(coordinates);
                TaxonomyProjection.AppendGeneration(hash, article);
                if (article.CoverMediaDigest is { } cover)
                {
                    hash.AppendData("public-cover-v1\0"u8);
                    hash.AppendData(Convert.FromHexString(cover));
                }
            }
        }
        else
        {
            // Server-only mode (#51): local FSPK corpus construction is disabled, so bind every
            // article's complete content, coordinates, taxonomy, cover, and search profile/analyzer
            // versions deterministically across restarts without depending on corpus bytes.
            hash.AppendData("public-generation-server-only-v1\0"u8);
            hash.AppendData(SearchProfileDomain);
            hash.AppendData(SearchAnalyzerDomain);
            if (wideSearch) hash.AppendData("public-search-bm25-wide-v1\0"u8);
            AppendNumber(articles.Count);
            Span<byte> articleFingerprint = stackalloc byte[32];
            foreach (var article in articles)
            {
                ct.ThrowIfCancellationRequested();
                ArticleSearchIndex.ComputeArticleFingerprint(article, articleFingerprint);
                hash.AppendData(articleFingerprint);
                TaxonomyProjection.AppendGeneration(hash, article);
                if (article.CoverMediaDigest is { } cover)
                {
                    hash.AppendData("public-cover-v1\0"u8);
                    hash.AppendData(Convert.FromHexString(cover));
                }
            }
        }
        if (taxonomyEpoch != 0)
        {
            hash.AppendData("taxonomy-epoch-v1"u8);
            BinaryPrimitives.WriteInt64LittleEndian(coordinates, taxonomyEpoch);
            hash.AppendData(coordinates[..sizeof(long)]);
        }
        return BinaryPrimitives.ReadInt64LittleEndian(hash.GetHashAndReset()) & long.MaxValue;

        void AppendNumber(int value)
        {
            Span<byte> number = stackalloc byte[sizeof(int)];
            BinaryPrimitives.WriteInt32LittleEndian(number, value);
            hash.AppendData(number);
        }
    }
}

/// <summary>
/// Bounded single-candidate snapshot coordinator (#51): enforces at most one simultaneous in-flight
/// snapshot build, cancels superseded candidates promptly, and fences atomic installation against
/// the intended source generation epoch and active instance lease.
/// </summary>
internal sealed class PublicSnapshotCoordinator : IDisposable
{
    private readonly object _sync = new();
    private readonly SemaphoreSlim _candidateGate = new(1, 1);
    private CancellationTokenSource? _activeCandidateCts;
    private long _epoch;
    private int _activeBuilds;
    private int _peakActiveBuilds;
    private long _supersededCount;
    private long _rejectedInstallCount;

    internal long CurrentEpoch => Volatile.Read(ref _epoch);
    internal int ActiveBuilds => Volatile.Read(ref _activeBuilds);
    internal int PeakActiveBuilds => Volatile.Read(ref _peakActiveBuilds);
    internal long SupersededCount => Volatile.Read(ref _supersededCount);
    internal long RejectedInstallCount => Volatile.Read(ref _rejectedInstallCount);

    internal long Invalidate(Action? onInvalidate = null)
    {
        CancellationTokenSource? toCancel;
        long nextEpoch;
        lock (_sync)
        {
            nextEpoch = ++_epoch;
            toCancel = _activeCandidateCts;
            onInvalidate?.Invoke();
        }
        CancelQuietly(toCancel);
        return nextEpoch;
    }

    internal void SupersedeActiveCandidate()
    {
        CancellationTokenSource? toCancel;
        lock (_sync) toCancel = _activeCandidateCts;
        CancelQuietly(toCancel);
    }

    internal async Task<(bool StillCurrent, T? Candidate)> BuildCandidateAsync<T>(
        long expectedEpoch,
        Func<CancellationToken, T> build,
        CancellationToken callerCt,
        CancellationToken leaseStoppedCt)
    {
        // Supersede any older in-flight candidate before awaiting the single-candidate gate.
        SupersedeActiveCandidate();

        using var waitLinked = leaseStoppedCt.CanBeCanceled
            ? CancellationTokenSource.CreateLinkedTokenSource(callerCt, leaseStoppedCt)
            : null;
        var waitToken = waitLinked?.Token ?? callerCt;
        await _candidateGate.WaitAsync(waitToken);

        CancellationTokenSource? buildCts = null;
        var entered = false;
        try
        {
            lock (_sync)
            {
                if (_epoch != expectedEpoch)
                {
                    Interlocked.Increment(ref _supersededCount);
                    return (false, default);
                }
                if (leaseStoppedCt.IsCancellationRequested)
                    throw new OperationCanceledException(leaseStoppedCt);
                callerCt.ThrowIfCancellationRequested();

                buildCts = leaseStoppedCt.CanBeCanceled
                    ? CancellationTokenSource.CreateLinkedTokenSource(callerCt, leaseStoppedCt)
                    : CancellationTokenSource.CreateLinkedTokenSource(callerCt);
                _activeCandidateCts = buildCts;
            }

            var active = Interlocked.Increment(ref _activeBuilds);
            entered = true;
            UpdatePeak(active);

            T candidate;
            try
            {
                candidate = build(buildCts.Token);
            }
            catch (OperationCanceledException) when (
                !callerCt.IsCancellationRequested &&
                !leaseStoppedCt.IsCancellationRequested &&
                Volatile.Read(ref _epoch) != expectedEpoch)
            {
                Interlocked.Increment(ref _supersededCount);
                return (false, default);
            }

            if (Volatile.Read(ref _epoch) != expectedEpoch)
            {
                Interlocked.Increment(ref _supersededCount);
                return (false, default);
            }
            if (leaseStoppedCt.IsCancellationRequested)
                throw new OperationCanceledException(leaseStoppedCt);

            return (true, candidate);
        }
        finally
        {
            if (entered) Interlocked.Decrement(ref _activeBuilds);
            lock (_sync)
            {
                if (ReferenceEquals(_activeCandidateCts, buildCts))
                    _activeCandidateCts = null;
            }
            buildCts?.Dispose();
            _candidateGate.Release();
        }
    }

    internal bool TryCommitCandidate(long expectedEpoch, Func<bool> leaseCurrent, Action install)
    {
        lock (_sync)
        {
            if (_epoch != expectedEpoch || !leaseCurrent())
            {
                Interlocked.Increment(ref _rejectedInstallCount);
                return false;
            }
            install();
            return true;
        }
    }

    public void Dispose()
    {
        CancellationTokenSource? toCancel;
        lock (_sync)
        {
            _epoch++;
            toCancel = _activeCandidateCts;
            _activeCandidateCts = null;
        }
        CancelQuietly(toCancel);
        _candidateGate.Dispose();
    }

    private void UpdatePeak(int value)
    {
        int observed;
        while ((observed = Volatile.Read(ref _peakActiveBuilds)) < value)
        {
            if (Interlocked.CompareExchange(ref _peakActiveBuilds, value, observed) == observed)
                break;
        }
    }

    private static void CancelQuietly(CancellationTokenSource? cts)
    {
        if (cts is null) return;
        try { cts.Cancel(); }
        catch (ObjectDisposedException) { }
    }
}

internal sealed class Publications(NpgsqlDataSource db, WebPages pages, ILogger<Publications> log, InstanceLease? lease = null,
    RuntimeEvidence? evidence = null, DistributionSettings? distribution = null, PublishedMediaStore? media = null,
    PublicProjection? projection = null, bool siteConfigOverrideActive = false, SitePages? sitePages = null,
    PublicSearchCache? searchCache = null, bool buildLocalCorpus = true)
{
    private const string MarkOutboxProcessedSql =
        "update public.blog_outbox set processed_at=now() where processed_at is null and id <= $1";
    private readonly SemaphoreSlim _writers = new(1, 1);
    private readonly PublicListCursor _listCursor = new(TimeProvider.System);
    private readonly PublicSearchCursor _searchCursor = new(TimeProvider.System);
    private readonly PublicProjection _projection = projection ?? new();
    private readonly PublicSnapshotCoordinator _coordinator = new();
    private PublicSnapshot? _lastProjection;
    private bool? _taxonomyEpochInstalled;
    private bool? _siteConfigOverrideInstalled;
    internal PublicSnapshot? Snapshot => lease?.IsCurrent is false ? null : _projection.Current?.Source;
    internal bool LeaseCurrent => lease?.IsCurrent is not false;

    private void ReplaceProjection(PublicSnapshot? next)
    {
        _projection.Replace(next);
        searchCache?.OnSnapshotChanged(next?.Generation);
    }

    internal void OnLeaseStopped()
    {
        _coordinator.Invalidate(() =>
        {
            _lastProjection = null;
            ReplaceProjection(null);
        });
    }

    internal async Task<(ArticleState Article, bool Changed)> Command(Store store, string? token,
        ArticleAction action, Edit edit, CancellationToken ct, string? expectedSession = null,
        ArticleBodyInsertionCommand? insertion = null, ArticleBodyInsertionsCommand? insertions = null,
        ArticleBodyEditsCommand? bodyEdits = null) =>
        await Change(action is ArticleAction.Publish or ArticleAction.Retract or ArticleAction.Delete,
            invalidate => store.WithSession(token, true, async (connection, tx, actor) =>
            {
                if (insertion is null && insertions is null && bodyEdits is null)
                    FsusBlog.V2.Server.Sessions.SiteSessions.IfCurrent(actor.Id, token, expectedSession);
                else FsusBlog.V2.Server.Sessions.SiteSessions.RequireCurrent(actor.Id, Store.TokenDigest(token)!, expectedSession);
                var update = bodyEdits is not null ? await Store.SaveBodyEdits(connection, tx, actor, edit, bodyEdits, ct) :
                    insertions is not null ? await Store.SaveBodyInsertions(connection, tx, actor, edit, insertions, ct) :
                    insertion is not null ? await Store.SaveBodyInsertion(connection, tx, actor, edit, insertion, ct) :
                    await Store.Execute(connection, tx, actor, action, edit, ct);
                if (insertions is not null || bodyEdits is not null)
                    FsusBlog.V2.Server.Sessions.SiteSessions.RequireCurrent(actor.Id, Store.TokenDigest(token)!, expectedSession);
                if (update.Changed) invalidate();
                return update;
            }, ct), ct);

    internal Task Attest(Func<Task> mint, CancellationToken ct) => Change(invalidate: false, async _ =>
    {
        await mint();
        return true;
    }, ct);

    internal Task<T> AdministrativePublication<T>(Func<Action, Task<T>> transact, CancellationToken ct) =>
        Change(invalidate: true, transact, ct);

    internal Task<(ArticleState Article, bool Changed)> PublishWithImages(Store store, string? token, string? expectedSession,
        PublishedMediaStore media, int articleId, long expectedRevision, Guid commandKey, IReadOnlyList<Guid> assetIds,
        CancellationToken ct)
    {
        var edit = Publishing.Validate(ArticleAction.Publish, new(articleId, expectedRevision, commandKey, "", ""));
        var selection = PublishedMediaSelection.Create(assetIds);
        return Change(invalidate: true, invalidate => store.WithSession(token, true, async (connection, tx, actor) =>
        {
            FsusBlog.V2.Server.Sessions.SiteSessions.RequireCurrent(actor.Id, Store.TokenDigest(token)!, expectedSession);
            var result = await Store.PublishWithImages(connection, tx, actor, edit, media, selection, ct);
            if (result.Changed) invalidate();
            return result;
        }, ct), ct);
    }

    private async Task<T> Change<T>(bool invalidate, Func<Action, Task<T>> transact, CancellationToken ct)
    {
        lease?.RequireCurrent();
        if (!await _writers.WaitAsync(TimeSpan.FromSeconds(5), ct)) throw new PublicUnavailableException();
        try
        {
            lease?.RequireCurrent();
            var result = await transact(() =>
            {
                // After an ambiguous commit or interruption, the old public bytes remain unservable.
                // Any in-flight background candidate is immediately superseded and cancelled.
                if (invalidate) _coordinator.Invalidate(() => ReplaceProjection(null));
            });

            if (invalidate && Snapshot is null)
            {
                try { await RebuildWhileHoldingWritersAsync(ct); }
                catch (OperationCanceledException) when (!LeaseCurrent && !ct.IsCancellationRequested)
                {
                    throw new PublicUnavailableException();
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    log.LogError(ex, "The article command committed; public projection awaits durable outbox recovery.");
                    throw new PublicUnavailableException();
                }
            }
            lease?.RequireCurrent();
            return result;
        }
        finally { _writers.Release(); }
    }

    internal async Task Refresh(CancellationToken ct)
    {
        using var attribution = evidence?.PublicationWork();
        lease?.RequireCurrent();
        ProjectionSource? source;
        long expectedEpoch;
        PublicSnapshot? baseProjection;

        await _writers.WaitAsync(ct);
        try
        {
            try { await PublishScheduled(ct); }
            catch (NpgsqlException error) when (LeaseCurrent && !ct.IsCancellationRequested)
            {
                log.LogError(error, "Scheduled publication batch rolled back or awaits outbox recovery.");
            }

            source = await ReadProjectionSourceAsync(ct);
            if (source is null)
            {
                evidence?.CountRefresh(false);
                return;
            }
            expectedEpoch = _coordinator.CurrentEpoch;
            baseProjection = _lastProjection;
        }
        finally { _writers.Release(); }

        // Build the candidate snapshot OUTSIDE _writers and OUTSIDE any open PostgreSQL transaction (#51).
        var (stillCurrent, next) = await BuildProjectionCandidateAsync(expectedEpoch, source, baseProjection, ct);
        if (!stillCurrent || next is null) return;

        await _writers.WaitAsync(ct);
        try
        {
            if (_coordinator.CurrentEpoch != expectedEpoch || !LeaseCurrent) return;
            await MarkOutboxProcessedAsync(source.MaxPendingOutboxId, ct);
            InstallProjectionCandidate(expectedEpoch, next);
        }
        finally { _writers.Release(); }
    }

    private async Task PublishScheduled(CancellationToken ct)
    {
        await using var connection = await db.OpenConnectionAsync(ct);
        await using var tx = await InstanceLease.BeginProtected(connection, lease, ct);
        if (await Authoring.ArticleScheduleStore.PublishDue(connection, tx, ct) != 0)
            _coordinator.Invalidate(() => ReplaceProjection(null));
        await InstanceLease.CommitProtected(tx, lease, ct);
    }

    private async Task RebuildWhileHoldingWritersAsync(CancellationToken ct)
    {
        using var attribution = evidence?.PublicationWork();
        lease?.RequireCurrent();
        var expectedEpoch = _coordinator.CurrentEpoch;
        var baseProjection = _lastProjection;
        var source = await ReadProjectionSourceAsync(ct);
        if (source is null)
        {
            evidence?.CountRefresh(false);
            return;
        }

        // Build candidate outside any open PostgreSQL transaction while enforcing the single-candidate bound.
        var (stillCurrent, next) = await BuildProjectionCandidateAsync(expectedEpoch, source, baseProjection, ct);
        if (!stillCurrent || next is null) return;

        await MarkOutboxProcessedAsync(source.MaxPendingOutboxId, ct);
        InstallProjectionCandidate(expectedEpoch, next);
    }

    private void InstallProjectionCandidate(long expectedEpoch, PublicSnapshot next)
    {
        if (_coordinator.TryCommitCandidate(expectedEpoch, () => LeaseCurrent, () =>
        {
            _lastProjection = next;
            ReplaceProjection(next);
        }))
        {
            evidence?.CountRefresh(true);
        }
    }

    private Task<(bool StillCurrent, PublicSnapshot? Candidate)> BuildProjectionCandidateAsync(long expectedEpoch,
        ProjectionSource source, PublicSnapshot? baseProjection, CancellationToken ct) =>
        _coordinator.BuildCandidateAsync(expectedEpoch, buildCt =>
            new PublicSnapshot(source.MaxEvent, source.Articles, source.Taxonomy, pages, _listCursor, baseProjection, log,
                evidence, distribution, buildCt, source.TaxonomyEpoch, source.Media, source.SiteConfigRevision,
                source.SitePagesMask, _searchCursor, buildLocalCorpus: buildLocalCorpus), ct,
            lease?.Stopped ?? CancellationToken.None);

    private sealed record ProjectionSource(
        long MaxEvent,
        long TaxonomyEpoch,
        long SiteConfigRevision,
        int SitePagesMask,
        long MaxPendingOutboxId,
        TaxonomyRows Taxonomy,
        PublishedMediaProjection? Media,
        List<Article> Articles);

    private async Task<ProjectionSource?> ReadProjectionSourceAsync(CancellationToken ct)
    {
        lease?.RequireCurrent();
        using var stop = lease is null ? null : CancellationTokenSource.CreateLinkedTokenSource(ct, lease.Stopped);
        ct = stop?.Token ?? ct;
        await using var connection = await db.OpenConnectionAsync(ct);
        await using var tx = await InstanceLease.BeginProtected(connection, lease, ct, System.Data.IsolationLevel.RepeatableRead);
        var (maxEvent, taxonomyEpoch, siteConfigRevision, sitePagesMask, maxPendingOutboxId) = await ReadWatermarks(connection, tx, ct);
        var current = Snapshot;
        var rebuilt = current is null || current.Watermark != maxEvent || current.TaxonomyEpoch != taxonomyEpoch ||
            current.SiteConfigRevision != siteConfigRevision || current.SitePagesMask != sitePagesMask;
        if (!rebuilt)
        {
            if (maxPendingOutboxId > 0)
                await SqlCommands.Execute(connection, tx, ct, MarkOutboxProcessedSql, maxPendingOutboxId);
            await InstanceLease.CommitProtected(tx, lease, ct);
            return null;
        }

        var taxonomy = await TaxonomyStore.Read(connection, tx, ct);
        var mediaProjection = media is null ? null : await PublishedMediaProjection.Read(connection, tx, ct);
        var articles = new List<Article>();
        await using (var cmd = Store.Sql(connection, tx, """
            select a.id,r.revision,p.publication_id,r.title,r.body,a.created_at,r.happened_at,p.published_at,
                p.publication_no, c.id, c.name, tags.ids, tags.names, s.id,
                w.enabled,w.license_type,w.copyright_holder,w.copyright_year,w.rights_statement,w.attribution_template,
                w.copy_policy,w.max_excerpt_chars,w.allow_code_copy,w.show_public_badge,w.proof_binding_enabled,r.author_summary
            from public.article_publication p join public.article a on a.id=p.article_id
            join public.article_revision r on r.article_id=p.article_id and r.revision=p.revision
            join public.article_publication_rights s on s.article_id=p.article_id and s.publication_id=p.publication_id and s.revision=p.revision
            join public.article_revision_rights w on w.article_id=s.article_id and w.revision=s.revision
            left join public.article_revision_category link on link.article_id=p.article_id and link.revision=p.revision
            left join public.category c on c.id=link.category_id
            left join lateral (
                select array_agg(t.id order by t.id) as ids, array_agg(t.name order by t.id) as names
                from public.article_revision_tag tag_link join public.tag t on t.id=tag_link.tag_id
                where tag_link.article_id=p.article_id and tag_link.revision=p.revision
            ) tags on true
            where not a.deleted and a.published_revision=p.revision
            order by a.created_at desc, a.id desc
            """))
        await using (var row = await cmd.ExecuteReaderAsync(ct))
        {
            while (await row.ReadAsync(ct))
            {
                var revision = row.GetInt64(1);
                var publication = row.GetInt64(2);
                var id = row.GetInt32(0);
                PublishedArticleRights rights;
                try
                {
                    rights = new(row.GetInt64(13), Authoring.PublicationRightsStore.ReadPolicy(row, 14, id, revision));
                }
                catch (ProtocolException)
                {
                    log.LogWarning("Article {ArticleId} publication {PublicationId} has an invalid immutable rights policy.", id, publication);
                    continue;
                }
                var body = row.GetString(4);
                var limit = Math.Min(body.Length, 200);
                if (limit > 0 && char.IsHighSurrogate(body[limit - 1])) limit--;
                var summary = row.IsDBNull(25) ? body[..limit] : row.GetString(25);
                var category = row.IsDBNull(9) ? null : new TaxonomyName(row.GetInt32(9), row.GetString(10));
                var tags = row.IsDBNull(11) ? [] : row.GetFieldValue<int[]>(11).Zip(row.GetFieldValue<string[]>(12),
                    (tagId, name) => new TaxonomyName(tagId, name)).ToArray();
                articles.Add(new Article(id, revision, publication, checked((int)revision), row.GetInt32(8),
                    row.GetString(3), body, row.GetFieldValue<DateTimeOffset>(5), row.GetFieldValue<DateTimeOffset>(6),
                    row.GetFieldValue<DateTimeOffset>(7), summary, category, tags, rights, mediaProjection?.CoverDigest(id, publication)));
            }
        }
        await InstanceLease.CommitProtected(tx, lease, ct);
        return new ProjectionSource(maxEvent, taxonomyEpoch, siteConfigRevision, sitePagesMask, maxPendingOutboxId,
            taxonomy, mediaProjection, articles);
    }

    private async Task MarkOutboxProcessedAsync(long maxPendingOutboxId, CancellationToken ct)
    {
        if (maxPendingOutboxId <= 0) return;
        lease?.RequireCurrent();
        using var stop = lease is null ? null : CancellationTokenSource.CreateLinkedTokenSource(ct, lease.Stopped);
        ct = stop?.Token ?? ct;
        await using var connection = await db.OpenConnectionAsync(ct);
        await using var tx = await InstanceLease.BeginProtected(connection, lease, ct);
        await SqlCommands.Execute(connection, tx, ct, MarkOutboxProcessedSql, maxPendingOutboxId);
        await InstanceLease.CommitProtected(tx, lease, ct);
    }

    private async Task<(long Article, long Taxonomy, long SiteConfig, int SitePagesMask, long MaxPendingOutboxId)> ReadWatermarks(
        NpgsqlConnection connection, NpgsqlTransaction tx, CancellationToken ct)
    {
        _taxonomyEpochInstalled ??= await CurrentSchema.HasAdminTagMetadataAsync(connection, tx, ct);
        var siteConfig = siteConfigOverrideActive ? (pages.SiteConfig ?? distribution?.Site) : null;
        if (siteConfig is not null)
            _siteConfigOverrideInstalled ??= await CurrentSchema.HasSiteConfigOverrideSchemaAsync(connection, tx, ct);
        var readSiteConfig = siteConfig is not null && _siteConfigOverrideInstalled == true;
        const string articles = "select coalesce(max(id),0) from public.blog_outbox where kind in ('publish','retract','delete')";
        const string pendingOutbox = "select coalesce(max(id),0) from public.blog_outbox where processed_at is null";
        var taxonomyExpr = _taxonomyEpochInstalled.Value ? "(select revision from public.taxonomy_epoch where singleton)" : "0::bigint";
        var siteConfigExpr = readSiteConfig ? "(select revision from public.site_config_override where singleton)" : "0::bigint";
        var sql = $"select ({articles}), {taxonomyExpr}, {siteConfigExpr}, ({pendingOutbox})";
        long articleWatermark, taxonomyEpoch, siteConfigRevision, maxPendingOutboxId;
        await using (var command = Store.Sql(connection, tx, sql))
        await using (var row = await command.ExecuteReaderAsync(ct))
        {
            await row.ReadRequired(ct, () => new InvalidOperationException("The public watermarks are missing."));
            articleWatermark = row.GetInt64(0);
            taxonomyEpoch = row.GetInt64(1);
            siteConfigRevision = row.GetInt64(2);
            maxPendingOutboxId = row.GetInt64(3);
        }
        if (readSiteConfig && siteConfig!.Revision != siteConfigRevision)
            await SiteConfigOverrideStore.SyncAsync(connection, tx, siteConfig, ct);
        var sitePagesMask = sitePages is null ? 0 : await sitePages.ConfiguredMaskAsync(connection, tx, ct);
        return (articleWatermark, taxonomyEpoch, siteConfigRevision, sitePagesMask, maxPendingOutboxId);
    }
}

internal sealed class PublicUnavailableException : Exception;

internal sealed class OutboxWorker(Publications publications, ILogger<OutboxWorker> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(2));
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            if (!publications.LeaseCurrent) return;
            try { await publications.Refresh(stoppingToken); }
            catch (Exception) when (!publications.LeaseCurrent) { return; }
            catch (Exception error) when (!stoppingToken.IsCancellationRequested)
            {
                log.LogError(error, "Public projection refresh failed; pending work remains durable.");
            }
        }
    }
}
