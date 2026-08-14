using System.Threading.Channels;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Distributed;
using FsusBlog.Server.Infrastructure.Operations;

using Microsoft.Extensions.Options;

namespace FsusBlog.Server.Infrastructure.PublicReadArtifacts;

[Flags]
public enum PublicHotArtifactDirtyReason
{
    Unknown = 0,
    Content = 1,
    ViewProjection = 2,
    ScheduledPublish = 4
}

public enum PublicHotArtifactDeliveryClass
{
    RequiredContent,
    RequiredTaxonomy,
    BestEffortView,
    FullRebuildMarker
}

public enum PublicHotArtifactDeliveryStatus
{
    Accepted,
    PersistedDirty,
    Coalesced,
    Cancelled,
    Closed,
    Failed
}

public readonly record struct PublicHotArtifactUpdate(
    int? ArticleId,
    string Reason,
    PublicHotArtifactDirtyReason DirtyReason,
    long? ExpectedReleaseId = null,
    long DeliveryGeneration = 0,
    PublicHotArtifactDeliveryClass DeliveryClass = PublicHotArtifactDeliveryClass.RequiredContent);

public readonly record struct PublicHotArtifactEnqueueResult(
    PublicHotArtifactDeliveryStatus Status,
    string Reason,
    PublicHotArtifactDirtyReason DirtyReason,
    long DeliveryGeneration = 0,
    string? ObligationId = null);

public static class PublicHotArtifactDeliveryReceipt
{
    public static void RequireDurable(PublicHotArtifactEnqueueResult result, string operation)
    {
        switch (result.Status)
        {
            case PublicHotArtifactDeliveryStatus.Accepted:
            case PublicHotArtifactDeliveryStatus.PersistedDirty:
            case PublicHotArtifactDeliveryStatus.Coalesced:
                return;
            case PublicHotArtifactDeliveryStatus.Cancelled:
                throw new OperationCanceledException($"public-hot delivery cancelled: {operation}");
            case PublicHotArtifactDeliveryStatus.Closed:
                throw new InvalidOperationException($"public-hot delivery channel closed: {operation}");
            case PublicHotArtifactDeliveryStatus.Failed:
                throw new InvalidOperationException($"public-hot delivery persistence failed: {operation}");
            default:
                throw new InvalidOperationException($"public-hot delivery status is unknown: {operation}");
        }
    }
}

public sealed class PublicHotArtifactUpdateQueue
{
    private readonly Channel<PublicHotArtifactUpdate> _channel;
    private readonly IPublicHotArtifactDeliveryStateStore _deliveryState;
    private readonly IPublicHotArtifactObligationStore? _obligations;
    private readonly PublicHotReadStore? _store;
    private readonly PublicArtifactRevocationRegistry? _revocations;
    private int _inFlightBatchCount;
    private int _activeProjectorCount;
    private int _activeBackgroundClaimCountForPublicHot;
    private long _lastPublishedGeneration;
    private PublicHotActivitySnapshot? _lastActivitySnapshot;

    public PublicHotArtifactUpdateQueue(
        IOptions<PublicHotReadOptions> options,
        IPublicHotArtifactDeliveryStateStore deliveryState,
        IPublicHotArtifactObligationStore? obligations = null,
        PublicHotReadStore? store = null,
        PublicArtifactRevocationRegistry? revocations = null)
    {
        _deliveryState = deliveryState;
        _store = store;
        _revocations = revocations;
        // Redis is the production durability owner. The in-memory state remains
        // the legacy deterministic test double for watermark compatibility.
        _obligations = obligations ?? (deliveryState is RedisPublicHotArtifactDeliveryStateStore
            ? deliveryState as IPublicHotArtifactObligationStore
            : null);
        int capacity = Math.Clamp(options.Value.UpdateQueueCapacity, 1, 65_536);
        _channel = Channel.CreateBounded<PublicHotArtifactUpdate>(new BoundedChannelOptions(capacity)
        {
            FullMode = BoundedChannelFullMode.Wait,
            SingleReader = true,
            SingleWriter = false
        });
    }

