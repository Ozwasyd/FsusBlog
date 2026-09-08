using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Distributed;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Infrastructure.Plugins;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Services.Telemetry;
using FsusBlog.Server.Services.VisitLog;

namespace FsusBlog.Server.Infrastructure.Operations;

internal static class BoundedQueueParticipantReceipts
{
    public static BoundedQueueParticipantReceipt Counts(
        IBoundedQueueDrainCatalog catalog,
        string queueId,
        string runId,
        TimeProvider timeProvider,
        long queued,
        long inFlight,
        long durablePending,
        long terminalFailures,
        BoundedQueueCommitPostcondition postcondition,
        long generation = 0,
        long sequence = 0,
        BoundedQueueDropProof? dropProof = null,
        IReadOnlyList<string>? blockers = null)
    {
        BoundedChannelQueueContract contract = catalog.DrainParticipants.First(
            item => string.Equals(item.QueueId, queueId, StringComparison.Ordinal));
        return BoundedQueueParticipantReceipt.Create(
            contract.QueueId,
            contract.DeliveryClass,
            runId,
            generation,
            sequence,
            queued,
            inFlight,
            durablePending,
            terminalFailures,
            postcondition,
            dropProof,
            blockers,
            timeProvider.GetUtcNow());
    }
}

public sealed class AdminAuditBoundedQueueDrainParticipant(
    IBoundedQueueDrainCatalog catalog,
    AdminAuditLogChannel channel,
    TimeProvider timeProvider) : IBoundedQueueDrainParticipant
{
    public string QueueId => "admin-audit";

    public BoundedQueueParticipantReceipt Observe(string runId)
    {
        AdminAuditLogChannelSnapshot snapshot = channel.Snapshot();
        return BoundedQueueParticipantReceipts.Counts(
            catalog,
            QueueId,
            runId,
            timeProvider,
            snapshot.QueuedCount,
            snapshot.InFlightCount,
            snapshot.DurablePendingCount,
            snapshot.TerminalFailureCount,
            snapshot.TerminalFailureCount > 0
                ? BoundedQueueCommitPostcondition.Failed
                : BoundedQueueCommitPostcondition.Success,
            snapshot.Sequence,
            snapshot.Sequence);
    }
}

public sealed class ArticleAssetCleanupBoundedQueueDrainParticipant(
    IBoundedQueueDrainCatalog catalog,
    ArticleAssetCleanupQueue queue,
    TimeProvider timeProvider) : IBoundedQueueDrainParticipant
{
    public string QueueId => "article-asset-cleanup";

    public BoundedQueueParticipantReceipt Observe(string runId)
    {
        int queued = queue.QueuedCount;
        return BoundedQueueParticipantReceipts.Counts(
            catalog,
            QueueId,
            runId,
            timeProvider,
            queued,
            0,
            0,
            0,
            BoundedQueueCommitPostcondition.Success,
            dropProof: new BoundedQueueDropProof(
                "coalescible",
                "signal coalescing over durable cleanup rows",
                "ArticleAssetCleanupQueue.TryRequestScan"));
    }
}

public sealed class ArticleBodyRepairBoundedQueueDrainParticipant(
    IBoundedQueueDrainCatalog catalog,
    ArticleBodyRepairQueue queue,
    TimeProvider timeProvider) : IBoundedQueueDrainParticipant
{
    public string QueueId => "article-body-repair";

    public BoundedQueueParticipantReceipt Observe(string runId)
    {
        int pending = queue.PendingCount;
        return BoundedQueueParticipantReceipts.Counts(
            catalog,
            QueueId,
            runId,
            timeProvider,
            pending,
            0,
            0,
            0,
            BoundedQueueCommitPostcondition.Success,
            dropProof: new BoundedQueueDropProof(
                "coalescible",
                "article-id coalescing",
                "ArticleBodyRepairQueue._pending"));
    }
}

public sealed class ArticleDetailAedsBoundedQueueDrainParticipant(
    IBoundedQueueDrainCatalog catalog,
    ArticleDetailAedsArtifactBackfillScheduler scheduler,
    TimeProvider timeProvider) : IBoundedQueueDrainParticipant
{
    public string QueueId => "article-detail-aeds-backfill";

    public BoundedQueueParticipantReceipt Observe(string runId)
    {
        int pending = scheduler.PendingCount;
        return BoundedQueueParticipantReceipts.Counts(
            catalog,
            QueueId,
            runId,
            timeProvider,
            pending,
            0,
            0,
            0,
            BoundedQueueCommitPostcondition.Success,
            dropProof: new BoundedQueueDropProof(
                "coalescible",
                "article-key coalesced cache backfill",
                "ArticleDetailAedsArtifactBackfillScheduler._scheduled"));
    }
}

