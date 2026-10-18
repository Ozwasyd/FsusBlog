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
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Shared.Contracts.Localization;
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

/// <summary>
/// Named disposition for distributed public-hot-read snapshot invalidation.
/// Callers must choose empty vs last-good explicitly; retiring
/// <see cref="WeakReference"/> entries are residency/GC tracking only and
/// are never a request-serving store.
/// </summary>
internal enum PublicHotReadInvalidationPolicy : byte
{
    /// <summary>
    /// Drop current and last-good to <see cref="PublicHotReadSnapshot.Empty"/>.
    /// New requests must not receive prior bytes. The miss reason is
    /// <c>invalidated-drop-to-empty:{reason}</c> so this is never a silent
    /// Empty-then-next().
    /// </summary>
    DropToEmpty = 0,

    /// <summary>
    /// Keep the last Ready, integrity-sealed generation strongly retained
    /// and requestable as last-good while a coalesced rebuild is scheduled.
    /// </summary>
    RetainLastGood = 1
}

/// <summary>
/// Serving-path miss class for list/category/tag (and diagnostic HTML).
/// Not-resident must not be written as <c>404</c>.
/// </summary>
internal enum PublicHotReadServingMiss : byte
{
    /// <summary>
    /// Artifact is not in this snapshot: un-preloaded page/size, missing
    /// critical taxonomy collection, or rebuild-pending last-good without
    /// the route. Callers see <c>503</c> + <c>Retry-After: 1</c>.
    /// </summary>
    NotResident = 0,

    /// <summary>
    /// Authoritative public not-found: unpublished, deleted, or never
    /// existed under this snapshot's public visibility. Callers see <c>404</c>.
    /// </summary>
    NotFound = 1
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
    public string Locale { get; init; } = string.Empty;

    public bool RequiresCspNonceMutation => CspNonceTemplate is not null;

    public long ResidentBytes => Bytes.Length + (CspNonceTemplate?.ResidentBytes ?? 0);
}

public readonly record struct PublicHtmlRouteIndex(
    string RouteKey,
    string PathKey,
    PublicPageId PageId);

