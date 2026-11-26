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

    internal async ValueTask<CachedSearchPayload?> SearchAsync(
        Publications publications,
        PublicSnapshot snapshot,
        string keyword,
        ArticleSearchSort sort,
        int size,
        CancellationToken ct,
        (int Number, bool Paginated)? fas4Page = null,
        string? cursor = null,
        int? countThreshold = null,
        int? workBudget = null,
        TimeSpan? callerDeadline = null)
    {
        RequireCurrent(publications, snapshot);
        if (!snapshot.HasSearchIndex)
        {
            if (fas4Page.HasValue) return null;
            throw PublicSearchFailure.Unavailable();
        }

        var plan = SearchQueryPlan.Build(keyword, ct);
        var cursorKey = SearchCursorCacheKey.None;
        if (cursor is not null)
        {
            try
            {
                var decoded = snapshot.DecodeSearchCursor(plan, sort, size, cursor);
                cursorKey = SearchCursorCacheKey.From(decoded.Position, decoded.ReturnedSoFar);
            }
            catch (PublicSearchFailure failure) when (failure.Details == "search_generation_changed")
            {
                _cache.RecordGenerationRestart();
                throw;
            }
        }

        var key = new SearchResultCacheKey(
            fas4Page.HasValue ? SearchCacheEndpointKind.Fas4 : SearchCacheEndpointKind.V2,
            snapshot.Generation,
            snapshot.SearchProfileVersion,
            snapshot.SearchAnalyzerVersion,
            snapshot.SearchUsesWideProfile,
            plan.BuildCanonicalCacheKey(),
            sort,
            fas4Page?.Number ?? 0,
            size,
            fas4Page?.Paginated ?? true,
            cursorKey,
            countThreshold ?? ArticleSearchIndex.MaxPaginatedResults,
            workBudget ?? ArticleSearchIndex.DefaultWorkBudgetCandidates);

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

                    if (key.Endpoint == SearchCacheEndpointKind.Fas4)
                    {
                        var computed = snapshot.SearchPageWithPlan(plan, key.Sort, key.Page, key.Size, workCt)
                            ?? throw PublicSearchFailure.Unavailable();
                        return new CachedSearchPayload(computed.Bytes, computed.Total);
                    }

                    var continuation = key.Cursor;
                    DecodedSearchCursor? decoded = continuation.HasCursor
                        ? new(new SearchCursorPosition(continuation.Tier, continuation.ScoreBits,
                            continuation.PublishedAtTicks, continuation.CreatedAtTicks, continuation.Id),
                            continuation.ReturnedSoFar)
                        : null;
                    var frame = snapshot.SearchV2WithPlan(plan, key.Sort, key.Size, decoded, workCt, out var hasMore,
                        key.CountThreshold, key.WorkBudget);
                    var validUntil = hasMore
                        ? snapshot.SearchCursorNowUtcSeconds + MaxCursorReuseSeconds
                        : long.MaxValue;
                    return new CachedSearchPayload(frame, 0, validUntil);
                },
                ct,
                callerDeadline,
                () => IsCurrent(publications, snapshot)).ConfigureAwait(false);

            RequireCurrent(publications, snapshot);
            return payload;
        }
        catch (SearchGenerationObsoleteException)
        {
            throw new PublicUnavailableException();
        }
        catch (Exception failure) when (failure is SearchWorkRejectedException or TimeoutException)
        {
            throw PublicSearchFailure.BudgetExceeded();
        }
        catch (PublicSearchFailure failure) when (fas4Page.HasValue && failure.Details == "search_unavailable")
        {
            return null;
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
