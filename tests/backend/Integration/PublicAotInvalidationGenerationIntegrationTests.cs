using System.Collections.Concurrent;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.Spa;

using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
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

            Assert.Equal(0, firstNode.GetCurrentVersion("article:1", "article:"));
            const int MarkCount = 128;
            var observed = new ConcurrentBag<long>();
            await Task.WhenAll(
                Task.Run(() =>
                {
                    for (int index = 0; index < MarkCount / 2; index++)
                    {
                        observed.Add(firstNode.MarkKey("same-key"));
                    }
                }),
                Task.Run(() =>
                {
                    for (int index = 0; index < MarkCount / 2; index++)
                    {
                        observed.Add(secondNode.MarkPrefix("same-prefix"));
                    }
                }));

            PublicAotInvalidationGenerationState afterConcurrentMarks = firstAuthority.Load();
            Assert.Equal(MarkCount, afterConcurrentMarks.AllGeneration);
            Assert.Equal(
                Enumerable.Range(1, MarkCount).Select(static value => (long)value),
                observed.Order());
            Assert.Equal(
                afterConcurrentMarks.AllGeneration,
                firstNode.GetCurrentVersion("same-key", "same-prefix"));

            long beforeRemoteMark = firstNode.GetCurrentVersion("remote-key", "remote-prefix");
            long remoteGeneration = secondNode.MarkKey("remote-key");
            Assert.True(remoteGeneration > beforeRemoteMark);
            Assert.Equal(
                remoteGeneration,
                firstNode.GetCurrentVersion("remote-key", "remote-prefix"));

            await using ConnectionMultiplexer restartedConnection = await redis.ConnectAsync();
            var restartedNode = new PublicAotInvalidationTracker(CreateAuthority(
                restartedConnection,
                new PrefixRuntimeKeyScope(prefix),
                temp));
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

            _ = first.Load();
            _ = second.Load();
            first.Mark(
                "all",
                PublicAotInvalidationGenerationStateCodec.AllCoordinate);
            first.Mark("key", "first:key");

            Assert.Equal(2, first.Load().AllGeneration);
            Assert.Equal(0, second.Load().AllGeneration);
            Assert.Equal(0, second.Load().Current("first:key", "first:"));
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
                connection,
                NullLogger<PublicAotFileShellCache>.Instance);
            PublicAotRouteMatch match = ArticleMatch();
            string baseKey = scope.PrefixKey(
                CacheKeyBuilder.PublicAotDocument(match.PageId, match.RouteKey));
            lv0Key = string.Concat(baseKey, ":iv:0");
            await cache.SetAsync(CacheEntry(lv0Key, match));
            Assert.NotNull(await cache.TryGetEntryAsync(lv0Key, "frontend-v1"));

            RedisPublicAotInvalidationGenerationAuthority authority =
                CreateAuthority(connection, scope, temp);
            var validator = new PublicAotInvalidationGenerationStartupValidator(authority);
            InvalidOperationException readinessFailure = await Assert.ThrowsAsync<InvalidOperationException>(
                () => validator.StartAsync(CancellationToken.None));
            Assert.Contains(
                "bootstrap-refused-existing-artifacts",
                readinessFailure.Message,
                StringComparison.Ordinal);

            PublicAotArtifactStore store = CreateStore(
                cache,
                scope,
                new PublicAotInvalidationTracker(authority));
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
            Assert.Equal(1, authority.Mark("key", "article:42").AllGeneration);
            Assert.True(await connection.GetDatabase().KeyDeleteAsync(
                scope.PrefixKey(RedisPublicAotInvalidationGenerationAuthority.StateKey)));

            var restarted = CreateAuthority(connection, scope, temp);
            InvalidOperationException failure = Assert.Throws<InvalidOperationException>(
                () => restarted.Load());
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
                connection,
                NullLogger<PublicAotFileShellCache>.Instance);
            var tracker = new PublicAotInvalidationTracker(authority);
            PublicAotRouteMatch match = ArticleMatch();
            string baseKey = scope.PrefixKey(
                CacheKeyBuilder.PublicAotDocument(match.PageId, match.RouteKey));
            lv0Key = string.Concat(baseKey, ":iv:0");
            Assert.Equal(0, authority.Load().AllGeneration);
            await cache.SetAsync(CacheEntry(lv0Key, match));
            Assert.NotNull(await cache.TryGetEntryAsync(lv0Key, "frontend-v1"));

            for (int generation = 0; generation < 5; generation++)
            {
                tracker.MarkKey(baseKey);
            }

            var restartedTracker = new PublicAotInvalidationTracker(
                CreateAuthority(connection, scope, temp));
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
                _ =>
                {
                    secondAuthority.Mark("key", invalidationKey);
                    return Task.CompletedTask;
                },
                CancellationToken.None);

            Assert.False(written);
            Assert.Empty(writer.ReceivedCalls());
            Assert.Equal(
                1,
                firstAuthority.Load().Current(invalidationKey, pagePrefixKey));
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
            authority.Mark("all", PublicAotInvalidationGenerationStateCodec.AllCoordinate);
            authority.Mark("prefix", activePrefix);
            authority.Mark("key", activeKey);
            authority.Mark("prefix", retiredPrefix);
            authority.Mark("key", retiredKey);
            long watermark = authority.Load().AllGeneration;
            registeredKey = string.Concat(activeKey, ":iv:3");
            await connection.GetDatabase().SetAddAsync(
                PublicAotCacheRegistry.GlobalRegistryKey,
                registeredKey);

            var worker = new PublicAotInvalidationGenerationCompactionWorker(
                authority,
                connection,
                NullLogger<PublicAotInvalidationGenerationCompactionWorker>.Instance);
            PublicAotInvalidationGenerationState compacted = worker.CompactOnce();

            Assert.Equal(watermark, compacted.AllGeneration);
            Assert.Contains(
                PublicAotInvalidationGenerationStateCodec.AllCoordinate,
                compacted.KeyGenerations.Keys);
            Assert.Contains(activeKey, compacted.KeyGenerations.Keys);
            Assert.Contains(activePrefix, compacted.PrefixGenerations.Keys);
            Assert.DoesNotContain(retiredKey, compacted.KeyGenerations.Keys);
            Assert.DoesNotContain(retiredPrefix, compacted.PrefixGenerations.Keys);
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
            connection,
            scope,
            new FilePublicAotInvalidationGenerationBootstrapGuard(
                temp.AotRoot,
                releaseDerivedBase: null,
                scope.ScopeToken));

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
