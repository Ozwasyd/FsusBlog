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

public readonly record struct PublicHotArtifactUpdate(int? ArticleId, string Reason, PublicHotArtifactDirtyReason DirtyReason);

public readonly record struct PublicHotArtifactEnqueueResult(
    bool Accepted,
    string Reason,
    PublicHotArtifactDirtyReason DirtyReason,
    string Status)
{
    public static PublicHotArtifactEnqueueResult AcceptedResult(string reason, PublicHotArtifactDirtyReason dirtyReason)
        => new(true, reason, dirtyReason, "accepted");

    public static PublicHotArtifactEnqueueResult Rejected(string reason, PublicHotArtifactDirtyReason dirtyReason)
        => new(false, reason, dirtyReason, "queue-full-or-closed");
}

public sealed class PublicHotArtifactUpdateQueue
{
    private readonly Channel<PublicHotArtifactUpdate> _channel;

    public PublicHotArtifactUpdateQueue(IOptions<PublicHotReadOptions> options)
    {
        int capacity = Math.Clamp(options.Value.UpdateQueueCapacity, 1, 65_536);
        _channel = Channel.CreateBounded<PublicHotArtifactUpdate>(new BoundedChannelOptions(capacity)
        {
            FullMode = BoundedChannelFullMode.Wait,
            SingleReader = true,
            SingleWriter = false
        });
    }

    public bool TryEnqueue(int? articleId, string reason)
        => Enqueue(articleId, reason).Accepted;

    public PublicHotArtifactEnqueueResult Enqueue(int? articleId, string reason)
    {
        string normalized = string.IsNullOrWhiteSpace(reason) ? "unknown" : reason;
        PublicHotArtifactDirtyReason dirtyReason = ClassifyReason(normalized);
        bool accepted = _channel.Writer.TryWrite(new PublicHotArtifactUpdate(articleId, normalized, dirtyReason));
        return accepted
            ? PublicHotArtifactEnqueueResult.AcceptedResult(normalized, dirtyReason)
            : PublicHotArtifactEnqueueResult.Rejected(normalized, dirtyReason);
    }

    internal ChannelReader<PublicHotArtifactUpdate> Reader => _channel.Reader;

    public int QueuedCount => _channel.Reader.CanCount ? _channel.Reader.Count : 0;

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
    private static readonly TimeSpan ViewProjectionRefreshInterval = TimeSpan.FromSeconds(30);
    private DateTime _lastViewProjectionRefreshUtc = DateTime.MinValue;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (PublicHotArtifactUpdate first in queue.Reader.ReadAllAsync(stoppingToken).ConfigureAwait(false))
        {
            string reason = first.Reason;
            PublicHotArtifactDirtyReason dirtyReason = first.DirtyReason;
            int coalesced = 1;
            var articleIds = new HashSet<int>();
            bool requiresFullRebuild = false;
            CollectUpdate(first, articleIds, ref requiresFullRebuild);
            TimeSpan debounce = TimeSpan.FromMilliseconds(Math.Clamp(options.Value.UpdateDebounceMilliseconds, 0, 30_000));
            if (debounce > TimeSpan.Zero)
            {
                await Task.Delay(debounce, stoppingToken).ConfigureAwait(false);
            }

            while (queue.Reader.TryRead(out PublicHotArtifactUpdate next))
            {
                reason = string.Concat(reason, "+", next.Reason);
                dirtyReason |= next.DirtyReason;
                coalesced++;
                CollectUpdate(next, articleIds, ref requiresFullRebuild);
            }

            if (dirtyReason == PublicHotArtifactDirtyReason.ViewProjection)
            {
                DateTime now = DateTime.UtcNow;
                if (now - _lastViewProjectionRefreshUtc < ViewProjectionRefreshInterval)
                {
                    logger.LogInformation(
                        "public-hot-read-view-refresh-coalesced {Reason} {Coalesced}",
                        reason,
                        coalesced);
                    continue;
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
                        snapshot = await projector
                            .RebuildAfterArticleMutationAsync(snapshot, articleId, stoppingToken)
                            .ConfigureAwait(false);
                    }
                }

                store.Publish(snapshot);
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
                break;
            }
            catch (Exception ex)
            {
                store.ReportBuildFailure(reason, ex);
                logger.LogWarning(ex, "public-hot-read-snapshot-update-failed {Reason} {Coalesced}", reason, coalesced);
            }
        }
    }

    private static void CollectUpdate(
        PublicHotArtifactUpdate update,
        HashSet<int> articleIds,
        ref bool requiresFullRebuild)
    {
        if (update.ArticleId is int id && id > 0)
        {
            articleIds.Add(id);
            return;
        }

        requiresFullRebuild = true;
    }
}
