using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Services.Telemetry;
using FsusBlog.Server.Services.VisitLog;

namespace FsusBlog.Server.Infrastructure.Operations;

public sealed record ReleaseDrainParticipantSnapshot(
    string Name,
    string Classification,
    long PendingCount,
    string Status,
    TimeSpan MaxDrain,
    string ReplaySource,
    string? ErrorCode = null,
    IReadOnlyList<string>? Blockers = null);

public sealed record ReleaseDrainRunResult(
    bool Drained,
    bool TimedOut,
    DateTimeOffset CompletedAtUtc,
    IReadOnlyList<ReleaseDrainParticipantSnapshot> Participants);

public interface IReleaseDrainParticipant
{
    string Name
    {
        get;
    }

    TimeSpan MaxDrain
    {
        get;
    }

    ReleaseDrainParticipantSnapshot Snapshot();

    Task DrainAsync(CancellationToken cancellationToken);
}

public sealed class ReleaseDrainParticipantRegistry(
    IEnumerable<IReleaseDrainParticipant> participants,
    TimeProvider timeProvider,
    ILogger<ReleaseDrainParticipantRegistry> logger)
{
    private readonly IReleaseDrainParticipant[] _participants = participants
        .OrderBy(static participant => participant.Name, StringComparer.Ordinal)
        .ToArray();

    public IReadOnlyList<ReleaseDrainParticipantSnapshot> Snapshot()
        => _participants.Select(static participant => participant.Snapshot()).ToArray();

    public async Task<ReleaseDrainRunResult> DrainAsync(
        TimeSpan globalTimeout,
        CancellationToken cancellationToken = default)
    {
        using CancellationTokenSource global = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        global.CancelAfter(globalTimeout);
        Task<ReleaseDrainParticipantSnapshot>[] drains = _participants
            .Select(participant => DrainOneAsync(participant, global.Token))
            .ToArray();
        ReleaseDrainParticipantSnapshot[] snapshots = await Task.WhenAll(drains).ConfigureAwait(false);
        Array.Sort(snapshots, static (left, right) => StringComparer.Ordinal.Compare(left.Name, right.Name));
        bool timedOut = global.IsCancellationRequested
            || snapshots.Any(static participant => string.Equals(participant.ErrorCode, "drain_timeout", StringComparison.Ordinal));
        bool drained = !timedOut
            && snapshots.All(static participant => participant.PendingCount == 0 && participant.ErrorCode is null);
        return new ReleaseDrainRunResult(drained, timedOut, timeProvider.GetUtcNow(), snapshots);
    }

    private async Task<ReleaseDrainParticipantSnapshot> DrainOneAsync(
        IReleaseDrainParticipant participant,
        CancellationToken globalToken)
    {
        using CancellationTokenSource bounded = CancellationTokenSource.CreateLinkedTokenSource(globalToken);
        bounded.CancelAfter(participant.MaxDrain);
        try
        {
            await participant.DrainAsync(bounded.Token).ConfigureAwait(false);
            return participant.Snapshot();
        }
        catch (OperationCanceledException) when (bounded.IsCancellationRequested)
        {
            logger.LogWarning("release-drain-participant-timeout {Participant}", participant.Name);
            ReleaseDrainParticipantSnapshot snapshot = participant.Snapshot();
            return snapshot with
            {
                Status = "timed-out",
                ErrorCode = "drain_timeout"
            };
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "release-drain-participant-failed {Participant}", participant.Name);
            ReleaseDrainParticipantSnapshot snapshot = participant.Snapshot();
            return snapshot with
            {
                Status = "failed",
                ErrorCode = "drain_failed"
            };
        }
    }
}

public sealed class ArticleViewReleaseDrainParticipant(IArticleViewWriteBuffer buffer) : IReleaseDrainParticipant
{
    public string Name => "article-view";

    public TimeSpan MaxDrain => TimeSpan.FromSeconds(10);

