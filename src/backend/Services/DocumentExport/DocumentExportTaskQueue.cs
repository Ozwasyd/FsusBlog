namespace FsusBlog.Server.Services.DocumentExport;

internal sealed record DocumentExportQueueLimits(
    int MaxTasks,
    int MaxConcurrency,
    long MaxFrozenBytes,
    TimeSpan RetentionTtl,
    int MaxAttempts = 3);

internal sealed record DocumentExportQueueSnapshot(
    DocumentExportTask Task,
    DateTimeOffset CreatedAtUtc,
    DateTimeOffset ExpiresAtUtc,
    bool ExecutionOutstanding,
    DocumentExportProviderResultStatus? StopOutcome,
    DocumentExportAttemptSnapshot CurrentAttempt);

internal sealed record DocumentExportAttemptSnapshot(
    Guid AttemptId,
    int Number,
    string RequestId,
    string TaskDigest,
    DocumentExportTaskStatus Status,
    DateTimeOffset CreatedAtUtc,
    DateTimeOffset? StartedAtUtc,
    DateTimeOffset? StoppedAtUtc,
    bool CancellationRequested,
    bool CleanupComplete,
    DocumentExportProviderResultStatus? StopOutcome,
    string ContentDigest);

internal sealed class DocumentExportTaskClaim
{
    internal DocumentExportTaskClaim(string taskId, CancellationToken cancellationToken)
    {
        TaskId = taskId;
        CancellationToken = cancellationToken;
    }

    internal string TaskId
    {
        get;
    }
    internal CancellationToken CancellationToken
    {
        get;
    }
}

/// <summary>
/// Bounded scheduling of already admitted, canonical frozen inputs. This internal
/// component has no public admission, persistence, renderer, or output authority.
/// Stop acknowledgements must come from the owning executor after actual cleanup;
/// a cancellation request alone never releases an execution slot.
/// </summary>
internal sealed class DocumentExportTaskQueue
{
    private readonly object _gate = new();
    private readonly TimeProvider _timeProvider;
    private readonly DocumentExportQueueLimits _limits;
    private readonly Dictionary<string, Entry> _entries = new(StringComparer.Ordinal);
    private readonly Dictionary<(long UserId, long SiteId, string Key), Entry> _idempotency = new();
    private readonly LinkedList<Entry> _pending = new();
    private long _frozenBytes;
    private int _executions;

    internal DocumentExportTaskQueue(TimeProvider timeProvider, DocumentExportQueueLimits limits)
    {
        ArgumentNullException.ThrowIfNull(timeProvider);
        ArgumentNullException.ThrowIfNull(limits);
        if (limits.MaxTasks is < 1 or > 1000
            || limits.MaxConcurrency < 1 || limits.MaxConcurrency > limits.MaxTasks
            || limits.MaxConcurrency > DocumentExportContractCatalog.Providers.Min(provider => provider.Budgets.MaxConcurrency)
            || limits.MaxAttempts is < 1 or > 3
            || limits.MaxFrozenBytes is < 1 or > 1073741824
            || limits.RetentionTtl <= TimeSpan.Zero
            || limits.RetentionTtl > DocumentExportContractCatalog.Providers.Min(provider => provider.Delivery.RetentionTtl))
        {
            throw new ArgumentOutOfRangeException(nameof(limits), "Export queue budgets are outside the catalog policy.");
        }
        _timeProvider = timeProvider;
        _limits = limits;
    }