    public async Task<PublicHotArtifactEnqueueResult> EnqueueAsync(
        PublicHotArtifactDeliveryClass deliveryClass,
        int? articleId,
        string reason,
        long? expectedReleaseId = null,
        CancellationToken cancellationToken = default)
    {
        string normalized = string.IsNullOrWhiteSpace(reason) ? "unknown" : reason;
        PublicHotArtifactDirtyReason dirtyReason = ClassifyReason(normalized);
        if (deliveryClass == PublicHotArtifactDeliveryClass.BestEffortView)
        {
            dirtyReason = PublicHotArtifactDirtyReason.ViewProjection;
        }

        long generation;
        string? obligationId = null;
        try
        {
            // The obligation is written before the channel wake-up. Production never
            // recovers from this channel; it only uses it to reduce replay latency.
            if (_obligations is { } obligations)
            {
                PublicHotArtifactObligation obligation = await obligations.MergeAsync(
                    new PublicHotArtifactUpdate(articleId, normalized, dirtyReason, expectedReleaseId, 0, deliveryClass),
                    cancellationToken).ConfigureAwait(false);
                generation = obligation.TargetGeneration;
                obligationId = obligation.ObligationId;
            }
            else
            {
                generation = await _deliveryState.MarkDirtyAsync(deliveryClass, cancellationToken).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException)
        {
            return new(PublicHotArtifactDeliveryStatus.Cancelled, normalized, dirtyReason);
        }
        catch
        {
            return new(PublicHotArtifactDeliveryStatus.Failed, normalized, dirtyReason);
        }

        if (cancellationToken.IsCancellationRequested)
        {
            return new(PublicHotArtifactDeliveryStatus.Cancelled, normalized, dirtyReason, generation, obligationId);
        }

        var update = new PublicHotArtifactUpdate(
            articleId,
            normalized,
            dirtyReason,
            expectedReleaseId,
            generation,
            deliveryClass);
        if (_channel.Writer.TryWrite(update))
        {
            return new(PublicHotArtifactDeliveryStatus.Accepted, normalized, dirtyReason, generation, obligationId);
        }

        ValueTask<bool> waitToWrite = _channel.Writer.WaitToWriteAsync(CancellationToken.None);
        if (waitToWrite.IsCompletedSuccessfully && !waitToWrite.Result)
        {
            return new(PublicHotArtifactDeliveryStatus.Closed, normalized, dirtyReason, generation, obligationId);
        }

        // A full bounded channel never changes the durable outcome into a drop.
        // The next worker cycle consumes this pending generation as a full rebuild.
        PublicHotArtifactDeliveryStatus status =
            deliveryClass == PublicHotArtifactDeliveryClass.FullRebuildMarker
                ? PublicHotArtifactDeliveryStatus.Coalesced
                : PublicHotArtifactDeliveryStatus.PersistedDirty;
        return new(status, normalized, dirtyReason, generation, obligationId);
    }

    internal ChannelReader<PublicHotArtifactUpdate> Reader => _channel.Reader;

    public int QueuedCount => _channel.Reader.CanCount ? _channel.Reader.Count : 0;

    internal void RecordBatchStarted() => Interlocked.Increment(ref _inFlightBatchCount);

    internal void RecordBatchFinished()
    {
        int remaining = Interlocked.Decrement(ref _inFlightBatchCount);
        if (remaining < 0)
        {
            Interlocked.Exchange(ref _inFlightBatchCount, 0);
        }
    }

    internal void RecordProjectorStarted() => Interlocked.Increment(ref _activeProjectorCount);

    internal void RecordProjectorFinished()
    {
        int remaining = Interlocked.Decrement(ref _activeProjectorCount);
        if (remaining < 0)
        {
            Interlocked.Exchange(ref _activeProjectorCount, 0);
        }
    }

    internal void RecordBackgroundClaimStarted()
        => Interlocked.Increment(ref _activeBackgroundClaimCountForPublicHot);

    internal void RecordBackgroundClaimFinished()
    {
        int remaining = Interlocked.Decrement(ref _activeBackgroundClaimCountForPublicHot);
        if (remaining < 0)
        {
            Interlocked.Exchange(ref _activeBackgroundClaimCountForPublicHot, 0);
        }
    }

    internal void RecordPublishedGeneration(long generation)
    {
        if (generation <= 0)
        {
            return;
        }

        long current = Volatile.Read(ref _lastPublishedGeneration);
        while (generation > current)
        {
            long observed = Interlocked.CompareExchange(ref _lastPublishedGeneration, generation, current);
            if (observed == current)
            {
                return;
            }

            current = observed;
        }
    }

    /// <summary>
    /// The single atomic PublicHot activity snapshot used by release drain, runtime
    /// health and readiness. Every owner is read in this one method; any exception
    /// produces a collector-failed snapshot that blocks instead of assuming zero.
    /// </summary>
    public async Task<PublicHotActivitySnapshot> CreateActivitySnapshotAsync(
        CancellationToken cancellationToken)
    {
        try
        {
            long? queuedCount = _channel.Reader.CanCount ? _channel.Reader.Count : null;
            PublicHotArtifactObligation? active = null;
            if (_obligations is { } obligations)
            {
                active = await obligations.GetActiveAsync(cancellationToken).ConfigureAwait(false);
            }

            long? pendingObligationCount;
            long? failedTerminalObligationCount;
            long? currentTargetGeneration;
            if (_obligations is null)
            {
                long pendingGeneration = await _deliveryState
                    .GetPendingGenerationAsync(cancellationToken)
                    .ConfigureAwait(false);
                pendingObligationCount = pendingGeneration > 0 ? 1 : 0;
                failedTerminalObligationCount = 0;
                currentTargetGeneration = pendingGeneration > 0 ? pendingGeneration : 0;
            }
            else if (active is null)
            {
                pendingObligationCount = 0;
                failedTerminalObligationCount = 0;
                currentTargetGeneration = 0;
            }
            else
            {
                pendingObligationCount = active.State != PublicHotArtifactObligationState.Published && !active.IsTerminal
                    ? 1
                    : 0;
                failedTerminalObligationCount = active.IsTerminal ? 1 : 0;
                currentTargetGeneration = active.TargetGeneration;
            }

            var snapshot = new PublicHotActivitySnapshot(
                queuedCount,
                Volatile.Read(ref _inFlightBatchCount),
                Volatile.Read(ref _activeProjectorCount),
                _store?.CreateRuntimeSnapshot().State,
                pendingObligationCount,
                failedTerminalObligationCount,
                Volatile.Read(ref _lastPublishedGeneration),
                _revocations?.Snapshot().Count,
                Volatile.Read(ref _activeBackgroundClaimCountForPublicHot),
                currentTargetGeneration);
            Volatile.Write(ref _lastActivitySnapshot, snapshot);
            return snapshot;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            var snapshot = new PublicHotActivitySnapshot(
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                ex.GetType().Name);
            Volatile.Write(ref _lastActivitySnapshot, snapshot);
            return snapshot;
        }
    }

    /// <summary>
    /// Synchronous view for status consumers. Returns the latest atomic observation
    /// when available; before the first observation the obligation fields are unknown
    /// so quiescence fails closed instead of assuming zero.
    /// </summary>
    internal PublicHotActivitySnapshot CreateActivitySnapshot()
    {
        PublicHotActivitySnapshot? cached = Volatile.Read(ref _lastActivitySnapshot);
        if (cached is not null)
        {
            return cached;
        }

        return new PublicHotActivitySnapshot(
            _channel.Reader.CanCount ? _channel.Reader.Count : null,
            Volatile.Read(ref _inFlightBatchCount),
            Volatile.Read(ref _activeProjectorCount),
            _store?.CreateRuntimeSnapshot().State,
            null,
            null,
            Volatile.Read(ref _lastPublishedGeneration),
            _revocations?.Snapshot().Count,
            Volatile.Read(ref _activeBackgroundClaimCountForPublicHot),
            null);
    }

    internal async Task<PublicHotArtifactUpdate?> LoadRecoveryUpdateAsync(CancellationToken cancellationToken)
    {
        if (_obligations is { } obligations)
        {
            PublicHotArtifactObligation? obligation = await obligations.GetActiveAsync(cancellationToken).ConfigureAwait(false);
            if (obligation is { State: not PublicHotArtifactObligationState.Published })
            {
                return new PublicHotArtifactUpdate(null, "durable-obligation-replay", obligation.DirtyReasons, null, obligation.TargetGeneration, PublicHotArtifactDeliveryClass.FullRebuildMarker);
            }
        }
        long generation = await _deliveryState.GetPendingGenerationAsync(cancellationToken).ConfigureAwait(false);
        return generation > 0
            ? new PublicHotArtifactUpdate(null, "durable-delivery-replay", PublicHotArtifactDirtyReason.Content, null, generation, PublicHotArtifactDeliveryClass.FullRebuildMarker)
            : null;
    }

    internal Task CompleteGenerationAsync(long generation, CancellationToken cancellationToken)
        => generation > 0 ? _deliveryState.CompleteAsync(generation, cancellationToken) : Task.CompletedTask;

    internal IPublicHotArtifactObligationStore? Obligations => _obligations;

    private static PublicHotArtifactDirtyReason ClassifyReason(string reason)
    {
        if (reason.Contains("view-projection", StringComparison.OrdinalIgnoreCase))
        {
            return PublicHotArtifactDirtyReason.ViewProjection;
        }

        if (reason.Contains("scheduled-publish", StringComparison.OrdinalIgnoreCase))
        {
            return PublicHotArtifactDirtyReason.ScheduledPublish | PublicHotArtifactDirtyReason.Content;
        }

        return PublicHotArtifactDirtyReason.Content;
    }
}

public sealed class PublicHotArtifactUpdateWorker(
    PublicHotArtifactUpdateQueue queue,
    PublicHotReadStore store,
    IPublicArtifactRevocationCoordinator revocations,
    DeploymentRuntimeState runtime,
    IServiceScopeFactory scopeFactory,
    IOptions<PublicHotReadOptions> options,
    ILogger<PublicHotArtifactUpdateWorker> logger) : BackgroundService
{
    private static readonly TimeSpan s_viewProjectionRefreshInterval = TimeSpan.FromSeconds(30);
    private DateTime _lastViewProjectionRefreshUtc = DateTime.MinValue;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (queue.Obligations is { } obligations)
        {
            await obligations.RecoverInterruptedAsync(DateTimeOffset.UtcNow, stoppingToken).ConfigureAwait(false);
            await ProcessDurableAsync(stoppingToken, scheduleRetry: true).ConfigureAwait(false);
        }
        PublicHotArtifactUpdate? recovery = await queue.LoadRecoveryUpdateAsync(stoppingToken).ConfigureAwait(false);
        if (recovery is { } pending)
        {
            await ProcessOnceAsync(pending, stoppingToken).ConfigureAwait(false);
        }

        await foreach (PublicHotArtifactUpdate first in queue.Reader.ReadAllAsync(stoppingToken).ConfigureAwait(false))
        {
            if (queue.Obligations is { })
                await ProcessDurableAsync(stoppingToken, scheduleRetry: true).ConfigureAwait(false);
            else
                await ProcessOnceAsync(first, stoppingToken).ConfigureAwait(false);
            // A producer may have persisted a newer generation while the bounded
            // channel was full. Drain that durable marker before waiting for more
            // notifications, so a coalesced view update becomes a full rebuild.
            PublicHotArtifactUpdate? pendingAfterPublish = await queue
                .LoadRecoveryUpdateAsync(stoppingToken)
                .ConfigureAwait(false);
            if (pendingAfterPublish is { } pendingUpdate)
            {
                await ProcessOnceAsync(pendingUpdate, stoppingToken).ConfigureAwait(false);
            }
        }
    }