public sealed class PublicHotReadOptions
{
    /// <summary>Omission blocks ownership admission; it does not change requested capability modes.</summary>
    public PublicHotReadSnapshotOwnershipOptions? SnapshotOwnership
    {
        get; set;
    }
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
    /// <summary>Maximum durable public-hot recovery attempts before readiness fails.</summary>
    public int PublicHotRecoveryMaximumAttempts { get; set; } = 3;
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
    /// <summary>
    /// Short generation pin for public hot-read responses across L0/L1/L2/endpoint.
    /// Adjacent generations do not flap inside this window without a content
    /// publish or hard invalidation. Zero disables the pin. The window is
    /// clamped to <see cref="MaxSnapshotAge"/> so it cannot become a permanent
    /// stale pin.
    /// </summary>
    public TimeSpan VersionStickinessWindow { get; set; } = PublicHotReadVersionStickiness.DefaultWindow;
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

public sealed partial class PublicHotReadSnapshot
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
    private readonly FrozenSet<int> _publicCategoryIds;
    private readonly FrozenSet<int> _publicTagIds;
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
        int articleFrameLimit,
        PublicHotReadSnapshotHostOwnership? hostOwnership = null)
    {
        _hostOwnership = hostOwnership;
        _hostOwnershipGate = hostOwnership is null ? null : new object();
        if (hostOwnership is not null)
        {
            hostOwnership.ValidateSnapshotRoster((long)articleFramesById.Count + listFrames.Count + htmlFrameCount
                + (categoryFrame.Frame.IsEmpty ? 0 : 1) + (tagFrame.Frame.IsEmpty ? 0 : 1));
            MemoryOperationResult<IDisposable> retention = hostOwnership.TryRetain();
            if (!retention.Succeeded)
            {
                throw new InsufficientMemoryException($"Snapshot host retention rejected: {retention.Failure}.");
            }
            _hostRootHold = retention.Value;
        }
        try
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
            _publicCategoryIds = TargetIdsOfKind(_listFrames, PublicListKind.Category);
            _publicTagIds = TargetIdsOfKind(_listFrames, PublicListKind.Tag);
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
        catch
        {
            _hostRootHold?.Dispose();
            _hostRootHold = null;
            throw;
        }
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

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    internal bool IsHtmlRemoved(string path)
        => _htmlRemovedPaths.Contains(path);

    /// <summary>
    /// Classify a list/category/tag miss against this snapshot's resident
    /// catalog. Home/archive/hot/featured and taxonomy collections always
    /// exist, so a miss is not-resident. Category/tag list IDs are 404 only
    /// when the matching taxonomy collection is resident and the ID has no
    /// public list pages in this generation.
    /// </summary>
    internal PublicHotReadServingMiss ClassifyListMiss(in PublicListKey key)
        => key.Kind switch
        {
            PublicListKind.Home or PublicListKind.Archive or PublicListKind.Hot or PublicListKind.Featured
                => PublicHotReadServingMiss.NotResident,
            PublicListKind.Category
                => CategoryFrameReady && !_publicCategoryIds.Contains(key.TargetId)
                    ? PublicHotReadServingMiss.NotFound
                    : PublicHotReadServingMiss.NotResident,
            PublicListKind.Tag
                => TagFrameReady && !_publicTagIds.Contains(key.TargetId)
                    ? PublicHotReadServingMiss.NotFound
                    : PublicHotReadServingMiss.NotResident,
            _ => PublicHotReadServingMiss.NotFound
        };

    internal PublicHotReadServingMiss ClassifyHtmlMiss(string path, bool lastGoodSnapshot)
        => IsHtmlRemoved(path) || !lastGoodSnapshot
            ? PublicHotReadServingMiss.NotFound
            : PublicHotReadServingMiss.NotResident;

    private static FrozenSet<int> TargetIdsOfKind(
        FrozenDictionary<PublicListKey, PublicBinaryArtifact> listFrames,
        PublicListKind kind)
    {
        HashSet<int>? ids = null;
        foreach (PublicListKey key in listFrames.Keys)
        {
            if (key.Kind != kind || key.TargetId <= 0)
            {
                continue;
            }

            ids ??= [];
            ids.Add(key.TargetId);
        }

        return ids is null ? FrozenSet<int>.Empty : ids.ToFrozenSet();
    }

    internal PublicHotReadSnapshot WithoutArticle(int articleId)
    {
        if (articleId <= 0 || !_articleFramesById.ContainsKey(articleId))
        {
            return this;
        }

        Dictionary<int, PublicBinaryArtifact> articles = _articleFramesById.ToDictionary();
        articles.Remove(articleId);
        return new PublicHotReadSnapshot(
            Version + 1,
            articles.ToFrozenDictionary(),
            _listFrames,
            _categoryFrame,
            _tagFrame,
            _htmlBaseByPath,
            PublicationEvidence.WithSourceVersion(Version + 1),
            _htmlOverlayByPath,
            _htmlRemovedPaths,
            _htmlFrameCount,
            PublicArticleCount,
            ArticleFrameLimit,
            _hostOwnership);
    }

    internal PublicHotReadSnapshot WithoutList(PublicListKey listKey)
    {
        if (!_listFrames.ContainsKey(listKey))
        {
            return this;
        }

        Dictionary<PublicListKey, PublicBinaryArtifact> lists = _listFrames.ToDictionary();
        lists.Remove(listKey);
        return new PublicHotReadSnapshot(
            Version + 1,
            _articleFramesById,
            lists.ToFrozenDictionary(),
            _categoryFrame,
            _tagFrame,
            _htmlBaseByPath,
            PublicationEvidence.WithSourceVersion(Version + 1),
            _htmlOverlayByPath,
            _htmlRemovedPaths,
            _htmlFrameCount,
            PublicArticleCount,
            ArticleFrameLimit,
            _hostOwnership);
    }

    internal PublicHotReadSnapshot WithoutCategory()
        => _categoryFrame.Frame.IsEmpty
            ? this
            : new PublicHotReadSnapshot(
                Version + 1,
                _articleFramesById,
                _listFrames,
                default,
                _tagFrame,
                _htmlBaseByPath,
                PublicationEvidence.WithSourceVersion(Version + 1),
                _htmlOverlayByPath,
                _htmlRemovedPaths,
                _htmlFrameCount,
                PublicArticleCount,
                ArticleFrameLimit,
            _hostOwnership);

    internal PublicHotReadSnapshot WithoutTag()
        => _tagFrame.Frame.IsEmpty
            ? this
            : new PublicHotReadSnapshot(
                Version + 1,
                _articleFramesById,
                _listFrames,
                _categoryFrame,
                default,
                _htmlBaseByPath,
                PublicationEvidence.WithSourceVersion(Version + 1),
                _htmlOverlayByPath,
                _htmlRemovedPaths,
                _htmlFrameCount,
                PublicArticleCount,
                ArticleFrameLimit,
            _hostOwnership);

    internal PublicHotReadSnapshot WithoutAllArticles()
        => _articleFramesById.Count == 0
            ? this
            : new PublicHotReadSnapshot(
                Version + 1,
                FrozenDictionary<int, PublicBinaryArtifact>.Empty,
                _listFrames,
                _categoryFrame,
                _tagFrame,
                _htmlBaseByPath,
                PublicationEvidence.WithSourceVersion(Version + 1),
                _htmlOverlayByPath,
                _htmlRemovedPaths,
                _htmlFrameCount,
                PublicArticleCount,
                ArticleFrameLimit,
            _hostOwnership);

    internal PublicHotReadSnapshot WithoutListsOfKind(PublicListKind kind)
    {
        Dictionary<PublicListKey, PublicBinaryArtifact> lists = _listFrames.ToDictionary();
        bool changed = false;
        foreach (PublicListKey key in lists.Keys.Where(item => item.Kind == kind).ToArray())
        {
            lists.Remove(key);
            changed = true;
        }

        return changed
            ? new PublicHotReadSnapshot(
                Version + 1,
                _articleFramesById,
                lists.ToFrozenDictionary(),
                _categoryFrame,
                _tagFrame,
                _htmlBaseByPath,
                PublicationEvidence.WithSourceVersion(Version + 1),
                _htmlOverlayByPath,
                _htmlRemovedPaths,
                _htmlFrameCount,
                PublicArticleCount,
                ArticleFrameLimit,
            _hostOwnership)
            : this;
    }

    public PublicHotReadSnapshot WithHtml(string path, PublicHtmlArtifact html)
    {
        if (HasHostOwnership && !html.Bytes.IsEmpty && !MemoryMarshal.TryGetArray(html.Bytes, out _))
        {
            throw new NotSupportedException("Owned binary snapshots cannot acquire opaque HTML through an array composition API.");
        }
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

    public PublicHotReadSnapshot WithoutHtmlMatching(Func<string, bool> match)
    {
        ArgumentNullException.ThrowIfNull(match);
        Dictionary<string, PublicHtmlArtifact> overlay = _htmlOverlayByPath.ToDictionary(StringComparer.Ordinal);
        HashSet<string> removed = _htmlRemovedPaths.ToHashSet(StringComparer.Ordinal);
        int htmlFrameCount = _htmlFrameCount;
        bool changed = false;
        foreach (string path in overlay.Keys.Concat(_htmlBaseByPath.Keys).Distinct(StringComparer.Ordinal).ToArray())
        {
            if (!match(path) || !TryGetHtml(path, out _))
            {
                continue;
            }

            overlay.Remove(path);
            if (_htmlBaseByPath.ContainsKey(path))
            {
                removed.Add(path);
            }

            htmlFrameCount--;
            changed = true;
        }

        return changed ? CreateHtmlDeltaSnapshot(overlay, removed, htmlFrameCount) : this;
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
                ArticleFrameLimit,
            _hostOwnership);

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
                ArticleFrameLimit,
            _hostOwnership);
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
            ArticleFrameLimit,
            _hostOwnership);
    }
}

