using System.Collections.Frozen;
using System.Buffers.Binary;
using System.Diagnostics.Metrics;
using System.IO.Compression;
using System.IO.Pipelines;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Primitives;

namespace FsusBlog.Server.Infrastructure.PublicReadArtifacts;

public enum PublicListKind : byte
{
    Home = 0,
    Category = 1,
    Tag = 2,
    Archive = 3,
    Hot = 4,
    Featured = 5
}

public enum PublicHotReadState : byte
{
    NotStarted = 0,
    Building = 1,
    Ready = 2,
    Failed = 3
}

public enum PublicHotReadCounterMode : byte
{
    Off = 0,
    Sampled = 1,
    Striped = 2
}

public readonly record struct PublicListKey(
    PublicListKind Kind,
    int TargetId,
    ushort Page,
    byte Size);

public readonly record struct PublicBinaryArtifact(
    ReadOnlyMemory<byte> Frame,
    string ETag,
    string CacheControl,
    long Version,
    AedsFrameType FrameType,
    ReadOnlyMemory<byte> BrotliFrame = default,
    string BrotliETag = "",
    ReadOnlyMemory<byte> GzipFrame = default,
    string GzipETag = "");

public readonly record struct PublicBinaryArtifactVariant(
    ReadOnlyMemory<byte> Frame,
    string ETag,
    string ContentEncoding);

internal enum PublicHotReadRouteKind : byte
{
    None = 0,
    Category = 1,
    Tag = 2,
    ArticleDetail = 3,
    ArticleList = 4,
    ArticleHot = 5,
    ArticleFeatured = 6,
    ArticleHtml = 7,
    PublicHtml = 8
}

internal readonly record struct PublicHotReadRoute(
    PublicHotReadRouteKind Kind,
    int ArticleId = 0,
    PublicListKey ListKey = default,
    string HtmlRouteKey = "");

public readonly record struct PublicHtmlArtifact(
    ReadOnlyMemory<byte> Bytes,
    string ContentType,
    string ETag,
    string CacheControl,
    CspNonceUtf8Template? CspNonceTemplate = null,
    string RendererVersion = "",
    string FrontendAssetVersion = "")
{
    public bool RequiresCspNonceMutation => CspNonceTemplate is not null;

    public long ResidentBytes => Bytes.Length + (CspNonceTemplate?.ResidentBytes ?? 0);
}

public readonly record struct PublicHtmlRouteIndex(
    string RouteKey,
    string PathKey,
    PublicPageId PageId);

public sealed class PublicHotReadOptions
{
    public bool Enabled { get; set; } = true;
    public string CacheControl { get; set; } = "public,max-age=60";
    public int[] PreloadPages { get; set; } = [1];
    public int[] PreloadSizes { get; set; } = [1, 3, 5, 10];
    public int[] HotSizes { get; set; } = [1, 3, 5, 10];
    public int[] FeaturedSizes { get; set; } = [3, 4, 10];
    public PublicHotReadCounterMode CounterMode { get; set; } = PublicHotReadCounterMode.Striped;
    public int CounterSampleRate { get; set; } = 64;
    public int UpdateDebounceMilliseconds { get; set; } = 250;
    public int UpdateQueueCapacity { get; set; } = 4096;
    public int MaxPreloadPage { get; set; } = 64;
    public int MaxPreloadSize { get; set; } = 100;
    public int MaxArticleFrames { get; set; } = 100_000;
    public int MaxFrameBytes { get; set; } = 2 * 1024 * 1024;
    /// <summary>
    /// Maximum resident artifact bytes. Zero selects an automatic budget from
    /// the runtime's current total available managed-memory limit.
    /// </summary>
    public long MaxResidentBytes { get; set; }
    public long MaxRawBytes { get; set; }
    public long MaxCompressedBytes { get; set; }
    public long MaxHtmlBytes { get; set; }
    public long MaxSnapshotOverlapBytes { get; set; }
    public int MaxRetiringSnapshots { get; set; }
    public long MaxRetiringBytes { get; set; }
    public TimeSpan RetiringSnapshotDeadline { get; set; }
    public long MaxArticleResidentBytes { get; set; }
    public int MaxArtifactObjects { get; set; }
    public int ArticleAdmissionRecentPercent { get; set; } = 40;
    public bool EnablePrecompressedBinaryVariants { get; set; } = true;
    public int MinPrecompressedFrameBytes { get; set; } = 256;
    public int MinCompressionSavingsPercent { get; set; } = 8;
    public int ExpectedBrotliClientSharePercent { get; set; } = 80;
    public int ExpectedGzipClientSharePercent { get; set; } = 15;
    public int MinResidentVariantClientSharePercent { get; set; } = 5;
    public bool ValidateFramesOnPublish { get; set; } = true;
    public bool FailOpenWhenNotReady { get; set; }
    public bool EnableDiagnosticHeaders { get; set; }
}

public sealed record PublicHotReadRuntimeSnapshot(
    string State,
    long Version,
    int ArticleFrameCount,
    int PublicArticleCount,
    int ArticleFrameLimit,
    bool ArticleFrameLimitExceeded,
    int ListFrameCount,
    bool CategoryFrameReady,
    bool TagFrameReady,
    int HtmlFrameCount,
    long ResidentBytes,
    long HtmlTemplateResidentBytes,
    long ResidentByteBudget,
    bool ResidentByteBudgetExceeded,
    PublicHotReadResidentBreakdown Residency,
    PublicHotReadBudgetLimits Budgets,
    long SnapshotOverlapBytes,
    long RetiringSnapshotBytes,
    int BudgetViolationCount,
    IReadOnlyList<string> BudgetViolations,
    string LifecycleStage,
    IReadOnlyList<string> LifecycleHistory,
    int HtmlOverlayEntryCount,
    int HtmlRemovedEntryCount,
    string StorageModel,
    string CompressionPolicy,
    DateTimeOffset? LastBuildAt,
    string? LastBuildReason,
    string? LastBuildStatus,
    string? LastError,
    bool EarlyDataPlaneEnabled,
    string EarlyDataPlaneState,
    string VisibilityPolicy,
    long VisibilitySourceVersion,
    DateTimeOffset? VisibilityCutoffUtc);

internal readonly record struct PublicHotReadRetiringRuntimeSnapshot(
    int SnapshotCount,
    long ResidentBytes,
    DateTimeOffset? OldestRetiredAtUtc,
    long PrunedCount,
    PublicHotReadRetiringLimits Limits);

public sealed class PublicHotReadSnapshot
{
    private const int HtmlOverlayCompactionFloor = 32;
    public static readonly PublicHotReadSnapshot Empty = new(
        0,
        FrozenDictionary<int, PublicBinaryArtifact>.Empty,
        FrozenDictionary<PublicListKey, PublicBinaryArtifact>.Empty,
        default,
        default,
        FrozenDictionary<string, PublicHtmlArtifact>.Empty,
        PublicHotReadPublicationEvidence.Empty);

    private readonly FrozenDictionary<int, PublicBinaryArtifact> _articleFramesById;
    private readonly FrozenDictionary<PublicListKey, PublicBinaryArtifact> _listFrames;
    private readonly PublicBinaryArtifact _categoryFrame;
    private readonly PublicBinaryArtifact _tagFrame;
    private readonly FrozenDictionary<string, PublicHtmlArtifact> _htmlBaseByPath;
    private readonly FrozenDictionary<string, PublicHtmlArtifact> _htmlOverlayByPath;
    private readonly FrozenSet<string> _htmlRemovedPaths;
    private readonly int _htmlFrameCount;
    private readonly PublicHotReadResidentBreakdown _residency;

    public PublicHotReadSnapshot(
        long version,
        FrozenDictionary<int, PublicBinaryArtifact> articleFramesById,
        FrozenDictionary<PublicListKey, PublicBinaryArtifact> listFrames,
        PublicBinaryArtifact categoryFrame,
        PublicBinaryArtifact tagFrame,
        FrozenDictionary<string, PublicHtmlArtifact> htmlByPath,
        PublicHotReadPublicationEvidence publicationEvidence,
        int? publicArticleCount = null,
        int? articleFrameLimit = null)
        : this(
            version,
            articleFramesById,
            listFrames,
            categoryFrame,
            tagFrame,
            htmlByPath,
            publicationEvidence,
            FrozenDictionary<string, PublicHtmlArtifact>.Empty,
            FrozenSet<string>.Empty,
            htmlByPath.Count,
            publicArticleCount ?? articleFramesById.Count,
            articleFrameLimit ?? articleFramesById.Count)
    {
    }

    private PublicHotReadSnapshot(
        long version,
        FrozenDictionary<int, PublicBinaryArtifact> articleFramesById,
        FrozenDictionary<PublicListKey, PublicBinaryArtifact> listFrames,
        PublicBinaryArtifact categoryFrame,
        PublicBinaryArtifact tagFrame,
        FrozenDictionary<string, PublicHtmlArtifact> htmlBaseByPath,
        PublicHotReadPublicationEvidence publicationEvidence,
        FrozenDictionary<string, PublicHtmlArtifact> htmlOverlayByPath,
        FrozenSet<string> htmlRemovedPaths,
        int htmlFrameCount,
        int publicArticleCount,
        int articleFrameLimit)
    {
        Version = version;
        PublicationEvidence = publicationEvidence;
        _articleFramesById = articleFramesById;
        _listFrames = listFrames;
        _categoryFrame = categoryFrame;
        _tagFrame = tagFrame;
        _htmlBaseByPath = htmlBaseByPath;
        _htmlOverlayByPath = htmlOverlayByPath;
        _htmlRemovedPaths = htmlRemovedPaths;
        _htmlFrameCount = htmlFrameCount;
        PublicArticleCount = Math.Max(publicArticleCount, articleFramesById.Count);
        ArticleFrameLimit = Math.Max(articleFrameLimit, 0);
        _residency = PublicHotReadResidentAccounting.Calculate(
            _articleFramesById,
            _listFrames,
            _categoryFrame,
            _tagFrame,
            _htmlBaseByPath,
            _htmlOverlayByPath,
            _htmlRemovedPaths);
    }

    public long Version { get; }
    public PublicHotReadPublicationEvidence PublicationEvidence { get; }

    public int ArticleFrameCount => _articleFramesById.Count;
    public int PublicArticleCount { get; }
    public int ArticleFrameLimit { get; }
    public bool ArticleFrameLimitExceeded => ArticleFrameLimit > 0 && PublicArticleCount > ArticleFrameLimit;
    public int ListFrameCount => _listFrames.Count;
    public bool CategoryFrameReady => !_categoryFrame.Frame.IsEmpty;
    public bool TagFrameReady => !_tagFrame.Frame.IsEmpty;
    public PublicBinaryArtifact CategoryFrame => _categoryFrame;
    public PublicBinaryArtifact TagFrame => _tagFrame;
    public int HtmlFrameCount => _htmlFrameCount;
    public long ResidentBytes => _residency.TotalBytes;
    public long HtmlTemplateResidentBytes => _residency.HtmlTemplateBytes;
    public PublicHotReadResidentBreakdown Residency => _residency;
    public int HtmlOverlayEntryCount => _htmlOverlayByPath.Count;
    public int HtmlRemovedEntryCount => _htmlRemovedPaths.Count;
    public IEnumerable<KeyValuePair<int, PublicBinaryArtifact>> ArticleArtifacts => _articleFramesById;
    public IEnumerable<KeyValuePair<PublicListKey, PublicBinaryArtifact>> ListArtifacts => _listFrames;

