using System.Collections.Frozen;
using System.Diagnostics.Metrics;
using System.IO.Pipelines;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;
using FsusBlog.Core.Algorithms;
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

public readonly record struct PublicListKey(
    PublicListKind Kind,
    int TargetId,
    ushort Page,
    byte Size);

public readonly record struct PublicHtmlArtifact(
    ReadOnlyMemory<byte> Bytes,
    string ContentType,
    string ETag,
    string CacheControl);

public sealed class PublicHotReadOptions
{
    public bool Enabled { get; init; } = true;
    public string CacheControl { get; init; } = "public,max-age=60";
    public int[] PreloadPages { get; init; } = [1];
    public int[] PreloadSizes { get; init; } = [1, 3, 5, 10];
    public int[] HotSizes { get; init; } = [1, 3, 5, 10];
    public int[] FeaturedSizes { get; init; } = [3, 4, 10];
}

public sealed class PublicHotReadSnapshot
{
    public static readonly PublicHotReadSnapshot Empty = new(
        0,
        [],
        FrozenDictionary<PublicListKey, ReadOnlyMemory<byte>>.Empty,
        FrozenDictionary<string, PublicHtmlArtifact>.Empty);

    private readonly ReadOnlyMemory<byte>[] _articleFramesById;
    private readonly FrozenDictionary<PublicListKey, ReadOnlyMemory<byte>> _listFrames;
    private readonly FrozenDictionary<string, PublicHtmlArtifact> _htmlBytes;

    public PublicHotReadSnapshot(
        long version,
        ReadOnlyMemory<byte>[] articleFramesById,
        FrozenDictionary<PublicListKey, ReadOnlyMemory<byte>> listFrames,
        FrozenDictionary<string, PublicHtmlArtifact> htmlBytes)
    {
        Version = version;
        _articleFramesById = articleFramesById;
        _listFrames = listFrames;
        _htmlBytes = htmlBytes;
    }

    public long Version { get; }

    public IEnumerable<KeyValuePair<string, PublicHtmlArtifact>> HtmlArtifacts => _htmlBytes;

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public bool TryGetArticle(int id, out ReadOnlyMemory<byte> frame)
    {
        if ((uint)id < (uint)_articleFramesById.Length)
        {
            frame = _articleFramesById[id];
            return !frame.IsEmpty;
        }

        frame = default;
        return false;
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public bool TryGetList(in PublicListKey key, out ReadOnlyMemory<byte> frame)
        => _listFrames.TryGetValue(key, out frame) && !frame.IsEmpty;

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public bool TryGetHtml(string routeKey, out PublicHtmlArtifact html)
        => _htmlBytes.TryGetValue(routeKey, out html) && !html.Bytes.IsEmpty;

    public PublicHotReadSnapshot WithHtml(string routeKey, PublicHtmlArtifact html)
    {
        var next = _htmlBytes.ToDictionary(StringComparer.Ordinal);
        next[routeKey] = html;
        return new PublicHotReadSnapshot(
            Version + 1,
            _articleFramesById,
            _listFrames,
            next.ToFrozenDictionary(StringComparer.Ordinal));
    }

    public PublicHotReadSnapshot WithoutHtml(string routeKey)
    {
        if (!_htmlBytes.ContainsKey(routeKey))
        {
            return this;
        }

        var next = _htmlBytes.ToDictionary(StringComparer.Ordinal);
        next.Remove(routeKey);
        return new PublicHotReadSnapshot(
            Version + 1,
            _articleFramesById,
            _listFrames,
            next.ToFrozenDictionary(StringComparer.Ordinal));
    }

    public PublicHotReadSnapshot WithoutAllHtml()
        => _htmlBytes.Count == 0
            ? this
            : new PublicHotReadSnapshot(
                Version + 1,
                _articleFramesById,
                _listFrames,
                FrozenDictionary<string, PublicHtmlArtifact>.Empty);
}

public sealed class PublicHotReadStore
{
    private PublicHotReadSnapshot _current = PublicHotReadSnapshot.Empty;

    public PublicHotReadSnapshot Current
    {
        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        get => Volatile.Read(ref _current);
    }

    public void Publish(PublicHotReadSnapshot next)
        => Volatile.Write(ref _current, next);

    public void PublishHtml(string routeKey, PublicHtmlArtifact html)
    {
        if (string.IsNullOrWhiteSpace(routeKey) || html.Bytes.IsEmpty)
        {
            return;
        }

        Publish(Current.WithHtml(routeKey.Trim(), html));
    }

    public void RemoveHtml(string routeKey)
    {
        if (string.IsNullOrWhiteSpace(routeKey))
        {
            return;
        }

        Publish(Current.WithoutHtml(routeKey.Trim()));
    }

    public void ClearHtml()
        => Publish(Current.WithoutAllHtml());
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
    private const string BinaryContentType = "application/octet-stream";
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
        if (path is null || !path.StartsWith(ArticlePrefix, StringComparison.Ordinal))
        {
            return next(ctx);
        }

        if (!HttpMethods.IsGet(ctx.Request.Method) && !HttpMethods.IsHead(ctx.Request.Method))
        {
            return WriteStatus(ctx, StatusCodes.Status405MethodNotAllowed);
        }