public sealed class AuditLogBoundedQueueDrainParticipant(
    IBoundedQueueDrainCatalog catalog,
    AuditLogChannel channel,
    TimeProvider timeProvider) : IBoundedQueueDrainParticipant
{
    public string QueueId => "audit-log-best-effort-lane";

    public BoundedQueueParticipantReceipt Observe(string runId)
    {
        AuditLogChannelSnapshot snapshot = channel.Snapshot();
        return BoundedQueueParticipantReceipts.Counts(
            catalog,
            QueueId,
            runId,
            timeProvider,
            snapshot.QueuedCount,
            snapshot.InFlightCount,
            snapshot.DurablePendingCount,
            snapshot.TerminalFailureCount,
            snapshot.TerminalFailureCount > 0
                ? BoundedQueueCommitPostcondition.Failed
                : BoundedQueueCommitPostcondition.Success,
            snapshot.Sequence,
            snapshot.Sequence);
    }
}

public sealed class ChallengeAuditHighValueBoundedQueueDrainParticipant(
    IBoundedQueueDrainCatalog catalog,
    ChallengeV2AuditEventQueue queue,
    TimeProvider timeProvider) : IBoundedQueueDrainParticipant
{
    public string QueueId => "challenge-audit-high-value";

    public BoundedQueueParticipantReceipt Observe(string runId)
    {
        ChallengeV2AuditEventQueueSnapshot snapshot = queue.Snapshot();
        return BoundedQueueParticipantReceipts.Counts(
            catalog,
            QueueId,
            runId,
            timeProvider,
            snapshot.HighValueQueuedCount,
            snapshot.InFlightCount,
            snapshot.DurablePendingCount,
            snapshot.TerminalFailureCount,
            snapshot.TerminalFailureCount > 0
                ? BoundedQueueCommitPostcondition.Failed
                : BoundedQueueCommitPostcondition.Success,
            snapshot.Sequence,
            snapshot.Sequence);
    }
}

public sealed class ChallengeAuditNormalBoundedQueueDrainParticipant(
    IBoundedQueueDrainCatalog catalog,
    ChallengeV2AuditEventQueue queue,
    TimeProvider timeProvider) : IBoundedQueueDrainParticipant
{
    public string QueueId => "challenge-audit-normal";

    public BoundedQueueParticipantReceipt Observe(string runId)
    {
        ChallengeV2AuditEventQueueSnapshot snapshot = queue.Snapshot();
        return BoundedQueueParticipantReceipts.Counts(
            catalog,
            QueueId,
            runId,
            timeProvider,
            snapshot.NormalQueuedCount,
            snapshot.InFlightCount,
            snapshot.DurablePendingCount,
            snapshot.TerminalFailureCount,
            snapshot.TerminalFailureCount > 0
                ? BoundedQueueCommitPostcondition.Failed
                : BoundedQueueCommitPostcondition.Success,
            snapshot.Sequence,
            snapshot.Sequence);
    }
}

public sealed class ContentFilterReloadBoundedQueueDrainParticipant(
    IBoundedQueueDrainCatalog catalog,
    IContentFilterService filter,
    TimeProvider timeProvider) : IBoundedQueueDrainParticipant
{
    public string QueueId => "content-filter-reload";

    public BoundedQueueParticipantReceipt Observe(string runId)
    {
        int queued = filter is ContentFilterService concrete
            ? concrete.ReloadQueuedCount
            : throw new InvalidOperationException("content_filter_observer_unavailable");
        return BoundedQueueParticipantReceipts.Counts(
            catalog,
            QueueId,
            runId,
            timeProvider,
            queued,
            0,
            0,
            0,
            BoundedQueueCommitPostcondition.Success,
            dropProof: new BoundedQueueDropProof(
                "coalescible",
                "DropOldest newest file signal retained",
                "ContentFilterService.ReloadFromWatcherAsync"));
    }
}