    internal async Task<DocumentExportQueueSnapshot> EnqueueAsync(
        DocumentExportTask task,
        DocumentExportFrozenInput input)
    {
        DocumentExportContractValidator.Validate(task, input);
        DocumentExportProviderContract provider = DocumentExportContractCatalog.RequireProvider(task.FormatId);
        if (task.Status != DocumentExportTaskStatus.Queued || !provider.ImplementationAvailable)
        {
            throw new InvalidOperationException("Export admission requires a queued task and an implemented exact provider.");
        }

        long rawBytes = input.MarkdownUtf8.Length;
        foreach (DocumentExportAsset asset in input.Assets)
        {
            rawBytes = checked(rawBytes + asset.Bytes.Length);
        }
        if (rawBytes > _limits.MaxFrozenBytes || rawBytes > provider.Budgets.MaxInputBytes)
        {
            throw new InvalidOperationException("Export frozen input exceeds its byte budget.");
        }
        DocumentExportFrozenInput ownedInput = DocumentExportContractValidator.Seal(input);
        DocumentExportContractValidator.Validate(task, ownedInput);
        long retainedBytes = DocumentExportDigest.Serialize(ownedInput).LongLength;
        if (retainedBytes > _limits.MaxFrozenBytes || retainedBytes > provider.Budgets.MaxInputBytes)
        {
            throw new InvalidOperationException("Export frozen input exceeds its byte budget.");
        }
        string identity = DocumentExportDigest.Compute(task with
        {
            TaskId = string.Empty,
            RequestId = string.Empty,
            ContentDigest = string.Empty
        });

        await ExpireAsync();
        lock (_gate)
        {
            var key = (task.UserId, task.SiteId, task.IdempotencyKey);
            if (_idempotency.TryGetValue(key, out Entry? existing))
            {
                if (!string.Equals(identity, existing.Identity, StringComparison.Ordinal))
                {
                    throw new InvalidOperationException("Export idempotency identity mismatch.");
                }
                return Snapshot(existing);
            }
            if (_entries.ContainsKey(task.TaskId))
            {
                throw new InvalidOperationException("Export task identity is unavailable.");
            }
            if (_entries.Count >= _limits.MaxTasks || retainedBytes > _limits.MaxFrozenBytes - _frozenBytes)
            {
                throw new InvalidOperationException("Export queue capacity is exhausted.");
            }
            DateTimeOffset createdAt = _timeProvider.GetUtcNow();
            var entry = new Entry(task, ownedInput, identity, retainedBytes, createdAt, createdAt + _limits.RetentionTtl);
            entry.PendingNode = _pending.AddLast(entry);
            _entries.Add(task.TaskId, entry);
            _idempotency.Add(key, entry);
            _frozenBytes += retainedBytes;
            return Snapshot(entry);
        }
    }

    internal async Task<DocumentExportQueueSnapshot> ReadAsync(long userId, long siteId, string taskId)
    {
        await ExpireAsync();
        lock (_gate)
        {
            return Snapshot(RequireOwned(userId, siteId, taskId));
        }
    }

    internal async Task<DocumentExportQueueSnapshot> RetryAsync(
        long userId, long siteId, string taskId, string requestId)
    {
        DocumentExportContractValidator.RequireIdentifier(requestId, nameof(requestId));
        await ExpireAsync();
        lock (_gate)
        {
            Entry entry = RequireOwned(userId, siteId, taskId);
            if (entry.Attempts.Any(attempt => string.Equals(attempt.Task.RequestId, requestId, StringComparison.Ordinal)))
            {
                return Snapshot(entry);
            }
            if (entry.Claim is not null || !entry.Current.CleanupComplete
                || entry.Current.Task.Status is not (DocumentExportTaskStatus.Failed or DocumentExportTaskStatus.Blocked)
                || entry.Attempts.Count >= _limits.MaxAttempts)
            {
                throw new InvalidOperationException("Export attempt is not eligible for retry.");
            }
            DocumentExportProviderContract provider = DocumentExportContractCatalog.RequireProvider(entry.Task.FormatId);
            if (!provider.ImplementationAvailable || provider.ProviderId != entry.Task.ProviderId
                || provider.ProviderVersion != entry.Task.ProviderVersion)
            {
                throw new InvalidOperationException("Export retry provider identity is unavailable.");
            }
            DocumentExportTask retry = DocumentExportContractValidator.Seal(entry.Task with
            {
                RequestId = requestId,
                Status = DocumentExportTaskStatus.Queued
            });
            DocumentExportContractValidator.Validate(retry, entry.Input);
            entry.Attempts.Add(new Attempt(retry, entry.Attempts.Count + 1, _timeProvider.GetUtcNow()));
            entry.PendingNode = _pending.AddLast(entry);
            return Snapshot(entry);
        }
    }

