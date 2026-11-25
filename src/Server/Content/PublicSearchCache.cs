namespace FsusBlog.V2.Server.Content;

/// <summary>
/// Server-side coordinator for bounded public search caching, single-flight coalescing,
/// admission limits, and strict current-snapshot / lease fencing (#50).
/// Never caches failures or serves stale hits after withdrawal or lease loss, and never logs raw user queries.
/// </summary>
internal sealed class PublicSearchCache : IDisposable
{
    // PublicSearchCursor tokens live 15 minutes; cap cached V2 entries that carry a nextCursor
    // to 5 minutes so every served cursor still has at least 10 minutes of remaining validity.
    internal const long MaxCursorReuseSeconds = 5 * 60;

    private readonly SearchResultCache _cache;
    private readonly Func<CancellationToken, Task>? _beforeCompute;

    internal PublicSearchCache(
        SearchResultCacheOptions? options = null,
        TimeProvider? timeProvider = null,
        Func<CancellationToken, Task>? beforeCompute = null)
    {
        _cache = new SearchResultCache(options ?? DefaultOptions(), timeProvider ?? TimeProvider.System);
        _beforeCompute = beforeCompute;
    }

    internal static SearchResultCacheOptions DefaultOptions() => new(
        MaxEntries: 512,
        MaxRetainedBytes: 8 * 1024 * 1024,
        MaxEntryBytes: 2 * 1024 * 1024,
        MaxInFlightKeys: 32,
        MaxWaitersPerKey: 16,
        MaxTotalWaiters: 32,
        MaxRetainedGenerations: 1,
        DefaultCallerDeadline: TimeSpan.FromSeconds(5));

    internal SearchResultCacheStats SnapshotStats() => _cache.SnapshotStats();

    internal void OnSnapshotChanged(long? activeGeneration) => _cache.RetireExceptGeneration(activeGeneration);

    internal void Clear() => _cache.Clear();

    internal async ValueTask<(byte[] Bytes, int Total)?> SearchFas4Async(
        Publications publications,
        PublicSnapshot snapshot,
        string keyword,
        ArticleSearchSort sort,
        int page,
        int size,
        bool paginated,
        CancellationToken ct,
        TimeSpan? callerDeadline = null)
    {
        RequireCurrent(publications, snapshot);
        if (!snapshot.HasSearchIndex) return null;

        var plan = SearchQueryPlan.Build(keyword, ct);
        var key = new SearchResultCacheKey(
            SearchCacheEndpointKind.Fas4,
            snapshot.Generation,
            snapshot.SearchProfileVersion,
            snapshot.SearchAnalyzerVersion,
            snapshot.SearchUsesWideProfile,
            plan.BuildCanonicalCacheKey(),
            sort,
            page,
            size,
            paginated,
            SearchCursorCacheKey.None,
            ArticleSearchIndex.MaxPaginatedResults,
            ArticleSearchIndex.DefaultWorkBudgetCandidates);

        try
        {
            var payload = await _cache.GetOrExecuteAsync(
                key,
                async workCt =>
                {
                    if (_beforeCompute is not null) await _beforeCompute(workCt).ConfigureAwait(false);
                    workCt.ThrowIfCancellationRequested();
                    if (!IsCurrent(publications, snapshot))
                        throw new SearchGenerationObsoleteException();
                    var computed = snapshot.SearchPageWithPlan(plan, sort, page, size, workCt)
                        ?? throw PublicSearchFailure.Unavailable();
                    return new CachedSearchPayload(computed.Bytes, computed.Total, long.MaxValue);
                },
                ct,
                callerDeadline,
                () => IsCurrent(publications, snapshot)).ConfigureAwait(false);

            RequireCurrent(publications, snapshot);
            return (payload.Bytes, payload.Total);
        }
        catch (SearchGenerationObsoleteException)
        {
            throw new PublicUnavailableException();
        }
        catch (SearchWorkRejectedException)
        {
            throw PublicSearchFailure.BudgetExceeded();
        }
        catch (TimeoutException)
        {
            throw PublicSearchFailure.BudgetExceeded();
        }
        catch (PublicSearchFailure failure) when (failure.Details == "search_unavailable")
        {
            return null;
        }
    }

    internal async ValueTask<byte[]> SearchV2Async(
        Publications publications,
        PublicSnapshot snapshot,
        string keyword,
        ArticleSearchSort sort,
        int size,
        string? cursor,
        CancellationToken ct,
        int? countThreshold = null,
        int? workBudget = null,
        TimeSpan? callerDeadline = null)
    {
        RequireCurrent(publications, snapshot);
        if (!snapshot.HasSearchIndex) throw PublicSearchFailure.Unavailable();

        var plan = SearchQueryPlan.Build(keyword, ct);
        DecodedSearchCursor? decoded = null;
        if (cursor is not null)
        {
            try
            {
                decoded = snapshot.DecodeSearchCursor(plan, sort, size, cursor);
            }
            catch (PublicSearchFailure failure) when (failure.Details == "search_generation_changed")
            {
                _cache.RecordGenerationRestart();
                throw;
            }
        }

        var effectiveThreshold = countThreshold ?? ArticleSearchIndex.MaxPaginatedResults;
        var effectiveBudget = workBudget ?? ArticleSearchIndex.DefaultWorkBudgetCandidates;
        var cursorKey = decoded is { } d
            ? SearchCursorCacheKey.From(d.Position, d.ReturnedSoFar)
            : SearchCursorCacheKey.None;

        var key = new SearchResultCacheKey(
            SearchCacheEndpointKind.V2,
            snapshot.Generation,
            snapshot.SearchProfileVersion,
            snapshot.SearchAnalyzerVersion,
            snapshot.SearchUsesWideProfile,
            plan.BuildCanonicalCacheKey(),
            sort,
            Page: 0,
            size,
            Paginated: true,
            cursorKey,
            effectiveThreshold,
            effectiveBudget);

        try
        {
            var payload = await _cache.GetOrExecuteAsync(
                key,
                async workCt =>
                {
                    if (_beforeCompute is not null) await _beforeCompute(workCt).ConfigureAwait(false);
                    workCt.ThrowIfCancellationRequested();
                    if (!IsCurrent(publications, snapshot))
                        throw new SearchGenerationObsoleteException();
                    var frame = snapshot.SearchV2WithPlan(plan, sort, size, decoded, workCt, out var hasMore,
                        countThreshold, workBudget);
                    var validUntil = hasMore
                        ? snapshot.SearchCursorNowUtcSeconds + MaxCursorReuseSeconds
                        : long.MaxValue;
                    return new CachedSearchPayload(frame, 0, validUntil);
                },
                ct,
                callerDeadline,
                () => IsCurrent(publications, snapshot)).ConfigureAwait(false);

            RequireCurrent(publications, snapshot);
            return payload.Bytes;
        }
        catch (SearchGenerationObsoleteException)
        {
            throw new PublicUnavailableException();
        }
        catch (SearchWorkRejectedException)
        {
            throw PublicSearchFailure.BudgetExceeded();
        }
        catch (TimeoutException)
        {
            throw PublicSearchFailure.BudgetExceeded();
        }
    }

    public void Dispose() => _cache.Dispose();

    private static bool IsCurrent(Publications publications, PublicSnapshot snapshot) =>
        publications.LeaseCurrent && ReferenceEquals(snapshot, publications.Snapshot);

    private static void RequireCurrent(Publications publications, PublicSnapshot snapshot)
    {
        if (!IsCurrent(publications, snapshot))
            throw new PublicUnavailableException();
    }
}
