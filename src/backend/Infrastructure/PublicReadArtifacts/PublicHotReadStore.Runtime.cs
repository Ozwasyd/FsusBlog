using System.Runtime.CompilerServices;

using FsusBlog.Shared.Contracts.Localization;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.PublicReadArtifacts;

public partial class PublicHotReadStore
{
    internal PublicHotReadRetiringRuntimeSnapshot RetiringSnapshotForTests()
    {
        lock (_gate)
        {
            RetiringState state = CollectRetiringStateLocked();
            return new(
                state.SnapshotCount,
                state.ResidentBytes,
                state.OldestRetiredAtUtc,
                _retiringPrunedCount,
                _retiringLimits);
        }
    }

    public bool IsReadyFast
    {
        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        get => Volatile.Read(ref _ready) == 1;
    }

    public void PublishHtml(string routeKey, PublicPageId pageId, PublicHtmlArtifact html)
    {
        if (string.IsNullOrWhiteSpace(routeKey) || html.Bytes.IsEmpty)
        {
            return;
        }

        string locale = string.IsNullOrWhiteSpace(html.Locale)
            ? LocaleCatalog.Default.Code
            : html.Locale;
        html = html with
        {
            Locale = locale
        };
        PublicHtmlRouteIndex route = PublicHotReadRouteKeys.CreateHtmlIndex(routeKey, pageId);
        string basePath = PublicHotReadRouteKeys.HtmlPath(route.PathKey);
        string localizedPath = PublicHotReadRouteKeys.LocalizeHtmlPath(basePath, locale);
        PublicHotReadSnapshot next = Current.WithHtml(localizedPath, html);
        if (string.Equals(
                locale,
                LocaleCatalog.Default.Code,
                StringComparison.Ordinal))
        {
            next = next.WithHtml(basePath, html);
        }

        Publish(next);
    }

    public void PublishHtml(string routeKey, PublicHtmlArtifact html)
    {
        if (string.IsNullOrWhiteSpace(routeKey) || html.Bytes.IsEmpty)
        {
            return;
        }

        Publish(Current.WithHtml(PublicHotReadRouteKeys.HtmlPath(routeKey), html));
    }

    public void RemoveHtml(string routeKey)
    {
        if (string.IsNullOrWhiteSpace(routeKey))
        {
            return;
        }

        PublicHotReadSnapshot current = Current;
        if (current.Version == 0)
        {
            return;
        }

        PublicHotReadSnapshot next = current.WithoutHtml(PublicHotReadRouteKeys.HtmlPath(routeKey));
        foreach (LocaleDescriptor locale in LocaleCatalog.Enabled)
        {
            next = next.WithoutHtml(PublicHotReadRouteKeys.LocalizeHtmlPath(
                PublicHotReadRouteKeys.HtmlPath(routeKey),
                locale.Code));
        }

        Publish(next);
    }

    public void RemoveHtmlFamily(string routeKey)
    {
        if (string.IsNullOrWhiteSpace(routeKey))
        {
            return;
        }

        PublicHotReadSnapshot current = Current;
        if (current.Version == 0)
        {
            return;
        }

        string exactPath = PublicHotReadRouteKeys.HtmlPath(routeKey);
        string familyPrefix = exactPath.EndsWith(".html", StringComparison.Ordinal)
            ? string.Concat(exactPath.AsSpan(0, exactPath.Length - ".html".Length), "-")
            : string.Concat(exactPath, "-");
        PublicHotReadSnapshot next = current.WithoutHtmlMatching(path =>
            string.Equals(path, exactPath, StringComparison.Ordinal)
            || path.StartsWith(familyPrefix, StringComparison.Ordinal));
        if (!ReferenceEquals(next, current))
        {
            Publish(next);
        }
    }

    public void ClearHtml()
    {
        PublicHotReadSnapshot current = Current;
        if (current.Version == 0)
        {
            return;
        }

        Publish(current.WithoutAllHtml());
    }