    public IEnumerable<KeyValuePair<string, PublicHtmlArtifact>> HtmlArtifacts
    {
        get
        {
            foreach (KeyValuePair<string, PublicHtmlArtifact> item in _htmlBaseByPath)
            {
                if (!_htmlOverlayByPath.ContainsKey(item.Key) && !_htmlRemovedPaths.Contains(item.Key))
                {
                    yield return item;
                }
            }

            foreach (KeyValuePair<string, PublicHtmlArtifact> item in _htmlOverlayByPath)
            {
                yield return item;
            }
        }
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public bool TryGetArticle(int id, out PublicBinaryArtifact artifact)
        => _articleFramesById.TryGetValue(id, out artifact) && !artifact.Frame.IsEmpty;

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public bool TryGetList(in PublicListKey key, out PublicBinaryArtifact artifact)
        => _listFrames.TryGetValue(key, out artifact) && !artifact.Frame.IsEmpty;

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public bool TryGetCategory(out PublicBinaryArtifact artifact)
    {
        artifact = _categoryFrame;
        return !artifact.Frame.IsEmpty;
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public bool TryGetTag(out PublicBinaryArtifact artifact)
    {
        artifact = _tagFrame;
        return !artifact.Frame.IsEmpty;
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public bool TryGetHtml(string path, out PublicHtmlArtifact html)
    {
        if (_htmlOverlayByPath.TryGetValue(path, out html))
        {
            return !html.Bytes.IsEmpty;
        }

        if (_htmlRemovedPaths.Contains(path))
        {
            html = default;
            return false;
        }

        return _htmlBaseByPath.TryGetValue(path, out html) && !html.Bytes.IsEmpty;
    }

    public PublicHotReadSnapshot WithHtml(string path, PublicHtmlArtifact html)
    {
        bool existed = TryGetHtml(path, out _);
        Dictionary<string, PublicHtmlArtifact> overlay = _htmlOverlayByPath.ToDictionary(StringComparer.Ordinal);
        overlay[path] = html;
        HashSet<string> removed = _htmlRemovedPaths.ToHashSet(StringComparer.Ordinal);
        removed.Remove(path);
        return CreateHtmlDeltaSnapshot(
            overlay,
            removed,
            _htmlFrameCount + (existed ? 0 : 1));
    }

    public PublicHotReadSnapshot WithoutHtml(string path)
    {
        if (!TryGetHtml(path, out _))
        {
            return this;
        }

        Dictionary<string, PublicHtmlArtifact> overlay = _htmlOverlayByPath.ToDictionary(StringComparer.Ordinal);
        overlay.Remove(path);
        HashSet<string> removed = _htmlRemovedPaths.ToHashSet(StringComparer.Ordinal);
        if (_htmlBaseByPath.ContainsKey(path))
        {
            removed.Add(path);
        }
        return CreateHtmlDeltaSnapshot(overlay, removed, _htmlFrameCount - 1);
    }

    public PublicHotReadSnapshot WithoutAllHtml()
        => _htmlFrameCount == 0
            ? this
            : new PublicHotReadSnapshot(
                Version + 1,
                _articleFramesById,
                _listFrames,
                _categoryFrame,
                _tagFrame,
                FrozenDictionary<string, PublicHtmlArtifact>.Empty,
                PublicationEvidence.WithSourceVersion(Version + 1),
                FrozenDictionary<string, PublicHtmlArtifact>.Empty,
                FrozenSet<string>.Empty,
                0,
                PublicArticleCount,
                ArticleFrameLimit);

    private PublicHotReadSnapshot CreateHtmlDeltaSnapshot(
        Dictionary<string, PublicHtmlArtifact> overlay,
        HashSet<string> removed,
        int htmlFrameCount)
    {
        int deltaEntries = overlay.Count + removed.Count;
        int compactionThreshold = Math.Max(HtmlOverlayCompactionFloor, Math.Max(1, _htmlBaseByPath.Count / 4));
        if (deltaEntries >= compactionThreshold)
        {
            var compacted = new Dictionary<string, PublicHtmlArtifact>(_htmlBaseByPath, StringComparer.Ordinal);
            foreach (string key in removed)
            {
                compacted.Remove(key);
            }
            foreach ((string key, PublicHtmlArtifact value) in overlay)
            {
                compacted[key] = value;
            }
            return new PublicHotReadSnapshot(
                Version + 1,
                _articleFramesById,
                _listFrames,
                _categoryFrame,
                _tagFrame,
                compacted.ToFrozenDictionary(StringComparer.Ordinal),
                PublicationEvidence.WithSourceVersion(Version + 1),
                FrozenDictionary<string, PublicHtmlArtifact>.Empty,
                FrozenSet<string>.Empty,
                htmlFrameCount,
                PublicArticleCount,
                ArticleFrameLimit);
        }

        return new PublicHotReadSnapshot(
            Version + 1,
            _articleFramesById,
            _listFrames,
            _categoryFrame,
            _tagFrame,
            _htmlBaseByPath,
            PublicationEvidence.WithSourceVersion(Version + 1),
            overlay.ToFrozenDictionary(StringComparer.Ordinal),
            removed.ToFrozenSet(StringComparer.Ordinal),
            htmlFrameCount,
            PublicArticleCount,
            ArticleFrameLimit);
    }
}

public sealed class PublicHotReadStore
{
    private static readonly Meter RetiringMeter = new("FsusBlog.PublicHotRead.Retiring", "1.0.0");
    private static readonly Counter<long> RetiringPrunedCounter =
        RetiringMeter.CreateCounter<long>("fsus.public_hot.retiring.evictions");
    private static readonly Histogram<long> RetiringBytesHistogram =
        RetiringMeter.CreateHistogram<long>("fsus.public_hot.retiring.bytes", "By");

    private PublicHotReadSnapshot _current = PublicHotReadSnapshot.Empty;
    private int _ready;
    private readonly object _gate = new();
    private readonly PublicHotReadEarlyDataPlaneRuntimeState? _earlyDataPlaneRuntimeState;
    private readonly bool _initialEarlyDataPlaneEnabled;
    private readonly PublicHotReadBudgetLimits _budgetLimits;
    private readonly string _compressionPolicy;
    private readonly List<RetiringSnapshotReference> _retiringSnapshots = [];
    private readonly PublicHotReadRetiringLimits _retiringLimits;
    private readonly TimeProvider _timeProvider;
    private long _retiringPrunedCount;
    private long _lastSnapshotOverlapBytes;
    private IReadOnlyList<string> _lastBudgetViolations = Array.Empty<string>();
    private string _lifecycleStage = "not-started";
    private readonly Queue<string> _lifecycleHistory = new(["not-started"]);
    private PublicHotReadRuntimeSnapshot _runtime;

    public PublicHotReadStore(
        PublicHotReadEarlyDataPlaneRuntimeState? earlyDataPlaneRuntimeState = null,
        IOptions<PublicHotReadOptions>? options = null,
        TimeProvider? timeProvider = null)
    {
        _earlyDataPlaneRuntimeState = earlyDataPlaneRuntimeState;
        _initialEarlyDataPlaneEnabled = earlyDataPlaneRuntimeState?.Enabled ?? options?.Value.Enabled ?? true;
        PublicHotReadOptions value = options?.Value ?? new PublicHotReadOptions();
        _budgetLimits = PublicHotReadBudgetLimits.Resolve(value);
        _retiringLimits = PublicHotReadRetiringLimits.Resolve(value, _budgetLimits);
        _timeProvider = timeProvider ?? TimeProvider.System;
        _compressionPolicy = CompressionPolicy(value);
        _runtime = new PublicHotReadRuntimeSnapshot(
            nameof(PublicHotReadState.NotStarted),
            0,
            0,
            0,
            0,
            false,
            0,
            false,
            false,
            0,
            0,
            0,
            _budgetLimits.MaxResidentBytes,
            false,
            PublicHotReadResidentBreakdown.Empty,
            _budgetLimits,
            0,
            0,
            0,
            Array.Empty<string>(),
            _lifecycleStage,
            _lifecycleHistory.ToArray(),
            0,
            0,
            "independent-readonly-arrays-upper-bound-v1",
            _compressionPolicy,
            null,
            null,
            "not_started",
            null,
            _initialEarlyDataPlaneEnabled,
            _initialEarlyDataPlaneEnabled ? "not-ready" : "disabled",
            string.Empty,
            0,
            null);
    }

    public PublicHotReadSnapshot Current
    {
        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        get => Volatile.Read(ref _current);
    }

    public void Publish(PublicHotReadSnapshot next)
    {
        ArgumentNullException.ThrowIfNull(next);
        long overlapBytes;
        lock (_gate)
        {
            PublicHotReadSnapshot current = Current;
            DateTimeOffset now = _timeProvider.GetUtcNow();
            if (!next.PublicationEvidence.IsVerifiedFor(next.Version))
            {
                SetLifecycleStageLocked("visibility-evidence-rejected");
                _runtime = CreateRuntimeSnapshotLocked(
                    current.Version == 0 ? nameof(PublicHotReadState.Failed) : nameof(PublicHotReadState.Ready),
                    current,
                    now,
                    _runtime.LastBuildReason,
                    "failed",
                    "PublicHotReadPublicationEvidenceInvalid");
                throw new InvalidOperationException(
                    $"public hot-read publication evidence is invalid for snapshot {next.Version}");
            }

            RetiringState retiringState = CollectRetiringStateLocked();
            long retiringBytes = retiringState.ResidentBytes;
            overlapBytes = checked(next.ResidentBytes
                + (current.Version == 0 ? 0 : current.ResidentBytes)
                + retiringBytes);
            SetLifecycleStageLocked("validate");
            var violations = PublicHotReadResidentAccounting.ValidateCandidate(
                next.Residency,
                overlapBytes,
                _budgetLimits).ToList();
            if (current.Version != 0)
            {
                int predictedRetiringCount = checked(retiringState.SnapshotCount + 1);
                long predictedRetiringBytes = checked(retiringBytes + current.ResidentBytes);
                if (predictedRetiringCount > _retiringLimits.MaxSnapshots)
                {
                    violations.Add($"retiring-count:{predictedRetiringCount}>{_retiringLimits.MaxSnapshots}");
                }
                if (predictedRetiringBytes > _retiringLimits.MaxBytes)
                {
                    violations.Add($"retiring-bytes:{predictedRetiringBytes}>{_retiringLimits.MaxBytes}");
                }
                if (retiringState.OldestRetiredAtUtc is { } oldest
                    && now - oldest > _retiringLimits.Deadline)
                {
                    violations.Add($"retiring-deadline:{oldest:O}>{_retiringLimits.Deadline}");
                }
            }
            if (violations.Count > 0)
            {
                _lastSnapshotOverlapBytes = overlapBytes;
                _lastBudgetViolations = violations;
                SetLifecycleStageLocked("validate-rejected");
                _runtime = CreateRuntimeSnapshotLocked(
                    Current.Version == 0 ? nameof(PublicHotReadState.Failed) : nameof(PublicHotReadState.Ready),
                    Current,
                    now,
                    _runtime.LastBuildReason,
                    "failed",
                    "PublicHotReadBudgetViolation");
                throw new InvalidOperationException(
                    $"public hot-read candidate budget exceeded: {string.Join(", ", violations)}");
            }

            SetLifecycleStageLocked("admit");
            SetLifecycleStageLocked("publish");
            Volatile.Write(ref _current, next);
            Volatile.Write(ref _ready, 1);
            _lastSnapshotOverlapBytes = overlapBytes;
            _lastBudgetViolations = Array.Empty<string>();
            if (current.Version != 0)
            {
                _retiringSnapshots.Add(new RetiringSnapshotReference(
                    new WeakReference<PublicHotReadSnapshot>(current),
                    now,
                    current.ResidentBytes,
                    current.Version));
            }
            SetLifecycleStageLocked(_retiringSnapshots.Count == 0 ? "active" : "retire");
            _runtime = CreateRuntimeSnapshotLocked(nameof(PublicHotReadState.Ready), next, now, _runtime.LastBuildReason, "ok", null);
        }
        FsusObservability.RecordPublicHotResidency(next.Residency, overlapBytes);
    }

    public void BeginBuild(string reason)
    {
        lock (_gate)
        {
            SetLifecycleStageLocked("build");
            PublicHotReadSnapshot current = Current;
            string state = string.Equals(_runtime.State, nameof(PublicHotReadState.Ready), StringComparison.Ordinal)
                ? nameof(PublicHotReadState.Ready)
                : nameof(PublicHotReadState.Building);
            _runtime = CreateRuntimeSnapshotLocked(state, current, _runtime.LastBuildAt, reason, "building", null);
        }
    }

    public void ReportBuildFailure(string reason, Exception exception)
    {
        lock (_gate)
        {
            SetLifecycleStageLocked("failed");
            PublicHotReadSnapshot current = Current;
            string state = string.Equals(_runtime.State, nameof(PublicHotReadState.Ready), StringComparison.Ordinal)
                ? nameof(PublicHotReadState.Ready)
                : nameof(PublicHotReadState.Failed);
            _runtime = CreateRuntimeSnapshotLocked(state, current, DateTimeOffset.UtcNow, reason, "failed", exception.GetType().Name);
        }
    }

    public PublicHotReadRuntimeSnapshot CreateRuntimeSnapshot()
    {
        lock (_gate)
        {
            bool enabled = _earlyDataPlaneRuntimeState?.Enabled ?? _initialEarlyDataPlaneEnabled;
            long retiringBytes = RetiringSnapshotBytesLocked();
            return _runtime with
            {
                RetiringSnapshotBytes = retiringBytes,
                LifecycleStage = retiringBytes == 0 && _lifecycleStage == "retire" ? "active" : _lifecycleStage,
                EarlyDataPlaneEnabled = enabled,
                EarlyDataPlaneState = !enabled
                    ? "disabled"
                    : string.Equals(_runtime.State, nameof(PublicHotReadState.Ready), StringComparison.Ordinal)
                        ? "ready"
                        : "not-ready"
            };
        }
    }

    public bool IsReady => IsReadyFast;

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

        PublicHtmlRouteIndex route = PublicHotReadRouteKeys.CreateHtmlIndex(routeKey, pageId);
        Publish(Current.WithHtml(PublicHotReadRouteKeys.HtmlPath(route.PathKey), html));
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

        Publish(Current.WithoutHtml(PublicHotReadRouteKeys.HtmlPath(routeKey)));
    }

    public void ClearHtml()
        => Publish(Current.WithoutAllHtml());

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
            RetiringPrunedCounter.Add(pruned, new KeyValuePair<string, object?>("fsus.reason", "released"));
        }
        RetiringBytesHistogram.Record(total);
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

public static class PublicHotReadFastPathExtensions
{
    public static IApplicationBuilder UseFsusPublicHotReadFastPath(this IApplicationBuilder app)
    {
        var store = app.ApplicationServices.GetRequiredService<PublicHotReadStore>();
        var options = app.ApplicationServices.GetRequiredService<IOptions<PublicHotReadOptions>>().Value;
        var counters = app.ApplicationServices.GetRequiredService<PublicHotReadCounters>();
        var env = app.ApplicationServices.GetRequiredService<IWebHostEnvironment>();
        bool isDevelopment = env.IsDevelopment();

        return app.Use((ctx, next) =>
        {
            PublicHotReadRequestFeature? feature = ctx.Features.Get<PublicHotReadRequestFeature>();
            return feature is null
                ? next(ctx)
                : PublicHotReadFastPath.TryServeClassifiedAsync(
                    ctx,
                    next,
                    store,
                    options,
                    counters,
                    feature,
                    isDevelopment);
        });
    }
}

// Design reference: docs/api/design.md "pathKey 与 routeKey 映射" and "L0 artifact HTTP 语义".
public static class PublicHotReadFastPath
{
    private const string ArticlePrefix = "/api/binary/article";
    private const string CategoryPath = "/api/binary/category.aeds";
    private const string CategoryPathWithoutSuffix = "/api/binary/category";
    private const string TagPath = "/api/binary/tag.aeds";
    private const string TagPathWithoutSuffix = "/api/binary/tag";
    private const string BinaryContentType = "application/octet-stream";
    private const string HtmlMediaType = "text/html";
    private const string HtmlContentType = "text/html; charset=utf-8";
    private const string ServerSsrAotSource = "server-ssr";
    private static readonly Task Completed = Task.CompletedTask;
    private static readonly string[] SensitiveApiPrefixes =
    [
        "/api/binary/auth",
        "/api/binary/admin",
        "/api/binary/author",
        "/api/binary/manage",
        "/api/binary/internal",
        "/api/binary/billing",
        "/api/binary/audit",
        "/api/auth",
        "/api/admin",
        "/api/author",
        "/api/manage",
        "/api/internal",
        "/api/billing",
        "/api/audit"
    ];

    public static Task TryServeAsync(
        HttpContext ctx,
        RequestDelegate next,
        PublicHotReadStore store,
        PublicHotReadOptions options,
        PublicHotReadCounters counters,
        bool isDevelopment = false)
    {
        if (!options.Enabled)
        {
            return next(ctx);
        }

        if (!TryCreateRequestFeature(ctx, out PublicHotReadRequestFeature? feature))
        {
            return next(ctx);
        }

        return TryServeClassifiedAsync(ctx, next, store, options, counters, feature!, isDevelopment);
    }

    internal static bool TryCreateRequestFeature(
        HttpContext ctx,
        out PublicHotReadRequestFeature? feature)
        => TryCreateRequestFeatureWithBypass(ctx, out feature, out _, out _);

    internal static bool TryCreateRequestFeatureWithBypass(
        HttpContext ctx,
        out PublicHotReadRequestFeature? feature,
        out bool sensitivePrefixBypass,
        out bool credentialBypass)
    {
        feature = null;
        sensitivePrefixBypass = false;
        credentialBypass = false;
        string? path = ctx.Request.Path.Value;
        if (path is null)
        {
            return false;
        }

        if (IsSensitiveApiPath(path))
        {
            sensitivePrefixBypass = true;
            return false;
        }

        ReadOnlySpan<char> span = path.AsSpan();
        bool allowlistedBinaryCandidate = IsCategoryPath(path)
            || IsTagPath(path)
            || string.Equals(path, ArticlePrefix, StringComparison.Ordinal)
            || path.StartsWith(ArticlePrefix + "/", StringComparison.Ordinal);
        bool rejectedPath = ContainsRejectedPathChar(span);
        bool classified = TryClassifyRoute(span, path, out PublicHotReadRoute route);
        PublicHotReadRoutePolicy routePolicy = classified
            && PublicHotReadRouteSecurityCatalog.TryGet(route.Kind, out PublicHotReadRoutePolicy matchedPolicy)
                ? matchedPolicy
                : PublicHotReadRouteSecurityCatalog.RejectedCandidate;
        bool isPublicHtmlRoute = route.Kind == PublicHotReadRouteKind.PublicHtml;

        if (IsDynamicRelatedReadingPath(span)
            || (!classified && !allowlistedBinaryCandidate))
        {
            return false;
        }

        if (HasCredentialBearingInput(ctx))
        {
            credentialBypass = true;
            return false;
        }

        if (!HttpMethods.IsGet(ctx.Request.Method)
            && !HttpMethods.IsHead(ctx.Request.Method)
            && (isPublicHtmlRoute || IsTaxonomyCollectionPath(path)))
        {
            return false;
        }

        bool fallbackToEndpoint = isPublicHtmlRoute && rejectedPath;
        feature = new PublicHotReadRequestFeature(
            route,
            classified,
            rejectedPath,
            fallbackToEndpoint,
            ResolveRiskRouteKey(route, path),
            routePolicy,
            classificationCount: 1);
        return true;
    }

    internal static bool TryCreateRequestFeatureForTests(
        HttpContext ctx,
        out PublicHotReadRequestFeature? feature)
        => TryCreateRequestFeature(ctx, out feature);

    internal static bool TryCreateRequestFeatureForTests(
        HttpContext ctx,
        out PublicHotReadRequestFeature? feature,
        out bool sensitivePrefixBypass)
        => TryCreateRequestFeatureWithBypass(ctx, out feature, out sensitivePrefixBypass, out _);

    internal static bool TryCreateRequestFeatureForTests(
        HttpContext ctx,
        out PublicHotReadRequestFeature? feature,
        out bool sensitivePrefixBypass,
        out bool credentialBypass)
        => TryCreateRequestFeatureWithBypass(ctx, out feature, out sensitivePrefixBypass, out credentialBypass);

    internal static bool IsSensitiveApiPathForTests(string path)
        => IsSensitiveApiPath(path);

    internal static Task TryServeClassifiedAsync(
        HttpContext ctx,
        RequestDelegate next,
        PublicHotReadStore store,
        PublicHotReadOptions options,
        PublicHotReadCounters counters,
        PublicHotReadRequestFeature feature,
        bool isDevelopment = false)
    {
        string path = ctx.Request.Path.Value!;
        PublicHotReadRoute route = feature.Route;
        bool classified = feature.Classified;
        bool isPublicHtmlRoute = route.Kind == PublicHotReadRouteKind.PublicHtml;

        if (feature.FallbackToEndpoint)
        {
            return next(ctx);
        }

        if (feature.RejectedPath)
        {
            counters.Rejected();
            return WriteStatus(ctx, StatusCodes.Status404NotFound, isDevelopment);
        }

        if (!HttpMethods.IsGet(ctx.Request.Method) && !HttpMethods.IsHead(ctx.Request.Method))
        {
            if (isPublicHtmlRoute)
            {
                return next(ctx);
            }

            if (IsTaxonomyCollectionPath(path))
            {
                return next(ctx);
            }

            return WriteStatus(ctx, StatusCodes.Status405MethodNotAllowed, isDevelopment);
        }

        // Public HTML artifacts are indexed by canonical route key, so the
        // classifier intentionally recognizes a trailing-slash request. Do
        // not let that shortcut bypass the application-wide canonical 301.
        if (isPublicHtmlRoute
            && WebApplicationCompositionExtensions.TryBuildTrailingSlashRedirect(
                ctx.Request,
                out string redirectLocation))
        {
            ctx.Response.StatusCode = StatusCodes.Status301MovedPermanently;
            ctx.Response.Headers.Location = redirectLocation;
            ctx.Response.ContentLength = 0;
            return Completed;
        }

        if (ctx.Request.Headers.ContainsKey("Range"))
        {
            ctx.Response.Headers.ContentRange = "bytes */0";
            return WriteStatus(ctx, StatusCodes.Status416RangeNotSatisfiable, isDevelopment);
        }

        if (ctx.Request.ContentLength.GetValueOrDefault() > 0 || ctx.Request.QueryString.HasValue)
        {
            if (isPublicHtmlRoute)
            {
                return next(ctx);
            }

            WriteLegacyRouteHint(ctx, path);
            return WriteStatus(ctx, StatusCodes.Status400BadRequest, isDevelopment);
        }

        if (!AcceptsArtifact(ctx, feature.IsHtml))
        {
            return WriteStatus(ctx, StatusCodes.Status406NotAcceptable, isDevelopment);
        }

        if (!store.IsReadyFast && !options.FailOpenWhenNotReady)
        {
            if (isPublicHtmlRoute)
            {
                return next(ctx);
            }

            ctx.Response.Headers["Retry-After"] = "1";
            return WriteStatus(ctx, StatusCodes.Status503ServiceUnavailable, isDevelopment);
        }

        PublicHotReadSnapshot snapshot = store.Current;
        if (classified)
        {
            return route.Kind switch
            {
                PublicHotReadRouteKind.Category => ServeCategory(ctx, snapshot, counters, options, isDevelopment),
                PublicHotReadRouteKind.Tag => ServeTag(ctx, snapshot, counters, options, isDevelopment),
                PublicHotReadRouteKind.ArticleDetail => ServeArticle(ctx, next, snapshot, counters, route.ArticleId, options, isDevelopment),
                PublicHotReadRouteKind.ArticleList => ServeList(ctx, snapshot, counters, route.ListKey, options, isDevelopment),
                PublicHotReadRouteKind.ArticleHot => ServeList(ctx, snapshot, counters, route.ListKey, options, isDevelopment),
                PublicHotReadRouteKind.ArticleFeatured => ServeList(ctx, snapshot, counters, route.ListKey, options, isDevelopment),
                PublicHotReadRouteKind.ArticleHtml => ServeHtml(ctx, snapshot, counters, route.HtmlRouteKey, options, isDevelopment),
                PublicHotReadRouteKind.PublicHtml => ServePublicHtml(ctx, next, snapshot, counters, route.HtmlRouteKey, options, isDevelopment),
                _ => WriteRejected(ctx, counters, isDevelopment)
            };
        }

        return WriteRejected(ctx, counters, isDevelopment);
    }

    private static string ResolveRiskRouteKey(in PublicHotReadRoute route, string path)
        => route.Kind switch
        {
            PublicHotReadRouteKind.Category => "taxonomy.category",
            PublicHotReadRouteKind.Tag => "taxonomy.tag",
            PublicHotReadRouteKind.ArticleDetail => "article.detail",
            PublicHotReadRouteKind.PublicHtml when path.Length == 1 => "public.html.home",
            PublicHotReadRouteKind.PublicHtml => "public.html.fallback",
            PublicHotReadRouteKind.ArticleHtml => "public.hot-read.html",
            _ => "public.hot-read.binary"
        };

    private static bool IsCategoryPath(string path)
        => string.Equals(path, CategoryPath, StringComparison.Ordinal)
            || string.Equals(path, CategoryPathWithoutSuffix, StringComparison.Ordinal);

    private static bool IsTagPath(string path)
        => string.Equals(path, TagPath, StringComparison.Ordinal)
            || string.Equals(path, TagPathWithoutSuffix, StringComparison.Ordinal);

    private static bool IsArticleHtmlPath(ReadOnlySpan<char> path)
        => path.StartsWith("/api/binary/article/html/", StringComparison.Ordinal);

    private static bool IsDynamicRelatedReadingPath(ReadOnlySpan<char> path)
    {
        const string prefix = "/api/binary/article/";
        ReadOnlySpan<char> suffix = "/related.aeds".AsSpan();
        if (!path.StartsWith(prefix, StringComparison.Ordinal)
            || !path.EndsWith(suffix, StringComparison.Ordinal))
        {
            return false;
        }

        ReadOnlySpan<char> articleId = path[prefix.Length..^suffix.Length];
        return TryParsePositiveInt(articleId, out _);
    }

    private static bool IsPublicHtmlCandidatePath(ReadOnlySpan<char> path)
    {
        path = TrimPublicHtmlPath(path);
        return path.Equals("/".AsSpan(), StringComparison.Ordinal)
            || PublicAotPageCatalog.TryGetByStaticPath(path, out _)
            || path.StartsWith(PublicRouteIdentityRegistry.ArticlePathPrefix.AsSpan(), StringComparison.Ordinal)
            || path.StartsWith(PublicRouteIdentityRegistry.CategoryPathPrefix.AsSpan(), StringComparison.Ordinal)
            || path.StartsWith(PublicRouteIdentityRegistry.TagPathPrefix.AsSpan(), StringComparison.Ordinal);
    }

    private static bool AcceptsArtifact(HttpContext ctx, bool html)
    {
        StringValues accept = ctx.Request.Headers.Accept;
        if (TryAcceptArtifactCommon(accept, html, out bool accepted))
        {
            return accepted;
        }

        return HttpAcceptNegotiation.Accepts(accept, html ? HtmlMediaType : BinaryContentType);
    }

    internal static bool AcceptsArtifactForTests(StringValues accept, bool html)
        => TryAcceptArtifactCommon(accept, html, out bool accepted)
            ? accepted
            : HttpAcceptNegotiation.Accepts(accept, html ? HtmlMediaType : BinaryContentType);

    private static bool TryAcceptArtifactCommon(StringValues values, bool html, out bool accepted)
    {
        accepted = false;
        if (values.Count == 0)
        {
            accepted = true;
            return true;
        }

        if (values.Count != 1)
        {
            return false;
        }

        ReadOnlySpan<char> header = (values[0] ?? string.Empty).AsSpan().Trim();
        if (header.IsEmpty || header.Equals("*/*", StringComparison.OrdinalIgnoreCase))
        {
            accepted = true;
            return true;
        }

        ReadOnlySpan<char> mediaType = html ? HtmlMediaType.AsSpan() : BinaryContentType.AsSpan();
        if (header.Equals(mediaType, StringComparison.OrdinalIgnoreCase)
            || EqualsCommaPair(header, mediaType, "*/*".AsSpan()))
        {
            accepted = true;
            return true;
        }

        return false;
    }

    private static bool EqualsCommaPair(ReadOnlySpan<char> value, ReadOnlySpan<char> first, ReadOnlySpan<char> second)
    {
        int comma = value.IndexOf(',');
        return comma > 0
            && value[..comma].Trim().Equals(first, StringComparison.OrdinalIgnoreCase)
            && value[(comma + 1)..].Trim().Equals(second, StringComparison.OrdinalIgnoreCase);
    }

    private static Task WriteRejected(HttpContext ctx, PublicHotReadCounters counters, bool isDevelopment)
    {
        counters.Rejected();
        return WriteStatus(ctx, StatusCodes.Status404NotFound, isDevelopment);
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static bool ContainsRejectedPathChar(ReadOnlySpan<char> path)
        => path.IndexOf('%') >= 0
            || path.IndexOf('\\') >= 0
            || path.IndexOf("..", StringComparison.Ordinal) >= 0
            || path.IndexOf("//", StringComparison.Ordinal) >= 0;

    private static Task ServeArticle(
        HttpContext ctx,
        RequestDelegate next,
        PublicHotReadSnapshot snapshot,
        PublicHotReadCounters counters,
        int articleId,
        PublicHotReadOptions options,
        bool isDevelopment)
    {
        if (!snapshot.TryGetArticle(articleId, out PublicBinaryArtifact artifact))
        {
            counters.ArticleMiss();
            return next(ctx);
        }

        counters.ArticleHit(artifact.Frame.Length);
        string artifactKey = options.EnableDiagnosticHeaders
            ? articleId.ToString(System.Globalization.CultureInfo.InvariantCulture)
            : string.Empty;
        return WriteBinaryFrame(ctx, artifact, counters, options, "article", artifactKey, isDevelopment);
    }

    private static Task ServeList(
        HttpContext ctx,
        PublicHotReadSnapshot snapshot,
        PublicHotReadCounters counters,
        in PublicListKey key,
        PublicHotReadOptions options,
        bool isDevelopment)
    {
        if (!snapshot.TryGetList(key, out PublicBinaryArtifact artifact))
        {
            counters.ListMiss();
            return WriteStatus(ctx, StatusCodes.Status404NotFound, isDevelopment);
        }

        counters.ListHit(artifact.Frame.Length);
        string artifactKey = options.EnableDiagnosticHeaders ? key.ToString() : string.Empty;
        return WriteBinaryFrame(ctx, artifact, counters, options, PublicListArtifactKind(key.Kind), artifactKey, isDevelopment);
    }

    private static Task ServeCategory(
        HttpContext ctx,
        PublicHotReadSnapshot snapshot,
        PublicHotReadCounters counters,
        PublicHotReadOptions options,
        bool isDevelopment)
    {
        if (!snapshot.TryGetCategory(out PublicBinaryArtifact artifact))
        {
            counters.ListMiss();
            return WriteStatus(ctx, StatusCodes.Status404NotFound, isDevelopment);
        }

        counters.ListHit(artifact.Frame.Length);
        return WriteBinaryFrame(ctx, artifact, counters, options, "category", "all", isDevelopment);
    }

    private static Task ServeTag(
        HttpContext ctx,
        PublicHotReadSnapshot snapshot,
        PublicHotReadCounters counters,
        PublicHotReadOptions options,
        bool isDevelopment)
    {
        if (!snapshot.TryGetTag(out PublicBinaryArtifact artifact))
        {
            counters.ListMiss();
            return WriteStatus(ctx, StatusCodes.Status404NotFound, isDevelopment);
        }

        counters.ListHit(artifact.Frame.Length);
        return WriteBinaryFrame(ctx, artifact, counters, options, "tag", "all", isDevelopment);
    }

    private static Task ServeHtml(
        HttpContext ctx,
        PublicHotReadSnapshot snapshot,
        PublicHotReadCounters counters,
        string routeKey,
        PublicHotReadOptions options,
        bool isDevelopment)
    {
        if (!snapshot.TryGetHtml(routeKey, out PublicHtmlArtifact html))
        {
            counters.HtmlMiss();
            return WriteStatus(ctx, StatusCodes.Status404NotFound, isDevelopment);
        }

        counters.HtmlHit(html.Bytes.Length);
        if (html.RequiresCspNonceMutation)
        {
            return ServeHtmlWithNonce(ctx, html, options, snapshot.Version, routeKey, isDevelopment);
        }

        HttpResponse response = ctx.Response;
        response.StatusCode = StatusCodes.Status200OK;
        response.ContentType = string.IsNullOrWhiteSpace(html.ContentType) ? HtmlContentType : html.ContentType;
        response.ContentLength = html.Bytes.Length;
        ApplyStaticPublicSecurityHeaders(response, isDevelopment);
        response.Headers["Cache-Control"] = string.IsNullOrWhiteSpace(html.CacheControl) ? "public,max-age=60" : html.CacheControl;
        response.Headers["Accept-Ranges"] = "none";
        SetPublicAotIdentityHeaders(response, html);
        if (!string.IsNullOrWhiteSpace(html.ETag))
        {
            response.Headers["ETag"] = html.ETag;
        }
        WriteDiagnosticHeaders(response, options, snapshot.Version, "html", routeKey);
        if (MatchesIfNoneMatch(ctx.Request, html.ETag))
        {
            response.StatusCode = StatusCodes.Status304NotModified;
            response.ContentLength = 0;
            return Completed;
        }

        if (HttpMethods.IsHead(ctx.Request.Method))
        {
            return Completed;
        }

        ValueTask<FlushResult> write = response.BodyWriter.WriteAsync(html.Bytes, ctx.RequestAborted);
        return write.IsCompletedSuccessfully ? Completed : AwaitWrite(write);
    }

    private static Task ServeHtmlWithNonce(
        HttpContext ctx,
        PublicHtmlArtifact html,
        PublicHotReadOptions options,
        long snapshotVersion,
        string routeKey,
        bool isDevelopment)
    {
        CspNonceUtf8Template template = html.CspNonceTemplate
            ?? throw new InvalidOperationException("nonce HTML artifact is missing its compiled template");
        HttpResponse response = ctx.Response;
        string nonce = WebApplicationCompositionExtensions.EnsureCspNonce(ctx);
        response.ContentType = string.IsNullOrWhiteSpace(html.ContentType) ? HtmlContentType : html.ContentType;
        ApplyStaticPublicSecurityHeaders(response, isDevelopment, nonce);
        response.Headers["Cache-Control"] = "private,no-store";
        response.Headers["Accept-Ranges"] = "none";
        SetPublicAotIdentityHeaders(response, html);
        response.Headers.Remove("Content-Encoding");
        response.Headers.Remove("ETag");
        WriteDiagnosticHeaders(response, options, snapshotVersion, "html", routeKey);
        if (!PublicAotHtmlResponseNegotiation.AcceptsIdentity(ctx.Request.Headers.AcceptEncoding))
        {
            response.StatusCode = StatusCodes.Status406NotAcceptable;
            response.ContentLength = 0;
            return Completed;
        }

        response.StatusCode = StatusCodes.Status200OK;
        response.ContentLength = template.GetRenderedLength(nonce.Length);

        if (HttpMethods.IsHead(ctx.Request.Method) || response.ContentLength == 0)
        {
            return Completed;
        }

        return CspNonceHtmlResponseWriter.WriteBodyAsync(response, template, nonce, ctx.RequestAborted);
    }

    private static void ApplyStaticPublicSecurityHeaders(HttpResponse response, bool isDevelopment, string? nonce = null)
    {
        response.Headers["X-Content-Type-Options"] = "nosniff";
        response.Headers["Referrer-Policy"] = "strict-origin-when-cross-origin";
        response.Headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), browsing-topics=()";
        response.Headers["X-Frame-Options"] = "DENY";
        response.Headers["Cross-Origin-Embedder-Policy"] = "credentialless";
        response.Headers["Cross-Origin-Opener-Policy"] = "same-origin";
        response.Headers["Cross-Origin-Resource-Policy"] = "same-origin";
        response.Headers["Content-Security-Policy"] = string.IsNullOrWhiteSpace(nonce)
            ? WebApplicationCompositionExtensions.BuildStaticCsp(isDevelopment)
            : WebApplicationCompositionExtensions.BuildHtmlCsp(isDevelopment, nonce);
    }

    private static Task ServePublicHtml(
        HttpContext ctx,
        RequestDelegate next,
        PublicHotReadSnapshot snapshot,
        PublicHotReadCounters counters,
        string routeKey,
        PublicHotReadOptions options,
        bool isDevelopment)
    {
        if (!snapshot.TryGetHtml(routeKey, out _))
        {
            counters.HtmlMiss();
            return next(ctx);
        }

        return ServeHtml(ctx, snapshot, counters, routeKey, options, isDevelopment);
    }

    private static Task WriteBinaryFrame(
        HttpContext ctx,
        PublicBinaryArtifact artifact,
        PublicHotReadCounters counters,
        PublicHotReadOptions options,
        string artifactKind,
        string artifactKey,
        bool isDevelopment)
    {
        if (!TrySelectBinaryVariant(ctx.Request, artifact, out PublicBinaryArtifactVariant variant))
        {
            return WriteStatus(ctx, StatusCodes.Status406NotAcceptable, isDevelopment);
        }
        counters.VariantSelected(variant.ContentEncoding);

        ReadOnlyMemory<byte> frame = variant.Frame;
        HttpResponse response = ctx.Response;
        response.StatusCode = StatusCodes.Status200OK;
        response.ContentType = BinaryContentType;
        response.ContentLength = frame.Length;
        response.Headers["X-Fsus-Frame-Version"] = AedsFrameHeader.CurrentVersion.ToString(System.Globalization.CultureInfo.InvariantCulture);
        response.Headers["X-Content-Type-Options"] = "nosniff";
        response.Headers["Vary"] = "Accept-Encoding";
        response.Headers["Cache-Control"] = string.IsNullOrWhiteSpace(artifact.CacheControl)
            ? (string.IsNullOrWhiteSpace(options.CacheControl) ? "public,max-age=60" : options.CacheControl)
            : artifact.CacheControl;
        response.Headers["Accept-Ranges"] = "none";
        if (!string.IsNullOrWhiteSpace(variant.ETag))
        {
            response.Headers["ETag"] = variant.ETag;
        }
        else
        {
            response.Headers.Remove("ETag");
        }
        response.Headers.Remove("Last-Modified");
        if (string.IsNullOrWhiteSpace(variant.ContentEncoding))
        {
            response.Headers.Remove("Content-Encoding");
        }
        else
        {
            response.Headers["Content-Encoding"] = variant.ContentEncoding;
        }

        response.Headers["X-Fsus-Frame-Encoding"] = string.IsNullOrWhiteSpace(variant.ContentEncoding)
            ? "identity"
            : variant.ContentEncoding;
        WriteDiagnosticHeaders(response, options, artifact.Version, artifactKind, artifactKey);
        if (MatchesIfNoneMatch(ctx.Request, variant.ETag))
        {
            response.StatusCode = StatusCodes.Status304NotModified;
            response.ContentLength = 0;
            return Completed;
        }

        if (HttpMethods.IsHead(ctx.Request.Method))
        {
            return Completed;
        }

        ValueTask<FlushResult> write = response.BodyWriter.WriteAsync(frame, ctx.RequestAborted);
        return write.IsCompletedSuccessfully ? Completed : AwaitWrite(write);
    }

    private static bool TrySelectBinaryVariant(
        HttpRequest request,
        PublicBinaryArtifact artifact,
        out PublicBinaryArtifactVariant variant)
        => TrySelectBinaryVariant(request.Headers.AcceptEncoding, artifact, out variant);

    internal static bool TrySelectBinaryVariantForTests(
        StringValues acceptEncoding,
        PublicBinaryArtifact artifact,
        out PublicBinaryArtifactVariant variant)
        => TrySelectBinaryVariant(acceptEncoding, artifact, out variant);

    private static bool TrySelectBinaryVariant(
        StringValues acceptEncoding,
        PublicBinaryArtifact artifact,
        out PublicBinaryArtifactVariant variant)
    {
        if (TrySelectCommonBinaryVariant(acceptEncoding, artifact, out variant))
        {
            return true;
        }

        BinaryEncodingQuality quality = ParseAcceptEncoding(acceptEncoding);
        double identity = quality.Identity;
        double gzip = quality.Gzip;
        double br = quality.Brotli;

        variant = default;
        double best = -1;
        if (identity > 0 && !artifact.Frame.IsEmpty)
        {
            variant = new PublicBinaryArtifactVariant(artifact.Frame, artifact.ETag, string.Empty);
            best = identity;
        }

        if (gzip > best && gzip > 0 && !artifact.GzipFrame.IsEmpty)
        {
            variant = new PublicBinaryArtifactVariant(artifact.GzipFrame, artifact.GzipETag, "gzip");
            best = gzip;
        }

        if (br >= best && br > 0 && !artifact.BrotliFrame.IsEmpty)
        {
            variant = new PublicBinaryArtifactVariant(artifact.BrotliFrame, artifact.BrotliETag, "br");
            best = br;
        }

        return best > 0 && !variant.Frame.IsEmpty;
    }

    private static bool TrySelectCommonBinaryVariant(
        StringValues values,
        PublicBinaryArtifact artifact,
        out PublicBinaryArtifactVariant variant)
    {
        variant = default;
        if (values.Count == 0)
        {
            return TrySelectIdentity(artifact, out variant);
        }

        if (values.Count != 1)
        {
            return false;
        }

        ReadOnlySpan<char> header = (values[0] ?? string.Empty).AsSpan().Trim();
        if (header.IsEmpty)
        {
            return TrySelectIdentity(artifact, out variant);
        }

        if (header.IndexOf(';') >= 0)
        {
            return false;
        }

        if (header.Equals("br", StringComparison.OrdinalIgnoreCase))
        {
            return TrySelectBrotliGzipIdentity(artifact, out variant);
        }

        if (header.Equals("gzip", StringComparison.OrdinalIgnoreCase))
        {
            return TrySelectGzipIdentity(artifact, out variant);
        }

        if (EqualsCommaPair(header, "gzip".AsSpan(), "br".AsSpan())
            || EqualsCommaPair(header, "br".AsSpan(), "gzip".AsSpan())
            || EqualsCommaTriple(header, "gzip".AsSpan(), "deflate".AsSpan(), "br".AsSpan()))
        {
            return TrySelectBrotliGzipIdentity(artifact, out variant);
        }

        return false;
    }

    private static bool TrySelectBrotliGzipIdentity(PublicBinaryArtifact artifact, out PublicBinaryArtifactVariant variant)
    {
        if (!artifact.BrotliFrame.IsEmpty)
        {
            variant = new PublicBinaryArtifactVariant(artifact.BrotliFrame, artifact.BrotliETag, "br");
            return true;
        }

        return TrySelectGzipIdentity(artifact, out variant);
    }

    private static bool TrySelectGzipIdentity(PublicBinaryArtifact artifact, out PublicBinaryArtifactVariant variant)
    {
        if (!artifact.GzipFrame.IsEmpty)
        {
            variant = new PublicBinaryArtifactVariant(artifact.GzipFrame, artifact.GzipETag, "gzip");
            return true;
        }

        return TrySelectIdentity(artifact, out variant);
    }

    private static bool TrySelectIdentity(PublicBinaryArtifact artifact, out PublicBinaryArtifactVariant variant)
    {
        variant = default;
        if (artifact.Frame.IsEmpty)
        {
            return false;
        }

        variant = new PublicBinaryArtifactVariant(artifact.Frame, artifact.ETag, string.Empty);
        return true;
    }

    private static bool EqualsCommaTriple(
        ReadOnlySpan<char> value,
        ReadOnlySpan<char> first,
        ReadOnlySpan<char> second,
        ReadOnlySpan<char> third)
    {
        int firstComma = value.IndexOf(',');
        if (firstComma <= 0 || !value[..firstComma].Trim().Equals(first, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        ReadOnlySpan<char> rest = value[(firstComma + 1)..];
        int secondComma = rest.IndexOf(',');
        return secondComma > 0
            && rest[..secondComma].Trim().Equals(second, StringComparison.OrdinalIgnoreCase)
            && rest[(secondComma + 1)..].Trim().Equals(third, StringComparison.OrdinalIgnoreCase);
    }

    private readonly record struct BinaryEncodingQuality(double Identity, double Gzip, double Brotli);

    private static BinaryEncodingQuality ParseAcceptEncoding(StringValues values)
    {
        if (values.Count == 0)
        {
            return new BinaryEncodingQuality(1, 0, 0);
        }

        bool saw = false;
        double identity = -1;
        double gzip = -1;
        double br = -1;
        double wildcard = -1;
        for (int i = 0; i < values.Count; i++)
        {
            ReadOnlySpan<char> header = (values[i] ?? string.Empty).AsSpan();
            while (true)
            {
                int comma = header.IndexOf(',');
                ReadOnlySpan<char> segment = comma >= 0 ? header[..comma] : header;
                ReadEncodingSegment(segment, ref saw, ref identity, ref gzip, ref br, ref wildcard);
                if (comma < 0)
                {
                    break;
                }

                header = header[(comma + 1)..];
            }
        }

        if (!saw)
        {
            return new BinaryEncodingQuality(1, 0, 0);
        }

        if (identity < 0)
        {
            identity = wildcard >= 0 ? wildcard : 1;
        }

        if (gzip < 0)
        {
            gzip = wildcard >= 0 ? wildcard : 0;
        }

        if (br < 0)
        {
            br = wildcard >= 0 ? wildcard : 0;
        }

        return new BinaryEncodingQuality(identity, gzip, br);
    }

    private static void ReadEncodingSegment(
        ReadOnlySpan<char> segment,
        ref bool saw,
        ref double identity,
        ref double gzip,
        ref double br,
        ref double wildcard)
    {
        segment = segment.Trim();
        if (segment.IsEmpty)
        {
            return;
        }

        saw = true;
        int semicolon = segment.IndexOf(';');
        ReadOnlySpan<char> name = (semicolon >= 0 ? segment[..semicolon] : segment).Trim();
        double quality = semicolon >= 0 ? ParseQuality(segment[(semicolon + 1)..]) : 1;
        if (name.Equals("identity", StringComparison.OrdinalIgnoreCase))
        {
            identity = quality;
        }
        else if (name.Equals("gzip", StringComparison.OrdinalIgnoreCase))
        {
            gzip = quality;
        }
        else if (name.Equals("br", StringComparison.OrdinalIgnoreCase))
        {
            br = quality;
        }
        else if (name.Equals("*", StringComparison.OrdinalIgnoreCase))
        {
            wildcard = quality;
        }
    }

    private static double ParseQuality(ReadOnlySpan<char> parameters)
    {
        while (!parameters.IsEmpty)
        {
            int semicolon = parameters.IndexOf(';');
            ReadOnlySpan<char> parameter = (semicolon >= 0 ? parameters[..semicolon] : parameters).Trim();
            if (parameter.StartsWith("q=", StringComparison.OrdinalIgnoreCase)
                && double.TryParse(
                    parameter[2..],
                    System.Globalization.NumberStyles.AllowDecimalPoint,
                    System.Globalization.CultureInfo.InvariantCulture,
                    out double quality))
            {
                return Math.Clamp(quality, 0, 1);
            }

            if (semicolon < 0)
            {
                break;
            }

            parameters = parameters[(semicolon + 1)..];
        }

        return 1;
    }

    private static bool MatchesIfNoneMatch(HttpRequest request, string etag)
        => MatchesIfNoneMatch(request.Headers.IfNoneMatch, etag);

    internal static bool MatchesIfNoneMatchForTests(StringValues ifNoneMatch, string etag)
        => MatchesIfNoneMatch(ifNoneMatch, etag);

    private static bool MatchesIfNoneMatch(StringValues values, string etag)
    {
        if (string.IsNullOrWhiteSpace(etag))
        {
            return false;
        }

        if (TryMatchesIfNoneMatchCommon(values, etag, out bool matched))
        {
            return matched;
        }

        for (int i = 0; i < values.Count; i++)
        {
            ReadOnlySpan<char> header = (values[i] ?? string.Empty).AsSpan();
            while (true)
            {
                int comma = header.IndexOf(',');
                ReadOnlySpan<char> candidate = (comma >= 0 ? header[..comma] : header).Trim();
                if (candidate.Equals("*", StringComparison.Ordinal)
                    || candidate.Equals(etag.AsSpan(), StringComparison.Ordinal))
                {
                    return true;
                }

                if (comma < 0)
                {
                    break;
                }

                header = header[(comma + 1)..];
            }
        }

        return false;
    }

    private static bool TryMatchesIfNoneMatchCommon(StringValues values, string etag, out bool matched)
    {
        matched = false;
        if (values.Count == 0)
        {
            return true;
        }

        if (values.Count != 1)
        {
            return false;
        }

        ReadOnlySpan<char> header = (values[0] ?? string.Empty).AsSpan().Trim();
        if (header.IndexOf(',') >= 0)
        {
            return false;
        }

        matched = header.Equals("*", StringComparison.Ordinal)
            || header.Equals(etag.AsSpan(), StringComparison.Ordinal);
        return true;
    }

    private static bool IsTaxonomyCollectionPath(string path)
        => path.Equals(CategoryPathWithoutSuffix, StringComparison.OrdinalIgnoreCase)
           || path.Equals(TagPathWithoutSuffix, StringComparison.OrdinalIgnoreCase);

    private static Task WriteStatus(HttpContext ctx, int statusCode, bool isDevelopment)
    {
        ctx.Response.StatusCode = statusCode;
        ctx.Response.ContentLength = 0;
        ApplyStaticPublicSecurityHeaders(ctx.Response, isDevelopment);
        ctx.Response.Headers["Cache-Control"] = "no-store";
        ctx.Response.Headers["Pragma"] = "no-cache";
        ctx.Response.Headers["Expires"] = "0";
        ctx.Response.Headers["Accept-Ranges"] = "none";
        return Completed;
    }

    private static void WriteDiagnosticHeaders(
        HttpResponse response,
        PublicHotReadOptions options,
        long version,
        string artifactKind,
        string artifactKey)
    {
        if (!options.EnableDiagnosticHeaders)
        {
            return;
        }

        response.Headers["X-Fsus-HotRead-Version"] = version.ToString(System.Globalization.CultureInfo.InvariantCulture);
        response.Headers["X-Fsus-HotRead-Artifact"] = artifactKind;
        response.Headers["X-Fsus-HotRead-Key"] = artifactKey;
    }

    private static void SetPublicAotIdentityHeaders(HttpResponse response, PublicHtmlArtifact html)
    {
        response.Headers["X-Fsus-Public-Aot-Source"] = ServerSsrAotSource;
        response.Headers["X-Fsus-Public-Aot-State"] = "fresh";
        response.Headers["X-Fsus-Public-Aot-Backfill"] = "none";
        response.Headers["X-Fsus-Public-Aot-Version"] = html.RendererVersion;
        response.Headers["X-Fsus-Public-Aot-Frontend-Asset-Version"] = html.FrontendAssetVersion;
    }

    private static string PublicListArtifactKind(PublicListKind kind)
        => kind switch
        {
            PublicListKind.Home => "list-home",
            PublicListKind.Category => "list-category",
            PublicListKind.Tag => "list-tag",
            PublicListKind.Archive => "list-archive",
            PublicListKind.Hot => "hot",
            PublicListKind.Featured => "featured",
            _ => "list"
        };

    private static bool IsSensitiveApiPath(string path)
    {
        foreach (string prefix in SensitiveApiPrefixes)
        {
            if (string.Equals(path, prefix, StringComparison.OrdinalIgnoreCase)
                || (path.Length > prefix.Length
                    && path[prefix.Length] == '/'
                    && path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)))
            {
                return true;
            }
        }

        return false;
    }

    private static bool HasCredentialBearingInput(HttpContext context)
    {
        IHeaderDictionary headers = context.Request.Headers;
        return context.User.Identity?.IsAuthenticated == true
            || headers.ContainsKey("Authorization")
            || headers.ContainsKey("Cookie")
            || headers.ContainsKey("RequestVerificationToken")
            || headers.ContainsKey("X-CSRF-TOKEN")
            || headers.ContainsKey("X-XSRF-TOKEN");
    }

    private static void WriteLegacyRouteHint(HttpContext ctx, string path)
    {
        if (string.Equals(path, ArticlePrefix, StringComparison.Ordinal))
        {
            ctx.Response.Headers["X-Fsus-Required-Route"] = "/api/binary/article/list/home/{page}/{size}.aeds";
            return;
        }

        if (string.Equals(path, "/api/binary/article/hot", StringComparison.Ordinal))
        {
            ctx.Response.Headers["X-Fsus-Required-Route"] = "/api/binary/article/hot/{size}.aeds";
            return;
        }

        if (string.Equals(path, "/api/binary/article/featured", StringComparison.Ordinal))
        {
            ctx.Response.Headers["X-Fsus-Required-Route"] = "/api/binary/article/featured/{size}.aeds";
        }
    }

    private static async Task AwaitWrite(ValueTask<FlushResult> write)
        => _ = await write.ConfigureAwait(false);

    internal static bool TryClassifyRouteForTests(string path, out PublicHotReadRoute route)
        => TryClassifyRoute(path.AsSpan(), path, out route);

    private static bool TryClassifyRoute(ReadOnlySpan<char> path, string pathValue, out PublicHotReadRoute route)
    {
        route = default;
        if (TryClassifyPublicHtmlRoute(path, out route))
        {
            return true;
        }

        if (path.Equals(CategoryPath.AsSpan(), StringComparison.Ordinal)
            || path.Equals(CategoryPathWithoutSuffix.AsSpan(), StringComparison.Ordinal))
        {
            route = new PublicHotReadRoute(PublicHotReadRouteKind.Category);
            return true;
        }

        if (path.Equals(TagPath.AsSpan(), StringComparison.Ordinal)
            || path.Equals(TagPathWithoutSuffix.AsSpan(), StringComparison.Ordinal))
        {
            route = new PublicHotReadRoute(PublicHotReadRouteKind.Tag);
            return true;
        }

        const string articlePrefix = "/api/binary/article/";
        if (!path.StartsWith(articlePrefix, StringComparison.Ordinal))
        {
            return false;
        }

        ReadOnlySpan<char> rest = path[articlePrefix.Length..];
        if (rest.StartsWith("list/".AsSpan(), StringComparison.Ordinal))
        {
            return TryClassifyArticleList(rest["list/".Length..], out route);
        }

        if (rest.StartsWith("hot/".AsSpan(), StringComparison.Ordinal))
        {
            return TryClassifySizeList(rest["hot/".Length..], PublicHotReadRouteKind.ArticleHot, PublicListKind.Hot, out route);
        }

        if (rest.StartsWith("featured/".AsSpan(), StringComparison.Ordinal))
        {
            return TryClassifySizeList(rest["featured/".Length..], PublicHotReadRouteKind.ArticleFeatured, PublicListKind.Featured, out route);
        }

        if (rest.StartsWith("html/".AsSpan(), StringComparison.Ordinal))
        {
            return TryClassifyHtml(rest["html/".Length..], pathValue, out route);
        }

        if (!rest.EndsWith(".aeds".AsSpan(), StringComparison.Ordinal)
            || !TryParsePositiveInt(rest[..^5], out int articleId))
        {
            return false;
        }

        route = new PublicHotReadRoute(PublicHotReadRouteKind.ArticleDetail, ArticleId: articleId);
        return true;
    }

    private static bool TryClassifyArticleList(ReadOnlySpan<char> rest, out PublicHotReadRoute route)
    {
        route = default;
        if (rest.StartsWith("home/".AsSpan(), StringComparison.Ordinal))
        {
            return TryClassifyPagedListTail(
                rest["home/".Length..],
                PublicHotReadRouteKind.ArticleList,
                PublicListKind.Home,
                0,
                out route);
        }

        if (rest.StartsWith("archive/".AsSpan(), StringComparison.Ordinal))
        {
            return TryClassifyPagedListTail(
                rest["archive/".Length..],
                PublicHotReadRouteKind.ArticleList,
                PublicListKind.Archive,
                0,
                out route);
        }

        if (rest.StartsWith("category/".AsSpan(), StringComparison.Ordinal))
        {
            return TryClassifyTargetedPagedListTail(
                rest["category/".Length..],
                PublicHotReadRouteKind.ArticleList,
                PublicListKind.Category,
                out route);
        }

        if (rest.StartsWith("tag/".AsSpan(), StringComparison.Ordinal))
        {
            return TryClassifyTargetedPagedListTail(
                rest["tag/".Length..],
                PublicHotReadRouteKind.ArticleList,
                PublicListKind.Tag,
                out route);
        }

        return false;
    }

    private static bool TryClassifySizeList(
        ReadOnlySpan<char> rest,
        PublicHotReadRouteKind routeKind,
        PublicListKind listKind,
        out PublicHotReadRoute route)
    {
        route = default;
        if (!rest.EndsWith(".aeds".AsSpan(), StringComparison.Ordinal)
            || !TryParseByteSize(rest[..^5], out byte size))
        {
            return false;
        }

        route = new PublicHotReadRoute(routeKind, ListKey: new PublicListKey(listKind, 0, 1, size));
        return true;
    }

    private static bool TryClassifyHtml(ReadOnlySpan<char> rest, string pathValue, out PublicHotReadRoute route)
    {
        route = default;
        if (!rest.EndsWith(".html".AsSpan(), StringComparison.Ordinal))
        {
            return false;
        }

        ReadOnlySpan<char> keySpan = rest[..^5];
        if (keySpan.IsEmpty
            || keySpan.IndexOf('/') >= 0
            || !PublicHotReadRouteKeys.IsSafePathKey(keySpan))
        {
            return false;
        }

        route = new PublicHotReadRoute(PublicHotReadRouteKind.ArticleHtml, HtmlRouteKey: pathValue);
        return true;
    }

    private static bool TryClassifyPublicHtmlRoute(ReadOnlySpan<char> path, out PublicHotReadRoute route)
    {
        route = default;
        bool hasNonCanonicalTagTrailingSlash = path.Length > PublicRouteIdentityRegistry.TagPathPrefix.Length
            && path.StartsWith(PublicRouteIdentityRegistry.TagPathPrefix.AsSpan(), StringComparison.OrdinalIgnoreCase)
            && path[^1] == '/';
        path = TrimPublicHtmlPath(path);

        if (PublicAotPageCatalog.TryGetByStaticPath(path, out PublicAotPageDescriptor descriptor)
            && !string.IsNullOrWhiteSpace(descriptor.FixedRouteKey))
        {
            route = new PublicHotReadRoute(
                PublicHotReadRouteKind.PublicHtml,
                HtmlRouteKey: PublicHotReadRouteKeys.HtmlPath(descriptor.FixedRouteKey));
            return true;
        }

        if (path.StartsWith(PublicRouteIdentityRegistry.ArticlePathPrefix.AsSpan(), StringComparison.Ordinal)
            && TryParseSinglePositiveIntPathTail(path[PublicRouteIdentityRegistry.ArticlePathPrefix.Length..], out int articleId))
        {
            route = new PublicHotReadRoute(
                PublicHotReadRouteKind.PublicHtml,
                ArticleId: articleId,
                HtmlRouteKey: PublicHotReadRouteKeys.HtmlPath(PublicRouteIdentity.BuildArticleRouteKey(articleId)));
            return true;
        }

        if (path.StartsWith(PublicRouteIdentityRegistry.CategoryPathPrefix.AsSpan(), StringComparison.Ordinal)
            && TryParseSinglePositiveIntPathTail(path[PublicRouteIdentityRegistry.CategoryPathPrefix.Length..], out int categoryId))
        {
            route = new PublicHotReadRoute(
                PublicHotReadRouteKind.PublicHtml,
                HtmlRouteKey: PublicHotReadRouteKeys.HtmlPath(PublicRouteIdentity.BuildCategoryRouteKey(categoryId)));
            return true;
        }

        if (!path.StartsWith(PublicRouteIdentityRegistry.TagPathPrefix.AsSpan(), StringComparison.Ordinal))
        {
            return false;
        }

        if (hasNonCanonicalTagTrailingSlash)
        {
            return false;
        }

        ReadOnlySpan<char> tagTail = path[PublicRouteIdentityRegistry.TagPathPrefix.Length..];
        if (TryParseSinglePositiveIntPathTail(tagTail, out int tagId))
        {
            route = new PublicHotReadRoute(
                PublicHotReadRouteKind.PublicHtml,
                HtmlRouteKey: PublicHotReadRouteKeys.HtmlPath(PublicRouteIdentity.BuildTagIdRouteKey(tagId)));
            return true;
        }

        // A non-numeric tag tail is a legacy name alias. It must reach the AOT
        // shell resolver so the request receives the single-hop 301 to /tag/{id};
        // serving a previously published name artifact here would incorrectly
        // turn the alias back into a second canonical 200 URL.
        return false;
    }

    private static ReadOnlySpan<char> TrimPublicHtmlPath(ReadOnlySpan<char> path)
    {
        while (path.Length > 1 && path[^1] == '/')
        {
            path = path[..^1];
        }

        return path;
    }

    private static bool TryParseSinglePositiveIntPathTail(ReadOnlySpan<char> tail, out int id)
    {
        id = 0;
        return tail.IndexOf('/') < 0 && TryParsePositiveInt(tail, out id);
    }

    private static bool TryClassifyPagedListTail(
        ReadOnlySpan<char> rest,
        PublicHotReadRouteKind routeKind,
        PublicListKind listKind,
        int targetId,
        out PublicHotReadRoute route)
    {
        route = default;
        if (!rest.EndsWith(".aeds".AsSpan(), StringComparison.Ordinal))
        {
            return false;
        }

        rest = rest[..^5];
        int slash = rest.IndexOf('/');
        if (slash <= 0 || slash == rest.Length - 1)
        {
            return false;
        }

        if (!TryParseUShort(rest[..slash], out ushort page)
            || !TryParseByteSize(rest[(slash + 1)..], out byte size))
        {
            return false;
        }

        route = new PublicHotReadRoute(routeKind, ListKey: new PublicListKey(listKind, targetId, page, size));
        return true;
    }

    private static bool TryClassifyTargetedPagedListTail(
        ReadOnlySpan<char> rest,
        PublicHotReadRouteKind routeKind,
        PublicListKind listKind,
        out PublicHotReadRoute route)
    {
        route = default;
        if (!rest.EndsWith(".aeds".AsSpan(), StringComparison.Ordinal))
        {
            return false;
        }

        rest = rest[..^5];
        int first = rest.IndexOf('/');
        if (first <= 0 || first == rest.Length - 1)
        {
            return false;
        }

        int secondRelative = rest[(first + 1)..].IndexOf('/');
        if (secondRelative <= 0)
        {
            return false;
        }

        int second = first + 1 + secondRelative;
        if (!TryParsePositiveInt(rest[..first], out int targetId)
            || !TryParseUShort(rest[(first + 1)..second], out ushort page)
            || !TryParseByteSize(rest[(second + 1)..], out byte size))
        {
            return false;
        }

        route = new PublicHotReadRoute(routeKind, ListKey: new PublicListKey(listKind, targetId, page, size));
        return true;
    }

    internal static bool TryMatchArticleDetail(ReadOnlySpan<char> path, out int articleId)
    {
        articleId = 0;
        if (!TryClassifyRoute(path, string.Empty, out PublicHotReadRoute route)
            || route.Kind != PublicHotReadRouteKind.ArticleDetail)
        {
            return false;
        }

        articleId = route.ArticleId;
        return true;
    }

    internal static bool TryMatchArticleList(ReadOnlySpan<char> path, out PublicListKey key)
    {
        key = default;
        if (!TryClassifyRoute(path, string.Empty, out PublicHotReadRoute route)
            || route.Kind != PublicHotReadRouteKind.ArticleList)
        {
            return false;
        }

        key = route.ListKey;
        return true;
    }

    internal static bool TryMatchArticleHot(ReadOnlySpan<char> path, out PublicListKey key)
    {
        key = default;
        if (!TryClassifyRoute(path, string.Empty, out PublicHotReadRoute route)
            || route.Kind != PublicHotReadRouteKind.ArticleHot)
        {
            return false;
        }

        key = route.ListKey;
        return true;
    }

    internal static bool TryMatchArticleFeatured(ReadOnlySpan<char> path, out PublicListKey key)
    {
        key = default;
        if (!TryClassifyRoute(path, string.Empty, out PublicHotReadRoute route)
            || route.Kind != PublicHotReadRouteKind.ArticleFeatured)
        {
            return false;
        }

        key = route.ListKey;
        return true;
    }

    internal static bool TryMatchArticleHtml(ReadOnlySpan<char> path, string pathValue, out string routeKey)
    {
        routeKey = string.Empty;
        if (!TryClassifyRoute(path, pathValue, out PublicHotReadRoute route)
            || route.Kind != PublicHotReadRouteKind.ArticleHtml)
        {
            return false;
        }

        routeKey = route.HtmlRouteKey;
        return true;
    }

    private static bool TryParsePositiveInt(ReadOnlySpan<char> value, out int parsed)
    {
        parsed = 0;
        if (value.IsEmpty || value.Length > 9)
        {
            return false;
        }

        int result = 0;
        for (int i = 0; i < value.Length; i++)
        {
            char c = value[i];
            if ((uint)(c - '0') > 9)
            {
                return false;
            }

            result = checked(result * 10 + (c - '0'));
        }

        parsed = result;
        return parsed > 0;
    }

    private static bool TryParseUShort(ReadOnlySpan<char> value, out ushort parsed)
    {
        parsed = 0;
        if (!TryParsePositiveInt(value, out int result) || result > ushort.MaxValue)
        {
            return false;
        }

        parsed = (ushort)result;
        return true;
    }

    private static bool TryParseByteSize(ReadOnlySpan<char> value, out byte parsed)
    {
        parsed = 0;
        if (!TryParsePositiveInt(value, out int result) || result > 100)
        {
            return false;
        }

        parsed = (byte)result;
        return true;
    }
}

public readonly record struct PublicHotReadCounterSnapshot(
    long ArticleHit,
    long ArticleMiss,
    long ListHit,
    long ListMiss,
    long HtmlHit,
    long HtmlMiss,
    long Rejected,
    long Bytes,
    long IdentityVariant,
    long BrotliVariant,
    long GzipVariant);

public sealed class PublicHotReadCounters
{
    private readonly CounterStripe[] _stripes = BuildStripes();
    private readonly PublicHotReadCounterMode _mode;
    private readonly int _sampleRate;

    public PublicHotReadCounters(IOptions<PublicHotReadOptions>? options = null)
    {
        PublicHotReadOptions value = options?.Value ?? new PublicHotReadOptions();
        _mode = value.CounterMode;
        _sampleRate = Math.Clamp(value.CounterSampleRate, 1, 4096);
    }

    public void ArticleHit(int bytes)
    {
        if (!ShouldRecordHit())
        {
            return;
        }

        CounterStripe stripe = PickStripe();
        Interlocked.Increment(ref stripe.ArticleHit);
        Interlocked.Add(ref stripe.Bytes, bytes);
    }

    public void ArticleMiss() => Interlocked.Increment(ref PickStripe().ArticleMiss);
    public void ListHit(int bytes)
    {
        if (!ShouldRecordHit())
        {
            return;
        }

        CounterStripe stripe = PickStripe();
        Interlocked.Increment(ref stripe.ListHit);
        Interlocked.Add(ref stripe.Bytes, bytes);
    }

    public void ListMiss() => Interlocked.Increment(ref PickStripe().ListMiss);
    public void HtmlHit(int bytes)
    {
        if (!ShouldRecordHit())
        {
            return;
        }

        CounterStripe stripe = PickStripe();
        Interlocked.Increment(ref stripe.HtmlHit);
        Interlocked.Add(ref stripe.Bytes, bytes);
    }

    public void HtmlMiss() => Interlocked.Increment(ref PickStripe().HtmlMiss);
    public void Rejected() => Interlocked.Increment(ref PickStripe().Rejected);
    public void VariantSelected(string contentEncoding)
    {
        if (!ShouldRecordHit())
        {
            return;
        }

        CounterStripe stripe = PickStripe();
        if (string.Equals(contentEncoding, "br", StringComparison.Ordinal))
        {
            Interlocked.Increment(ref stripe.BrotliVariant);
        }
        else if (string.Equals(contentEncoding, "gzip", StringComparison.Ordinal))
        {
            Interlocked.Increment(ref stripe.GzipVariant);
        }
        else
        {
            Interlocked.Increment(ref stripe.IdentityVariant);
        }
    }

    public PublicHotReadCounterSnapshot Snapshot()
        => Collect(reset: false);

    public PublicHotReadCounterSnapshot CollectAndReset()
        => Collect(reset: true);

    private PublicHotReadCounterSnapshot Collect(bool reset)
    {
        long articleHit = 0;
        long articleMiss = 0;
        long listHit = 0;
        long listMiss = 0;
        long htmlHit = 0;
        long htmlMiss = 0;
        long rejected = 0;
        long bytes = 0;
        long identityVariant = 0;
        long brotliVariant = 0;
        long gzipVariant = 0;

        foreach (CounterStripe stripe in _stripes)
        {
            articleHit += reset ? Interlocked.Exchange(ref stripe.ArticleHit, 0) : Volatile.Read(ref stripe.ArticleHit);
            articleMiss += reset ? Interlocked.Exchange(ref stripe.ArticleMiss, 0) : Volatile.Read(ref stripe.ArticleMiss);
            listHit += reset ? Interlocked.Exchange(ref stripe.ListHit, 0) : Volatile.Read(ref stripe.ListHit);
            listMiss += reset ? Interlocked.Exchange(ref stripe.ListMiss, 0) : Volatile.Read(ref stripe.ListMiss);
            htmlHit += reset ? Interlocked.Exchange(ref stripe.HtmlHit, 0) : Volatile.Read(ref stripe.HtmlHit);
            htmlMiss += reset ? Interlocked.Exchange(ref stripe.HtmlMiss, 0) : Volatile.Read(ref stripe.HtmlMiss);
            rejected += reset ? Interlocked.Exchange(ref stripe.Rejected, 0) : Volatile.Read(ref stripe.Rejected);
            bytes += reset ? Interlocked.Exchange(ref stripe.Bytes, 0) : Volatile.Read(ref stripe.Bytes);
            identityVariant += reset ? Interlocked.Exchange(ref stripe.IdentityVariant, 0) : Volatile.Read(ref stripe.IdentityVariant);
            brotliVariant += reset ? Interlocked.Exchange(ref stripe.BrotliVariant, 0) : Volatile.Read(ref stripe.BrotliVariant);
            gzipVariant += reset ? Interlocked.Exchange(ref stripe.GzipVariant, 0) : Volatile.Read(ref stripe.GzipVariant);
        }

        return new PublicHotReadCounterSnapshot(
            articleHit,
            articleMiss,
            listHit,
            listMiss,
            htmlHit,
            htmlMiss,
            rejected,
            bytes,
            identityVariant,
            brotliVariant,
            gzipVariant);
    }

    private CounterStripe PickStripe()
    {
        int index = Environment.CurrentManagedThreadId % _stripes.Length;
        return _stripes[index];
    }

    private bool ShouldRecordHit()
        => _mode switch
        {
            PublicHotReadCounterMode.Off => false,
            PublicHotReadCounterMode.Sampled => (Environment.TickCount & int.MaxValue) % _sampleRate == 0,
            _ => true
        };

    private static CounterStripe[] BuildStripes()
    {
        int count = Math.Max(2, Environment.ProcessorCount * 2);
        CounterStripe[] stripes = new CounterStripe[count];
        for (int i = 0; i < stripes.Length; i++)
        {
            stripes[i] = new CounterStripe();
        }

        return stripes;
    }

    [StructLayout(LayoutKind.Explicit, Size = 128)]
    private sealed class CounterStripe
    {
        [FieldOffset(0)] public long ArticleHit;
        [FieldOffset(8)] public long ArticleMiss;
        [FieldOffset(16)] public long ListHit;
        [FieldOffset(24)] public long ListMiss;
        [FieldOffset(32)] public long HtmlHit;
        [FieldOffset(40)] public long HtmlMiss;
        [FieldOffset(48)] public long Rejected;
        [FieldOffset(56)] public long Bytes;
        [FieldOffset(64)] public long IdentityVariant;
        [FieldOffset(72)] public long BrotliVariant;
        [FieldOffset(80)] public long GzipVariant;
    }
}

public sealed class PublicHotReadMetricFlushWorker(
    PublicHotReadCounters counters,
    PublicHotReadClassifierCounters classifierCounters,
    ILogger<PublicHotReadMetricFlushWorker> logger) : BackgroundService
{
    private static readonly Meter Meter = new("FsusBlog.PublicHotRead", "1.0.0");
    private static readonly Counter<long> ArticleHitCounter = Meter.CreateCounter<long>("fsus.hotread.article.hit");
    private static readonly Counter<long> ArticleMissCounter = Meter.CreateCounter<long>("fsus.hotread.article.miss");
    private static readonly Counter<long> ListHitCounter = Meter.CreateCounter<long>("fsus.hotread.list.hit");
    private static readonly Counter<long> ListMissCounter = Meter.CreateCounter<long>("fsus.hotread.list.miss");
    private static readonly Counter<long> HtmlHitCounter = Meter.CreateCounter<long>("fsus.hotread.html.hit");
    private static readonly Counter<long> HtmlMissCounter = Meter.CreateCounter<long>("fsus.hotread.html.miss");
    private static readonly Counter<long> BytesCounter = Meter.CreateCounter<long>("fsus.hotread.bytes");
    private static readonly Counter<long> IdentityVariantCounter = Meter.CreateCounter<long>("fsus.hotread.encoding.identity");
    private static readonly Counter<long> BrotliVariantCounter = Meter.CreateCounter<long>("fsus.hotread.encoding.br");
    private static readonly Counter<long> GzipVariantCounter = Meter.CreateCounter<long>("fsus.hotread.encoding.gzip");
    private static readonly Counter<long> SensitivePrefixBypassCounter =
        Meter.CreateCounter<long>("fsus.hotread.classifier.sensitive_bypass");
    private static readonly Counter<long> CredentialBypassCounter =
        Meter.CreateCounter<long>("fsus.hotread.classifier.credential_bypass");

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken).ConfigureAwait(false))
            {
                Flush();
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            Flush();
        }
    }

