using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.DependencyInjection;

public sealed class PublicSearchCacheTests
{
    private static readonly DateTimeOffset BaseTime = new(2026, 6, 1, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task ConcurrentIdenticalRequestsShareOneExecutionAndCoalesceWaiters()
    {
        using var cache = new SearchResultCache(new SearchResultCacheOptions(
            MaxEntries: 64,
            MaxRetainedBytes: 1024 * 1024,
            MaxInFlightKeys: 16,
            MaxWaitersPerKey: 16,
            MaxTotalWaiters: 32,
            DefaultCallerDeadline: TimeSpan.FromSeconds(5)));

        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var executions = 0;
        var key = MakeKey(generation: 100, query: "alpha beta");

        var tasks = Enumerable.Range(0, 16).Select(_ => cache.GetOrExecuteAsync(
            key,
            async ct =>
            {
                Interlocked.Increment(ref executions);
                started.TrySetResult();
                await release.Task.WaitAsync(ct);
                return new CachedSearchPayload([1, 2, 3, 4], 42);
            },
            CancellationToken.None).AsTask()).ToArray();

        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await WaitUntilAsync(() => cache.SnapshotStats().ActiveWaiters == 16, TimeSpan.FromSeconds(5));

        var duringStats = cache.SnapshotStats();
        Assert.Equal(1, duringStats.Executions);
        Assert.Equal(15, duringStats.CoalescedWaiters);
        Assert.Equal(1, duringStats.InFlightCount);
        Assert.Equal(16, duringStats.ActiveWaiters);

        release.TrySetResult();
        var results = await Task.WhenAll(tasks);

        Assert.Equal(1, executions);
        Assert.All(results, r =>
        {
            Assert.Equal(42, r.Total);
            Assert.Same(results[0].Bytes, r.Bytes);
        });

        var cachedHit = await cache.GetOrExecuteAsync(
            key,
            _ => throw new InvalidOperationException("Should have served from cache."),
            CancellationToken.None);
        Assert.Same(results[0].Bytes, cachedHit.Bytes);

        var afterStats = cache.SnapshotStats();
        Assert.Equal(1, afterStats.Hits);
        Assert.Equal(16, afterStats.Misses);
        Assert.Equal(15, afterStats.CoalescedWaiters);
        Assert.Equal(1, afterStats.Executions);
        Assert.Equal(1, afterStats.EntryCount);
        Assert.Equal(0, afterStats.InFlightCount);
        Assert.Equal(0, afterStats.ActiveWaiters);
        Assert.True(afterStats.RetainedBytes > 0);
    }

    [Fact]
    public async Task DistinctGenerationsProfilesQueriesFiltersSortsAndCursorsNeverShareResults()
    {
        using var cache = new SearchResultCache(new SearchResultCacheOptions(
            MaxEntries: 128,
            MaxRetainedBytes: 4 * 1024 * 1024,
            MaxRetainedGenerations: 4));

        var cursorA = SearchCursorCacheKey.From(new SearchCursorPosition(SearchMatchTier.Primary, BitConverter.DoubleToInt64Bits(2.5), 100, 100, 10), 10);
        var cursorB = SearchCursorCacheKey.From(new SearchCursorPosition(SearchMatchTier.Relaxed, BitConverter.DoubleToInt64Bits(2.5), 100, 100, 10), 10);

        var distinctKeys = new[]
        {
            MakeKey(generation: 100, query: "繁體 搜索"),
            MakeKey(generation: 100, query: "繁体 搜索"), // exact form differs
            MakeKey(generation: 101, query: "繁體 搜索"), // distinct generation
            MakeKey(generation: 100, query: "繁體 搜索", endpoint: SearchCacheEndpointKind.Fas4),
            MakeKey(generation: 100, query: "繁體 搜索", profileVersion: 4),
            MakeKey(generation: 100, query: "繁體 搜索", analyzerVersion: 2),
            MakeKey(generation: 100, query: "繁體 搜索", usesWide: true),
            MakeKey(generation: 100, query: "繁體 搜索", sort: ArticleSearchSort.Latest),
            MakeKey(generation: 100, query: "繁體 搜索", page: 2),
            MakeKey(generation: 100, query: "繁體 搜索", size: 20),
            MakeKey(generation: 100, query: "繁體 搜索", paginated: false),
            MakeKey(generation: 100, query: "繁體 搜索", cursor: cursorA),
            MakeKey(generation: 100, query: "繁體 搜索", cursor: cursorB),
            MakeKey(generation: 100, query: "繁體 搜索", filterKey: "category:1"),
            MakeKey(generation: 100, query: "繁體 搜索", countThreshold: 250),
            MakeKey(generation: 100, query: "繁體 搜索", workBudget: 5_000),
        };

        for (var i = 0; i < distinctKeys.Length; i++)
        {
            var tag = i + 1;
            var res = await cache.GetOrExecuteAsync(
                distinctKeys[i],
                _ => ValueTask.FromResult(new CachedSearchPayload([(byte)tag], tag)),
                CancellationToken.None);
            Assert.Equal(tag, res.Total);
        }

        Assert.Equal(distinctKeys.Length, cache.SnapshotStats().Executions);
        Assert.Equal(0, cache.SnapshotStats().Hits);

        // Equivalent normalized query (fullwidth + extra whitespace + uppercase ASCII) shares canonical plan key!
        var canon1 = MakeKey(generation: 100, query: "  ＡＬＰＨＡ   beta ");
        var canon2 = MakeKey(generation: 100, query: "alpha beta");
        Assert.Equal(canon1, canon2);
        var first = await cache.GetOrExecuteAsync(canon1, _ => ValueTask.FromResult(new CachedSearchPayload([99], 99)), CancellationToken.None);
        var second = await cache.GetOrExecuteAsync(canon2, _ => throw new InvalidOperationException("Must hit cache"), CancellationToken.None);
        Assert.Same(first.Bytes, second.Bytes);
        Assert.Equal(1, cache.SnapshotStats().Hits);
    }

    [Fact]
    public async Task CancellingOneWaiterDoesNotCancelSharedWorkAndCancellingAllWaitersAbandonsWork()
    {
        using var cache = new SearchResultCache(new SearchResultCacheOptions(
            DefaultCallerDeadline: TimeSpan.FromSeconds(5)));

        // Case 1: Leader cancels while second waiter remains -> shared work continues for waiter 2.
        var key1 = MakeKey(generation: 10, query: "keep alive");
        var started1 = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release1 = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var workObservedCancel1 = false;

        using var ctsA = new CancellationTokenSource();
        using var ctsB = new CancellationTokenSource();

        var taskA = cache.GetOrExecuteAsync(key1, async ct =>
        {
            started1.TrySetResult();
            using var reg = ct.Register(() => workObservedCancel1 = true);
            await release1.Task.WaitAsync(ct);
            return new CachedSearchPayload([7, 8], 78);
        }, ctsA.Token).AsTask();

        await started1.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var taskB = cache.GetOrExecuteAsync(key1, _ => throw new InvalidOperationException("Must coalesce"), ctsB.Token).AsTask();
        await WaitUntilAsync(() => cache.SnapshotStats().ActiveWaiters == 2, TimeSpan.FromSeconds(5));

        ctsA.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => taskA);
        await WaitUntilAsync(() => cache.SnapshotStats().ActiveWaiters == 1, TimeSpan.FromSeconds(5));
        Assert.False(workObservedCancel1);

        release1.TrySetResult();
        var resultB = await taskB;
        Assert.Equal(78, resultB.Total);
        Assert.False(workObservedCancel1);
        Assert.Equal(0, cache.SnapshotStats().Cancellations);

        // Case 2: All waiters cancel -> shared work cancels immediately and slot is freed for a fresh caller.
        var key2 = MakeKey(generation: 10, query: "abandon me");
        var started2 = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var abandoned2 = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var ctsC = new CancellationTokenSource();
        using var ctsD = new CancellationTokenSource();

        var taskC = cache.GetOrExecuteAsync(key2, async ct =>
        {
            started2.TrySetResult();
            try
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, ct);
                return new CachedSearchPayload([1], 1);
            }
            catch (OperationCanceledException)
            {
                abandoned2.TrySetResult();
                throw;
            }
        }, ctsC.Token).AsTask();

        await started2.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var taskD = cache.GetOrExecuteAsync(key2, _ => throw new InvalidOperationException("Must coalesce"), ctsD.Token).AsTask();
        await WaitUntilAsync(() => cache.SnapshotStats().ActiveWaiters == 2, TimeSpan.FromSeconds(5));

        ctsC.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => taskC);
        Assert.False(abandoned2.Task.IsCompleted);

        ctsD.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => taskD);
        await abandoned2.Task.WaitAsync(TimeSpan.FromSeconds(5));

        var statsAfterAbandon = cache.SnapshotStats();
        Assert.Equal(1, statsAfterAbandon.Cancellations);
        Assert.Equal(0, statsAfterAbandon.InFlightCount);
        Assert.Equal(0, statsAfterAbandon.ActiveWaiters);

        // Next caller starts cleanly and is not poisoned by the abandoned slot.
        var fresh = await cache.GetOrExecuteAsync(key2, _ => ValueTask.FromResult(new CachedSearchPayload([5], 5)), CancellationToken.None);
        Assert.Equal(5, fresh.Total);
    }

    [Fact]
    public async Task CallerDeadlineExpiryFailureHandlingAdmissionCapsAndDisposalStayBounded()
    {
        var clock = new ControllableTimeProvider(BaseTime);
        var cache = new SearchResultCache(new SearchResultCacheOptions(
            MaxEntries: 16,
            MaxRetainedBytes: 8192,
            MaxInFlightKeys: 2,
            MaxWaitersPerKey: 2,
            MaxTotalWaiters: 3,
            DefaultCallerDeadline: TimeSpan.FromSeconds(10)), clock);

        try
        {
            // 1. Computation failure is NEVER cached.
            var failKey = MakeKey(generation: 20, query: "transient fail");
            await Assert.ThrowsAsync<InvalidOperationException>(() => cache.GetOrExecuteAsync(
                failKey,
                _ => ValueTask.FromException<CachedSearchPayload>(new InvalidOperationException("boom")),
                CancellationToken.None).AsTask());
            Assert.Equal(0, cache.SnapshotStats().EntryCount);

            var recovered = await cache.GetOrExecuteAsync(
                failKey,
                _ => ValueTask.FromResult(new CachedSearchPayload([42], 1)),
                CancellationToken.None);
            Assert.Equal(1, recovered.Total);

            // 2. Per-caller deadline expiry via deterministic TimeProvider does not cancel a patient peer.
            var slowKey = MakeKey(generation: 20, query: "slow deadline");
            var slowStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var slowRelease = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

            var impatient = cache.GetOrExecuteAsync(
                slowKey,
                async ct =>
                {
                    slowStarted.TrySetResult();
                    await slowRelease.Task.WaitAsync(ct);
                    return new CachedSearchPayload([9, 9], 99);
                },
                CancellationToken.None,
                callerDeadline: TimeSpan.FromMilliseconds(100)).AsTask();

            await slowStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
            var patient = cache.GetOrExecuteAsync(
                slowKey,
                _ => throw new InvalidOperationException("Should coalesce"),
                CancellationToken.None,
                callerDeadline: TimeSpan.FromSeconds(5)).AsTask();

            await WaitUntilAsync(() => cache.SnapshotStats().ActiveWaiters == 2, TimeSpan.FromSeconds(5));

            // 3. Admission cap: 3rd waiter on same key hits MaxWaitersPerKey (2) -> SearchWorkRejectedException!
            await Assert.ThrowsAsync<SearchWorkRejectedException>(() => cache.GetOrExecuteAsync(
                slowKey,
                _ => ValueTask.FromResult(new CachedSearchPayload([1], 1)),
                CancellationToken.None).AsTask());
            Assert.Equal(1, cache.SnapshotStats().RejectedWork);

            // Advance clock past impatient's 100ms deadline: impatient times out, patient still succeeds.
            clock.Advance(TimeSpan.FromMilliseconds(150));
            await Assert.ThrowsAsync<TimeoutException>(() => impatient);
            Assert.Equal(1, cache.SnapshotStats().DeadlineExpirations);

            slowRelease.TrySetResult();
            var patientResult = await patient;
            Assert.Equal(99, patientResult.Total);

            // 4. MaxInFlightKeys cap: fill 2 in-flight keys, 3rd key rejected cleanly.
            var gate1 = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var gate2 = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var s1 = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var s2 = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var inFlight1 = cache.GetOrExecuteAsync(MakeKey(20, "inflight one"), async ct =>
            {
                s1.TrySetResult();
                await gate1.Task.WaitAsync(ct);
                return new CachedSearchPayload([1], 1);
            }, CancellationToken.None).AsTask();
            var inFlight2 = cache.GetOrExecuteAsync(MakeKey(20, "inflight two"), async ct =>
            {
                s2.TrySetResult();
                await gate2.Task.WaitAsync(ct);
                return new CachedSearchPayload([2], 2);
            }, CancellationToken.None).AsTask();
            await Task.WhenAll(s1.Task, s2.Task).WaitAsync(TimeSpan.FromSeconds(5));

            await Assert.ThrowsAsync<SearchWorkRejectedException>(() => cache.GetOrExecuteAsync(
                MakeKey(20, "inflight three"),
                _ => ValueTask.FromResult(new CachedSearchPayload([3], 3)),
                CancellationToken.None).AsTask());
            Assert.Equal(2, cache.SnapshotStats().RejectedWork);

            // 5. Dispose cancels all active in-flight work and rejects future calls.
            var disposeObserved = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            gate1.TrySetResult();
            await inFlight1;
            var dispStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var inFlightDispose = cache.GetOrExecuteAsync(MakeKey(20, "dispose target"), async ct =>
            {
                dispStarted.TrySetResult();
                try { await Task.Delay(Timeout.InfiniteTimeSpan, ct); }
                catch (OperationCanceledException) { disposeObserved.TrySetResult(); throw; }
                return new CachedSearchPayload([0], 0);
            }, CancellationToken.None).AsTask();
            await dispStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));

            cache.Dispose();
            await disposeObserved.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await Assert.ThrowsAsync<ObjectDisposedException>(() => inFlightDispose);
            await Assert.ThrowsAnyAsync<Exception>(() => inFlight2);
            await Assert.ThrowsAsync<ObjectDisposedException>(() => cache.GetOrExecuteAsync(
                MakeKey(20, "after dispose"),
                _ => ValueTask.FromResult(new CachedSearchPayload([1], 1)),
                CancellationToken.None).AsTask());

            var finalStats = cache.SnapshotStats();
            Assert.Equal(0, finalStats.EntryCount);
            Assert.Equal(0, finalStats.RetainedBytes);
            Assert.Equal(0, finalStats.InFlightCount);
        }
        finally
        {
            cache.Dispose();
        }
    }

    [Fact]
    public async Task HostileHighCardinalityQueryBurstStaysStrictlyWithinByteEntryAndGenerationBounds()
    {
        const int maxEntries = 64;
        const long maxBytes = 32 * 1024;
        using var cache = new SearchResultCache(new SearchResultCacheOptions(
            MaxEntries: maxEntries,
            MaxRetainedBytes: maxBytes,
            MaxEntryBytes: 8 * 1024,
            MaxInFlightKeys: 16,
            MaxWaitersPerKey: 8,
            MaxTotalWaiters: 32,
            MaxRetainedGenerations: 1));

        // 2,000 unique high-cardinality 120-char queries across 20 concurrent tasks
        var payload = new byte[512];
        await Parallel.ForEachAsync(Enumerable.Range(0, 2_000), new ParallelOptions { MaxDegreeOfParallelism = 12 }, async (i, ct) =>
        {
            var q = $"hostile-{i:D6}-" + new string('q', 100);
            var key = MakeKey(generation: 100 + (i / 500), query: q);
            var res = await cache.GetOrExecuteAsync(key, _ => ValueTask.FromResult(new CachedSearchPayload(payload, i)), ct);
            Assert.Equal(i, res.Total);
        });

        // Oversized single entry (> MaxEntryBytes) must return cleanly without blowing the cache budget or retaining it.
        var giant = new byte[12 * 1024];
        var giantKey = MakeKey(generation: 103, query: "giant response");
        var giantRes = await cache.GetOrExecuteAsync(giantKey, _ => ValueTask.FromResult(new CachedSearchPayload(giant, 777)), CancellationToken.None);
        Assert.Equal(777, giantRes.Total);

        var stats = cache.SnapshotStats();
        Assert.InRange(stats.EntryCount, 1, maxEntries);
        Assert.InRange(stats.RetainedBytes, 1, maxBytes);
        Assert.Equal(0, stats.InFlightCount);
        Assert.Equal(0, stats.ActiveWaiters);
        Assert.True(stats.Evictions > 0);
        Assert.True(stats.GenerationEvictions > 0);
    }

    [Fact]
    public async Task ServerLifecycleFencesHitsMissesInFlightWorkAndHttpCommitAcrossPublishEditTaxonomyWithdrawAndLeaseLoss()
    {
        var clock = new ControllableTimeProvider(BaseTime);
        var pages = new WebPages("<title>Test</title><!--fsus-public-content-->");
        var listCursor = new PublicListCursor(clock);
        var searchCursor = new PublicSearchCursor(clock);

        var articlesG1 = new[]
        {
            new Article(1, 1, 1001, 1, 1, "Cache Target Alpha", "Body content alpha beacon", BaseTime, BaseTime, BaseTime,
                "Summary alpha", new TaxonomyName(10, "CoreTag"), [new TaxonomyName(20, "RustLang")]),
            new Article(2, 1, 1002, 1, 1, "Cache Target Beta", "Body content beta beacon", BaseTime.AddMinutes(1), BaseTime.AddMinutes(1), BaseTime.AddMinutes(1),
                "Summary beta", new TaxonomyName(10, "CoreTag"), [new TaxonomyName(21, "DotNet")])
        };
        var articlesG2Edited = new[]
        {
            articlesG1[0] with { Revision = 2, Publication = 1003, RevisionNo = 2, PublicationNo = 2, Title = "Cache Target Alpha Edited", Body = "Body edited gamma beacon" },
            articlesG1[1]
        };
        var articlesG3TaxonomyRenamed = new[]
        {
            articlesG2Edited[0] with { Category = new TaxonomyName(10, "RenamedCategory"), Tags = [new TaxonomyName(20, "RenamedTag")] },
            articlesG2Edited[1] with { Category = new TaxonomyName(10, "RenamedCategory") }
        };
        var articlesG4Withdrawn = new[] { articlesG3TaxonomyRenamed[1] };

        var snap1 = new PublicSnapshot(1, articlesG1, new([], [], []), pages, listCursor, null, NullLogger.Instance, null, null, CancellationToken.None, searchCursor: searchCursor);
        var snap2 = new PublicSnapshot(2, articlesG2Edited, new([], [], []), pages, listCursor, snap1, NullLogger.Instance, null, null, CancellationToken.None, searchCursor: searchCursor);
        var snap3 = new PublicSnapshot(3, articlesG3TaxonomyRenamed, new([], [], []), pages, listCursor, snap2, NullLogger.Instance, null, null, CancellationToken.None, taxonomyEpoch: 2, searchCursor: searchCursor);
        var snap4 = new PublicSnapshot(4, articlesG4Withdrawn, new([], [], []), pages, listCursor, snap3, NullLogger.Instance, null, null, CancellationToken.None, taxonomyEpoch: 2, searchCursor: searchCursor);

        var projection = new PublicProjection();
        projection.Replace(snap1);

        var computeStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var computeRelease = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var holdNext = 0;

        using var searchCache = new PublicSearchCache(
            PublicSearchCache.DefaultOptions(),
            clock,
            beforeCompute: async ct =>
            {
                if (Interlocked.CompareExchange(ref holdNext, 0, 1) == 1)
                {
                    computeStarted.TrySetResult();
                    await computeRelease.Task.WaitAsync(ct);
                }
            });

        await using var unusedDb = NpgsqlDataSource.Create("Host=127.0.0.1;Port=1;Database=unused;Username=unused");
        var publications = new Publications(unusedDb, pages, NullLogger<Publications>.Instance, projection: projection, searchCache: searchCache);

        // 1. Prime cache hit on snap1
        var v2G1 = await searchCache.SearchV2Async(publications, snap1, "alpha beacon", ArticleSearchSort.Relevance, 10, null, CancellationToken.None);
        var decodedG1 = Wire.DecodePublicSearchResult(v2G1);
        Assert.Equal(snap1.Generation, decodedG1.Generation);
        Assert.Equal([1], decodedG1.Items.Select(static i => i.Id));

        // Repeat serves from cache
        var v2G1Hit = await searchCache.SearchV2Async(publications, snap1, "alpha beacon", ArticleSearchSort.Relevance, 10, null, CancellationToken.None);
        Assert.Same(v2G1, v2G1Hit);
        Assert.Equal(1, searchCache.SnapshotStats().Hits);

        // 2. Race on cached HIT when edit changes snapshot to snap2 (even before OnSnapshotChanged!)
        projection.Replace(snap2);
        await Assert.ThrowsAsync<PublicUnavailableException>(() =>
            searchCache.SearchV2Async(publications, snap1, "alpha beacon", ArticleSearchSort.Relevance, 10, null, CancellationToken.None).AsTask());

        // Notifying generation change evicts snap1 entries promptly
        searchCache.OnSnapshotChanged(snap2.Generation);
        Assert.Equal(0, searchCache.SnapshotStats().EntryCount);
        Assert.Equal(0, searchCache.SnapshotStats().RetainedBytes);

        // Query on snap2 reflects edited body ("gamma beacon")
        var v2G2 = await searchCache.SearchV2Async(publications, snap2, "gamma beacon", ArticleSearchSort.Relevance, 10, null, CancellationToken.None);
        Assert.Equal([1], Wire.DecodePublicSearchResult(v2G2).Items.Select(static i => i.Id));

        // 3. Taxonomy rename -> old taxonomy query no longer served after snap3 replaces snap2
        var oldTax = await searchCache.SearchV2Async(publications, snap2, "RustLang", ArticleSearchSort.Relevance, 10, null, CancellationToken.None);
        Assert.Equal([1], Wire.DecodePublicSearchResult(oldTax).Items.Select(static i => i.Id));
        projection.Replace(snap3);
        searchCache.OnSnapshotChanged(snap3.Generation);
        Assert.Equal(0, searchCache.SnapshotStats().EntryCount);
        var oldTaxAfterRename = await searchCache.SearchV2Async(publications, snap3, "RustLang", ArticleSearchSort.Relevance, 10, null, CancellationToken.None);
        Assert.Empty(Wire.DecodePublicSearchResult(oldTaxAfterRename).Items);
        var newTaxAfterRename = await searchCache.SearchV2Async(publications, snap3, "RenamedTag", ArticleSearchSort.Relevance, 10, null, CancellationToken.None);
        Assert.Equal([1], Wire.DecodePublicSearchResult(newTaxAfterRename).Items.Select(static i => i.Id));

        // 4. Race on IN-FLIGHT work during withdrawal (snap3 -> null -> snap4):
        // in-flight work is cancelled immediately and never cached or returned!
        Interlocked.Exchange(ref holdNext, 1);
        var inFlightTask = searchCache.SearchV2Async(publications, snap3, "Cache Target Alpha", ArticleSearchSort.Relevance, 10, null, CancellationToken.None).AsTask();
        await computeStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));

        projection.Replace(null);
        searchCache.OnSnapshotChanged(null);
        await Assert.ThrowsAsync<PublicUnavailableException>(() => inFlightTask);
        Assert.Equal(0, searchCache.SnapshotStats().EntryCount);
        Assert.Equal(0, searchCache.SnapshotStats().InFlightCount);

        projection.Replace(snap4);
        searchCache.OnSnapshotChanged(snap4.Generation);
        var afterWithdraw = await searchCache.SearchV2Async(publications, snap4, "Cache Target Alpha", ArticleSearchSort.Relevance, 10, null, CancellationToken.None);
        Assert.DoesNotContain(Wire.DecodePublicSearchResult(afterWithdraw).Items, item => item.Id == 1);

        // 5. Cursor freshness guard: advancing clock past MaxCursorReuseSeconds forces fresh cursor mint on same generation.
        var page1 = await searchCache.SearchV2Async(publications, snap4, "Cache Target", ArticleSearchSort.Relevance, 1, null, CancellationToken.None);
        var page1Repeat = await searchCache.SearchV2Async(publications, snap4, "Cache Target", ArticleSearchSort.Relevance, 1, null, CancellationToken.None);
        Assert.Same(page1, page1Repeat); // cursorless (1 article total -> HasMore=false) still hits even after 6 min
        var page2SetupSnap = new PublicSnapshot(5, articlesG1, new([], [], []), pages, listCursor, snap4, NullLogger.Instance, null, null, CancellationToken.None, searchCursor: searchCursor);
        projection.Replace(page2SetupSnap);
        searchCache.OnSnapshotChanged(page2SetupSnap.Generation);
        var withCursor1 = await searchCache.SearchV2Async(publications, page2SetupSnap, "Cache Target", ArticleSearchSort.Relevance, 1, null, CancellationToken.None);
        Assert.True(Wire.DecodePublicSearchResult(withCursor1).HasMore);
        var withCursorHit = await searchCache.SearchV2Async(publications, page2SetupSnap, "Cache Target", ArticleSearchSort.Relevance, 1, null, CancellationToken.None);
        Assert.Same(withCursor1, withCursorHit);
        clock.Advance(TimeSpan.FromSeconds(PublicSearchCache.MaxCursorReuseSeconds + 1));
        var withCursorRefreshed = await searchCache.SearchV2Async(publications, page2SetupSnap, "Cache Target", ArticleSearchSort.Relevance, 1, null, CancellationToken.None);
        Assert.NotSame(withCursor1, withCursorRefreshed);
        // Fresh cursor decodes cleanly even after 6 minutes elapsed
        var refreshedCursor = Wire.DecodePublicSearchResult(withCursorRefreshed).NextCursor;
        var page2 = await searchCache.SearchV2Async(publications, page2SetupSnap, "Cache Target", ArticleSearchSort.Relevance, 1, refreshedCursor, CancellationToken.None);
        Assert.Single(Wire.DecodePublicSearchResult(page2).Items);

        // 6. Real Kestrel HTTP check: CurrentSearchFrame strips generation header and returns 503 if snapshot changes before commit;
        // normal cached hits always send Cache-Control: no-store.
        var builder = WebApplication.CreateSlimBuilder();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Services.AddSingleton(searchCache);
        builder.Services.AddRateLimiter(options => options.AddImmediateConcurrency(CommandEndpoints.QueryPolicy, 32));
        await using var app = builder.Build();
        app.Use(async (ctx, next) =>
        {
            try { await next(); }
            catch (PublicUnavailableException)
            {
                await ServerHttp.Error(ctx, 503, "Unavailable").ExecuteAsync(ctx);
            }
        });
        app.UseRateLimiter();
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["FSUSBLOG_WIDE_SEARCH_CORPUS"] = "false" })
            .Build();
        PublicReadEndpoints.Map(app, SiteCapabilities.Resolve(config, Directory.GetCurrentDirectory()), publications, publicMediaEnabled: false);
        await app.StartAsync();
        try
        {
            using var client = new HttpClient { BaseAddress = new Uri(Assert.Single(app.Urls)) };
            using var okResp = await client.GetAsync($"{WireRoutes.PublicSearchV2}?q=Cache+Target&size=1");
            Assert.Equal(OK, okResp.StatusCode);
            Assert.True(okResp.Headers.CacheControl?.NoStore);
            Assert.Equal(page2SetupSnap.GenerationHeader, Assert.Single(okResp.Headers.GetValues(WireHeaders.SearchIndexGeneration)));

            // Simulate lease loss / withdrawal while snapshot is null -> HTTP 503 with no-store and no generation header!
            projection.Replace(null);
            searchCache.OnSnapshotChanged(null);
            using var unavailableResp = await client.GetAsync($"{WireRoutes.PublicSearchV2}?q=Cache+Target&size=1");
            Assert.Equal(ServiceUnavailable, unavailableResp.StatusCode);
            Assert.True(unavailableResp.Headers.CacheControl?.NoStore);
            Assert.False(unavailableResp.Headers.Contains(WireHeaders.SearchIndexGeneration));
        }
        finally
        {
            await app.StopAsync();
        }
    }

    private static SearchResultCacheKey MakeKey(
        long generation,
        string query,
        SearchCacheEndpointKind endpoint = SearchCacheEndpointKind.V2,
        int profileVersion = SearchScoringProfile.ProfileVersion,
        int analyzerVersion = SearchTextAnalyzer.Version,
        bool usesWide = false,
        ArticleSearchSort sort = ArticleSearchSort.Relevance,
        int page = 0,
        int size = 10,
        bool paginated = true,
        SearchCursorCacheKey cursor = default,
        int countThreshold = ArticleSearchIndex.MaxPaginatedResults,
        int workBudget = ArticleSearchIndex.DefaultWorkBudgetCandidates,
        string filterKey = "")
    {
        var plan = SearchQueryPlan.Build(query, CancellationToken.None);
        return new SearchResultCacheKey(
            endpoint,
            generation,
            profileVersion,
            analyzerVersion,
            usesWide,
            plan.BuildCanonicalCacheKey(),
            sort,
            page,
            size,
            paginated,
            cursor,
            countThreshold,
            workBudget,
            filterKey);
    }

    private static async Task WaitUntilAsync(Func<bool> condition, TimeSpan timeout)
    {
        var sw = Stopwatch.StartNew();
        while (!condition())
        {
            if (sw.Elapsed > timeout)
                Assert.Fail("Condition was not satisfied before timeout.");
            await Task.Delay(5);
        }
    }

    private sealed class ControllableTimeProvider(DateTimeOffset start) : TimeProvider
    {
        private readonly object _lock = new();
        private DateTimeOffset _now = start;
        private readonly List<ControllableTimer> _timers = [];

        public override DateTimeOffset GetUtcNow()
        {
            lock (_lock) return _now;
        }

        public void Advance(TimeSpan delta)
        {
            List<ControllableTimer> due = [];
            lock (_lock)
            {
                _now = _now.Add(delta);
                for (var i = _timers.Count - 1; i >= 0; i--)
                {
                    if (_timers[i].DueUtc <= _now)
                    {
                        due.Add(_timers[i]);
                        _timers.RemoveAt(i);
                    }
                }
            }
            foreach (var timer in due) timer.Fire();
        }

        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
        {
            var timer = new ControllableTimer(this, callback, state);
            timer.Change(dueTime, period);
            return timer;
        }

        private void Schedule(ControllableTimer timer, TimeSpan dueTime)
        {
            var fireNow = false;
            lock (_lock)
            {
                _timers.Remove(timer);
                if (dueTime == Timeout.InfiniteTimeSpan) return;
                if (dueTime <= TimeSpan.Zero)
                {
                    fireNow = true;
                }
                else
                {
                    timer.DueUtc = _now.Add(dueTime);
                    _timers.Add(timer);
                }
            }
            if (fireNow) timer.Fire();
        }

        private void Remove(ControllableTimer timer)
        {
            lock (_lock) _timers.Remove(timer);
        }

        private sealed class ControllableTimer(ControllableTimeProvider owner, TimerCallback callback, object? state) : ITimer
        {
            private int _disposed;
            internal DateTimeOffset DueUtc;

            public bool Change(TimeSpan dueTime, TimeSpan period)
            {
                if (Volatile.Read(ref _disposed) != 0) return false;
                owner.Schedule(this, dueTime);
                return true;
            }

            internal void Fire()
            {
                if (Volatile.Read(ref _disposed) != 0) return;
                callback(state);
            }

            public void Dispose()
            {
                if (Interlocked.Exchange(ref _disposed, 1) == 0) owner.Remove(this);
            }

            public ValueTask DisposeAsync()
            {
                Dispose();
                return ValueTask.CompletedTask;
            }
        }
    }
}
