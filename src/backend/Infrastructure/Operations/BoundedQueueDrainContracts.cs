using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Server.Infrastructure.Operations;

public enum BoundedQueueCommitPostcondition
{
    Success = 0,
    Failed = 1,
    Unknown = 2
}

public sealed record BoundedChannelQueueContract(
    string QueueId,
    string DeliveryClass,
    bool DrainParticipant,
    string? ParticipantAdapterToken,
    string QualificationImpact);

public interface IBoundedQueueDrainCatalog
{
    string Digest
    {
        get;
    }

    IReadOnlyList<BoundedChannelQueueContract> Queues
    {
        get;
    }

    IReadOnlyList<BoundedChannelQueueContract> DrainParticipants
    {
        get;
    }
}

public sealed record BoundedQueueDropProof(
    string Kind,
    string Policy,
    string Evidence);

public sealed record BoundedQueueParticipantReceipt(
    string QueueId,
    string DeliveryClass,
    string RunId,
    long Generation,
    long Sequence,
    string ContentDigest,
    long Queued,
    long InFlight,
    long DurablePending,
    long TerminalFailures,
    BoundedQueueCommitPostcondition CommitPostcondition,
    BoundedQueueDropProof? DropProof,
    IReadOnlyList<string> Blockers,
    string? ErrorCode,
    DateTimeOffset ObservedAtUtc)
{
    public static BoundedQueueParticipantReceipt Create(
        string queueId,
        string deliveryClass,
        string runId,
        long generation,
        long sequence,
        long queued,
        long inFlight,
        long durablePending,
        long terminalFailures,
        BoundedQueueCommitPostcondition commitPostcondition,
        BoundedQueueDropProof? dropProof,
        IReadOnlyList<string>? blockers,
        DateTimeOffset observedAtUtc)
    {
        List<string> resolvedBlockers = blockers is null ? [] : [.. blockers];
        string? error = null;

        if (string.IsNullOrWhiteSpace(queueId) || string.IsNullOrWhiteSpace(deliveryClass) || string.IsNullOrWhiteSpace(runId))
        {
            error = "participant_identity_invalid";
            resolvedBlockers.Add("queueId, deliveryClass, and runId are required");
        }

        if (generation < 0 || sequence < 0)
        {
            error ??= "generation_underflow";
            resolvedBlockers.Add($"underflow generation={generation} sequence={sequence}");
        }

        if (queued < 0 || inFlight < 0 || durablePending < 0 || terminalFailures < 0)
        {
            error ??= "count_underflow";
            resolvedBlockers.Add($"underflow queued={queued} inFlight={inFlight} durablePending={durablePending} terminalFailures={terminalFailures}");
        }

        if (BoundedQueueDrainEvaluation.RequiresDropProof(deliveryClass) && dropProof is null)
        {
            error ??= "drop_proof_missing";
            resolvedBlockers.Add("dropProof=missing");
        }
        else if (dropProof is not null && !BoundedQueueDrainEvaluation.IsValidDropProof(deliveryClass, dropProof))
        {
            error ??= "drop_proof_invalid";
            resolvedBlockers.Add("dropProof=invalid");
        }

        if (commitPostcondition == BoundedQueueCommitPostcondition.Unknown)
        {
            error ??= "postcondition_unknown";
            resolvedBlockers.Add("commitPostcondition=unknown");
        }
        else if (commitPostcondition == BoundedQueueCommitPostcondition.Failed)
        {
            error ??= "commit_postcondition_failed";
            resolvedBlockers.Add("commitPostcondition=failed");
        }

        if (queued > 0)
        {
            resolvedBlockers.Add($"queued={queued}");
        }

        if (inFlight > 0)
        {
            resolvedBlockers.Add($"inFlight={inFlight}");
        }

        if (durablePending > 0)
        {
            resolvedBlockers.Add($"durablePending={durablePending}");
        }

        if (terminalFailures > 0
            && !BoundedQueueDrainEvaluation.AllowsTerminalFailures(deliveryClass, dropProof))
        {
            resolvedBlockers.Add($"terminalFailures={terminalFailures}");
        }

        string digest = BoundedQueueDrainDigest.Receipt(
            queueId,
            deliveryClass,
            runId,
            generation,
            sequence,
            queued,
            inFlight,
            durablePending,
            terminalFailures,
            commitPostcondition,
            dropProof);
        return new BoundedQueueParticipantReceipt(
            queueId,
            deliveryClass,
            runId,
            generation,
            sequence,
            digest,
            queued,
            inFlight,
            durablePending,
            terminalFailures,
            commitPostcondition,
            dropProof,
            resolvedBlockers,
            error,
            observedAtUtc);
    }
}

public interface IBoundedQueueDrainParticipant
{
    string QueueId
    {
        get;
    }

    string AdapterToken => GetType().Name;

    BoundedQueueParticipantReceipt Observe(string runId);
}

public sealed record BoundedQueueDrainAggregateReceipt(
    string Schema,
    string RunId,
    string CatalogDigest,
    string ContentDigest,
    bool Complete,
    bool TimedOut,
    bool Cancelled,
    IReadOnlyList<string> Blockers,
    IReadOnlyList<BoundedQueueParticipantReceipt> Participants,
    string HealthStatus,
    string ReadinessStatus,
    string QualificationStatus,
    string? ErrorCode,
    DateTimeOffset ObservedAtUtc);

