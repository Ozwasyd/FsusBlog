namespace FsusBlog.V2.Contracts;

/// <summary>Public search endpoint representation kind included in cache identity (#50).</summary>
public enum SearchCacheEndpointKind : byte
{
    Fas4 = 0,
    V2 = 1
}

/// <summary>Canonical continuation cursor identity for cache keys (#50).</summary>
public readonly record struct SearchCursorCacheKey(
    bool HasCursor,
    SearchMatchTier Tier,
    long ScoreBits,
    long PublishedAtTicks,
    long CreatedAtTicks,
    int Id,
    int ReturnedSoFar)
{
    public static readonly SearchCursorCacheKey None = default;

    public static SearchCursorCacheKey From(SearchCursorPosition position, int returnedSoFar) => new(
        true,
        position.Tier,
        position.ScoreBits,
        position.PublishedAtTicks,
        position.CreatedAtTicks,
        position.Id,
        returnedSoFar);
}

/// <summary>
/// Immutable cache identity binding every input that can change public search response bytes or headers (#50).
/// Distinct generations, profiles, analyzer versions, canonical query plans, filters, sorts, pages/sizes,
/// pagination flags, budgets, or continuation cursors never share results.
/// </summary>
public sealed record SearchResultCacheKey(
    SearchCacheEndpointKind Endpoint,
    long Generation,
    int ProfileVersion,
    int AnalyzerVersion,
    bool UsesWideProfile,
    string CanonicalPlanKey,
    ArticleSearchSort Sort,
    int Page,
    int Size,
    bool Paginated,
    SearchCursorCacheKey Cursor,
    int CountThreshold,
    int WorkBudget,
    string FilterKey = "")
{
    internal long EstimatedKeyBytes =>
        160L + (long)CanonicalPlanKey.Length * sizeof(char) + (long)FilterKey.Length * sizeof(char);
}

/// <summary>Immutable cached search response frame and metadata (#50).</summary>
public readonly record struct CachedSearchPayload(
    byte[] Bytes,
    int Total,
    long ValidUntilUtcSeconds = long.MaxValue);

/// <summary>Strict resource and admission bounds for <see cref="SearchResultCache"/> (#50).</summary>
public sealed record SearchResultCacheOptions(
    int MaxEntries = 512,
    long MaxRetainedBytes = 8 * 1024 * 1024,
    long MaxEntryBytes = 2 * 1024 * 1024,
    int MaxInFlightKeys = 32,
    int MaxWaitersPerKey = 16,
    int MaxTotalWaiters = 32,
    int MaxRetainedGenerations = 1,
    TimeSpan? DefaultCallerDeadline = null)
{
    internal static readonly TimeSpan FallbackCallerDeadline = TimeSpan.FromSeconds(5);

    internal void Validate()
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(MaxEntries, 0);
        ArgumentOutOfRangeException.ThrowIfLessThan(MaxRetainedBytes, 0);
        ArgumentOutOfRangeException.ThrowIfLessThan(MaxEntryBytes, 0);
        ArgumentOutOfRangeException.ThrowIfLessThan(MaxInFlightKeys, 1);
        ArgumentOutOfRangeException.ThrowIfLessThan(MaxWaitersPerKey, 1);
        ArgumentOutOfRangeException.ThrowIfLessThan(MaxTotalWaiters, 1);
        ArgumentOutOfRangeException.ThrowIfLessThan(MaxRetainedGenerations, 1);
        if (DefaultCallerDeadline is { } d && d <= TimeSpan.Zero)
            throw new ArgumentOutOfRangeException(nameof(DefaultCallerDeadline), d, "Caller deadline must be positive.");
    }
}

/// <summary>Aggregate privacy-safe counters for public search caching and coalescing (#50). Never includes raw query text.</summary>
public readonly record struct SearchResultCacheStats(
    long Hits,
    long Misses,
    long CoalescedWaiters,
    long Executions,
    long Cancellations,
    long DeadlineExpirations,
    long GenerationRestarts,
    long RejectedWork,
    long Evictions,
    long GenerationEvictions,
    long RetainedBytes,
    int EntryCount,
    int InFlightCount,
    int ActiveWaiters);

/// <summary>Raised when in-flight key or waiter admission caps are reached without creating unbounded queues (#50).</summary>
public sealed class SearchWorkRejectedException(string message = "Public search work admission limit reached.") : Exception(message);