    internal async Task<IReadOnlyList<DocumentExportAttemptSnapshot>> ReadAttemptsAsync(long userId, long siteId, string taskId)
    {
        await ExpireAsync();
        lock (_gate)
        {
            return Array.AsReadOnly(RequireOwned(userId, siteId, taskId).Attempts.Select(AttemptSnapshot).ToArray());
        }
    }

    internal async Task<DocumentExportTaskClaim?> TryClaimAsync()
    {
        await ExpireAsync();
        lock (_gate)
        {
            if (_executions >= _limits.MaxConcurrency || _pending.First is null)
            {
                return null;
            }
            Entry entry = _pending.First.Value;
            RemovePending(entry);
            entry.Abort = new CancellationTokenSource();
            entry.Claim = new DocumentExportTaskClaim(entry.Task.TaskId, entry.Abort.Token);
            SetStatus(entry, DocumentExportTaskStatus.Preparing);
            _executions++;
            return entry.Claim;
        }
    }

    internal async Task<(DocumentExportTask Task, DocumentExportFrozenInput Input)> StartAsync(DocumentExportTaskClaim claim)
    {
        await ExpireAsync();
        lock (_gate)
        {
            Entry entry = RequireClaim(claim);
            if (entry.Current.Task.Status != DocumentExportTaskStatus.Preparing)
            {
                throw new InvalidOperationException("Export claim cannot start in its current state.");
            }
            SetStatus(entry, DocumentExportTaskStatus.Running);
            // Never expose the queue's immutable-array backing storage to a worker.
            return (entry.Current.Task, DocumentExportContractValidator.Seal(entry.Input));
        }
    }

    internal async Task<DocumentExportQueueSnapshot> CancelAsync(long userId, long siteId, string taskId)
    {
        await ExpireAsync();
        CancellationTokenSource? abort = null;
        lock (_gate)
        {
            Entry entry = RequireOwned(userId, siteId, taskId);
            if (entry.Current.Task.Status == DocumentExportTaskStatus.Queued)
            {
                RemovePending(entry);
                SetStatus(entry, DocumentExportTaskStatus.Cancelled);
                entry.Current.CancellationRequested = true;
                entry.Current.CleanupComplete = true;
                entry.Current.StoppedAtUtc = _timeProvider.GetUtcNow();
            }
            else if (entry.Current.Task.Status is DocumentExportTaskStatus.Preparing or DocumentExportTaskStatus.Running)
            {
                SetStatus(entry, DocumentExportTaskStatus.Cancelling);
                entry.Current.CancellationRequested = true;
                abort = entry.Abort;
            }
        }
        if (abort is not null)
        {
            // Execute host callbacks outside the scheduling lock; failure leaves
            // the claim and its cleanup obligation outstanding.
            await abort.CancelAsync();
        }
        lock (_gate)
        {
            return Snapshot(RequireOwned(userId, siteId, taskId));
        }
    }