public partial class PublicHotReadStore
{
    private static readonly TimeSpan s_minimumSnapshotAge = TimeSpan.FromSeconds(2);
    private static readonly Meter s_retiringMeter = new("FsusBlog.PublicHotRead.Retiring", "1.0.0");
    private static readonly Counter<long> s_retiringPrunedCounter =
        s_retiringMeter.CreateCounter<long>("fsus.public_hot.retiring.evictions");
    private static readonly Histogram<long> s_retiringBytesHistogram =
        s_retiringMeter.CreateHistogram<long>("fsus.public_hot.retiring.bytes", "By");

    private PublicHotReadSnapshot _current = PublicHotReadSnapshot.Empty;
    private int _ready;
    private readonly object _gate = new();
    private readonly PublicHotReadEarlyDataPlaneRuntimeState? _earlyDataPlaneRuntimeState;
    private readonly bool _initialEarlyDataPlaneEnabled;
    private readonly PublicHotReadBudgetLimits _budgetLimits;
    private readonly string _compressionPolicy;
    // Weak retiring entries are residency/GC overlap tracking only. They are
    // not a request-serving last-good store; last-good is _lastGood (strong).
    private readonly List<RetiringSnapshotReference> _retiringSnapshots = [];
    private PublicHotReadSnapshot _lastGood = PublicHotReadSnapshot.Empty;
    // Strong pin of the generation last served. Distinct from last-good: last-good
    // is the latest Ready snapshot, while stickiness may keep the previous adjacent
    // generation requestable for a short window after a soft refresh.
    private PublicHotReadSnapshot _sticky = PublicHotReadSnapshot.Empty;
    private long _stickyUntilUtcTicks;
    private readonly TimeSpan _stickyWindow;
    private int _retainLastGoodUntilPublish;
    private int _coalescedRefreshRequested;
    private string _coalescedRefreshReason = string.Empty;
    private string _lastInvalidationReason = string.Empty;
    private int _lastInvalidationPolicy;
    private readonly PublicHotReadRetiringLimits _retiringLimits;
    private readonly TimeProvider _timeProvider;
    private readonly TimeSpan _maxSnapshotAge;
    private long _distributedInvalidationGeneration;
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
        if (value.MaxSnapshotAge < s_minimumSnapshotAge)
        {
            throw new ArgumentOutOfRangeException(
                nameof(value.MaxSnapshotAge),
                value.MaxSnapshotAge,
                $"Snapshot age must be at least {s_minimumSnapshotAge}.");
        }
        _maxSnapshotAge = value.MaxSnapshotAge;
        _stickyWindow = PublicHotReadVersionStickiness.ResolveWindow(
            value.VersionStickinessWindow,
            _maxSnapshotAge);
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

