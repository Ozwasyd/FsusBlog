using System.Text;
using System.Text.Json.Serialization;

using FsusBlog.Server.Infrastructure.Distributed.Cluster;

namespace FsusBlog.Server.Infrastructure.Distributed.StateControl;

public readonly record struct LeaseKey
{
    [JsonConstructor]
    public LeaseKey(string responsibility, string resource)
    {
        Responsibility = Normalize(responsibility, nameof(responsibility));
        Resource = Normalize(resource, nameof(resource));
    }

    public string Responsibility
    {
        get;
    }

    public string Resource
    {
        get;
    }

    public override string ToString() => string.Concat(Responsibility, ':', Resource);

    internal string StorageIdentity => BuildLengthPrefixed(Responsibility, Resource);

    private static string Normalize(string value, string parameterName)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(value, parameterName);
        string normalized = value.Trim().ToLowerInvariant();
        if (normalized.Length > 128
            || normalized.Any(static character =>
                !(char.IsAsciiLetterOrDigit(character)
                    || character is '-' or '_' or '.' or ':')))
        {
            throw new ArgumentOutOfRangeException(parameterName, value, "Lease key contains unsupported characters.");
        }
        return normalized;
    }

    private static string BuildLengthPrefixed(string first, string second)
        => string.Concat(
            first.Length.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ':',
            first,
            second.Length.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ':',
            second);
}

public readonly record struct LeaseId(Guid Value)
{
    public override string ToString() => Value.ToString("N");
}

public readonly record struct FencingToken
{
    [JsonConstructor]
    public FencingToken(long value)
    {
        if (value <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(value));
        }
        Value = value;
    }

    public long Value
    {
        get;
    }

    public override string ToString() => Value.ToString(System.Globalization.CultureInfo.InvariantCulture);
}

public sealed record DistributedLease(
    LeaseKey Key,
    LeaseId LeaseId,
    NodeId OwnerNodeId,
    FencingToken FencingToken,
    DateTimeOffset ExpiresAt);

public sealed record LeaseContentionSnapshot(
    LeaseKey Key,
    NodeId OwnerNodeId,
    FencingToken FencingToken,
    DateTimeOffset ExpiresAt);

public sealed record LeaseAcquireResult(
    bool Acquired,
    DistributedLease? Lease,
    LeaseContentionSnapshot? Contention)
{
    public static LeaseAcquireResult Success(DistributedLease lease) => new(true, lease, null);

    public static LeaseAcquireResult Contended(DistributedLease lease)
        => new(
            false,
            null,
            new LeaseContentionSnapshot(
                lease.Key,
                lease.OwnerNodeId,
                lease.FencingToken,
                lease.ExpiresAt));
}

public interface ILeaseManager
{
    ValueTask<LeaseAcquireResult> TryAcquireAsync(
        LeaseKey key,
        NodeId nodeId,
        TimeSpan ttl,
        CancellationToken cancellationToken);

    ValueTask<bool> RenewAsync(
        LeaseId leaseId,
        FencingToken token,
        TimeSpan ttl,
        CancellationToken cancellationToken);

    ValueTask<bool> ReleaseAsync(
        LeaseId leaseId,
        FencingToken token,
        CancellationToken cancellationToken);

    ValueTask<bool> IsCurrentWriterAsync(
        DistributedLease lease,
        CancellationToken cancellationToken);
}

public readonly record struct IdempotencyKey
{
    [JsonConstructor]
    public IdempotencyKey(string taskType, string objectId, string operationId)
    {
        TaskType = Normalize(taskType, nameof(taskType));
        ObjectId = Normalize(objectId, nameof(objectId));
        OperationId = Normalize(operationId, nameof(operationId));
    }

    public string TaskType
    {
        get;
    }

    public string ObjectId
    {
        get;
    }

    public string OperationId
    {
        get;
    }

    public override string ToString() => string.Join(':', TaskType, ObjectId, OperationId);

    internal string StorageIdentity => BuildLengthPrefixed(TaskType, ObjectId, OperationId);

    private static string Normalize(string value, string parameterName)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(value, parameterName);
        string normalized = value.Trim();
        if (normalized.Length > 256 || normalized.Any(char.IsControl))
        {
            throw new ArgumentOutOfRangeException(parameterName, value, "Idempotency key is invalid.");
        }
        return normalized;
    }

    private static string BuildLengthPrefixed(string first, string second, string third)
        => string.Concat(
            first.Length.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ':',
            first,
            second.Length.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ':',
            second,
            third.Length.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ':',
            third);
}

