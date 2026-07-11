using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.Spa;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using System.Reflection;
using System.Security.Cryptography;

namespace FsusBlog.Server.Tests;

[Collection(PublicSpaTemplateLocatorTestCollection.Name)]
public sealed class PublicAotDocumentServiceTests
{
    [Fact]
    public async Task ComposeAsync_CachesPreparedTemplateHeadLinksAndHydrationSidecarExistence()
    {
        string root = CreateTempDirectory();
        PublicSpaTemplateLocator.ResetCacheForTests();
        try
        {
            string templatePath = Path.Combine(root, "wwwroot", "index.html");
            await File.AppendAllTextAsync(templatePath, $"\n<!-- unique:{Guid.NewGuid():N} -->");
            var service = new PublicAotDocumentService(
                new TestWebHostEnvironment(root, Environments.Production),
                new ConfigurationBuilder().Build(),
                new FixedSystemService(),
                new ContextAwareAssetManifest(),
                NullLogger<PublicAotDocumentService>.Instance);
            string hydrationPayload = PublicAotBinaryPayload.EncodeObject(new Dictionary<string, object?>
            {
                ["pageKind"] = "Home",
                ["cacheProbe"] = Guid.NewGuid().ToString("N")
            });
            PublicAotShellEntryContract entry = CreateEntry(hydrationPayload);
            FieldInfo preparedCache = StaticCacheField("PreparedTemplateCache");
            FieldInfo headLinksCache = StaticCacheField("HeadLinksCache");
            FieldInfo sidecarCache = StaticCacheField("HydrationSidecarExistsCache");
            int preparedBefore = CacheCount(preparedCache);
            int headBefore = CacheCount(headLinksCache);
            int sidecarBefore = CacheCount(sidecarCache);

            Result<string> first = await service.ComposeAsync(entry);
            Assert.True(first.IsSuccess, first.Error.Message);
            string sidecarUrl = ExtractAttribute(first.Value!, "data-aeds-src");
            string sidecarPath = Path.Combine(root, "wwwroot", sidecarUrl.TrimStart('/').Replace('/', Path.DirectorySeparatorChar));
            DateTime firstWrite = File.GetLastWriteTimeUtc(sidecarPath);
            int preparedAfterFirst = CacheCount(preparedCache);
            int headAfterFirst = CacheCount(headLinksCache);
            int sidecarAfterFirst = CacheCount(sidecarCache);

            Result<string> second = await service.ComposeAsync(entry);

            Assert.True(second.IsSuccess, second.Error.Message);
            Assert.Equal(first.Value, second.Value);
            Assert.Equal(preparedBefore + 1, preparedAfterFirst);
            Assert.Equal(headBefore + 1, headAfterFirst);
            Assert.Equal(sidecarBefore + 1, sidecarAfterFirst);
            Assert.Equal(preparedAfterFirst, CacheCount(preparedCache));
            Assert.Equal(headAfterFirst, CacheCount(headLinksCache));
            Assert.Equal(sidecarAfterFirst, CacheCount(sidecarCache));
            Assert.Equal(firstWrite, File.GetLastWriteTimeUtc(sidecarPath));
        }
        finally
        {
            PublicSpaTemplateLocator.ResetCacheForTests();
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task ComposeAsync_WritesHydrationPayloadSidecarAsRawAedsFrame()
    {
        string root = CreateTempDirectory();
        PublicSpaTemplateLocator.ResetCacheForTests();
        try
        {
            var service = new PublicAotDocumentService(
                new TestWebHostEnvironment(root, Environments.Production),
                new ConfigurationBuilder().Build(),
                new FixedSystemService(),
                new ContextAwareAssetManifest(),
                NullLogger<PublicAotDocumentService>.Instance);
            string hydrationPayload = PublicAotBinaryPayload.EncodeObject(new Dictionary<string, object?>
            {
                ["pageKind"] = "Home",
                ["routeKey"] = "home"
            });

            Result<string> result = await service.ComposeAsync(new PublicAotShellEntryContract
            {
                PageId = PublicPageId.Home,
                RouteKey = "home",
                Html = "<main>Home</main>",
                Title = "Home",
                BootstrapPayload = PublicAotBinaryPayload.EncodeObject(new Dictionary<string, object?>
                {
                    ["kind"] = "Home"
                }),
                HydrationPropsPayload = hydrationPayload
            });

            Assert.True(result.IsSuccess, result.Error.Message);
            string html = result.Value!;
            Assert.Contains("data-aeds-src=\"/aot-cache/payloads/", html, StringComparison.Ordinal);
            Assert.DoesNotContain(hydrationPayload, html, StringComparison.Ordinal);

            string sidecarUrl = ExtractAttribute(html, "data-aeds-src");
            string sidecarPath = Path.Combine(root, "wwwroot", sidecarUrl.TrimStart('/').Replace('/', Path.DirectorySeparatorChar));
            Assert.True(File.Exists(sidecarPath), sidecarPath);
            byte[] expectedBytes = PublicAotDocumentComposer.DecodePayloadFrameBytes(hydrationPayload);
            byte[] actualBytes = await File.ReadAllBytesAsync(sidecarPath);
            Assert.Equal(expectedBytes, actualBytes);
            Assert.Equal(
                Convert.ToHexStringLower(SHA256.HashData(expectedBytes)),
                Path.GetFileNameWithoutExtension(sidecarPath));
        }
        finally
        {
            PublicSpaTemplateLocator.ResetCacheForTests();
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task ComposeAsync_ChangedHydrationPayloadProducesNewSidecarUrl()
    {
        string root = CreateTempDirectory();
        PublicSpaTemplateLocator.ResetCacheForTests();
        try
        {
            var service = new PublicAotDocumentService(
                new TestWebHostEnvironment(root, Environments.Production),
                new ConfigurationBuilder().Build(),
                new FixedSystemService(),
                new ContextAwareAssetManifest(),
                NullLogger<PublicAotDocumentService>.Instance);
            string firstPayload = PublicAotBinaryPayload.EncodeObject(new Dictionary<string, object?>
            {
                ["pageKind"] = "Home",
                ["routeKey"] = "home",
                ["siteTitle"] = "First"
            });
            string secondPayload = PublicAotBinaryPayload.EncodeObject(new Dictionary<string, object?>
            {
                ["pageKind"] = "Home",
                ["routeKey"] = "home",
                ["siteTitle"] = "Second"
            });

            string firstHtml = (await service.ComposeAsync(CreateEntry(firstPayload))).Value!;
            string secondHtml = (await service.ComposeAsync(CreateEntry(secondPayload))).Value!;

            string firstUrl = ExtractAttribute(firstHtml, "data-aeds-src");
            string secondUrl = ExtractAttribute(secondHtml, "data-aeds-src");

            Assert.NotEqual(firstUrl, secondUrl);
            Assert.Equal(PublicAotDocumentComposer.DecodePayloadFrameBytes(firstPayload), await ReadSidecarAsync(root, firstUrl));
            Assert.Equal(PublicAotDocumentComposer.DecodePayloadFrameBytes(secondPayload), await ReadSidecarAsync(root, secondUrl));
        }
        finally
        {
            PublicSpaTemplateLocator.ResetCacheForTests();
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task ComposeAsync_ProductionConfiguredBaseUrlOverridesDefaultEntryBaseUrl()
    {
        string root = CreateTempDirectory();
        PublicSpaTemplateLocator.ResetCacheForTests();
        try
        {
            IConfiguration configuration = new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["Seo:BaseUrl"] = "https://selfhost.example/"
                })
                .Build();
            var service = new PublicAotDocumentService(
                new TestWebHostEnvironment(root, Environments.Production),
                configuration,
                new FixedSystemService(baseUrl: "https://example.com"),
                new ContextAwareAssetManifest(),
                NullLogger<PublicAotDocumentService>.Instance);

            Result<string> result = await service.ComposeAsync(new PublicAotShellEntryContract
            {
                PageId = PublicPageId.ArticleDetail,
                RouteKey = PublicRouteIdentity.BuildArticleRouteKey(42),
                ArticleId = 42,
                Html = "<article>Article</article>",
                Title = "Article",
                BaseUrl = "https://example.com",
                BootstrapPayload = PublicAotBinaryPayload.EncodeObject(new Dictionary<string, object?>
                {
                    ["kind"] = "ArticleDetail"
                }),
                HydrationPropsPayload = PublicAotBinaryPayload.EncodeObject(new Dictionary<string, object?>
                {
                    ["pageKind"] = "ArticleDetail",
                    ["routeKey"] = PublicRouteIdentity.BuildArticleRouteKey(42),
                    ["title"] = "Outer Article",
                    ["siteTitle"] = "Self Host",
                    ["article"] = new Dictionary<string, object?>
                    {
                        ["title"] = "Nested Article",
                        ["authorName"] = "Alice",
                        ["coverImageUrl"] = "/uploads/cover.png",
                        ["publishedAt"] = "2026-06-15T12:30:00.0000000Z",
                        ["updatedAt"] = "2026-06-16T08:15:00.0000000Z"
                    }
                })
            });

            Assert.True(result.IsSuccess, result.Error.Message);
            string html = result.Value!;
            Assert.True(
                html.Contains("href=\"https://selfhost.example/article/42\"", StringComparison.Ordinal),
                html);
            Assert.Contains("property=\"og:url\" content=\"https://selfhost.example/article/42\"", html, StringComparison.Ordinal);
            Assert.Contains("\"url\":\"https://selfhost.example/article/42\"", html, StringComparison.Ordinal);
            Assert.Contains("\"headline\":\"Nested Article\"", html, StringComparison.Ordinal);
            Assert.Contains("\"datePublished\":\"2026-06-15T12:30:00.0000000Z\"", html, StringComparison.Ordinal);
            Assert.Contains("\"dateModified\":\"2026-06-16T08:15:00.0000000Z\"", html, StringComparison.Ordinal);
            Assert.Contains("\"name\":\"Alice\"", html, StringComparison.Ordinal);
            Assert.Contains("\"image\":\"https://selfhost.example/uploads/cover.png\"", html, StringComparison.Ordinal);
            Assert.DoesNotContain("https://example.com/article/42", html, StringComparison.Ordinal);
        }
        finally
        {
            PublicSpaTemplateLocator.ResetCacheForTests();
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task ComposeAsync_DevelopmentViteProxy_UsesSourceAssetsInsteadOfProductionManifestChunks()
    {
        string root = CreateTempDirectory();
        PublicSpaTemplateLocator.ResetCacheForTests();
        try
        {
            var context = new DefaultHttpContext();
            context.Request.Host = new HostString("127.0.0.1:7568");
            context.Request.Headers["X-Forwarded-Host"] = "127.0.0.1:3000";
            var logger = new RecordingLogger<PublicAotDocumentService>();
            var service = new PublicAotDocumentService(
                new TestWebHostEnvironment(root, Environments.Development),
                new ConfigurationBuilder().Build(),
                new FixedSystemService(),
                new ContextAwareAssetManifest(),
                logger);

            Result<string> result = await service.ComposeAsync(new PublicAotShellEntryContract
            {
                PageId = PublicPageId.Home,
                RouteKey = "home",
                Html = "<main>Home</main>",
                Title = "Home",
                BootstrapPayload = PublicAotBinaryPayload.EncodeObject(new Dictionary<string, object?>
                {
                    ["siteTitle"] = "Fsus Blog",
                    ["diagnosticPadding"] = "public-aot-document-service-dev-source-assets"
                }),
                HydrationPropsPayload = PublicAotBinaryPayload.EncodeObject(new Dictionary<string, object?>
                {
                    ["title"] = "Home",
                    ["siteTitle"] = "Fsus Blog",
                    ["diagnosticPadding"] = "public-aot-document-service-dev-source-assets"
                })
            }, context);

            Assert.True(result.IsSuccess, logger.LastException?.ToString() ?? result.Error.Message);
            string html = result.Value!;
            Assert.Contains("/src/bootstrap/entry.ts", html, StringComparison.Ordinal);
            Assert.Contains("/src/assets/public-page.css?direct", html, StringComparison.Ordinal);
            Assert.DoesNotContain("full-app-core-prod", html, StringComparison.Ordinal);
            Assert.DoesNotContain("route-admin-moderation-prod", html, StringComparison.Ordinal);
        }
        finally
        {
            PublicSpaTemplateLocator.ResetCacheForTests();
            Directory.Delete(root, recursive: true);
        }
    }

    private static string CreateTempDirectory()
    {
        string root = Path.Combine(Path.GetTempPath(), "fsus-aot-document-tests", Guid.NewGuid().ToString("N"));
        string webRoot = Path.Combine(root, "wwwroot");
        Directory.CreateDirectory(webRoot);
        File.WriteAllText(Path.Combine(webRoot, "index.html"), """
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <!--fsus:aot:head-start-->
  <title>Loading</title>
  <!--fsus:aot:head-end-->
</head>
<body>
  <div id="app"><!--fsus:aot:app--></div>
  <!--fsus:aot:payloads-->
  <!--fsus:aot:spa-boot-->
</body>
</html>
""");
        return root;
    }

    private static string ExtractAttribute(string html, string attribute)
    {
        string marker = attribute + "=\"";
        int start = html.IndexOf(marker, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Missing attribute {attribute}");
        start += marker.Length;
        int end = html.IndexOf('"', start);
        Assert.True(end > start, $"Malformed attribute {attribute}");
        return html[start..end];
    }

    private static async Task<byte[]> ReadSidecarAsync(string root, string sidecarUrl)
    {
        string sidecarPath = Path.Combine(root, "wwwroot", sidecarUrl.TrimStart('/').Replace('/', Path.DirectorySeparatorChar));
        Assert.True(File.Exists(sidecarPath), sidecarPath);
        return await File.ReadAllBytesAsync(sidecarPath);
    }

    private static FieldInfo StaticCacheField(string name)
        => typeof(PublicAotDocumentService).GetField(name, BindingFlags.NonPublic | BindingFlags.Static)
            ?? throw new InvalidOperationException($"Public AOT document cache was not found: {name}");

    private static int CacheCount(FieldInfo field)
    {
        object cache = field.GetValue(null)
            ?? throw new InvalidOperationException($"Public AOT document cache was null: {field.Name}");
        PropertyInfo count = cache.GetType().GetProperty("Count")
            ?? throw new InvalidOperationException($"Public AOT document cache has no count: {field.Name}");
        return Assert.IsType<int>(count.GetValue(cache));
    }

    private static PublicAotShellEntryContract CreateEntry(string hydrationPayload)
        => new()
        {
            PageId = PublicPageId.Home,
            RouteKey = "home",
            Html = "<main>Home</main>",
            Title = "Home",
            BootstrapPayload = PublicAotBinaryPayload.EncodeObject(new Dictionary<string, object?>
            {
                ["kind"] = "Home"
            }),
            HydrationPropsPayload = hydrationPayload
        };

    private sealed class ContextAwareAssetManifest : ISpaAssetManifestService
    {
        public IReadOnlyList<string> GetPreloadsForPath(string path, HttpContext? context = null) => [];

        public SpaAssetSet GetPublicAssetSet(HttpContext? context = null, PublicPageId? pageId = null)
            => IsViteProxy(context)
                ? new SpaAssetSet(
                    "/src/bootstrap/entry.ts",
                    [
                        "/src/assets/public-shell-critical.css",
                        "/src/assets/tailwind.css",
                        "/src/assets/public-page.css?direct"
                    ],
                    [],
                    "dev-source-assets",
                    UsesSourceAssets: true)
                : new SpaAssetSet(
                    "/assets/fsus-spa-entry.js",
                    ["/assets/public-page-prod.css"],
                    [],
                    "prod-manifest",
                    UsesSourceAssets: false)
                {
                    FullAppTakeover = new FullAppTakeoverAssetSet(
                        ["/assets/full-app-core-prod.js"],
                        ["/assets/route-admin-moderation-prod.css"])
                };

        public string GetFrontendAssetVersion(HttpContext? context = null)
            => IsViteProxy(context) ? "dev-source-assets" : "prod-manifest";

        private static bool IsViteProxy(HttpContext? context)
            => context?.Request.Headers["X-Forwarded-Host"].ToString().Contains(":3000", StringComparison.Ordinal) == true;
    }

    private sealed class FixedSystemService(string baseUrl = "https://example.com") : ISystemService
    {
        public Task<SeoConfigReadModel> GetSeoConfigAsync()
            => Task.FromResult(new SeoConfigReadModel
            {
                Title = "Fsus Blog",
                Description = "Public AOT test",
                BaseUrl = baseUrl
            });

        public Task UpdateSeoConfigAsync(UpdateSeoConfigRequest request) => Task.CompletedTask;

        public Task<SiteComplianceConfigReadModel> GetSiteComplianceConfigAsync()
            => Task.FromResult(new SiteComplianceConfigReadModel());

        public Task UpdateSiteComplianceConfigAsync(UpdateSiteComplianceConfigRequest request) => Task.CompletedTask;

        public Task<PageContentReadModel> GetPageContentAsync(string slug)
            => Task.FromResult(new PageContentReadModel { Slug = slug, Content = string.Empty });

        public Task<bool> UpdatePageContentAsync(UpdatePageContentRequest request) => Task.FromResult(true);

        public Task<bool> RefreshPageCacheAsync(string slug) => Task.FromResult(true);
    }

    private sealed class TestWebHostEnvironment(string root, string environmentName) : IWebHostEnvironment
    {
        public string ApplicationName { get; set; } = nameof(PublicAotDocumentServiceTests);
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string WebRootPath { get; set; } = Path.Combine(root, "wwwroot");
        public string EnvironmentName { get; set; } = environmentName;
        public string ContentRootPath { get; set; } = root;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }

    private sealed class RecordingLogger<T> : ILogger<T>
    {
        public Exception? LastException { get; private set; }

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            LastException = exception;
        }
    }
}