    private void Flush()
    {
        PublicHotReadCounterSnapshot snapshot = counters.CollectAndReset();
        long sensitivePrefixBypass = classifierCounters.CollectSensitivePrefixBypassAndReset();
        long credentialBypass = classifierCounters.CollectCredentialBypassAndReset();
        AddIfPositive(ArticleHitCounter, snapshot.ArticleHit);
        AddIfPositive(ArticleMissCounter, snapshot.ArticleMiss);
        AddIfPositive(ListHitCounter, snapshot.ListHit);
        AddIfPositive(ListMissCounter, snapshot.ListMiss);
        AddIfPositive(HtmlHitCounter, snapshot.HtmlHit);
        AddIfPositive(HtmlMissCounter, snapshot.HtmlMiss);
        AddIfPositive(BytesCounter, snapshot.Bytes);
        AddIfPositive(IdentityVariantCounter, snapshot.IdentityVariant);
        AddIfPositive(BrotliVariantCounter, snapshot.BrotliVariant);
        AddIfPositive(GzipVariantCounter, snapshot.GzipVariant);
        AddIfPositive(SensitivePrefixBypassCounter, sensitivePrefixBypass);
        AddIfPositive(CredentialBypassCounter, credentialBypass);
        if (snapshot.Rejected > 0)
        {
            logger.LogDebug("public-hot-read-rejected {Count}", snapshot.Rejected);
        }
        if (sensitivePrefixBypass > 0)
        {
            logger.LogWarning(
                "public-hot-read-sensitive-prefix-bypass {Count}",
                sensitivePrefixBypass);
        }
        if (credentialBypass > 0)
        {
            logger.LogInformation(
                "public-hot-read-credential-bypass {Count}",
                credentialBypass);
        }
    }

