using System.Collections.Frozen;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Primitives;
using NSubstitute;
using System.Reflection;
using System.Threading.RateLimiting;

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
    public async Task TryServeAsync_ResponseAbortCancellationPropagatesFromBodyWriter()
    {
        byte[] frame = CreateFrame(AedsFrameType.ArticleDetail, new byte[4096]);
        var store = CreateReadyStoreWithArticle(42, frame);
        var context = CreateContext("/api/binary/article/42.aeds");
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        context.RequestAborted = cancellation.Token;

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => PublicHotReadFastPath.TryServeAsync(
            context,
            _ => throw new InvalidOperationException("aborted L0 hit must not enter fallback"),
            store,
            new PublicHotReadOptions(),
            new PublicHotReadCounters()));
    }

    [Fact]
    public async Task TryServeAsync_DetailMiss_AllowsEndpointFallbackForArtifactBackfill()
    {
        var context = CreateContext("/api/binary/article/42.aeds");
        bool nextCalled = false;

        await PublicHotReadFastPath.TryServeAsync(
            context,
            ctx =>
            {
                nextCalled = true;
                ctx.Response.StatusCode = StatusCodes.Status202Accepted;
                return Task.CompletedTask;
            },
            CreateReadyEmptyStore(),
            new PublicHotReadOptions(),
            new PublicHotReadCounters());

        Assert.True(nextCalled);
        Assert.Equal(StatusCodes.Status202Accepted, context.Response.StatusCode);
    }

    [Fact]
    public void RuntimeSnapshot_ExposesArticleFrameLimitOverflow()
    {
        var store = new PublicHotReadStore();
        PublicBinaryArtifact article = new(CreateFrame(AedsFrameType.ArticleDetail), "\"detail\"", "public,max-age=60", 1, AedsFrameType.ArticleDetail);
        var snapshot = new PublicHotReadSnapshot(
            2,
            new Dictionary<int, PublicBinaryArtifact> { [42] = article }.ToFrozenDictionary(),
            FrozenDictionary<PublicListKey, PublicBinaryArtifact>.Empty,
            default,
            default,
            FrozenDictionary<string, PublicHtmlArtifact>.Empty,
            publicArticleCount: 2,
            articleFrameLimit: 1);

        store.Publish(snapshot);

        PublicHotReadRuntimeSnapshot runtime = store.CreateRuntimeSnapshot();
        Assert.Equal(1, runtime.ArticleFrameCount);
        Assert.Equal(2, runtime.PublicArticleCount);
        Assert.Equal(1, runtime.ArticleFrameLimit);
        Assert.True(runtime.ArticleFrameLimitExceeded);
        Assert.True(runtime.EarlyDataPlaneEnabled);
        Assert.Equal("ready", runtime.EarlyDataPlaneState);
    }

    [Fact]
    public void EarlyDataPlaneRuntimeState_ReloadDisablesClassifierWithoutRestart()
    {
        var monitor = new ReloadablePublicHotReadOptionsMonitor(new PublicHotReadOptions { Enabled = true });
        using var runtimeState = new PublicHotReadEarlyDataPlaneRuntimeState(monitor);
        var store = new PublicHotReadStore(runtimeState);
        store.Publish(PublicHotReadSnapshot.Empty);

        monitor.Set(new PublicHotReadOptions { Enabled = false });

        Assert.False(runtimeState.Enabled);
        PublicHotReadRuntimeSnapshot snapshot = store.CreateRuntimeSnapshot();
        Assert.False(snapshot.EarlyDataPlaneEnabled);
        Assert.Equal("disabled", snapshot.EarlyDataPlaneState);
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
    public async Task TryServeAsync_DetailHit_PrefersPrecompressedBrotliVariant()
    {
        var options = new PublicHotReadOptions { MinPrecompressedFrameBytes = 1 };
        byte[] payload = Enumerable.Repeat((byte)'a', 2048).ToArray();
        PublicBinaryArtifact artifact = PublicHotReadBinaryArtifactFactory.FromPayload(
            new AedsEncoder(),
            AedsFrameType.ArticleDetail,
            payload,
            "public,max-age=60",
            1,
            options);
        Assert.False(artifact.BrotliFrame.IsEmpty);
        var store = CreateReadyStoreWithArticle(42, artifact);
        var context = CreateContext("/api/binary/article/42.aeds");
        context.Request.Headers.AcceptEncoding = "gzip, br";

        await PublicHotReadFastPath.TryServeAsync(
            context,
            _ => throw new InvalidOperationException("next should not run"),
            store,
            options,
            new PublicHotReadCounters());

        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Equal("br", context.Response.Headers["Content-Encoding"]);
        Assert.Equal("Accept-Encoding", context.Response.Headers.Vary);
        Assert.Equal("br", context.Response.Headers["X-Fsus-Frame-Encoding"]);
        Assert.Equal(artifact.BrotliETag, context.Response.Headers.ETag);
        Assert.Equal(artifact.BrotliFrame.Length, context.Response.ContentLength);
        Assert.Equal(artifact.BrotliFrame.ToArray(), ((MemoryStream)context.Response.Body).ToArray());
    }

    [Theory]
    [InlineData("", "")]
    [InlineData("br", "br")]
    [InlineData("gzip", "gzip")]
    [InlineData("gzip, br", "br")]
    [InlineData("br, gzip", "br")]
    [InlineData("gzip, deflate, br", "br")]
    public async Task TryServeAsync_DetailHit_CommonAcceptEncodingValuesUseFastVariantSelection(
        string acceptEncoding,
        string expectedEncoding)
    {
        PublicBinaryArtifact artifact = CreateCompressibleArtifact();
        var store = CreateReadyStoreWithArticle(42, artifact);
        var context = CreateContext("/api/binary/article/42.aeds");
        if (acceptEncoding.Length > 0)
        {
            context.Request.Headers.AcceptEncoding = acceptEncoding;
        }

        await PublicHotReadFastPath.TryServeAsync(
            context,
            _ => throw new InvalidOperationException("next should not run"),
            store,
            new PublicHotReadOptions { MinPrecompressedFrameBytes = 1 },
            new PublicHotReadCounters());

        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Equal(expectedEncoding, context.Response.Headers["Content-Encoding"].ToString());
        Assert.Equal(string.IsNullOrEmpty(expectedEncoding) ? "identity" : expectedEncoding, context.Response.Headers["X-Fsus-Frame-Encoding"].ToString());
    }

    [Fact]
    public async Task TryServeAsync_DetailHit_QValueFallbackStillHonorsQuality()
    {
        PublicBinaryArtifact artifact = CreateCompressibleArtifact();
        var store = CreateReadyStoreWithArticle(42, artifact);
        var context = CreateContext("/api/binary/article/42.aeds");
        context.Request.Headers.AcceptEncoding = "br;q=0, gzip;q=1, identity;q=0.1";

        await PublicHotReadFastPath.TryServeAsync(
            context,
            _ => throw new InvalidOperationException("next should not run"),
            store,
            new PublicHotReadOptions { MinPrecompressedFrameBytes = 1 },
            new PublicHotReadCounters());

        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Equal("gzip", context.Response.Headers["Content-Encoding"].ToString());
        Assert.Equal(artifact.GzipETag, context.Response.Headers.ETag);
    }

    [Fact]
    public async Task TryServeAsync_DetailHit_IdentityQZeroWithoutAvailableCompressedVariantReturns406()
    {
        byte[] frame = CreateFrame(AedsFrameType.ArticleDetail);
        var store = CreateReadyStoreWithArticle(42, frame);
        var context = CreateContext("/api/binary/article/42.aeds");
        context.Request.Headers.AcceptEncoding = "identity;q=0";

        await PublicHotReadFastPath.TryServeAsync(
            context,
            _ => throw new InvalidOperationException("next should not run"),
            store,
            new PublicHotReadOptions(),
            new PublicHotReadCounters());

        Assert.Equal(StatusCodes.Status406NotAcceptable, context.Response.StatusCode);
        AssertNoStore(context);
    }

    [Fact]
    public async Task TryServeAsync_DetailHit_Returns304ForMatchingIfNoneMatch()
    {
        byte[] frame = CreateFrame(AedsFrameType.ArticleDetail);
        var store = CreateReadyStoreWithArticle(42, frame);
        var context = CreateContext("/api/binary/article/42.aeds");
        context.Request.Headers.IfNoneMatch = "\"detail\"";

        await PublicHotReadFastPath.TryServeAsync(
            context,
            _ => throw new InvalidOperationException("next should not run"),
            store,
            new PublicHotReadOptions(),
            new PublicHotReadCounters());

        Assert.Equal(StatusCodes.Status304NotModified, context.Response.StatusCode);
        Assert.Equal("\"detail\"", context.Response.Headers.ETag);
        Assert.Empty(((MemoryStream)context.Response.Body).ToArray());
    }

    [Fact]
    public void IfNoneMatchCommonAndFallbackCases_MatchExpectedEtags()
    {
        Assert.False(PublicHotReadFastPath.MatchesIfNoneMatchForTests(StringValues.Empty, "\"detail\""));
        Assert.True(PublicHotReadFastPath.MatchesIfNoneMatchForTests(new StringValues("\"detail\""), "\"detail\""));
        Assert.False(PublicHotReadFastPath.MatchesIfNoneMatchForTests(new StringValues("\"other\""), "\"detail\""));
        Assert.True(PublicHotReadFastPath.MatchesIfNoneMatchForTests(new StringValues("*"), "\"detail\""));
        Assert.True(PublicHotReadFastPath.MatchesIfNoneMatchForTests(new StringValues("\"other\", \"detail\""), "\"detail\""));
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

    [Theory]
    [InlineData(false, "", true)]
    [InlineData(false, "*/*", true)]
    [InlineData(false, "application/octet-stream", true)]
    [InlineData(false, "application/octet-stream,*/*", true)]
    [InlineData(false, "application/json", false)]
    [InlineData(true, "text/html", true)]
    [InlineData(true, "text/html,*/*", true)]
    [InlineData(true, "*/*", true)]
    [InlineData(true, "application/octet-stream", false)]
    public void AcceptCommonValues_ShortCircuitToExpectedArtifactDecision(bool html, string accept, bool expected)
    {
        bool actual = PublicHotReadFastPath.AcceptsArtifactForTests(new StringValues(accept), html);

        Assert.Equal(expected, actual);
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
    public async Task TryServeAsync_RelatedReadingRoute_PassesThroughToDynamicEndpoint()
    {
        var context = CreateContext("/api/binary/article/42/related.aeds");
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
    public void TryClassifyRoute_ParsesPublicHotReadRoutesInOnePass()
    {
        Assert.True(PublicHotReadFastPath.TryClassifyRouteForTests("/api/binary/category.aeds", out PublicHotReadRoute category));
        Assert.Equal(PublicHotReadRouteKind.Category, category.Kind);

        Assert.True(PublicHotReadFastPath.TryClassifyRouteForTests("/api/binary/tag", out PublicHotReadRoute tag));
        Assert.Equal(PublicHotReadRouteKind.Tag, tag.Kind);

        Assert.True(PublicHotReadFastPath.TryClassifyRouteForTests("/api/binary/article/42.aeds", out PublicHotReadRoute detail));
        Assert.Equal(PublicHotReadRouteKind.ArticleDetail, detail.Kind);
        Assert.Equal(42, detail.ArticleId);

        Assert.True(PublicHotReadFastPath.TryClassifyRouteForTests("/api/binary/article/list/category/7/1/5.aeds", out PublicHotReadRoute list));
        Assert.Equal(PublicHotReadRouteKind.ArticleList, list.Kind);
        Assert.Equal(new PublicListKey(PublicListKind.Category, 7, 1, 5), list.ListKey);

        Assert.True(PublicHotReadFastPath.TryClassifyRouteForTests("/api/binary/article/featured/4.aeds", out PublicHotReadRoute featured));
        Assert.Equal(PublicHotReadRouteKind.ArticleFeatured, featured.Kind);
        Assert.Equal(new PublicListKey(PublicListKind.Featured, 0, 1, 4), featured.ListKey);

        Assert.True(PublicHotReadFastPath.TryClassifyRouteForTests("/", out PublicHotReadRoute homeHtml));
        Assert.Equal(PublicHotReadRouteKind.PublicHtml, homeHtml.Kind);
        Assert.Equal(PublicHotReadRouteKeys.HtmlPath("home"), homeHtml.HtmlRouteKey);

        Assert.True(PublicHotReadFastPath.TryClassifyRouteForTests("/category/7", out PublicHotReadRoute categoryHtml));
        Assert.Equal(PublicHotReadRouteKind.PublicHtml, categoryHtml.Kind);
        Assert.Equal(PublicHotReadRouteKeys.HtmlPath("category:7"), categoryHtml.HtmlRouteKey);

        Assert.True(PublicHotReadFastPath.TryClassifyRouteForTests("/tag/9", out PublicHotReadRoute tagHtml));
        Assert.Equal(PublicHotReadRouteKind.PublicHtml, tagHtml.Kind);
        Assert.Equal(PublicHotReadRouteKeys.HtmlPath("tag:9"), tagHtml.HtmlRouteKey);
        Assert.False(PublicHotReadFastPath.TryClassifyRouteForTests("/tag/9/", out _));

        string htmlPath = PublicHotReadRouteKeys.HtmlPath("home");
        Assert.True(PublicHotReadFastPath.TryClassifyRouteForTests(htmlPath, out PublicHotReadRoute html));
        Assert.Equal(PublicHotReadRouteKind.ArticleHtml, html.Kind);
        Assert.Equal(htmlPath, html.HtmlRouteKey);

        Assert.False(PublicHotReadFastPath.TryClassifyRouteForTests("/api/binary/article/list/home/0/10.aeds", out _));
    }

    [Theory]
    [InlineData("/api/binary/article/42.aeds", true)]
    [InlineData("/api/binary/article/list/home/1/10.aeds", true)]
    [InlineData("/api/binary/category.aeds", true)]
    [InlineData("/", true)]
    [InlineData("/category/7", true)]
    [InlineData("/tag/9", true)]
    [InlineData("/tag/fsus", false)]
    [InlineData("/api/binary/article/42/related.aeds", false)]
    [InlineData("/assets/app.js", false)]
    public void RequestFeatureSecurityGate_CoversBinaryAndPublicHtmlArtifacts(string path, bool expected)
    {
        DefaultHttpContext context = CreateContext(path);

        bool actual = PublicHotReadFastPath.TryCreateRequestFeatureForTests(
            context,
            out PublicHotReadRequestFeature? feature)
            && feature?.RequiresSecurityGate == true;
        Assert.Equal(expected, actual);
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
    public async Task TryServeAsync_PublicHtmlHomeHit_ServesArtifactBeforeNormalPipeline()
    {
        var store = CreateReadyEmptyStore();
        PublicHtmlArtifact html = CreateHtmlArtifact("home");
        store.PublishHtml("home", PublicPageId.Home, html);
        var context = CreateContext("/");
        context.Request.Headers.Accept = "text/html";
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
        Assert.Equal("text/html; charset=utf-8", context.Response.ContentType);
        Assert.Equal(html.ETag, context.Response.Headers.ETag);
        Assert.Equal(html.Bytes.Length, context.Response.ContentLength);
        Assert.Equal("server-ssr", context.Response.Headers["X-Fsus-Public-Aot-Source"]);
        Assert.Equal(html.Bytes.ToArray(), ((MemoryStream)context.Response.Body).ToArray());
        AssertHtmlSecurityHeaders(context);
    }

    [Fact]
    public async Task TryServeAsync_PublicHtmlHomeHit_WithInlineAotDocumentUsesNonceCsp()
    {
        var store = CreateReadyEmptyStore();
        const string source = "<!doctype html><html><head><style>.ok{color:currentColor}</style></head><body><script id=\"fsus-theme-bootstrap\"></script><main style=\"display:block\">ok</main></body></html>";
        PublicHtmlArtifact html = PublicHotReadHtmlArtifactFactory.FromHtml(source, "public,max-age=60");
        Assert.True(html.RequiresCspNonceMutation);
        store.PublishHtml("home", PublicPageId.Home, html);
        var context = CreateContext("/");
        context.Request.Headers.Accept = "text/html";
        context.Request.Headers.AcceptEncoding = "br, gzip";
        context.Request.Headers.IfNoneMatch = html.ETag;

        await PublicHotReadFastPath.TryServeAsync(
            context,
            _ => throw new InvalidOperationException("next should not run"),
            store,
            new PublicHotReadOptions(),
            new PublicHotReadCounters(),
            isDevelopment: true);

        string rendered = System.Text.Encoding.UTF8.GetString(((MemoryStream)context.Response.Body).ToArray());
        string csp = context.Response.Headers["Content-Security-Policy"].ToString();
        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Contains("script-src 'self' 'wasm-unsafe-eval' 'nonce-", csp, StringComparison.Ordinal);
        Assert.Contains("style-src 'self' 'nonce-", csp, StringComparison.Ordinal);
        Assert.Contains("style-src-attr 'unsafe-inline'", csp, StringComparison.Ordinal);
        Assert.Contains("http://127.0.0.1:3000", csp, StringComparison.Ordinal);
        Assert.Contains("<meta property=\"csp-nonce\" nonce=\"", rendered, StringComparison.Ordinal);
        Assert.Contains("<script nonce=\"", rendered, StringComparison.Ordinal);
        Assert.Contains("<style nonce=\"", rendered, StringComparison.Ordinal);
        Assert.Equal("private,no-store", context.Response.Headers.CacheControl.ToString());
        Assert.True(string.IsNullOrEmpty(context.Response.Headers.ContentEncoding.ToString()));
        Assert.True(string.IsNullOrEmpty(context.Response.Headers.ETag.ToString()));
        Assert.Equal(System.Text.Encoding.UTF8.GetByteCount(rendered), context.Response.ContentLength);
    }

    [Fact]
    public async Task TryServeAsync_PublicNonceHtmlHeadHit_WritesHeadersWithoutBody()
    {
        var store = CreateReadyEmptyStore();
        PublicHtmlArtifact html = PublicHotReadHtmlArtifactFactory.FromHtml(
            "<html><head></head><body><script>head()</script></body></html>",
            "public,max-age=60");
        store.PublishHtml("home", PublicPageId.Home, html);
        var context = CreateContext("/");
        context.Request.Method = HttpMethods.Head;
        context.Request.Headers.Accept = "text/html";

        await PublicHotReadFastPath.TryServeAsync(
            context,
            _ => throw new InvalidOperationException("next should not run"),
            store,
            new PublicHotReadOptions(),
            new PublicHotReadCounters());

        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Equal("private,no-store", context.Response.Headers.CacheControl.ToString());
        Assert.True(context.Response.ContentLength > html.Bytes.Length);
        Assert.True(string.IsNullOrEmpty(context.Response.Headers.ETag.ToString()));
        Assert.Empty(((MemoryStream)context.Response.Body).ToArray());
    }

    [Fact]
    public async Task TryServeAsync_PublicHtmlArticleHit_Returns304ForMatchingIfNoneMatch()
    {
        var store = CreateReadyEmptyStore();
        PublicHtmlArtifact html = CreateHtmlArtifact("article");
        string routeKey = PublicRouteIdentity.BuildArticleRouteKey(42);
        store.PublishHtml(routeKey, PublicPageId.ArticleDetail, html);
        var context = CreateContext("/article/42");
        context.Request.Headers.Accept = "text/html";
        context.Request.Headers.IfNoneMatch = html.ETag;

        await PublicHotReadFastPath.TryServeAsync(
            context,
            _ => throw new InvalidOperationException("next should not run"),
            store,
            new PublicHotReadOptions(),
            new PublicHotReadCounters());

        Assert.Equal(StatusCodes.Status304NotModified, context.Response.StatusCode);
        Assert.Equal(html.ETag, context.Response.Headers.ETag);
        Assert.Equal(0, context.Response.ContentLength);
        Assert.Empty(((MemoryStream)context.Response.Body).ToArray());
        AssertHtmlSecurityHeaders(context);
    }

    [Theory]
    [InlineData("GET")]
    [InlineData("HEAD")]
    public async Task TryServeAsync_PublicHtmlTrailingSlashHit_RedirectsBeforeServingArtifact(string method)
    {
        var store = CreateReadyEmptyStore();
        store.PublishHtml(
            PublicRouteIdentity.BuildArticleRouteKey(42),
            PublicPageId.ArticleDetail,
            CreateHtmlArtifact("article"));
        var context = CreateContext("/article/42/");
        context.Request.Method = method;
        context.Request.QueryString = new QueryString("?ref=canonical");
        context.Request.Headers.Accept = "text/html";

        await PublicHotReadFastPath.TryServeAsync(
            context,
            _ => throw new InvalidOperationException("next should not run"),
            store,
            new PublicHotReadOptions(),
            new PublicHotReadCounters());

        Assert.Equal(StatusCodes.Status301MovedPermanently, context.Response.StatusCode);
        Assert.Equal("/article/42?ref=canonical", context.Response.Headers.Location.ToString());
        Assert.Equal(0, context.Response.ContentLength);
        Assert.Empty(((MemoryStream)context.Response.Body).ToArray());
        Assert.False(context.Response.Headers.ContainsKey("X-Fsus-Public-Aot-Source"));
    }

    [Fact]
    public async Task TryServeAsync_PublicHtmlArchiveHeadHit_WritesHeadersWithoutBody()
    {
        var store = CreateReadyEmptyStore();
        PublicHtmlArtifact html = CreateHtmlArtifact("archive");
        store.PublishHtml("archive", PublicPageId.Archive, html);
        var context = CreateContext("/archive");
        context.Request.Method = HttpMethods.Head;
        context.Request.Headers.Accept = "text/html";

        await PublicHotReadFastPath.TryServeAsync(
            context,
            _ => throw new InvalidOperationException("next should not run"),
            store,
            new PublicHotReadOptions(),
            new PublicHotReadCounters());

        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Equal(html.Bytes.Length, context.Response.ContentLength);
        Assert.Equal(html.ETag, context.Response.Headers.ETag);
        Assert.Empty(((MemoryStream)context.Response.Body).ToArray());
        AssertHtmlSecurityHeaders(context);
    }

    [Fact]
    public async Task TryServeAsync_PublicHtmlMissingOrRemovedArtifact_FallsThroughToNormalPipeline()
    {
        var store = CreateReadyEmptyStore();
        store.PublishHtml("about", PublicPageId.About, CreateHtmlArtifact("about"));
        store.RemoveHtml("about");
        var context = CreateContext("/about");
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

        Assert.True(nextCalled);
        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Empty(((MemoryStream)context.Response.Body).ToArray());
    }

    [Fact]
    public async Task TryServeAsync_PublicHtmlNotReady_FallsThroughToNormalPipeline()
    {
        var context = CreateContext("/archive");
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
        Assert.False(context.Response.Headers.ContainsKey("Retry-After"));
    }

    [Fact]
    public async Task TryServeAsync_PublicHtmlBinaryAccept_Returns406BeforeNormalPipeline()
    {
        var store = CreateReadyEmptyStore();
        store.PublishHtml("home", PublicPageId.Home, CreateHtmlArtifact("home"));
        var context = CreateContext("/");
        context.Request.Headers.Accept = "application/octet-stream";
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
        Assert.Equal(StatusCodes.Status406NotAcceptable, context.Response.StatusCode);
        AssertNoStore(context);
    }

    [Fact]
    public async Task TryServeAsync_PublicHtmlUnsupportedPublicShape_FallsThrough()
    {
        var context = CreateContext("/article/abc");
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

        Assert.True(nextCalled);
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

    [Theory]
    [InlineData(StatusCodes.Status404NotFound, "/api/binary/article/0.aeds", "GET", "", "", true)]
    [InlineData(StatusCodes.Status405MethodNotAllowed, "/api/binary/category.aeds", "OPTIONS", "", "", true)]
    [InlineData(StatusCodes.Status406NotAcceptable, "/api/binary/article/42.aeds", "GET", "application/json", "", true)]
    [InlineData(StatusCodes.Status416RangeNotSatisfiable, "/api/binary/article/42.aeds", "GET", "", "bytes=0-1", true)]
    [InlineData(StatusCodes.Status503ServiceUnavailable, "/api/binary/article/42.aeds", "GET", "", "", false)]
    public async Task TryServeAsync_ErrorResponses_KeepStaticPublicSecurityHeaders(
        int statusCode,
        string path,
        string method,
        string accept,
        string range,
        bool storeReady)
    {
        var context = CreateContext(path);
        context.Request.Method = method;
        if (!string.IsNullOrEmpty(accept))
        {
            context.Request.Headers.Accept = accept;
        }

        if (!string.IsNullOrEmpty(range))
        {
            context.Request.Headers.Range = range;
        }

        bool nextCalled = false;

        await PublicHotReadFastPath.TryServeAsync(
            context,
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            },
            storeReady ? CreateReadyEmptyStore() : new PublicHotReadStore(),
            new PublicHotReadOptions(),
            new PublicHotReadCounters());

        Assert.False(nextCalled);
        Assert.Equal(statusCode, context.Response.StatusCode);
        AssertNoStore(context);
        AssertHtmlSecurityHeaders(context);
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
    public void FastPathRuntime_DoesNotReferenceRequestScopedOrIoHotPathDependencies()
    {
        string runtimeShape = RuntimeMetadataInspection.DescribeType(typeof(PublicHotReadFastPath));

        Assert.DoesNotContain("HttpContext.get_RequestServices", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("System.IO.File", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("IConnectionMultiplexer", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("IMemoryCache", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("System.Diagnostics.Activity", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("ILogger", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("IAedsEncoder", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("BinaryResults", runtimeShape, StringComparison.Ordinal);
    }

    [Fact]
    public void FastPathRuntime_UsesRouteClassifierInsteadOfMatcherChain()
    {
        MethodInfo featureFactory = typeof(PublicHotReadFastPath).GetMethod(
            "TryCreateRequestFeature",
            BindingFlags.Static | BindingFlags.NonPublic)!;
        MethodBase[] calls = ReadCalledMethods(featureFactory).ToArray();

        Assert.Contains(calls, static method => method.Name == "TryClassifyRoute");
        Assert.DoesNotContain(calls, static method => method.Name is
            "TryMatchArticleDetail" or
            "TryMatchArticleList" or
            "TryMatchArticleHot" or
            "TryMatchArticleFeatured" or
            "TryMatchArticleHtml");
    }

    [Theory]
    [InlineData("/api/binary/article/42.aeds", "ArticleDetail", "Binary", "article.detail")]
    [InlineData("/api/binary/article/list/home/1/10.aeds", "ArticleList", "Binary", "public.hot-read.binary")]
    [InlineData("/", "PublicHtml", "Html", "public.html.home")]
    public void RequestFeature_ClassifiesCandidateExactlyOnceAndCarriesImmutableRouteData(
        string path,
        string expectedKind,
        string expectedMedia,
        string expectedRiskRouteKey)
    {
        DefaultHttpContext context = CreateContext(path);

        Assert.True(PublicHotReadFastPath.TryCreateRequestFeatureForTests(context, out PublicHotReadRequestFeature? candidate));
        PublicHotReadRequestFeature feature = Assert.IsType<PublicHotReadRequestFeature>(candidate);

        Assert.Equal(1, feature.ClassificationCount);
        Assert.Equal(expectedKind, feature.RouteKind.ToString());
        Assert.Equal(expectedMedia, feature.MediaKind.ToString());
        Assert.Equal(expectedRiskRouteKey, feature.RiskRouteKey);
        Assert.True(feature.RequiresSecurityGate);
    }

    [Theory]
    [InlineData("/api/binary/system/info.aeds")]
    [InlineData("/api/binary/article/42/related.aeds")]
    [InlineData("/assets/app.js")]
    public void RequestFeature_DoesNotAttachToNormalOrDynamicRelatedRequests(string path)
    {
        DefaultHttpContext context = CreateContext(path);

        Assert.False(PublicHotReadFastPath.TryCreateRequestFeatureForTests(context, out PublicHotReadRequestFeature? feature));
        Assert.Null(feature);
    }

    [Fact]
    public void RequestFeature_NormalPathProbeDoesNotAllocateAfterWarmup()
    {
        DefaultHttpContext context = CreateContext("/assets/app.js");
        for (int i = 0; i < 1000; i++)
        {
            _ = PublicHotReadFastPath.TryCreateRequestFeatureForTests(context, out _);
        }

        long before = GC.GetAllocatedBytesForCurrentThread();
        bool attached = false;
        for (int i = 0; i < 1000; i++)
        {
            attached |= PublicHotReadFastPath.TryCreateRequestFeatureForTests(context, out _);
        }
        long allocated = GC.GetAllocatedBytesForCurrentThread() - before;

        Assert.False(attached);
        Assert.True(allocated <= 256, $"normal-path classifier probe allocated {allocated} bytes over 1000 requests");
    }

    [Fact]
    public async Task EarlyWriter_L0HitBypassesAllGenericMiddlewareSentinels()
    {
        var visited = new List<string>();
        RequestDelegate pipeline = BuildFastPathPipeline(
            CreateReadyStoreWithArticle(42, CreateFrame(AedsFrameType.ArticleDetail)),
            app =>
            {
                foreach (string stage in new[]
                {
                    "compression",
                    "output-cache",
                    "cors",
                    "antiforgery",
                    "authentication",
                    "banned-user",
                    "request-audit"
                })
                {
                    app.Use(next => async context =>
                    {
                        visited.Add(stage);
                        await next(context);
                    });
                }
            });
        DefaultHttpContext context = CreateContext("/api/binary/article/42.aeds");

        await pipeline(context);

        Assert.Empty(visited);
        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        PublicHotReadRequestFeature feature = Assert.IsType<PublicHotReadRequestFeature>(
            context.Features.Get<PublicHotReadRequestFeature>());
        Assert.Equal(1, feature.ClassificationCount);
    }

    [Fact]
    public async Task EarlyClassifier_AttachesStableRateAndRiskMetadataThenRestoresRoutingOnMiss()
    {
        Endpoint? observedEarlyEndpoint = null;
        Endpoint? observedFallbackEndpoint = new(static _ => Task.CompletedTask, new EndpointMetadataCollection(), "unset");
        var services = CreateFastPathServices(CreateReadyEmptyStore());
        var app = new ApplicationBuilder(services);
        app.UseFsusPublicHotReadClassifier();
        app.Use(async (context, next) =>
        {
            observedEarlyEndpoint = context.GetEndpoint();
            await next(context);
        });
        app.UseFsusPublicHotReadFastPath();
        app.UseFsusPublicHotReadFallbackRestore();
        app.Run(context =>
        {
            observedFallbackEndpoint = context.GetEndpoint();
            return Task.CompletedTask;
        });
        DefaultHttpContext context = CreateContext("/api/binary/article/42.aeds");
        context.RequestServices = services;

        await app.Build()(context);

        Endpoint endpoint = Assert.IsType<Endpoint>(observedEarlyEndpoint);
        Assert.Equal("public_read", Assert.IsType<EnableRateLimitingAttribute>(
            endpoint.Metadata.GetMetadata<EnableRateLimitingAttribute>()).PolicyName);
        Assert.Equal("article.detail", Assert.IsType<FsusBlog.Server.Infrastructure.Security.RiskActionEndpointMetadata>(
            endpoint.Metadata.GetMetadata<FsusBlog.Server.Infrastructure.Security.RiskActionEndpointMetadata>()).RouteKey);
        Assert.Null(observedFallbackEndpoint);
    }

    [Fact]
    public async Task EarlyRateLimiter_ConsumesPublicReadPolicyBeforeWriter()
    {
        ServiceProvider services = CreateFastPathServices(CreateReadyEmptyStore(), includeRateLimiter: true);
        var app = new ApplicationBuilder(services);
        app.UseFsusPublicHotReadClassifier();
        app.UseFsusPublicHotReadRateLimiter();
        bool terminalCalled = false;
        app.Run(context =>
        {
            terminalCalled = true;
            PublicHotReadEarlyPipelineState state = Assert.IsType<PublicHotReadEarlyPipelineState>(
                context.Features.Get<PublicHotReadEarlyPipelineState>());
            Assert.True(state.RateLimitEvaluated);
            return Task.CompletedTask;
        });
        DefaultHttpContext context = CreateContext("/api/binary/article/42.aeds");
        context.Connection.RemoteIpAddress = System.Net.IPAddress.Parse("203.0.113.7");
        context.RequestServices = services;

        await app.Build()(context);

        Assert.True(terminalCalled);
    }

    [Fact]
    public void CommonHeaderAndRouteProbe_AvoidsPerRequestAllocationsAfterWarmup()
    {
        PublicBinaryArtifact artifact = CreateCompressibleArtifact();
        StringValues acceptEncoding = new("gzip, br");
        StringValues accept = new("application/octet-stream,*/*");
        StringValues ifNoneMatch = new("\"detail\"");
        const string route = "/api/binary/article/list/home/1/10.aeds";

        _ = PublicHotReadFastPath.TrySelectBinaryVariantForTests(acceptEncoding, artifact, out _);
        _ = PublicHotReadFastPath.AcceptsArtifactForTests(accept, html: false);
        _ = PublicHotReadFastPath.MatchesIfNoneMatchForTests(ifNoneMatch, "\"detail\"");
        _ = PublicHotReadFastPath.TryClassifyRouteForTests(route, out _);
        for (int i = 0; i < 1000; i++)
        {
            _ = PublicHotReadFastPath.TrySelectBinaryVariantForTests(acceptEncoding, artifact, out _);
            _ = PublicHotReadFastPath.AcceptsArtifactForTests(accept, html: false);
            _ = PublicHotReadFastPath.MatchesIfNoneMatchForTests(ifNoneMatch, "\"detail\"");
            _ = PublicHotReadFastPath.TryClassifyRouteForTests(route, out _);
        }

        long before = GC.GetAllocatedBytesForCurrentThread();
        bool ok = true;
        for (int i = 0; i < 1000; i++)
        {
            ok &= PublicHotReadFastPath.TrySelectBinaryVariantForTests(acceptEncoding, artifact, out PublicBinaryArtifactVariant variant)
                && variant.ContentEncoding == "br"
                && PublicHotReadFastPath.AcceptsArtifactForTests(accept, html: false)
                && PublicHotReadFastPath.MatchesIfNoneMatchForTests(ifNoneMatch, "\"detail\"")
                && PublicHotReadFastPath.TryClassifyRouteForTests(route, out PublicHotReadRoute parsed)
                && parsed.ListKey.Equals(new PublicListKey(PublicListKind.Home, 0, 1, 10));
        }

        long allocated = GC.GetAllocatedBytesForCurrentThread() - before;
        Assert.True(ok);
        Assert.True(allocated <= 512, $"expected steady-state common hot path to stay allocation-free; measured {allocated} bytes over 1000 iterations");
    }

    [Fact]
    public void PreencodedArticleDetailHotPath_AvoidsPerRequestAllocationsAfterWarmup()
    {
        PublicBinaryArtifact artifact = CreateCompressibleArtifact();
        StringValues acceptEncoding = new("gzip, br");
        StringValues accept = new("application/octet-stream,*/*");
        StringValues ifNoneMatch = new("\"detail\"");
        const string route = "/api/binary/article/42.aeds";

        _ = PublicHotReadFastPath.TrySelectBinaryVariantForTests(acceptEncoding, artifact, out _);
        _ = PublicHotReadFastPath.AcceptsArtifactForTests(accept, html: false);
        _ = PublicHotReadFastPath.MatchesIfNoneMatchForTests(ifNoneMatch, "\"detail\"");
        _ = PublicHotReadFastPath.TryClassifyRouteForTests(route, out _);
        for (int i = 0; i < 1000; i++)
        {
            _ = PublicHotReadFastPath.TrySelectBinaryVariantForTests(acceptEncoding, artifact, out _);
            _ = PublicHotReadFastPath.AcceptsArtifactForTests(accept, html: false);
            _ = PublicHotReadFastPath.MatchesIfNoneMatchForTests(ifNoneMatch, "\"detail\"");
            _ = PublicHotReadFastPath.TryClassifyRouteForTests(route, out _);
        }

        long before = GC.GetAllocatedBytesForCurrentThread();
        bool ok = true;
        for (int i = 0; i < 1000; i++)
        {
            ok &= PublicHotReadFastPath.TrySelectBinaryVariantForTests(acceptEncoding, artifact, out PublicBinaryArtifactVariant variant)
                && variant.ContentEncoding == "br"
                && PublicHotReadFastPath.AcceptsArtifactForTests(accept, html: false)
                && PublicHotReadFastPath.MatchesIfNoneMatchForTests(ifNoneMatch, "\"detail\"")
                && PublicHotReadFastPath.TryClassifyRouteForTests(route, out PublicHotReadRoute parsed)
                && parsed.Kind == PublicHotReadRouteKind.ArticleDetail
                && parsed.ArticleId == 42;
        }

        long allocated = GC.GetAllocatedBytesForCurrentThread() - before;
        Assert.True(ok);
        Assert.True(allocated <= 512, $"expected steady-state preencoded ArticleDetail artifact hot path to stay allocation-free; measured {allocated} bytes over 1000 iterations");
    }

    [Fact]
    public void ProjectorRuntime_UsesDeterministicPublicListOrdering()
    {
        string runtimeShape = RuntimeMetadataInspection.DescribeMethodClosureContaining(
            typeof(PublicHotArtifactProjector),
            "ORDER BY a.createtime DESC, a.id DESC");

        Assert.Contains("ORDER BY a.createtime DESC, a.id DESC", runtimeShape, StringComparison.Ordinal);
    }

    private static IEnumerable<MethodBase> ReadCalledMethods(MethodInfo method)
    {
        byte[] il = method.GetMethodBody()?.GetILAsByteArray() ?? [];
        for (int offset = 0; offset <= il.Length - 5; offset++)
        {
            if (il[offset] is not (0x28 or 0x6F)) continue;
            MethodBase? called = null;
            try
            {
                called = method.Module.ResolveMethod(BitConverter.ToInt32(il, offset + 1));
            }
            catch (ArgumentException)
            {
            }
            if (called is not null) yield return called;
        }
    }

    private static DefaultHttpContext CreateContext(string path)
    {
        var context = new DefaultHttpContext();
        context.Request.Method = HttpMethods.Get;
        context.Request.Path = path;
        context.Response.Body = new MemoryStream();
        return context;
    }

    private static RequestDelegate BuildFastPathPipeline(PublicHotReadStore store, Action<IApplicationBuilder> addDownstream)
    {
        ServiceProvider services = CreateFastPathServices(store);
        var app = new ApplicationBuilder(services);
        app.UseFsusPublicHotReadClassifier();
        app.UseFsusPublicHotReadFastPath();
        addDownstream(app);
        app.Run(static _ => Task.CompletedTask);
        return app.Build();
    }

    private static ServiceProvider CreateFastPathServices(PublicHotReadStore store, bool includeRateLimiter = false)
    {
        IWebHostEnvironment environment = Substitute.For<IWebHostEnvironment>();
        environment.EnvironmentName.Returns(Environments.Production);
        var options = new PublicHotReadOptions();
        IOptionsMonitor<PublicHotReadOptions> optionsMonitor = Substitute.For<IOptionsMonitor<PublicHotReadOptions>>();
        optionsMonitor.CurrentValue.Returns(options);
        optionsMonitor.OnChange(Arg.Any<Action<PublicHotReadOptions, string?>>())
            .Returns(Substitute.For<IDisposable>());
        var services = new ServiceCollection();
        services.AddLogging();
        services
            .AddSingleton(store)
            .AddSingleton(new PublicHotReadCounters())
            .AddSingleton<IOptions<PublicHotReadOptions>>(Options.Create(options))
            .AddSingleton(optionsMonitor)
            .AddSingleton<PublicHotReadEarlyDataPlaneRuntimeState>()
            .AddSingleton(environment);
        if (includeRateLimiter)
        {
            services.AddRateLimiter(options => options.AddPolicy(
                "public_read",
                _ => RateLimitPartition.GetNoLimiter("unit")));
        }

        return services.BuildServiceProvider();
    }

    private static PublicHotReadStore CreateReadyEmptyStore()
    {
        var store = new PublicHotReadStore();
        store.Publish(PublicHotReadSnapshot.Empty);
        return store;
    }

    private static PublicHotReadStore CreateReadyStoreWithArticle(int articleId, byte[] frame)
        => CreateReadyStoreWithArticle(articleId, new PublicBinaryArtifact(frame, "\"detail\"", "public,max-age=60", 1, AedsFrameType.ArticleDetail));

    private static PublicHotReadStore CreateReadyStoreWithArticle(int articleId, PublicBinaryArtifact artifact)
    {
        var store = new PublicHotReadStore();
        var articles = new Dictionary<int, PublicBinaryArtifact>
        {
            [articleId] = artifact
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

    private static PublicBinaryArtifact CreateCompressibleArtifact()
    {
        var options = new PublicHotReadOptions { MinPrecompressedFrameBytes = 1 };
        byte[] payload = Enumerable.Repeat((byte)'a', 2048).ToArray();
        return PublicHotReadBinaryArtifactFactory.FromPayload(
            new AedsEncoder(),
            AedsFrameType.ArticleDetail,
            payload,
            "public,max-age=60",
            1,
            options);
    }

    private static byte[] CreateFrame(AedsFrameType frameType, byte[]? payload = null)
        => new AedsEncoder().Encode(frameType, payload ?? []);

    private static PublicHtmlArtifact CreateHtmlArtifact(string label)
        => PublicHotReadHtmlArtifactFactory.FromHtml(
            $"<!doctype html><html><body>{label} public hot read artifact</body></html>",
            "public,max-age=60");

    private static void AssertNoStore(DefaultHttpContext context)
    {
        Assert.Equal("no-store", context.Response.Headers.CacheControl);
        Assert.Equal("no-cache", context.Response.Headers.Pragma);
        Assert.Equal("0", context.Response.Headers.Expires);
        Assert.Equal("none", context.Response.Headers["Accept-Ranges"]);
    }

    private static void AssertHtmlSecurityHeaders(DefaultHttpContext context)
    {
        Assert.Equal("nosniff", context.Response.Headers["X-Content-Type-Options"]);
        Assert.Equal("strict-origin-when-cross-origin", context.Response.Headers["Referrer-Policy"]);
        Assert.Equal("camera=(), microphone=(), geolocation=(), browsing-topics=()", context.Response.Headers["Permissions-Policy"]);
        Assert.Equal("DENY", context.Response.Headers["X-Frame-Options"]);
        Assert.Equal("credentialless", context.Response.Headers["Cross-Origin-Embedder-Policy"]);
        Assert.Equal("same-origin", context.Response.Headers["Cross-Origin-Opener-Policy"]);
        Assert.Equal("same-origin", context.Response.Headers["Cross-Origin-Resource-Policy"]);
        Assert.Contains("default-src 'self'", context.Response.Headers["Content-Security-Policy"].ToString(), StringComparison.Ordinal);
    }

    private sealed class ReloadablePublicHotReadOptionsMonitor(PublicHotReadOptions current) : IOptionsMonitor<PublicHotReadOptions>
    {
        private Action<PublicHotReadOptions, string?>? _listener;

        public PublicHotReadOptions CurrentValue { get; private set; } = current;

        public PublicHotReadOptions Get(string? name) => CurrentValue;

        public IDisposable OnChange(Action<PublicHotReadOptions, string?> listener)
        {
            _listener = listener;
            return new CallbackDisposable(() => _listener = null);
        }

        public void Set(PublicHotReadOptions next)
        {
            CurrentValue = next;
            _listener?.Invoke(next, Options.DefaultName);
        }
    }

    private sealed class CallbackDisposable(Action dispose) : IDisposable
    {
        public void Dispose() => dispose();
    }
}