        if (ctx.Request.ContentLength.GetValueOrDefault() > 0 || ctx.Request.QueryString.HasValue)
        {
            return WriteStatus(ctx, StatusCodes.Status400BadRequest);
        }

        ReadOnlySpan<char> span = path.AsSpan();
        if (ContainsRejectedPathChar(span))
        {
            counters.Rejected();
            return WriteStatus(ctx, StatusCodes.Status404NotFound);
        }

        PublicHotReadSnapshot snapshot = store.Current;
        if (TryMatchArticleDetail(span, out int articleId))
        {
            return ServeArticle(ctx, snapshot, counters, articleId, options.CacheControl);
        }

        if (TryMatchArticleList(span, out PublicListKey listKey))
        {
            return ServeList(ctx, snapshot, counters, listKey, options.CacheControl);
        }

        if (TryMatchArticleHot(span, out PublicListKey hotKey))
        {
            return ServeList(ctx, snapshot, counters, hotKey, options.CacheControl);
        }

        if (TryMatchArticleFeatured(span, out PublicListKey featuredKey))
        {
            return ServeList(ctx, snapshot, counters, featuredKey, options.CacheControl);
        }

        if (TryMatchArticleHtml(span, out string? routeKey))
        {
            return ServeHtml(ctx, snapshot, counters, routeKey);
        }

        counters.Rejected();
        return WriteStatus(ctx, StatusCodes.Status404NotFound);
    }

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
        string cacheControl)
    {
        if (!snapshot.TryGetArticle(articleId, out ReadOnlyMemory<byte> frame))
        {
            counters.ArticleMiss();
            return WriteStatus(ctx, StatusCodes.Status404NotFound);
        }

        counters.ArticleHit(frame.Length);
        return WriteBinaryFrame(ctx, frame, cacheControl);
    }

    private static Task ServeList(
        HttpContext ctx,
        PublicHotReadSnapshot snapshot,
        PublicHotReadCounters counters,
        in PublicListKey key,
        string cacheControl)
    {
        if (!snapshot.TryGetList(key, out ReadOnlyMemory<byte> frame))
        {
            counters.ListMiss();
            return WriteStatus(ctx, StatusCodes.Status404NotFound);
        }

        counters.ListHit(frame.Length);
        return WriteBinaryFrame(ctx, frame, cacheControl);
    }

    private static Task ServeHtml(
        HttpContext ctx,
        PublicHotReadSnapshot snapshot,
        PublicHotReadCounters counters,
        string routeKey)
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
        if (!string.IsNullOrWhiteSpace(html.ETag))
        {
            response.Headers["ETag"] = html.ETag;
        }

        if (HttpMethods.IsHead(ctx.Request.Method))
        {
            return Completed;
        }

        ValueTask<FlushResult> write = response.BodyWriter.WriteAsync(html.Bytes, ctx.RequestAborted);
        return write.IsCompletedSuccessfully ? Completed : AwaitWrite(write);
    }

    private static Task WriteBinaryFrame(HttpContext ctx, ReadOnlyMemory<byte> frame, string cacheControl)
    {
        HttpResponse response = ctx.Response;
        response.StatusCode = StatusCodes.Status200OK;
        response.ContentType = BinaryContentType;
        response.ContentLength = frame.Length;
        response.Headers["X-Fsus-Frame-Version"] = AedsFrameHeader.CurrentVersion.ToString(System.Globalization.CultureInfo.InvariantCulture);
        response.Headers["X-Content-Type-Options"] = "nosniff";
        response.Headers["Cache-Control"] = string.IsNullOrWhiteSpace(cacheControl) ? "public,max-age=60" : cacheControl;
        response.Headers.Remove("ETag");
        response.Headers.Remove("Last-Modified");

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
        return Completed;
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

    internal static bool TryMatchArticleHtml(ReadOnlySpan<char> path, out string routeKey)
    {
        routeKey = string.Empty;
        const string prefix = "/api/binary/article/html/";
        if (!path.StartsWith(prefix, StringComparison.Ordinal) || !path.EndsWith(".html", StringComparison.Ordinal))
        {
            return false;
        }

        ReadOnlySpan<char> keySpan = path[prefix.Length..^5];
        if (keySpan.IsEmpty || keySpan.IndexOf('/') >= 0)
        {
            return false;
        }

        routeKey = keySpan.ToString();
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

    public void ArticleHit(int bytes)
    {
        CounterStripe stripe = PickStripe();
        Interlocked.Increment(ref stripe.ArticleHit);
        Interlocked.Add(ref stripe.Bytes, bytes);
    }

    public void ArticleMiss() => Interlocked.Increment(ref PickStripe().ArticleMiss);
    public void ListHit(int bytes)
    {
        CounterStripe stripe = PickStripe();
        Interlocked.Increment(ref stripe.ListHit);
        Interlocked.Add(ref stripe.Bytes, bytes);
    }

    public void ListMiss() => Interlocked.Increment(ref PickStripe().ListMiss);
    public void HtmlHit(int bytes)
    {
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
        byte[] bytes = Encoding.UTF8.GetBytes(html);
        string etag = string.Concat("\"", Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).AsSpan(0, 16).ToString().ToLowerInvariant(), "\"");
        return new PublicHtmlArtifact(bytes, "text/html; charset=utf-8", etag, cacheControl);
    }
}
