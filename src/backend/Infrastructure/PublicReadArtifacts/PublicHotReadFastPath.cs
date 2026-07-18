using System.Buffers.Binary;
using System.Collections.Frozen;
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
using FsusBlog.Server.Infrastructure.Middlewares;
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
    string GzipETag = "",
    PublicArtifactIntegrityTag FrameIntegrityTag = default,
    PublicArtifactIntegrityTag BrotliIntegrityTag = default,
    PublicArtifactIntegrityTag GzipIntegrityTag = default);

public readonly record struct PublicBinaryArtifactVariant(
    ReadOnlyMemory<byte> Frame,
    string ETag,
    string ContentEncoding,
    PublicArtifactIntegrityTag IntegrityTag = default);

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
    string FrontendAssetVersion = "",
    PublicArtifactIntegrityTag IntegrityTag = default,
    PublicArtifactIntegrityTag TemplateIntegrityTag = default)
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
    public long MaxResidentBytes
    {
        get; set;
    }
    public long MaxRawBytes
    {
        get; set;
    }
    public long MaxCompressedBytes
    {
        get; set;
    }
    public long MaxHtmlBytes
    {
        get; set;
    }
    public long MaxSnapshotOverlapBytes
    {
        get; set;
    }
    public int MaxRetiringSnapshots
    {
        get; set;
    }
    public long MaxRetiringBytes
    {
        get; set;
    }
    public TimeSpan RetiringSnapshotDeadline
    {
        get; set;
    }
    public TimeSpan MaxSnapshotAge { get; set; } = TimeSpan.FromMinutes(5);
    public long MaxArticleResidentBytes
    {
        get; set;
    }
    public int MaxArtifactObjects
    {
        get; set;
    }
    public int ArticleAdmissionRecentPercent { get; set; } = 40;
    public bool EnablePrecompressedBinaryVariants { get; set; } = true;
    public int MinPrecompressedFrameBytes { get; set; } = 256;
    public int MinCompressionSavingsPercent { get; set; } = 8;
    public int ExpectedBrotliClientSharePercent { get; set; } = 80;
    public int ExpectedGzipClientSharePercent { get; set; } = 15;
    public int MinResidentVariantClientSharePercent { get; set; } = 5;
    public bool FailOpenWhenNotReady
    {
        get; set;
    }
    public bool EnableDiagnosticHeaders
    {
        get; set;
    }
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
    string SourceVisibility,
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
        _articleFramesById = articleFramesById.ToFrozenDictionary(
            static pair => pair.Key,
            static pair => PublicHotReadArtifactIntegrity.Seal(
                pair.Value,
                PublicArtifactIntegrityContext.ForArticle(pair.Key)));
        _listFrames = listFrames.ToFrozenDictionary(
            static pair => pair.Key,
            static pair => PublicHotReadArtifactIntegrity.Seal(
                pair.Value,
                PublicArtifactIntegrityContext.ForList(pair.Key)));
        _categoryFrame = PublicHotReadArtifactIntegrity.Seal(
            categoryFrame,
            PublicArtifactIntegrityContext.ForCategory());
        _tagFrame = PublicHotReadArtifactIntegrity.Seal(
            tagFrame,
            PublicArtifactIntegrityContext.ForTag());
        _htmlBaseByPath = htmlBaseByPath.ToFrozenDictionary(
            static pair => pair.Key,
            static pair => PublicHotReadArtifactIntegrity.Seal(
                pair.Value,
                PublicArtifactIntegrityContext.ForHtml(pair.Key)),
            StringComparer.Ordinal);
        _htmlOverlayByPath = htmlOverlayByPath.ToFrozenDictionary(
            static pair => pair.Key,
            static pair => PublicHotReadArtifactIntegrity.Seal(
                pair.Value,
                PublicArtifactIntegrityContext.ForHtml(pair.Key)),
            StringComparer.Ordinal);
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

    public long Version
    {
        get;
    }
    public PublicHotReadPublicationEvidence PublicationEvidence
    {
        get;
    }

    public int ArticleFrameCount => _articleFramesById.Count;
    public int PublicArticleCount
    {
        get;
    }
    public int ArticleFrameLimit
    {
        get;
    }
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
    private static readonly TimeSpan MinimumSnapshotAge = TimeSpan.FromSeconds(2);
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
    private readonly TimeSpan _maxSnapshotAge;
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
        if (value.MaxSnapshotAge < MinimumSnapshotAge)
        {
            throw new ArgumentOutOfRangeException(
                nameof(value.MaxSnapshotAge),
                value.MaxSnapshotAge,
                $"Snapshot age must be at least {MinimumSnapshotAge}.");
        }
        _maxSnapshotAge = value.MaxSnapshotAge;
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
            DateTimeOffset visibilityCutoff = next.PublicationEvidence.VisibilityCutoffUtc!.Value;
            if (visibilityCutoff > now)
            {
                SetLifecycleStageLocked("sanity-future-cutoff-rejected");
                throw new InvalidOperationException($"public hot-read snapshot cutoff is in the future: {visibilityCutoff:O}");
            }
            if (now - visibilityCutoff > _maxSnapshotAge)
            {
                SetLifecycleStageLocked("sanity-age-rejected");
                throw new InvalidOperationException($"public hot-read snapshot age exceeded: {visibilityCutoff:O}");
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
                if (_retiringLimits.MaxSnapshots > 0
                    && predictedRetiringCount > _retiringLimits.MaxSnapshots)
                {
                    violations.Add($"retiring-count:{predictedRetiringCount}>{_retiringLimits.MaxSnapshots}");
                }
                if (predictedRetiringBytes > _retiringLimits.MaxBytes)
                {
                    violations.Add($"retiring-bytes:{predictedRetiringBytes}>{_retiringLimits.MaxBytes}");
                }
                if (_retiringLimits.Deadline > TimeSpan.Zero
                    && retiringState.OldestRetiredAtUtc is { } oldest
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
            if (!PublicHotReadArtifactIntegrity.IsSnapshotValid(next))
            {
                SetLifecycleStageLocked("sanity-integrity-rejected");
                throw new InvalidOperationException(
                    $"public hot-read snapshot integrity or schema invalid: {PublicHotReadArtifactIntegrity.Algorithm}");
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

    internal bool TryGetRequestSnapshot(out PublicHotReadSnapshot snapshot, out string reason)
    {
        snapshot = Current;
        if (!IsReadyFast || snapshot.Version <= 0)
        {
            reason = "not-ready";
            return false;
        }

        DateTimeOffset? cutoff = snapshot.PublicationEvidence.VisibilityCutoffUtc;
        DateTimeOffset now = _timeProvider.GetUtcNow();
        if (!cutoff.HasValue || cutoff.Value > now || now - cutoff.Value > _maxSnapshotAge)
        {
            reason = cutoff > now ? "future-cutoff" : "stale";
            return false;
        }

        reason = "ok";
        return true;
    }

    internal bool ShouldRefreshSnapshot()
    {
        PublicHotReadSnapshot snapshot = Current;
        DateTimeOffset? cutoff = snapshot.PublicationEvidence.VisibilityCutoffUtc;
        DateTimeOffset now = _timeProvider.GetUtcNow();
        return !IsReadyFast
            || !cutoff.HasValue
            || cutoff.Value > now
            || now - cutoff.Value >= TimeSpan.FromTicks(_maxSnapshotAge.Ticks / 2);
    }

    internal TimeSpan SnapshotRefreshInterval
        => TimeSpan.FromTicks(_maxSnapshotAge.Ticks / 2);

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

        PublicHotReadSnapshot current = Current;
        if (current.Version == 0)
        {
            return;
        }

        Publish(current.WithoutHtml(PublicHotReadRouteKeys.HtmlPath(routeKey)));
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