public sealed class DistributedInvalidationIngressBoundedQueueDrainParticipant(
    IBoundedQueueDrainCatalog catalog,
    DistributedInvalidationIngressRuntimeState ingress,
    TimeProvider timeProvider) : IBoundedQueueDrainParticipant
{
    public string QueueId => "distributed-invalidation-ingress";

    public BoundedQueueParticipantReceipt Observe(string runId)
    {
        DistributedInvalidationIngressSnapshot snapshot = ingress.Snapshot();
        BoundedQueueCommitPostcondition postcondition = !snapshot.LedgerAvailable || snapshot.Degraded
            ? BoundedQueueCommitPostcondition.Failed
            : BoundedQueueCommitPostcondition.Success;
        return BoundedQueueParticipantReceipts.Counts(
            catalog,
            QueueId,
            runId,
            timeProvider,
            snapshot.QueuedCount,
            snapshot.InFlightCount,
            snapshot.PendingInboxCount,
            snapshot.Degraded ? 1 : 0,
            postcondition,
            sequence: snapshot.OverflowCount);
    }
}

public sealed class JavaScriptEnginePoolBoundedQueueDrainParticipant(
    IBoundedQueueDrainCatalog catalog,
    IJavaScriptPluginRuntime runtime,
    TimeProvider timeProvider) : IBoundedQueueDrainParticipant
{
    public string QueueId => "javascript-engine-pool";

    public BoundedQueueParticipantReceipt Observe(string runId)
    {
        IReadOnlyList<JavaScriptPluginRuntimeSnapshot> snapshots = runtime is JavaScriptPluginRuntime concrete
            ? concrete.GetLoadedSnapshots()
            : throw new InvalidOperationException("javascript_engine_observer_unavailable");
        long inFlight = snapshots.Sum(static item => item.ActiveLeases);
        long terminal = snapshots.Sum(static item => item.PoisonedEngines);
        return BoundedQueueParticipantReceipts.Counts(
            catalog,
            QueueId,
            runId,
            timeProvider,
            0,
            inFlight,
            0,
            terminal,
            terminal > 0 ? BoundedQueueCommitPostcondition.Failed : BoundedQueueCommitPostcondition.Success,
            sequence: snapshots.Sum(static item => item.CreatedEngines));
    }
}

public sealed class NotificationConnectionBoundedQueueDrainParticipant(
    IBoundedQueueDrainCatalog catalog,
    NotificationStreamConnectionManager connections,
    TimeProvider timeProvider) : IBoundedQueueDrainParticipant
{
    public string QueueId => "notification-connection";

    public BoundedQueueParticipantReceipt Observe(string runId)
    {
        NotificationStreamDeliverySnapshot snapshot = connections.DeliverySnapshot;
        return BoundedQueueParticipantReceipts.Counts(
            catalog,
            QueueId,
            runId,
            timeProvider,
            snapshot.Queued,
            snapshot.InFlight,
            snapshot.ReplayRequired + snapshot.ReplayReadFailures,
            snapshot.TerminalFailures,
            snapshot.TerminalFailures > 0 || snapshot.ReplayReadFailures > 0
                ? BoundedQueueCommitPostcondition.Failed
                : BoundedQueueCommitPostcondition.Success,
            snapshot.Sequence,
            snapshot.Sequence);
    }
}

public sealed class NotificationFanoutLosslessBoundedQueueDrainParticipant(
    IBoundedQueueDrainCatalog catalog,
    NotificationStreamLocalFanoutQueue fanout,
    TimeProvider timeProvider) : IBoundedQueueDrainParticipant
{
    public string QueueId => "notification-fanout-lossless";

    public BoundedQueueParticipantReceipt Observe(string runId)
    {
        NotificationStreamFanoutLaneSnapshot lanes = fanout.LaneSnapshot();
        NotificationStreamDeliverySnapshot delivery = fanout.DeliverySnapshot;
        return BoundedQueueParticipantReceipts.Counts(
            catalog,
            QueueId,
            runId,
            timeProvider,
            lanes.LosslessQueued,
            delivery.InFlight,
            delivery.ReplayRequired,
            delivery.TerminalFailures,
            delivery.TerminalFailures > 0
                ? BoundedQueueCommitPostcondition.Failed
                : BoundedQueueCommitPostcondition.Success,
            lanes.Sequence,
            lanes.Sequence);
    }
}