    private static void AddIfPositive(Counter<long> counter, long value)
    {
        if (value > 0)
        {
            counter.Add(value);
        }
    }
}

internal static class PublicHotReadHtmlArtifactFactory
{
    internal static PublicHtmlArtifact FromHtml(
        string html,
        string cacheControl,
        string rendererVersion = "",
        string frontendAssetVersion = "")
    {
        byte[] bytes = Encoding.UTF8.GetBytes(html);
        string etag = CreateEtag(bytes);
        CspNonceUtf8Template? nonceTemplate = CspNonceUtf8Template.Compile(
            html,
            string.Concat("hot:sha256:", CreateDigest(bytes)));
        return new PublicHtmlArtifact(
            bytes,
            "text/html; charset=utf-8",
            etag,
            cacheControl,
            nonceTemplate,
            rendererVersion,
            frontendAssetVersion);
    }

    internal static PublicHtmlArtifact FromDocument(PublicAotHtmlArtifact document, string cacheControl)
    {
        return new PublicHtmlArtifact(
            document.Utf8Bytes,
            string.IsNullOrWhiteSpace(document.ContentType) ? "text/html; charset=utf-8" : document.ContentType,
            document.ETag,
            string.IsNullOrWhiteSpace(cacheControl) ? document.CacheControl : cacheControl,
            document.CspNonceTemplate,
            document.RendererVersion,
            document.FrontendAssetVersion);
    }

