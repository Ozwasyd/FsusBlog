using FsusBlog.Server.Infrastructure.Distributed.Cluster;

namespace FsusBlog.Server.Infrastructure.Distributed.StateControl;

public sealed class InMemoryDistributedStateControlStore(
    TimeProvider timeProvider) : IDistributedStateControlStore
{
    private readonly object _gate = new();
    private readonly Dictionary<LeaseKey, DistributedLease> _leases = [];
    private readonly Dictionary<LeaseId, LeaseKey> _leaseIndex = [];
    private readonly Dictionary<LeaseKey, long> _fencingTokens = [];
    private readonly Dictionary<IdempotencyKey, DistributedTaskRecord> _tasks = [];

    public ValueTask<LeaseAcquireResult> TryAcquireAsync(
        LeaseKey key,
        NodeId nodeId,
        TimeSpan ttl,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ValidateTtl(ttl);
        lock (_gate)
        {
            DateTimeOffset now = timeProvider.GetUtcNow();
            if (_leases.TryGetValue(key, out DistributedLease? current)
                && current.ExpiresAt > now)
            {
                return ValueTask.FromResult(LeaseAcquireResult.Contended(current));
            }
            if (current is not null)
            {
                _leaseIndex.Remove(current.LeaseId);
            }
            long nextToken = checked(_fencingTokens.GetValueOrDefault(key) + 1);
            _fencingTokens[key] = nextToken;
            var lease = new DistributedLease(
                key,
                new LeaseId(Guid.NewGuid()),
                nodeId,
                new FencingToken(nextToken),
                now.Add(ttl));
            _leases[key] = lease;
            _leaseIndex[lease.LeaseId] = key;
            return ValueTask.FromResult(LeaseAcquireResult.Success(lease));
        }
    }

    public ValueTask<bool> RenewAsync(
        LeaseId leaseId,
        FencingToken token,
        TimeSpan ttl,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ValidateTtl(ttl);
        lock (_gate)
        {
            DateTimeOffset now = timeProvider.GetUtcNow();
            if (!TryGetCurrentLease(leaseId, token, now, out DistributedLease? lease))
            {
                return ValueTask.FromResult(false);
            }
            _leases[lease.Key] = lease with
            {
                ExpiresAt = now.Add(ttl)
            };
            return ValueTask.FromResult(true);
        }
    }

    public ValueTask<bool> ReleaseAsync(
        LeaseId leaseId,
        FencingToken token,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        lock (_gate)
        {
            if (!TryGetCurrentLease(
                    leaseId,
                    token,
                    timeProvider.GetUtcNow(),
                    out DistributedLease? lease))
            {
                return ValueTask.FromResult(false);
            }
            _leases.Remove(lease.Key);
            _leaseIndex.Remove(leaseId);
            return ValueTask.FromResult(true);
        }
    }

    public ValueTask<bool> IsCurrentWriterAsync(
        DistributedLease lease,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        lock (_gate)
        {
            return ValueTask.FromResult(
                TryGetCurrentLease(
                    lease.LeaseId,
                    lease.FencingToken,
                    timeProvider.GetUtcNow(),
                    out DistributedLease? current)
                && current.Key == lease.Key
                && current.OwnerNodeId == lease.OwnerNodeId);
        }
    }

    public ValueTask<TaskStartResult> TryBeginAsync(
        IdempotencyKey key,
        DistributedLease lease,
        TaskFailurePolicy failurePolicy,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        failurePolicy.Validate();
        lock (_gate)
        {
            DateTimeOffset now = timeProvider.GetUtcNow();
            EnsureCurrentWriter(lease, now);
            _tasks.TryGetValue(key, out DistributedTaskRecord? current);
            EnsureLeasePartition(current, lease);
            if (current?.Status == DistributedTaskStatus.Succeeded)
            {
                return ValueTask.FromResult(new TaskStartResult(
                    TaskStartDisposition.CompletedReplay,
                    null,
                    current));
            }
            if (current?.Status is DistributedTaskStatus.DeadLettered
                or DistributedTaskStatus.CompensationRequired)
            {
                return ValueTask.FromResult(new TaskStartResult(
                    TaskStartDisposition.DeadLettered,
                    null,
                    current));
            }
            if (current?.Status == DistributedTaskStatus.RetryScheduled
                && current.NextAttemptAt > now)
            {
                return ValueTask.FromResult(new TaskStartResult(
                    TaskStartDisposition.RetryNotDue,
                    null,
                    current));
            }
            if (current?.Status == DistributedTaskStatus.Running
                && current.FencingToken.Value >= lease.FencingToken.Value)
            {
                return ValueTask.FromResult(new TaskStartResult(
                    TaskStartDisposition.AlreadyRunning,
                    null,
                    current));
            }
            int attempt = (current?.Attempt ?? 0) + 1;
            var updated = new DistributedTaskRecord(
                key,
                lease.Key,
                DistributedTaskStatus.Running,
                attempt,
                current?.FailurePolicy ?? failurePolicy,
                lease.LeaseId,
                lease.FencingToken,
                lease.OwnerNodeId,
                current?.Checkpoint,
                null,
                current?.LastError,
                null,
                now);
            _tasks[key] = updated;
            return ValueTask.FromResult(new TaskStartResult(
                TaskStartDisposition.Acquired,
                ToExecution(updated),
                updated));
        }
    }

    public ValueTask<DistributedTaskCheckpoint> SaveCheckpointAsync(
        DistributedTaskExecution execution,
        int expectedVersion,
        string payload,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string checkpointPayload = DistributedStateControlGuards.CheckpointPayload(payload);
        lock (_gate)
        {
            DateTimeOffset now = timeProvider.GetUtcNow();
            DistributedTaskRecord record = EnsureCurrentExecution(execution, now);
            int currentVersion = record.Checkpoint?.Version ?? 0;
            if (currentVersion != expectedVersion)
            {
                throw new CheckpointVersionConflictException(
                    $"checkpoint_version_conflict:{currentVersion}:{expectedVersion}");
            }
            var checkpoint = new DistributedTaskCheckpoint(
                checked(currentVersion + 1),
                checkpointPayload,
                now);
            _tasks[execution.IdempotencyKey] = record with
            {
                Checkpoint = checkpoint,
                UpdatedAt = now
            };
            return ValueTask.FromResult(checkpoint);
        }
    }

    public ValueTask CompleteAsync(
        DistributedTaskExecution execution,
        string resultDigest,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string normalizedResultDigest = DistributedStateControlGuards.ResultDigest(resultDigest);
        lock (_gate)
        {
            DateTimeOffset now = timeProvider.GetUtcNow();
            DistributedTaskRecord record = EnsureCurrentExecution(execution, now);
            _tasks[execution.IdempotencyKey] = record with
            {
                Status = DistributedTaskStatus.Succeeded,
                ResultDigest = normalizedResultDigest,
                LastError = null,
                NextAttemptAt = null,
                UpdatedAt = now
            };
            return ValueTask.CompletedTask;
        }
    }

    public ValueTask<DistributedTaskRecord> FailAsync(
        DistributedTaskExecution execution,
        string failureCode,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string normalizedFailureCode = DistributedStateControlGuards.FailureCode(failureCode);
        lock (_gate)
        {
            DateTimeOffset now = timeProvider.GetUtcNow();
            DistributedTaskRecord record = EnsureCurrentExecution(execution, now);
            bool exhausted = record.Attempt >= record.FailurePolicy.MaxAttempts;
            DistributedTaskStatus status = exhausted
                ? record.FailurePolicy.RequireCompensation
                    ? DistributedTaskStatus.CompensationRequired
                    : DistributedTaskStatus.DeadLettered
                : DistributedTaskStatus.RetryScheduled;
            DistributedTaskRecord updated = record with
            {
                Status = status,
                LastError = normalizedFailureCode,
                NextAttemptAt = exhausted ? null : now.Add(record.FailurePolicy.RetryDelay),
                UpdatedAt = now
            };
            _tasks[execution.IdempotencyKey] = updated;
            return ValueTask.FromResult(updated);
        }
    }

    public ValueTask<DistributedTaskRecord?> GetAsync(
        IdempotencyKey key,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        lock (_gate)
        {
            return ValueTask.FromResult(_tasks.GetValueOrDefault(key));
        }
    }

    private bool TryGetCurrentLease(
        LeaseId leaseId,
        FencingToken token,
        DateTimeOffset now,
        out DistributedLease lease)
    {
        if (_leaseIndex.TryGetValue(leaseId, out LeaseKey key)
            && _leases.TryGetValue(key, out DistributedLease? current)
            && current.LeaseId == leaseId
            && current.FencingToken == token
            && current.ExpiresAt > now)
        {
            lease = current;
            return true;
        }
        lease = null!;
        return false;
    }

    private void EnsureCurrentWriter(DistributedLease lease, DateTimeOffset now)
    {
        if (!TryGetCurrentLease(lease.LeaseId, lease.FencingToken, now, out DistributedLease? current)
            || current.Key != lease.Key
            || current.OwnerNodeId != lease.OwnerNodeId)
        {
            throw new StaleFencingTokenException("stale_fencing_token");
        }
    }

    private DistributedTaskRecord EnsureCurrentExecution(
        DistributedTaskExecution execution,
        DateTimeOffset now)
    {
        if (!_tasks.TryGetValue(execution.IdempotencyKey, out DistributedTaskRecord? record)
            || record.Status != DistributedTaskStatus.Running
            || record.WriterLeaseId != execution.LeaseId
            || record.FencingToken != execution.FencingToken
            || record.Attempt != execution.Attempt
            || !_leaseIndex.TryGetValue(execution.LeaseId, out LeaseKey leaseKey)
            || !_leases.TryGetValue(leaseKey, out DistributedLease? lease)
            || lease.ExpiresAt <= now
            || lease.FencingToken != execution.FencingToken)
        {
            throw new StaleFencingTokenException("stale_fencing_token");
        }
        return record;
    }

    private static DistributedTaskExecution ToExecution(DistributedTaskRecord record)
        => new(
            record.IdempotencyKey,
            record.LeaseKey,
            record.WriterLeaseId,
            record.FencingToken,
            record.WriterNodeId,
            record.Attempt,
            record.Checkpoint);

    private static void EnsureLeasePartition(
        DistributedTaskRecord? record,
        DistributedLease lease)
    {
        if (record is not null && record.LeaseKey != lease.Key)
        {
            throw new InvalidOperationException("idempotency_lease_partition_mismatch");
        }
    }

    private static void ValidateTtl(TimeSpan ttl)
    {
        if (ttl <= TimeSpan.Zero || ttl > TimeSpan.FromHours(24))
        {
            throw new ArgumentOutOfRangeException(nameof(ttl));
        }
    }
}
