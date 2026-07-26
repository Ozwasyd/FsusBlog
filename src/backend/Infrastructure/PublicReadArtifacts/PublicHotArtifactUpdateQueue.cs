using System.Threading.Channels;

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
    long DeliveryGeneration = 0);

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

    public PublicHotArtifactUpdateQueue(
        IOptions<PublicHotReadOptions> options,
        IPublicHotArtifactDeliveryStateStore deliveryState)
    {
        _deliveryState = deliveryState;
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
        try
        {
            // Persist before notification: a crash in either channel window is replayed at startup.
            generation = await _deliveryState.MarkDirtyAsync(deliveryClass, cancellationToken).ConfigureAwait(false);
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
            return new(PublicHotArtifactDeliveryStatus.Cancelled, normalized, dirtyReason, generation);
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
            return new(PublicHotArtifactDeliveryStatus.Accepted, normalized, dirtyReason, generation);
        }

        ValueTask<bool> waitToWrite = _channel.Writer.WaitToWriteAsync(CancellationToken.None);
        if (waitToWrite.IsCompletedSuccessfully && !waitToWrite.Result)
        {
            return new(PublicHotArtifactDeliveryStatus.Closed, normalized, dirtyReason, generation);
        }

        // A full bounded channel never changes the durable outcome into a drop.
        // The next worker cycle consumes this pending generation as a full rebuild.
        PublicHotArtifactDeliveryStatus status =
            deliveryClass == PublicHotArtifactDeliveryClass.FullRebuildMarker
                ? PublicHotArtifactDeliveryStatus.Coalesced
                : PublicHotArtifactDeliveryStatus.PersistedDirty;
        return new(status, normalized, dirtyReason, generation);
    }

    internal ChannelReader<PublicHotArtifactUpdate> Reader => _channel.Reader;

    public int QueuedCount => _channel.Reader.CanCount ? _channel.Reader.Count : 0;

    internal async Task<PublicHotArtifactUpdate?> LoadRecoveryUpdateAsync(CancellationToken cancellationToken)
    {
        long generation = await _deliveryState.GetPendingGenerationAsync(cancellationToken).ConfigureAwait(false);
        return generation > 0
            ? new PublicHotArtifactUpdate(null, "durable-delivery-replay", PublicHotArtifactDirtyReason.Content, null, generation, PublicHotArtifactDeliveryClass.FullRebuildMarker)
            : null;
    }

    internal Task CompleteGenerationAsync(long generation, CancellationToken cancellationToken)
        => generation > 0 ? _deliveryState.CompleteAsync(generation, cancellationToken) : Task.CompletedTask;

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
    IServiceScopeFactory scopeFactory,
    IOptions<PublicHotReadOptions> options,
    ILogger<PublicHotArtifactUpdateWorker> logger) : BackgroundService
{
    private static readonly TimeSpan s_viewProjectionRefreshInterval = TimeSpan.FromSeconds(30);
    private DateTime _lastViewProjectionRefreshUtc = DateTime.MinValue;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        PublicHotArtifactUpdate? recovery = await queue.LoadRecoveryUpdateAsync(stoppingToken).ConfigureAwait(false);
        if (recovery is { } pending)
        {
            await ProcessOnceAsync(pending, stoppingToken).ConfigureAwait(false);
        }

        await foreach (PublicHotArtifactUpdate first in queue.Reader.ReadAllAsync(stoppingToken).ConfigureAwait(false))
        {
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
        string reason = first.Reason;
        PublicHotArtifactDirtyReason dirtyReason = first.DirtyReason;
        int coalesced = 1;
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
        try
        {
            await using AsyncServiceScope scope = scopeFactory.CreateAsyncScope();
            var projector = scope.ServiceProvider.GetRequiredService<IPublicHotArtifactProjector>();
            PublicHotReadSnapshot snapshot = store.Current;
            if (dirtyReason == PublicHotArtifactDirtyReason.ViewProjection)
            {
                snapshot = await projector
                    .RebuildAfterViewProjectionAsync(snapshot, articleIds, stoppingToken)
                    .ConfigureAwait(false);
            }
            else if (requiresFullRebuild || articleIds.Count == 0)
            {
                snapshot = await projector.BuildInitialSnapshotAsync(stoppingToken).ConfigureAwait(false);
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

            store.Publish(snapshot);
            await queue.CompleteGenerationAsync(deliveryGeneration, stoppingToken).ConfigureAwait(false);
            if ((dirtyReason & PublicHotArtifactDirtyReason.Content) != 0)
            {
                await revocations
                    .CompleteRebuildAsync(
                        requiresFullRebuild ? null : articleIds,
                        maximumRevocationGeneration,
                        stoppingToken)
                    .ConfigureAwait(false);
            }
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
