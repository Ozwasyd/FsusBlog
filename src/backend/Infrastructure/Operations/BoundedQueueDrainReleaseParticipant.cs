namespace FsusBlog.Server.Infrastructure.Operations;

/// <summary>
/// Adapts the catalog aggregate to the existing deployment qualification boundary.
/// Queue implementations remain owned by their individual participant adapters.
/// </summary>
public sealed class BoundedQueueDrainReleaseParticipant(
    BoundedQueueDrainAggregator aggregator) : IReleaseDrainParticipant
{
    private readonly object _gate = new();
    private BoundedQueueDrainAggregateReceipt? _lastRun;

    public string Name => "bounded-queue-drain";

    public TimeSpan MaxDrain => TimeSpan.FromMinutes(5);

    public ReleaseDrainParticipantSnapshot Snapshot()
    {
        BoundedQueueDrainAggregateReceipt receipt;
        lock (_gate)
        {
            receipt = _lastRun ?? aggregator.Observe();
        }

        return ToSnapshot(receipt);
    }

    public async Task DrainAsync(CancellationToken cancellationToken)
    {
        aggregator.BeginRun();
        lock (_gate)
        {
            _lastRun = null;
        }

        BoundedQueueDrainAggregateReceipt receipt = await aggregator
            .WaitAsync(MaxDrain, cancellationToken)
            .ConfigureAwait(false);
        lock (_gate)
        {
            _lastRun = receipt;
        }
    }

    private static ReleaseDrainParticipantSnapshot ToSnapshot(BoundedQueueDrainAggregateReceipt receipt)
    {
        bool complete = receipt.Complete;
        string? error = complete
            ? null
            : receipt.ErrorCode ?? "bounded_queue_drain_incomplete";
        string status = complete
            ? "drained"
            : receipt.TimedOut
                ? "timed-out"
                : receipt.Cancelled
                    ? "cancelled"
                    : receipt.HealthStatus;
        IReadOnlyList<string> blockers = receipt.Blockers;
        return new ReleaseDrainParticipantSnapshot(
            "bounded-queue-drain",
            "catalog-aggregate",
            complete ? 0 : 1,
            status,
            TimeSpan.FromMinutes(5),
            $"catalog={receipt.CatalogDigest};aggregate={receipt.ContentDigest}",
            error,
            blockers);
    }
}
