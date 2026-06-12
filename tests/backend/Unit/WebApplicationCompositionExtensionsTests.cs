using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.Spa;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using System.Diagnostics;
using System.IO.Compression;
using System.Reflection;
using System.Text;

namespace FsusBlog.Server.Tests;

public sealed class WebApplicationCompositionExtensionsTests
{
    [Fact]
    public void ApplyCspNonceToHtml_AddsNonceToScriptStyleAndHeadMeta()
    {
        var context = new DefaultHttpContext();
        context.Items["__fsusblog_csp_nonce"] = "abc123";

        string html = "<html><head></head><body><script type=\"module\"></script><style>.a{}</style></body></html>";

        string rendered = WebApplicationCompositionExtensions.ApplyCspNonceToHtml(context, html);

        Assert.Contains("<head>\n    <meta property=\"csp-nonce\" nonce=\"abc123\" /></head>", rendered);
        Assert.Contains("<script nonce=\"abc123\" type=\"module\">", rendered);
        Assert.Contains("<style nonce=\"abc123\">", rendered);
    }

    [Fact]
    public void ApplyCspNonceToHtml_PreservesExistingNonceAndMeta()
    {
        var context = new DefaultHttpContext();
        context.Items["__fsusblog_csp_nonce"] = "new";

        string html = "<html><head><meta property=\"csp-nonce\" nonce=\"old\" /></head><body><script nonce=\"old\"></script></body></html>";

        string rendered = WebApplicationCompositionExtensions.ApplyCspNonceToHtml(context, html);

        Assert.Contains("<meta property=\"csp-nonce\" nonce=\"old\" />", rendered);
        Assert.Contains("<script nonce=\"old\"></script>", rendered);
        Assert.DoesNotContain("nonce=\"new\"", rendered);
    }

    [Theory]
    [InlineData("/search/index.core.0123456789abcdef.bin", true)]
    [InlineData("/search/index.recent.0123456789ABCDEF.bin", true)]
    [InlineData("/search/index.archive.0123456789abcdef.bin", true)]
    [InlineData("/search/index.body.0123456789abcdef.bin", true)]
    [InlineData("/search/index.core.01234.bin", false)]
    [InlineData("/search/index.other.0123456789abcdef.bin", false)]
    [InlineData("/search/index.core.0123456789abcdef.json", false)]
    public void IsImmutableSearchIndexAssetPath_MatchesFixedHashedShape(string path, bool expected)
    {
        Assert.Equal(expected, WebApplicationCompositionExtensions.IsImmutableSearchIndexAssetPath(path));
    }