public sealed class NotificationFanoutLowBoundedQueueDrainParticipant(
    IBoundedQueueDrainCatalog catalog,
    NotificationStreamLocalFanoutQueue fanout,
    TimeProvider timeProvider) : IBoundedQueueDrainParticipant
{
    public string QueueId => "notification-fanout-low";

    public BoundedQueueParticipantReceipt Observe(string runId)
    {
        NotificationStreamFanoutLaneSnapshot lanes = fanout.LaneSnapshot();
        return BoundedQueueParticipantReceipts.Counts(
            catalog,
            QueueId,
            runId,
            timeProvider,
            lanes.LowQueued,
            0,
            0,
            0,
            BoundedQueueCommitPostcondition.Success,
            lanes.Sequence,
            lanes.Sequence,
            new BoundedQueueDropProof(
                "best-effort",
                "typed DiagnosticDropped for low-priority diagnostics",
                "NotificationStreamFanoutEnqueueStatus.DiagnosticDropped"));
    }
}

public sealed class NotificationFanoutStateBoundedQueueDrainParticipant(
    IBoundedQueueDrainCatalog catalog,
    NotificationStreamLocalFanoutQueue fanout,
    TimeProvider timeProvider) : IBoundedQueueDrainParticipant
{
    public string QueueId => "notification-fanout-state";

    public BoundedQueueParticipantReceipt Observe(string runId)
    {
        NotificationStreamFanoutLaneSnapshot lanes = fanout.LaneSnapshot();
        return BoundedQueueParticipantReceipts.Counts(
            catalog,
            QueueId,
            runId,
            timeProvider,
            lanes.StateQueued,
            0,
            0,
            0,
            BoundedQueueCommitPostcondition.Success,
            lanes.Sequence,
            lanes.Sequence,
            new BoundedQueueDropProof(
                "coalescible",
                "latest-item per coalescing key",
                "item.CoalescingKey"));
    }
}

public sealed class PublicAotBackfillBoundedQueueDrainParticipant(
    IBoundedQueueDrainCatalog catalog,
    PublicAotBackfillScheduler scheduler,
    TimeProvider timeProvider) : IBoundedQueueDrainParticipant
{
    public string QueueId => "public-aot-backfill";

    public BoundedQueueParticipantReceipt Observe(string runId)
    {
        PublicAotBackfillQueueSnapshot snapshot = scheduler.Snapshot();
        return BoundedQueueParticipantReceipts.Counts(
            catalog,
            QueueId,
            runId,
            timeProvider,
            snapshot.QueuedCount,
            snapshot.InFlightCount,
            snapshot.DurablePendingCount,
            snapshot.TerminalFailureCount,
            snapshot.TerminalFailureCount > 0
                ? BoundedQueueCommitPostcondition.Failed
                : BoundedQueueCommitPostcondition.Success,
            snapshot.TargetGeneration,
            snapshot.TargetGeneration,
            new BoundedQueueDropProof(
                "coalescible",
                "maximum-version coalescing",
                "existingVersion >= version"));
    }
}

public sealed class PublicHotArtifactUpdateBoundedQueueDrainParticipant(
    IBoundedQueueDrainCatalog catalog,
    PublicHotArtifactUpdateQueue queue,
    TimeProvider timeProvider) : IBoundedQueueDrainParticipant
{
    public string QueueId => "public-hot-artifact-update";

    public BoundedQueueParticipantReceipt Observe(string runId)
    {
        PublicHotActivitySnapshot snapshot = queue.CreateActivitySnapshot();
        if (!string.IsNullOrWhiteSpace(snapshot.CollectorError)
            || snapshot.QueuedCount is null
            || snapshot.InFlightBatchCount is null
            || snapshot.PendingObligationCount is null
            || snapshot.FailedTerminalObligationCount is null)
        {
            return BoundedQueueParticipantReceipts.Counts(
                catalog,
                QueueId,
                runId,
                timeProvider,
                snapshot.QueuedCount ?? 0,
                snapshot.InFlightBatchCount ?? 0,
                snapshot.PendingObligationCount ?? 0,
                snapshot.FailedTerminalObligationCount ?? 0,
                BoundedQueueCommitPostcondition.Unknown,
                snapshot.PublishedGeneration ?? 0,
                snapshot.CurrentTargetGeneration ?? 0,
                blockers: ["public_hot_activity_unavailable"]);
        }

        PublicHotQuiescenceResult quiescence = PublicHotQuiescence.Evaluate(
            snapshot,
            snapshot.CurrentTargetGeneration ?? 0);
        return BoundedQueueParticipantReceipts.Counts(
            catalog,
            QueueId,
            runId,
            timeProvider,
            snapshot.QueuedCount.Value,
            snapshot.InFlightBatchCount.Value,
            snapshot.PendingObligationCount.Value + (snapshot.RevocationPendingCount ?? 0),
            snapshot.FailedTerminalObligationCount.Value,
            quiescence.Drained
                ? BoundedQueueCommitPostcondition.Success
                : BoundedQueueCommitPostcondition.Failed,
            snapshot.PublishedGeneration ?? 0,
            snapshot.CurrentTargetGeneration ?? 0,
            blockers: quiescence.Blockers);
    }
}