    public ReleaseDrainParticipantSnapshot Snapshot()
    {
        ArticleViewBufferSnapshot snapshot = buffer is ArticleViewWriteBuffer concrete
            ? concrete.CreateSnapshot()
            : new ArticleViewBufferSnapshot(0, 0);
        return new ReleaseDrainParticipantSnapshot(
            Name,
            "multi-consumer-safe",
            snapshot.PendingDelta,
            snapshot.PendingDelta == 0 ? "drained" : "pending",
            MaxDrain,
            "database delta reconciliation");
    }

    public async Task DrainAsync(CancellationToken cancellationToken)
    {
        while (Snapshot().PendingCount > 0)
        {
            await buffer.FlushAsync(cancellationToken).ConfigureAwait(false);
        }
    }
}

public sealed class HotStatsReleaseDrainParticipant(HotStatsInvalidationCoalescer coalescer) : IReleaseDrainParticipant
{
    public string Name => "hot-stats-invalidation";

    public TimeSpan MaxDrain => TimeSpan.FromSeconds(5);

    public ReleaseDrainParticipantSnapshot Snapshot()
    {
        HotStatsInvalidationSnapshot snapshot = coalescer.Snapshot();
        long pending = (snapshot.StatsDirty ? 1 : 0) + (snapshot.HotArticlesDirty ? 1 : 0);
        return new ReleaseDrainParticipantSnapshot(
            Name,
            "instance-local",
            pending,
            pending == 0 ? "drained" : "pending",
            MaxDrain,
            "shared cache version counters");
    }

    public Task DrainAsync(CancellationToken cancellationToken)
        => coalescer.FlushPendingAsync(cancellationToken);
}

public sealed class NotificationStreamReleaseDrainParticipant(
    NotificationStreamRestartCoordinator restart,
    NotificationStreamConnectionManager connections,
    TimeProvider timeProvider) : IReleaseDrainParticipant
{
    public string Name => "notification-stream";

    public TimeSpan MaxDrain => TimeSpan.FromSeconds(10);

    public ReleaseDrainParticipantSnapshot Snapshot()
    {
        int pending = connections.ConnectionCount;
        return new ReleaseDrainParticipantSnapshot(
            Name,
            "multi-consumer-safe",
            pending,
            pending == 0 ? "drained" : restart.IsRestartRequested ? "closing-1012" : "accepting",
            MaxDrain,
            "Redis notification backlog; replay miss forces full resync");
    }

    public async Task DrainAsync(CancellationToken cancellationToken)
    {
        NotificationStreamRestartSnapshot current = restart.Current;
        NotificationStreamRestartSnapshot requested = restart.RequestRestart(new NotificationStreamRestartRequest(
            current.ReleaseId,
            current.Slot,
            current.Generation,
            "deployment_drain"));
        if (!requested.Accepted)
        {
            throw new InvalidOperationException(requested.ErrorCode ?? "notification_restart_rejected");
        }

        while (connections.ConnectionCount > 0)
        {
            await Task.Delay(TimeSpan.FromMilliseconds(50), timeProvider, cancellationToken).ConfigureAwait(false);
        }
    }
}

public abstract class PollingReleaseDrainParticipant(TimeProvider timeProvider) : IReleaseDrainParticipant
{
    public abstract string Name
    {
        get;
    }

    public abstract TimeSpan MaxDrain
    {
        get;
    }

    protected abstract string Classification
    {
        get;
    }

    protected abstract string ReplaySource
    {
        get;
    }

    protected abstract long ReadPendingCount();

    public virtual ReleaseDrainParticipantSnapshot Snapshot()
    {
        long pending = Math.Max(0, ReadPendingCount());
        return new ReleaseDrainParticipantSnapshot(
            Name,
            Classification,
            pending,
            pending == 0 ? "drained" : "pending",
            MaxDrain,
            ReplaySource);
    }

    public virtual async Task DrainAsync(CancellationToken cancellationToken)
    {
        while (ReadPendingCount() > 0)
        {
            await Task.Delay(TimeSpan.FromMilliseconds(50), timeProvider, cancellationToken).ConfigureAwait(false);
        }
    }
}

public sealed class AuditLogReleaseDrainParticipant(AuditLogChannel channel, TimeProvider timeProvider)
    : PollingReleaseDrainParticipant(timeProvider)
{
    public override string Name => "audit-log";
    public override TimeSpan MaxDrain => TimeSpan.FromSeconds(10);
    protected override string Classification => "multi-consumer-safe";
    protected override string ReplaySource => "structured application log";
    protected override long ReadPendingCount() => channel.Snapshot().QueuedCount;
}

