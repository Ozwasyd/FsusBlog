using System.Buffers;
using System.Diagnostics;
using System.Reflection;
using System.Text;

using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Infrastructure.Spa;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
namespace FsusBlog.Server.Tests;

public sealed class WebApplicationCompositionExtensionsTests
{
    [Fact]
    public void CspNonceUtf8Template_AddsNonceToScriptStyleAndHeadMeta()
    {
        string html = "<html><head></head><body><script type=\"module\"></script><style>.a{}</style></body></html>";
        CspNonceUtf8Template template = Assert.IsType<CspNonceUtf8Template>(
            CspNonceUtf8Template.Compile(html, "artifact:test"));
        string rendered = Encoding.UTF8.GetString(RenderTemplate(template, "abc123"u8));

        Assert.Contains("<head>\n    <meta property=\"csp-nonce\" nonce=\"abc123\" /></head>", rendered);
        Assert.Contains("<script nonce=\"abc123\" type=\"module\">", rendered);
        Assert.Contains("<style nonce=\"abc123\">", rendered);
        Assert.Equal(3, template.SlotCount);
    }

    [Fact]
    public void CspNonceUtf8Template_RejectsPreRenderedNonceAndMeta()
    {
        string html = "<html><head><meta property=\"csp-nonce\" nonce=\"old\" /></head><body><script nonce=\"old\"></script></body></html>";

        InvalidOperationException exception = Assert.Throws<InvalidOperationException>(
            () => CspNonceUtf8Template.Compile(html, "artifact:malicious"));
        Assert.Contains("nonce", exception.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void EnsureCspNonce_GeneratesUrlSafeBase64Nonce()
    {
        for (int i = 0; i < 16; i++)
        {
            var context = new DefaultHttpContext();
            string nonce = PublicWebRuntime.EnsureCspNonce(context);

            Assert.DoesNotContain("+", nonce, StringComparison.Ordinal);
            Assert.DoesNotContain("/", nonce, StringComparison.Ordinal);
            Assert.DoesNotContain("=", nonce, StringComparison.Ordinal);
            Assert.Equal(nonce, QueryHelpers.ParseQuery($"?nonce={nonce}")["nonce"].ToString());
        }
    }

    [Fact]
    public void GeneratedCspNonce_MatchesHeaderAndInlineScript()
    {
        var context = new DefaultHttpContext();
        string nonce = PublicWebRuntime.EnsureCspNonce(context);
        string csp = PublicWebRuntime.BuildHtmlCsp(isDevelopment: false, nonce);
        string html = "<html><head></head><body><script type=\"module\"></script></body></html>";

        CspNonceUtf8Template template = Assert.IsType<CspNonceUtf8Template>(
            CspNonceUtf8Template.Compile(html, "artifact:csp-match"));
        string rendered = Encoding.UTF8.GetString(RenderTemplate(template, Encoding.UTF8.GetBytes(nonce)));

        Assert.Contains($"'nonce-{nonce}'", csp, StringComparison.Ordinal);
        Assert.Contains("script-src 'self' 'wasm-unsafe-eval'", csp, StringComparison.Ordinal);
        Assert.Contains("style-src-attr 'none'", csp, StringComparison.Ordinal);
        Assert.DoesNotContain("style-src-attr 'unsafe-inline'", csp, StringComparison.Ordinal);
        Assert.Contains("require-trusted-types-for 'script'", csp, StringComparison.Ordinal);
        Assert.Contains("trusted-types vue fsusblog fsusblog-spa-entry;", csp, StringComparison.Ordinal);
        Assert.DoesNotContain("trusted-types *", csp, StringComparison.Ordinal);
        Assert.DoesNotContain("'allow-duplicates'", csp, StringComparison.Ordinal);
        Assert.Contains("report-uri /api/security/csp-report", csp, StringComparison.Ordinal);
        Assert.Contains($"<script nonce=\"{nonce}\" type=\"module\">", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void DevelopmentHtmlCsp_PreservesNonceAndHmrWithoutTrustedTypesEnforcement()
    {
        const string Nonce = "development-nonce";
        string csp = PublicWebRuntime.BuildHtmlCsp(isDevelopment: true, Nonce);

        Assert.Contains($"'nonce-{Nonce}'", csp, StringComparison.Ordinal);
        Assert.Contains("http://127.0.0.1:3000", csp, StringComparison.Ordinal);
        Assert.DoesNotContain("require-trusted-types-for", csp, StringComparison.Ordinal);
        Assert.DoesNotContain("trusted-types vue fsusblog", csp, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("Development", false, true)]
    [InlineData("Development", true, false)]
    [InlineData("Production", false, false)]
    [InlineData("Production", true, false)]
    public void DevelopmentCspPolicy_CanBeDisabledForReleaseAcceptance(
        string environmentName,
        bool enforceProductionCsp,
        bool expected)
    {
        var environment = new TestWebHostEnvironment(Path.GetTempPath(), new NullFileProvider())
        {
            EnvironmentName = environmentName
        };
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Testing:EnforceProductionCsp"] = enforceProductionCsp.ToString()
            })
            .Build();

        Assert.Equal(
            expected,
            PublicWebRuntime.ShouldUseDevelopmentCspPolicy(environment, configuration));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void StaticCsp_DeniesStyleAttributesAndWasmCompilationAndEnforcesTrustedTypesOnlyInProduction(bool isDevelopment)
    {
        string csp = PublicWebRuntime.BuildStaticCsp(isDevelopment);

        Assert.Contains("script-src 'self';", csp, StringComparison.Ordinal);
        Assert.DoesNotContain("wasm-unsafe-eval", csp, StringComparison.Ordinal);
        Assert.Contains("style-src-attr 'none'", csp, StringComparison.Ordinal);
        Assert.DoesNotContain("style-src-attr 'unsafe-inline'", csp, StringComparison.Ordinal);
        Assert.Contains("report-uri /api/security/csp-report", csp, StringComparison.Ordinal);
        if (isDevelopment)
        {
            Assert.DoesNotContain("require-trusted-types-for", csp, StringComparison.Ordinal);
            Assert.DoesNotContain("trusted-types vue fsusblog", csp, StringComparison.Ordinal);
        }
        else
        {
            Assert.Contains("require-trusted-types-for 'script'", csp, StringComparison.Ordinal);
            Assert.Contains("trusted-types vue fsusblog fsusblog-spa-entry;", csp, StringComparison.Ordinal);
            Assert.DoesNotContain("trusted-types *", csp, StringComparison.Ordinal);
            Assert.DoesNotContain("'allow-duplicates'", csp, StringComparison.Ordinal);
        }
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
        Assert.Equal(expected, PublicWebRuntime.IsImmutableSearchIndexAssetPath(path));
    }

    [Theory]
    [InlineData("/aot-cache/payloads/aa/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.aeds", true)]
    [InlineData("/aot-cache/payloads/aa/payload.bin", false)]
    [InlineData("/aot-cache/frontend/version/Home/aa/0123456789abcdef.aeds", false)]
    [InlineData("/search/index.manifest.aeds", false)]
    public void IsPublicAotHydrationSidecarPath_MatchesPayloadSidecarsOnly(string path, bool expected)
    {
        Assert.Equal(expected, PublicWebRuntime.IsPublicAotHydrationSidecarPath(path));
    }

    [Fact]
    public async Task HotPathCompositionSource_AvoidsRegexAndFullPageReplaceForStaticAndFallback()
    {
        Type template = Assert.IsAssignableFrom<Type>(typeof(PublicWebRuntime).GetNestedType(
            "SpaHtmlByteTemplate",
            BindingFlags.NonPublic));
        Assert.NotNull(template.GetMethod("GetLength", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic));
        Assert.NotNull(template.GetMethod("Write", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic));
        await SpaFallbackHeadInjectionCache_DoesNotCacheCspNonce();
    }

    [Fact]
    public void EndpointPipeline_AuthenticatesBeforeRateLimiterAndBannedUserChecks()
    {
        IReadOnlyList<string> stages = WebApplicationCompositionExtensions.EndpointPipelineStageIds;

        AssertBefore(stages, "authentication", "rate-limiter");
        AssertBefore(stages, "rate-limiter", "banned-user");
        AssertBefore(stages, "banned-user", "authorization");
    }

    [Fact]
    public void EndpointPipeline_CompressesDynamicApiResponsesBeforeOutputCache()
    {
        IReadOnlyList<string> stages = WebApplicationCompositionExtensions.EndpointPipelineStageIds;

        Assert.Contains("response-compression", stages);
        AssertBefore(stages, "response-compression", "output-cache");
    }

    [Fact]
    public void PublicHotReadFastPath_RunsAsEarlyDataPlaneBeforeGenericEndpointPipeline()
    {
        IReadOnlyList<string> stages = WebApplicationCompositionExtensions.ApplicationPipelineStageIds;

        AssertBefore(stages, "core-middlewares", "public-hot-read-classifier");
        AssertBefore(stages, "observability-correlation", "public-hot-read-classifier");
        AssertBefore(stages, "public-hot-read-classifier", "public-hot-read-request-audit-context");
        AssertBefore(stages, "public-hot-read-request-audit-context", "public-hot-read-rate-limiter");
        AssertBefore(stages, "public-hot-read-classifier", "public-hot-read-rate-limiter");
        AssertBefore(stages, "public-hot-read-rate-limiter", "public-read-security-gate");
        AssertBefore(stages, "public-read-security-gate", "public-hot-read-fast-path");
        AssertBefore(stages, "public-read-security-gate", "public-artifact-revocation");
        AssertBefore(stages, "public-artifact-revocation", "public-hot-read-fast-path");
        AssertBefore(stages, "public-hot-read-fast-path", "public-hot-read-fallback-restore");
        AssertBefore(stages, "public-hot-read-fallback-restore", "endpoint-pipeline");
        AssertBefore(stages, "public-hot-read-fast-path", "static-assets");

        IReadOnlyList<string> genericStages = WebApplicationCompositionExtensions.EndpointPipelineStageIds;
        foreach (string bypassedStage in new[]
        {
            "response-compression",
            "output-cache",
            "cors",
            "antiforgery",
            "authentication",
            "banned-user",
            "request-audit-context"
        })
        {
            Assert.Contains(bypassedStage, genericStages);
        }
    }

    [Fact]
    public void PublicHotReadFastPath_SharesSecurityReleaseAndTraceStagesWithNormalPipeline()
    {
        IReadOnlyList<string> stages = WebApplicationCompositionExtensions.ApplicationPipelineStageIds;

        foreach (string sharedStage in new[]
        {
            "security-headers",
            "deployment-request-tracking",
            "observability-correlation"
        })
        {
            AssertBefore(stages, sharedStage, "public-hot-read-fast-path");
            AssertBefore(stages, sharedStage, "endpoint-pipeline");
        }
    }

    [Fact]
    public void Program_DoesNotMountPublicHotReadBeforeApplicationPipeline()
    {
        Assert.Single(
            WebApplicationCompositionExtensions.ApplicationPipelineStageIds,
            static stage => stage == "public-hot-read-fast-path");
    }

    [Fact]
    public async Task PublicHtmlRoutes_UsePublicReadRateLimitAndRiskMetadata()
    {
        await using WebApplication app = CreateApplicationRouteMap();
        RouteEndpoint[] routes = ((IEndpointRouteBuilder)app).DataSources
            .SelectMany(static source => source.Endpoints)
            .OfType<RouteEndpoint>()
            .Where(static endpoint => endpoint.Metadata.GetMetadata<RiskActionEndpointMetadata>() is
            { ActionName: RiskActionNames.PublicRead, RouteKey: "public.html.home" or "public.html.fallback" })
            .ToArray();

        Assert.Equal(2, routes.Length);
        Assert.Equal(
            ["public.html.fallback", "public.html.home"],
            routes.Select(static endpoint => endpoint.Metadata.GetMetadata<RiskActionEndpointMetadata>()!.RouteKey)
                .OrderBy(static routeKey => routeKey, StringComparer.Ordinal)
                .ToArray());
        Assert.All(routes, static endpoint => Assert.Equal(
            "public_read",
            Assert.IsType<EnableRateLimitingAttribute>(
                endpoint.Metadata.GetMetadata<EnableRateLimitingAttribute>()).PolicyName));
    }

    [Fact]
    public void PublicHtmlRoutes_TrailingSlashRedirectPreservesQueryAndPathBase()
    {
        var context = new DefaultHttpContext();
        context.Request.PathBase = "/blog";
        context.Request.Path = "/article/42/";
        context.Request.QueryString = new QueryString("?ref=canonical");

        Assert.True(PublicWebRuntime.TryBuildTrailingSlashRedirect(
            context.Request,
            out string location));
        Assert.Equal("/blog/article/42?ref=canonical", location);

        context.Request.Path = "/";
        Assert.False(PublicWebRuntime.TryBuildTrailingSlashRedirect(
            context.Request,
            out _));

        context.Request.Path = "/tag/Legacy//";
        Assert.False(PublicWebRuntime.TryBuildTrailingSlashRedirect(
            context.Request,
            out _));
    }

    [Theory]
    [InlineData("/search", true)]
    [InlineData("/login", true)]
    [InlineData("/recover", true)]
    [InlineData("/user/profile", true)]
    [InlineData("/route-that-does-not-exist", false)]
    [InlineData("/article/42/extra", false)]
    public void PublicHtmlRoutes_OnlyKnownSpaFallbacksRemainSuccessful(string path, bool expected)
    {
        Assert.Equal(expected, PublicWebRuntime.IsKnownSpaRoute(new PathString(path)));
    }

    [Fact]
    public void SearchSpaHead_IsNoIndexWithoutCanonicalOrStructuredData()
    {
        string head = Encoding.UTF8.GetString(
            PublicWebRuntime.GetSearchNoIndexHeadInjectionForTests().Span);

        Assert.Contains("<meta name=\"robots\" content=\"noindex,follow\"", head, StringComparison.Ordinal);
        Assert.Contains("data-fsus-search-head", head, StringComparison.Ordinal);
        Assert.DoesNotContain("canonical", head, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("application/ld+json", head, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("GET")]
    [InlineData("HEAD")]
    public async Task PublicStatusHtml_NotFoundIsNoIndexAndNeverCarriesSuccessMetadata(string method)
    {
        var context = new DefaultHttpContext();
        context.Request.Method = method;
        context.Response.Body = new MemoryStream();

        await PublicWebRuntime.WritePublicStatusHtmlAsync(
            context,
            CreateTestEnv(),
            StatusCodes.Status404NotFound);

        Assert.Equal(StatusCodes.Status404NotFound, context.Response.StatusCode);
        Assert.Equal("text/html; charset=utf-8", context.Response.ContentType);
        Assert.Equal("no-store", context.Response.Headers.CacheControl);
        Assert.Equal("noindex, follow", context.Response.Headers["X-Robots-Tag"]);
        Assert.Equal("none", context.Response.Headers["X-Fsus-Public-Aot-Backfill"]);
        Assert.Equal("not-found", context.Response.Headers["X-Fsus-Public-Aot-State"]);
        Assert.False(context.Response.Headers.ContainsKey("ETag"));

        context.Response.Body.Position = 0;
        string body = await new StreamReader(context.Response.Body, Encoding.UTF8).ReadToEndAsync();
        if (HttpMethods.IsHead(method))
        {
            Assert.Empty(body);
            Assert.True(context.Response.ContentLength > 0);
        }
        else
        {
            Assert.Contains("<meta name=\"robots\" content=\"noindex,follow\">", body, StringComparison.Ordinal);
            Assert.DoesNotContain("rel=\"canonical\"", body, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("og:url", body, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("BlogPosting", body, StringComparison.Ordinal);
            Assert.DoesNotContain("<script", body, StringComparison.OrdinalIgnoreCase);
        }
    }

    [Fact]
    public async Task PublicStatusHtml_TransientFailureIsRetryableAndNoIndex()
    {
        var context = new DefaultHttpContext();
        context.Request.Method = HttpMethods.Get;
        context.Response.Body = new MemoryStream();

        await PublicWebRuntime.WritePublicStatusHtmlAsync(
            context,
            CreateTestEnv(),
            StatusCodes.Status503ServiceUnavailable);

        Assert.Equal(StatusCodes.Status503ServiceUnavailable, context.Response.StatusCode);
        Assert.Equal("5", context.Response.Headers.RetryAfter);
        Assert.Equal("noindex, follow", context.Response.Headers["X-Robots-Tag"]);
        Assert.Equal("transient-failure", context.Response.Headers["X-Fsus-Public-Aot-State"]);
    }

    [Fact]
    public async Task NotificationStreamEndpoints_UseDedicatedRateLimiter()
    {
        await using WebApplication app = CreateApplicationRouteMap();
        RouteEndpoint[] routes = ((IEndpointRouteBuilder)app).DataSources
            .SelectMany(static source => source.Endpoints)
            .OfType<RouteEndpoint>()
            .Where(static endpoint => (endpoint.RoutePattern.RawText ?? string.Empty).TrimStart('/') is
                "api/notifications/stream" or "api/notifications/stream/preflight")
            .ToArray();

        Assert.Equal(2, routes.Length);
        Assert.All(routes, static endpoint => Assert.Equal(
            "notification_stream",
            Assert.IsType<EnableRateLimitingAttribute>(
                endpoint.Metadata.GetMetadata<EnableRateLimitingAttribute>()).PolicyName));
    }

    [Fact]
    public void SpaFallbackHeadInjectionCache_ReusesRouteBytesForSameVersionAndRoute()
    {
        PublicWebRuntime.ResetSpaHeadInjectionCacheForTests();
        string[] preloads =
        [
            "/assets/route-admin.abc.js",
            "/assets/route-admin.abc.css"
        ];

        ReadOnlyMemory<byte> first = PublicWebRuntime.GetRoutePreloadHeadInjectionForTests(
            "asset-v1",
            "/admin/articles",
            preloads);
        ReadOnlyMemory<byte> second = PublicWebRuntime.GetRoutePreloadHeadInjectionForTests(
            "asset-v1",
            "/admin/articles",
            ["/assets/should-not-rebuild.js"]);

        string html = Encoding.UTF8.GetString(second.Span);
        Assert.Equal(Encoding.UTF8.GetString(first.Span), html);
        Assert.Contains("<link rel=\"modulepreload\" href=\"/assets/route-admin.abc.js\">", html, StringComparison.Ordinal);
        Assert.Contains("<link rel=\"stylesheet\" href=\"/assets/route-admin.abc.css\">", html, StringComparison.Ordinal);
        var stats = PublicWebRuntime.GetSpaHeadInjectionCacheStatsForTests();
        Assert.Equal(1, stats.EntryCount);
        Assert.Equal(1, stats.BuildCount);
        Assert.Equal(1, stats.HitCount);
    }

    [Fact]
    public void SpaFallbackHeadInjectionCache_MissesWhenAssetVersionChanges()
    {
        PublicWebRuntime.ResetSpaHeadInjectionCacheForTests();

        ReadOnlyMemory<byte> first = PublicWebRuntime.GetRoutePreloadHeadInjectionForTests(
            "asset-v1",
            "/login",
            ["/assets/auth.v1.js"]);
        ReadOnlyMemory<byte> second = PublicWebRuntime.GetRoutePreloadHeadInjectionForTests(
            "asset-v2",
            "/login",
            ["/assets/auth.v2.js"]);

        Assert.Contains("auth.v1.js", Encoding.UTF8.GetString(first.Span), StringComparison.Ordinal);
        Assert.Contains("auth.v2.js", Encoding.UTF8.GetString(second.Span), StringComparison.Ordinal);
        var stats = PublicWebRuntime.GetSpaHeadInjectionCacheStatsForTests();
        Assert.Equal(2, stats.EntryCount);
        Assert.Equal(2, stats.BuildCount);
        Assert.Equal(0, stats.HitCount);
    }

    [Fact]
    public void SpaFallbackHeadInjectionCache_ReusesPublicAssetSetBytes()
    {
        PublicWebRuntime.ResetSpaHeadInjectionCacheForTests();
        var assets = new SpaAssetSet(
            "/assets/fsus-spa-entry.js",
            ["/assets/public-page.abc.css"],
            ["/assets/entry-runtime.abc.js"],
            "asset-v1",
            UsesSourceAssets: false);

        ReadOnlyMemory<byte> first = PublicWebRuntime.GetPublicAssetHeadInjectionForTests("home", assets);
        ReadOnlyMemory<byte> second = PublicWebRuntime.GetPublicAssetHeadInjectionForTests("home", assets);

        string html = Encoding.UTF8.GetString(second.Span);
        Assert.Equal(Encoding.UTF8.GetString(first.Span), html);
        Assert.Contains("<link rel=\"modulepreload\" crossorigin href=\"/assets/entry-runtime.abc.js\">", html, StringComparison.Ordinal);
        Assert.Contains("<link rel=\"stylesheet\" href=\"/assets/public-page.abc.css\">", html, StringComparison.Ordinal);
        var stats = PublicWebRuntime.GetSpaHeadInjectionCacheStatsForTests();
        Assert.Equal(1, stats.EntryCount);
        Assert.Equal(1, stats.BuildCount);
        Assert.Equal(1, stats.HitCount);
    }

    [Fact]
    public void SpaFallbackHeadInjectionCache_DoesNotCacheEmptyPreloadSet()
    {
        PublicWebRuntime.ResetSpaHeadInjectionCacheForTests();

        ReadOnlyMemory<byte> headInjection = PublicWebRuntime.GetRoutePreloadHeadInjectionForTests(
            "asset-v1",
            "/plain",
            []);

        Assert.True(headInjection.IsEmpty);
        var stats = PublicWebRuntime.GetSpaHeadInjectionCacheStatsForTests();
        Assert.Equal(0, stats.EntryCount);
        Assert.Equal(0, stats.BuildCount);
        Assert.Equal(0, stats.HitCount);
    }

    [Fact]
    public async Task SpaFallbackHeadInjectionCache_DoesNotCacheCspNonce()
    {
        PublicWebRuntime.ResetSpaHeadInjectionCacheForTests();
        ReadOnlyMemory<byte> headInjection = PublicWebRuntime.GetRoutePreloadHeadInjectionForTests(
            "asset-v1",
            "/admin",
            ["/assets/route-admin.abc.js"]);

        string first = await PublicWebRuntime.RenderSpaHtmlForTestsAsync(
            "<html><head><script type=\"module\"></script></head><body></body></html>",
            headInjection,
            "nonce-a");
        string second = await PublicWebRuntime.RenderSpaHtmlForTestsAsync(
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
    public async Task SpaFallbackHtmlResponse_StreamsIdentityToKeepNonceOutOfCompressionOracle()
    {
        DefaultHttpContext context = CreateSpaFallbackContext(HttpMethods.Get, "br, gzip");
        context.Items["__fsusblog_csp_nonce"] = "spa-nonce";
        ReadOnlyMemory<byte> headInjection = Encoding.UTF8.GetBytes("<link rel=\"modulepreload\" href=\"/assets/route-admin.js\">\n");

        await PublicWebRuntime.WriteSpaHtmlResponseForTestsAsync(
            context,
            CreateTestEnv(),
            CreateLargeSpaTemplate("brotli"),
            headInjection);

        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.True(string.IsNullOrEmpty(context.Response.Headers["Content-Encoding"].ToString()));
        Assert.DoesNotContain("Accept-Encoding", context.Response.Headers.Vary.ToString(), StringComparison.OrdinalIgnoreCase);
        Assert.Equal(context.Response.Body.Length, context.Response.ContentLength);

        string rendered = Encoding.UTF8.GetString(((MemoryStream)context.Response.Body).ToArray());
        Assert.Contains("nonce=\"spa-nonce\"", rendered, StringComparison.Ordinal);
        Assert.Contains("<meta property=\"csp-nonce\" nonce=\"spa-nonce\" />", rendered, StringComparison.Ordinal);
        Assert.Contains("<link rel=\"modulepreload\" href=\"/assets/route-admin.js\">", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public async Task SpaFallbackHtmlResponse_RejectsWhenIdentityIsForbidden()
    {
        DefaultHttpContext context = CreateSpaFallbackContext(HttpMethods.Get, "gzip;q=1, br;q=0, identity;q=0");

        await PublicWebRuntime.WriteSpaHtmlResponseForTestsAsync(
            context,
            CreateTestEnv(),
            CreateLargeSpaTemplate("gzip"),
            ReadOnlyMemory<byte>.Empty);

        Assert.Equal(StatusCodes.Status406NotAcceptable, context.Response.StatusCode);
        Assert.True(string.IsNullOrEmpty(context.Response.Headers["Content-Encoding"].ToString()));
        Assert.DoesNotContain("Accept-Encoding", context.Response.Headers.Vary.ToString(), StringComparison.OrdinalIgnoreCase);
        Assert.Equal(0, context.Response.ContentLength);
        Assert.Equal(0, context.Response.Body.Length);
    }

    [Fact]
    public async Task SpaFallbackHtmlResponse_HeadReportsIdentityLengthWithoutWritingBody()
    {
        DefaultHttpContext context = CreateSpaFallbackContext(HttpMethods.Head, "br, gzip");

        await PublicWebRuntime.WriteSpaHtmlResponseForTestsAsync(
            context,
            CreateTestEnv(),
            CreateLargeSpaTemplate("head"),
            ReadOnlyMemory<byte>.Empty);

        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.True(string.IsNullOrEmpty(context.Response.Headers["Content-Encoding"].ToString()));
        Assert.DoesNotContain("Accept-Encoding", context.Response.Headers.Vary.ToString(), StringComparison.OrdinalIgnoreCase);
        Assert.True(context.Response.ContentLength > 0);
        Assert.Equal(0, context.Response.Body.Length);
    }

    [Fact]
    public async Task SpaFallbackHtmlResponse_SkipsCompressionForSmallHtml()
    {
        DefaultHttpContext context = CreateSpaFallbackContext(HttpMethods.Get, "br, gzip");

        await PublicWebRuntime.WriteSpaHtmlResponseForTestsAsync(
            context,
            CreateTestEnv(),
            "<html><head><script type=\"module\"></script></head><body>tiny</body></html>",
            ReadOnlyMemory<byte>.Empty);

        Assert.True(string.IsNullOrEmpty(context.Response.Headers["Content-Encoding"].ToString()));
        Assert.DoesNotContain("Accept-Encoding", context.Response.Headers.Vary.ToString(), StringComparison.OrdinalIgnoreCase);
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

        await PublicWebRuntime.WritePublicAotHtmlEntryForTestsAsync(context, CreateTestEnv(), entry);

        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Equal("br", context.Response.Headers["Content-Encoding"].ToString());
        Assert.Equal("Accept-Encoding, Accept-Language, Cookie", context.Response.Headers["Vary"].ToString());
        Assert.Equal(artifact.BrotliETag, context.Response.Headers["ETag"].ToString());
        Assert.Equal(artifact.BrotliBytes.Length, context.Response.ContentLength);
        Assert.Equal(artifact.BrotliBytes.ToArray(), ((MemoryStream)context.Response.Body).ToArray());
        Assert.Equal("renderer-v2", context.Response.Headers["X-Fsus-Public-Aot-Version"]);
        Assert.Equal("frontend-v2", context.Response.Headers["X-Fsus-Public-Aot-Frontend-Asset-Version"]);
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

        await PublicWebRuntime.WritePublicAotHtmlEntryForTestsAsync(context, CreateTestEnv(), entry);

        Assert.Equal(StatusCodes.Status304NotModified, context.Response.StatusCode);
        Assert.Equal("gzip", context.Response.Headers["Content-Encoding"].ToString());
        Assert.Equal(artifact.GzipETag, context.Response.Headers["ETag"].ToString());
        Assert.Equal(0, context.Response.ContentLength);
        Assert.Equal(0, context.Response.Body.Length);
    }

    [Fact]
    public async Task PublicAotHtmlFastPath_FallsBackToIdentityWhenCompressedVariantIsMissing()
    {
        const string Html = "<!doctype html><html><body>tiny</body></html>";
        PublicAotHtmlArtifact artifact = PublicAotHtmlArtifactFactory.FromHtml(
            Html,
            "renderer-v2",
            "frontend-v2",
            minPrecompressedHtmlBytes: 1024);
        var entry = CreateAotEntry(Html, artifact);
        DefaultHttpContext context = CreateAotContext("br, gzip");

        await PublicWebRuntime.WritePublicAotHtmlEntryForTestsAsync(context, CreateTestEnv(), entry);

        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.True(string.IsNullOrEmpty(context.Response.Headers["Content-Encoding"].ToString()));
        Assert.Equal(artifact.ETag, context.Response.Headers["ETag"].ToString());
        Assert.Equal(Encoding.UTF8.GetBytes(Html), ((MemoryStream)context.Response.Body).ToArray());
    }

    [Fact]
    public async Task PublicAotHtmlNonceTemplate_StreamsIdentityWithNoStoreAndNoEntityValidator()
    {
        const string Html = "<html><head></head><body><script type=\"module\"></script></body></html>";
        PublicAotHtmlArtifact artifact = PublicAotHtmlArtifactFactory.FromHtml(
            Html,
            "renderer-v2",
            "frontend-v2",
            minPrecompressedHtmlBytes: 1);
        var entry = CreateAotEntry(Html, artifact);
        DefaultHttpContext context = CreateAotContext("br, gzip");
        context.Request.Headers.IfNoneMatch = artifact.ETag;

        await PublicWebRuntime.WritePublicAotHtmlEntryForTestsAsync(context, CreateTestEnv(), entry);

        string rendered = Encoding.UTF8.GetString(((MemoryStream)context.Response.Body).ToArray());
        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.True(artifact.RequiresCspNonceMutation);
        Assert.True(artifact.BrotliBytes.IsEmpty);
        Assert.True(artifact.GzipBytes.IsEmpty);
        Assert.Contains("<meta property=\"csp-nonce\" nonce=\"", rendered, StringComparison.Ordinal);
        Assert.Contains("<script nonce=\"", rendered, StringComparison.Ordinal);
        Assert.Equal("private,no-store", context.Response.Headers.CacheControl.ToString());
        Assert.True(string.IsNullOrEmpty(context.Response.Headers["Content-Encoding"].ToString()));
        Assert.True(string.IsNullOrEmpty(context.Response.Headers["ETag"].ToString()));
        Assert.Equal(context.Response.ContentLength, context.Response.Body.Length);
    }

    [Fact]
    public async Task PublicAotHtmlNonceTemplate_HeadComputesHeadersWithoutWritingBody()
    {
        const string Html = "<html><head></head><body><script>head()</script></body></html>";
        PublicAotHtmlArtifact artifact = PublicAotHtmlArtifactFactory.FromHtml(Html, "renderer-head", "frontend-head");
        DefaultHttpContext context = CreateAotContext("br, gzip");
        context.Request.Method = HttpMethods.Head;

        await PublicWebRuntime.WritePublicAotHtmlEntryForTestsAsync(
            context,
            CreateTestEnv(),
            CreateAotEntry(Html, artifact));

        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.True(context.Response.ContentLength > artifact.Utf8Bytes.Length);
        Assert.Equal("private,no-store", context.Response.Headers.CacheControl.ToString());
        Assert.True(string.IsNullOrEmpty(context.Response.Headers.ETag.ToString()));
        Assert.Equal(0, context.Response.Body.Length);
    }

    [Fact]
    public async Task PublicAotHtmlNonceTemplate_RejectsWhenIdentityIsExplicitlyForbidden()
    {
        const string Html = "<html><head></head><body><script>identity()</script></body></html>";
        PublicAotHtmlArtifact artifact = PublicAotHtmlArtifactFactory.FromHtml(Html, "renderer-identity", "frontend-identity");
        DefaultHttpContext context = CreateAotContext("br;q=1, gzip;q=1, identity;q=0");

        await PublicWebRuntime.WritePublicAotHtmlEntryForTestsAsync(
            context,
            CreateTestEnv(),
            CreateAotEntry(Html, artifact));

        Assert.Equal(StatusCodes.Status406NotAcceptable, context.Response.StatusCode);
        Assert.Equal(0, context.Response.ContentLength);
        Assert.Equal(0, context.Response.Body.Length);
    }

    [Fact]
    public async Task PublicAotHtmlFastPath_SourceAvoidsStringContentAndPerRequestUtf8Encode()
    {
        await PublicAotHtmlFastPath_PrefersBrotliVariantAndWritesPreencodedBytes();
        await PublicAotHtmlFastPath_ProbeCapturesBytesLatencyAndAllocationShape();
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
        await PublicWebRuntime.WritePublicAotHtmlEntryForTestsAsync(identity, CreateTestEnv(), entry);
        DefaultHttpContext brotli = CreateAotContext("br, gzip");
        await PublicWebRuntime.WritePublicAotHtmlEntryForTestsAsync(brotli, CreateTestEnv(), entry);
        DefaultHttpContext gzip = CreateAotContext("gzip;q=1, identity;q=0");
        await PublicWebRuntime.WritePublicAotHtmlEntryForTestsAsync(gzip, CreateTestEnv(), entry);

        long identityBytes = identity.Response.Body.Length;
        long brotliBytes = brotli.Response.Body.Length;
        long gzipBytes = gzip.Response.Body.Length;
        Assert.Equal(artifact.Utf8Bytes.Length, identityBytes);
        Assert.Equal(artifact.BrotliBytes.Length, brotliBytes);
        Assert.Equal(artifact.GzipBytes.Length, gzipBytes);
        Assert.True(brotliBytes < identityBytes);
        Assert.True(gzipBytes < identityBytes);

        const int Samples = 32;
        long[] elapsedTicks = new long[Samples];
        long allocBefore = GC.GetTotalAllocatedBytes(precise: true);
        long totalBytes = 0;
        for (int i = 0; i < Samples; i++)
        {
            DefaultHttpContext context = CreateAotContext("br, gzip");
            long started = Stopwatch.GetTimestamp();
            await PublicWebRuntime.WritePublicAotHtmlEntryForTestsAsync(context, CreateTestEnv(), entry);
            elapsedTicks[i] = Stopwatch.GetTimestamp() - started;
            totalBytes += context.Response.Body.Length;
        }

        long allocAfter = GC.GetTotalAllocatedBytes(precise: true);
        Assert.True(allocAfter >= allocBefore);
        Assert.True(PercentileTicks(elapsedTicks, 99) >= 0);
        Assert.Equal(artifact.BrotliBytes.Length * Samples, totalBytes);
    }

    [Fact]
    public async Task StaticNoCacheEntryAssets_PreserveValidatorsForConditionalRequests()
    {
        await StaticNoCacheEntryAssets_ReturnNotModifiedWhenEtagMatches("/sw.js", "self.__fsus_test = 1;");
        await StaticNoCacheEntryAssets_ReturnNotModifiedWhenEtagMatches("/search/index.manifest.aeds", "manifest-v1");
        await StaticNoCacheEntryAssets_ReturnNotModifiedWhenEtagMatches("/search/index.bin", "legacy-index-v1");
        await StaticNoCacheEntryAssets_ReturnNotModifiedWhenEtagMatches("/manifest.webmanifest", "{\"name\":\"FsusBlog\"}");
    }

    [Fact]
    public void StaticAssets_UseConfiguredPhysicalWebRootInsteadOfCompositeSourceShadow()
    {
        string root = Path.Combine(Path.GetTempPath(), $"fsus-static-root-{Guid.NewGuid():N}");
        string sourceRoot = Path.Combine(root, "source");
        string configuredRoot = Path.Combine(root, "configured");
        string relativePath = Path.Combine("search", "index.bin");
        Directory.CreateDirectory(Path.Combine(sourceRoot, "search"));
        Directory.CreateDirectory(Path.Combine(configuredRoot, "search"));
        File.WriteAllText(Path.Combine(sourceRoot, relativePath), "stale-source-alias");
        File.WriteAllText(Path.Combine(configuredRoot, relativePath), "current-runtime-alias");

        try
        {
            using var sourceProvider = new PhysicalFileProvider(sourceRoot);
            using var configuredProvider = new PhysicalFileProvider(configuredRoot);
            var compositeProvider = new CompositeFileProvider(sourceProvider, configuredProvider);
            var environment = new TestWebHostEnvironment(configuredRoot, compositeProvider)
            {
                WebRootPath = configuredRoot
            };

            Assert.Equal(
                "stale-source-alias",
                File.ReadAllText(environment.WebRootFileProvider.GetFileInfo("search/index.bin").PhysicalPath!));

            using PhysicalFileProvider authoritative =
                PublicWebRuntime.CreateAuthoritativeWebRootFileProvider(environment);
            Assert.Equal(
                "current-runtime-alias",
                File.ReadAllText(authoritative.GetFileInfo("search/index.bin").PhysicalPath!));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task DynamicManifest_SourceUsesDerivedBytesCacheAndConditionalEtag()
    {
        await DynamicManifest_ReturnsNotModifiedForMatchingEtagAndChangesEtagWhenSeoChanges();
    }

    [Fact]
    public async Task DynamicManifest_ReturnsNotModifiedForMatchingEtagAndChangesEtagWhenSeoChanges()
    {
        var seo = new SeoConfigReadModel
        {
            ManifestName = "FsusBlog",
            ManifestShortName = "Fsus",
            Title = "FsusBlog",
            Description = "Initial description",
            ThemeColor = "#111111",
            BackgroundColor = "#ffffff"
        };
        DefaultHttpContext first = CreateManifestContext();

        await PublicWebRuntime.WriteDynamicManifestForTestsAsync(first, seo);

        Assert.Equal(StatusCodes.Status200OK, first.Response.StatusCode);
        Assert.Equal("no-cache", first.Response.Headers["Cache-Control"].ToString());
        string firstEtag = first.Response.Headers["ETag"].ToString();
        Assert.StartsWith("\"manifest-", firstEtag, StringComparison.Ordinal);
        Assert.True(first.Response.Body.Length > 0);

        DefaultHttpContext second = CreateManifestContext(firstEtag);

        await PublicWebRuntime.WriteDynamicManifestForTestsAsync(second, seo);

        Assert.Equal(StatusCodes.Status304NotModified, second.Response.StatusCode);
        Assert.Equal(firstEtag, second.Response.Headers["ETag"].ToString());
        Assert.Equal(0, second.Response.ContentLength);
        Assert.Equal(0, second.Response.Body.Length);

        DefaultHttpContext changed = CreateManifestContext(firstEtag);

        await PublicWebRuntime.WriteDynamicManifestForTestsAsync(
            changed,
            seo with
            {
                ThemeColor = "#222222"
            });

        Assert.Equal(StatusCodes.Status200OK, changed.Response.StatusCode);
        Assert.NotEqual(firstEtag, changed.Response.Headers["ETag"].ToString());
        Assert.True(changed.Response.Body.Length > 0);
    }

    [Theory]
    [InlineData("/sw.js", "self.__fsus_test = 1;")]
    [InlineData("/search/index.manifest.aeds", "manifest-v1")]
    [InlineData("/search/index.bin", "legacy-index-v1")]
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
    public async Task ImmutableStaticAssets_KeepLongCacheWithoutValidators()
    {
        await ImmutableSearchShardKeepsLongCacheAndRemovesValidators();
    }

    [Fact]
    public async Task ImmutableSearchShardKeepsLongCacheAndRemovesValidators()
    {
        using var site = StaticAssetTestSite.Create();
        site.Write("/search/index.core.0123456789abcdef.bin", "core-shard");

        DefaultHttpContext result = await site.GetAsync("/search/index.core.0123456789abcdef.bin");

        Assert.Equal(StatusCodes.Status200OK, result.Response.StatusCode);
        Assert.Equal("nosniff", result.Response.Headers["X-Content-Type-Options"].ToString());
        Assert.Equal("public,max-age=31536000,immutable", result.Response.Headers["Cache-Control"].ToString());
        Assert.True(string.IsNullOrEmpty(result.Response.Headers["ETag"].ToString()));
        Assert.True(string.IsNullOrEmpty(result.Response.Headers["Last-Modified"].ToString()));
    }

    [Fact]
    public async Task PublicAotHydrationSidecarUsesVendorAedsTypeAndImmutableCache()
    {
        using var site = StaticAssetTestSite.Create();
        site.Write(
            "/aot-cache/payloads/aa/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.aeds",
            "aeds-frame");

        DefaultHttpContext result = await site.GetAsync(
            "/aot-cache/payloads/aa/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.aeds");

        Assert.Equal(StatusCodes.Status200OK, result.Response.StatusCode);
        Assert.Equal("application/vnd.fsus.aeds", result.Response.ContentType);
        Assert.Equal("public,max-age=31536000,immutable", result.Response.Headers["Cache-Control"].ToString());
        Assert.True(string.IsNullOrEmpty(result.Response.Headers["ETag"].ToString()));
        Assert.True(string.IsNullOrEmpty(result.Response.Headers["Last-Modified"].ToString()));
    }
    private static WebApplication CreateApplicationRouteMap()
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        EndpointContractApplication.AddContractServices(builder);
        WebApplication app = builder.Build();
        app.MapFsusApplicationRoutes();
        return app;
    }

    private static void AssertBefore(IReadOnlyList<string> stages, string first, string second)
    {
        var ordered = stages.ToList();
        int firstIndex = ordered.IndexOf(first);
        int secondIndex = ordered.IndexOf(second);

        Assert.True(firstIndex >= 0, $"Unable to locate {first}.");
        Assert.True(secondIndex >= 0, $"Unable to locate {second}.");
        Assert.True(firstIndex < secondIndex, $"{first} must appear before {second}.");
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

    private static DefaultHttpContext CreateManifestContext(string? ifNoneMatch = null)
    {
        var context = new DefaultHttpContext();
        context.Request.Method = HttpMethods.Get;
        context.Request.Path = "/manifest.webmanifest";
        context.Response.Body = new MemoryStream();
        if (!string.IsNullOrWhiteSpace(ifNoneMatch))
        {
            context.Request.Headers.IfNoneMatch = ifNoneMatch;
        }

        return context;
    }

    private static string CreateLargeSpaTemplate(string marker)
        => string.Concat(
            "<!doctype html><html><head><script type=\"module\"></script></head><body><div id=\"app\">",
            string.Concat(Enumerable.Repeat($"<p>{marker} fallback payload</p>", 320)),
            "</div></body></html>");

    private static IWebHostEnvironment CreateTestEnv()
        => new TestWebHostEnvironment(Path.GetTempPath(), new NullFileProvider());

    private static byte[] RenderTemplate(CspNonceUtf8Template template, ReadOnlySpan<byte> nonce)
    {
        var writer = new ArrayBufferWriter<byte>(template.GetRenderedLength(nonce.Length));
        template.Write(writer, nonce);
        return writer.WrittenSpan.ToArray();
    }

    private static long PercentileTicks(long[] values, int percentile)
    {
        Array.Sort(values);
        int index = (int)Math.Ceiling(values.Length * (percentile / 100d)) - 1;
        return values[Math.Clamp(index, 0, values.Length - 1)];
    }

    private sealed class StaticAssetTestSite : IDisposable
    {
        private static readonly Action<StaticFileResponseContext> s_staticAssetResponseCallback =
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
                OnPrepareResponse = s_staticAssetResponseCallback
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
            MethodInfo? method = typeof(PublicWebRuntime).GetMethod(
                "PrepareStaticAssetResponse",
                BindingFlags.NonPublic | BindingFlags.Static);
            if (method is null)
            {
                throw new MissingMethodException(
                    typeof(PublicWebRuntime).FullName,
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
