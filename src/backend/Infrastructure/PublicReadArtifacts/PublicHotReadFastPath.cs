using System.Collections.Frozen;
using System.Buffers.Binary;
using System.Diagnostics.Metrics;
using System.IO.Pipelines;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.Extensions.Options;

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
    AedsFrameType FrameType);

public readonly record struct PublicHtmlArtifact(
    ReadOnlyMemory<byte> Bytes,
    string ContentType,
    string ETag,
    string CacheControl);

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
    public bool ValidateFramesOnPublish { get; set; } = true;
    public bool FailOpenWhenNotReady { get; set; }
    public bool EnableDiagnosticHeaders { get; set; }
}

public sealed record PublicHotReadRuntimeSnapshot(
    string State,
    long Version,
    int ArticleFrameCount,
    int ListFrameCount,
    bool CategoryFrameReady,
    bool TagFrameReady,
    int HtmlFrameCount,
    DateTimeOffset? LastBuildAt,
    string? LastBuildReason,
    string? LastBuildStatus,
    string? LastError);

public sealed class PublicHotReadSnapshot
{
    public static readonly PublicHotReadSnapshot Empty = new(
        0,
        FrozenDictionary<int, PublicBinaryArtifact>.Empty,
        FrozenDictionary<PublicListKey, PublicBinaryArtifact>.Empty,
        default,
        default,
        FrozenDictionary<string, PublicHtmlArtifact>.Empty);

    private readonly FrozenDictionary<int, PublicBinaryArtifact> _articleFramesById;
    private readonly FrozenDictionary<PublicListKey, PublicBinaryArtifact> _listFrames;
    private readonly PublicBinaryArtifact _categoryFrame;
    private readonly PublicBinaryArtifact _tagFrame;
    private readonly FrozenDictionary<string, PublicHtmlArtifact> _htmlBaseByPath;
    private readonly FrozenDictionary<string, PublicHtmlArtifact> _htmlOverlayByPath;
    private readonly FrozenSet<string> _htmlRemovedPaths;
    private readonly int _htmlFrameCount;

    public PublicHotReadSnapshot(
        long version,
        FrozenDictionary<int, PublicBinaryArtifact> articleFramesById,
        FrozenDictionary<PublicListKey, PublicBinaryArtifact> listFrames,
        PublicBinaryArtifact categoryFrame,
        PublicBinaryArtifact tagFrame,
        FrozenDictionary<string, PublicHtmlArtifact> htmlByPath)
        : this(
            version,
            articleFramesById,
            listFrames,
            categoryFrame,
            tagFrame,
            htmlByPath,
            FrozenDictionary<string, PublicHtmlArtifact>.Empty,
            FrozenSet<string>.Empty,
            htmlByPath.Count)
    {
    }

    private PublicHotReadSnapshot(
        long version,
        FrozenDictionary<int, PublicBinaryArtifact> articleFramesById,
        FrozenDictionary<PublicListKey, PublicBinaryArtifact> listFrames,
        PublicBinaryArtifact categoryFrame,
        PublicBinaryArtifact tagFrame,
        FrozenDictionary<string, PublicHtmlArtifact> htmlBaseByPath,
        FrozenDictionary<string, PublicHtmlArtifact> htmlOverlayByPath,
        FrozenSet<string> htmlRemovedPaths,
        int htmlFrameCount)
    {
        Version = version;
        _articleFramesById = articleFramesById;
        _listFrames = listFrames;
        _categoryFrame = categoryFrame;
        _tagFrame = tagFrame;
        _htmlBaseByPath = htmlBaseByPath;
        _htmlOverlayByPath = htmlOverlayByPath;
        _htmlRemovedPaths = htmlRemovedPaths;
        _htmlFrameCount = htmlFrameCount;
    }

    public long Version { get; }

