using System.Collections.Frozen;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.AspNetCore.Http;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicHotReadFastPathTests
{
    [Fact]
    public async Task TryServeAsync_DetailHit_WritesPreencodedFrameWithoutNext()
    {
        byte[] frame = CreateFrame(AedsFrameType.ArticleDetail);
        var store = CreateReadyStoreWithArticle(42, frame);
        var context = CreateContext("/api/binary/article/42.aeds");
        bool nextCalled = false;

        await PublicHotReadFastPath.TryServeAsync(
            context,
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            },
            store,
            new PublicHotReadOptions(),
            new PublicHotReadCounters());

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Equal("application/octet-stream", context.Response.ContentType);
        Assert.Equal(frame.Length, context.Response.ContentLength);
        Assert.Equal("2", context.Response.Headers["X-Fsus-Frame-Version"]);
        Assert.Equal(frame, ((MemoryStream)context.Response.Body).ToArray());
    }

    [Fact]
    public async Task TryServeAsync_DetailHeadHit_WritesHeadersWithoutBody()
    {
        byte[] frame = CreateFrame(AedsFrameType.ArticleDetail);
        var store = CreateReadyStoreWithArticle(42, frame);
        var getContext = CreateContext("/api/binary/article/42.aeds");
        var context = CreateContext("/api/binary/article/42.aeds");
        context.Request.Method = HttpMethods.Head;

        await PublicHotReadFastPath.TryServeAsync(
            getContext,
            _ => throw new InvalidOperationException("next should not run"),
            store,
            new PublicHotReadOptions(),
            new PublicHotReadCounters());

        await PublicHotReadFastPath.TryServeAsync(
            context,
            _ => throw new InvalidOperationException("next should not run"),
            store,
            new PublicHotReadOptions(),
            new PublicHotReadCounters());

        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Equal(frame.Length, context.Response.ContentLength);
        Assert.Equal(getContext.Response.ContentType, context.Response.ContentType);
        Assert.Equal(getContext.Response.Headers.CacheControl, context.Response.Headers.CacheControl);
        Assert.Equal(getContext.Response.Headers.ETag, context.Response.Headers.ETag);
        Assert.Equal(getContext.Response.Headers["Accept-Ranges"], context.Response.Headers["Accept-Ranges"]);
        Assert.Equal(getContext.Response.Headers["X-Fsus-Frame-Version"], context.Response.Headers["X-Fsus-Frame-Version"]);
        Assert.Empty(((MemoryStream)context.Response.Body).ToArray());
    }

    [Fact]
    public async Task TryServeAsync_NotReadyPublicPath_Returns503WithRetryAfter()
    {
        var context = CreateContext("/api/binary/article/42.aeds");
        bool nextCalled = false;

        await PublicHotReadFastPath.TryServeAsync(
            context,
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            },
            new PublicHotReadStore(),
            new PublicHotReadOptions(),
            new PublicHotReadCounters());

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, context.Response.StatusCode);
        Assert.Equal("1", context.Response.Headers["Retry-After"]);
        AssertNoStore(context);
    }

    [Fact]
    public async Task TryServeAsync_BroadArticlePrefix_PassesThroughToNormalPipeline()
    {
        var context = CreateContext("/api/binary/articlex/foo");
        bool nextCalled = false;

        await PublicHotReadFastPath.TryServeAsync(
            context,
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            },
            new PublicHotReadStore(),
            new PublicHotReadOptions(),
            new PublicHotReadCounters());

        Assert.True(nextCalled);
    }

    [Fact]
    public async Task TryServeAsync_OptionsOnPublicPath_Returns405()
    {
        var context = CreateContext("/api/binary/category.aeds");
        context.Request.Method = HttpMethods.Options;
        bool nextCalled = false;

        await PublicHotReadFastPath.TryServeAsync(
            context,
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            },
            new PublicHotReadStore(),
            new PublicHotReadOptions(),
            new PublicHotReadCounters());

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status405MethodNotAllowed, context.Response.StatusCode);
        AssertNoStore(context);
    }

    [Theory]
    [InlineData("/api/binary/category")]
    [InlineData("/api/binary/tag")]
    public async Task TryServeAsync_TaxonomyWritePath_PassesThroughToNormalPipeline(string path)
    {
        var context = CreateContext(path);
        context.Request.Method = HttpMethods.Post;
        bool nextCalled = false;

        await PublicHotReadFastPath.TryServeAsync(
            context,
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            },
            new PublicHotReadStore(),
            new PublicHotReadOptions(),
            new PublicHotReadCounters());

        Assert.True(nextCalled);
    }

    [Fact]
    public async Task TryServeAsync_BadAccept_Returns406BeforeSnapshotLookup()
    {
        var context = CreateContext("/api/binary/article/42.aeds");
        context.Request.Headers.Accept = "application/json";
        bool nextCalled = false;

        await PublicHotReadFastPath.TryServeAsync(
            context,
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            },
            new PublicHotReadStore(),
            new PublicHotReadOptions(),
            new PublicHotReadCounters());

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status406NotAcceptable, context.Response.StatusCode);
        AssertNoStore(context);
    }

    [Theory]
    [InlineData("")]
    [InlineData("*/*")]
    [InlineData("application/octet-stream")]
    [InlineData("application/octet-stream; version=2")]
    [InlineData("application/json;q=1, application/octet-stream;q=0.5")]
    public async Task TryServeAsync_BinaryAcceptVariants_UseSharedNegotiation(string accept)
    {
        byte[] frame = CreateFrame(AedsFrameType.ArticleDetail);
        var store = CreateReadyStoreWithArticle(42, frame);
        var context = CreateContext("/api/binary/article/42.aeds");
        context.Request.Headers.Accept = accept;

        await PublicHotReadFastPath.TryServeAsync(
            context,
            _ => throw new InvalidOperationException("next should not run"),
            store,
            new PublicHotReadOptions(),
            new PublicHotReadCounters());

        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Equal(frame, ((MemoryStream)context.Response.Body).ToArray());
    }

    [Fact]
    public async Task TryServeAsync_BinaryAcceptQZero_Returns406()
    {
        var context = CreateContext("/api/binary/article/42.aeds");
        context.Request.Headers.Accept = "application/octet-stream;q=0";

        await PublicHotReadFastPath.TryServeAsync(
            context,
            _ => throw new InvalidOperationException("next should not run"),
            CreateReadyEmptyStore(),
            new PublicHotReadOptions(),
            new PublicHotReadCounters());

        Assert.Equal(StatusCodes.Status406NotAcceptable, context.Response.StatusCode);
        AssertNoStore(context);
    }

    [Fact]
    public async Task TryServeAsync_HtmlPathWithBinaryAccept_Returns406()
    {
        var context = CreateContext(PublicHotReadRouteKeys.HtmlPath("home"));
        context.Request.Headers.Accept = "application/octet-stream";
        bool nextCalled = false;

        await PublicHotReadFastPath.TryServeAsync(
            context,
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            },
            new PublicHotReadStore(),
            new PublicHotReadOptions(),
            new PublicHotReadCounters());

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status406NotAcceptable, context.Response.StatusCode);
        AssertNoStore(context);
    }

    [Theory]
    [InlineData("text/html")]
    [InlineData("text/html; charset=utf-8")]
    [InlineData("application/json;q=1, text/html;q=0.5")]
    [InlineData("*/*")]
    public async Task TryServeAsync_HtmlAcceptVariants_UseSharedNegotiation(string accept)
    {
        var store = CreateReadyEmptyStore();
        store.PublishHtml(
            "home",
            PublicHotReadHtmlArtifactFactory.FromHtml("<!doctype html><html><body>ok</body></html>", "public,max-age=60"));
        var context = CreateContext(PublicHotReadRouteKeys.HtmlPath("home"));
        context.Request.Headers.Accept = accept;

        await PublicHotReadFastPath.TryServeAsync(
            context,
            _ => throw new InvalidOperationException("next should not run"),
            store,
            new PublicHotReadOptions(),
            new PublicHotReadCounters());

        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Equal("text/html; charset=utf-8", context.Response.ContentType);
    }

    [Fact]
    public async Task TryServeAsync_HtmlAcceptQZero_Returns406()
    {
        var context = CreateContext(PublicHotReadRouteKeys.HtmlPath("home"));
        context.Request.Headers.Accept = "text/html;q=0";

        await PublicHotReadFastPath.TryServeAsync(
            context,
            _ => throw new InvalidOperationException("next should not run"),
            CreateReadyEmptyStore(),
            new PublicHotReadOptions(),
            new PublicHotReadCounters());

        Assert.Equal(StatusCodes.Status406NotAcceptable, context.Response.StatusCode);
        AssertNoStore(context);
    }

    [Fact]
    public async Task TryServeAsync_RangeRequest_Returns416NoStore()
    {
        var context = CreateContext("/api/binary/article/42.aeds");
        context.Request.Headers.Range = "bytes=0-1";
        bool nextCalled = false;

        await PublicHotReadFastPath.TryServeAsync(
            context,
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            },
            new PublicHotReadStore(),
            new PublicHotReadOptions(),
            new PublicHotReadCounters());

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status416RangeNotSatisfiable, context.Response.StatusCode);
        Assert.Equal("bytes */0", context.Response.Headers.ContentRange);
        AssertNoStore(context);
    }

    [Fact]
    public async Task TryServeAsync_CategoryArtifactHit_WritesPreencodedFrame()
    {
        byte[] frame = CreateFrame(AedsFrameType.CategoryList);
        var store = new PublicHotReadStore();
        store.Publish(new PublicHotReadSnapshot(
            1,
            FrozenDictionary<int, PublicBinaryArtifact>.Empty,
            FrozenDictionary<PublicListKey, PublicBinaryArtifact>.Empty,
            new PublicBinaryArtifact(frame, "\"category\"", "public,max-age=60", 1, AedsFrameType.CategoryList),
            default,
            FrozenDictionary<string, PublicHtmlArtifact>.Empty));
        var context = CreateContext("/api/binary/category.aeds");

        await PublicHotReadFastPath.TryServeAsync(
            context,
            _ => throw new InvalidOperationException("next should not run"),
            store,
            new PublicHotReadOptions(),
            new PublicHotReadCounters());

        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Equal("\"category\"", context.Response.Headers.ETag);
        Assert.Equal(frame, ((MemoryStream)context.Response.Body).ToArray());
    }

    [Theory]
    [InlineData("/api/binary/category")]
    [InlineData("/api/binary/category.aeds")]
    [InlineData("/api/binary/tag")]
    [InlineData("/api/binary/tag.aeds")]
    public async Task TryServeAsync_TaxonomyRoutes_HitPreencodedArtifacts(string path)
    {
        bool isCategory = path.Contains("category", StringComparison.Ordinal);
        byte[] frame = CreateFrame(isCategory ? AedsFrameType.CategoryList : AedsFrameType.TagList);
        var store = new PublicHotReadStore();
        store.Publish(new PublicHotReadSnapshot(
            1,
            FrozenDictionary<int, PublicBinaryArtifact>.Empty,
            FrozenDictionary<PublicListKey, PublicBinaryArtifact>.Empty,
            isCategory ? new PublicBinaryArtifact(frame, "\"category\"", "public,max-age=60", 1, AedsFrameType.CategoryList) : default,
            isCategory ? default : new PublicBinaryArtifact(frame, "\"tag\"", "public,max-age=60", 1, AedsFrameType.TagList),
            FrozenDictionary<string, PublicHtmlArtifact>.Empty));
        var context = CreateContext(path);

        await PublicHotReadFastPath.TryServeAsync(
            context,
            _ => throw new InvalidOperationException("next should not run"),
            store,
            new PublicHotReadOptions(),
            new PublicHotReadCounters());

        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Equal(frame, ((MemoryStream)context.Response.Body).ToArray());
    }

    [Fact]
    public async Task TryServeAsync_PublicQueryPath_IsRejectedBeforeNormalPipeline()
    {
        var context = CreateContext("/api/binary/article");
        context.Request.QueryString = new QueryString("?page=1&size=10");
        bool nextCalled = false;

        await PublicHotReadFastPath.TryServeAsync(
            context,
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            },
            new PublicHotReadStore(),
            new PublicHotReadOptions(),
            new PublicHotReadCounters());

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status400BadRequest, context.Response.StatusCode);
        Assert.Equal("/api/binary/article/list/home/{page}/{size}.aeds", context.Response.Headers["X-Fsus-Required-Route"]);
        AssertNoStore(context);
    }

    [Fact]
    public async Task TryServeAsync_PublicBody_IsRejectedBeforeNormalPipeline()
    {
        var context = CreateContext("/api/binary/article/42.aeds");
        context.Request.Body = new MemoryStream([1, 2, 3]);
        context.Request.ContentLength = 3;
        bool nextCalled = false;

        await PublicHotReadFastPath.TryServeAsync(
            context,
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            },
            new PublicHotReadStore(),
            new PublicHotReadOptions(),
            new PublicHotReadCounters());

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status400BadRequest, context.Response.StatusCode);
        AssertNoStore(context);
    }

    [Fact]
    public async Task TryServeAsync_AdminRoute_PassesThroughToNormalPipeline()
    {
        var context = CreateContext("/api/binary/admin/article/42");
        bool nextCalled = false;

        await PublicHotReadFastPath.TryServeAsync(
            context,
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            },
            new PublicHotReadStore(),
            new PublicHotReadOptions(),
            new PublicHotReadCounters());

        Assert.True(nextCalled);
    }

    [Fact]
    public void TryMatchArticleList_ParsesSegmentRoutes()
    {
        Assert.True(PublicHotReadFastPath.TryMatchArticleList("/api/binary/article/list/home/1/10.aeds", out PublicListKey home));
        Assert.Equal(new PublicListKey(PublicListKind.Home, 0, 1, 10), home);

        Assert.True(PublicHotReadFastPath.TryMatchArticleList("/api/binary/article/list/category/7/1/5.aeds", out PublicListKey category));
        Assert.Equal(new PublicListKey(PublicListKind.Category, 7, 1, 5), category);

        Assert.True(PublicHotReadFastPath.TryMatchArticleHot("/api/binary/article/hot/10.aeds", out PublicListKey hot));
        Assert.Equal(new PublicListKey(PublicListKind.Hot, 0, 1, 10), hot);
    }

    [Fact]
    public void PublicHotReadRouteKeys_MapsUnsafeRouteKeysToStableSafeHtmlPaths()
    {
        Assert.Equal("/api/binary/article/html/article-42.html", PublicHotReadRouteKeys.HtmlPath("article:42"));
        Assert.Equal("/api/binary/article/html/category-7.html", PublicHotReadRouteKeys.HtmlPath("category:7"));
        Assert.Equal("/api/binary/article/html/tag-9.html", PublicHotReadRouteKeys.HtmlPath("tag:9"));

        string tagNamePath = PublicHotReadRouteKeys.HtmlPath("tag-name:中文 / white space");
        Assert.StartsWith("/api/binary/article/html/tag-name-", tagNamePath, StringComparison.Ordinal);
        Assert.EndsWith(".html", tagNamePath, StringComparison.Ordinal);
        Assert.DoesNotContain("中文", tagNamePath, StringComparison.Ordinal);
        Assert.DoesNotContain(" ", tagNamePath, StringComparison.Ordinal);
        Assert.False(tagNamePath["/api/binary/article/html/".Length..^5].Contains('/'));
    }

    [Fact]
    public async Task TryServeAsync_HtmlHit_UsesStableSafePathKey()
    {
        var store = CreateReadyEmptyStore();
        string routeKey = "tag-name:中文 / white space";
        store.PublishHtml(
            routeKey,
            PublicPageId.Filter,
            PublicHotReadHtmlArtifactFactory.FromHtml("<!doctype html><html><body>ok</body></html>", "public,max-age=60"));

        var context = CreateContext(PublicHotReadRouteKeys.HtmlPath(routeKey));
        context.Request.Headers.Accept = "text/html";

        await PublicHotReadFastPath.TryServeAsync(
            context,
            _ => throw new InvalidOperationException("next should not run"),
            store,
            new PublicHotReadOptions(),
            new PublicHotReadCounters());

        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Equal("text/html; charset=utf-8", context.Response.ContentType);
        Assert.Equal("none", context.Response.Headers["Accept-Ranges"]);
    }

    [Fact]
    public void SnapshotHtmlOverlay_UpdatesAndRemovesWithoutRebuildingBase()
    {
        var baseHtml = PublicHotReadHtmlArtifactFactory.FromHtml("<!doctype html><html><body>base</body></html>", "public,max-age=60");
        var nextHtml = PublicHotReadHtmlArtifactFactory.FromHtml("<!doctype html><html><body>next</body></html>", "public,max-age=60");
        var baseSnapshot = new PublicHotReadSnapshot(
            1,
            FrozenDictionary<int, PublicBinaryArtifact>.Empty,
            FrozenDictionary<PublicListKey, PublicBinaryArtifact>.Empty,
            default,
            default,
            new Dictionary<string, PublicHtmlArtifact>
            {
                [PublicHotReadRouteKeys.HtmlPath("home")] = baseHtml
            }.ToFrozenDictionary(StringComparer.Ordinal));

        PublicHotReadSnapshot updated = baseSnapshot.WithHtml(PublicHotReadRouteKeys.HtmlPath("home"), nextHtml);
        PublicHotReadSnapshot added = updated.WithHtml(PublicHotReadRouteKeys.HtmlPath("about"), nextHtml);
        PublicHotReadSnapshot removedBase = added.WithoutHtml(PublicHotReadRouteKeys.HtmlPath("home"));

        Assert.Equal(1, baseSnapshot.HtmlFrameCount);
        Assert.Equal(1, updated.HtmlFrameCount);
        Assert.Equal(2, added.HtmlFrameCount);
        Assert.Equal(1, removedBase.HtmlFrameCount);
        Assert.True(updated.TryGetHtml(PublicHotReadRouteKeys.HtmlPath("home"), out PublicHtmlArtifact updatedHtml));
        Assert.Equal(nextHtml.ETag, updatedHtml.ETag);
        Assert.False(removedBase.TryGetHtml(PublicHotReadRouteKeys.HtmlPath("home"), out _));
        Assert.Single(removedBase.HtmlArtifacts);
    }

    [Fact]
    public async Task TryServeAsync_DiagnosticHeaders_AreOptIn()
    {
        byte[] frame = CreateFrame(AedsFrameType.ArticleDetail);
        var store = CreateReadyStoreWithArticle(42, frame);
        var defaultContext = CreateContext("/api/binary/article/42.aeds");
        var diagnosticContext = CreateContext("/api/binary/article/42.aeds");

        await PublicHotReadFastPath.TryServeAsync(
            defaultContext,
            _ => throw new InvalidOperationException("next should not run"),
            store,
            new PublicHotReadOptions(),
            new PublicHotReadCounters());

        await PublicHotReadFastPath.TryServeAsync(
            diagnosticContext,
            _ => throw new InvalidOperationException("next should not run"),
            store,
            new PublicHotReadOptions { EnableDiagnosticHeaders = true },
            new PublicHotReadCounters());

        Assert.False(defaultContext.Response.Headers.ContainsKey("X-Fsus-HotRead-Version"));
        Assert.Equal("1", diagnosticContext.Response.Headers["X-Fsus-HotRead-Version"]);
        Assert.Equal("article", diagnosticContext.Response.Headers["X-Fsus-HotRead-Artifact"]);
        Assert.Equal("42", diagnosticContext.Response.Headers["X-Fsus-HotRead-Key"]);
    }

    [Theory]
    [InlineData("/api/binary/article/0.aeds")]
    [InlineData("/api/binary/article/-1.aeds")]
    [InlineData("/api/binary/article/1.json")]
    [InlineData("/api/binary/article/list/home/0/10.aeds")]
    [InlineData("/api/binary/article/list/home/1/0.aeds")]
    [InlineData("/api/binary/article/list/home/1/101.aeds")]
    [InlineData("/api/binary/article/html/%2f.html")]
    public async Task TryServeAsync_InvalidPublicRouteShapes_Return404WithoutNext(string path)
    {
        var context = CreateContext(path);
        bool nextCalled = false;

        await PublicHotReadFastPath.TryServeAsync(
            context,
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            },
            CreateReadyEmptyStore(),
            new PublicHotReadOptions(),
            new PublicHotReadCounters());

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status404NotFound, context.Response.StatusCode);
        AssertNoStore(context);
    }

    [Fact]
    public void BinaryArtifactFactory_ValidatesExpectedFrameAndRejectsCorruption()
    {
        var encoder = new AedsEncoder();
        byte[] payload = PodBinaryCodec.EncodeCategoryList([]);
        PublicBinaryArtifact artifact = PublicHotReadBinaryArtifactFactory.FromPayload(
            encoder,
            AedsFrameType.CategoryList,
            payload,
            "public,max-age=60",
            1,
            new PublicHotReadOptions());

        Assert.True(PublicHotReadBinaryArtifactFactory.LooksLikeExpectedAedsFrame(artifact.Frame.Span, AedsFrameType.CategoryList));

        byte[] corrupted = artifact.Frame.ToArray();
        corrupted[^1] ^= 0xFF;
        Assert.False(PublicHotReadBinaryArtifactFactory.LooksLikeExpectedAedsFrame(corrupted, AedsFrameType.CategoryList));
    }

    [Fact]
    public void FastPathSource_DoesNotReferenceRequestScopedOrIoHotPathDependencies()
    {
        string source = File.ReadAllText(Path.Combine(FindRepoRoot(), "src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.cs"));
        string fastPathSource = source[
            source.IndexOf("public static class PublicHotReadFastPath", StringComparison.Ordinal)
            ..source.IndexOf("public readonly record struct PublicHotReadCounterSnapshot", StringComparison.Ordinal)];

        Assert.DoesNotContain("RequestServices", fastPathSource, StringComparison.Ordinal);
        Assert.DoesNotContain("File.", fastPathSource, StringComparison.Ordinal);
        Assert.DoesNotContain("IConnectionMultiplexer", fastPathSource, StringComparison.Ordinal);
        Assert.DoesNotContain("IMemoryCache", fastPathSource, StringComparison.Ordinal);
        Assert.DoesNotContain("Activity", fastPathSource, StringComparison.Ordinal);
        Assert.DoesNotContain("ILogger", fastPathSource, StringComparison.Ordinal);
        Assert.DoesNotContain("IAedsEncoder", fastPathSource, StringComparison.Ordinal);
        Assert.DoesNotContain("BinaryResults", fastPathSource, StringComparison.Ordinal);
    }

    [Fact]
    public void ProjectorSource_UsesDeterministicPublicListOrdering()
    {
        string source = File.ReadAllText(Path.Combine(FindRepoRoot(), "src/backend/Infrastructure/PublicReadArtifacts/PublicHotArtifactProjector.cs"));

        Assert.Contains("ORDER BY a.createtime DESC, a.id DESC", source, StringComparison.Ordinal);
    }

    private static DefaultHttpContext CreateContext(string path)
    {
        var context = new DefaultHttpContext();
        context.Request.Method = HttpMethods.Get;
        context.Request.Path = path;
        context.Response.Body = new MemoryStream();
        return context;
    }

    private static PublicHotReadStore CreateReadyEmptyStore()
    {
        var store = new PublicHotReadStore();
        store.Publish(PublicHotReadSnapshot.Empty);
        return store;
    }

    private static PublicHotReadStore CreateReadyStoreWithArticle(int articleId, byte[] frame)
    {
        var store = new PublicHotReadStore();
        var articles = new Dictionary<int, PublicBinaryArtifact>
        {
            [articleId] = new(frame, "\"detail\"", "public,max-age=60", 1, AedsFrameType.ArticleDetail)
        }.ToFrozenDictionary();
        store.Publish(new PublicHotReadSnapshot(
            1,
            articles,
            FrozenDictionary<PublicListKey, PublicBinaryArtifact>.Empty,
            default,
            default,
            FrozenDictionary<string, PublicHtmlArtifact>.Empty));
        return store;
    }

    private static byte[] CreateFrame(AedsFrameType frameType, byte[]? payload = null)
        => new AedsEncoder().Encode(frameType, payload ?? []);

    private static void AssertNoStore(DefaultHttpContext context)
    {
        Assert.Equal("no-store", context.Response.Headers.CacheControl);
        Assert.Equal("no-cache", context.Response.Headers.Pragma);
        Assert.Equal("0", context.Response.Headers.Expires);
        Assert.Equal("none", context.Response.Headers["Accept-Ranges"]);
    }

    private static string FindRepoRoot()
    {
        DirectoryInfo? current = new(AppContext.BaseDirectory);
        while (current is not null)
        {
            if (File.Exists(Path.Combine(current.FullName, "FsusBlog.slnx")))
            {
                return current.FullName;
            }

            current = current.Parent;
        }

        throw new DirectoryNotFoundException("repo root not found");
    }
}