    public virtual void Publish(PublicHotReadSnapshot next)
        => PublishCore(next, PublicHotReadPublishCause.Content);

    internal void PublishSoftRefresh(PublicHotReadSnapshot next)
        => PublishCore(next, PublicHotReadPublishCause.SoftRefresh);

    private void PublishCore(PublicHotReadSnapshot next, PublicHotReadPublishCause cause)
    {
        ArgumentNullException.ThrowIfNull(next);
        long overlapBytes;
        IDisposable? retiredCurrent;
        IDisposable? retiredLastGood;
        IDisposable? retiredSticky;
        lock (_gate)
        {
            PublicHotReadSnapshot current = Current;
            PublicHotReadSnapshot previousLastGood = _lastGood;
            PublicHotReadSnapshot previousSticky = _sticky;
            // Durable obligation replay may repeat a completed publication after
            // a process crash. Never let such a replay restore an older snapshot.
            if (next.Version < current.Version)
            {
                return;
            }
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
            next.ClaimHostPublication(this);
            SetLifecycleStageLocked("publish");
            Volatile.Write(ref _current, next);
            Volatile.Write(ref _lastGood, next);
            Volatile.Write(ref _ready, 1);
            Volatile.Write(ref _retainLastGoodUntilPublish, 0);
            Volatile.Write(ref _coalescedRefreshRequested, 0);
            Volatile.Write(ref _lastInvalidationReason, string.Empty);
            UpdateStickyPinLocked(next, now, cause);
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
            retiredCurrent = DetachInactiveHostRootLocked(current);
            retiredLastGood = DetachInactiveHostRootLocked(previousLastGood);
            retiredSticky = DetachInactiveHostRootLocked(previousSticky);
        }
        DisposeRetiredHostRoots(retiredCurrent, retiredLastGood, retiredSticky);
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

    internal long DistributedInvalidationGenerationForTests
        => Volatile.Read(ref _distributedInvalidationGeneration);

    internal PublicHotReadSnapshot LastGoodSnapshotForTests
        => Volatile.Read(ref _lastGood);

    internal PublicHotReadSnapshot StickySnapshotForTests
        => Volatile.Read(ref _sticky);

    internal DateTimeOffset StickyUntilForTests
        => new(Volatile.Read(ref _stickyUntilUtcTicks), TimeSpan.Zero);

    internal TimeSpan VersionStickinessWindowForTests => _stickyWindow;

    internal bool CoalescedRefreshPending
        => Volatile.Read(ref _coalescedRefreshRequested) == 1;

    internal bool CoalescedRefreshPendingForTests
        => CoalescedRefreshPending;

    internal bool TryGetQualifiedLastGood(out PublicHotReadSnapshot snapshot)
    {
        if (TryGetRequestSnapshot(out snapshot, out string reason)
            && string.Equals(reason, "last-good", StringComparison.Ordinal))
        {
            return true;
        }

        snapshot = PublicHotReadSnapshot.Empty;
        return false;
    }

    internal string CoalescedRefreshReasonForTests
        => Volatile.Read(ref _coalescedRefreshReason);

    internal PublicHotReadInvalidationPolicy LastInvalidationPolicyForTests
        => (PublicHotReadInvalidationPolicy)Volatile.Read(ref _lastInvalidationPolicy);

    internal string LastInvalidationReasonForTests
        => Volatile.Read(ref _lastInvalidationReason);

    internal int ApplyDistributedFragments(IReadOnlyList<string> fragments)
    {
        ArgumentNullException.ThrowIfNull(fragments);
        if (fragments.Count == 0)
        {
            return 0;
        }

        lock (_gate)
        {
            PublicHotReadSnapshot current = Current;
            if (current.Version <= 0)
            {
                Interlocked.Increment(ref _distributedInvalidationGeneration);
                return 0;
            }

            PublicHotReadSnapshot next = current;
            int processed = 0;
            try
            {
                foreach (string fragment in fragments.Distinct(StringComparer.Ordinal))
                {
                    PublicHotReadSnapshot previous = next;
                    next = ApplyOneDistributedFragment(previous, fragment);
                    DisposeIntermediateHostClone(previous, next, current);
                    processed++;
                }

                if (!ReferenceEquals(next, current))
                {
                    Publish(next);
                }

                Interlocked.Increment(ref _distributedInvalidationGeneration);
                return processed;
            }
            catch
            {
                DisposeIntermediateHostClone(next, current, current);
                throw;
            }
        }
    }

    private static PublicHotReadSnapshot ApplyOneDistributedFragment(PublicHotReadSnapshot next, string fragment)
        => fragment switch
        {
            "taxonomy:category" => next.WithoutCategory(),
            "taxonomy:tag" => next.WithoutTag(),
            "article:*" => next.WithoutAllArticles(),
            "list:home" => next.WithoutListsOfKind(PublicListKind.Home),
            "list:archive" => next.WithoutListsOfKind(PublicListKind.Archive),
            "list:hot" => next.WithoutListsOfKind(PublicListKind.Hot),
            "list:featured" => next.WithoutListsOfKind(PublicListKind.Featured),
            "list:category" => next.WithoutListsOfKind(PublicListKind.Category),
            "list:tag" => next.WithoutListsOfKind(PublicListKind.Tag),
            "comments:*" => next,
            _ when fragment.StartsWith("comment-policy", StringComparison.Ordinal) => next,
            _ when fragment.StartsWith("taxonomy:category:", StringComparison.Ordinal) => next.WithoutCategory(),
            _ when fragment.StartsWith("taxonomy:tag:", StringComparison.Ordinal) => next.WithoutTag(),
            _ when TryParseArticleFragment(fragment, out int articleId, out bool commentsOnly)
                => commentsOnly ? next : next.WithoutArticle(articleId),
            _ when fragment.StartsWith("html:", StringComparison.Ordinal)
                => RemoveDistributedHtml(next, fragment[5..]),
            _ when fragment.StartsWith("public-hot-read:v", StringComparison.Ordinal)
                => next,
            _ => throw new InvalidDataException($"distributed hot-read fragment is unsupported: {fragment}")
        };

    private static PublicHotReadSnapshot RemoveDistributedHtml(PublicHotReadSnapshot snapshot, string routeKey)
    {
        if (string.IsNullOrWhiteSpace(routeKey))
        {
            throw new InvalidDataException("distributed hot-read html fragment is empty");
        }

        PublicHotReadSnapshot next = snapshot.WithoutHtml(PublicHotReadRouteKeys.HtmlPath(routeKey));
        try
        {
            foreach (LocaleDescriptor locale in LocaleCatalog.Enabled)
            {
                PublicHotReadSnapshot previous = next;
                next = previous.WithoutHtml(PublicHotReadRouteKeys.LocalizeHtmlPath(
                    PublicHotReadRouteKeys.HtmlPath(routeKey),
                    locale.Code));
                DisposeIntermediateHostClone(previous, next, snapshot);
            }

            return next;
        }
        catch
        {
            DisposeIntermediateHostClone(next, snapshot, snapshot);
            throw;
        }
    }

    private static bool TryParseArticleFragment(string fragment, out int articleId, out bool commentsOnly)
    {
        articleId = 0;
        commentsOnly = false;
        if (!fragment.StartsWith("article:", StringComparison.Ordinal))
        {
            return false;
        }

        ReadOnlySpan<char> value = fragment.AsSpan("article:".Length);
        int separator = value.IndexOf(':');
        ReadOnlySpan<char> id = separator < 0 ? value : value[..separator];
        if (!int.TryParse(id, out articleId) || articleId <= 0)
        {
            articleId = 0;
            return false;
        }

        if (separator < 0)
        {
            return true;
        }

        if (value[(separator + 1)..].SequenceEqual("comments"))
        {
            commentsOnly = true;
            return true;
        }

        articleId = 0;
        return false;
    }

    internal void InvalidateDistributedSnapshot(
        string reason,
        PublicHotReadInvalidationPolicy policy)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(reason);
        IDisposable? retiredCurrent;
        IDisposable? retiredLastGood;
        IDisposable? retiredSticky;
        lock (_gate)
        {
            Volatile.Write(ref _lastInvalidationReason, reason);
            Volatile.Write(ref _lastInvalidationPolicy, (int)policy);
            if (policy == PublicHotReadInvalidationPolicy.RetainLastGood)
            {
                PublicHotReadSnapshot retained = Current.Version > 0 ? Current : Volatile.Read(ref _lastGood);
                if (retained.Version > 0)
                {
                    Volatile.Write(ref _lastGood, retained);
                    Volatile.Write(ref _current, retained);
                    Volatile.Write(ref _ready, 1);
                    Volatile.Write(ref _retainLastGoodUntilPublish, 1);
                    KeepStickyPinLocked(retained, _timeProvider.GetUtcNow());
                    TryRequestCoalescedRefreshLocked("last-good:" + reason);
                    SetLifecycleStageLocked("distributed-invalidated-retain-last-good");
                    _runtime = CreateRuntimeSnapshotLocked(
                        nameof(PublicHotReadState.Ready),
                        retained,
                        _timeProvider.GetUtcNow(),
                        reason,
                        "invalidated-retain-last-good",
                        null);
                    Interlocked.Increment(ref _distributedInvalidationGeneration);
                    return;
                }
            }

            PublicHotReadSnapshot previousCurrent = _current;
            PublicHotReadSnapshot previousLastGood = _lastGood;
            PublicHotReadSnapshot previousSticky = _sticky;
            Volatile.Write(ref _current, PublicHotReadSnapshot.Empty);
            Volatile.Write(ref _lastGood, PublicHotReadSnapshot.Empty);
            Volatile.Write(ref _ready, 0);
            Volatile.Write(ref _retainLastGoodUntilPublish, 0);
            Volatile.Write(ref _coalescedRefreshRequested, 0);
            ClearStickyPinLocked();
            _retiringSnapshots.Clear();
            _lastSnapshotOverlapBytes = 0;
            _lastBudgetViolations = Array.Empty<string>();
            SetLifecycleStageLocked("distributed-invalidated-drop-to-empty");
            _runtime = CreateRuntimeSnapshotLocked(
                nameof(PublicHotReadState.NotStarted),
                PublicHotReadSnapshot.Empty,
                _timeProvider.GetUtcNow(),
                reason,
                "invalidated-drop-to-empty",
                null);
            Interlocked.Increment(ref _distributedInvalidationGeneration);
            retiredCurrent = DetachInactiveHostRootLocked(previousCurrent);
            retiredLastGood = DetachInactiveHostRootLocked(previousLastGood);
            retiredSticky = DetachInactiveHostRootLocked(previousSticky);
        }
        DisposeRetiredHostRoots(retiredCurrent, retiredLastGood, retiredSticky);
    }