    public int ArticleFrameCount => _articleFramesById.Count;
    public int ListFrameCount => _listFrames.Count;
    public bool CategoryFrameReady => !_categoryFrame.Frame.IsEmpty;
    public bool TagFrameReady => !_tagFrame.Frame.IsEmpty;
    public int HtmlFrameCount => _htmlFrameCount;

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
        bool hadVisible = TryGetHtml(path, out _);
        var nextOverlay = _htmlOverlayByPath.ToDictionary(StringComparer.Ordinal);
        nextOverlay[path] = html;
        FrozenSet<string> nextRemoved = _htmlRemovedPaths;
        if (_htmlRemovedPaths.Contains(path))
        {
            var removed = _htmlRemovedPaths.ToHashSet(StringComparer.Ordinal);
            removed.Remove(path);
            nextRemoved = removed.ToFrozenSet(StringComparer.Ordinal);
        }

        return new PublicHotReadSnapshot(
            Version + 1,
            _articleFramesById,
            _listFrames,
            _categoryFrame,
            _tagFrame,
            _htmlBaseByPath,
            nextOverlay.ToFrozenDictionary(StringComparer.Ordinal),
            nextRemoved,
            hadVisible ? _htmlFrameCount : _htmlFrameCount + 1);
    }

    public PublicHotReadSnapshot WithoutHtml(string path)
    {
        bool overlayHad = _htmlOverlayByPath.ContainsKey(path);
        bool baseVisible = _htmlBaseByPath.ContainsKey(path) && !_htmlRemovedPaths.Contains(path);
        if (!overlayHad && !baseVisible)
        {
            return this;
        }

        FrozenDictionary<string, PublicHtmlArtifact> nextOverlay = _htmlOverlayByPath;
        if (overlayHad)
        {
            var overlay = _htmlOverlayByPath.ToDictionary(StringComparer.Ordinal);
            overlay.Remove(path);
            nextOverlay = overlay.ToFrozenDictionary(StringComparer.Ordinal);
        }

        FrozenSet<string> nextRemoved = _htmlRemovedPaths;
        if (baseVisible)
        {
            var removed = _htmlRemovedPaths.ToHashSet(StringComparer.Ordinal);
            removed.Add(path);
            nextRemoved = removed.ToFrozenSet(StringComparer.Ordinal);
        }

        return new PublicHotReadSnapshot(
            Version + 1,
            _articleFramesById,
            _listFrames,
            _categoryFrame,
            _tagFrame,
            _htmlBaseByPath,
            nextOverlay,
            nextRemoved,
            _htmlFrameCount - 1);
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
                FrozenDictionary<string, PublicHtmlArtifact>.Empty,
                FrozenSet<string>.Empty,
                0);
}

public sealed class PublicHotReadStore
{
    private PublicHotReadSnapshot _current = PublicHotReadSnapshot.Empty;
    private readonly object _gate = new();
    private PublicHotReadRuntimeSnapshot _runtime = new(
        nameof(PublicHotReadState.NotStarted),
        0,
        0,
        0,
        false,
        false,
        0,
        null,
        null,
        "not_started",
        null);

    public PublicHotReadSnapshot Current
    {
        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        get => Volatile.Read(ref _current);
    }

    public void Publish(PublicHotReadSnapshot next)
    {
        Volatile.Write(ref _current, next);
        lock (_gate)
        {
            _runtime = CreateRuntimeSnapshotLocked(nameof(PublicHotReadState.Ready), next, DateTimeOffset.UtcNow, _runtime.LastBuildReason, "ok", null);
        }
    }

    public void BeginBuild(string reason)
    {
        lock (_gate)
        {
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
            return _runtime;
        }
    }

    public bool IsReady => string.Equals(CreateRuntimeSnapshot().State, nameof(PublicHotReadState.Ready), StringComparison.Ordinal);

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

