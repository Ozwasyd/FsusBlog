using System.Globalization;

using FsusBlog.Server.Infrastructure.Observability;

namespace FsusBlog.Server.Infrastructure.Cache;

public sealed class HotStatsInvalidationCoalescer(
    IServiceScopeFactory scopeFactory,
    ILogger<HotStatsInvalidationCoalescer> logger,
    ICacheCounterStore? sharedCounters = null,
    ICacheStringReader? sharedReader = null) : BackgroundService, IHotStatsInvalidationCoalescer, IHotArticlesCacheVersionPublisher
{
    private static readonly TimeSpan s_pollInterval = TimeSpan.FromMilliseconds(250);
    private static readonly TimeSpan s_hotArticlesDebounce = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan s_statsDebounce = TimeSpan.FromSeconds(10);
    private const long HotArticlesForceFlushThreshold = 16;
    private const long StatsForceFlushThreshold = 32;

    private readonly object _gate = new();
    private HotStatsInvalidationSnapshot _snapshot = new(
        DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
        0,
        0,
        0,
        0,
        0,
        0,
        false,
        false,
        null,
        null,
        null,
        null);

    private DateTimeOffset? _statsFirstDirtyAt;
    private DateTimeOffset? _hotArticlesFirstDirtyAt;
    private long _pendingStatsDirtyCount;
    private long _pendingHotArticlesDirtyCount;
    private string? _pendingStatsReason;
    private string? _pendingHotArticlesReason;

    public long CurrentHotArticlesVersion
    {
        get
        {
            lock (_gate)
            {
                return _snapshot.HotArticlesVersion;
            }
        }
    }

    public string BuildVersionedHotArticlesIdentity(string identity)
        => $"v{CurrentHotArticlesVersion}:{identity}";

    public async Task MarkStatsDirtyAsync(string reason, CancellationToken cancellationToken = default)
    {
        long? sharedDirtyCount = null;
        lock (_gate)
        {
            DateTimeOffset now = DateTimeOffset.UtcNow;
            _statsFirstDirtyAt ??= now;
            _pendingStatsDirtyCount++;
            _pendingStatsReason = NormalizeReason(reason);
            _snapshot = _snapshot with
            {
                StatsDirtyCount = _snapshot.StatsDirtyCount + 1,
                StatsDirty = true,
                LastDirtyAt = now,
                LastDirtyReason = _pendingStatsReason
            };
        }

        sharedDirtyCount = await IncrementSharedCounterAsync("hot-stats:stats:dirty", 1, cancellationToken).ConfigureAwait(false);
        if (sharedDirtyCount.HasValue)
        {
            lock (_gate)
            {
                _snapshot = _snapshot with
                {
                    StatsDirtyCount = Math.Max(_snapshot.StatsDirtyCount, sharedDirtyCount.Value)
                };
            }
        }

        FsusObservability.RecordHotStatsInvalidation("stats", "dirty", reason, 1);
    }

    public async Task MarkHotArticlesDirtyAsync(string reason, CancellationToken cancellationToken = default)
    {
        long? sharedDirtyCount = null;
        lock (_gate)
        {
            DateTimeOffset now = DateTimeOffset.UtcNow;
            _hotArticlesFirstDirtyAt ??= now;
            _pendingHotArticlesDirtyCount++;
            _pendingHotArticlesReason = NormalizeReason(reason);
            _snapshot = _snapshot with
            {
                HotArticlesDirtyCount = _snapshot.HotArticlesDirtyCount + 1,
                HotArticlesDirty = true,
                LastDirtyAt = now,
                LastDirtyReason = _pendingHotArticlesReason
            };
        }

        sharedDirtyCount = await IncrementSharedCounterAsync("hot-stats:hot-articles:dirty", 1, cancellationToken).ConfigureAwait(false);
        if (sharedDirtyCount.HasValue)
        {
            lock (_gate)
            {
                _snapshot = _snapshot with
                {
                    HotArticlesDirtyCount = Math.Max(_snapshot.HotArticlesDirtyCount, sharedDirtyCount.Value)
                };
            }
        }

        FsusObservability.RecordHotStatsInvalidation("hot_articles", "dirty", reason, 1);
    }

    public long PublishNextHotArticlesVersion(string reason)
    {
        lock (_gate)
        {
            long nextVersion = Math.Max(_snapshot.HotArticlesVersion + 1, DateTimeOffset.UtcNow.ToUnixTimeSeconds());
            _snapshot = _snapshot with
            {
                HotArticlesVersion = nextVersion,
                LastFlushAt = DateTimeOffset.UtcNow,
                LastFlushReason = NormalizeReason(reason)
            };
            return nextVersion;
        }
    }

    public HotStatsInvalidationSnapshot Snapshot()
    {
        lock (_gate)
        {
            return _snapshot;
        }
    }

    public async Task<HotStatsInvalidationSnapshot> SnapshotAsync(CancellationToken cancellationToken = default)
    {
        HotStatsInvalidationSnapshot current = Snapshot();
        if (sharedCounters is null || sharedReader is null)
        {
            return current;
        }

        return current with
        {
            StatsDirtyCount = Math.Max(current.StatsDirtyCount, await ReadSharedCounterAsync("hot-stats:stats:dirty", cancellationToken).ConfigureAwait(false)),
            StatsFlushCount = Math.Max(current.StatsFlushCount, await ReadSharedCounterAsync("hot-stats:stats:flush", cancellationToken).ConfigureAwait(false)),
            StatsCoalescedDirtyCount = Math.Max(current.StatsCoalescedDirtyCount, await ReadSharedCounterAsync("hot-stats:stats:coalesced", cancellationToken).ConfigureAwait(false)),
            HotArticlesDirtyCount = Math.Max(current.HotArticlesDirtyCount, await ReadSharedCounterAsync("hot-stats:hot-articles:dirty", cancellationToken).ConfigureAwait(false)),
            HotArticlesFlushCount = Math.Max(current.HotArticlesFlushCount, await ReadSharedCounterAsync("hot-stats:hot-articles:flush", cancellationToken).ConfigureAwait(false)),
            HotArticlesCoalescedDirtyCount = Math.Max(current.HotArticlesCoalescedDirtyCount, await ReadSharedCounterAsync("hot-stats:hot-articles:coalesced", cancellationToken).ConfigureAwait(false))
        };
    }

    public async Task FlushPendingAsync(CancellationToken cancellationToken = default)
        => await FlushDueAsync(force: true, cancellationToken).ConfigureAwait(false);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using PeriodicTimer timer = new(s_pollInterval);
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken).ConfigureAwait(false))
            {
                await FlushDueAsync(force: false, stoppingToken).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
        finally
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            try
            {
                await FlushDueAsync(force: true, cts.Token).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "hot-stats-invalidation-shutdown-flush-failed");
            }
        }
    }

    private async Task FlushDueAsync(bool force, CancellationToken cancellationToken)
    {
        PendingInvalidation pending = TakeDuePending(force);
        if (!pending.HasWork)
        {
            return;
        }

        if (pending.FlushStats)
        {
            try
            {
                await FlushStatsAsync(pending.StatsDirtyCount, pending.StatsReason, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                RestorePendingStats(pending.StatsDirtyCount, pending.StatsReason);
                throw;
            }
            catch (Exception ex)
            {
                RestorePendingStats(pending.StatsDirtyCount, pending.StatsReason);
                logger.LogWarning(ex, "hot-stats-invalidation-stats-flush-failed {DirtyCount} {Reason}", pending.StatsDirtyCount, pending.StatsReason);
            }
        }

        if (pending.FlushHotArticles)
        {
            try
            {
                await FlushHotArticlesAsync(pending.HotArticlesDirtyCount, pending.HotArticlesReason, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                RestorePendingHotArticles(pending.HotArticlesDirtyCount, pending.HotArticlesReason);
                throw;
            }
            catch (Exception ex)
            {
                RestorePendingHotArticles(pending.HotArticlesDirtyCount, pending.HotArticlesReason);
                logger.LogWarning(ex, "hot-stats-invalidation-hot-flush-failed {DirtyCount} {Reason}", pending.HotArticlesDirtyCount, pending.HotArticlesReason);
            }
        }
    }

    private PendingInvalidation TakeDuePending(bool force)
    {
        lock (_gate)
        {
            DateTimeOffset now = DateTimeOffset.UtcNow;
            bool flushStats = _pendingStatsDirtyCount > 0
                && (force
                    || _pendingStatsDirtyCount >= StatsForceFlushThreshold
                    || (_statsFirstDirtyAt.HasValue && now - _statsFirstDirtyAt.Value >= s_statsDebounce));
            bool flushHotArticles = _pendingHotArticlesDirtyCount > 0
                && (force
                    || _pendingHotArticlesDirtyCount >= HotArticlesForceFlushThreshold
                    || (_hotArticlesFirstDirtyAt.HasValue && now - _hotArticlesFirstDirtyAt.Value >= s_hotArticlesDebounce));

            if (!flushStats && !flushHotArticles)
            {
                return default;
            }

            var pending = new PendingInvalidation(
                flushStats,
                flushHotArticles,
                flushStats ? _pendingStatsDirtyCount : 0,
                flushHotArticles ? _pendingHotArticlesDirtyCount : 0,
                flushStats ? _pendingStatsReason : null,
                flushHotArticles ? _pendingHotArticlesReason : null);

            if (flushStats)
            {
                _pendingStatsDirtyCount = 0;
                _pendingStatsReason = null;
                _statsFirstDirtyAt = null;
                _snapshot = _snapshot with
                {
                    StatsDirty = false
                };
            }

            if (flushHotArticles)
            {
                _pendingHotArticlesDirtyCount = 0;
                _pendingHotArticlesReason = null;
                _hotArticlesFirstDirtyAt = null;
                _snapshot = _snapshot with
                {
                    HotArticlesDirty = false
                };
            }

            return pending;
        }
    }

    private void RestorePendingStats(long dirtyCount, string? reason)
    {
        lock (_gate)
        {
            _pendingStatsDirtyCount += dirtyCount;
            _pendingStatsReason = reason ?? _pendingStatsReason;
            _statsFirstDirtyAt ??= DateTimeOffset.UtcNow;
            _snapshot = _snapshot with
            {
                StatsDirty = _pendingStatsDirtyCount > 0,
                LastDirtyAt = DateTimeOffset.UtcNow,
                LastDirtyReason = _pendingStatsReason
            };
        }
    }

    private void RestorePendingHotArticles(long dirtyCount, string? reason)
    {
        lock (_gate)
        {
            _pendingHotArticlesDirtyCount += dirtyCount;
            _pendingHotArticlesReason = reason ?? _pendingHotArticlesReason;
            _hotArticlesFirstDirtyAt ??= DateTimeOffset.UtcNow;
            _snapshot = _snapshot with
            {
                HotArticlesDirty = _pendingHotArticlesDirtyCount > 0,
                LastDirtyAt = DateTimeOffset.UtcNow,
                LastDirtyReason = _pendingHotArticlesReason
            };
        }
    }

    private async Task FlushStatsAsync(long dirtyCount, string? reason, CancellationToken cancellationToken)
    {
        using IServiceScope scope = scopeFactory.CreateScope();
        var dispatcher = scope.ServiceProvider.GetRequiredService<ICacheInvalidationDispatcher>();
        await dispatcher.InvalidateStatsAsync(cancellationToken).ConfigureAwait(false);
        lock (_gate)
        {
            _snapshot = _snapshot with
            {
                StatsFlushCount = _snapshot.StatsFlushCount + 1,
                StatsCoalescedDirtyCount = _snapshot.StatsCoalescedDirtyCount + dirtyCount,
                LastFlushAt = DateTimeOffset.UtcNow,
                LastFlushReason = $"stats:{reason ?? "unknown"}"
            };
        }

        await IncrementSharedCounterAsync("hot-stats:stats:flush", 1, cancellationToken).ConfigureAwait(false);
        await IncrementSharedCounterAsync("hot-stats:stats:coalesced", dirtyCount, cancellationToken).ConfigureAwait(false);
        FsusObservability.RecordHotStatsInvalidation("stats", "flush", reason ?? "unknown", dirtyCount);
    }

    private async Task FlushHotArticlesAsync(long dirtyCount, string? reason, CancellationToken cancellationToken)
    {
        using IServiceScope scope = scopeFactory.CreateScope();
        var httpCacheInvalidator = scope.ServiceProvider.GetRequiredService<IHttpCacheInvalidator>();
        await httpCacheInvalidator.InvalidateAsync(CacheTag.HotArticles).ConfigureAwait(false);

        long version = PublishNextHotArticlesVersion($"hot_articles:{reason ?? "unknown"}");
        if (scope.ServiceProvider.GetService<CacheInvalidationRuntimeState>() is { } runtimeState)
        {
            await runtimeState.RecordAsync("hot_articles", $"coalesced:v{version};dirty:{dirtyCount};reason:{reason ?? "unknown"}", cancellationToken).ConfigureAwait(false);
        }

        lock (_gate)
        {
            _snapshot = _snapshot with
            {
                HotArticlesFlushCount = _snapshot.HotArticlesFlushCount + 1,
                HotArticlesCoalescedDirtyCount = _snapshot.HotArticlesCoalescedDirtyCount + dirtyCount,
                LastFlushAt = DateTimeOffset.UtcNow,
                LastFlushReason = $"hot_articles:{reason ?? "unknown"}"
            };
        }

        await IncrementSharedCounterAsync("hot-stats:hot-articles:flush", 1, cancellationToken).ConfigureAwait(false);
        await IncrementSharedCounterAsync("hot-stats:hot-articles:coalesced", dirtyCount, cancellationToken).ConfigureAwait(false);
        FsusObservability.RecordHotStatsInvalidation("hot_articles", "flush", reason ?? "unknown", dirtyCount);
        FsusObservability.RecordHotArticlesVersion(version);
    }

    private async Task<long?> IncrementSharedCounterAsync(string identity, long value, CancellationToken cancellationToken)
    {
        if (sharedCounters is null)
        {
            return null;
        }

        return await sharedCounters.IncrementAsync(CachePolicyId.AdminStats, identity, value, cancellationToken).ConfigureAwait(false);
    }

    private async Task<long> ReadSharedCounterAsync(string identity, CancellationToken cancellationToken)
    {
        if (sharedReader is null)
        {
            return 0;
        }

        string? value = await sharedReader.GetStringAsync(CachePolicyId.AdminStats, identity, cancellationToken).ConfigureAwait(false);
        return long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out long parsed) ? parsed : 0;
    }

    private static string NormalizeReason(string? reason)
        => string.IsNullOrWhiteSpace(reason) ? "unknown" : reason.Trim()[..Math.Min(reason.Trim().Length, 80)];

    private readonly record struct PendingInvalidation(
        bool FlushStats,
        bool FlushHotArticles,
        long StatsDirtyCount,
        long HotArticlesDirtyCount,
        string? StatsReason,
        string? HotArticlesReason)
    {
        public bool HasWork => FlushStats || FlushHotArticles;
    }
}