    internal async Task<DocumentExportQueueSnapshot> AcknowledgeStoppedAsync(
        DocumentExportTaskClaim claim,
        DocumentExportProviderResultStatus outcome,
        bool cleanupComplete)
    {
        if (outcome is not (DocumentExportProviderResultStatus.Failed
            or DocumentExportProviderResultStatus.Blocked
            or DocumentExportProviderResultStatus.Cancelled))
        {
            throw new ArgumentException("Only stopped unsuccessful attempts are admitted here.", nameof(outcome));
        }
        await ExpireAsync();
        lock (_gate)
        {
            Entry entry = RequireStopClaim(claim, out Attempt attempt);
            if (attempt.Claim is null)
            {
                if (!cleanupComplete || attempt.StopOutcome != outcome)
                {
                    throw new InvalidOperationException("Export completed acknowledgement cannot be changed.");
                }
                return Snapshot(entry);
            }
            if (outcome == DocumentExportProviderResultStatus.Cancelled
                && entry.Current.Task.Status is not (DocumentExportTaskStatus.Cancelling
                    or DocumentExportTaskStatus.Expired
                    or DocumentExportTaskStatus.CleanupRequired))
            {
                throw new InvalidOperationException("Export cancellation was not requested.");
            }
            if (entry.Current.StopOutcome is not null && entry.Current.StopOutcome != outcome)
            {
                throw new InvalidOperationException("Export first stop outcome cannot be overwritten.");
            }
            entry.Current.StopOutcome ??= outcome;
            entry.Current.StoppedAtUtc ??= _timeProvider.GetUtcNow();
            if (!cleanupComplete)
            {
                if (entry.Current.Task.Status != DocumentExportTaskStatus.Expired)
                {
                    SetStatus(entry, DocumentExportTaskStatus.CleanupRequired);
                }
                return Snapshot(entry);
            }

            DocumentExportTaskStatus status = entry.Current.Task.Status == DocumentExportTaskStatus.Expired
                ? DocumentExportTaskStatus.Expired
                : outcome switch
                {
                    DocumentExportProviderResultStatus.Failed => DocumentExportTaskStatus.Failed,
                    DocumentExportProviderResultStatus.Blocked => DocumentExportTaskStatus.Blocked,
                    _ => DocumentExportTaskStatus.Cancelled
                };
            SetStatus(entry, status);
            entry.Current.CleanupComplete = true;
            entry.Current.CompletedClaim = entry.Claim;
            entry.Claim = null;
            // Keep the source alive until all in-flight cancellation callbacks
            // complete. No dispose/cancel race is introduced by an acknowledgement.
            entry.Abort = null;
            _executions--;
            return Snapshot(entry);
        }
    }

    internal async Task ExpireAsync()
    {
        var aborts = new List<CancellationTokenSource>();
        lock (_gate)
        {
            DateTimeOffset now = _timeProvider.GetUtcNow();
            foreach (Entry entry in _entries.Values.ToArray())
            {
                if (now < entry.ExpiresAtUtc)
                {
                    continue;
                }
                RemovePending(entry);
                if (entry.Claim is not null)
                {
                    if (entry.Current.Task.Status != DocumentExportTaskStatus.Expired)
                    {
                        SetStatus(entry, DocumentExportTaskStatus.Expired);
                        entry.Current.CancellationRequested = true;
                        aborts.Add(entry.Abort!);
                    }
                    continue;
                }
                _entries.Remove(entry.Task.TaskId);
                _idempotency.Remove((entry.Task.UserId, entry.Task.SiteId, entry.Task.IdempotencyKey));
                _frozenBytes -= entry.RetainedBytes;
            }
        }
        // A faulty host callback must not suppress aborts for the other tasks.
        await Task.WhenAll(aborts.Select(abort => abort.CancelAsync()));
    }

    private Entry RequireOwned(long userId, long siteId, string taskId)
    {
        if (taskId is null || !_entries.TryGetValue(taskId, out Entry? entry)
            || userId <= 0 || siteId <= 0 || entry.Task.UserId != userId || entry.Task.SiteId != siteId)
        {
            throw new KeyNotFoundException("Export task is unavailable.");
        }
        return entry;
    }

    private Entry RequireClaim(DocumentExportTaskClaim claim)
    {
        ArgumentNullException.ThrowIfNull(claim);
        if (!_entries.TryGetValue(claim.TaskId, out Entry? entry) || !ReferenceEquals(entry.Claim, claim))
        {
            throw new InvalidOperationException("Export claim is stale or foreign.");
        }
        return entry;
    }

    private Entry RequireStopClaim(DocumentExportTaskClaim claim, out Attempt attempt)
    {
        ArgumentNullException.ThrowIfNull(claim);
        if (_entries.TryGetValue(claim.TaskId, out Entry? entry))
        {
            Attempt? matched = entry.Attempts.SingleOrDefault(candidate =>
                ReferenceEquals(candidate.Claim, claim) || ReferenceEquals(candidate.CompletedClaim, claim));
            if (matched is not null)
            {
                attempt = matched;
                return entry;
            }
        }
        throw new InvalidOperationException("Export claim is stale or foreign.");
    }

