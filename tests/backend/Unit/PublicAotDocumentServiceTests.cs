using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;

using FsusBlog.Core.Common;
using FsusBlog.Server.Helpers;
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
                new ContextAwareAssetManifest(Path.Combine(root, "wwwroot", "index.html")),
                NullLogger<PublicAotDocumentService>.Instance);
            string hydrationPayload = PublicAotBinaryPayload.EncodeObject(new Dictionary<string, object?>
            {
                ["pageKind"] = "Home",
                ["cacheProbe"] = Guid.NewGuid().ToString("N")
            });
            PublicAotShellEntryContract entry = CreateEntry(hydrationPayload);
            FieldInfo preparedCache = StaticCacheField("s_preparedTemplateCache");
            FieldInfo headLinksCache = StaticCacheField("s_headLinksCache");
            FieldInfo sidecarCache = StaticCacheField("s_hydrationSidecarExistsCache");
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
                new ContextAwareAssetManifest(Path.Combine(root, "wwwroot", "index.html")),
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
                RenderLocale = "zh-CN",
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
                new ContextAwareAssetManifest(Path.Combine(root, "wwwroot", "index.html")),
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
                new ContextAwareAssetManifest(Path.Combine(root, "wwwroot", "index.html")),
                NullLogger<PublicAotDocumentService>.Instance);

            Result<string> result = await service.ComposeAsync(new PublicAotShellEntryContract
            {
                PageId = PublicPageId.ArticleDetail,
                RouteKey = PublicRouteIdentity.BuildArticleRouteKey(42),
                ArticleId = 42,
                Html = "<article>Article</article>",
                RenderLocale = "zh-CN",
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
    public async Task ComposeAsync_ArticleWithoutSummary_ProducesPlainUnicodeSafeDescription()
    {
        string root = CreateTempDirectory();
        PublicSpaTemplateLocator.ResetCacheForTests();
        try
        {
            var service = new PublicAotDocumentService(
                new TestWebHostEnvironment(root, Environments.Production),
                new ConfigurationBuilder().Build(),
                new FixedSystemService(),
                new ContextAwareAssetManifest(Path.Combine(root, "wwwroot", "index.html")),
                NullLogger<PublicAotDocumentService>.Instance);
            string markdown = "# 标题\n\n**加粗内容**与[链接文字](https://example.com)，包含 &amp; 实体。\n\n```cs\nConsole.WriteLine(\"hidden\");\n```\n";
            markdown += string.Concat(Enumerable.Repeat("这是不会切断代理对的正文🚀。", 20));

            Result<string> result = await service.ComposeAsync(new PublicAotShellEntryContract
            {
                PageId = PublicPageId.ArticleDetail,
                RouteKey = PublicRouteIdentity.BuildArticleRouteKey(42),
                ArticleId = 42,
                Html = "<article>Article</article>",
                RenderLocale = "zh-CN",
                Title = "Article",
                BootstrapPayload = PublicAotBinaryPayload.EncodeObject(new Dictionary<string, object?>
                {
                    ["article"] = new Dictionary<string, object?>
                    {
                        ["summary"] = string.Empty,
                        ["content"] = markdown
                    }
                }),
                HydrationPropsPayload = PublicAotBinaryPayload.EncodeObject(new Dictionary<string, object?>
                {
                    ["siteTitle"] = "Fsus Blog"
                })
            });

            Assert.True(result.IsSuccess, result.Error.Message);
            string html = result.Value!;
            Assert.Contains("加粗内容与链接文字，包含 &amp; 实体。", html, StringComparison.Ordinal);
            Assert.DoesNotContain("**", html, StringComparison.Ordinal);
            Assert.DoesNotContain("[链接文字]", html, StringComparison.Ordinal);
            Assert.DoesNotContain("```", html, StringComparison.Ordinal);
            Assert.DoesNotContain("Console.WriteLine", html, StringComparison.Ordinal);
        }
        finally
        {
            PublicSpaTemplateLocator.ResetCacheForTests();
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task BuildSeoHeadModelAsync_PageKindsUseDistinctRelevantDescriptions()
    {
        string root = CreateTempDirectory();
        PublicSpaTemplateLocator.ResetCacheForTests();
        try
        {
            var service = new PublicAotDocumentService(
                new TestWebHostEnvironment(root, Environments.Production),
                new ConfigurationBuilder().Build(),
                new FixedSystemService(),
                new ContextAwareAssetManifest(Path.Combine(root, "wwwroot", "index.html")),
                NullLogger<PublicAotDocumentService>.Instance);
            (PublicPageId PageId, string RouteKey, string Title)[] pages =
            [
                (PublicPageId.Home, "home", "首页"),
                (PublicPageId.Archive, "archive", "归档"),
                (PublicPageId.Filter, PublicRouteIdentity.BuildCategoryRouteKey(7), "后端"),
                (PublicPageId.Filter, PublicRouteIdentity.BuildTagIdRouteKey(9), "性能"),
                (PublicPageId.About, "about", "关于"),
                (PublicPageId.Privacy, "privacy", "隐私"),
                (PublicPageId.Guidelines, "guidelines", "用户守则"),
                (PublicPageId.Copyright, "copyright", "版权")
            ];

            var descriptions = new List<string>(pages.Length);
            foreach ((PublicPageId pageId, string routeKey, string title) in pages)
            {
                Result<PublicSeoHeadModel> result = await service.BuildSeoHeadModelAsync(new PublicAotShellEntryContract
                {
                    PageId = pageId,
                    RouteKey = routeKey,
                    Title = title,
                    Html = "<main />",
                    RenderLocale = "zh-CN",
                    HydrationPropsPayload = PublicAotBinaryPayload.EncodeObject(new Dictionary<string, object?>
                    {
                        ["siteTitle"] = "Fsus Blog",
                        ["siteDescription"] = "Public AOT test"
                    })
                });
                Assert.True(result.IsSuccess, result.Error.Message);
                descriptions.Add(result.Value!.Description);
            }

            Assert.Equal(pages.Length, descriptions.Distinct(StringComparer.Ordinal).Count());
            Assert.Contains(descriptions, static value => value.Contains("分类", StringComparison.Ordinal));
            Assert.Contains(descriptions, static value => value.Contains("标签", StringComparison.Ordinal));
            Assert.Contains(descriptions, static value => value.Contains("隐私", StringComparison.Ordinal));
        }
        finally
        {
            PublicSpaTemplateLocator.ResetCacheForTests();
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task BuildSeoHeadModelAsync_StaticPageUsesActualHydratedContentBeforeGenericFallback()
    {
        string root = CreateTempDirectory();
        PublicSpaTemplateLocator.ResetCacheForTests();
        try
        {
            var service = new PublicAotDocumentService(
                new TestWebHostEnvironment(root, Environments.Production),
                new ConfigurationBuilder().Build(),
                new FixedSystemService(),
                new ContextAwareAssetManifest(Path.Combine(root, "wwwroot", "index.html")),
                NullLogger<PublicAotDocumentService>.Instance);
            Result<PublicSeoHeadModel> result = await service.BuildSeoHeadModelAsync(new PublicAotShellEntryContract
            {
                PageId = PublicPageId.About,
                RouteKey = "about",
                Title = "关于",
                Html = "<main />",
                RenderLocale = "zh-CN",
                HydrationPropsPayload = PublicAotBinaryPayload.EncodeObject(new Dictionary<string, object?>
                {
                    ["siteTitle"] = "Fsus Blog",
                    ["staticPage"] = new Dictionary<string, object?>
                    {
                        ["content"] = "# 我们是谁\n\n这里介绍[真实内容](https://example.com)，而不是通用回退。"
                    }
                })
            });

            Assert.True(result.IsSuccess, result.Error.Message);
            Assert.Equal("我们是谁 这里介绍真实内容，而不是通用回退。", result.Value!.Description);
        }
        finally
        {
            PublicSpaTemplateLocator.ResetCacheForTests();
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task BuildSeoHeadModelAsync_CategoryFilterWithDescription_UsesSummarizedTaxonomyText()
    {
        await AssertFilterDescriptionAsync(
            PublicRouteIdentity.BuildCategoryRouteKey(7),
            "后端",
            "  这是分类说明，含 **加粗** 与[链接](https://example.com)。  ",
            expected: ImageHelper.StripMarkdown("  这是分类说明，含 **加粗** 与[链接](https://example.com)。  ", 160));
    }

    [Fact]
    public async Task BuildSeoHeadModelAsync_RegeneratedFilterHead_ObservesUpdatedTaxonomyDescription()
    {
        string oldDescription = "old category notes about caching.";
        string newDescription = "fresh category notes about taxonomy SEO.";
        string expectedOld = ImageHelper.StripMarkdown(oldDescription, 160);
        string expectedNew = ImageHelper.StripMarkdown(newDescription, 160);
        Assert.NotEqual(expectedOld, expectedNew);

        await WithServiceAsync(async service =>
        {
            Result<PublicSeoHeadModel> stale = await service.BuildSeoHeadModelAsync(CreateFilterEntry(
                PublicRouteIdentity.BuildCategoryRouteKey(7),
                "后端",
                oldDescription));
            Result<PublicSeoHeadModel> regenerated = await service.BuildSeoHeadModelAsync(CreateFilterEntry(
                PublicRouteIdentity.BuildCategoryRouteKey(7),
                "后端",
                newDescription));

            Assert.True(stale.IsSuccess, stale.Error.Message);
            Assert.True(regenerated.IsSuccess, regenerated.Error.Message);
            AssertSeoDescription(stale.Value!, expectedOld);
            AssertSeoDescription(regenerated.Value!, expectedNew);
        });
    }

    [Fact]
    public async Task BuildSeoHeadModelAsync_TagFilterWithDescription_UsesSummarizedTaxonomyText()
    {
        await AssertFilterDescriptionAsync(
            PublicRouteIdentity.BuildTagIdRouteKey(9),
            "性能",
            "Tag notes about latency and cache locality.",
            expected: ImageHelper.StripMarkdown("Tag notes about latency and cache locality.", 160));
    }

    [Fact]
    public async Task BuildSeoHeadModelAsync_FilterDescriptionLongerThanLimit_UsesExistingSummaryPath()
    {
        string raw = string.Concat(Enumerable.Repeat("这是一段会超过摘要上限的分类说明。", 12));
        string expected = ImageHelper.StripMarkdown(raw, 160);
        Assert.True(expected.Length < raw.Length, expected);

        await AssertFilterDescriptionAsync(
            PublicRouteIdentity.BuildCategoryRouteKey(7),
            "后端",
            raw,
            expected);
    }

    [Fact]
    public async Task BuildSeoHeadModelAsync_CategoryAndTagWithoutDescription_PreserveGeneratedFallback()
    {
        await WithServiceAsync(async service =>
        {
            Result<PublicSeoHeadModel> category = await service.BuildSeoHeadModelAsync(CreateFilterEntry(
                PublicRouteIdentity.BuildCategoryRouteKey(7),
                "后端",
                description: null));
            Result<PublicSeoHeadModel> tag = await service.BuildSeoHeadModelAsync(CreateFilterEntry(
                PublicRouteIdentity.BuildTagIdRouteKey(9),
                "性能",
                description: string.Empty));
            Result<PublicSeoHeadModel> whitespace = await service.BuildSeoHeadModelAsync(CreateFilterEntry(
                PublicRouteIdentity.BuildCategoryRouteKey(7),
                "后端",
                description: "   "));

            Assert.True(category.IsSuccess, category.Error.Message);
            Assert.True(tag.IsSuccess, tag.Error.Message);
            Assert.True(whitespace.IsSuccess, whitespace.Error.Message);
            AssertSeoDescription(category.Value!, "浏览 Fsus Blog 中“后端”分类下的文章。");
            AssertSeoDescription(tag.Value!, "浏览 Fsus Blog 中“性能”标签下的文章。");
            AssertSeoDescription(whitespace.Value!, "浏览 Fsus Blog 中“后端”分类下的文章。");
        });
    }

    [Fact]
    public async Task BuildSeoHeadModelAsync_FilterPrefersHydrationDescriptionThenBootstrap()
    {
        await WithServiceAsync(async service =>
        {
            Result<PublicSeoHeadModel> hydrationWins = await service.BuildSeoHeadModelAsync(CreateFilterEntry(
                PublicRouteIdentity.BuildCategoryRouteKey(7),
                "后端",
                hydrationDescription: "hydration taxonomy description",
                bootstrapDescription: "bootstrap taxonomy description"));
            Result<PublicSeoHeadModel> bootstrapFallback = await service.BuildSeoHeadModelAsync(CreateFilterEntry(
                PublicRouteIdentity.BuildTagIdRouteKey(9),
                "性能",
                hydrationDescription: null,
                bootstrapDescription: "bootstrap-only taxonomy description",
                includeHydrationFilter: true));

            Assert.True(hydrationWins.IsSuccess, hydrationWins.Error.Message);
            Assert.True(bootstrapFallback.IsSuccess, bootstrapFallback.Error.Message);
            AssertSeoDescription(hydrationWins.Value!, "hydration taxonomy description");
            AssertSeoDescription(bootstrapFallback.Value!, "bootstrap-only taxonomy description");
        });
    }

    [Fact]
    public async Task ComposeAsync_FilterTaxonomyDescription_FeedsMetaOgTwitterAndJsonLd()
    {
        string root = CreateTempDirectory();
        PublicSpaTemplateLocator.ResetCacheForTests();
        try
        {
            var service = new PublicAotDocumentService(
                new TestWebHostEnvironment(root, Environments.Production),
                new ConfigurationBuilder().Build(),
                new FixedSystemService(),
                new ContextAwareAssetManifest(Path.Combine(root, "wwwroot", "index.html")),
                NullLogger<PublicAotDocumentService>.Instance);
            const string Description = "Category description used by public Filter SEO.";
            Result<string> result = await service.ComposeAsync(CreateFilterEntry(
                PublicRouteIdentity.BuildCategoryRouteKey(7),
                "后端",
                Description));

            Assert.True(result.IsSuccess, result.Error.Message);
            string html = result.Value!;
            string encoded = WebUtility.HtmlEncode(Description);
            Assert.Contains($"name=\"description\" content=\"{encoded}\"", html, StringComparison.Ordinal);
            Assert.Contains($"property=\"og:description\" content=\"{encoded}\"", html, StringComparison.Ordinal);
            Assert.Contains($"name=\"twitter:description\" content=\"{encoded}\"", html, StringComparison.Ordinal);
            Assert.Contains($"\"description\":\"{Description}\"", html, StringComparison.Ordinal);
            Assert.DoesNotContain("SeoDescription", html, StringComparison.Ordinal);
            Assert.DoesNotContain("MetaDescription", html, StringComparison.Ordinal);
        }
        finally
        {
            PublicSpaTemplateLocator.ResetCacheForTests();
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task BuildSeoHeadModelAsync_ArticleAndStaticPageDescriptionsRemainUnchanged()
    {
        await WithServiceAsync(async service =>
        {
            Result<PublicSeoHeadModel> article = await service.BuildSeoHeadModelAsync(new PublicAotShellEntryContract
            {
                PageId = PublicPageId.ArticleDetail,
                RouteKey = PublicRouteIdentity.BuildArticleRouteKey(42),
                ArticleId = 42,
                Title = "Article",
                Html = "<article />",
                RenderLocale = "zh-CN",
                BootstrapPayload = PublicAotBinaryPayload.EncodeObject(new Dictionary<string, object?>
                {
                    ["article"] = new Dictionary<string, object?>
                    {
                        ["summary"] = "Article summary for SEO.",
                        ["content"] = "Unused body"
                    }
                }),
                HydrationPropsPayload = PublicAotBinaryPayload.EncodeObject(new Dictionary<string, object?>
                {
                    ["siteTitle"] = "Fsus Blog",
                    ["siteDescription"] = "Public AOT test"
                })
            });
            Result<PublicSeoHeadModel> about = await service.BuildSeoHeadModelAsync(new PublicAotShellEntryContract
            {
                PageId = PublicPageId.About,
                RouteKey = "about",
                Title = "关于",
                Html = "<main />",
                RenderLocale = "zh-CN",
                HydrationPropsPayload = PublicAotBinaryPayload.EncodeObject(new Dictionary<string, object?>
                {
                    ["siteTitle"] = "Fsus Blog",
                    ["staticPage"] = new Dictionary<string, object?>
                    {
                        ["content"] = "About page content for SEO."
                    }
                })
            });

            Assert.True(article.IsSuccess, article.Error.Message);
            Assert.True(about.IsSuccess, about.Error.Message);
            AssertSeoDescription(article.Value!, "Article summary for SEO.");
            AssertSeoDescription(about.Value!, "About page content for SEO.");
        });
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
                new ContextAwareAssetManifest(Path.Combine(root, "wwwroot", "index.html")),
                logger);

            Result<string> result = await service.ComposeAsync(new PublicAotShellEntryContract
            {
                PageId = PublicPageId.Home,
                RouteKey = "home",
                Html = "<main>Home</main>",
                RenderLocale = "zh-CN",
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
            Assert.Contains("href=\"/src/assets/public-shell-critical.css?direct\"", html, StringComparison.Ordinal);
            Assert.Contains("href=\"/src/assets/tailwind.css?direct\"", html, StringComparison.Ordinal);
            Assert.Contains("/src/assets/public-page.css?direct", html, StringComparison.Ordinal);
            Assert.DoesNotContain("href=\"/src/assets/markdown.css?direct\"", html, StringComparison.Ordinal);
            Assert.DoesNotContain("full-app-core-prod", html, StringComparison.Ordinal);
            Assert.DoesNotContain("route-admin-moderation-prod", html, StringComparison.Ordinal);
        }
        finally
        {
            PublicSpaTemplateLocator.ResetCacheForTests();
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task ComposeAsync_DevelopmentViteProxy_ArticleUsesDirectMarkdownStylesheet()
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
                new ContextAwareAssetManifest(Path.Combine(root, "wwwroot", "index.html")),
                logger);

            Result<string> result = await service.ComposeAsync(new PublicAotShellEntryContract
            {
                PageId = PublicPageId.ArticleDetail,
                RouteKey = PublicRouteIdentity.BuildArticleRouteKey(42),
                ArticleId = 42,
                Html = "<article><p>Article body</p></article>",
                RenderLocale = "zh-CN",
                Title = "Article",
                BootstrapPayload = PublicAotBinaryPayload.EncodeObject(new Dictionary<string, object?>
                {
                    ["kind"] = "ArticleDetail"
                }),
                HydrationPropsPayload = PublicAotBinaryPayload.EncodeObject(new Dictionary<string, object?>
                {
                    ["pageKind"] = "ArticleDetail",
                    ["routeKey"] = PublicRouteIdentity.BuildArticleRouteKey(42),
                    ["title"] = "Article",
                    ["siteTitle"] = "Fsus Blog"
                })
            }, context);

            Assert.True(result.IsSuccess, logger.LastException?.ToString() ?? result.Error.Message);
            string html = result.Value!;
            Assert.Contains("href=\"/src/assets/public-shell-critical.css?direct\"", html, StringComparison.Ordinal);
            Assert.Contains("href=\"/src/assets/tailwind.css?direct\"", html, StringComparison.Ordinal);
            Assert.Contains("href=\"/src/assets/public-page.css?direct\"", html, StringComparison.Ordinal);
            Assert.Contains("href=\"/src/assets/markdown.css?direct\"", html, StringComparison.Ordinal);
            Assert.DoesNotContain("href=\"/src/assets/markdown.css\"", html, StringComparison.Ordinal);
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
            RenderLocale = "zh-CN",
            Title = "Home",
            BootstrapPayload = PublicAotBinaryPayload.EncodeObject(new Dictionary<string, object?>
            {
                ["kind"] = "Home"
            }),
            HydrationPropsPayload = hydrationPayload
        };

    private static async Task WithServiceAsync(Func<PublicAotDocumentService, Task> action)
    {
        string root = CreateTempDirectory();
        PublicSpaTemplateLocator.ResetCacheForTests();
        try
        {
            var service = new PublicAotDocumentService(
                new TestWebHostEnvironment(root, Environments.Production),
                new ConfigurationBuilder().Build(),
                new FixedSystemService(),
                new ContextAwareAssetManifest(Path.Combine(root, "wwwroot", "index.html")),
                NullLogger<PublicAotDocumentService>.Instance);
            await action(service);
        }
        finally
        {
            PublicSpaTemplateLocator.ResetCacheForTests();
            Directory.Delete(root, recursive: true);
        }
    }

    private static async Task AssertFilterDescriptionAsync(
        string routeKey,
        string title,
        string description,
        string expected)
    {
        await WithServiceAsync(async service =>
        {
            Result<PublicSeoHeadModel> result = await service.BuildSeoHeadModelAsync(
                CreateFilterEntry(routeKey, title, description));
            Assert.True(result.IsSuccess, result.Error.Message);
            AssertSeoDescription(result.Value!, expected);
        });
    }

    private static PublicAotShellEntryContract CreateFilterEntry(
        string routeKey,
        string title,
        string? description = null,
        string? hydrationDescription = null,
        string? bootstrapDescription = null,
        bool includeHydrationFilter = true)
    {
        string? resolvedHydration = hydrationDescription ?? description;
        string? resolvedBootstrap = bootstrapDescription ?? description;
        Dictionary<string, object?> hydration = new(StringComparer.Ordinal)
        {
            ["pageKind"] = "Filter",
            ["routeKey"] = routeKey,
            ["title"] = title,
            ["siteTitle"] = "Fsus Blog",
            ["siteDescription"] = "Public AOT test"
        };
        if (includeHydrationFilter)
        {
            hydration["filter"] = CreateFilterPayload(routeKey, title, resolvedHydration);
        }

        return new PublicAotShellEntryContract
        {
            PageId = PublicPageId.Filter,
            RouteKey = routeKey,
            Title = title,
            Html = "<main />",
            RenderLocale = "zh-CN",
            BootstrapPayload = PublicAotBinaryPayload.EncodeObject(new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["pageKind"] = "Filter",
                ["routeKey"] = routeKey,
                ["title"] = title,
                ["filter"] = CreateFilterPayload(routeKey, title, resolvedBootstrap)
            }),
            HydrationPropsPayload = PublicAotBinaryPayload.EncodeObject(hydration)
        };
    }

    private static Dictionary<string, object?> CreateFilterPayload(string routeKey, string title, string? description)
        => new(StringComparer.Ordinal)
        {
            ["filterType"] = routeKey.StartsWith("category:", StringComparison.Ordinal) ? "category" : "tag",
            ["filterKey"] = routeKey,
            ["filterId"] = 1,
            ["filterName"] = title,
            ["description"] = description,
            ["isInvalidTarget"] = false,
            ["pageIndex"] = 1,
            ["pageSize"] = 10,
            ["total"] = 0,
            ["articles"] = Array.Empty<object>()
        };

    private static void AssertSeoDescription(PublicSeoHeadModel head, string expected)
    {
        Assert.Equal(expected, head.Description);
        Assert.Equal(expected, head.OpenGraph.Description);
        Assert.Equal(expected, head.Twitter.Description);
        using JsonDocument document = JsonDocument.Parse(head.JsonLdGraph);
        JsonElement graph = document.RootElement.GetProperty("@graph");
        JsonElement? page = null;
        foreach (JsonElement node in graph.EnumerateArray())
        {
            string? type = node.GetProperty("@type").GetString();
            if (type is "CollectionPage" or "WebPage" or "BlogPosting")
            {
                page = node;
                break;
            }
        }

        Assert.True(page.HasValue, head.JsonLdGraph);
        Assert.Equal(expected, page.Value.GetProperty("description").GetString());
    }

    private sealed class ContextAwareAssetManifest(string indexTemplatePath) : ISpaAssetManifestService
    {
        public IReadOnlyList<string> GetPreloadsForPath(string path, HttpContext? context = null) => [];

        public SpaAssetSet GetPublicAssetSet(HttpContext? context = null, PublicPageId? pageId = null)
        {
            if (IsViteProxy(context))
            {
                string[] stylesheets = pageId == PublicPageId.ArticleDetail
                    ? [
                        "/src/assets/public-shell-critical.css?direct",
                        "/src/assets/tailwind.css?direct",
                        "/src/assets/public-page.css?direct",
                        "/src/assets/markdown.css?direct"
                    ]
                    : [
                        "/src/assets/public-shell-critical.css?direct",
                        "/src/assets/tailwind.css?direct",
                        "/src/assets/public-page.css?direct"
                    ];

                return new SpaAssetSet(
                    "/src/bootstrap/entry.ts",
                    stylesheets,
                    [],
                    "dev-source-assets",
                    UsesSourceAssets: true)
                {
                    FrontendBuildIdentity = "local-unversioned"
                };
            }

            return new SpaAssetSet(
                    "/assets/fsus-spa-entry.js",
                    ["/assets/public-page-prod.css"],
                    [],
                    "prod-manifest",
                    UsesSourceAssets: false)
            {
                FrontendBuildIdentity = "20260727150000-a62dca66e6e8",
                FullAppTakeover = new FullAppTakeoverAssetSet(
                        ["/assets/full-app-core-prod.js"],
                        ["/assets/route-admin-moderation-prod.css"])
            };
        }

        public string GetFrontendAssetVersion(HttpContext? context = null)
            => IsViteProxy(context) ? "dev-source-assets" : "prod-manifest";

        public string GetIndexTemplatePath() => indexTemplatePath;

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
        public Exception? LastException
        {
            get; private set;
        }

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