    private static string CreateEtag(ReadOnlySpan<byte> bytes)
    {
        Span<byte> hash = stackalloc byte[32];
        SHA256.HashData(bytes, hash);
        return string.Concat("\"", Convert.ToHexStringLower(hash[..8]), "\"");
    }

    private static string CreateDigest(ReadOnlySpan<byte> bytes)
    {
        Span<byte> hash = stackalloc byte[32];
        SHA256.HashData(bytes, hash);
        return Convert.ToHexStringLower(hash);
    }

}

internal static class PublicHotReadRouteKeys
{
    private const string HtmlPrefix = "/api/binary/article/html/";
    private const string HtmlSuffix = ".html";

    internal static PublicHtmlRouteIndex CreateHtmlIndex(string routeKey, PublicPageId pageId)
    {
        string normalizedRouteKey = routeKey.Trim();
        PublicPageId normalizedPageId = Enum.IsDefined(typeof(PublicPageId), pageId) ? pageId : PublicPageId.Home;
        return new PublicHtmlRouteIndex(
            normalizedRouteKey,
            HtmlPathKey(normalizedRouteKey),
            normalizedPageId);
    }

    internal static string HtmlPath(string routeKey)
        => string.Concat(HtmlPrefix, HtmlPathKey(routeKey), HtmlSuffix);

