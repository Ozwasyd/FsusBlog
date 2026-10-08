using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Distributed;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;

namespace FsusBlog.Server.Infrastructure.Operations;

/// <summary>
/// Captures authoritative projection activity without draining, invalidating,
/// publishing or inferring current-run identity from caller-provided coordinates.
/// </summary>
public sealed class PublicProjectionQuiescenceSourceReader(
    PublicHotArtifactUpdateQueue? publicHot,
    PublicAotBackfillScheduler? publicAot,
    DistributedInvalidationIngressRuntimeState? ingress,
    IHotStatsInvalidationCoalescer? hotStats)
{
    public async Task<QuiescenceSourceCapture> ReadPublicHotAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        PublicHotActivitySnapshot? snapshot = publicHot is null
            ? null
            : await publicHot.CreateActivitySnapshotAsync(cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        var blockers = new List<string>
        {
            "current-run-namespace-and-runtime-identity=unavailable",
            "immutable-barrier-watermark-and-worker-incarnation=unavailable"
        };
        if (snapshot?.CurrentTargetGeneration is not { } target || target < 0)
        {
            blockers.Add("target-generation=unavailable-or-invalid");
        }
        else
        {
            // Keep the unique business predicate in its canonical PublicHot owner.
            blockers.AddRange(PublicHotQuiescence.Evaluate(snapshot, target).Blockers);
        }
        return QuiescenceSourceCapture.Create(
            "public-hot-obligation",
            "PublicHotArtifactUpdateQueue.CreateActivitySnapshotAsync+PublicHotQuiescence.Evaluate/v1",
            snapshot is not null && snapshot.CollectorError is null,
            new Dictionary<string, long?>
            {
                ["queued-count"] = snapshot?.QueuedCount,
                ["in-flight-batch-count"] = snapshot?.InFlightBatchCount,
                ["active-projector-count"] = snapshot?.ActiveProjectorCount,
                ["pending-obligation-count"] = snapshot?.PendingObligationCount,
                ["terminal-failure-count"] = snapshot?.FailedTerminalObligationCount,
                ["published-generation"] = snapshot?.PublishedGeneration,
                ["target-generation"] = snapshot?.CurrentTargetGeneration,
                ["revocation-pending-count"] = snapshot?.RevocationPendingCount,
                ["active-background-claim-count"] = snapshot?.ActiveBackgroundClaimCountForPublicHot
            }, blockers);
    }

    public QuiescenceSourceCapture ReadPublicAot(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        PublicAotBackfillQueueSnapshot? snapshot = publicAot?.Snapshot();
        return QuiescenceSourceCapture.Create(
            "public-aot-backfill-and-publish", "PublicAotBackfillScheduler.Snapshot/v1", snapshot is not null,
            new Dictionary<string, long?>
            {
                ["queued-count"] = snapshot?.QueuedCount,
                ["in-flight-count"] = snapshot?.InFlightCount,
                ["reservation-count"] = snapshot?.ReservationCount,
                ["durable-pending-count"] = snapshot?.DurablePendingCount,
                ["target-generation"] = snapshot?.TargetGeneration,
                ["terminal-failure-count"] = snapshot?.TerminalFailureCount,
                ["active-manifest-generation"] = null
            },
            ["current-run-namespace-and-runtime-identity=unavailable",
                "immutable-barrier-watermark-and-worker-incarnation=unavailable",
                "active-manifest-generation-and-overlay-commit=unavailable"]);
    }

    public QuiescenceSourceCapture ReadRedisInvalidation(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        DistributedInvalidationIngressSnapshot? snapshot = ingress?.Snapshot();
        return QuiescenceSourceCapture.Create(
            "redis-invalidation", "DistributedInvalidationIngressRuntimeState.Snapshot/v1", snapshot is not null,
            new Dictionary<string, long?>
            {
                ["queued-count"] = snapshot?.QueuedCount,
                ["in-flight-count"] = snapshot?.InFlightCount,
                ["pending-inbox-count"] = snapshot?.LedgerAvailable == true ? snapshot.PendingInboxCount : null,
                ["overflow-count"] = snapshot?.OverflowCount,
                ["unacknowledged-count"] = null,
                ["acked-generation"] = null,
                ["terminal-failure-count"] = null
            },
            ["current-run-namespace-and-runtime-identity=unavailable",
                "immutable-barrier-watermark-and-worker-incarnation=unavailable",
                "current-namespace-outbox-ack-and-terminal-ledger=unavailable",
                "source=last-ledger-poll-plus-live-ingress"]);
    }

    public async Task<QuiescenceSourceCapture> ReadCacheFlushAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        HotStatsInvalidationSnapshot? snapshot = null;
        var blockers = new List<string>
        {
            "current-run-namespace-and-runtime-identity=unavailable",
            "immutable-barrier-watermark-and-worker-incarnation=unavailable",
            "live-flush-in-flight-and-commit-postcondition=unavailable"
        };
        try
        {
            if (hotStats is not null)
            {
                snapshot = await hotStats.SnapshotAsync(cancellationToken).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception)
        {
            // Never substitute Snapshot() or zero when the authoritative shared read fails.
            blockers.Add("shared-cache-source=unavailable");
        }
        cancellationToken.ThrowIfCancellationRequested();
        return QuiescenceSourceCapture.Create(
            "runtime-cache-rebuild-or-flush", "IHotStatsInvalidationCoalescer.SnapshotAsync/v1", snapshot is not null,
            new Dictionary<string, long?>
            {
                ["hot-articles-version"] = snapshot?.HotArticlesVersion,
                ["stats-dirty"] = snapshot is null ? null : snapshot.StatsDirty ? 1 : 0,
                ["hot-articles-dirty"] = snapshot is null ? null : snapshot.HotArticlesDirty ? 1 : 0,
                ["stats-dirty-count"] = snapshot?.StatsDirtyCount,
                ["stats-flush-count"] = snapshot?.StatsFlushCount,
                ["hot-articles-dirty-count"] = snapshot?.HotArticlesDirtyCount,
                ["hot-articles-flush-count"] = snapshot?.HotArticlesFlushCount,
                ["in-flight-flush-count"] = null,
                ["terminal-failure-count"] = null
            }, blockers);
    }
}
