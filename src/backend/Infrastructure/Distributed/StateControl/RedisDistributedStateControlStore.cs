using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Distributed.Cluster;

using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.Distributed.StateControl;

public sealed class RedisDistributedStateControlStore(
    IConnectionMultiplexer redis,
    IRuntimeKeyScope runtimeKeyScope,
    TimeProvider timeProvider) : IDistributedStateControlStore
{
    private static readonly JsonSerializerOptions s_jsonOptions = new(JsonSerializerDefaults.Web);
    private readonly string _prefix = runtimeKeyScope.PrefixKey("fsus:state-control:v1").ToString();

    public async ValueTask<LeaseAcquireResult> TryAcquireAsync(
        LeaseKey key,
        NodeId nodeId,
        TimeSpan ttl,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ValidateTtl(ttl);
        LeaseId leaseId = new(Guid.NewGuid());
        RedisKey leaseKey = BuildLeaseKey(key);
        RedisKey counterKey = BuildFencingCounterKey(key);
        RedisKey indexKey = BuildLeaseIndexKey(leaseId);
        const string Script = """
local current = redis.call('HMGET', KEYS[1], 'leaseId', 'token', 'nodeId', 'expiresAt')
if current[1] then
  return {0, current[1], current[2], current[3], current[4]}
end
local token = redis.call('INCR', KEYS[2])
local now = redis.call('TIME')
local expiresAt = (now[1] * 1000) + math.floor(now[2] / 1000) + tonumber(ARGV[4])
redis.call('HSET', KEYS[1],
  'leaseId', ARGV[1],
  'token', token,
  'nodeId', ARGV[2],
  'responsibility', ARGV[3],
  'resource', ARGV[5],
  'expiresAt', expiresAt)
redis.call('PEXPIRE', KEYS[1], ARGV[4])
redis.call('SET', KEYS[3], KEYS[1], 'PX', ARGV[4])
return {1, ARGV[1], token, ARGV[2], expiresAt}
""";
        RedisResult result = await Database.ScriptEvaluateAsync(
                Script,
                [leaseKey, counterKey, indexKey],
                [
                    leaseId.ToString(),
                    nodeId.Value,
                    key.Responsibility,
                    checked((long)ttl.TotalMilliseconds),
                    key.Resource
                ],
                CommandFlags.None)
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        RedisResult[] values = (RedisResult[])result!;
        DistributedLease lease = ParseLease(key, values);
        return (long)values[0] == 1L
            ? LeaseAcquireResult.Success(lease)
            : LeaseAcquireResult.Contended(lease);
    }

    public async ValueTask<bool> RenewAsync(
        LeaseId leaseId,
        FencingToken token,
        TimeSpan ttl,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ValidateTtl(ttl);
        RedisKey indexKey = BuildLeaseIndexKey(leaseId);
        RedisValue indexedLeaseKey = await Database.StringGetAsync(indexKey).ConfigureAwait(false);
        if (indexedLeaseKey.IsNullOrEmpty)
        {
            return false;
        }
        const string Script = """
if redis.call('HGET', KEYS[1], 'leaseId') ~= ARGV[1]
  or redis.call('HGET', KEYS[1], 'token') ~= ARGV[2] then
  return 0
end
local now = redis.call('TIME')
local expiresAt = (now[1] * 1000) + math.floor(now[2] / 1000) + tonumber(ARGV[3])
redis.call('HSET', KEYS[1], 'expiresAt', expiresAt)
redis.call('PEXPIRE', KEYS[1], ARGV[3])
redis.call('PEXPIRE', KEYS[2], ARGV[3])
return 1
""";
        RedisResult result = await Database.ScriptEvaluateAsync(
                Script,
                [(RedisKey)indexedLeaseKey.ToString(), indexKey],
                [leaseId.ToString(), token.ToString(), checked((long)ttl.TotalMilliseconds)],
                CommandFlags.None)
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        return (long)result == 1L;
    }

    public async ValueTask<bool> ReleaseAsync(
        LeaseId leaseId,
        FencingToken token,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        RedisKey indexKey = BuildLeaseIndexKey(leaseId);
        RedisValue indexedLeaseKey = await Database.StringGetAsync(indexKey).ConfigureAwait(false);
        if (indexedLeaseKey.IsNullOrEmpty)
        {
            return false;
        }
        const string Script = """
if redis.call('HGET', KEYS[1], 'leaseId') ~= ARGV[1]
  or redis.call('HGET', KEYS[1], 'token') ~= ARGV[2] then
  return 0
end
redis.call('DEL', KEYS[1])
redis.call('DEL', KEYS[2])
return 1
""";
        RedisResult result = await Database.ScriptEvaluateAsync(
                Script,
                [(RedisKey)indexedLeaseKey.ToString(), indexKey],
                [leaseId.ToString(), token.ToString()],
                CommandFlags.None)
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        return (long)result == 1L;
    }

    public async ValueTask<bool> IsCurrentWriterAsync(
        DistributedLease lease,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        RedisKey leaseKey = BuildLeaseKey(lease.Key);
        RedisValue[] values = await Database.HashGetAsync(
                leaseKey,
                ["leaseId", "token", "nodeId"])
            .ConfigureAwait(false);
        return values.Length == 3
            && StringComparer.Ordinal.Equals(values[0].ToString(), lease.LeaseId.ToString())
            && StringComparer.Ordinal.Equals(values[1].ToString(), lease.FencingToken.ToString())
            && StringComparer.Ordinal.Equals(values[2].ToString(), lease.OwnerNodeId.Value);
    }

    public async ValueTask<TaskStartResult> TryBeginAsync(
        IdempotencyKey key,
        DistributedLease lease,
        TaskFailurePolicy failurePolicy,
        CancellationToken cancellationToken)
    {
        failurePolicy.Validate();
        return await MutateTaskAsync(
            key,
            lease,
            current =>
            {
                DateTimeOffset now = timeProvider.GetUtcNow();
                EnsureLeasePartition(current, lease);
                if (current?.Status == DistributedTaskStatus.Succeeded)
                {
                    return MutationResult.Unchanged(new TaskStartResult(
                        TaskStartDisposition.CompletedReplay,
                        null,
                        current));
                }
                if (current?.Status is DistributedTaskStatus.DeadLettered
                    or DistributedTaskStatus.CompensationRequired)
                {
                    return MutationResult.Unchanged(new TaskStartResult(
                        TaskStartDisposition.DeadLettered,
                        null,
                        current));
                }
                if (current?.Status == DistributedTaskStatus.RetryScheduled
                    && current.NextAttemptAt > now)
                {
                    return MutationResult.Unchanged(new TaskStartResult(
                        TaskStartDisposition.RetryNotDue,
                        null,
                        current));
                }
                if (current?.Status == DistributedTaskStatus.Running
                    && current.FencingToken.Value >= lease.FencingToken.Value)
                {
                    return MutationResult.Unchanged(new TaskStartResult(
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
                return MutationResult.Changed(
                    updated,
                    new TaskStartResult(
                        TaskStartDisposition.Acquired,
                        ToExecution(updated),
                        updated));
            },
            cancellationToken).ConfigureAwait(false);
    }

    public async ValueTask<DistributedTaskCheckpoint> SaveCheckpointAsync(
        DistributedTaskExecution execution,
        int expectedVersion,
        string payload,
        CancellationToken cancellationToken)
    {
        string checkpointPayload = DistributedStateControlGuards.CheckpointPayload(payload);
        DistributedLease lease = ExecutionLease(execution);
        return await MutateTaskAsync(
            execution.IdempotencyKey,
            lease,
            current =>
            {
                DistributedTaskRecord record = EnsureCurrentExecution(current, execution);
                int currentVersion = record.Checkpoint?.Version ?? 0;
                if (currentVersion != expectedVersion)
                {
                    throw new CheckpointVersionConflictException(
                        $"checkpoint_version_conflict:{currentVersion}:{expectedVersion}");
                }
                var checkpoint = new DistributedTaskCheckpoint(
                    checked(currentVersion + 1),
                    checkpointPayload,
                    timeProvider.GetUtcNow());
                return MutationResult.Changed(
                    record with
                    {
                        Checkpoint = checkpoint,
                        UpdatedAt = checkpoint.UpdatedAt
                    },
                    checkpoint);
            },
            cancellationToken).ConfigureAwait(false);
    }

    public async ValueTask CompleteAsync(
        DistributedTaskExecution execution,
        string resultDigest,
        CancellationToken cancellationToken)
    {
        string normalizedResultDigest = DistributedStateControlGuards.ResultDigest(resultDigest);
        DistributedLease lease = ExecutionLease(execution);
        _ = await MutateTaskAsync(
            execution.IdempotencyKey,
            lease,
            current =>
            {
                DistributedTaskRecord record = EnsureCurrentExecution(current, execution);
                return MutationResult.Changed(
                    record with
                    {
                        Status = DistributedTaskStatus.Succeeded,
                        ResultDigest = normalizedResultDigest,
                        LastError = null,
                        NextAttemptAt = null,
                        UpdatedAt = timeProvider.GetUtcNow()
                    },
                    true);
            },
            cancellationToken).ConfigureAwait(false);
    }

    public async ValueTask<DistributedTaskRecord> FailAsync(
        DistributedTaskExecution execution,
        string failureCode,
        CancellationToken cancellationToken)
    {
        string normalizedFailureCode = DistributedStateControlGuards.FailureCode(failureCode);
        DistributedLease lease = ExecutionLease(execution);
        return await MutateTaskAsync(
            execution.IdempotencyKey,
            lease,
            current =>
            {
                DistributedTaskRecord record = EnsureCurrentExecution(current, execution);
                DateTimeOffset now = timeProvider.GetUtcNow();
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
                return MutationResult.Changed(updated, updated);
            },
            cancellationToken).ConfigureAwait(false);
    }

    public async ValueTask<DistributedTaskRecord?> GetAsync(
        IdempotencyKey key,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        RedisValue payload = await Database.StringGetAsync(BuildTaskKey(key)).ConfigureAwait(false);
        return payload.IsNullOrEmpty ? null : DeserializeRecord(payload);
    }

    private IDatabase Database => redis.GetDatabase();

    private async ValueTask<T> MutateTaskAsync<T>(
        IdempotencyKey key,
        DistributedLease lease,
        Func<DistributedTaskRecord?, MutationResult<T>> mutation,
        CancellationToken cancellationToken)
    {
        RedisKey taskKey = BuildTaskKey(key);
        RedisKey leaseKey = BuildLeaseKey(lease.Key);
        for (int attempt = 0; attempt < 8; attempt++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            RedisValue currentValue = await Database.StringGetAsync(taskKey).ConfigureAwait(false);
            DistributedTaskRecord? current = currentValue.IsNullOrEmpty
                ? null
                : DeserializeRecord(currentValue);
            MutationResult<T> result = mutation(current);
            if (!result.HasChange)
            {
                return result.Value;
            }
            ITransaction transaction = Database.CreateTransaction();
            transaction.AddCondition(currentValue.IsNull
                ? Condition.KeyNotExists(taskKey)
                : Condition.StringEqual(taskKey, currentValue));
            transaction.AddCondition(Condition.HashEqual(
                leaseKey,
                "leaseId",
                lease.LeaseId.ToString()));
            transaction.AddCondition(Condition.HashEqual(
                leaseKey,
                "token",
                lease.FencingToken.ToString()));
            transaction.AddCondition(Condition.HashEqual(
                leaseKey,
                "nodeId",
                lease.OwnerNodeId.Value));
            _ = transaction.StringSetAsync(
                taskKey,
                JsonSerializer.Serialize(result.Record, s_jsonOptions));
            if (await transaction.ExecuteAsync().ConfigureAwait(false))
            {
                return result.Value;
            }
            if (!await IsCurrentWriterAsync(lease, cancellationToken).ConfigureAwait(false))
            {
                throw new StaleFencingTokenException("stale_fencing_token");
            }
        }
        throw new InvalidOperationException("distributed_task_concurrent_update_exhausted");
    }

    private RedisKey BuildLeaseKey(LeaseKey key)
        => string.Concat(_prefix, ":lease:", HashIdentity(key.StorageIdentity));

    private RedisKey BuildFencingCounterKey(LeaseKey key)
        => string.Concat(_prefix, ":fence:", HashIdentity(key.StorageIdentity));

    private RedisKey BuildLeaseIndexKey(LeaseId leaseId)
        => string.Concat(_prefix, ":lease-index:", leaseId);

    private RedisKey BuildTaskKey(IdempotencyKey key)
        => string.Concat(_prefix, ":task:", HashIdentity(key.StorageIdentity));

    private static string HashIdentity(string value)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    private static DistributedLease ParseLease(LeaseKey key, RedisResult[] values)
        => new(
            key,
            new LeaseId(Guid.ParseExact(values[1].ToString(), "N")),
            new NodeId(values[3].ToString()),
            new FencingToken((long)values[2]),
            DateTimeOffset.FromUnixTimeMilliseconds((long)values[4]));

    private static DistributedTaskRecord DeserializeRecord(RedisValue payload)
        => JsonSerializer.Deserialize<DistributedTaskRecord>(
            payload.ToString(),
            s_jsonOptions)
            ?? throw new InvalidOperationException("distributed_task_record_invalid");

    private static DistributedTaskRecord EnsureCurrentExecution(
        DistributedTaskRecord? record,
        DistributedTaskExecution execution)
    {
        if (record is null
            || record.Status != DistributedTaskStatus.Running
            || record.WriterLeaseId != execution.LeaseId
            || record.FencingToken != execution.FencingToken
            || record.Attempt != execution.Attempt)
        {
            throw new StaleFencingTokenException("stale_fencing_token");
        }
        return record;
    }

    private static void EnsureLeasePartition(
        DistributedTaskRecord? record,
        DistributedLease lease)
    {
        if (record is not null && record.LeaseKey != lease.Key)
        {
            throw new InvalidOperationException("idempotency_lease_partition_mismatch");
        }
    }

    private static DistributedLease ExecutionLease(DistributedTaskExecution execution)
        => new(
            execution.LeaseKey,
            execution.LeaseId,
            execution.NodeId,
            execution.FencingToken,
            DateTimeOffset.MaxValue);

    private static DistributedTaskExecution ToExecution(DistributedTaskRecord record)
        => new(
            record.IdempotencyKey,
            record.LeaseKey,
            record.WriterLeaseId,
            record.FencingToken,
            record.WriterNodeId,
            record.Attempt,
            record.Checkpoint);

    private static void ValidateTtl(TimeSpan ttl)
    {
        if (ttl <= TimeSpan.Zero || ttl > TimeSpan.FromHours(24))
        {
            throw new ArgumentOutOfRangeException(nameof(ttl));
        }
    }

    private sealed record MutationResult<T>(
        bool HasChange,
        DistributedTaskRecord? Record,
        T Value);

    private static class MutationResult
    {
        public static MutationResult<T> Changed<T>(DistributedTaskRecord record, T value)
            => new(true, record, value);

        public static MutationResult<T> Unchanged<T>(T value)
            => new(false, null, value);
    }
}