public sealed class RumTelemetryBoundedQueueDrainParticipant(
    IBoundedQueueDrainCatalog catalog,
    RumTelemetryChannel channel,
    TimeProvider timeProvider) : IBoundedQueueDrainParticipant
{
    public string QueueId => "rum-telemetry";

    public BoundedQueueParticipantReceipt Observe(string runId)
    {
        RumTelemetryChannelSnapshot snapshot = channel.CreateSnapshot();
        return BoundedQueueParticipantReceipts.Counts(
            catalog,
            QueueId,
            runId,
            timeProvider,
            snapshot.QueuedBatches,
            0,
            0,
            0,
            BoundedQueueCommitPostcondition.Success,
            sequence: snapshot.AcceptedBatches,
            dropProof: new BoundedQueueDropProof(
                "best-effort",
                "DropOldest newest performance sample retained",
                "RumTelemetryChannel_WhenFull_DropsOldestAndKeepsNewest"));
    }
}

public sealed class SecurityRiskEventBoundedQueueDrainParticipant(
    IBoundedQueueDrainCatalog catalog,
    SecurityRiskEventWriteQueue queue,
    TimeProvider timeProvider) : IBoundedQueueDrainParticipant
{
    public string QueueId => "security-risk-event";

    public BoundedQueueParticipantReceipt Observe(string runId)
    {
        SecurityRiskEventWriteQueueSnapshot snapshot = queue.Snapshot();
        return BoundedQueueParticipantReceipts.Counts(
            catalog,
            QueueId,
            runId,
            timeProvider,
            snapshot.QueuedCount,
            snapshot.InFlightCount,
            snapshot.DurablePendingCount,
            snapshot.TerminalFailureCount,
            snapshot.TerminalFailureCount > 0
                ? BoundedQueueCommitPostcondition.Failed
                : BoundedQueueCommitPostcondition.Success,
            snapshot.Sequence,
            snapshot.Sequence);
    }
}

public sealed class UploadSessionCleanupBoundedQueueDrainParticipant(
    IBoundedQueueDrainCatalog catalog,
    UploadSessionCleanupQueue queue,
    TimeProvider timeProvider) : IBoundedQueueDrainParticipant
{
    public string QueueId => "upload-session-cleanup";

    public BoundedQueueParticipantReceipt Observe(string runId)
    {
        int queued = queue.PendingSignalCount - queue.InFlightCount;
        return BoundedQueueParticipantReceipts.Counts(
            catalog,
            QueueId,
            runId,
            timeProvider,
            queued,
            queue.InFlightCount,
            0,
            0,
            BoundedQueueCommitPostcondition.Success,
            dropProof: new BoundedQueueDropProof(
                "coalescible",
                "overflowed signal coalesces scan demand",
                "Volatile.Write(ref _overflowedSignal, 1)"));
    }
}

public sealed class VisitLogBoundedQueueDrainParticipant(
    IBoundedQueueDrainCatalog catalog,
    VisitLogChannel channel,
    TimeProvider timeProvider) : IBoundedQueueDrainParticipant
{
    public string QueueId => "visit-log";

    public BoundedQueueParticipantReceipt Observe(string runId)
    {
        return BoundedQueueParticipantReceipts.Counts(
            catalog,
            QueueId,
            runId,
            timeProvider,
            channel.QueuedCount,
            0,
            0,
            0,
            BoundedQueueCommitPostcondition.Success,
            sequence: channel.SaturatedWriteCount,
            dropProof: new BoundedQueueDropProof(
                "best-effort",
                "DropOldest approximate popularity sampling",
                "SaturatedWriteCount"));
    }
}