    private void RemovePending(Entry entry)
    {
        if (entry.PendingNode is not null)
        {
            _pending.Remove(entry.PendingNode);
            entry.PendingNode = null;
        }
    }

    private void SetStatus(Entry entry, DocumentExportTaskStatus status)
    {
        entry.Current.Task = DocumentExportContractValidator.Seal(entry.Current.Task with
        {
            Status = status
        });
        if (status == DocumentExportTaskStatus.Running)
        {
            entry.Current.StartedAtUtc ??= _timeProvider.GetUtcNow();
        }
        // The first terminal task/attempt is immutable. A retry owns a new
        // attempt projection and cannot make the original failure a success.
        if (!IsTerminal(entry.Task.Status))
        {
            entry.Task = entry.Current.Task;
        }
    }

    private static bool IsTerminal(DocumentExportTaskStatus status)
        => status is DocumentExportTaskStatus.Failed or DocumentExportTaskStatus.Blocked
            or DocumentExportTaskStatus.Cancelled or DocumentExportTaskStatus.Expired
            or DocumentExportTaskStatus.Succeeded;

    private static DocumentExportAttemptSnapshot AttemptSnapshot(Attempt attempt)
    {
        var unsigned = new DocumentExportAttemptSnapshot(
            attempt.Id, attempt.Number, attempt.Task.RequestId, attempt.Task.ContentDigest,
            attempt.Task.Status, attempt.CreatedAtUtc, attempt.StartedAtUtc, attempt.StoppedAtUtc,
            attempt.CancellationRequested, attempt.CleanupComplete, attempt.StopOutcome, string.Empty);
        return unsigned with
        {
            ContentDigest = DocumentExportDigest.Compute(unsigned)
        };
    }

    private static DocumentExportQueueSnapshot Snapshot(Entry entry)
        => new(entry.Task, entry.CreatedAtUtc, entry.ExpiresAtUtc, entry.Claim is not null,
            entry.Attempts[0].StopOutcome, AttemptSnapshot(entry.Current));

    private sealed class Attempt(DocumentExportTask task, int number, DateTimeOffset createdAtUtc)
    {
        internal Guid Id { get; } = Guid.NewGuid();
        internal int Number { get; } = number;
        internal DateTimeOffset CreatedAtUtc { get; } = createdAtUtc;
        internal DocumentExportTask Task { get; set; } = task;
        internal DateTimeOffset? StartedAtUtc
        {
            get; set;
        }
        internal DateTimeOffset? StoppedAtUtc
        {
            get; set;
        }
        internal bool CancellationRequested
        {
            get; set;
        }
        internal bool CleanupComplete
        {
            get; set;
        }
        internal DocumentExportTaskClaim? Claim
        {
            get; set;
        }
        internal DocumentExportTaskClaim? CompletedClaim
        {
            get; set;
        }
        internal CancellationTokenSource? Abort
        {
            get; set;
        }
        internal DocumentExportProviderResultStatus? StopOutcome
        {
            get; set;
        }
    }

    private sealed class Entry(
        DocumentExportTask task,
        DocumentExportFrozenInput input,
        string identity,
        long retainedBytes,
        DateTimeOffset createdAtUtc,
        DateTimeOffset expiresAtUtc)
    {
        internal DocumentExportTask Task { get; set; } = task;
        internal DocumentExportFrozenInput Input { get; } = input;
        internal string Identity { get; } = identity;
        internal long RetainedBytes { get; } = retainedBytes;
        internal DateTimeOffset CreatedAtUtc { get; } = createdAtUtc;
        internal DateTimeOffset ExpiresAtUtc { get; } = expiresAtUtc;
        internal List<Attempt> Attempts { get; } = [new Attempt(task, 1, createdAtUtc)];
        internal Attempt Current => Attempts[^1];
        internal DocumentExportTaskClaim? Claim
        {
            get => Current.Claim;
            set => Current.Claim = value;
        }
        internal CancellationTokenSource? Abort
        {
            get => Current.Abort;
            set => Current.Abort = value;
        }
        internal LinkedListNode<Entry>? PendingNode
        {
            get; set;
        }
    }
}
