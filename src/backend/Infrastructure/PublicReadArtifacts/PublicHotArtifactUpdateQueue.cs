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

public sealed class PublicHotArtifactUpdateQueue
{
    private readonly Channel<PublicHotArtifactUpdate> _channel;

    public PublicHotArtifactUpdateQueue(IOptions<PublicHotReadOptions> options)
    {
        int capacity = Math.Clamp(options.Value.UpdateQueueCapacity, 1, 65_536);
        _channel = Channel.CreateBounded<PublicHotArtifactUpdate>(new BoundedChannelOptions(capacity)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
            SingleWriter = false
        });
    }

    public bool TryEnqueue(int? articleId, string reason)
    {
        string normalized = string.IsNullOrWhiteSpace(reason) ? "unknown" : reason;
        return _channel.Writer.TryWrite(new PublicHotArtifactUpdate(articleId, normalized, ClassifyReason(normalized)));
    }

    internal ChannelReader<PublicHotArtifactUpdate> Reader => _channel.Reader;

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

            store.BeginBuild(reason);
            try
            {
                await using AsyncServiceScope scope = scopeFactory.CreateAsyncScope();
                var projector = scope.ServiceProvider.GetRequiredService<IPublicHotArtifactProjector>();
                PublicHotReadSnapshot snapshot = await projector
                    .RebuildAfterArticleMutationAsync(store.Current, first.ArticleId ?? 0, stoppingToken)
                    .ConfigureAwait(false);
                store.Publish(snapshot);
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
}