    [Fact]
    public void HotPathCompositionSource_AvoidsRegexAndFullPageReplaceForStaticAndFallback()
    {
        string source = ReadCompositionSource();

        Assert.DoesNotContain("Regex.IsMatch", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Replace(\"</head>\"", source, StringComparison.Ordinal);
        Assert.Contains("SpaHtmlByteTemplate", source, StringComparison.Ordinal);
    }

    [Fact]
    public void SpaFallbackHeadInjectionCache_ReusesRouteBytesForSameVersionAndRoute()
    {
        WebApplicationCompositionExtensions.ResetSpaHeadInjectionCacheForTests();
        string[] preloads =
        [
            "/assets/route-admin.abc.js",
            "/assets/route-admin.abc.css"
        ];

        ReadOnlyMemory<byte> first = WebApplicationCompositionExtensions.GetRoutePreloadHeadInjectionForTests(
            "asset-v1",
            "/admin/articles",
            preloads);
        ReadOnlyMemory<byte> second = WebApplicationCompositionExtensions.GetRoutePreloadHeadInjectionForTests(
            "asset-v1",
            "/admin/articles",
            ["/assets/should-not-rebuild.js"]);

        string html = Encoding.UTF8.GetString(second.Span);
        Assert.Equal(Encoding.UTF8.GetString(first.Span), html);
        Assert.Contains("<link rel=\"modulepreload\" href=\"/assets/route-admin.abc.js\">", html, StringComparison.Ordinal);
        Assert.Contains("<link rel=\"stylesheet\" href=\"/assets/route-admin.abc.css\">", html, StringComparison.Ordinal);
        var stats = WebApplicationCompositionExtensions.GetSpaHeadInjectionCacheStatsForTests();
        Assert.Equal(1, stats.EntryCount);
        Assert.Equal(1, stats.BuildCount);
        Assert.Equal(1, stats.HitCount);
    }

    [Fact]
    public void SpaFallbackHeadInjectionCache_MissesWhenAssetVersionChanges()
    {
        WebApplicationCompositionExtensions.ResetSpaHeadInjectionCacheForTests();

        ReadOnlyMemory<byte> first = WebApplicationCompositionExtensions.GetRoutePreloadHeadInjectionForTests(
            "asset-v1",
            "/login",
            ["/assets/auth.v1.js"]);
        ReadOnlyMemory<byte> second = WebApplicationCompositionExtensions.GetRoutePreloadHeadInjectionForTests(
            "asset-v2",
            "/login",
            ["/assets/auth.v2.js"]);

        Assert.Contains("auth.v1.js", Encoding.UTF8.GetString(first.Span), StringComparison.Ordinal);
        Assert.Contains("auth.v2.js", Encoding.UTF8.GetString(second.Span), StringComparison.Ordinal);
        var stats = WebApplicationCompositionExtensions.GetSpaHeadInjectionCacheStatsForTests();
        Assert.Equal(2, stats.EntryCount);
        Assert.Equal(2, stats.BuildCount);
        Assert.Equal(0, stats.HitCount);
    }

    [Fact]
    public void SpaFallbackHeadInjectionCache_ReusesPublicAssetSetBytes()
    {
        WebApplicationCompositionExtensions.ResetSpaHeadInjectionCacheForTests();
        var assets = new SpaAssetSet(
            "/assets/fsus-spa-entry.js",
            ["/assets/public-page.abc.css"],
            ["/assets/entry-runtime.abc.js"],
            "asset-v1",
            UsesSourceAssets: false);

        ReadOnlyMemory<byte> first = WebApplicationCompositionExtensions.GetPublicAssetHeadInjectionForTests("home", assets);
        ReadOnlyMemory<byte> second = WebApplicationCompositionExtensions.GetPublicAssetHeadInjectionForTests("home", assets);

        string html = Encoding.UTF8.GetString(second.Span);
        Assert.Equal(Encoding.UTF8.GetString(first.Span), html);
        Assert.Contains("<link rel=\"modulepreload\" crossorigin href=\"/assets/entry-runtime.abc.js\">", html, StringComparison.Ordinal);
        Assert.Contains("<link rel=\"stylesheet\" href=\"/assets/public-page.abc.css\">", html, StringComparison.Ordinal);
        var stats = WebApplicationCompositionExtensions.GetSpaHeadInjectionCacheStatsForTests();
        Assert.Equal(1, stats.EntryCount);
        Assert.Equal(1, stats.BuildCount);
        Assert.Equal(1, stats.HitCount);
    }

    [Fact]
    public void SpaFallbackHeadInjectionCache_DoesNotCacheEmptyPreloadSet()
    {
        WebApplicationCompositionExtensions.ResetSpaHeadInjectionCacheForTests();

        ReadOnlyMemory<byte> headInjection = WebApplicationCompositionExtensions.GetRoutePreloadHeadInjectionForTests(
            "asset-v1",
            "/plain",
            []);

        Assert.True(headInjection.IsEmpty);
        var stats = WebApplicationCompositionExtensions.GetSpaHeadInjectionCacheStatsForTests();
        Assert.Equal(0, stats.EntryCount);
        Assert.Equal(0, stats.BuildCount);
        Assert.Equal(0, stats.HitCount);
    }

    [Fact]
    public async Task SpaFallbackHeadInjectionCache_DoesNotCacheCspNonce()
    {
        WebApplicationCompositionExtensions.ResetSpaHeadInjectionCacheForTests();
        ReadOnlyMemory<byte> headInjection = WebApplicationCompositionExtensions.GetRoutePreloadHeadInjectionForTests(
            "asset-v1",
            "/admin",
            ["/assets/route-admin.abc.js"]);

        string first = await WebApplicationCompositionExtensions.RenderSpaHtmlForTestsAsync(
            "<html><head><script type=\"module\"></script></head><body></body></html>",
            headInjection,
            "nonce-a");
        string second = await WebApplicationCompositionExtensions.RenderSpaHtmlForTestsAsync(
            "<html><head><script type=\"module\"></script></head><body></body></html>",
            headInjection,
            "nonce-b");

        string cachedHead = Encoding.UTF8.GetString(headInjection.Span);
        Assert.DoesNotContain("nonce-a", cachedHead, StringComparison.Ordinal);
        Assert.DoesNotContain("nonce-b", cachedHead, StringComparison.Ordinal);
        Assert.Contains("nonce=\"nonce-a\"", first, StringComparison.Ordinal);
        Assert.Contains("nonce=\"nonce-b\"", second, StringComparison.Ordinal);
        Assert.DoesNotContain("nonce=\"nonce-a\"", second, StringComparison.Ordinal);
    }

    [Fact]
    public async Task SpaFallbackHtmlResponse_CompressesBrotliAndPreservesNonceAndHeadInjection()
    {
        DefaultHttpContext context = CreateSpaFallbackContext(HttpMethods.Get, "br, gzip");
        context.Items["__fsusblog_csp_nonce"] = "spa-nonce";
        ReadOnlyMemory<byte> headInjection = Encoding.UTF8.GetBytes("<link rel=\"modulepreload\" href=\"/assets/route-admin.js\">\n");

        await WebApplicationCompositionExtensions.WriteSpaHtmlResponseForTestsAsync(
            context,
            CreateTestEnv(),
            CreateLargeSpaTemplate("brotli"),
            headInjection);

        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Equal("br", context.Response.Headers["Content-Encoding"].ToString());
        Assert.Equal("Accept-Encoding", context.Response.Headers["Vary"].ToString());
        Assert.Equal(context.Response.Body.Length, context.Response.ContentLength);

        string rendered = DecodeSpaFallbackBody(context);
        Assert.Contains("nonce=\"spa-nonce\"", rendered, StringComparison.Ordinal);
        Assert.Contains("<meta property=\"csp-nonce\" nonce=\"spa-nonce\" />", rendered, StringComparison.Ordinal);
        Assert.Contains("<link rel=\"modulepreload\" href=\"/assets/route-admin.js\">", rendered, StringComparison.Ordinal);
        Assert.True(context.Response.Body.Length < Encoding.UTF8.GetByteCount(rendered));
    }

    [Fact]
    public async Task SpaFallbackHtmlResponse_HonorsGzipNegotiation()
    {
        DefaultHttpContext context = CreateSpaFallbackContext(HttpMethods.Get, "gzip;q=1, br;q=0, identity;q=0");

        await WebApplicationCompositionExtensions.WriteSpaHtmlResponseForTestsAsync(
            context,
            CreateTestEnv(),
            CreateLargeSpaTemplate("gzip"),
            ReadOnlyMemory<byte>.Empty);

        Assert.Equal("gzip", context.Response.Headers["Content-Encoding"].ToString());
        Assert.Equal("Accept-Encoding", context.Response.Headers["Vary"].ToString());
        Assert.Equal(context.Response.Body.Length, context.Response.ContentLength);
        Assert.Contains("gzip fallback payload", DecodeSpaFallbackBody(context), StringComparison.Ordinal);
    }

    [Fact]
    public async Task SpaFallbackHtmlResponse_HeadNegotiatesCompressionWithoutWritingBody()
    {
        DefaultHttpContext context = CreateSpaFallbackContext(HttpMethods.Head, "br, gzip");

        await WebApplicationCompositionExtensions.WriteSpaHtmlResponseForTestsAsync(
            context,
            CreateTestEnv(),
            CreateLargeSpaTemplate("head"),
            ReadOnlyMemory<byte>.Empty);

        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Equal("br", context.Response.Headers["Content-Encoding"].ToString());
        Assert.Equal("Accept-Encoding", context.Response.Headers["Vary"].ToString());
        Assert.True(context.Response.ContentLength > 0);
        Assert.Equal(0, context.Response.Body.Length);
    }

    [Fact]
    public async Task SpaFallbackHtmlResponse_SkipsCompressionForSmallHtml()
    {
        DefaultHttpContext context = CreateSpaFallbackContext(HttpMethods.Get, "br, gzip");

        await WebApplicationCompositionExtensions.WriteSpaHtmlResponseForTestsAsync(
            context,
            CreateTestEnv(),
            "<html><head><script type=\"module\"></script></head><body>tiny</body></html>",
            ReadOnlyMemory<byte>.Empty);

        Assert.True(string.IsNullOrEmpty(context.Response.Headers["Content-Encoding"].ToString()));
        Assert.Equal("Accept-Encoding", context.Response.Headers["Vary"].ToString());
        Assert.Equal(context.Response.Body.Length, context.Response.ContentLength);
        string rendered = Encoding.UTF8.GetString(((MemoryStream)context.Response.Body).ToArray());
        Assert.Contains("<body>tiny</body>", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public async Task PublicAotHtmlFastPath_PrefersBrotliVariantAndWritesPreencodedBytes()
    {
        string html = string.Concat("<!doctype html><html><body>", new string('a', 4096), "</body></html>");
        PublicAotHtmlArtifact artifact = PublicAotHtmlArtifactFactory.FromHtml(
            html,
            "renderer-v2",
            "frontend-v2",
            minPrecompressedHtmlBytes: 1);
        var entry = CreateAotEntry(html, artifact);
        DefaultHttpContext context = CreateAotContext("br, gzip");

        await WebApplicationCompositionExtensions.WritePublicAotHtmlEntryForTestsAsync(context, CreateTestEnv(), entry);

        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Equal("br", context.Response.Headers["Content-Encoding"].ToString());
        Assert.Equal("Accept-Encoding", context.Response.Headers["Vary"].ToString());
        Assert.Equal(artifact.BrotliETag, context.Response.Headers["ETag"].ToString());
        Assert.Equal(artifact.BrotliBytes.Length, context.Response.ContentLength);
        Assert.Equal(artifact.BrotliBytes.ToArray(), ((MemoryStream)context.Response.Body).ToArray());
    }

    [Fact]
    public async Task PublicAotHtmlFastPath_ReturnsNotModifiedForVariantEtag()
    {
        string html = string.Concat("<!doctype html><html><body>", new string('b', 4096), "</body></html>");
        PublicAotHtmlArtifact artifact = PublicAotHtmlArtifactFactory.FromHtml(
            html,
            "renderer-v2",
            "frontend-v2",
            minPrecompressedHtmlBytes: 1);
        var entry = CreateAotEntry(html, artifact);
        DefaultHttpContext context = CreateAotContext("gzip;q=1, identity;q=0");
        context.Request.Headers.IfNoneMatch = artifact.GzipETag;

        await WebApplicationCompositionExtensions.WritePublicAotHtmlEntryForTestsAsync(context, CreateTestEnv(), entry);

        Assert.Equal(StatusCodes.Status304NotModified, context.Response.StatusCode);
        Assert.Equal("gzip", context.Response.Headers["Content-Encoding"].ToString());
        Assert.Equal(artifact.GzipETag, context.Response.Headers["ETag"].ToString());
        Assert.Equal(0, context.Response.ContentLength);
        Assert.Equal(0, context.Response.Body.Length);
    }

    [Fact]
    public async Task PublicAotHtmlFastPath_FallsBackToIdentityWhenCompressedVariantIsMissing()
    {
        const string html = "<!doctype html><html><body>tiny</body></html>";
        PublicAotHtmlArtifact artifact = PublicAotHtmlArtifactFactory.FromHtml(
            html,
            "renderer-v2",
            "frontend-v2",
            minPrecompressedHtmlBytes: 1024);
        var entry = CreateAotEntry(html, artifact);
        DefaultHttpContext context = CreateAotContext("br, gzip");

        await WebApplicationCompositionExtensions.WritePublicAotHtmlEntryForTestsAsync(context, CreateTestEnv(), entry);

        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.True(string.IsNullOrEmpty(context.Response.Headers["Content-Encoding"].ToString()));
        Assert.Equal(artifact.ETag, context.Response.Headers["ETag"].ToString());
        Assert.Equal(Encoding.UTF8.GetBytes(html), ((MemoryStream)context.Response.Body).ToArray());
    }

    [Fact]
    public async Task PublicAotHtmlSlowPath_PreservesCspNonceMutationAndSkipsVariantEtag()
    {
        const string html = "<html><head></head><body><script type=\"module\"></script></body></html>";
        PublicAotHtmlArtifact artifact = PublicAotHtmlArtifactFactory.FromHtml(
            html,
            "renderer-v2",
            "frontend-v2",
            minPrecompressedHtmlBytes: 1);
        var entry = CreateAotEntry(html, artifact);
        DefaultHttpContext context = CreateAotContext("br, gzip");

        await WebApplicationCompositionExtensions.WritePublicAotHtmlEntryForTestsAsync(context, CreateTestEnv(), entry);

        string rendered = Encoding.UTF8.GetString(((MemoryStream)context.Response.Body).ToArray());
        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.True(artifact.RequiresCspNonceMutation);
        Assert.Contains("<meta property=\"csp-nonce\" nonce=\"", rendered, StringComparison.Ordinal);
        Assert.Contains("<script nonce=\"", rendered, StringComparison.Ordinal);
        Assert.True(string.IsNullOrEmpty(context.Response.Headers["Content-Encoding"].ToString()));
        Assert.True(string.IsNullOrEmpty(context.Response.Headers["ETag"].ToString()));
    }

    [Fact]
    public void PublicAotHtmlFastPath_SourceAvoidsStringContentAndPerRequestUtf8Encode()
    {
        string source = ReadCompositionSource();
        string fastPath = ExtractPublicAotFastPath(source);

        Assert.Contains("BodyWriter.WriteAsync(variant.Bytes", fastPath, StringComparison.Ordinal);
        Assert.DoesNotContain("TypedResults.Content", fastPath, StringComparison.Ordinal);
        Assert.DoesNotContain("Encoding.UTF8.GetBytes", fastPath, StringComparison.Ordinal);
    }

    [Fact]
    public async Task PublicAotHtmlFastPath_ProbeCapturesBytesLatencyAndAllocationShape()
    {
        string html = string.Concat("<!doctype html><html><body>", string.Concat(Enumerable.Repeat("public-aot-byte-artifact ", 512)), "</body></html>");
        PublicAotHtmlArtifact artifact = PublicAotHtmlArtifactFactory.FromHtml(
            html,
            "renderer-v2",
            "frontend-v2",
            minPrecompressedHtmlBytes: 1);
        var entry = CreateAotEntry(html, artifact);

        DefaultHttpContext identity = CreateAotContext("identity");
        await WebApplicationCompositionExtensions.WritePublicAotHtmlEntryForTestsAsync(identity, CreateTestEnv(), entry);
        DefaultHttpContext brotli = CreateAotContext("br, gzip");
        await WebApplicationCompositionExtensions.WritePublicAotHtmlEntryForTestsAsync(brotli, CreateTestEnv(), entry);
        DefaultHttpContext gzip = CreateAotContext("gzip;q=1, identity;q=0");
        await WebApplicationCompositionExtensions.WritePublicAotHtmlEntryForTestsAsync(gzip, CreateTestEnv(), entry);

        long identityBytes = identity.Response.Body.Length;
        long brotliBytes = brotli.Response.Body.Length;
        long gzipBytes = gzip.Response.Body.Length;
        Assert.Equal(artifact.Utf8Bytes.Length, identityBytes);
        Assert.Equal(artifact.BrotliBytes.Length, brotliBytes);
        Assert.Equal(artifact.GzipBytes.Length, gzipBytes);
        Assert.True(brotliBytes < identityBytes);
        Assert.True(gzipBytes < identityBytes);

        const int samples = 32;
        long[] elapsedTicks = new long[samples];
        long allocBefore = GC.GetTotalAllocatedBytes(precise: true);
        long totalBytes = 0;
        for (int i = 0; i < samples; i++)
        {
            DefaultHttpContext context = CreateAotContext("br, gzip");
            long started = Stopwatch.GetTimestamp();
            await WebApplicationCompositionExtensions.WritePublicAotHtmlEntryForTestsAsync(context, CreateTestEnv(), entry);
            elapsedTicks[i] = Stopwatch.GetTimestamp() - started;
            totalBytes += context.Response.Body.Length;
        }

        long allocAfter = GC.GetTotalAllocatedBytes(precise: true);
        Assert.True(allocAfter >= allocBefore);
        Assert.True(PercentileTicks(elapsedTicks, 99) >= 0);
        Assert.Equal(artifact.BrotliBytes.Length * samples, totalBytes);
    }

    [Fact]
    public void StaticNoCacheEntryAssets_PreserveValidatorsForConditionalRequests()
    {
        string source = ReadCompositionSource();
        string branch = ExtractStaticNoCacheEntryBranch(source);

        Assert.Contains("headers[\"Cache-Control\"] = \"no-cache\";", branch, StringComparison.Ordinal);
        Assert.Contains("/sw.js", branch, StringComparison.Ordinal);
        Assert.Contains("/search/index.manifest.aeds", branch, StringComparison.Ordinal);
        Assert.Contains("/search/index.bin", branch, StringComparison.Ordinal);
        Assert.Contains("/favicon.svg", branch, StringComparison.Ordinal);
        Assert.Contains("/manifest.webmanifest", branch, StringComparison.Ordinal);
        Assert.DoesNotContain("headers.Remove(\"ETag\")", branch, StringComparison.Ordinal);
        Assert.DoesNotContain("headers.Remove(\"Last-Modified\")", branch, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("/sw.js", "self.__fsus_test = 1;")]
    [InlineData("/search/index.manifest.aeds", "manifest-v1")]
    [InlineData("/search/index.bin", "legacy-index-v1")]
    [InlineData("/favicon.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>")]
    [InlineData("/manifest.webmanifest", "{\"name\":\"FsusBlog\"}")]
    public async Task StaticNoCacheEntryAssets_ReturnNotModifiedWhenEtagMatches(string path, string contents)
    {
        using var site = StaticAssetTestSite.Create();
        site.Write(path, contents);

        DefaultHttpContext first = await site.GetAsync(path);

        Assert.Equal(StatusCodes.Status200OK, first.Response.StatusCode);
        Assert.Equal("no-cache", first.Response.Headers["Cache-Control"].ToString());
        string etag = first.Response.Headers["ETag"].ToString();
        Assert.False(string.IsNullOrWhiteSpace(etag));
        Assert.False(string.IsNullOrWhiteSpace(first.Response.Headers["Last-Modified"].ToString()));

        DefaultHttpContext second = await site.GetAsync(path, etag);

        Assert.Equal(StatusCodes.Status304NotModified, second.Response.StatusCode);
        Assert.Equal(0, second.Response.Body.Length);
    }

    [Fact]
    public void ImmutableStaticAssets_KeepLongCacheWithoutValidators()
    {
        string source = ReadCompositionSource();
        int immutableBranchStart = source.IndexOf("if (requestPath.StartsWith(\"/search/patches/\"", StringComparison.Ordinal);

        Assert.True(immutableBranchStart >= 0, "Unable to locate immutable search asset branch.");

        string immutableBranch = source[immutableBranchStart..];
        Assert.Contains("headers[\"Cache-Control\"] = \"public,max-age=31536000,immutable\";", immutableBranch, StringComparison.Ordinal);
        Assert.Contains("headers.Remove(\"ETag\")", immutableBranch, StringComparison.Ordinal);
        Assert.Contains("headers.Remove(\"Last-Modified\")", immutableBranch, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ImmutableSearchShardKeepsLongCacheAndRemovesValidators()
    {
        using var site = StaticAssetTestSite.Create();
        site.Write("/search/index.core.0123456789abcdef.bin", "core-shard");

        DefaultHttpContext result = await site.GetAsync("/search/index.core.0123456789abcdef.bin");

        Assert.Equal(StatusCodes.Status200OK, result.Response.StatusCode);
        Assert.Equal("public,max-age=31536000,immutable", result.Response.Headers["Cache-Control"].ToString());
        Assert.True(string.IsNullOrEmpty(result.Response.Headers["ETag"].ToString()));
        Assert.True(string.IsNullOrEmpty(result.Response.Headers["Last-Modified"].ToString()));
    }

    private static string FindRepoRoot()
    {
        string current = AppContext.BaseDirectory;
        while (!string.IsNullOrWhiteSpace(current))
        {
            if (File.Exists(Path.Combine(current, "FsusBlog.slnx")))
            {
                return current;
            }

            DirectoryInfo? parent = Directory.GetParent(current);
            if (parent is null)
            {
                break;
            }

            current = parent.FullName;
        }

        throw new DirectoryNotFoundException("Unable to locate repository root.");
    }

    private static string ReadCompositionSource()
    {
        return File.ReadAllText(Path.Combine(
            FindRepoRoot(),
            "src",
            "backend",
            "Infrastructure",
            "Bootstrap",
            "WebApplicationCompositionExtensions.cs"));
    }

    private static string ExtractStaticNoCacheEntryBranch(string source)
    {
        int branchStart = source.IndexOf("if (string.Equals(requestPath, \"/sw.js\"", StringComparison.Ordinal);
        int branchEnd = source.IndexOf("if (requestPath.StartsWith(\"/search/patches/\"", branchStart, StringComparison.Ordinal);

        Assert.True(branchStart >= 0, "Unable to locate no-cache static entry branch.");
        Assert.True(branchEnd > branchStart, "Unable to locate end of no-cache static entry branch.");

        return source[branchStart..branchEnd];
    }

    private static string ExtractPublicAotFastPath(string source)
    {
        int branchStart = source.IndexOf("private static async Task WritePublicAotHtmlEntryAsync", StringComparison.Ordinal);
        int branchEnd = source.IndexOf("private static async Task WritePublicAotHtmlSlowPathAsync", branchStart, StringComparison.Ordinal);

        Assert.True(branchStart >= 0, "Unable to locate Public AOT HTML write branch.");
        Assert.True(branchEnd > branchStart, "Unable to locate Public AOT HTML slow-path branch.");

        return source[branchStart..branchEnd];
    }

    private static PublicAotCacheEntry CreateAotEntry(string html, PublicAotHtmlArtifact artifact)
        => new()
        {
            CacheKey = "public:aot:v2:doc:1:home",
            RouteKey = "home",
            PageId = PublicPageId.Home,
            Source = PublicAotWriteSource.ServerSsrBackfill,
            GeneratedAtUtc = DateTimeOffset.UtcNow.AddSeconds(-1),
            ExpiresAtUtc = DateTimeOffset.UtcNow.AddMinutes(10),
            RendererVersion = artifact.RendererVersion,
            FrontendAssetVersion = artifact.FrontendAssetVersion,
            Value = html,
            Document = artifact
        };

    private static DefaultHttpContext CreateAotContext(string acceptEncoding)
    {
        var context = new DefaultHttpContext();
        context.Request.Method = HttpMethods.Get;
        context.Request.Path = "/";
        context.Request.Headers.AcceptEncoding = acceptEncoding;
        context.Response.Body = new MemoryStream();
        return context;
    }

    private static DefaultHttpContext CreateSpaFallbackContext(string method, string acceptEncoding)
    {
        var context = new DefaultHttpContext();
        context.Request.Method = method;
        context.Request.Path = "/user/manage";
        context.Request.Headers.AcceptEncoding = acceptEncoding;
        context.Response.Body = new MemoryStream();
        return context;
    }

    private static string CreateLargeSpaTemplate(string marker)
        => string.Concat(
            "<!doctype html><html><head><script type=\"module\"></script></head><body><div id=\"app\">",
            string.Concat(Enumerable.Repeat($"<p>{marker} fallback payload</p>", 320)),
            "</div></body></html>");

    private static string DecodeSpaFallbackBody(DefaultHttpContext context)
    {
        byte[] bytes = ((MemoryStream)context.Response.Body).ToArray();
        using var input = new MemoryStream(bytes);
        string encoding = context.Response.Headers["Content-Encoding"].ToString();
        using Stream decoded = encoding switch
        {
            "br" => new BrotliStream(input, CompressionMode.Decompress),
            "gzip" => new GZipStream(input, CompressionMode.Decompress),
            _ => input
        };
        using var reader = new StreamReader(decoded, Encoding.UTF8);
        return reader.ReadToEnd();
    }

    private static IWebHostEnvironment CreateTestEnv()
        => new TestWebHostEnvironment(Path.GetTempPath(), new NullFileProvider());

    private static long PercentileTicks(long[] values, int percentile)
    {
        Array.Sort(values);
        int index = (int)Math.Ceiling(values.Length * (percentile / 100d)) - 1;
        return values[Math.Clamp(index, 0, values.Length - 1)];
    }

    private sealed class StaticAssetTestSite : IDisposable
    {
        private static readonly Action<StaticFileResponseContext> StaticAssetResponseCallback =
            CreateStaticAssetResponseCallback();

        private readonly string _root;
        private readonly PhysicalFileProvider _fileProvider;
        private readonly StaticFileMiddleware _middleware;

        private StaticAssetTestSite(string root)
        {
            _root = root;
            Directory.CreateDirectory(root);
            _fileProvider = new PhysicalFileProvider(root);
            var contentTypeProvider = new FileExtensionContentTypeProvider();
            contentTypeProvider.Mappings[".aeds"] = "application/octet-stream";
            contentTypeProvider.Mappings[".bin"] = "application/octet-stream";
            contentTypeProvider.Mappings[".webmanifest"] = "application/manifest+json";
            var options = Options.Create(new StaticFileOptions
            {
                FileProvider = _fileProvider,
                ContentTypeProvider = contentTypeProvider,
                OnPrepareResponse = StaticAssetResponseCallback
            });

            _middleware = new StaticFileMiddleware(
                _ => Task.CompletedTask,
                new TestWebHostEnvironment(root, _fileProvider),
                options,
                NullLoggerFactory.Instance);
        }

        public static StaticAssetTestSite Create()
        {
            return new StaticAssetTestSite(Path.Combine(Path.GetTempPath(), $"fsus-static-{Guid.NewGuid():N}"));
        }

        public void Write(string requestPath, string contents)
        {
            string relativePath = requestPath.TrimStart('/');
            string filePath = Path.Combine(_root, relativePath);
            Directory.CreateDirectory(Path.GetDirectoryName(filePath)!);
            File.WriteAllBytes(filePath, Encoding.UTF8.GetBytes(contents));
        }

        public async Task<DefaultHttpContext> GetAsync(string path, string? ifNoneMatch = null)
        {
            var context = new DefaultHttpContext();
            context.Request.Method = HttpMethods.Get;
            context.Request.Path = path;
            context.Response.Body = new MemoryStream();
            if (!string.IsNullOrWhiteSpace(ifNoneMatch))
            {
                context.Request.Headers["If-None-Match"] = ifNoneMatch;
            }

            await _middleware.Invoke(context);
            return context;
        }

        public void Dispose()
        {
            _fileProvider.Dispose();
            Directory.Delete(_root, recursive: true);
        }

        private static Action<StaticFileResponseContext> CreateStaticAssetResponseCallback()
        {
            MethodInfo? method = typeof(WebApplicationCompositionExtensions).GetMethod(
                "PrepareStaticAssetResponse",
                BindingFlags.NonPublic | BindingFlags.Static);
            if (method is null)
            {
                throw new MissingMethodException(
                    typeof(WebApplicationCompositionExtensions).FullName,
                    "PrepareStaticAssetResponse");
            }

            return ctx => method.Invoke(null, [ctx]);
        }
    }

    private sealed class TestWebHostEnvironment(string root, IFileProvider fileProvider) : IWebHostEnvironment
    {
        public string ApplicationName { get; set; } = "FsusBlog.Server.Tests";
        public IFileProvider ContentRootFileProvider { get; set; } = fileProvider;
        public string ContentRootPath { get; set; } = root;
        public string EnvironmentName { get; set; } = "Production";
        public string WebRootPath { get; set; } = root;
        public IFileProvider WebRootFileProvider { get; set; } = fileProvider;
    }
}