    internal bool TryGetRequestSnapshot(out PublicHotReadSnapshot snapshot, out string reason)
    {
        snapshot = Current;
        PublicHotReadSnapshot lastGood = Volatile.Read(ref _lastGood);
        if (IsReadyFast && snapshot.Version > 0)
        {
            DateTimeOffset? cutoff = snapshot.PublicationEvidence.VisibilityCutoffUtc;
            DateTimeOffset now = _timeProvider.GetUtcNow();
            if (cutoff > now)
            {
                reason = "future-cutoff";
                snapshot = PublicHotReadSnapshot.Empty;
                return false;
            }

            bool retainLastGood = Volatile.Read(ref _retainLastGoodUntilPublish) == 1;
            bool ageStale = !cutoff.HasValue || now - cutoff.Value > _maxSnapshotAge;
            if (!ageStale && !retainLastGood)
            {
                if (TrySelectStickySnapshot(snapshot, now, out PublicHotReadSnapshot pinned))
                {
                    snapshot = pinned;
                    reason = "sticky";
                    return true;
                }

                reason = "ok";
                return true;
            }

            PublicHotReadSnapshot candidate = lastGood.Version > 0 ? lastGood : snapshot;
            if (TrySelectStickySnapshot(candidate, now, out PublicHotReadSnapshot stickyLastGood))
            {
                snapshot = stickyLastGood;
                reason = "sticky";
                return true;
            }

            if (candidate.Version > 0)
            {
                snapshot = candidate;
                reason = "last-good";
                TryRequestCoalescedRefresh("last-good");
                return true;
            }

            reason = "stale";
            snapshot = PublicHotReadSnapshot.Empty;
            return false;
        }

        if (lastGood.Version > 0 && Volatile.Read(ref _retainLastGoodUntilPublish) == 1)
        {
            snapshot = lastGood;
            reason = "last-good";
            TryRequestCoalescedRefresh("last-good");
            return true;
        }

        string invalidationReason = Volatile.Read(ref _lastInvalidationReason);
        if (Volatile.Read(ref _lastInvalidationPolicy) == (int)PublicHotReadInvalidationPolicy.DropToEmpty
            && invalidationReason.Length > 0)
        {
            reason = "invalidated-drop-to-empty:" + invalidationReason;
            snapshot = PublicHotReadSnapshot.Empty;
            return false;
        }

        reason = "not-ready";
        snapshot = PublicHotReadSnapshot.Empty;
        return false;
    }