    private static PublicHotReadRuntimeSnapshot CreateRuntimeSnapshotLocked(
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
            snapshot.ListFrameCount,
            snapshot.CategoryFrameReady,
            snapshot.TagFrameReady,
            snapshot.HtmlFrameCount,
            lastBuildAt,
            lastBuildReason,
            lastBuildStatus,
            lastError);
}

public static class PublicHotReadFastPathExtensions
{
    public static IApplicationBuilder UseFsusPublicHotReadFastPath(this IApplicationBuilder app)
    {
        var store = app.ApplicationServices.GetRequiredService<PublicHotReadStore>();
        var options = app.ApplicationServices.GetRequiredService<IOptions<PublicHotReadOptions>>().Value;
        var counters = app.ApplicationServices.GetRequiredService<PublicHotReadCounters>();

        return app.Use((ctx, next) => PublicHotReadFastPath.TryServeAsync(ctx, next, store, options, counters));
    }
}

public static class PublicHotReadFastPath
{
    private const string ArticlePrefix = "/api/binary/article";
    private const string CategoryPath = "/api/binary/category.aeds";
    private const string TagPath = "/api/binary/tag.aeds";
    private const string BinaryContentType = "application/octet-stream";
    private const string HtmlMediaType = "text/html";
    private const string HtmlContentType = "text/html; charset=utf-8";
    private const string StaticPublicCsp = "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:;";
    private static readonly Task Completed = Task.CompletedTask;

    public static Task TryServeAsync(
        HttpContext ctx,
        RequestDelegate next,
        PublicHotReadStore store,
        PublicHotReadOptions options,
        PublicHotReadCounters counters)
    {
        if (!options.Enabled)
        {
            return next(ctx);
        }

        string? path = ctx.Request.Path.Value;
        if (path is null || !IsPublicHotReadPath(path))
        {
            return next(ctx);
        }

        if (!HttpMethods.IsGet(ctx.Request.Method) && !HttpMethods.IsHead(ctx.Request.Method))
        {
            return WriteStatus(ctx, StatusCodes.Status405MethodNotAllowed);
        }

        if (ctx.Request.Headers.ContainsKey("Range"))
        {
            ctx.Response.Headers.ContentRange = "bytes */0";
            return WriteStatus(ctx, StatusCodes.Status416RangeNotSatisfiable);
        }

        if (ctx.Request.ContentLength.GetValueOrDefault() > 0 || ctx.Request.QueryString.HasValue)
        {
            WriteLegacyRouteHint(ctx, path);
            return WriteStatus(ctx, StatusCodes.Status400BadRequest);
        }

        ReadOnlySpan<char> span = path.AsSpan();
        if (ContainsRejectedPathChar(span))
        {
            counters.Rejected();
            return WriteStatus(ctx, StatusCodes.Status404NotFound);
        }

        bool isHtmlPath = IsArticleHtmlPath(span);
        if (!AcceptsArtifact(ctx, isHtmlPath))
        {
            return WriteStatus(ctx, StatusCodes.Status406NotAcceptable);
        }

        if (!store.IsReady && !options.FailOpenWhenNotReady)
        {
            ctx.Response.Headers["Retry-After"] = "1";
            return WriteStatus(ctx, StatusCodes.Status503ServiceUnavailable);
        }

        PublicHotReadSnapshot snapshot = store.Current;
        if (path.Length == CategoryPath.Length && string.Equals(path, CategoryPath, StringComparison.Ordinal))
        {
            return ServeCategory(ctx, snapshot, counters, options);
        }

        if (path.Length == TagPath.Length && string.Equals(path, TagPath, StringComparison.Ordinal))
        {
            return ServeTag(ctx, snapshot, counters, options);
        }

        if (TryMatchArticleDetail(span, out int articleId))
        {
            return ServeArticle(ctx, snapshot, counters, articleId, options);
        }

        if (TryMatchArticleList(span, out PublicListKey listKey))
        {
            return ServeList(ctx, snapshot, counters, listKey, options);
        }

        if (TryMatchArticleHot(span, out PublicListKey hotKey))
        {
            return ServeList(ctx, snapshot, counters, hotKey, options);
        }

        if (TryMatchArticleFeatured(span, out PublicListKey featuredKey))
        {
            return ServeList(ctx, snapshot, counters, featuredKey, options);
        }

        if (TryMatchArticleHtml(span, path, out string? htmlPath))
        {
            return ServeHtml(ctx, snapshot, counters, htmlPath, options);
        }

        counters.Rejected();
        return WriteStatus(ctx, StatusCodes.Status404NotFound);
    }