public sealed class AdminAuditLogReleaseDrainParticipant(AdminAuditLogChannel channel, TimeProvider timeProvider)
    : PollingReleaseDrainParticipant(timeProvider)
{
    public override string Name => "admin-audit-log";
    public override TimeSpan MaxDrain => TimeSpan.FromSeconds(10);
    protected override string Classification => "multi-consumer-safe";
    protected override string ReplaySource => "high-value audit fallback log";
    protected override long ReadPendingCount() => channel.QueuedCount;
}

public sealed class VisitLogReleaseDrainParticipant(VisitLogChannel channel, TimeProvider timeProvider)
    : PollingReleaseDrainParticipant(timeProvider)
{
    public override string Name => "visit-log";
    public override TimeSpan MaxDrain => TimeSpan.FromSeconds(10);
    protected override string Classification => "multi-consumer-safe";
    protected override string ReplaySource => "request log evidence";
    protected override long ReadPendingCount() => channel.QueuedCount;
}

public sealed class RumTelemetryReleaseDrainParticipant(RumTelemetryChannel channel, TimeProvider timeProvider)
    : PollingReleaseDrainParticipant(timeProvider)
{
    public override string Name => "rum-telemetry";
    public override TimeSpan MaxDrain => TimeSpan.FromSeconds(5);
    protected override string Classification => "multi-consumer-safe";
    protected override string ReplaySource => "browser retry";
    protected override long ReadPendingCount() => channel.CreateSnapshot().QueuedBatches;
}

public sealed class SecurityRiskReleaseDrainParticipant(SecurityRiskEventWriteQueue queue, TimeProvider timeProvider)
    : PollingReleaseDrainParticipant(timeProvider)
{
    public override string Name => "security-risk";
    public override TimeSpan MaxDrain => TimeSpan.FromSeconds(10);
    protected override string Classification => "multi-consumer-safe";
    protected override string ReplaySource => "security audit log";
    protected override long ReadPendingCount() => queue.Snapshot().QueuedCount;
}

public sealed class ChallengeAuditReleaseDrainParticipant(ChallengeV2AuditEventQueue queue, TimeProvider timeProvider)
    : PollingReleaseDrainParticipant(timeProvider)
{
    public override string Name => "challenge-v2-audit";
    public override TimeSpan MaxDrain => TimeSpan.FromSeconds(5);
    protected override string Classification => "multi-consumer-safe";
    protected override string ReplaySource => "challenge attempt store";
    protected override long ReadPendingCount()
    {
        ChallengeV2AuditEventQueueSnapshot snapshot = queue.Snapshot();
        return snapshot.NormalQueuedCount + snapshot.HighValueQueuedCount;
    }
}