    internal bool ShouldRefreshSnapshot()
    {
        if (Volatile.Read(ref _coalescedRefreshRequested) == 1)
        {
            return true;
        }

        PublicHotReadSnapshot snapshot = Current;
        DateTimeOffset? cutoff = snapshot.PublicationEvidence.VisibilityCutoffUtc;
        DateTimeOffset now = _timeProvider.GetUtcNow();
        return !IsReadyFast
            || !cutoff.HasValue
            || cutoff.Value > now
            || now - cutoff.Value >= TimeSpan.FromTicks(_maxSnapshotAge.Ticks / 2);
    }

    internal bool TryRequestCoalescedRefresh(string reason)
    {
        if (Interlocked.CompareExchange(ref _coalescedRefreshRequested, 1, 0) == 0)
        {
            Volatile.Write(ref _coalescedRefreshReason, reason);
            return true;
        }

        return false;
    }

    private void TryRequestCoalescedRefreshLocked(string reason)
    {
        if (_coalescedRefreshRequested == 0)
        {
            Volatile.Write(ref _coalescedRefreshRequested, 1);
            Volatile.Write(ref _coalescedRefreshReason, reason);
        }
    }

    private void UpdateStickyPinLocked(
        PublicHotReadSnapshot next,
        DateTimeOffset now,
        PublicHotReadPublishCause cause)
    {
        if (_stickyWindow <= TimeSpan.Zero || next.Version <= 0)
        {
            ClearStickyPinLocked();
            return;
        }

        PublicHotReadSnapshot existing = Volatile.Read(ref _sticky);
        long untilTicks = Volatile.Read(ref _stickyUntilUtcTicks);
        bool pinActive = existing.Version > 0 && untilTicks > 0 && now.UtcTicks < untilTicks;
        if (cause == PublicHotReadPublishCause.SoftRefresh
            && pinActive
            && PublicHotReadVersionStickiness.IsAdjacent(existing.Version, next.Version))
        {
            return;
        }

        Volatile.Write(ref _sticky, next);
        Volatile.Write(ref _stickyUntilUtcTicks, now.Add(_stickyWindow).UtcTicks);
    }