    private static bool IsPublicHotReadPath(string path)
        => string.Equals(path, CategoryPath, StringComparison.Ordinal)
            || string.Equals(path, TagPath, StringComparison.Ordinal)
            || string.Equals(path, ArticlePrefix, StringComparison.Ordinal)
            || path.StartsWith(ArticlePrefix + "/", StringComparison.Ordinal);

    private static bool IsArticleHtmlPath(ReadOnlySpan<char> path)
        => path.StartsWith("/api/binary/article/html/", StringComparison.Ordinal);

    private static bool AcceptsArtifact(HttpContext ctx, bool html)
        => HttpAcceptNegotiation.Accepts(ctx.Request.Headers.Accept, html ? HtmlMediaType : BinaryContentType);

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static bool ContainsRejectedPathChar(ReadOnlySpan<char> path)
        => path.IndexOf('%') >= 0
            || path.IndexOf('\\') >= 0
            || path.IndexOf("..", StringComparison.Ordinal) >= 0
            || path.IndexOf("//", StringComparison.Ordinal) >= 0;

    private static Task ServeArticle(
        HttpContext ctx,
        PublicHotReadSnapshot snapshot,
        PublicHotReadCounters counters,
        int articleId,
        PublicHotReadOptions options)
    {
        if (!snapshot.TryGetArticle(articleId, out PublicBinaryArtifact artifact))
        {
            counters.ArticleMiss();
            return WriteStatus(ctx, StatusCodes.Status404NotFound);
        }

        counters.ArticleHit(artifact.Frame.Length);
        string artifactKey = options.EnableDiagnosticHeaders
            ? articleId.ToString(System.Globalization.CultureInfo.InvariantCulture)
            : string.Empty;
        return WriteBinaryFrame(ctx, artifact, options, "article", artifactKey);
    }

    private static Task ServeList(
        HttpContext ctx,
        PublicHotReadSnapshot snapshot,
        PublicHotReadCounters counters,
        in PublicListKey key,
        PublicHotReadOptions options)
    {
        if (!snapshot.TryGetList(key, out PublicBinaryArtifact artifact))
        {
            counters.ListMiss();
            return WriteStatus(ctx, StatusCodes.Status404NotFound);
        }

        counters.ListHit(artifact.Frame.Length);
        string artifactKey = options.EnableDiagnosticHeaders ? key.ToString() : string.Empty;
        return WriteBinaryFrame(ctx, artifact, options, PublicListArtifactKind(key.Kind), artifactKey);
    }

    private static Task ServeCategory(
        HttpContext ctx,
        PublicHotReadSnapshot snapshot,
        PublicHotReadCounters counters,
        PublicHotReadOptions options)
    {
        if (!snapshot.TryGetCategory(out PublicBinaryArtifact artifact))
        {
            counters.ListMiss();
            return WriteStatus(ctx, StatusCodes.Status404NotFound);
        }

        counters.ListHit(artifact.Frame.Length);
        return WriteBinaryFrame(ctx, artifact, options, "category", "all");
    }

    private static Task ServeTag(
        HttpContext ctx,
        PublicHotReadSnapshot snapshot,
        PublicHotReadCounters counters,
        PublicHotReadOptions options)
    {
        if (!snapshot.TryGetTag(out PublicBinaryArtifact artifact))
        {
            counters.ListMiss();
            return WriteStatus(ctx, StatusCodes.Status404NotFound);
        }

        counters.ListHit(artifact.Frame.Length);
        return WriteBinaryFrame(ctx, artifact, options, "tag", "all");
    }

