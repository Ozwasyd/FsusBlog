using System.Collections.Concurrent;
using System.Text.Json;

using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Distributed;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.Spa;
using FsusBlog.Server.Services.Distribution;

using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using StackExchange.Redis;

namespace FsusBlog.Server.Tests;

[CollectionDefinition(nameof(PublicAotInvalidationGenerationRedisCollection))]
public sealed class PublicAotInvalidationGenerationRedisCollection :
    ICollectionFixture<PublicHotDeliveryRedisFixture>;

[Collection(nameof(PublicAotInvalidationGenerationRedisCollection))]
[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
public sealed class PublicAotInvalidationGenerationIntegrationTests(
    PublicHotDeliveryRedisFixture redis)
{
    [Fact]
    public async Task SitemapGeneration_FreshHostProcessLoadsDurableRedisCoordinateAndRejectsGenerationZero()
    {
        string prefix = $"test:sitemap-process-restart:{Guid.CreateVersion7():N}:";
        using var temp = new TemporaryDirectory();
        try
        {
            await using ConnectionMultiplexer connection = await redis.ConnectAsync();
            var scope = new PrefixRuntimeKeyScope(prefix);
            var tracker = new PublicAotInvalidationTracker(CreateAuthority(connection, scope, temp));
            await tracker.InitializeAsync(CancellationToken.None);
            _ = await tracker.MarkSitemapAsync("taxonomy:before-process-restart");
            long durableGeneration = tracker.GetSitemapGeneration();

            await using var child = new CacheCoordinationProcessProbe.Child(
                redis.ConnectionString,
                "unused",
                prefix,
                "sitemap-restart",
                1);
            await child.ReadyAsync();
            await child.GoAsync();
            using JsonDocument completed = await child.ReadAsync("complete");
            await child.FinishAsync();

            Assert.Equal(durableGeneration, completed.RootElement.GetProperty("generation").GetInt64());
            Assert.Equal(durableGeneration, completed.RootElement.GetProperty("artifactGeneration").GetInt64());
            Assert.NotEqual(0, completed.RootElement.GetProperty("artifactGeneration").GetInt64());
            Assert.Equal("child-process-sitemap", completed.RootElement.GetProperty("root").GetString());
            Assert.Contains("pid=", child.Identity, StringComparison.Ordinal);
        }
        finally
        {
            await redis.DeleteNamespaceAsync(prefix);
        }
    }

    [Fact]
    public async Task TaxonomyPublishFailure_RealRedisGenerationInvalidatesSourceAndRestartRejectsOldArtifact()
    {
        string prefix = $"test:sitemap-taxonomy-source:{Guid.CreateVersion7():N}:";
        using var temp = new TemporaryDirectory();
        try
        {
            await using ConnectionMultiplexer connection = await redis.ConnectAsync();
            var scope = new PrefixRuntimeKeyScope(prefix);
            RedisPublicAotInvalidationGenerationAuthority authority = CreateAuthority(connection, scope, temp);
            var tracker = new PublicAotInvalidationTracker(authority);
            await tracker.InitializeAsync(CancellationToken.None);
            var sitemap = new SitemapArtifactCache(tracker);
            int builds = 0;
            SitemapArtifactSet oldArtifact = await sitemap.GetOrBuildAsync(
                _ => Task.FromResult(BuildSitemapArtifact(++builds)),
                CancellationToken.None);
            DistributedInvalidationRequest? observed = null;
            var publisher = Substitute.For<IDistributedInvalidationPublisher>();
            publisher.PublishAsync(Arg.Any<DistributedInvalidationRequest>(), Arg.Any<CancellationToken>())
                .Returns<Task<DistributedInvalidationPublishResult>>(call =>
                {
                    observed = call.Arg<DistributedInvalidationRequest>();
                    throw new InvalidOperationException("redis-publish-failed");
                });
            using var cache = new UnifiedCache(
                connection,
                new CachePolicyRegistry(),
                scope,
                NullLogger<UnifiedCache>.Instance);
            var dispatcher = new CacheInvalidationDispatcher(
                cache,
                cache,
                Substitute.For<IHttpCacheInvalidator>(),
                distributedInvalidationPublisher: publisher,
                publicAotInvalidationTracker: tracker);

            _ = await Assert.ThrowsAsync<InvalidOperationException>(
                () => dispatcher.InvalidateCategoryTagAsync());
            SitemapArtifactSet rebuilt = await sitemap.GetOrBuildAsync(
                _ => Task.FromResult(BuildSitemapArtifact(++builds)),
                CancellationToken.None);
            PublicAotInvalidationGenerationState durable = await authority.LoadAsync(CancellationToken.None);

            Assert.NotNull(observed);
            Assert.Equal(observed.EventId, durable.LastMutationId);
            Assert.Equal(1, durable.AllGeneration);
            Assert.Equal(0, oldArtifact.Generation);
            Assert.Equal(1, rebuilt.Generation);
            Assert.Equal("root-2", rebuilt.RootDocument);
            Assert.Equal(2, builds);

            var restarted = new PublicAotInvalidationTracker(CreateAuthority(connection, scope, temp));
            await restarted.InitializeAsync(CancellationToken.None);
            var restartedSitemap = new SitemapArtifactCache(restarted);
            SitemapArtifactSet afterRestart = await restartedSitemap.GetOrBuildAsync(
                _ => Task.FromResult(new SitemapArtifactBuildResult(
                    new SitemapArtifactSet("root-after-restart", []),
                    AllocationBytes: 1)),
                CancellationToken.None);
            Assert.Equal(durable.AllGeneration, afterRestart.Generation);
            Assert.NotEqual(oldArtifact.RootDocument, afterRestart.RootDocument);
        }
        finally
        {
            await redis.DeleteNamespaceAsync(prefix);
        }
    }

    private static SitemapArtifactBuildResult BuildSitemapArtifact(int version)
        => new(new SitemapArtifactSet($"root-{version}", []), AllocationBytes: 1);

    [Fact]
    public async Task SitemapCurrentGenerationHit_SurvivesRealRedisDisconnectWithoutRebuild()
    {
        string prefix = $"test:sitemap-redis-outage:{Guid.CreateVersion7():N}:";
        using var temp = new TemporaryDirectory();
        ConnectionMultiplexer connection = await redis.ConnectAsync();
        try
        {
            var scope = new PrefixRuntimeKeyScope(prefix);
            var tracker = new PublicAotInvalidationTracker(CreateAuthority(connection, scope, temp));
            await tracker.InitializeAsync(CancellationToken.None);
            var sitemap = new SitemapArtifactCache(tracker);
            int builds = 0;
            SitemapArtifactSet beforeOutage = await sitemap.GetOrBuildAsync(
                _ => Task.FromResult(BuildSitemapArtifact(++builds)),
                CancellationToken.None);

            await connection.DisposeAsync();
            SitemapArtifactSet duringOutage = await sitemap.GetOrBuildAsync(
                _ => Task.FromResult(BuildSitemapArtifact(++builds)),
                CancellationToken.None);

            Assert.Same(beforeOutage, duringOutage);
            Assert.Equal(1, builds);
            await Assert.ThrowsAnyAsync<Exception>(() => tracker.MarkAllAsync("mutation-during-outage"));
            Assert.Equal(beforeOutage.Generation, sitemap.Snapshot().Generation);
        }
        finally
        {
            connection.Dispose();
            await redis.DeleteNamespaceAsync(prefix);
        }
    }

    [Fact]
    public async Task RendererFailure_PreservesVerifiedFileAndRedisArtifacts()
    {
        const string FrontendAssetVersion = "frontend-v1";
        const string VerifiedHtml = "<!doctype html><html><body>verified-before-render-failure</body></html>";
        using var temp = new TemporaryDirectory();
        await using ConnectionMultiplexer connection = await redis.ConnectAsync();
        var match = new PublicAotRouteMatch(
            PublicPageKind.ArticleDetail,
            PublicPageId.ArticleDetail,
            "article:1792",
            "/article/1792",
            "/article/1792",
            string.Empty);
        string cacheKey = string.Concat(
            CacheKeyBuilder.PublicAotDocument(match.PageId, match.RouteKey, "zh-CN"),
            ":iv:0");
        var entry = new PublicAotCacheEntry
        {
            CacheKey = cacheKey,
            PageId = match.PageId,
            RouteKey = match.RouteKey,
            Source = PublicAotWriteSource.ServerSsrBackfill,
            Value = VerifiedHtml,
            RendererVersion = PublicAotConstants.RendererVersion,
            FrontendAssetVersion = FrontendAssetVersion,
            Locale = "zh-CN",
            GeneratedAtUtc = DateTimeOffset.UtcNow,
            ExpiresAtUtc = DateTimeOffset.UtcNow.AddHours(1)
        };

        var fileCache = new PublicAotFileShellCache(
            new TestWebHostEnvironment(temp.Root),
            RedisOperationExecutor.ForTestConnection(connection),
            NullLogger<PublicAotFileShellCache>.Instance);
        await fileCache.SetAsync(entry);
        string artifactPath = PublicAotFileShellCache.ResolveVersionedEntryPathForTests(
            Path.Combine(temp.Root, "wwwroot"),
            cacheKey,
            FrontendAssetVersion,
            match.PageId);
        byte[] verifiedFileBytes = await File.ReadAllBytesAsync(artifactPath);

        await GenerateFailingBackfillAsync(fileCache, match, cacheKey, FrontendAssetVersion);

        Assert.Equal(verifiedFileBytes, await File.ReadAllBytesAsync(artifactPath));
        Assert.Equal(
            VerifiedHtml,
            (await fileCache.TryGetEntryAsync(cacheKey, FrontendAssetVersion))?.Value);
        foreach (string registryKey in PublicAotCacheRegistry.GetRegistryKeys(match.PageId, match.RouteKey))
        {
            Assert.True(await connection.GetDatabase().SetContainsAsync(registryKey, cacheKey));
        }

        string redisScopePrefix = $"test:public-aot-preservation:{Guid.CreateVersion7():N}:";
        var redisScope = new PrefixRuntimeKeyScope(redisScopePrefix);
        using (var memory = new MemoryCache(new MemoryCacheOptions()))
        using (var unified = new UnifiedCache(
            connection,
            new CachePolicyRegistry(),
            redisScope,
            NullLogger<UnifiedCache>.Instance))
        {
            var redisCache = new PublicAotShellCache(
                unified,
                unified,
                unified,
                RedisOperationExecutor.ForTestConnection(connection));
            await redisCache.SetAsync(entry);
            await GenerateFailingBackfillAsync(redisCache, match, cacheKey, FrontendAssetVersion);
        }

        using (var restartedMemory = new MemoryCache(new MemoryCacheOptions()))
        using (var restartedUnified = new UnifiedCache(
            connection,
            new CachePolicyRegistry(),
            redisScope,
            NullLogger<UnifiedCache>.Instance))
        {
            var restartedRedisCache = new PublicAotShellCache(
                restartedUnified,
                restartedUnified,
                restartedUnified,
                RedisOperationExecutor.ForTestConnection(connection));
            Assert.Equal(
                VerifiedHtml,
                (await restartedRedisCache.TryGetEntryAsync(cacheKey, FrontendAssetVersion))?.Value);
        }

        await fileCache.RemoveAsync(cacheKey);
        await redis.DeleteNamespaceAsync(redisScopePrefix);
    }

    [Fact]
    public async Task RedisAuthority_HighConflictAcrossTwoNodesHasNoLostUpdatesAndLiftsStaleNode()
    {
        string prefix = $"test:public-aot-generation:{Guid.CreateVersion7():N}:";
        using var temp = new TemporaryDirectory();
        try
        {
            await using ConnectionMultiplexer firstConnection = await redis.ConnectAsync();
            await using ConnectionMultiplexer secondConnection = await redis.ConnectAsync();
            var firstScope = new PrefixRuntimeKeyScope(prefix);
            var secondScope = new PrefixRuntimeKeyScope(prefix);
            var firstAuthority = CreateAuthority(firstConnection, firstScope, temp);
            var secondAuthority = CreateAuthority(secondConnection, secondScope, temp);
            var firstNode = new PublicAotInvalidationTracker(firstAuthority);
            var secondNode = new PublicAotInvalidationTracker(secondAuthority);
            await firstNode.InitializeAsync(CancellationToken.None);
            await secondNode.InitializeAsync(CancellationToken.None);

            Assert.Equal(0, firstNode.GetCurrentVersion("article:1", "article:"));
            const int MarkCount = 128;
            var observed = new ConcurrentBag<long>();
            await Task.WhenAll(
                Task.Run(async () =>
                {
                    for (int index = 0; index < MarkCount / 2; index++)
                    {
                        observed.Add(await firstNode.MarkKeyAsync("same-key"));
                    }
                }),
                Task.Run(async () =>
                {
                    for (int index = 0; index < MarkCount / 2; index++)
                    {
                        observed.Add(await secondNode.MarkPrefixAsync("same-prefix"));
                    }
                }));

            PublicAotInvalidationGenerationState afterConcurrentMarks = await firstAuthority
                .LoadAsync(CancellationToken.None);
            Assert.Equal(MarkCount, afterConcurrentMarks.AllGeneration);
            Assert.Equal(
                Enumerable.Range(1, MarkCount).Select(static value => (long)value),
                observed.Order());
            await firstNode.InitializeAsync(CancellationToken.None);
            Assert.Equal(
                afterConcurrentMarks.AllGeneration,
                firstNode.GetCurrentVersion("same-key", "same-prefix"));

            long beforeRemoteMark = firstNode.GetCurrentVersion("remote-key", "remote-prefix");
            long remoteGeneration = await secondNode.MarkKeyAsync("remote-key");
            Assert.True(remoteGeneration > beforeRemoteMark);
            await firstNode.InitializeAsync(CancellationToken.None);
            Assert.Equal(
                remoteGeneration,
                firstNode.GetCurrentVersion("remote-key", "remote-prefix"));

            await using ConnectionMultiplexer restartedConnection = await redis.ConnectAsync();
            var restartedNode = new PublicAotInvalidationTracker(CreateAuthority(
                restartedConnection,
                new PrefixRuntimeKeyScope(prefix),
                temp));
            await restartedNode.InitializeAsync(CancellationToken.None);
            Assert.Equal(
                remoteGeneration,
                restartedNode.GetCurrentVersion("remote-key", "remote-prefix"));
        }
        finally
        {
            await redis.DeleteNamespaceAsync(prefix);
        }
    }

    [Fact]
    public async Task RedisAuthority_DifferentRuntimeScopesDoNotShareGeneration()
    {
        string prefix = $"test:public-aot-generation:{Guid.CreateVersion7():N}:";
        using var temp = new TemporaryDirectory();
        try
        {
            await using ConnectionMultiplexer connection = await redis.ConnectAsync();
            var firstScope = new PrefixRuntimeKeyScope(string.Concat(prefix, "first:"));
            var secondScope = new PrefixRuntimeKeyScope(string.Concat(prefix, "second:"));
            RedisPublicAotInvalidationGenerationAuthority first =
                CreateAuthority(connection, firstScope, temp);
            RedisPublicAotInvalidationGenerationAuthority second =
                CreateAuthority(connection, secondScope, temp);

            _ = await first.LoadAsync(CancellationToken.None);
            _ = await second.LoadAsync(CancellationToken.None);
            _ = await first.MarkAsync(
                "all",
                PublicAotInvalidationGenerationStateCodec.AllCoordinate,
                null,
                CancellationToken.None);
            _ = await first.MarkAsync("key", "first:key", null, CancellationToken.None);

            Assert.Equal(2, (await first.LoadAsync(CancellationToken.None)).AllGeneration);
            Assert.Equal(0, (await second.LoadAsync(CancellationToken.None)).AllGeneration);
            Assert.Equal(0, (await second.LoadAsync(CancellationToken.None)).Current("first:key", "first:"));
        }
        finally
        {
            await redis.DeleteNamespaceAsync(prefix);
        }
    }

    [Fact]
    public async Task MissingDurableStateWithOldArtifactFailsReadinessAndCannotProduceLv0Lookup()
    {
        string prefix = $"test:public-aot-generation:{Guid.CreateVersion7():N}:";
        using var temp = new TemporaryDirectory();
        string lv0Key = string.Empty;
        try
        {
            await using ConnectionMultiplexer connection = await redis.ConnectAsync();
            var scope = new PrefixRuntimeKeyScope(prefix);
            var cache = new PublicAotFileShellCache(
                new TestWebHostEnvironment(temp.Root),
                RedisOperationExecutor.ForTestConnection(connection),
                NullLogger<PublicAotFileShellCache>.Instance);
            PublicAotRouteMatch match = ArticleMatch();
            string baseKey = scope.PrefixKey(
                CacheKeyBuilder.PublicAotDocument(match.PageId, match.RouteKey));
            lv0Key = string.Concat(baseKey, ":iv:0");
            await cache.SetAsync(CacheEntry(lv0Key, match));
            Assert.NotNull(await cache.TryGetEntryAsync(lv0Key, "frontend-v1"));

            RedisPublicAotInvalidationGenerationAuthority authority =
                CreateAuthority(connection, scope, temp);
            var tracker = new PublicAotInvalidationTracker(authority);
            var validator = new PublicAotInvalidationGenerationStartupValidator(tracker);
            InvalidOperationException readinessFailure = await Assert.ThrowsAsync<InvalidOperationException>(
                () => validator.StartAsync(CancellationToken.None));
            Assert.Contains(
                "bootstrap-refused-existing-artifacts",
                readinessFailure.Message,
                StringComparison.Ordinal);

            PublicAotArtifactStore store = CreateStore(
                cache,
                scope,
                tracker);
            Assert.Throws<InvalidOperationException>(
                () => store.CreateLookup(new DefaultHttpContext(), match));
        }
        finally
        {
            if (!string.IsNullOrEmpty(lv0Key))
            {
                await using ConnectionMultiplexer cleanup = await redis.ConnectAsync();
                await cleanup.GetDatabase().SetRemoveAsync(
                    PublicAotCacheRegistry.GlobalRegistryKey,
                    lv0Key);
            }
            await redis.DeleteNamespaceAsync(prefix);
        }
    }

    [Fact]
    public async Task RedisStateLossAfterInitializationFailsClosedEvenWithoutArtifacts()
    {
        string prefix = $"test:public-aot-generation:{Guid.CreateVersion7():N}:";
        using var temp = new TemporaryDirectory();
        try
        {
            await using ConnectionMultiplexer connection = await redis.ConnectAsync();
            var scope = new PrefixRuntimeKeyScope(prefix);
            RedisPublicAotInvalidationGenerationAuthority authority =
                CreateAuthority(connection, scope, temp);
            Assert.Equal(
                1,
                (await authority.MarkAsync("key", "article:42", null, CancellationToken.None)).AllGeneration);
            Assert.True(await connection.GetDatabase().KeyDeleteAsync(
                scope.PrefixKey(RedisPublicAotInvalidationGenerationAuthority.StateKey)));

            var restarted = CreateAuthority(connection, scope, temp);
            InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(
                () => restarted.LoadAsync(CancellationToken.None));
            Assert.Contains(
                "state-missing-after-initialization",
                failure.Message,
                StringComparison.Ordinal);
        }
        finally
        {
            await redis.DeleteNamespaceAsync(prefix);
        }
    }

    [Fact]
    public async Task ConcurrentBootstrap_ReloadsStatePublishedByCompetingNode()
    {
        string prefix = $"test:public-aot-generation:{Guid.CreateVersion7():N}:";
        try
        {
            await using ConnectionMultiplexer connection = await redis.ConnectAsync();
            var scope = new PrefixRuntimeKeyScope(prefix);
            var guard = new CompetingBootstrapGuard(connection.GetDatabase(), scope);
            var authority = new RedisPublicAotInvalidationGenerationAuthority(
                RedisOperationExecutor.ForTestConnection(connection),
                scope,
                guard);

            PublicAotInvalidationGenerationState state = await authority.LoadAsync(CancellationToken.None);

            Assert.Equal(scope.ScopeToken, state.RuntimeScope);
            Assert.True(guard.RecordInitializedCalled);
        }
        finally
        {
            await redis.DeleteNamespaceAsync(prefix);
        }
    }

    [Fact]
    public async Task RedisDurableGeneration_PreventsFreshProcessFromReadingLv0DiskArtifact()
    {
        string prefix = $"test:public-aot-generation:{Guid.CreateVersion7():N}:";
        using var temp = new TemporaryDirectory();
        string lv0Key = string.Empty;
        try
        {
            await using ConnectionMultiplexer connection = await redis.ConnectAsync();
            var scope = new PrefixRuntimeKeyScope(prefix);
            var authority = CreateAuthority(connection, scope, temp);
            var cache = new PublicAotFileShellCache(
                new TestWebHostEnvironment(temp.Root),
                RedisOperationExecutor.ForTestConnection(connection),
                NullLogger<PublicAotFileShellCache>.Instance);
            var tracker = new PublicAotInvalidationTracker(authority);
            await tracker.InitializeAsync(CancellationToken.None);
            PublicAotRouteMatch match = ArticleMatch();
            string baseKey = scope.PrefixKey(
                CacheKeyBuilder.PublicAotDocument(match.PageId, match.RouteKey));
            lv0Key = string.Concat(baseKey, ":iv:0");
            Assert.Equal(0, (await authority.LoadAsync(CancellationToken.None)).AllGeneration);
            await cache.SetAsync(CacheEntry(lv0Key, match));
            Assert.NotNull(await cache.TryGetEntryAsync(lv0Key, "frontend-v1"));

            for (int generation = 0; generation < 5; generation++)
            {
                _ = await tracker.MarkKeyAsync(baseKey);
            }

            var restartedTracker = new PublicAotInvalidationTracker(
                CreateAuthority(connection, scope, temp));
            await restartedTracker.InitializeAsync(CancellationToken.None);
            PublicAotArtifactStore store = CreateStore(cache, scope, restartedTracker);
            PublicAotArtifactLookup lookup =
                store.CreateLookup(new DefaultHttpContext(), match);

            Assert.EndsWith(":iv:5", lookup.DocumentCacheKey, StringComparison.Ordinal);
            Assert.Null(await store.TryGetEntryAsync(lookup, CancellationToken.None));
            Assert.NotNull(await cache.TryGetEntryAsync(lv0Key, "frontend-v1"));
        }
        finally
        {
            if (!string.IsNullOrEmpty(lv0Key))
            {
                await using ConnectionMultiplexer cleanup = await redis.ConnectAsync();
                await cleanup.GetDatabase().SetRemoveAsync(
                    PublicAotCacheRegistry.GlobalRegistryKey,
                    lv0Key);
            }
            await redis.DeleteNamespaceAsync(prefix);
        }
    }

    [Fact]
    public async Task BackfillCommit_RechecksTheDurableGenerationAfterRemoteNodeMutation()
    {
        string prefix = $"test:public-aot-generation:{Guid.CreateVersion7():N}:";
        using var temp = new TemporaryDirectory();
        try
        {
            await using ConnectionMultiplexer firstConnection = await redis.ConnectAsync();
            await using ConnectionMultiplexer secondConnection = await redis.ConnectAsync();
            var scope = new PrefixRuntimeKeyScope(prefix);
            RedisPublicAotInvalidationGenerationAuthority firstAuthority =
                CreateAuthority(firstConnection, scope, temp);
            RedisPublicAotInvalidationGenerationAuthority secondAuthority =
                CreateAuthority(
                    secondConnection,
                    new PrefixRuntimeKeyScope(prefix),
                    temp);
            var tracker = new PublicAotInvalidationTracker(firstAuthority);
            await tracker.InitializeAsync(CancellationToken.None);
            PublicAotRouteMatch match = ArticleMatch();
            string invalidationKey = scope.PrefixKey(
                CacheKeyBuilder.PublicAotDocument(match.PageId, match.RouteKey));
            string pagePrefixKey = scope.PrefixKey(
                CacheKeyBuilder.PublicAotDocument(match.PageId, string.Empty));
            long scheduledGeneration =
                tracker.GetCurrentVersion(invalidationKey, pagePrefixKey);
            var request = new PublicAotBackfillRequest(
                match.Kind,
                match.RouteKey,
                match.Path,
                match.QueryString,
                string.Concat(invalidationKey, ":iv:", scheduledGeneration))
            {
                InvalidationKey = invalidationKey,
                PagePrefixKey = pagePrefixKey,
                ScheduledInvalidationVersion = scheduledGeneration,
                FrontendAssetVersion = "frontend-v1"
            };
            var writer = Substitute.For<IPublicAotCacheWriter>();
            var manifest = Substitute.For<ISpaAssetManifestService>();
            manifest.GetFrontendAssetVersion().Returns("frontend-v1");
            var store = new PublicAotArtifactStore(
                Substitute.For<IPublicAotShellCache>(),
                writer,
                Substitute.For<IPublicAotBackfillScheduler>(),
                manifest,
                scope,
                tracker);

            bool written = await store.WriteBackfillAsync(
                request,
                new PublicAotBackfillDocument(
                    match,
                    "<html>stale</html>",
                    PublicAotConstants.RendererVersion,
                    DateTimeOffset.UnixEpoch),
                async token =>
                {
                    await secondAuthority.MarkAsync(
                        "key",
                        invalidationKey,
                        null,
                        token);
                    await tracker.InitializeAsync(token);
                },
                CancellationToken.None);

            Assert.False(written);
            Assert.Empty(writer.ReceivedCalls());
            Assert.Equal(
                1,
                (await firstAuthority.LoadAsync(CancellationToken.None)).Current(invalidationKey, pagePrefixKey));
        }
        finally
        {
            await redis.DeleteNamespaceAsync(prefix);
        }
    }

    [Fact]
    public async Task ProductionCompactionRetainsGlobalAndArtifactReferencedCoordinates()
    {
        string prefix = $"test:public-aot-generation:{Guid.CreateVersion7():N}:";
        using var temp = new TemporaryDirectory();
        string registeredKey = string.Empty;
        try
        {
            await using ConnectionMultiplexer connection = await redis.ConnectAsync();
            var scope = new PrefixRuntimeKeyScope(prefix);
            RedisPublicAotInvalidationGenerationAuthority authority =
                CreateAuthority(connection, scope, temp);
            string activePrefix = string.Concat(prefix, "active:");
            string activeKey = string.Concat(activePrefix, "article");
            string retiredPrefix = string.Concat(prefix, "retired:");
            string retiredKey = string.Concat(retiredPrefix, "article");
            _ = await authority.MarkAsync("all", PublicAotInvalidationGenerationStateCodec.AllCoordinate, null, CancellationToken.None);
            long sitemapGeneration = (await authority.MarkAsync(
                "key",
                PublicAotInvalidationGenerationStateCodec.SitemapCoordinate,
                "taxonomy:compaction",
                CancellationToken.None)).AllGeneration;
            _ = await authority.MarkAsync("prefix", activePrefix, null, CancellationToken.None);
            _ = await authority.MarkAsync("key", activeKey, null, CancellationToken.None);
            _ = await authority.MarkAsync("prefix", retiredPrefix, null, CancellationToken.None);
            _ = await authority.MarkAsync("key", retiredKey, null, CancellationToken.None);
            long watermark = (await authority.LoadAsync(CancellationToken.None)).AllGeneration;
            registeredKey = string.Concat(activeKey, ":iv:3");
            await connection.GetDatabase().SetAddAsync(
                PublicAotCacheRegistry.GlobalRegistryKey,
                registeredKey);

            var worker = new PublicAotInvalidationGenerationCompactionWorker(
                authority,
                RedisOperationExecutor.ForTestConnection(connection),
                NullLogger<PublicAotInvalidationGenerationCompactionWorker>.Instance);
            PublicAotInvalidationGenerationState compacted = await worker
                .CompactOnceAsync(CancellationToken.None);

            Assert.Equal(watermark, compacted.AllGeneration);
            Assert.Contains(
                PublicAotInvalidationGenerationStateCodec.AllCoordinate,
                compacted.KeyGenerations.Keys);
            Assert.Equal(
                sitemapGeneration,
                compacted.KeyGenerations[PublicAotInvalidationGenerationStateCodec.SitemapCoordinate]);
            Assert.Contains(activeKey, compacted.KeyGenerations.Keys);
            Assert.Contains(activePrefix, compacted.PrefixGenerations.Keys);
            Assert.DoesNotContain(retiredKey, compacted.KeyGenerations.Keys);
            Assert.DoesNotContain(retiredPrefix, compacted.PrefixGenerations.Keys);
            var restarted = new PublicAotInvalidationTracker(CreateAuthority(connection, scope, temp));
            await restarted.InitializeAsync(CancellationToken.None);
            Assert.Equal(sitemapGeneration, restarted.GetSitemapGeneration());
        }
        finally
        {
            if (!string.IsNullOrEmpty(registeredKey))
            {
                await using ConnectionMultiplexer cleanup = await redis.ConnectAsync();
                await cleanup.GetDatabase().SetRemoveAsync(
                    PublicAotCacheRegistry.GlobalRegistryKey,
                    registeredKey);
            }
            await redis.DeleteNamespaceAsync(prefix);
        }
    }

    private static RedisPublicAotInvalidationGenerationAuthority CreateAuthority(
        IConnectionMultiplexer connection,
        PrefixRuntimeKeyScope scope,
        TemporaryDirectory temp)
        => new(
            RedisOperationExecutor.ForTestConnection(connection),
            scope,
            new FilePublicAotInvalidationGenerationBootstrapGuard(
                temp.AotRoot,
                releaseDerivedBase: null,
                scope.ScopeToken));

    private sealed class CompetingBootstrapGuard(
        IDatabase database,
        PrefixRuntimeKeyScope scope) : IPublicAotInvalidationGenerationBootstrapGuard
    {
        public bool RecordInitializedCalled
        {
            get; private set;
        }

        public void PrepareInitialBootstrap()
        {
            PublicAotInvalidationGenerationState state =
                PublicAotInvalidationGenerationStateCodec.CreateEmpty(scope.ScopeToken);
            _ = database.StringSetAsync(
                    scope.PrefixKey(RedisPublicAotInvalidationGenerationAuthority.StateKey),
                    PublicAotInvalidationGenerationStateCodec.Serialize(state),
                    flags: CommandFlags.DemandMaster)
                .GetAwaiter()
                .GetResult();
            throw new InvalidOperationException(
                FilePublicAotInvalidationGenerationBootstrapGuard.MissingStateAfterInitializationError);
        }

        public void RecordInitialized(PublicAotInvalidationGenerationState state)
            => RecordInitializedCalled = true;
    }

    private static async Task GenerateFailingBackfillAsync(
        IPublicAotShellCache cache,
        PublicAotRouteMatch match,
        string cacheKey,
        string frontendAssetVersion)
    {
        var composition = Substitute.For<IPublicAotDocumentComposition>();
        composition.BuildBackfillDocumentAsync(
                Arg.Any<PublicAotBackfillRequest>(),
                Arg.Any<DateTimeOffset>(),
                Arg.Any<CancellationToken>())
            .Returns(Result<PublicAotBackfillDocument>.Failure(
                ErrorCode.InfraFailure,
                "public_aot_contract_markdown_runtime_authority_invalid"));
        var manifest = Substitute.For<ISpaAssetManifestService>();
        manifest.GetFrontendAssetVersion().Returns(frontendAssetVersion);
        var tracker = new PublicAotInvalidationTracker();
        var writer = Substitute.For<IPublicAotCacheWriter>();
        var store = new PublicAotArtifactStore(
            cache,
            writer,
            Substitute.For<IPublicAotBackfillScheduler>(),
            manifest,
            new PrefixRuntimeKeyScope(string.Empty),
            tracker);
        var service = new PublicAotShellService(
            new ImmediateDbConcurrencyGate(),
            composition,
            store,
            new PublicAotRuntimeState(
                new PublicAotSsrRuntimeState(new ConfigurationBuilder().Build())),
            new LocaleResolver(),
            NullLogger<PublicAotShellService>.Instance);
        var request = new PublicAotBackfillRequest(
            match.Kind,
            match.RouteKey,
            match.Path,
            match.QueryString,
            cacheKey)
        {
            InvalidationKey = CacheKeyBuilder.PublicAotDocument(match.PageId, match.RouteKey),
            PagePrefixKey = CacheKeyBuilder.PublicAotDocument(match.PageId, string.Empty),
            ScheduledInvalidationVersion = 0,
            FrontendAssetVersion = frontendAssetVersion,
            Locale = "zh-CN"
        };

        await service.GenerateAndStoreAsync(request);

        Assert.Empty(writer.ReceivedCalls());
    }

    private static PublicAotArtifactStore CreateStore(
        IPublicAotShellCache cache,
        IRuntimeKeyScope scope,
        PublicAotInvalidationTracker tracker)
    {
        var manifest = Substitute.For<ISpaAssetManifestService>();
        manifest.GetFrontendAssetVersion(Arg.Any<HttpContext>()).Returns("frontend-v1");
        return new PublicAotArtifactStore(
            cache,
            Substitute.For<IPublicAotCacheWriter>(),
            Substitute.For<IPublicAotBackfillScheduler>(),
            manifest,
            scope,
            tracker);
    }

    private static PublicAotCacheEntry CacheEntry(
        string cacheKey,
        PublicAotRouteMatch match)
        => new()
        {
            CacheKey = cacheKey,
            PageId = match.PageId,
            RouteKey = match.RouteKey,
            Source = PublicAotWriteSource.ServerSsrBackfill,
            Value = "<html>lv0</html>",
            RendererVersion = PublicAotConstants.RendererVersion,
            FrontendAssetVersion = "frontend-v1",
            GeneratedAtUtc = DateTimeOffset.UtcNow,
            ExpiresAtUtc = DateTimeOffset.UtcNow.AddHours(1)
        };

    private static PublicAotRouteMatch ArticleMatch()
        => new(
            PublicPageKind.ArticleDetail,
            PublicPageId.ArticleDetail,
            "article:42",
            "/article/42",
            "/article/42",
            string.Empty);

    private sealed class PrefixRuntimeKeyScope(string prefix) : IRuntimeKeyScope
    {
        public string ScopeToken => prefix;
        public string PrefixKey(string key) => string.Concat(prefix, key);
    }

    private sealed class ImmediateDbConcurrencyGate : IDbConcurrencyGate
    {
        public async Task<T> ExecuteAsync<T>(
            string operation,
            Func<CancellationToken, Task<T>> action,
            Func<CancellationToken, Task<T>> onTimeout,
            CancellationToken cancellationToken = default)
            => await action(cancellationToken);

        public DbConcurrencyGateSnapshot GetSnapshot() => new(1, 0, 0);
    }

    private sealed class TemporaryDirectory : IDisposable
    {
        public string Root
        {
            get;
        } =
            Path.Combine(
                Path.GetTempPath(),
                $"fsus-public-aot-generation-{Guid.NewGuid():N}");
        public string AotRoot => Path.Combine(Root, "wwwroot", "aot-cache");

        public TemporaryDirectory()
            => Directory.CreateDirectory(Path.Combine(Root, "wwwroot"));

        public void Dispose()
        {
            try
            {
                Directory.Delete(Root, recursive: true);
            }
            catch
            {
            }
        }
    }

    private sealed class TestWebHostEnvironment(string root) : IWebHostEnvironment
    {
        public string ApplicationName { get; set; } = "FsusBlog.Tests";
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string WebRootPath { get; set; } = Path.Combine(root, "wwwroot");
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
        public string ContentRootPath { get; set; } = root;
        public string EnvironmentName { get; set; } = Environments.Development;
    }
}