    private void KeepStickyPinLocked(PublicHotReadSnapshot retained, DateTimeOffset now)
    {
        PublicHotReadSnapshot existing = Volatile.Read(ref _sticky);
        long untilTicks = Volatile.Read(ref _stickyUntilUtcTicks);
        if (existing.Version > 0 && untilTicks > 0 && now.UtcTicks < untilTicks)
        {
            return;
        }

        if (retained.Version <= 0 || _stickyWindow <= TimeSpan.Zero)
        {
            ClearStickyPinLocked();
            return;
        }

        Volatile.Write(ref _sticky, retained);
        Volatile.Write(ref _stickyUntilUtcTicks, now.Add(_stickyWindow).UtcTicks);
    }

    private void ClearStickyPinLocked()
    {
        Volatile.Write(ref _sticky, PublicHotReadSnapshot.Empty);
        Volatile.Write(ref _stickyUntilUtcTicks, 0);
    }

    private bool TrySelectStickySnapshot(
        PublicHotReadSnapshot current,
        DateTimeOffset now,
        out PublicHotReadSnapshot pinned)
    {
        pinned = Volatile.Read(ref _sticky);
        long untilTicks = Volatile.Read(ref _stickyUntilUtcTicks);
        if (pinned.Version <= 0 || untilTicks <= 0 || now.UtcTicks >= untilTicks)
        {
            pinned = PublicHotReadSnapshot.Empty;
            return false;
        }

        if (pinned.Version == current.Version)
        {
            pinned = PublicHotReadSnapshot.Empty;
            return false;
        }

        if (!PublicHotReadVersionStickiness.IsAdjacent(pinned.Version, current.Version))
        {
            pinned = PublicHotReadSnapshot.Empty;
            return false;
        }

        return true;
    }

    internal TimeSpan SnapshotRefreshInterval
        => TimeSpan.FromTicks(_maxSnapshotAge.Ticks / 2);
}