    internal static string HtmlPathKey(string routeKey)
    {
        string trimmed = routeKey.Trim();
        if (TryExtractPathKey(trimmed, out string existingPathKey))
        {
            return existingPathKey;
        }

        if (trimmed.StartsWith(PublicRouteIdentityRegistry.TagNameBucket + ":", StringComparison.Ordinal))
        {
            return string.Concat(PublicRouteIdentityRegistry.TagNameBucket, "-", StableRouteHash(trimmed));
        }

        string candidate = trimmed.Replace(':', '-').ToLowerInvariant();
        if (IsSafePathKey(candidate.AsSpan()))
        {
            return candidate;
        }

        return string.Concat("route-", StableRouteHash(trimmed));
    }

    internal static bool IsSafePathKey(ReadOnlySpan<char> value)
    {
        if (value.IsEmpty)
        {
            return false;
        }

        for (int i = 0; i < value.Length; i++)
        {
            char c = value[i];
            if ((uint)(c - 'a') <= 25
                || (uint)(c - '0') <= 9
                || c == '-'
                || c == '_')
            {
                continue;
            }

            return false;
        }

        return true;
    }

    private static bool TryExtractPathKey(string routeKey, out string pathKey)
    {
        pathKey = string.Empty;
        if (!routeKey.StartsWith(HtmlPrefix, StringComparison.Ordinal)
            || !routeKey.EndsWith(HtmlSuffix, StringComparison.Ordinal)
            || routeKey.Length <= HtmlPrefix.Length + HtmlSuffix.Length)
        {
            return false;
        }

        string candidate = routeKey[HtmlPrefix.Length..^HtmlSuffix.Length];
        if (!IsSafePathKey(candidate.AsSpan()))
        {
            pathKey = string.Concat("route-", StableRouteHash(routeKey));
            return true;
        }

        pathKey = candidate;
        return true;
    }