/// <summary>Raised when the target publication generation ceased to be current before a result could be committed (#50).</summary>
public sealed class SearchGenerationObsoleteException(string message = "Public search generation is no longer current.") : Exception(message);

/// <summary>
/// Byte-bounded LRU cache with bounded single-flight coalescing, independent per-caller cancellation/deadlines,
/// immediate abandoned-work cancellation, and prompt obsolete-generation retirement (#50).
/// </summary>
public sealed class SearchResultCache : IDisposable
{
    private const long EntryStructuralOverheadBytes = 96;

    private readonly SearchResultCacheOptions _options;
    private readonly TimeProvider _time;
    private readonly object _gate = new();
    private readonly Dictionary<SearchResultCacheKey, LinkedListNode<CacheEntry>> _entries = new();
    private readonly LinkedList<CacheEntry> _lru = new();
    private readonly Dictionary<long, int> _generationEntryCounts = new();
    private readonly LinkedList<long> _generationOrder = new();
    private readonly Dictionary<long, LinkedListNode<long>> _generationNodes = new();
    private readonly Dictionary<SearchResultCacheKey, InFlightSlot> _inFlight = new();
    private readonly CancellationTokenSource _disposeCts = new();
    private long _retainedBytes;
    private int _totalWaiters;
    private long? _pinnedGeneration;
    private bool _disposed;

    private long _hits;
    private long _misses;
    private long _coalescedWaiters;
    private long _executions;
    private long _cancellations;
    private long _deadlineExpirations;
    private long _generationRestarts;
    private long _rejectedWork;
    private long _evictions;
    private long _generationEvictions;

    public SearchResultCache(SearchResultCacheOptions? options = null, TimeProvider? timeProvider = null)
    {
        _options = options ?? new SearchResultCacheOptions();
        _options.Validate();
        _time = timeProvider ?? TimeProvider.System;
    }

    public SearchResultCacheStats SnapshotStats()
    {
        lock (_gate)
        {
            return new SearchResultCacheStats(
                Hits: Interlocked.Read(ref _hits),
                Misses: Interlocked.Read(ref _misses),
                CoalescedWaiters: Interlocked.Read(ref _coalescedWaiters),
                Executions: Interlocked.Read(ref _executions),
                Cancellations: Interlocked.Read(ref _cancellations),
                DeadlineExpirations: Interlocked.Read(ref _deadlineExpirations),
                GenerationRestarts: Interlocked.Read(ref _generationRestarts),
                RejectedWork: Interlocked.Read(ref _rejectedWork),
                Evictions: Interlocked.Read(ref _evictions),
                GenerationEvictions: Interlocked.Read(ref _generationEvictions),
                RetainedBytes: _retainedBytes,
                EntryCount: _entries.Count,
                InFlightCount: _inFlight.Count,
                ActiveWaiters: _totalWaiters);
        }
    }

    public void RecordGenerationRestart() => Interlocked.Increment(ref _generationRestarts);

    /// <summary>
    /// Synchronously executes or retrieves an immutable search payload under bounded single-flight coalescing.
    /// Every caller receives independent cancellation and deadline enforcement; abandoning the last waiter cancels shared work.
    /// </summary>
    public async ValueTask<CachedSearchPayload> GetOrExecuteAsync(
        SearchResultCacheKey key,
        Func<CancellationToken, ValueTask<CachedSearchPayload>> compute,
        CancellationToken callerCt,
        TimeSpan? callerDeadline = null,
        Func<bool>? isStillCurrent = null)
    {
        ArgumentNullException.ThrowIfNull(key);
        ArgumentNullException.ThrowIfNull(compute);
        if (callerDeadline is { } customDeadline && customDeadline <= TimeSpan.Zero)
            throw new ArgumentOutOfRangeException(nameof(callerDeadline), customDeadline, "Caller deadline must be positive.");

        callerCt.ThrowIfCancellationRequested();
        if (isStillCurrent is not null && !isStillCurrent())
            throw new SearchGenerationObsoleteException();

        var nowSeconds = _time.GetUtcNow().ToUnixTimeSeconds();
        InFlightSlot slot;
        bool isLeader;

        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);

            if (_pinnedGeneration is { } pinned && key.Generation != pinned)
                throw new SearchGenerationObsoleteException();