    private PublicHotReadRuntimeSnapshot CreateRuntimeSnapshotLocked(
        string state,
        PublicHotReadSnapshot snapshot,
        DateTimeOffset? lastBuildAt,
        string? lastBuildReason,
        string? lastBuildStatus,
        string? lastError)
        => new(
            state,
            snapshot.Version,
            snapshot.ArticleFrameCount,
            snapshot.PublicArticleCount,
            snapshot.ArticleFrameLimit,
            snapshot.ArticleFrameLimitExceeded,
            snapshot.ListFrameCount,
            snapshot.CategoryFrameReady,
            snapshot.TagFrameReady,
            snapshot.HtmlFrameCount,
            snapshot.ResidentBytes,
            snapshot.HtmlTemplateResidentBytes,
            _budgetLimits.MaxResidentBytes,
            _lastBudgetViolations.Count > 0,
            snapshot.Residency,
            _budgetLimits,
            _lastSnapshotOverlapBytes,
            RetiringSnapshotBytesLocked(),
            _lastBudgetViolations.Count,
            _lastBudgetViolations,
            _lifecycleStage,
            _lifecycleHistory.ToArray(),
            snapshot.HtmlOverlayEntryCount,
            snapshot.HtmlRemovedEntryCount,
            "independent-readonly-arrays-upper-bound-v1",
            _compressionPolicy,
            lastBuildAt,
            lastBuildReason,
            lastBuildStatus,
            lastError,
            _earlyDataPlaneRuntimeState?.Enabled ?? _initialEarlyDataPlaneEnabled,
            !(_earlyDataPlaneRuntimeState?.Enabled ?? _initialEarlyDataPlaneEnabled)
                ? "disabled"
                : string.Equals(state, nameof(PublicHotReadState.Ready), StringComparison.Ordinal)
                    ? "ready"
                    : "not-ready",
            snapshot.PublicationEvidence.VisibilityPolicy,
            snapshot.PublicationEvidence.SourceVisibility,
            snapshot.PublicationEvidence.SourceVersion,
            snapshot.PublicationEvidence.VisibilityCutoffUtc);

    internal static long ResolveResidentByteBudget(long configuredBytes)
    {
        return PublicHotReadBudgetLimits.Resolve(new PublicHotReadOptions
        {
            MaxResidentBytes = configuredBytes
        }).MaxResidentBytes;
    }

    internal static PublicHotReadBudgetLimits ResolveBudgetLimitsForTests(
        PublicHotReadOptions options,
        long availableMemoryBytes)
        => PublicHotReadBudgetLimits.Resolve(options, availableMemoryBytes);

    private long RetiringSnapshotBytesLocked()
        => CollectRetiringStateLocked().ResidentBytes;

    private RetiringState CollectRetiringStateLocked()
    {
        long total = 0;
        int count = 0;
        long pruned = 0;
        DateTimeOffset? oldest = null;
        PublicHotReadSnapshot current = Current;
        for (int index = _retiringSnapshots.Count - 1; index >= 0; index--)
        {
            RetiringSnapshotReference tracked = _retiringSnapshots[index];
            if (!tracked.Reference.TryGetTarget(out PublicHotReadSnapshot? retiring)
                || ReferenceEquals(retiring, current))
            {
                _retiringSnapshots.RemoveAt(index);
                pruned++;
                continue;
            }
            count++;
            total = checked(total + tracked.ResidentBytes);
            oldest = !oldest.HasValue || tracked.RetiredAtUtc < oldest.Value
                ? tracked.RetiredAtUtc
                : oldest;
        }
        if (pruned > 0)
        {
            _retiringPrunedCount = checked(_retiringPrunedCount + pruned);
            s_retiringPrunedCounter.Add(pruned, new KeyValuePair<string, object?>("fsus.reason", "released"));
        }
        s_retiringBytesHistogram.Record(total);
        return new RetiringState(count, total, oldest);
    }

    private sealed record RetiringSnapshotReference(
        WeakReference<PublicHotReadSnapshot> Reference,
        DateTimeOffset RetiredAtUtc,
        long ResidentBytes,
        long Version);

    private readonly record struct RetiringState(
        int SnapshotCount,
        long ResidentBytes,
        DateTimeOffset? OldestRetiredAtUtc);

    private static string CompressionPolicy(PublicHotReadOptions options)
        => $"publish-time;minBytes={options.MinPrecompressedFrameBytes};minSavings={options.MinCompressionSavingsPercent};brShare={options.ExpectedBrotliClientSharePercent};gzipShare={options.ExpectedGzipClientSharePercent}";

    private void SetLifecycleStageLocked(string stage)
    {
        _lifecycleStage = stage;
        if (_lifecycleHistory.Count == 12)
        {
            _lifecycleHistory.Dequeue();
        }
        _lifecycleHistory.Enqueue(stage);
    }
}