    private static Task ServeHtml(
        HttpContext ctx,
        PublicHotReadSnapshot snapshot,
        PublicHotReadCounters counters,
        string routeKey,
        PublicHotReadOptions options)
    {
        if (!snapshot.TryGetHtml(routeKey, out PublicHtmlArtifact html))
        {
            counters.HtmlMiss();
            return WriteStatus(ctx, StatusCodes.Status404NotFound);
        }

        counters.HtmlHit(html.Bytes.Length);
        HttpResponse response = ctx.Response;
        response.StatusCode = StatusCodes.Status200OK;
        response.ContentType = string.IsNullOrWhiteSpace(html.ContentType) ? HtmlContentType : html.ContentType;
        response.ContentLength = html.Bytes.Length;
        response.Headers["X-Content-Type-Options"] = "nosniff";
        response.Headers["Cache-Control"] = string.IsNullOrWhiteSpace(html.CacheControl) ? "public,max-age=60" : html.CacheControl;
        response.Headers["Content-Security-Policy"] = StaticPublicCsp;
        response.Headers["Accept-Ranges"] = "none";
        if (!string.IsNullOrWhiteSpace(html.ETag))
        {
            response.Headers["ETag"] = html.ETag;
        }
        WriteDiagnosticHeaders(response, options, snapshot.Version, "html", routeKey);

        if (HttpMethods.IsHead(ctx.Request.Method))
        {
            return Completed;
        }

        ValueTask<FlushResult> write = response.BodyWriter.WriteAsync(html.Bytes, ctx.RequestAborted);
        return write.IsCompletedSuccessfully ? Completed : AwaitWrite(write);
    }

    private static Task WriteBinaryFrame(
        HttpContext ctx,
        PublicBinaryArtifact artifact,
        PublicHotReadOptions options,
        string artifactKind,
        string artifactKey)
    {
        ReadOnlyMemory<byte> frame = artifact.Frame;
        HttpResponse response = ctx.Response;
        response.StatusCode = StatusCodes.Status200OK;
        response.ContentType = BinaryContentType;
        response.ContentLength = frame.Length;
        response.Headers["X-Fsus-Frame-Version"] = AedsFrameHeader.CurrentVersion.ToString(System.Globalization.CultureInfo.InvariantCulture);
        response.Headers["X-Content-Type-Options"] = "nosniff";
        response.Headers["Cache-Control"] = string.IsNullOrWhiteSpace(artifact.CacheControl)
            ? (string.IsNullOrWhiteSpace(options.CacheControl) ? "public,max-age=60" : options.CacheControl)
            : artifact.CacheControl;
        response.Headers["Accept-Ranges"] = "none";
        if (!string.IsNullOrWhiteSpace(artifact.ETag))
        {
            response.Headers["ETag"] = artifact.ETag;
        }
        else
        {
            response.Headers.Remove("ETag");
        }
        response.Headers.Remove("Last-Modified");
        response.Headers.Remove("Content-Encoding");
        WriteDiagnosticHeaders(response, options, artifact.Version, artifactKind, artifactKey);

        if (HttpMethods.IsHead(ctx.Request.Method))
        {
            return Completed;
        }

        ValueTask<FlushResult> write = response.BodyWriter.WriteAsync(frame, ctx.RequestAborted);
        return write.IsCompletedSuccessfully ? Completed : AwaitWrite(write);
    }