            if (_entries.TryGetValue(key, out var node))
            {
                if (node.Value.Payload.ValidUntilUtcSeconds <= nowSeconds)
                {
                    RemoveEntryLocked(node, isGenerationEviction: false);
                }
                else
                {
                    if (!ReferenceEquals(node, _lru.First))
                    {
                        _lru.Remove(node);
                        _lru.AddFirst(node);
                    }
                    Interlocked.Increment(ref _hits);
                    if (isStillCurrent is not null && !isStillCurrent())
                        throw new SearchGenerationObsoleteException();
                    return node.Value.Payload;
                }
            }

            Interlocked.Increment(ref _misses);

            if (_inFlight.TryGetValue(key, out var existing) && !existing.Completed && !existing.Abandoned && !existing.GenerationRetired)
            {
                if (existing.ActiveWaiters >= _options.MaxWaitersPerKey || _totalWaiters >= _options.MaxTotalWaiters)
                {
                    Interlocked.Increment(ref _rejectedWork);
                    throw new SearchWorkRejectedException();
                }
                existing.ActiveWaiters++;
                _totalWaiters++;
                Interlocked.Increment(ref _coalescedWaiters);
                slot = existing;
                isLeader = false;
            }
            else
            {
                if (_inFlight.Count >= _options.MaxInFlightKeys || _totalWaiters >= _options.MaxTotalWaiters)
                {
                    Interlocked.Increment(ref _rejectedWork);
                    throw new SearchWorkRejectedException();
                }
                var workCts = CancellationTokenSource.CreateLinkedTokenSource(_disposeCts.Token);
                slot = new InFlightSlot(key, workCts) { ActiveWaiters = 1 };
                _inFlight[key] = slot;
                _totalWaiters++;
                Interlocked.Increment(ref _executions);
                isLeader = true;
            }
        }

        var effectiveDeadline = callerDeadline ?? _options.DefaultCallerDeadline ?? SearchResultCacheOptions.FallbackCallerDeadline;
        var detached = false;

        if (isLeader)
        {
            var startTimestamp = _time.GetTimestamp();
            CancellationTokenRegistration leaderCancelReg = default;
            if (callerCt.CanBeCanceled)
            {
                leaderCancelReg = callerCt.UnsafeRegister(static state =>
                {
                    var (self, s) = ((SearchResultCache, InFlightSlot))state!;
                    self.CancelLeaderInlineWaiter(s);
                }, (this, slot));
            }

            ValueTask<CachedSearchPayload> workTask;
            try
            {
                slot.WorkToken.ThrowIfCancellationRequested();
                workTask = compute(slot.WorkToken);
            }
            catch (Exception ex)
            {
                leaderCancelReg.Dispose();
                CompleteSlotException(slot, ex);
                if (!slot.ConsumeLeaderInlineDetach())
                    DetachWaiter(slot, ref detached, callerInitiatedCancel: callerCt.IsCancellationRequested);
                else
                    detached = true;
                if (callerCt.IsCancellationRequested)
                    throw new OperationCanceledException(callerCt);
                if (ex is OperationCanceledException)
                {
                    if (_disposed) throw new ObjectDisposedException(nameof(SearchResultCache));
                    if (slot.GenerationRetired) throw new SearchGenerationObsoleteException();
                }
                throw;
            }

            if (workTask.IsCompleted)
            {
                leaderCancelReg.Dispose();
                try
                {
                    var value = workTask.GetAwaiter().GetResult();
                    CompleteSlotSuccess(slot, value, isStillCurrent);
                    var leaderCancelled = slot.ConsumeLeaderInlineDetach();
                    if (!leaderCancelled)
                        DetachWaiter(slot, ref detached, callerInitiatedCancel: false);
                    else
                        detached = true;

                    if (callerCt.IsCancellationRequested)
                        throw new OperationCanceledException(callerCt);
                    if (_time.GetElapsedTime(startTimestamp) > effectiveDeadline)
                    {
                        Interlocked.Increment(ref _deadlineExpirations);
                        throw new TimeoutException("Public search request exceeded its deadline.");
                    }
                    if (_disposed)
                        throw new ObjectDisposedException(nameof(SearchResultCache));
                    if (slot.GenerationRetired || (isStillCurrent is not null && !isStillCurrent()))
                        throw new SearchGenerationObsoleteException();
                    return value;
                }
                catch (Exception ex) when (ex is not TimeoutException && ex is not ObjectDisposedException && ex is not SearchGenerationObsoleteException && !(ex is OperationCanceledException && callerCt.IsCancellationRequested))
                {
                    CompleteSlotException(slot, ex);
                    if (!slot.ConsumeLeaderInlineDetach())
                        DetachWaiter(slot, ref detached, callerInitiatedCancel: callerCt.IsCancellationRequested);
                    else
                        detached = true;
                    if (callerCt.IsCancellationRequested)
                        throw new OperationCanceledException(callerCt);
                    if (ex is OperationCanceledException)
                    {
                        if (_disposed) throw new ObjectDisposedException(nameof(SearchResultCache));
                        if (slot.GenerationRetired) throw new SearchGenerationObsoleteException();
                    }
                    throw;
                }
            }

            // Async / contended path: hand off completion independently so leader cancellation wakes immediately
            // without interrupting remaining coalesced waiters.
            leaderCancelReg.Dispose();
            if (slot.ConsumeLeaderInlineDetach())
            {
                detached = true;
                _ = ObserveAsyncSlotAsync(slot, workTask, isStillCurrent);
                throw new OperationCanceledException(callerCt);
            }
            _ = ObserveAsyncSlotAsync(slot, workTask, isStillCurrent);
        }

        using var deadlineCts = new CancellationTokenSource(effectiveDeadline, _time);
        using var linkedWaitCts = callerCt.CanBeCanceled
            ? CancellationTokenSource.CreateLinkedTokenSource(callerCt, deadlineCts.Token)
            : null;
        var waitToken = linkedWaitCts?.Token ?? deadlineCts.Token;

        try
        {
            var payload = await slot.Completion.Task.WaitAsync(waitToken).ConfigureAwait(false);
            if (isStillCurrent is not null && !isStillCurrent())
                throw new SearchGenerationObsoleteException();
            return payload;
        }
        catch (OperationCanceledException) when (waitToken.IsCancellationRequested)
        {
            DetachWaiter(slot, ref detached, callerInitiatedCancel: true);
            if (deadlineCts.IsCancellationRequested && !callerCt.IsCancellationRequested)
            {
                Interlocked.Increment(ref _deadlineExpirations);
                throw new TimeoutException("Public search request exceeded its deadline.");
            }
            throw new OperationCanceledException(callerCt);
        }
        finally
        {
            DetachWaiter(slot, ref detached, callerInitiatedCancel: false);
        }
    }

    /// <summary>
    /// Promptly evicts all cached entries from generations other than <paramref name="activeGeneration"/>
    /// (or all entries if <paramref name="activeGeneration"/> is null) and cancels obsolete in-flight computations.
    /// </summary>
    public void RetireExceptGeneration(long? activeGeneration)
    {
        List<InFlightSlot>? toCancel = null;
        lock (_gate)
        {
            _pinnedGeneration = activeGeneration;
            if (_entries.Count > 0)
            {
                var node = _lru.First;
                while (node is not null)
                {
                    var next = node.Next;
                    if (activeGeneration is null || node.Value.Key.Generation != activeGeneration.Value)
                        RemoveEntryLocked(node, isGenerationEviction: true);
                    node = next;
                }
            }

            if (_inFlight.Count > 0)
            {
                foreach (var entry in _inFlight)
                {
                    if (activeGeneration is null || entry.Key.Generation != activeGeneration.Value)
                    {
                        entry.Value.GenerationRetired = true;
                        (toCancel ??= []).Add(entry.Value);
                    }
                }
                if (toCancel is not null)
                {
                    foreach (var obsolete in toCancel)
                        _inFlight.Remove(obsolete.Key);
                }
            }
        }

        if (toCancel is not null)
        {
            foreach (var obsolete in toCancel)
                obsolete.CancelWork();
        }
    }

    public void Clear() => RetireExceptGeneration(null);

    public void Dispose()
    {
        List<InFlightSlot>? active = null;
        lock (_gate)
        {
            if (_disposed) return;
            _disposed = true;
            _entries.Clear();
            _lru.Clear();
            _generationEntryCounts.Clear();
            _generationOrder.Clear();
            _generationNodes.Clear();
            _retainedBytes = 0;

            if (_inFlight.Count > 0)
            {
                active = new List<InFlightSlot>(_inFlight.Values);
                _inFlight.Clear();
            }
        }

        _disposeCts.Cancel();
        if (active is not null)
        {
            foreach (var slot in active)
                slot.CancelWork();
        }
        _disposeCts.Dispose();
    }

    private void DetachWaiter(InFlightSlot slot, ref bool detached, bool callerInitiatedCancel)
    {
        if (detached) return;
        detached = true;
        var cancelWork = false;
        lock (_gate)
        {
            slot.ActiveWaiters--;
            _totalWaiters--;
            if (slot.ActiveWaiters == 0 && !slot.Completed && !slot.Abandoned)
            {
                slot.Abandoned = true;
                if (_inFlight.TryGetValue(slot.Key, out var current) && ReferenceEquals(current, slot))
                    _inFlight.Remove(slot.Key);
                cancelWork = true;
                if (callerInitiatedCancel)
                    Interlocked.Increment(ref _cancellations);
            }
        }

        if (cancelWork)
            slot.CancelWork();
    }

    private void CancelLeaderInlineWaiter(InFlightSlot slot)
    {
        var cancelWork = false;
        lock (_gate)
        {
            if (slot.LeaderInlineDetached) return;
            slot.LeaderInlineDetached = true;
            slot.ActiveWaiters--;
            _totalWaiters--;
            if (slot.ActiveWaiters == 0 && !slot.Completed && !slot.Abandoned)
            {
                slot.Abandoned = true;
                if (_inFlight.TryGetValue(slot.Key, out var current) && ReferenceEquals(current, slot))
                    _inFlight.Remove(slot.Key);
                cancelWork = true;
                Interlocked.Increment(ref _cancellations);
            }
        }
        if (cancelWork)
            slot.CancelWork();
    }

    private async Task ObserveAsyncSlotAsync(
        InFlightSlot slot,
        ValueTask<CachedSearchPayload> workTask,
        Func<bool>? isStillCurrent)
    {
        try
        {
            var value = await workTask.ConfigureAwait(false);
            slot.WorkToken.ThrowIfCancellationRequested();
            CompleteSlotSuccess(slot, value, isStillCurrent);
        }
        catch (Exception ex)
        {
            CompleteSlotException(slot, ex);
        }
    }

    private void CompleteSlotSuccess(InFlightSlot slot, CachedSearchPayload value, Func<bool>? isStillCurrent)
    {
        try
        {
            var stillCurrent = isStillCurrent is null || isStillCurrent();
            bool retiredOrDisposed;
            lock (_gate)
            {
                slot.Completed = true;
                if (_inFlight.TryGetValue(slot.Key, out var current) && ReferenceEquals(current, slot))
                    _inFlight.Remove(slot.Key);

                retiredOrDisposed = _disposed || slot.GenerationRetired || !stillCurrent ||
                    (_pinnedGeneration is { } pinned && slot.Key.Generation != pinned);
                if (!retiredOrDisposed && !slot.Abandoned)
                {
                    StoreLocked(slot.Key, value);
                }
            }

            if (retiredOrDisposed)
            {
                if (_disposed)
                    slot.Completion.TrySetException(new ObjectDisposedException(nameof(SearchResultCache)));
                else
                    slot.Completion.TrySetException(new SearchGenerationObsoleteException());
                return;
            }

            slot.Completion.TrySetResult(value);
        }
        finally
        {
            slot.DisposeWork();
        }
    }

    private void CompleteSlotException(InFlightSlot slot, Exception ex)
    {
        try
        {
            bool disposed;
            bool retired;
            lock (_gate)
            {
                slot.Completed = true;
                if (_inFlight.TryGetValue(slot.Key, out var current) && ReferenceEquals(current, slot))
                    _inFlight.Remove(slot.Key);
                disposed = _disposed;
                retired = slot.GenerationRetired;
            }

            if (ex is OperationCanceledException oce)
            {
                if (disposed)
                    slot.Completion.TrySetException(new ObjectDisposedException(nameof(SearchResultCache)));
                else if (retired)
                    slot.Completion.TrySetException(new SearchGenerationObsoleteException());
                else
                    slot.Completion.TrySetCanceled(oce.CancellationToken);
            }
            else
            {
                // Never cache transient or permanent failures.
                slot.Completion.TrySetException(ex);
            }
        }
        finally
        {
            slot.DisposeWork();
        }
    }

    private void StoreLocked(SearchResultCacheKey key, CachedSearchPayload payload)
    {
        if (_options.MaxEntries == 0 || _options.MaxRetainedBytes == 0) return;

        var entryBytes = EntryStructuralOverheadBytes + key.EstimatedKeyBytes + payload.Bytes.Length;
        if (entryBytes > _options.MaxEntryBytes || entryBytes > _options.MaxRetainedBytes)
            return;

        if (_entries.TryGetValue(key, out var existing))
            RemoveEntryLocked(existing, isGenerationEviction: false);

        // Enforce MaxRetainedGenerations before inserting entries for a newly observed generation.
        if (!_generationEntryCounts.ContainsKey(key.Generation))
        {
            while (_generationOrder.Count >= _options.MaxRetainedGenerations && _generationOrder.First is { } oldestGenNode)
            {
                var victimGen = oldestGenNode.Value;
                var node = _lru.First;
                while (node is not null)
                {
                    var next = node.Next;
                    if (node.Value.Key.Generation == victimGen)
                        RemoveEntryLocked(node, isGenerationEviction: true);
                    node = next;
                }
            }
        }

        while ((_entries.Count >= _options.MaxEntries || _retainedBytes + entryBytes > _options.MaxRetainedBytes) &&
               _lru.Last is { } victim)
        {
            RemoveEntryLocked(victim, isGenerationEviction: false);
        }

        if (_entries.Count >= _options.MaxEntries || _retainedBytes + entryBytes > _options.MaxRetainedBytes)
            return;

        var added = _lru.AddFirst(new CacheEntry(key, payload, entryBytes));
        _entries.Add(key, added);
        _retainedBytes += entryBytes;

        if (_generationEntryCounts.TryGetValue(key.Generation, out var count))
        {
            _generationEntryCounts[key.Generation] = count + 1;
        }
        else
        {
            _generationEntryCounts[key.Generation] = 1;
            var genNode = _generationOrder.AddLast(key.Generation);
            _generationNodes[key.Generation] = genNode;
        }
    }

    private void RemoveEntryLocked(LinkedListNode<CacheEntry> node, bool isGenerationEviction)
    {
        var entry = node.Value;
        _entries.Remove(entry.Key);
        _lru.Remove(node);
        _retainedBytes -= entry.SizeBytes;
        Interlocked.Increment(ref _evictions);
        if (isGenerationEviction)
            Interlocked.Increment(ref _generationEvictions);

        var gen = entry.Key.Generation;
        if (_generationEntryCounts.TryGetValue(gen, out var count))
        {
            if (count <= 1)
            {
                _generationEntryCounts.Remove(gen);
                if (_generationNodes.Remove(gen, out var genNode))
                    _generationOrder.Remove(genNode);
            }
            else
            {
                _generationEntryCounts[gen] = count - 1;
            }
        }
    }

    private sealed record CacheEntry(SearchResultCacheKey Key, CachedSearchPayload Payload, long SizeBytes);

    private sealed class InFlightSlot
    {
        private readonly object _ctsGate = new();
        private readonly CancellationTokenSource _workCts;
        private bool _ctsDisposed;

        internal InFlightSlot(SearchResultCacheKey key, CancellationTokenSource workCts)
        {
            Key = key;
            _workCts = workCts;
            WorkToken = workCts.Token;
            Completion = new TaskCompletionSource<CachedSearchPayload>(TaskCreationOptions.RunContinuationsAsynchronously);
        }

        internal SearchResultCacheKey Key { get; }
        internal CancellationToken WorkToken { get; }
        internal TaskCompletionSource<CachedSearchPayload> Completion { get; }
        internal int ActiveWaiters;
        internal bool Completed;
        internal bool Abandoned;
        internal bool GenerationRetired;
        internal volatile bool LeaderInlineDetached;

        internal bool ConsumeLeaderInlineDetach()
        {
            return LeaderInlineDetached;
        }

        internal void CancelWork()
        {
            lock (_ctsGate)
            {
                if (!_ctsDisposed) _workCts.Cancel();
            }
        }

        internal void DisposeWork()
        {
            lock (_ctsGate)
            {
                if (_ctsDisposed) return;
                _ctsDisposed = true;
                _workCts.Dispose();
            }
        }
    }
}