public enum DistributedTaskStatus
{
    Running = 0,
    Succeeded = 1,
    RetryScheduled = 2,
    DeadLettered = 3,
    CompensationRequired = 4
}

public enum TaskStartDisposition
{
    Acquired = 0,
    AlreadyRunning = 1,
    CompletedReplay = 2,
    RetryNotDue = 3,
    DeadLettered = 4
}

public sealed record TaskFailurePolicy(
    int MaxAttempts,
    TimeSpan RetryDelay,
    bool RequireCompensation)
{
    public void Validate()
    {
        if (MaxAttempts is <= 0 or > 100)
        {
            throw new ArgumentOutOfRangeException(nameof(MaxAttempts));
        }
        if (RetryDelay < TimeSpan.Zero || RetryDelay > TimeSpan.FromDays(30))
        {
            throw new ArgumentOutOfRangeException(nameof(RetryDelay));
        }
    }
}

public sealed record DistributedTaskCheckpoint(
    int Version,
    string Payload,
    DateTimeOffset UpdatedAt);

public sealed record DistributedTaskRecord(
    IdempotencyKey IdempotencyKey,
    LeaseKey LeaseKey,
    DistributedTaskStatus Status,
    int Attempt,
    TaskFailurePolicy FailurePolicy,
    LeaseId WriterLeaseId,
    FencingToken FencingToken,
    NodeId WriterNodeId,
    DistributedTaskCheckpoint? Checkpoint,
    string? ResultDigest,
    string? LastError,
    DateTimeOffset? NextAttemptAt,
    DateTimeOffset UpdatedAt);

public sealed record DistributedTaskExecution(
    IdempotencyKey IdempotencyKey,
    LeaseKey LeaseKey,
    LeaseId LeaseId,
    FencingToken FencingToken,
    NodeId NodeId,
    int Attempt,
    DistributedTaskCheckpoint? Checkpoint);

public sealed record TaskStartResult(
    TaskStartDisposition Disposition,
    DistributedTaskExecution? Execution,
    DistributedTaskRecord? Record);

public interface IDistributedTaskStateStore
{
    ValueTask<TaskStartResult> TryBeginAsync(
        IdempotencyKey key,
        DistributedLease lease,
        TaskFailurePolicy failurePolicy,
        CancellationToken cancellationToken);

    ValueTask<DistributedTaskCheckpoint> SaveCheckpointAsync(
        DistributedTaskExecution execution,
        int expectedVersion,
        string payload,
        CancellationToken cancellationToken);

    ValueTask CompleteAsync(
        DistributedTaskExecution execution,
        string resultDigest,
        CancellationToken cancellationToken);

    ValueTask<DistributedTaskRecord> FailAsync(
        DistributedTaskExecution execution,
        string failureCode,
        CancellationToken cancellationToken);

    ValueTask<DistributedTaskRecord?> GetAsync(
        IdempotencyKey key,
        CancellationToken cancellationToken);
}

public interface IDistributedStateControlStore : ILeaseManager, IDistributedTaskStateStore;

public sealed class StaleFencingTokenException(string message) : InvalidOperationException(message);

public sealed class CheckpointVersionConflictException(string message) : InvalidOperationException(message);

internal static class DistributedStateControlGuards
{
    private const int MaxCheckpointPayloadBytes = 64 * 1024;
    private const int MaxResultDigestLength = 256;
    private const int MaxFailureCodeLength = 1024;

    public static string CheckpointPayload(string payload)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(payload);
        if (Encoding.UTF8.GetByteCount(payload) > MaxCheckpointPayloadBytes)
        {
            throw new ArgumentOutOfRangeException(nameof(payload), "Checkpoint payload exceeds 64 KiB.");
        }
        return payload;
    }

    public static string ResultDigest(string resultDigest)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(resultDigest);
        string normalized = resultDigest.Trim();
        if (normalized.Length > MaxResultDigestLength || normalized.Any(char.IsControl))
        {
            throw new ArgumentOutOfRangeException(nameof(resultDigest), "Result digest is invalid.");
        }
        return normalized;
    }

    public static string FailureCode(string failureCode)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(failureCode);
        string normalized = failureCode.Trim();
        if (normalized.Length > MaxFailureCodeLength || normalized.Any(char.IsControl))
        {
            throw new ArgumentOutOfRangeException(nameof(failureCode), "Failure code is invalid.");
        }
        return normalized;
    }
}
