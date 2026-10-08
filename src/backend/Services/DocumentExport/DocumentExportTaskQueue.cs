namespace FsusBlog.Server.Services.DocumentExport;

internal sealed record DocumentExportQueueLimits(
    int MaxTasks,
    int MaxConcurrency,
    long MaxFrozenBytes,
    TimeSpan RetentionTtl);

internal sealed record DocumentExportQueueSnapshot(
    DocumentExportTask Task,
    DateTimeOffset CreatedAtUtc,
    DateTimeOffset ExpiresAtUtc,
    bool ExecutionOutstanding,
    DocumentExportProviderResultStatus? StopOutcome);

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
            if (entry.Task.Status != DocumentExportTaskStatus.Preparing)
            {
                throw new InvalidOperationException("Export claim cannot start in its current state.");
            }
            SetStatus(entry, DocumentExportTaskStatus.Running);
            // Never expose the queue's immutable-array backing storage to a worker.
            return (entry.Task, DocumentExportContractValidator.Seal(entry.Input));
        }
    }

    internal async Task<DocumentExportQueueSnapshot> CancelAsync(long userId, long siteId, string taskId)
    {
        await ExpireAsync();
        CancellationTokenSource? abort = null;
        lock (_gate)
        {
            Entry entry = RequireOwned(userId, siteId, taskId);
            if (entry.Task.Status == DocumentExportTaskStatus.Queued)
            {
                RemovePending(entry);
                SetStatus(entry, DocumentExportTaskStatus.Cancelled);
            }
            else if (entry.Task.Status is DocumentExportTaskStatus.Preparing or DocumentExportTaskStatus.Running)
            {
                SetStatus(entry, DocumentExportTaskStatus.Cancelling);
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
            Entry entry = RequireStopClaim(claim);
            if (entry.Claim is null)
            {
                if (!cleanupComplete || entry.StopOutcome != outcome)
                {
                    throw new InvalidOperationException("Export completed acknowledgement cannot be changed.");
                }
                return Snapshot(entry);
            }
            if (outcome == DocumentExportProviderResultStatus.Cancelled
                && entry.Task.Status is not (DocumentExportTaskStatus.Cancelling
                    or DocumentExportTaskStatus.Expired
                    or DocumentExportTaskStatus.CleanupRequired))
            {
                throw new InvalidOperationException("Export cancellation was not requested.");
            }
            if (entry.StopOutcome is not null && entry.StopOutcome != outcome)
            {
                throw new InvalidOperationException("Export first stop outcome cannot be overwritten.");
            }
            entry.StopOutcome ??= outcome;
            if (!cleanupComplete)
            {
                if (entry.Task.Status != DocumentExportTaskStatus.Expired)
                {
                    SetStatus(entry, DocumentExportTaskStatus.CleanupRequired);
                }
                return Snapshot(entry);
            }

            DocumentExportTaskStatus status = entry.Task.Status == DocumentExportTaskStatus.Expired
                ? DocumentExportTaskStatus.Expired
                : outcome switch
                {
                    DocumentExportProviderResultStatus.Failed => DocumentExportTaskStatus.Failed,
                    DocumentExportProviderResultStatus.Blocked => DocumentExportTaskStatus.Blocked,
                    _ => DocumentExportTaskStatus.Cancelled
                };
            SetStatus(entry, status);
            entry.CompletedClaim = entry.Claim;
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
                    if (entry.Task.Status != DocumentExportTaskStatus.Expired)
                    {
                        SetStatus(entry, DocumentExportTaskStatus.Expired);
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

    private Entry RequireStopClaim(DocumentExportTaskClaim claim)
    {
        ArgumentNullException.ThrowIfNull(claim);
        if (!_entries.TryGetValue(claim.TaskId, out Entry? entry)
            || (!ReferenceEquals(entry.Claim, claim) && !ReferenceEquals(entry.CompletedClaim, claim)))
        {
            throw new InvalidOperationException("Export claim is stale or foreign.");
        }
        return entry;
    }

    private void RemovePending(Entry entry)
    {
        if (entry.PendingNode is not null)
        {
            _pending.Remove(entry.PendingNode);
            entry.PendingNode = null;
        }
    }

    private static void SetStatus(Entry entry, DocumentExportTaskStatus status)
        => entry.Task = DocumentExportContractValidator.Seal(entry.Task with
        {
            Status = status
        });

    private static DocumentExportQueueSnapshot Snapshot(Entry entry)
        => new(entry.Task, entry.CreatedAtUtc, entry.ExpiresAtUtc, entry.Claim is not null, entry.StopOutcome);

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
        internal LinkedListNode<Entry>? PendingNode
        {
            get; set;
        }
    }
}
