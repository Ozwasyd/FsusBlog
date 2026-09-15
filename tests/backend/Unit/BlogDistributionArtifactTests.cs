using System.Diagnostics;
using System.Net;
using System.Text.Json;
using System.Xml.Linq;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Distributed;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Spa;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Distribution;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;

using StackExchange.Redis;
using StackExchange.Redis.Profiling;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class BlogDistributionArtifactTests(
    PostgresSchemaMigrationFixture fixture,
    PublicHotDeliveryRedisFixture redis) : IClassFixture<PublicHotDeliveryRedisFixture>
{
    private static readonly XNamespace s_sitemapNamespace = "http://www.sitemaps.org/schemas/sitemap/0.9";

    [Fact]
    public async Task FeedStaysBoundedWhileFinalSitemapContainsEveryPublicCanonicalUrl()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        int categoryId = db.Insertable(new Category { Name = "SEO" }).ExecuteReturnIdentity();
        int tagId = db.Insertable(new Tag { Name = "canonical" }).ExecuteReturnIdentity();
        var articleIds = new List<int>(55);
        for (int index = 0; index < 55; index++)
        {
            DateTime publishedAt = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddDays(index);
            int articleId = db.Insertable(new Article
            {
                Title = $"Public article {index + 1}",
                Summary = $"Summary {index + 1}",
                CoverImageUrl = $"/uploads/illustration/{index + 1}.webp",
                CategoryId = categoryId,
                CreateTime = publishedAt,
                PublishedAt = publishedAt,
                Status = ArticleStatus.Published,
                IsDeleted = false
            }).ExecuteReturnIdentity();
            articleIds.Add(articleId);
            db.Insertable(new ArticleBody
            {
                ArticleId = articleId,
                MarkdownContent = $"# Body {index + 1}",
                UpdatedAt = publishedAt.AddHours(6)
            }).ExecuteCommand();
            db.Insertable(new ArticleTag { ArticleId = articleId, TagId = tagId }).ExecuteCommand();
        }

        int draftId = db.Insertable(new Article
        {
            Title = "Draft must stay private",
            CategoryId = categoryId,
            CreateTime = DateTime.UtcNow,
            Status = ArticleStatus.Draft,
            IsDeleted = false
        }).ExecuteReturnIdentity();
        db.Insertable(new ArticleBody { ArticleId = draftId, MarkdownContent = "private" }).ExecuteCommand();
        InsertStaticPages(db);

        IUnifiedCache cache = CreateVersionCache("1");
        using var memory = new MemoryCache(new MemoryCacheOptions());
        BlogDistributionService service = CreateService(db, cache, memory);

        string rss = await service.BuildRssAsync();
        JsonFeedDocument jsonFeed = await service.BuildJsonFeedAsync();
        string sitemap = await service.BuildSitemapAsync();
        XDocument sitemapDocument = XDocument.Parse(sitemap);
        string[] locations = sitemapDocument.Descendants(s_sitemapNamespace + "loc")
            .Select(static node => node.Value)
            .ToArray();

        Assert.Equal(50, XDocument.Parse(rss).Descendants("item").Count());
        Assert.Equal(50, jsonFeed.Items.Count);
        Assert.Equal(StaticPageCount + 55 + 1 + 1, locations.Length);
        Assert.Equal(55, locations.Count(static location => location.Contains("/article/", StringComparison.Ordinal)));
        Assert.All(articleIds, id => Assert.Contains($"https://public.example/article/{id}", locations));
        Assert.DoesNotContain($"https://public.example/article/{draftId}", locations);
        Assert.DoesNotContain("/search", sitemap, StringComparison.Ordinal);
        Assert.DoesNotContain("priority", sitemap, StringComparison.OrdinalIgnoreCase);
        Assert.Equal("2026-01-03", ReadLastmod(sitemap, "https://public.example/about"));

        DistributionDiagnosticsCounts diagnostics = await service.GetDiagnosticsCountsAsync();
        Assert.Equal(locations.Length, diagnostics.SitemapUrlCount);
        Assert.Equal(50, diagnostics.FeedItemCount);
    }

    [Fact]
    public async Task ArticleLastmodTracksCurrentPublicRevisionAndEmptySiteNeverInventsCurrentTime()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        int categoryId = db.Insertable(new Category { Name = "Updates" }).ExecuteReturnIdentity();
        DateTime publishedAt = new(2026, 3, 1, 8, 0, 0, DateTimeKind.Utc);
        int articleId = db.Insertable(new Article
        {
            Title = "Updated body",
            CategoryId = categoryId,
            CreateTime = publishedAt,
            MetadataUpdatedAt = publishedAt,
            PublishedAt = publishedAt,
            LastPublishedAt = publishedAt,
            PublicUpdatedAt = new DateTime(2026, 3, 4, 9, 0, 0, DateTimeKind.Utc),
            Status = ArticleStatus.Published,
            IsDeleted = false
        }).ExecuteReturnIdentity();
        db.Insertable(new ArticleBody
        {
            ArticleId = articleId,
            MarkdownContent = "v1",
            UpdatedAt = new DateTime(2026, 3, 4, 9, 0, 0, DateTimeKind.Utc)
        }).ExecuteCommand();

        IUnifiedCache cache = CreateVersionCache("1");
        using var memory = new MemoryCache(new MemoryCacheOptions());
        var generation = new PublicAotInvalidationTracker();
        BlogDistributionService service = CreateService(db, cache, memory, generation);
        string first = await service.BuildSitemapAsync();
        JsonFeedDocument firstFeed = await service.BuildJsonFeedAsync();
        Assert.Equal("2026-03-04", ReadLastmod(first, $"https://public.example/article/{articleId}"));
        Assert.Equal("2026-03-04", ReadFeedModifiedDate(firstFeed, articleId));

        db.Updateable<Article>()
            .SetColumns(article => article.Summary == "Non-body metadata changed")
            .SetColumns(article => article.Views == article.Views + 1)
            .SetColumns(article => article.MetadataUpdatedAt == new DateTime(2026, 3, 7, 11, 0, 0, DateTimeKind.Utc))
            .SetColumns(article => article.PublicUpdatedAt == new DateTime(2026, 3, 7, 11, 0, 0, DateTimeKind.Utc))
            .Where(article => article.Id == articleId)
            .ExecuteCommand();
        db.Insertable(new Comment
        {
            Id = 1,
            ArticleId = articleId,
            Content = "A new public comment must not change article lastmod.",
            CreateTime = new DateTime(2026, 3, 7, 12, 0, 0, DateTimeKind.Utc),
            AuthorMode = "anonymous",
            IsDeleted = false,
            ModerationStatus = CommentModerationStatus.Approved
        }).ExecuteCommand();
        cache.GetStringAsync(CachePolicyId.ArticleListVersion, "main", Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<string?>("2"));
        await CreatePublicAotInvalidationService(generation)
            .InvalidateArticleMutationAsync(articleId, [categoryId], []);
        string metadataOnly = await service.BuildSitemapAsync();
        JsonFeedDocument metadataOnlyFeed = await service.BuildJsonFeedAsync();
        Assert.Equal("2026-03-07", ReadLastmod(metadataOnly, $"https://public.example/article/{articleId}"));
        Assert.Equal("2026-03-07", ReadFeedModifiedDate(metadataOnlyFeed, articleId));

        db.Updateable<ArticleBody>()
            .SetColumns(body => body.MarkdownContent == "v2")
            .SetColumns(body => body.UpdatedAt == new DateTime(2026, 3, 8, 10, 0, 0, DateTimeKind.Utc))
            .Where(body => body.ArticleId == articleId)
            .ExecuteCommand();
        db.Updateable<Article>()
            .SetColumns(article => article.PublicUpdatedAt == new DateTime(2026, 3, 8, 10, 0, 0, DateTimeKind.Utc))
            .Where(article => article.Id == articleId)
            .ExecuteCommand();
        cache.GetStringAsync(CachePolicyId.ArticleListVersion, "main", Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<string?>("3"));
        await CreatePublicAotInvalidationService(generation)
            .InvalidateArticleMutationAsync(articleId, [categoryId], []);
        string second = await service.BuildSitemapAsync();
        JsonFeedDocument secondFeed = await service.BuildJsonFeedAsync();
        Assert.Equal("2026-03-08", ReadLastmod(second, $"https://public.example/article/{articleId}"));
        Assert.Equal("2026-03-08", ReadFeedModifiedDate(secondFeed, articleId));

        using SqlSugarClient emptyDb = await CreateDatabaseAsync();
        using var emptyMemory = new MemoryCache(new MemoryCacheOptions());
        BlogDistributionService emptyService = CreateService(emptyDb, CreateVersionCache("empty"), emptyMemory);
        string emptyFirst = await emptyService.BuildSitemapAsync();
        string emptySecond = await emptyService.BuildSitemapAsync();
        Assert.Equal(emptyFirst, emptySecond);
        Assert.Equal(StaticPageCount, XDocument.Parse(emptyFirst).Descendants(s_sitemapNamespace + "url").Count());
        Assert.Empty(XDocument.Parse(emptyFirst).Descendants(s_sitemapNamespace + "lastmod"));
    }

    [Fact]
    public void SitemapCapacityUsesIndexAndBoundedChildDocuments()
    {
        (string root, IReadOnlyList<string> pages) = BlogDistributionService.BuildSitemapArtifactSetForTests(
            "https://public.example",
            45_001);

        XDocument index = XDocument.Parse(root);
        Assert.Equal("sitemapindex", index.Root?.Name.LocalName);
        Assert.Equal(2, pages.Count);
        Assert.Equal(45_000, XDocument.Parse(pages[0]).Descendants(s_sitemapNamespace + "url").Count());
        Assert.Single(XDocument.Parse(pages[1]).Descendants(s_sitemapNamespace + "url"));
        Assert.Contains("https://public.example/sitemap/1.xml", root, StringComparison.Ordinal);
        Assert.Contains("https://public.example/sitemap/2.xml", root, StringComparison.Ordinal);
    }

    [Fact]
    [Trait("Category", "Performance")]
    public async Task ProductionSitemap45_001Urls_HasBoundedAllocationResidentBytesAndP99()
    {
        const int Samples = 128;
        const int Warmups = 3;
        const int ArticleCount = 44_994;
        const long AllocationBudgetBytes = 256L * 1024 * 1024;
        const long ResidentBudgetBytes = 16L * 1024 * 1024;
        const double P99BudgetMilliseconds = 2_000;
        using SqlSugarClient db = await CreateDatabaseAsync();
        int categoryId = db.Insertable(new Category { Name = "Production benchmark" }).ExecuteReturnIdentity();
        _ = await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO article
                (title, categoryid, views, createtime, metadata_updated_at, status,
                 published_at, last_published_at, public_updated_at, isdeleted)
            SELECT
                'Benchmark article ' || value,
                @CategoryId,
                0,
                CAST('2026-01-01T00:00:00Z' AS timestamp) + value * INTERVAL '1 second',
                CAST('2026-01-01T00:00:00Z' AS timestamp) + value * INTERVAL '1 second',
                @PublishedStatus,
                CAST('2026-01-01T00:00:00Z' AS timestamp) + value * INTERVAL '1 second',
                CAST('2026-01-01T00:00:00Z' AS timestamp) + value * INTERVAL '1 second',
                CAST('2026-01-01T00:00:00Z' AS timestamp) + value * INTERVAL '1 second',
                false
            FROM generate_series(1, @ArticleCount) AS value;
            """,
            new SugarParameter("@CategoryId", categoryId),
            new SugarParameter("@PublishedStatus", (int)ArticleStatus.Published),
            new SugarParameter("@ArticleCount", ArticleCount));
        var elapsedMilliseconds = new double[Samples];
        var allocationBytes = new long[Samples];
        long residentBytes = 0;

        for (int sample = -Warmups; sample < Samples; sample++)
        {
            using var memory = new MemoryCache(new MemoryCacheOptions());
            var artifacts = new SitemapArtifactCache(new PublicAotInvalidationTracker());
            BlogDistributionService service = CreateService(
                db,
                Substitute.For<ICacheStringReader>(),
                memory,
                artifacts: artifacts);
            long allocatedBefore = GC.GetTotalAllocatedBytes(precise: true);
            long startedAt = Stopwatch.GetTimestamp();
            _ = await service.BuildSitemapAsync();
            TimeSpan elapsed = Stopwatch.GetElapsedTime(startedAt);
            long allocated = GC.GetTotalAllocatedBytes(precise: true) - allocatedBefore;
            SitemapArtifactCacheSnapshot snapshot = artifacts.Snapshot();
            DistributionDiagnosticsCounts diagnostics = await service.GetDiagnosticsCountsAsync();
            Assert.Equal(45_001, diagnostics.SitemapUrlCount);
            if (sample < 0)
            {
                continue;
            }

            elapsedMilliseconds[sample] = elapsed.TotalMilliseconds;
            allocationBytes[sample] = allocated;
            residentBytes = snapshot.ResidentBytes;
        }

        Array.Sort(elapsedMilliseconds);
        double p99 = elapsedMilliseconds[(int)Math.Ceiling(Samples * 0.99d) - 1];
        long maxAllocation = allocationBytes.Max();
        Console.WriteLine(
            $"[sitemap-production] urls=45001 warmups={Warmups} samples={Samples} "
            + $"p99Ms={p99:F2} maxAllocationBytes={maxAllocation} residentBytes={residentBytes}");
        Assert.True(p99 <= P99BudgetMilliseconds, $"sitemap p99 {p99:F2}ms exceeds {P99BudgetMilliseconds:F0}ms");
        Assert.True(maxAllocation <= AllocationBudgetBytes, $"sitemap allocation {maxAllocation} exceeds {AllocationBudgetBytes}");
        Assert.True(residentBytes <= ResidentBudgetBytes, $"sitemap resident bytes {residentBytes} exceeds {ResidentBudgetBytes}");
    }

    [Fact]
    public async Task SitemapColdMissIsProcessWideSingleflightAndFollowingHitExecutesNoRedisOrDatabaseCommands()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        int commandCount = 0;
        db.Aop.OnLogExecuting = (_, _) => Interlocked.Increment(ref commandCount);
        var generation = new PublicAotInvalidationTracker();
        var artifacts = new SitemapArtifactCache(generation);
        ISystemService system = Substitute.For<ISystemService>();
        IUnifiedCache redis = Substitute.For<IUnifiedCache>();
        IConfiguration configuration = CreateConfiguration("https://public.example");
        using var memory = new MemoryCache(new MemoryCacheOptions());
        BlogDistributionService[] services = Enumerable.Range(0, 100)
            .Select(_ => new BlogDistributionService(db, system, redis, memory, configuration, artifacts))
            .ToArray();

        Task<string>[] requests = services.Select(static service => service.BuildSitemapAsync()).ToArray();
        string[] documents = await Task.WhenAll(requests);

        Assert.All(documents, document => Assert.Equal(documents[0], document));
        Assert.Equal(4, commandCount);
        await system.DidNotReceive().GetSeoConfigAsync();
        await redis.DidNotReceiveWithAnyArgs().GetStringAsync(default, default!, default);

        commandCount = 0;
        Assert.Equal(documents[0], await services[0].BuildSitemapAsync());
        Assert.Equal(0, commandCount);
        await system.DidNotReceive().GetSeoConfigAsync();
        SitemapArtifactCacheSnapshot snapshot = artifacts.Snapshot();
        Assert.Equal(1, snapshot.ArtifactCount);
        Assert.True(snapshot.ResidentBytes > 0);
    }

    [Fact]
    public async Task KestrelWithoutOutputCache_ColdRequestUsesFourPostgresCommandsAndHitUsesNoExternalCommand()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        int dbCommands = 0;
        db.Aop.OnLogExecuting = (_, _) => Interlocked.Increment(ref dbCommands);
        await using ConnectionMultiplexer connection = await redis.ConnectAsync();
        var redisProfile = new ProfilingSession();
        connection.RegisterProfiler(() => redisProfile);
        string prefix = $"test:sitemap-kestrel:{Guid.CreateVersion7():N}:";
        var scope = new PrefixRuntimeKeyScope(prefix);
        var unifiedCache = new UnifiedCache(
            connection,
            new CachePolicyRegistry(),
            scope,
            Microsoft.Extensions.Logging.Abstractions.NullLogger<UnifiedCache>.Instance);
        var artifacts = new SitemapArtifactCache(new PublicAotInvalidationTracker());
        using var memory = new MemoryCache(new MemoryCacheOptions());
        BlogDistributionService service = CreateService(
            db,
            unifiedCache,
            memory,
            generation: null,
            artifacts: artifacts);
        WebApplicationBuilder builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            EnvironmentName = Environments.Production
        });
        builder.Configuration["AllowedHosts"] = "127.0.0.1;localhost";
        builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, 0));
        builder.Services.AddRouting();
        builder.Services.AddOutputCache();
        builder.Services.AddSingleton(service);
        WebApplication app = builder.Build();
        app.MapDistributionEndpoints();
        await app.StartAsync();
        try
        {
            string address = app.Services
                .GetRequiredService<Microsoft.AspNetCore.Hosting.Server.IServer>()
                .Features
                .Get<IServerAddressesFeature>()!
                .Addresses
                .Single();
            using var client = new HttpClient(new HttpClientHandler { UseProxy = false })
            {
                BaseAddress = new Uri(address),
                Timeout = TimeSpan.FromSeconds(10)
            };
            _ = redisProfile.FinishProfiling().ToArray();

            using HttpResponseMessage cold = await client.GetAsync("/sitemap.xml");
            string coldBody = await cold.Content.ReadAsStringAsync();
            string[] coldRedis = redisProfile.FinishProfiling().Select(static command => command.Command).ToArray();

            Assert.Equal(HttpStatusCode.OK, cold.StatusCode);
            Assert.Contains("<urlset", coldBody, StringComparison.Ordinal);
            Assert.Equal(4, dbCommands);
            Assert.Empty(coldRedis);
            Assert.Equal(1, artifacts.Snapshot().BuildCount);

            dbCommands = 0;
            using HttpResponseMessage hit = await client.GetAsync("/sitemap.xml");
            string hitBody = await hit.Content.ReadAsStringAsync();
            string[] hitRedis = redisProfile.FinishProfiling().Select(static command => command.Command).ToArray();

            Assert.Equal(HttpStatusCode.OK, hit.StatusCode);
            Assert.Equal(coldBody, hitBody);
            Assert.Equal(0, dbCommands);
            Assert.Empty(hitRedis);
            Assert.Equal(1, artifacts.Snapshot().BuildCount);
        }
        finally
        {
            await app.StopAsync();
            await app.DisposeAsync();
            await redis.DeleteNamespaceAsync(prefix);
        }
    }

    [Fact]
    public async Task FullKestrelRuntimeEvidence_ExposesSitemapSnapshotAndInternalL1Source()
    {
        const string Secret = "runtime-cache-sitemap-snapshot-secret";
        using SqlSugarClient db = await CreateDatabaseAsync();
        await using ConnectionMultiplexer connection = await redis.ConnectAsync();
        string prefix = $"test:sitemap-runtime-evidence:{Guid.CreateVersion7():N}:";
        var scope = new PrefixRuntimeKeyScope(prefix);
        var policies = new CachePolicyRegistry();
        using var unifiedCache = new UnifiedCache(
            connection,
            policies,
            scope,
            NullLogger<UnifiedCache>.Instance);
        using var singleFlight = new CacheSingleFlightCoordinator(
            new CacheKeyResolver(policies, scope, NullLogger<CacheKeyResolver>.Instance));
        var artifacts = new SitemapArtifactCache(new PublicAotInvalidationTracker());
        using var memory = new MemoryCache(new MemoryCacheOptions());
        BlogDistributionService service = CreateService(
            db,
            unifiedCache,
            memory,
            generation: null,
            artifacts: artifacts);
        WebApplicationBuilder builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            EnvironmentName = "Test"
        });
        builder.Configuration[RuntimeCacheEvidenceMiddleware.SecretConfigurationKey] = Secret;
        builder.Configuration["AllowedHosts"] = "127.0.0.1;localhost";
        builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, 0));
        builder.Services.AddRouting();
        builder.Services.AddOutputCache();
        builder.Services.AddSingleton(service);
        builder.Services.AddSingleton(artifacts);
        builder.Services.AddSingleton<RuntimeCacheEvidenceStore>();
        builder.Services.AddSingleton<ICacheDiagnostics>(unifiedCache);
        builder.Services.AddSingleton<ICacheSingleFlightCoordinator>(singleFlight);
        WebApplication app = builder.Build();
        app.UseMiddleware<RuntimeCacheEvidenceMiddleware>();
        app.UseOutputCache();
        app.MapDistributionEndpoints();
        app.MapRuntimeCacheEvidenceEndpoints();
        await app.StartAsync();
        try
        {
            string address = app.Services
                .GetRequiredService<Microsoft.AspNetCore.Hosting.Server.IServer>()
                .Features
                .Get<IServerAddressesFeature>()!
                .Addresses
                .Single();
            using var client = new HttpClient(new HttpClientHandler { UseProxy = false })
            {
                BaseAddress = new Uri(address),
                Timeout = TimeSpan.FromSeconds(15)
            };

            JsonElement build = await ObserveRuntimeRequestAsync(
                client,
                "/sitemap.xml?runtime-cache-probe=build",
                "sitemap-build-0001",
                Secret);
            JsonElement hit = await ObserveRuntimeRequestAsync(
                client,
                "/sitemap.xml?runtime-cache-probe=hit",
                "sitemap-hit-0001",
                Secret);

            Assert.Equal("database", build.GetProperty("layerSource").GetString());
            Assert.Equal("l1-object", hit.GetProperty("layerSource").GetString());
            Assert.Equal(0, hit.GetProperty("databaseCommandCount").GetInt32());
            Assert.Empty(hit.GetProperty("redisCommands").EnumerateArray());

            using HttpResponseMessage forbidden = await client.GetAsync(
                "/_fsus/testing/runtime-cache/runtime-snapshot");
            Assert.Equal(HttpStatusCode.Forbidden, forbidden.StatusCode);

            using var snapshotRequest = new HttpRequestMessage(
                HttpMethod.Get,
                "/_fsus/testing/runtime-cache/runtime-snapshot");
            snapshotRequest.Headers.TryAddWithoutValidation(
                RuntimeCacheEvidenceMiddleware.SecretHeader,
                Secret);
            using HttpResponseMessage snapshotResponse = await client.SendAsync(snapshotRequest);
            snapshotResponse.EnsureSuccessStatusCode();
            await using Stream snapshotPayload = await snapshotResponse.Content.ReadAsStreamAsync();
            using JsonDocument snapshotDocument = await JsonDocument.ParseAsync(snapshotPayload);
            JsonElement sitemap = snapshotDocument.RootElement.GetProperty("sitemap");
            Assert.Equal(0, sitemap.GetProperty("generation").GetInt64());
            Assert.Equal(1, sitemap.GetProperty("artifactCount").GetInt32());
            Assert.True(sitemap.GetProperty("residentBytes").GetInt64() > 0);
            Assert.Equal(1, sitemap.GetProperty("buildCount").GetInt64());
        }
        finally
        {
            await app.StopAsync();
            await app.DisposeAsync();
            await redis.DeleteNamespaceAsync(prefix);
        }
    }

    [Fact]
    public async Task PublicOriginMutationAdvancesGenerationAndReplacesEverySitemapDocument()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        db.Insertable(new SystemConfig { Key = "Seo_BaseUrl", Value = "https://origin-a.example" }).ExecuteCommand();
        var generation = new PublicAotInvalidationTracker();
        var artifacts = new SitemapArtifactCache(generation);
        ISystemService system = Substitute.For<ISystemService>();
        IUnifiedCache redis = Substitute.For<IUnifiedCache>();
        IConfiguration configuration = new ConfigurationBuilder().Build();
        using var memory = new MemoryCache(new MemoryCacheOptions());
        var service = new BlogDistributionService(db, system, redis, memory, configuration, artifacts);

        string first = await service.BuildSitemapAsync();
        db.Updateable<SystemConfig>()
            .SetColumns(config => config.Value == "https://origin-b.example")
            .Where(config => config.Key == "Seo_BaseUrl")
            .ExecuteCommand();
        await CreatePublicAotInvalidationService(generation).InvalidateSeoAsync();
        long nextGeneration = generation.GetSitemapGeneration();
        string second = await service.BuildSitemapAsync();

        Assert.Contains("https://origin-a.example/", first, StringComparison.Ordinal);
        Assert.DoesNotContain("https://origin-a.example/", second, StringComparison.Ordinal);
        Assert.Contains("https://origin-b.example/", second, StringComparison.Ordinal);
        Assert.Equal(nextGeneration, artifacts.Snapshot().Generation);
        await system.DidNotReceive().GetSeoConfigAsync();
        await redis.DidNotReceiveWithAnyArgs().GetStringAsync(default, default!, default);
    }

    [Theory]
    [InlineData("seo", DistributedInvalidationEventKinds.SeoMutation)]
    [InlineData("compliance", DistributedInvalidationEventKinds.ComplianceMutation)]
    [InlineData("system-page", DistributedInvalidationEventKinds.SystemPageMutation)]
    public async Task SystemMutationPublishFailure_CommitsDbButInvalidatesSourceArtifactExactlyOnce(
        string mutation,
        string expectedEventKind)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var authority = new InMemoryPublicAotInvalidationGenerationAuthority();
        var generation = new PublicAotInvalidationTracker(authority);
        var shell = Substitute.For<IPublicAotShellCache>();
        PublicAotInvalidationService publicAot = CreatePublicAotInvalidationService(generation, shell);
        var publisher = Substitute.For<IDistributedInvalidationPublisher>();
        DistributedInvalidationRequest? observed = null;
        publisher.PublishAsync(Arg.Any<DistributedInvalidationRequest>(), Arg.Any<CancellationToken>())
            .Returns<Task<DistributedInvalidationPublishResult>>(call =>
            {
                observed = call.Arg<DistributedInvalidationRequest>();
                throw new InvalidOperationException("publish-failed");
            });
        var cache = Substitute.For<IUnifiedCache>();
        var dispatcher = new CacheInvalidationDispatcher(
            cache,
            cache,
            Substitute.For<IHttpCacheInvalidator>(),
            distributedInvalidationPublisher: publisher,
            publicAotInvalidationTracker: generation);
        var system = new SystemService(
            db,
            cache,
            cache,
            cache,
            Substitute.For<ICacheMissCoordinator>(),
            Substitute.For<IDbConcurrencyGate>(),
            NullLogger<SystemService>.Instance,
            publicAot,
            Substitute.For<IMessageRealtimePublisher>(),
            dispatcher);
        var artifacts = new SitemapArtifactCache(generation);
        int builds = 0;
        _ = await artifacts.GetOrBuildAsync(
            _ => Task.FromResult(new SitemapArtifactBuildResult(
                new SitemapArtifactSet($"root-{++builds}", []),
                AllocationBytes: 1)),
            CancellationToken.None);

        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() => mutation switch
        {
            "seo" => system.UpdateSeoConfigAsync(new UpdateSeoConfigRequest
            {
                Title = "Committed SEO",
                BaseUrl = "https://committed.example"
            }),
            "compliance" => system.UpdateSiteComplianceConfigAsync(new UpdateSiteComplianceConfigRequest
            {
                Enabled = true,
                RegionMode = "global"
            }),
            "system-page" => system.UpdatePageContentAsync(new UpdatePageContentRequest
            {
                Slug = "about",
                Content = "Committed about page"
            }),
            _ => throw new ArgumentOutOfRangeException(nameof(mutation), mutation, null)
        });
        SitemapArtifactSet rebuilt = await artifacts.GetOrBuildAsync(
            _ => Task.FromResult(new SitemapArtifactBuildResult(
                new SitemapArtifactSet($"root-{++builds}", []),
                AllocationBytes: 1)),
            CancellationToken.None);

        Assert.Equal("publish-failed", failure.Message);
        Assert.Equal(1, authority.Current.AllGeneration);
        Assert.Equal(1, rebuilt.Generation);
        Assert.Equal(2, builds);
        Assert.NotNull(observed);
        Assert.Equal(expectedEventKind, observed.Kind);
        Assert.Equal(authority.Current.LastMutationId, observed.EventId);
        if (mutation == "system-page")
        {
            await shell.DidNotReceive().InvalidateAllAsync(Arg.Any<CancellationToken>());
            await shell.Received(1).RemoveManyAsync(
                Arg.Is<IReadOnlyCollection<string>>(keys => keys.Count == 1),
                Arg.Any<CancellationToken>());
        }
        else
        {
            await shell.Received(1).InvalidateAllAsync(Arg.Any<CancellationToken>());
        }
        Assert.True(mutation switch
        {
            "seo" => db.Queryable<SystemConfig>().Any(config =>
                config.Key == "Seo_Title" && config.Value == "Committed SEO"),
            "compliance" => db.Queryable<SystemConfig>().Any(config =>
                config.Key == "Compliance_Enabled" && config.Value == "true"),
            "system-page" => db.Queryable<PageContent>().Any(page =>
                page.Slug == "about" && page.Content == "Committed about page"),
            _ => false
        });
    }

    [Theory]
    [InlineData("seo", DistributedInvalidationEventKinds.SeoMutation)]
    [InlineData("compliance", DistributedInvalidationEventKinds.ComplianceMutation)]
    [InlineData("system-page", DistributedInvalidationEventKinds.SystemPageMutation)]
    public async Task SystemMutation_AdvancesSitemapOnceAndPreservesTargetedAotInvalidation(
        string mutation,
        string expectedEventKind)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var authority = new InMemoryPublicAotInvalidationGenerationAuthority();
        var generation = new PublicAotInvalidationTracker(authority);
        var shell = Substitute.For<IPublicAotShellCache>();
        PublicAotInvalidationService publicAot = CreatePublicAotInvalidationService(generation, shell);
        var publisher = Substitute.For<IDistributedInvalidationPublisher>();
        DistributedInvalidationRequest? observed = null;
        bool identityBoundAtPublish = false;
        publisher.PublishAsync(Arg.Any<DistributedInvalidationRequest>(), Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                observed = call.Arg<DistributedInvalidationRequest>();
                identityBoundAtPublish = string.Equals(
                    authority.Current.LastMutationId,
                    observed.EventId,
                    StringComparison.Ordinal);
                return new DistributedInvalidationPublishResult(
                    DistributedInvalidationPublishStatus.LocalOnly,
                    observed.EventId,
                    null);
            });
        var cache = Substitute.For<IUnifiedCache>();
        var dispatcher = new CacheInvalidationDispatcher(
            cache,
            cache,
            Substitute.For<IHttpCacheInvalidator>(),
            distributedInvalidationPublisher: publisher,
            publicAotInvalidationTracker: generation);
        var system = new SystemService(
            db,
            cache,
            cache,
            cache,
            Substitute.For<ICacheMissCoordinator>(),
            Substitute.For<IDbConcurrencyGate>(),
            NullLogger<SystemService>.Instance,
            publicAot,
            Substitute.For<IMessageRealtimePublisher>(),
            dispatcher);

        switch (mutation)
        {
            case "seo":
                await system.UpdateSeoConfigAsync(new UpdateSeoConfigRequest
                {
                    Title = "Committed SEO",
                    BaseUrl = "https://committed.example"
                });
                break;
            case "compliance":
                await system.UpdateSiteComplianceConfigAsync(new UpdateSiteComplianceConfigRequest
                {
                    Enabled = true,
                    RegionMode = "global"
                });
                break;
            case "system-page":
                Assert.True(await system.UpdatePageContentAsync(new UpdatePageContentRequest
                {
                    Slug = "about",
                    Content = "Committed about page"
                }));
                break;
            default:
                throw new ArgumentOutOfRangeException(nameof(mutation), mutation, null);
        }

        Assert.Equal(1, generation.GetSitemapGeneration());
        Assert.NotNull(observed);
        Assert.Equal(expectedEventKind, observed.Kind);
        Assert.True(identityBoundAtPublish);
        if (mutation == "system-page")
        {
            Assert.DoesNotContain(
                PublicAotInvalidationGenerationStateCodec.AllCoordinate,
                authority.Current.KeyGenerations.Keys);
            Assert.Contains(
                PublicAotInvalidationGenerationStateCodec.SitemapCoordinate,
                authority.Current.KeyGenerations.Keys);
            await shell.DidNotReceive().InvalidateAllAsync(Arg.Any<CancellationToken>());
            await shell.Received(1).RemoveManyAsync(
                Arg.Is<IReadOnlyCollection<string>>(keys => keys.Count == 1),
                Arg.Any<CancellationToken>());
        }
        else
        {
            Assert.Contains(
                PublicAotInvalidationGenerationStateCodec.AllCoordinate,
                authority.Current.KeyGenerations.Keys);
            await shell.Received(1).InvalidateAllAsync(Arg.Any<CancellationToken>());
        }
    }

    private const int StaticPageCount = 6;

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(Category),
            typeof(Tag),
            typeof(Article),
            typeof(ArticleBody),
            typeof(ArticleTag),
            typeof(Comment),
            typeof(PageContent),
            typeof(SystemConfig));
        return db;
    }

    private static BlogDistributionService CreateService(
        ISqlSugarClient db,
        ICacheStringReader cache,
        IMemoryCache memory,
        PublicAotInvalidationTracker? generation = null,
        SitemapArtifactCache? artifacts = null)
    {
        ISystemService system = Substitute.For<ISystemService>();
        system.GetSeoConfigAsync().Returns(Task.FromResult(new SeoConfigReadModel
        {
            Title = "Public site",
            Description = "Public description",
            Author = "Author",
            BaseUrl = "https://public.example"
        }));
        system.GetSiteComplianceConfigAsync().Returns(Task.FromResult(new SiteComplianceConfigReadModel()));
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Seo:BaseUrl"] = "https://public.example"
            })
            .Build();
        return new BlogDistributionService(
            db,
            system,
            cache,
            memory,
            configuration,
            artifacts ?? new SitemapArtifactCache(generation ?? new PublicAotInvalidationTracker()));
    }

    private static IConfiguration CreateConfiguration(string baseUrl)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Seo:BaseUrl"] = baseUrl
            })
            .Build();

    private static async Task<JsonElement> ObserveRuntimeRequestAsync(
        HttpClient client,
        string path,
        string requestId,
        string secret)
    {
        using (var request = new HttpRequestMessage(HttpMethod.Get, path))
        {
            request.Headers.TryAddWithoutValidation(
                RuntimeCacheEvidenceMiddleware.RequestIdHeader,
                requestId);
            request.Headers.TryAddWithoutValidation(
                RuntimeCacheEvidenceMiddleware.SecretHeader,
                secret);
            using HttpResponseMessage response = await client.SendAsync(request);
            response.EnsureSuccessStatusCode();
        }

        using var observationRequest = new HttpRequestMessage(
            HttpMethod.Get,
            $"/_fsus/testing/runtime-cache/observations/{requestId}");
        observationRequest.Headers.TryAddWithoutValidation(
            RuntimeCacheEvidenceMiddleware.SecretHeader,
            secret);
        using HttpResponseMessage observationResponse = await client.SendAsync(observationRequest);
        observationResponse.EnsureSuccessStatusCode();
        await using Stream payload = await observationResponse.Content.ReadAsStreamAsync();
        using JsonDocument document = await JsonDocument.ParseAsync(payload);
        return document.RootElement.Clone();
    }

    private static PublicAotInvalidationService CreatePublicAotInvalidationService(
        PublicAotInvalidationTracker generation,
        IPublicAotShellCache? shell = null)
    {
        var manifest = Substitute.For<IPublicAotRouteManifestProvider>();
        manifest.ListRoutesAsync(Arg.Any<PublicAotRouteManifestScope>(), Arg.Any<CancellationToken>())
            .Returns(Array.Empty<PublicAotRouteDescriptor>());
        var scheduler = Substitute.For<IPublicAotBackfillScheduler>();
        scheduler.TrySchedule(Arg.Any<PublicAotBackfillRequest>()).Returns(true);
        var testScope = Substitute.For<ITestSessionKeyScope>();
        testScope.PrefixKey(Arg.Any<string>()).Returns(call => call.Arg<string>());
        var assets = Substitute.For<ISpaAssetManifestService>();
        assets.GetFrontendAssetVersion(Arg.Any<Microsoft.AspNetCore.Http.HttpContext?>()).Returns("sitemap-test-assets");
        return new PublicAotInvalidationService(
            shell ?? Substitute.For<IPublicAotShellCache>(),
            new PrefixRuntimeKeyScope(string.Empty),
            generation,
            scheduler,
            manifest,
            new PublicHotReadStore(),
            testScope,
            assets,
            new PublicAotSsrRuntimeState(new ConfigurationBuilder().Build()),
            NullLogger<PublicAotInvalidationService>.Instance);
    }

    private static IUnifiedCache CreateVersionCache(string version)
    {
        IUnifiedCache cache = Substitute.For<IUnifiedCache>();
        cache.GetStringAsync(CachePolicyId.ArticleListVersion, "main", Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<string?>(version));
        return cache;
    }

    private static void InsertStaticPages(SqlSugarClient db)
    {
        db.Insertable(new[]
        {
            new PageContent { Slug = "about", Content = "About", UpdatedAt = new DateTime(2026, 1, 3, 0, 0, 0, DateTimeKind.Utc) },
            new PageContent { Slug = "privacy", Content = "Privacy", UpdatedAt = new DateTime(2026, 1, 4, 0, 0, 0, DateTimeKind.Utc) },
            new PageContent { Slug = "guidelines", Content = "Guidelines", UpdatedAt = new DateTime(2026, 1, 5, 0, 0, 0, DateTimeKind.Utc) },
            new PageContent { Slug = "copyright", Content = "Copyright", UpdatedAt = new DateTime(2026, 1, 6, 0, 0, 0, DateTimeKind.Utc) }
        }).ExecuteCommand();
    }

    private sealed class PrefixRuntimeKeyScope(string prefix) : IRuntimeKeyScope
    {
        public string ScopeToken => prefix;
        public string PrefixKey(string key) => string.Concat(prefix, key);
    }

    private static string? ReadLastmod(string sitemap, string location)
    {
        XElement? url = XDocument.Parse(sitemap)
            .Descendants(s_sitemapNamespace + "url")
            .SingleOrDefault(node => string.Equals(
                node.Element(s_sitemapNamespace + "loc")?.Value,
                location,
                StringComparison.Ordinal));
        return url?.Element(s_sitemapNamespace + "lastmod")?.Value;
    }

    private static string ReadFeedModifiedDate(JsonFeedDocument feed, int articleId)
        => feed.Items
            .Single(item => string.Equals(item.Id, articleId.ToString(System.Globalization.CultureInfo.InvariantCulture), StringComparison.Ordinal))
            .DateModified
            .ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
}