    internal async Task ProcessOnceAsync(PublicHotArtifactUpdate first, CancellationToken stoppingToken)
    {
        if (queue.Obligations is { } obligations
            && await obligations.GetActiveAsync(stoppingToken).ConfigureAwait(false) is not null)
        {
            await ProcessDurableAsync(stoppingToken).ConfigureAwait(false);
            return;
        }
        queue.RecordBatchStarted();
        IDisposable? claim = BeginBatchClaim();
        string reason = first.Reason;
        int coalesced = 1;
        try
        {
            PublicHotArtifactDirtyReason dirtyReason = first.DirtyReason;
            long deliveryGeneration = first.DeliveryGeneration;
            var articleIds = new HashSet<int>();
            var expectedReleaseIds = new Dictionary<int, long>();
            bool requiresFullRebuild = false;
            CollectUpdate(first, articleIds, expectedReleaseIds, ref requiresFullRebuild);
            TimeSpan debounce = TimeSpan.FromMilliseconds(Math.Clamp(options.Value.UpdateDebounceMilliseconds, 0, 30_000));
            if (debounce > TimeSpan.Zero)
            {
                await Task.Delay(debounce, stoppingToken).ConfigureAwait(false);
            }

            while (queue.Reader.TryRead(out PublicHotArtifactUpdate next))
            {
                reason = string.Concat(reason, "+", next.Reason);
                dirtyReason |= next.DirtyReason;
                deliveryGeneration = Math.Max(deliveryGeneration, next.DeliveryGeneration);
                coalesced++;
                CollectUpdate(next, articleIds, expectedReleaseIds, ref requiresFullRebuild);
            }

            if (dirtyReason == PublicHotArtifactDirtyReason.ViewProjection)
            {
                DateTime now = DateTime.UtcNow;
                if (now - _lastViewProjectionRefreshUtc < s_viewProjectionRefreshInterval)
                {
                    logger.LogInformation(
                        "public-hot-read-view-refresh-coalesced {Reason} {Coalesced}",
                        reason,
                        coalesced);
                    return;
                }

                _lastViewProjectionRefreshUtc = now;
            }

            long maximumRevocationGeneration = revocations.CurrentGeneration;
            store.BeginBuild(reason);
            await using AsyncServiceScope scope = scopeFactory.CreateAsyncScope();
            var projector = scope.ServiceProvider.GetRequiredService<IPublicHotArtifactProjector>();
            PublicHotReadSnapshot snapshot = store.Current;
            bool publishesFullSnapshot = requiresFullRebuild
                || articleIds.Count == 0
                || RequiresInitialSnapshot(snapshot);
            queue.RecordProjectorStarted();
            try
            {
                if (publishesFullSnapshot)
                {
                    snapshot = await projector.BuildInitialSnapshotAsync(stoppingToken).ConfigureAwait(false);
                }
                else if (dirtyReason == PublicHotArtifactDirtyReason.ViewProjection)
                {
                    snapshot = await projector
                        .RebuildAfterViewProjectionAsync(snapshot, articleIds, stoppingToken)
                        .ConfigureAwait(false);
                }
                else
                {
                    foreach (int articleId in articleIds)
                    {
                        expectedReleaseIds.TryGetValue(articleId, out long expectedReleaseId);
                        snapshot = projector is IVersionedPublicHotArtifactProjector versionedProjector
                            ? await versionedProjector
                                .RebuildAfterArticleMutationAsync(
                                    snapshot,
                                    articleId,
                                    expectedReleaseId > 0 ? expectedReleaseId : null,
                                    stoppingToken)
                                .ConfigureAwait(false)
                            : await projector
                                .RebuildAfterArticleMutationAsync(snapshot, articleId, stoppingToken)
                                .ConfigureAwait(false);
                    }
                }
            }
            finally
            {
                queue.RecordProjectorFinished();
            }

            store.Publish(snapshot);
            if ((dirtyReason & PublicHotArtifactDirtyReason.Content) != 0)
            {
                await revocations
                    .CompleteRebuildAsync(
                        publishesFullSnapshot ? null : articleIds,
                        maximumRevocationGeneration,
                        stoppingToken)
                    .ConfigureAwait(false);
            }

            // The durable generation is the recovery truth. Do not acknowledge
            // it until every publication stage, including revocation completion,
            // has succeeded; a crash or exception here must replay this build.
            if (publishesFullSnapshot)
            {
                await RecordDistributedReconcileCoverageAsync(
                    scope.ServiceProvider,
                    deliveryGeneration,
                    snapshot.Version,
                    stoppingToken).ConfigureAwait(false);
            }
            await queue.CompleteGenerationAsync(deliveryGeneration, stoppingToken).ConfigureAwait(false);
            queue.RecordPublishedGeneration(deliveryGeneration);
            logger.LogInformation("public-hot-read-snapshot-updated {Version} {Reason} {Coalesced}", snapshot.Version, reason, coalesced);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            return;
        }
        catch (Exception ex)
        {
            store.ReportBuildFailure(reason, ex);
            logger.LogWarning(ex, "public-hot-read-snapshot-update-failed {Reason} {Coalesced}", reason, coalesced);
        }
        finally
        {
            EndBatchClaim(claim);
            queue.RecordBatchFinished();
        }
    }