public sealed class PublicHotUpdateReleaseDrainParticipant(
    PublicHotArtifactUpdateQueue queue,
    TimeProvider timeProvider) : IReleaseDrainParticipant
{
    private static readonly TimeSpan s_minimumObservationInterval = TimeSpan.FromMilliseconds(50);
    private long _requestedDrainGeneration;
    private PublicHotActivitySnapshot? _lastObservation;

    public string Name => "public-hot-update";

    public TimeSpan MaxDrain => TimeSpan.FromSeconds(15);

    public ReleaseDrainParticipantSnapshot Snapshot()
    {
        PublicHotActivitySnapshot? observation = _lastObservation;
        if (observation is null)
        {
            return new ReleaseDrainParticipantSnapshot(
                Name,
                "instance-local",
                1,
                "unknown",
                MaxDrain,
                "full database projection",
                "public_hot_activity_unavailable");
        }

        long target = ResolveTargetGeneration(observation);
        PublicHotQuiescenceResult quiescence = PublicHotQuiescence.Evaluate(observation, target);
        return new ReleaseDrainParticipantSnapshot(
            Name,
            "instance-local",
            quiescence.Drained ? 0 : 1,
            quiescence.Drained ? "drained" : "blocked",
            MaxDrain,
            "full database projection",
            quiescence.Drained ? null : "public_hot_not_quiescent",
            quiescence.Blockers);
    }

    public async Task DrainAsync(CancellationToken cancellationToken)
    {
        PublicHotActivitySnapshot previous = await ObserveAsync(cancellationToken).ConfigureAwait(false);
        bool previousDrained = Evaluate(previous);
        while (true)
        {
            await Task.Delay(s_minimumObservationInterval, timeProvider, cancellationToken).ConfigureAwait(false);
            PublicHotActivitySnapshot current = await ObserveAsync(cancellationToken).ConfigureAwait(false);
            bool currentDrained = Evaluate(current);
            // Drain completes only after two consecutive observations (spaced at
            // least one worker scheduling tick) both satisfy quiescence and neither
            // the published generation nor the requested target moved in between.
            if (currentDrained
                && previousDrained
                && current.PublishedGeneration == previous.PublishedGeneration
                && current.CurrentTargetGeneration == previous.CurrentTargetGeneration)
            {
                return;
            }

            previous = current;
            previousDrained = currentDrained;
        }
    }

    private async Task<PublicHotActivitySnapshot> ObserveAsync(CancellationToken cancellationToken)
    {
        PublicHotActivitySnapshot snapshot = await queue
            .CreateActivitySnapshotAsync(cancellationToken)
            .ConfigureAwait(false);
        Volatile.Write(ref _lastObservation, snapshot);
        if (snapshot.CurrentTargetGeneration is long target && target > _requestedDrainGeneration)
        {
            InterlockedExchangeMax(ref _requestedDrainGeneration, target);
        }

        return snapshot;
    }

    private bool Evaluate(PublicHotActivitySnapshot snapshot)
        => PublicHotQuiescence.Evaluate(snapshot, ResolveTargetGeneration(snapshot)).Drained;

    private long ResolveTargetGeneration(PublicHotActivitySnapshot snapshot)
    {
        if (snapshot.CurrentTargetGeneration is long target && target > _requestedDrainGeneration)
        {
            InterlockedExchangeMax(ref _requestedDrainGeneration, target);
        }

        return _requestedDrainGeneration;
    }

    private static void InterlockedExchangeMax(ref long location, long value)
    {
        long current = Volatile.Read(ref location);
        while (value > current)
        {
            long observed = Interlocked.CompareExchange(ref location, value, current);
            if (observed == current)
            {
                return;
            }

            current = observed;
        }
    }
}

public sealed class ArticleDetailAedsReleaseDrainParticipant(
    ArticleDetailAedsArtifactBackfillScheduler scheduler,
    TimeProvider timeProvider) : PollingReleaseDrainParticipant(timeProvider)
{
    public override string Name => "article-detail-aeds";
    public override TimeSpan MaxDrain => TimeSpan.FromSeconds(15);
    protected override string Classification => "instance-local";
    protected override string ReplaySource => "article database projection";
    protected override long ReadPendingCount() => scheduler.PendingCount;
}

public sealed class PublicAotBackfillReleaseDrainParticipant(
    PublicAotBackfillScheduler scheduler,
    TimeProvider timeProvider) : PollingReleaseDrainParticipant(timeProvider)
{
    public override string Name => "public-aot-backfill";
    public override TimeSpan MaxDrain => TimeSpan.FromSeconds(20);
    protected override string Classification => "active-singleton";
    protected override string ReplaySource => "public AOT route registry";
    protected override long ReadPendingCount() => scheduler.InFlightCount;
}

public sealed class UploadCleanupReleaseDrainParticipant(
    UploadSessionCleanupQueue queue,
    TimeProvider timeProvider) : PollingReleaseDrainParticipant(timeProvider)
{
    public override string Name => "upload-cleanup";
    public override TimeSpan MaxDrain => TimeSpan.FromSeconds(15);
    protected override string Classification => "active-singleton";
    protected override string ReplaySource => "durable upload session manifests and expiration index";
    protected override long ReadPendingCount() => queue.PendingSignalCount;

    public override Task DrainAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return base.DrainAsync(cancellationToken);
    }
}