    private static string StableRouteHash(string routeKey)
    {
        Span<byte> hash = stackalloc byte[32];
        SHA256.HashData(Encoding.UTF8.GetBytes(routeKey), hash);
        return Convert.ToHexStringLower(hash[..8]);
    }
}

internal static class PublicHotReadBinaryArtifactFactory
{
    internal static PublicBinaryArtifact FromPayload(
        IAedsEncoder encoder,
        AedsFrameType frameType,
        byte[] payload,
        string cacheControl,
        long version,
        PublicHotReadOptions options)
    {
        byte[] frame = encoder.Encode(frameType, payload);
        if (frame.Length > options.MaxFrameBytes)
        {
            throw new InvalidOperationException($"public hot-read frame too large: {frameType} {frame.Length} bytes");
        }

        if (options.ValidateFramesOnPublish && !LooksLikeExpectedAedsFrame(frame, frameType))
        {
            throw new InvalidOperationException($"public hot-read frame validation failed: {frameType}");
        }

        string etag = CreateEtag(frame);
        ReadOnlyMemory<byte> brotliFrame = default;
        string brotliEtag = string.Empty;
        ReadOnlyMemory<byte> gzipFrame = default;
        string gzipEtag = string.Empty;
        if (options.EnablePrecompressedBinaryVariants && frame.Length >= options.MinPrecompressedFrameBytes)
        {
            int minimumShare = Math.Clamp(options.MinResidentVariantClientSharePercent, 0, 100);
            int minimumSavings = Math.Clamp(options.MinCompressionSavingsPercent, 0, 99);
            byte[]? compressedBrotli = options.ExpectedBrotliClientSharePercent >= minimumShare
                ? TryCompress(frame, "br", minimumSavings)
                : null;
            if (compressedBrotli is { Length: > 0 })
            {
                brotliFrame = compressedBrotli;
                brotliEtag = CreateEtag(compressedBrotli);
            }

            byte[]? compressedGzip = options.ExpectedGzipClientSharePercent >= minimumShare
                ? TryCompress(frame, "gzip", minimumSavings)
                : null;
            if (compressedGzip is { Length: > 0 })
            {
                gzipFrame = compressedGzip;
                gzipEtag = CreateEtag(compressedGzip);
            }
        }

        return new PublicBinaryArtifact(frame, etag, cacheControl, version, frameType, brotliFrame, brotliEtag, gzipFrame, gzipEtag);
    }