    private async Task ProcessDurableAsync(CancellationToken stoppingToken, bool scheduleRetry = false)
    {
        IPublicHotArtifactObligationStore obligations = queue.Obligations!;
        PublicHotArtifactObligation? obligation = await obligations
            .ClaimEligibleAsync(DateTimeOffset.UtcNow, stoppingToken).ConfigureAwait(false);
        if (obligation is null)
            return;

        queue.RecordBatchStarted();
        IDisposable? claim = BeginBatchClaim();
        int maxAttempts = Math.Clamp(options.Value.PublicHotRecoveryMaximumAttempts, 1, 20);
        long maximumRevocationGeneration = revocations.CurrentGeneration;
        PublicHotArtifactAttemptStage stage = PublicHotArtifactAttemptStage.Projector;
        try
        {
            store.BeginBuild("obligation:" + obligation.ObligationId);
            await using AsyncServiceScope scope = scopeFactory.CreateAsyncScope();
            var projector = scope.ServiceProvider.GetRequiredService<IPublicHotArtifactProjector>();
            PublicHotReadSnapshot snapshot = store.Current;
            bool publishesFullSnapshot = obligation.RequiresFullRebuild
                || obligation.ArticleIds.Count == 0
                || RequiresInitialSnapshot(snapshot);
            queue.RecordProjectorStarted();
            try
            {
                if (publishesFullSnapshot)
                {
                    snapshot = await projector.BuildInitialSnapshotAsync(stoppingToken).ConfigureAwait(false);
                }
                else if (obligation.DirtyReasons == PublicHotArtifactDirtyReason.ViewProjection)
                {
                    snapshot = await projector.RebuildAfterViewProjectionAsync(snapshot, obligation.ArticleIds, stoppingToken).ConfigureAwait(false);
                }
                else
                {
                    foreach (int articleId in obligation.ArticleIds)
                    {
                        obligation.ExpectedReleaseIds.TryGetValue(articleId, out long release);
                        snapshot = projector is IVersionedPublicHotArtifactProjector versioned
                            ? await versioned.RebuildAfterArticleMutationAsync(snapshot, articleId, release > 0 ? release : null, stoppingToken).ConfigureAwait(false)
                            : await projector.RebuildAfterArticleMutationAsync(snapshot, articleId, stoppingToken).ConfigureAwait(false);
                    }
                }
            }
            finally
            {
                queue.RecordProjectorFinished();
            }
            await obligations.RecordStageSuccessAsync(obligation.ObligationId, obligation.AttemptNumber, PublicHotArtifactAttemptStage.Projector, DateTimeOffset.UtcNow, stoppingToken).ConfigureAwait(false);
            stage = PublicHotArtifactAttemptStage.Publish;
            store.Publish(snapshot);
            await obligations.RecordStageSuccessAsync(obligation.ObligationId, obligation.AttemptNumber, PublicHotArtifactAttemptStage.Publish, DateTimeOffset.UtcNow, stoppingToken).ConfigureAwait(false);
            stage = PublicHotArtifactAttemptStage.RevocationCompletion;
            if ((obligation.DirtyReasons & PublicHotArtifactDirtyReason.Content) != 0)
                await revocations.CompleteRebuildAsync(publishesFullSnapshot ? null : obligation.ArticleIds, maximumRevocationGeneration, stoppingToken).ConfigureAwait(false);
            await obligations.RecordStageSuccessAsync(obligation.ObligationId, obligation.AttemptNumber, PublicHotArtifactAttemptStage.RevocationCompletion, DateTimeOffset.UtcNow, stoppingToken).ConfigureAwait(false);
            stage = PublicHotArtifactAttemptStage.Completion;
            // A claim can be superseded while its snapshot is building.  CAS the
            // generation claimed by this attempt, so a later merge remains pending.
            if (publishesFullSnapshot)
            {
                await RecordDistributedReconcileCoverageAsync(
                    scope.ServiceProvider,
                    obligation.TargetGeneration,
                    snapshot.Version,
                    stoppingToken).ConfigureAwait(false);
            }
            bool published = await obligations.CompletePublishedAsync(obligation.ObligationId, obligation.AttemptNumber, obligation.TargetGeneration, stoppingToken).ConfigureAwait(false);
            if (published)
            {
                queue.RecordPublishedGeneration(obligation.TargetGeneration);
                logger.LogInformation("public-hot obligation published {ObligationId} {Generation} {Recovered}", obligation.ObligationId, obligation.TargetGeneration, obligation.Recovered);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            await obligations.RecordFailureAsync(obligation.ObligationId, obligation.AttemptNumber, stage, new OperationCanceledException(stoppingToken), DateTimeOffset.UtcNow, maxAttempts, CancellationToken.None).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            PublicHotArtifactObligation failed = await obligations.RecordFailureAsync(obligation.ObligationId, obligation.AttemptNumber, stage, ex, DateTimeOffset.UtcNow, maxAttempts, CancellationToken.None).ConfigureAwait(false);
            store.ReportBuildFailure("obligation:" + obligation.ObligationId, ex);
            logger.LogWarning(ex, "public-hot obligation failed {ObligationId} {Attempt} {State} {FailureKind}", obligation.ObligationId, obligation.AttemptNumber, failed.State, failed.LastFailureKind);
            if (scheduleRetry && failed.State == PublicHotArtifactObligationState.FailedRetryable && !stoppingToken.IsCancellationRequested)
            {
                TimeSpan delay = failed.NextEligibleAt - DateTimeOffset.UtcNow;
                if (delay > TimeSpan.Zero)
                {
                    await Task.Delay(delay, stoppingToken).ConfigureAwait(false);
                }
                await ProcessDurableAsync(stoppingToken, scheduleRetry: true).ConfigureAwait(false);
            }
        }
        finally
        {
            EndBatchClaim(claim);
            queue.RecordBatchFinished();
        }
    }

    private IDisposable? BeginBatchClaim()
    {
        if (!runtime.TryBeginBackgroundClaim(out IDisposable? lease))
        {
            return null;
        }

        queue.RecordBackgroundClaimStarted();
        return lease;
    }

    private void EndBatchClaim(IDisposable? lease)
    {
        if (lease is null)
        {
            return;
        }

        lease.Dispose();
        queue.RecordBackgroundClaimFinished();
    }

    private static bool RequiresInitialSnapshot(PublicHotReadSnapshot snapshot)
        => snapshot.Version <= 0;

    private static async Task RecordDistributedReconcileCoverageAsync(
        IServiceProvider serviceProvider,
        long generation,
        long snapshotVersion,
        CancellationToken cancellationToken)
    {
        if (generation <= 0
            || serviceProvider.GetService<DistributedInvalidationOptions>() is not { Enabled: true } distributedOptions
            || serviceProvider.GetService<IDistributedInvalidationDeliveryLedger>() is not { } ledger
            || serviceProvider.GetService<IRuntimeKeyScope>() is not { } runtimeKeyScope)
        {
            return;
        }
        string runtimeScope = string.IsNullOrWhiteSpace(runtimeKeyScope.ScopeToken)
            ? "default"
            : runtimeKeyScope.ScopeToken;
        string proofIdentity = FormattableString.Invariant(
            $"public-hot-full-rebuild:snapshot:{snapshotVersion}:generation:{generation}");
        foreach (string kind in DistributedInvalidationEventKinds.All.Order(StringComparer.Ordinal))
        {
            await ledger.RecordReconcileCoverageAsync(
                runtimeScope,
                distributedOptions.NodeId,
                kind,
                generation,
                proofIdentity,
                cancellationToken).ConfigureAwait(false);
        }
    }

    private static void CollectUpdate(
        PublicHotArtifactUpdate update,
        HashSet<int> articleIds,
        Dictionary<int, long> expectedReleaseIds,
        ref bool requiresFullRebuild)
    {
        if (update.ArticleId is int id && id > 0)
        {
            articleIds.Add(id);
            if (update.ExpectedReleaseId is long expectedReleaseId && expectedReleaseId > 0)
            {
                // Publication ids are coordinates, not sequence numbers. The channel is ordered,
                // so retain the last event coordinate instead of guessing ordering from its id.
                expectedReleaseIds[id] = expectedReleaseId;
            }
            return;
        }

        requiresFullRebuild = true;
    }
}