public static class BoundedQueueDrainDigest
{
    public const string AggregateSchema = "fsusblog.bounded-queue-drain-aggregate.v1";

    public static string Receipt(
        string queueId,
        string deliveryClass,
        string runId,
        long generation,
        long sequence,
        long queued,
        long inFlight,
        long durablePending,
        long terminalFailures,
        BoundedQueueCommitPostcondition commitPostcondition,
        BoundedQueueDropProof? dropProof)
    {
        string drop = dropProof is null
            ? string.Empty
            : $"{dropProof.Kind}\n{dropProof.Policy}\n{dropProof.Evidence}";
        return Hash(string.Join(
            '\n',
            queueId,
            deliveryClass,
            runId,
            generation.ToString(System.Globalization.CultureInfo.InvariantCulture),
            sequence.ToString(System.Globalization.CultureInfo.InvariantCulture),
            queued.ToString(System.Globalization.CultureInfo.InvariantCulture),
            inFlight.ToString(System.Globalization.CultureInfo.InvariantCulture),
            durablePending.ToString(System.Globalization.CultureInfo.InvariantCulture),
            terminalFailures.ToString(System.Globalization.CultureInfo.InvariantCulture),
            commitPostcondition.ToString(),
            drop));
    }

    public static string Aggregate(string runId, string catalogDigest, IEnumerable<BoundedQueueParticipantReceipt> participants)
    {
        string body = string.Join(
            '\n',
            participants
                .OrderBy(static item => item.QueueId, StringComparer.Ordinal)
                .Select(static item => item.ContentDigest));
        return Hash($"{runId}\n{catalogDigest}\n{body}");
    }

    public static string Hash(string canonical)
        => "sha256:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
}

public static class BoundedQueueDrainEvaluation
{
    public static bool IsKnownDeliveryClass(string deliveryClass)
        => string.Equals(deliveryClass, "required", StringComparison.Ordinal)
            || string.Equals(deliveryClass, "best-effort", StringComparison.Ordinal)
            || string.Equals(deliveryClass, "coalescible", StringComparison.Ordinal)
            || string.Equals(deliveryClass, "replayable", StringComparison.Ordinal);

    public static bool RequiresDropProof(string deliveryClass)
        => string.Equals(deliveryClass, "best-effort", StringComparison.Ordinal)
            || string.Equals(deliveryClass, "coalescible", StringComparison.Ordinal);

    public static bool IsValidDropProof(string deliveryClass, BoundedQueueDropProof? dropProof)
        => dropProof is not null
            && ((string.Equals(deliveryClass, "best-effort", StringComparison.Ordinal)
                    && string.Equals(dropProof.Kind, "best-effort", StringComparison.Ordinal))
                || (string.Equals(deliveryClass, "coalescible", StringComparison.Ordinal)
                    && string.Equals(dropProof.Kind, "coalescible", StringComparison.Ordinal)))
            && !string.IsNullOrWhiteSpace(dropProof.Policy)
            && !string.IsNullOrWhiteSpace(dropProof.Evidence);

    public static bool AllowsTerminalFailures(string deliveryClass, BoundedQueueDropProof? dropProof)
        => IsValidDropProof(deliveryClass, dropProof);

    public static bool IsBlockingDeliveryClass(string deliveryClass)
        => string.Equals(deliveryClass, "required", StringComparison.Ordinal)
            || string.Equals(deliveryClass, "replayable", StringComparison.Ordinal);

    public static bool ParticipantComplete(BoundedQueueParticipantReceipt receipt)
    {
        if (!IsKnownDeliveryClass(receipt.DeliveryClass)
            || receipt.ErrorCode is not null
            || receipt.Blockers is null
            || receipt.Blockers.Count > 0
            || receipt.Generation < 0
            || receipt.Sequence < 0
            || receipt.Queued < 0
            || receipt.InFlight < 0
            || receipt.DurablePending < 0
            || receipt.TerminalFailures < 0
            || receipt.CommitPostcondition != BoundedQueueCommitPostcondition.Success
            || receipt.Queued != 0
            || receipt.InFlight != 0
            || receipt.DurablePending != 0)
        {
            return false;
        }

        return receipt.TerminalFailures == 0
            || AllowsTerminalFailures(receipt.DeliveryClass, receipt.DropProof);
    }

    public static (string Health, string Readiness, string Qualification) Judge(
        bool complete,
        string? errorCode,
        IReadOnlyList<BoundedQueueParticipantReceipt> participants)
    {
        bool blockingFailure = errorCode is not null
            || participants.Any(static item =>
                !IsKnownDeliveryClass(item.DeliveryClass)
                || item.ErrorCode is not null
                || item.Blockers is null
                || item.Blockers.Count > 0
                || item.Generation < 0
                || item.Sequence < 0
                || item.Queued < 0
                || item.InFlight < 0
                || item.DurablePending < 0
                || item.TerminalFailures < 0
                || item.CommitPostcondition != BoundedQueueCommitPostcondition.Success
                || (item.TerminalFailures > 0 && IsBlockingDeliveryClass(item.DeliveryClass))
                || item.Queued > 0
                || item.InFlight > 0
                || item.DurablePending > 0);
        string status = blockingFailure ? "failed" : complete ? "ok" : "blocked";
        return (status, status, status);
    }
}