    private static string CreateEtag(ReadOnlySpan<byte> bytes)
    {
        Span<byte> hash = stackalloc byte[32];
        SHA256.HashData(bytes, hash);
        return string.Concat("\"", Convert.ToHexStringLower(hash[..8]), "\"");
    }

    private static byte[]? TryCompress(ReadOnlySpan<byte> frame, string encoding, int minimumSavingsPercent)
    {
        using var output = new MemoryStream();
        if (encoding == "br")
        {
            using (var brotli = new BrotliStream(output, CompressionLevel.SmallestSize, leaveOpen: true))
            {
                brotli.Write(frame);
            }
        }
        else
        {
            using (var gzip = new GZipStream(output, CompressionLevel.SmallestSize, leaveOpen: true))
            {
                gzip.Write(frame);
            }
        }

        long savedBytes = frame.Length - output.Length;
        if (savedBytes <= 0 || (savedBytes * 100) < ((long)frame.Length * minimumSavingsPercent))
        {
            return null;
        }

        return output.ToArray();
    }

    internal static bool LooksLikeExpectedAedsFrame(ReadOnlySpan<byte> frame, AedsFrameType expectedFrameType)
    {
        if (frame.Length < AedsFrameHeader.Size)
        {
            return false;
        }

        uint magic = BinaryPrimitives.ReadUInt32LittleEndian(frame[0..4]);
        if (magic != AedsEncoder.Magic
            || frame[4] != AedsFrameHeader.CurrentVersion
            || frame[5] != AedsFrameHeader.Size)
        {
            return false;
        }

        ushort frameType = BinaryPrimitives.ReadUInt16LittleEndian(frame[8..10]);
        uint payloadLength = BinaryPrimitives.ReadUInt32LittleEndian(frame[10..14]);
        if (frameType != (ushort)expectedFrameType || payloadLength != (uint)(frame.Length - AedsFrameHeader.Size))
        {
            return false;
        }

        ushort expectedCrc = BinaryPrimitives.ReadUInt16LittleEndian(frame[14..16]);
        return expectedCrc == AedsCrc16.Compute(frame[AedsFrameHeader.Size..]);
    }
}