    private static Task WriteStatus(HttpContext ctx, int statusCode)
    {
        ctx.Response.StatusCode = statusCode;
        ctx.Response.ContentLength = 0;
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

    internal static bool TryMatchArticleDetail(ReadOnlySpan<char> path, out int articleId)
    {
        const string prefix = "/api/binary/article/";
        articleId = 0;
        if (!path.StartsWith(prefix, StringComparison.Ordinal) || !path.EndsWith(".aeds", StringComparison.Ordinal))
        {
            return false;
        }

        ReadOnlySpan<char> idSpan = path[prefix.Length..^5];
        return TryParsePositiveInt(idSpan, out articleId);
    }

    internal static bool TryMatchArticleList(ReadOnlySpan<char> path, out PublicListKey key)
    {
        key = default;
        const string homePrefix = "/api/binary/article/list/home/";
        const string archivePrefix = "/api/binary/article/list/archive/";
        const string categoryPrefix = "/api/binary/article/list/category/";
        const string tagPrefix = "/api/binary/article/list/tag/";

        if (TryMatchPagedList(path, homePrefix, PublicListKind.Home, 0, out key)
            || TryMatchPagedList(path, archivePrefix, PublicListKind.Archive, 0, out key))
        {
            return true;
        }

        return TryMatchTargetedPagedList(path, categoryPrefix, PublicListKind.Category, out key)
            || TryMatchTargetedPagedList(path, tagPrefix, PublicListKind.Tag, out key);
    }

    internal static bool TryMatchArticleHot(ReadOnlySpan<char> path, out PublicListKey key)
    {
        key = default;
        const string prefix = "/api/binary/article/hot/";
        if (!path.StartsWith(prefix, StringComparison.Ordinal) || !path.EndsWith(".aeds", StringComparison.Ordinal))
        {
            return false;
        }

        ReadOnlySpan<char> sizeSpan = path[prefix.Length..^5];
        if (!TryParseByteSize(sizeSpan, out byte size))
        {
            return false;
        }

        key = new PublicListKey(PublicListKind.Hot, 0, 1, size);
        return true;
    }

    internal static bool TryMatchArticleFeatured(ReadOnlySpan<char> path, out PublicListKey key)
    {
        key = default;
        const string prefix = "/api/binary/article/featured/";
        if (!path.StartsWith(prefix, StringComparison.Ordinal) || !path.EndsWith(".aeds", StringComparison.Ordinal))
        {
            return false;
        }

        ReadOnlySpan<char> sizeSpan = path[prefix.Length..^5];
        if (!TryParseByteSize(sizeSpan, out byte size))
        {
            return false;
        }

        key = new PublicListKey(PublicListKind.Featured, 0, 1, size);
        return true;
    }

    internal static bool TryMatchArticleHtml(ReadOnlySpan<char> path, string pathValue, out string routeKey)
    {
        routeKey = string.Empty;
        const string prefix = "/api/binary/article/html/";
        if (!path.StartsWith(prefix, StringComparison.Ordinal) || !path.EndsWith(".html", StringComparison.Ordinal))
        {
            return false;
        }

        ReadOnlySpan<char> keySpan = path[prefix.Length..^5];
        if (keySpan.IsEmpty
            || keySpan.IndexOf('/') >= 0
            || !PublicHotReadRouteKeys.IsSafePathKey(keySpan))
        {
            return false;
        }

        routeKey = pathValue;
        return true;
    }

    private static bool TryMatchPagedList(ReadOnlySpan<char> path, string prefix, PublicListKind kind, int targetId, out PublicListKey key)
    {
        key = default;
        if (!path.StartsWith(prefix, StringComparison.Ordinal) || !path.EndsWith(".aeds", StringComparison.Ordinal))
        {
            return false;
        }

        ReadOnlySpan<char> rest = path[prefix.Length..^5];
        int slash = rest.IndexOf('/');
        if (slash <= 0 || slash == rest.Length - 1)
        {
            return false;
        }

        if (!TryParseUShort(rest[..slash], out ushort page) || !TryParseByteSize(rest[(slash + 1)..], out byte size))
        {
            return false;
        }

        key = new PublicListKey(kind, targetId, page, size);
        return true;
    }

    private static bool TryMatchTargetedPagedList(ReadOnlySpan<char> path, string prefix, PublicListKind kind, out PublicListKey key)
    {
        key = default;
        if (!path.StartsWith(prefix, StringComparison.Ordinal) || !path.EndsWith(".aeds", StringComparison.Ordinal))
        {
            return false;
        }

        ReadOnlySpan<char> rest = path[prefix.Length..^5];
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

        key = new PublicListKey(kind, targetId, page, size);
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
    long Bytes);

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

    public PublicHotReadCounterSnapshot CollectAndReset()
    {
        long articleHit = 0;
        long articleMiss = 0;
        long listHit = 0;
        long listMiss = 0;
        long htmlHit = 0;
        long htmlMiss = 0;
        long rejected = 0;
        long bytes = 0;

        foreach (CounterStripe stripe in _stripes)
        {
            articleHit += Interlocked.Exchange(ref stripe.ArticleHit, 0);
            articleMiss += Interlocked.Exchange(ref stripe.ArticleMiss, 0);
            listHit += Interlocked.Exchange(ref stripe.ListHit, 0);
            listMiss += Interlocked.Exchange(ref stripe.ListMiss, 0);
            htmlHit += Interlocked.Exchange(ref stripe.HtmlHit, 0);
            htmlMiss += Interlocked.Exchange(ref stripe.HtmlMiss, 0);
            rejected += Interlocked.Exchange(ref stripe.Rejected, 0);
            bytes += Interlocked.Exchange(ref stripe.Bytes, 0);
        }

        return new PublicHotReadCounterSnapshot(articleHit, articleMiss, listHit, listMiss, htmlHit, htmlMiss, rejected, bytes);
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
    }
}

public sealed class PublicHotReadMetricFlushWorker(
    PublicHotReadCounters counters,
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
        AddIfPositive(ArticleHitCounter, snapshot.ArticleHit);
        AddIfPositive(ArticleMissCounter, snapshot.ArticleMiss);
        AddIfPositive(ListHitCounter, snapshot.ListHit);
        AddIfPositive(ListMissCounter, snapshot.ListMiss);
        AddIfPositive(HtmlHitCounter, snapshot.HtmlHit);
        AddIfPositive(HtmlMissCounter, snapshot.HtmlMiss);
        AddIfPositive(BytesCounter, snapshot.Bytes);
        if (snapshot.Rejected > 0)
        {
            logger.LogDebug("public-hot-read-rejected {Count}", snapshot.Rejected);
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
    internal static PublicHtmlArtifact FromHtml(string html, string cacheControl)
    {
        ValidateStaticHtml(html);
        byte[] bytes = Encoding.UTF8.GetBytes(html);
        string etag = string.Concat("\"", Convert.ToHexString(SHA256.HashData(bytes)).AsSpan(0, 16).ToString().ToLowerInvariant(), "\"");
        return new PublicHtmlArtifact(bytes, "text/html; charset=utf-8", etag, cacheControl);
    }

    private static void ValidateStaticHtml(string html)
    {
        if (html.Contains("nonce=", StringComparison.OrdinalIgnoreCase)
            || html.Contains("%%FSUSBLOG_CSP_NONCE%%", StringComparison.Ordinal))
        {
            throw new InvalidOperationException("public hot-read HTML artifacts must not depend on nonce placeholders.");
        }

        // Executable inline script is audited by the source-level fast-path check.
        // Runtime validation stays limited to nonce placeholders so an existing
        // static shell cannot fail publication after the renderer has accepted it.
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
        return Convert.ToHexString(hash[..8]).ToLowerInvariant();
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

        string etag = string.Concat("\"", Convert.ToHexString(SHA256.HashData(frame)).AsSpan(0, 16).ToString().ToLowerInvariant(), "\"");
        return new PublicBinaryArtifact(frame, etag, cacheControl, version, frameType);
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
