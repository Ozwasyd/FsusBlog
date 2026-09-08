using System.Collections.Frozen;
using System.Diagnostics;
using System.Net;

using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Distributed;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Storage;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

using NSubstitute;

using SqlSugar;

using StackExchange.Redis;
using StackExchange.Redis.Profiling;

namespace FsusBlog.Server.Tests;

[Collection(nameof(SchemaMigrationPostgresCollectionA))]
[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
public sealed class DistributedInvalidationTargetConvergenceIntegrationTests(
    PostgresSchemaMigrationFixture postgres,
    PublicHotDeliveryRedisFixture redis) : IClassFixture<PublicHotDeliveryRedisFixture>
{
    private const string AppliedState = "applied";
    private const string TerminalFailedState = "terminal-failed";

    [Fact]
    public async Task DualNodeCommentMutation_ChangesOnlyCommentAndStatsTargets()
    {
        await using NodePair nodes = await NodePair.CreateAsync(postgres, redis);
        nodes.SeedBoth(articles: [1, 2], seedSeo: true, seedCategory: true);
        IReadOnlyList<CachePolicyStorageSnapshot> before = nodes.Target.LocalCache.SnapshotResidency();
        long readyTicks = Stopwatch.GetTimestamp();

        DistributedInvalidationPublishResult published = await nodes.Source.Bus.PublishAsync(
            new DistributedInvalidationRequest(
                DistributedInvalidationEventKinds.CommentMutation,
                ["comments", "stats"],
                ["article:1:comments"],
                ["public-hot-read"]));
        Assert.NotEqual(DistributedInvalidationPublishStatus.LocalOnly, published.Status);
        await EventuallyAsync(() => InboxState(nodes.Connection) == AppliedState);

        Assert.True(nodes.Target.HotRead.IsReady);
        Assert.True(Stopwatch.GetElapsedTime(readyTicks) < TimeSpan.FromSeconds(5));
        Assert.True(nodes.Target.HotRead.Current.TryGetArticle(1, out _));
        Assert.True(nodes.Target.HotRead.Current.TryGetArticle(2, out _));
        Assert.True(nodes.Target.HotRead.Current.TryGetCategory(out _));
        AssertResidencyUnchanged(before, nodes.Target.LocalCache.SnapshotResidency(), CachePolicyId.ArticleDetail);
        AssertResidencyUnchanged(before, nodes.Target.LocalCache.SnapshotResidency(), CachePolicyId.CategoryFrame);
        AssertResidencyUnchanged(before, nodes.Target.LocalCache.SnapshotResidency(), CachePolicyId.SystemSeo);
        Assert.Equal(AppliedState, InboxState(nodes.Connection));
        DistributedInvalidationLocalApplyResult commentReceipt = nodes.Target.LastResult!;
        Assert.False(commentReceipt.FullReconcile);
        Assert.True(commentReceipt.ResolvedTargetCount >= 4);
        Assert.True(commentReceipt.L1InvalidatedPolicyCount > 0);
        Assert.Equal(0, commentReceipt.AotRouteCount);
        Assert.Equal(1, commentReceipt.HotReadFragmentCount);
    }

    [Fact]
    public async Task DualNodeArticleMutation_KeepsUnrelatedHotReadRouteReady()
    {
        await using NodePair nodes = await NodePair.CreateAsync(postgres, redis);
        nodes.SeedBoth(articles: [1, 2], seedSeo: true, seedCategory: true);
        Assert.True(nodes.Target.HotRead.Current.TryGetArticle(2, out PublicBinaryArtifact beforeTwo));
        byte[] unchanged = beforeTwo.Frame.ToArray();
        await using KestrelHotReadHost kestrel = await KestrelHotReadHost.StartAsync(nodes.Target.HotRead);
        _ = nodes.DrainSourceRedisCommands();
        string[] redisStartupCommands = nodes.DrainTargetRedisCommands();
        Assert.Contains(redisStartupCommands, static command => command is "SUBSCRIBE" or "PSUBSCRIBE");

        HotReadHttpEvidence beforeHttp = await kestrel.GetArticleAsync(2);
        Assert.True(
            beforeHttp.StatusCode == HttpStatusCode.OK,
            $"Kestrel article request failed: status={beforeHttp.StatusCode}; body={System.Text.Encoding.UTF8.GetString(beforeHttp.Body)}");
        Assert.Equal(unchanged, beforeHttp.Body);
        Assert.Equal(beforeTwo.Version.ToString(System.Globalization.CultureInfo.InvariantCulture), beforeHttp.HotReadVersion);
        Assert.Equal(AedsFrameHeader.CurrentVersion.ToString(System.Globalization.CultureInfo.InvariantCulture), beforeHttp.FrameVersion);
        Assert.Equal(beforeTwo.ETag, beforeHttp.ETag);
        _ = nodes.DrainSourceRedisCommands();
        _ = nodes.DrainTargetRedisCommands();

        DistributedInvalidationPublishResult published = await nodes.Source.Bus.PublishAsync(
            new DistributedInvalidationRequest(
                DistributedInvalidationEventKinds.ArticleMutation,
                ["article-list", "hot-articles", "stats"],
                ["article:1"],
                ["article-detail:1", "public-aot", "public-hot-read"]));
        await EventuallyAsync(() => InboxState(nodes.Connection) == AppliedState);
        Assert.Contains("PUBLISH", nodes.DrainSourceRedisCommands());

        Assert.True(nodes.Target.HotRead.IsReady);
        Assert.False(nodes.Target.HotRead.Current.TryGetArticle(1, out _));
        Assert.True(nodes.Target.HotRead.Current.TryGetArticle(2, out PublicBinaryArtifact remaining));
        Assert.Equal(unchanged, remaining.Frame.ToArray());
        DistributedInvalidationLocalApplyResult articleReceipt = nodes.Target.LastResult!;
        Assert.False(articleReceipt.FullReconcile);
        Assert.True(articleReceipt.ResolvedTargetCount >= 7);
        Assert.True(articleReceipt.L1InvalidatedPolicyCount > 0);
        Assert.True(articleReceipt.L1InvalidatedEntryCount > 0);
        Assert.Equal(1, articleReceipt.AotRouteCount);
        Assert.True(articleReceipt.HotReadFragmentCount > 0);

        DistributedInvalidationInboxEntity inbox = Assert.IsType<DistributedInvalidationInboxEntity>(ReadInbox(nodes.Connection));
        Assert.Equal(published.EventId, inbox.EventId);
        Assert.Equal("node-b", inbox.TargetNodeId);
        Assert.Equal(AppliedState, inbox.ApplyState);

        _ = nodes.DrainTargetRedisCommands();
        HotReadHttpEvidence afterHttp = await kestrel.GetArticleAsync(2);
        Assert.Equal(HttpStatusCode.OK, afterHttp.StatusCode);
        Assert.Equal(beforeHttp.Body, afterHttp.Body);
        Assert.Equal(beforeHttp.HotReadVersion, afterHttp.HotReadVersion);
        Assert.Equal(beforeHttp.FrameVersion, afterHttp.FrameVersion);
        Assert.Equal(beforeHttp.ETag, afterHttp.ETag);
        Assert.Empty(nodes.DrainTargetRedisCommands());
    }

    [Fact]
    public async Task LostPubSub_ReplayMatchesOnlineExactTargets()
    {
        await using NodePair online = await NodePair.CreateAsync(postgres, redis, "online");
        await using NodePair replay = await NodePair.CreateAsync(postgres, redis, "replay");
        online.SeedBoth(articles: [4, 5], seedSeo: true, seedCategory: true);
        replay.SeedBoth(articles: [4, 5], seedSeo: true, seedCategory: true);
        _ = await online.Source.Bus.PublishAsync(CommentRequest());
        await EventuallyAsync(() => InboxState(online.Connection) == AppliedState);

        RedisChannel channel = RedisChannel.Literal($"{replay.Prefix}{replay.Channel}");
        await replay.TargetRedis.GetSubscriber().UnsubscribeAsync(channel);
        _ = await replay.Source.Bus.PublishAsync(CommentRequest());
        await EventuallyAsync(() => InboxState(replay.Connection) == AppliedState);

        AssertResidencyEqual(
            online.Target.LocalCache.SnapshotResidency(),
            replay.Target.LocalCache.SnapshotResidency());
        Assert.Equal(online.Target.HotRead.IsReady, replay.Target.HotRead.IsReady);
        Assert.Equal(
            online.Target.HotRead.Current.TryGetArticle(4, out _),
            replay.Target.HotRead.Current.TryGetArticle(4, out _));
        Assert.False(online.Target.LastResult!.FullReconcile);
        Assert.False(replay.Target.LastResult!.FullReconcile);
    }

    [Fact]
    public async Task UnknownTarget_RecordsFullReconcileOnRemoteInbox()
    {
        await using NodePair nodes = await NodePair.CreateAsync(postgres, redis);
        nodes.SeedBoth(articles: [8], seedSeo: true, seedCategory: true);

        _ = await nodes.Source.Bus.PublishAsync(
            new DistributedInvalidationRequest(
                DistributedInvalidationEventKinds.ArticleMutation,
                ["unknown-target"],
                ["article:8"],
                ["public-aot"]));
        await EventuallyAsync(() => InboxState(nodes.Connection) == TerminalFailedState);

        Assert.False(nodes.Target.HotRead.IsReady);
        Assert.True(nodes.Target.LastResult!.FullReconcile);
    }

    private static string InboxState(string connection)
        => ReadInbox(connection)?.ApplyState ?? string.Empty;

    private static DistributedInvalidationInboxEntity? ReadInbox(string connection)
    {
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connection);
        DistributedInvalidationInboxEntity? inbox = db.Queryable<DistributedInvalidationInboxEntity>().First();
        return inbox;
    }

    private static DistributedInvalidationRequest CommentRequest()
        => new(
            DistributedInvalidationEventKinds.CommentMutation,
            ["comments", "stats"],
            ["article:4:comments"],
            ["public-hot-read"]);

    private static void AssertResidencyUnchanged(
        IReadOnlyList<CachePolicyStorageSnapshot> before,
        IReadOnlyList<CachePolicyStorageSnapshot> after,
        CachePolicyId policyId)
    {
        CachePolicyStorageSnapshot previous = before.Single(item => item.PolicyId == policyId);
        CachePolicyStorageSnapshot current = after.Single(item => item.PolicyId == policyId);
        Assert.Equal(previous.KeyCount, current.KeyCount);
        Assert.Equal(previous.Bytes, current.Bytes);
    }

    private static void AssertResidencyEqual(
        IReadOnlyList<CachePolicyStorageSnapshot> left,
        IReadOnlyList<CachePolicyStorageSnapshot> right)
    {
        Assert.Equal(left.Count, right.Count);
        for (int i = 0; i < left.Count; i++)
        {
            Assert.Equal(left[i].PolicyId, right[i].PolicyId);
            Assert.Equal(left[i].KeyCount, right[i].KeyCount);
            Assert.Equal(left[i].Bytes, right[i].Bytes);
        }
    }

    private static async Task EventuallyAsync(Func<bool> predicate)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (!predicate())
        {
            await Task.Delay(25, timeout.Token);
        }
    }

    private readonly record struct HotReadHttpEvidence(
        HttpStatusCode StatusCode,
        byte[] Body,
        string? HotReadVersion,
        string? FrameVersion,
        string? ETag);

    private sealed class KestrelHotReadHost : IAsyncDisposable
    {
        private readonly WebApplication _app;
        private readonly HttpClient _client;

        private KestrelHotReadHost(WebApplication app, HttpClient client)
        {
            _app = app;
            _client = client;
        }

        public static async Task<KestrelHotReadHost> StartAsync(PublicHotReadStore store)
        {
            WebApplicationBuilder builder = WebApplication.CreateBuilder(new WebApplicationOptions
            {
                EnvironmentName = Environments.Production
            });
            builder.Configuration["AllowedHosts"] = "127.0.0.1;localhost";
            builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, 0));
            builder.Services.AddRouting();
            builder.Services.Configure<PublicHotReadOptions>(options =>
            {
                options.Enabled = true;
                options.FailOpenWhenNotReady = false;
                options.EnableDiagnosticHeaders = true;
            });
            builder.Services
                .AddSingleton(store)
                .AddSingleton<PublicHotReadEarlyDataPlaneRuntimeState>()
                .AddSingleton<PublicHotReadClassifierCounters>()
                .AddSingleton<PublicHotReadCounters>();

            WebApplication app = builder.Build();
            app.UseFsusPublicHotReadClassifier();
            app.UseFsusPublicHotReadFastPath();
            app.Run(static context =>
            {
                context.Response.StatusCode = StatusCodes.Status404NotFound;
                return Task.CompletedTask;
            });
            await app.StartAsync().ConfigureAwait(false);

            IServerAddressesFeature addresses = app.Services
                .GetRequiredService<Microsoft.AspNetCore.Hosting.Server.IServer>()
                .Features
                .Get<IServerAddressesFeature>()
                ?? throw new InvalidOperationException("Kestrel did not expose a bound address.");
            HttpClient client = new(new HttpClientHandler
            {
                UseProxy = false
            })
            {
                BaseAddress = new Uri(addresses.Addresses.Single()),
                Timeout = TimeSpan.FromSeconds(10)
            };
            return new KestrelHotReadHost(app, client);
        }

        public async Task<HotReadHttpEvidence> GetArticleAsync(int articleId)
        {
            using HttpRequestMessage request = new(
                HttpMethod.Get,
                $"/api/binary/article/{articleId}.aeds");
            request.Headers.TryAddWithoutValidation("Accept", "application/octet-stream");
            request.Headers.TryAddWithoutValidation("Accept-Encoding", "identity");
            using HttpResponseMessage response = await _client
                .SendAsync(request, HttpCompletionOption.ResponseHeadersRead)
                .ConfigureAwait(false);
            return new(
                response.StatusCode,
                await response.Content.ReadAsByteArrayAsync().ConfigureAwait(false),
                Header(response, "X-Fsus-HotRead-Version"),
                Header(response, "X-Fsus-Frame-Version"),
                Header(response, "ETag"));
        }

        public async ValueTask DisposeAsync()
        {
            _client.Dispose();
            await _app.StopAsync().ConfigureAwait(false);
            await _app.DisposeAsync().ConfigureAwait(false);
        }

        private static string? Header(HttpResponseMessage response, string name)
            => response.Headers.TryGetValues(name, out IEnumerable<string>? values)
                ? values.SingleOrDefault()
                : null;
    }

    private sealed class NodePair : IAsyncDisposable
    {
        private NodePair(
            string connection,
            string prefix,
            string channel,
            ConnectionMultiplexer sourceRedis,
            ConnectionMultiplexer targetRedis,
            ProfilingSession sourceRedisProfile,
            ProfilingSession targetRedisProfile,
            ServiceProvider sourceServices,
            ServiceProvider targetServices,
            NodeHarness source,
            NodeHarness target)
        {
            Connection = connection;
            Prefix = prefix;
            Channel = channel;
            SourceRedis = sourceRedis;
            TargetRedis = targetRedis;
            _sourceRedisProfile = sourceRedisProfile;
            _targetRedisProfile = targetRedisProfile;
            SourceServices = sourceServices;
            TargetServices = targetServices;
            Source = source;
            Target = target;
        }

        public string Connection
        {
            get;
        }
        public string Prefix
        {
            get;
        }
        public string Channel
        {
            get;
        }
        public ConnectionMultiplexer SourceRedis
        {
            get;
        }
        public ConnectionMultiplexer TargetRedis
        {
            get;
        }
        private readonly ProfilingSession _sourceRedisProfile;
        private readonly ProfilingSession _targetRedisProfile;

        public string[] DrainSourceRedisCommands()
            => _sourceRedisProfile.FinishProfiling().Select(static item => item.Command).ToArray();

        public string[] DrainTargetRedisCommands()
            => _targetRedisProfile.FinishProfiling().Select(static item => item.Command).ToArray();

        public ServiceProvider SourceServices
        {
            get;
        }
        public ServiceProvider TargetServices
        {
            get;
        }
        public NodeHarness Source
        {
            get;
        }
        public NodeHarness Target
        {
            get;
        }

        public static async Task<NodePair> CreateAsync(
            PostgresSchemaMigrationFixture postgres,
            PublicHotDeliveryRedisFixture redis,
            string? label = null)
        {
            string connection = await CreateDatabaseAsync(postgres);
            string prefix = $"test:distributed-target:{label ?? "pair"}:{Guid.CreateVersion7():N}:";
            string channel = $"invalidation-{Guid.CreateVersion7():N}";
            ConnectionMultiplexer sourceRedis = await redis.ConnectAsync();
            ConnectionMultiplexer targetRedis = await redis.ConnectAsync();
            var sourceRedisProfile = new ProfilingSession();
            var targetRedisProfile = new ProfilingSession();
            sourceRedis.RegisterProfiler(() => sourceRedisProfile);
            targetRedis.RegisterProfiler(() => targetRedisProfile);
            ServiceProvider sourceServices = CreateLedgerServices(connection);
            ServiceProvider targetServices = CreateLedgerServices(connection);
            var source = NodeHarness.Create("node-a", ["node-a", "node-b"], channel, prefix, sourceRedis, sourceServices);
            var target = NodeHarness.Create("node-b", ["node-a", "node-b"], channel, prefix, targetRedis, targetServices);
            await source.Bus.StartAsync(CancellationToken.None);
            await target.Bus.StartAsync(CancellationToken.None);
            await Task.Delay(TimeSpan.FromMilliseconds(150));
            return new(
                connection,
                prefix,
                channel,
                sourceRedis,
                targetRedis,
                sourceRedisProfile,
                targetRedisProfile,
                sourceServices,
                targetServices,
                source,
                target);
        }

        public void SeedBoth(int[] articles, bool seedSeo, bool seedCategory)
        {
            Source.Seed(articles, seedSeo, seedCategory);
            Target.Seed(articles, seedSeo, seedCategory);
        }

        public async ValueTask DisposeAsync()
        {
            await Target.Bus.StopAsync(CancellationToken.None);
            await Source.Bus.StopAsync(CancellationToken.None);
            await SourceServices.DisposeAsync();
            await TargetServices.DisposeAsync();
            await SourceRedis.DisposeAsync();
            await TargetRedis.DisposeAsync();
            Source.Dispose();
            Target.Dispose();
        }

        private static async Task<string> CreateDatabaseAsync(PostgresSchemaMigrationFixture postgres)
        {
            string connection = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(postgres);
            using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connection);
            PostgresSqlSugarTestClient.InitTables(
                db,
                typeof(DistributedInvalidationConvergenceObligationEntity),
                typeof(DistributedInvalidationInboxEntity),
                typeof(DistributedInvalidationTopologyRetirementEntity),
                typeof(DistributedInvalidationReconcileCoverageEntity),
                typeof(DistributedInvalidationFullReconcileObligationEntity));
            return connection;
        }

        private static ServiceProvider CreateLedgerServices(string connection)
            => new ServiceCollection()
                .AddScoped<ISqlSugarClient>(_ => PostgresSqlSugarTestClient.Create(connection))
                .AddSingleton(TimeProvider.System)
                .AddSingleton<DistributedInvalidationConvergenceRuntimeState>()
                .AddScoped<IDistributedInvalidationDeliveryLedger, DistributedInvalidationConvergenceObligationStore>()
                .BuildServiceProvider();
    }

    private sealed class NodeHarness : IDisposable
    {
        private readonly MemoryCache _memory;
        private readonly CachePolicyRegistry _policies = new();
        private readonly Dictionary<int, byte[]> _articleBytes = [];
        private readonly CountingApplier _counting;

        private NodeHarness(
            MemoryCache memory,
            CacheLocalStore localCache,
            PublicHotReadStore hotRead,
            CountingApplier counting,
            DistributedInvalidationBus bus)
        {
            _memory = memory;
            LocalCache = localCache;
            HotRead = hotRead;
            _counting = counting;
            Bus = bus;
        }

        public CacheLocalStore LocalCache
        {
            get;
        }
        public PublicHotReadStore HotRead
        {
            get;
        }
        public DistributedInvalidationBus Bus
        {
            get;
        }
        public int ApplierCount => _counting.Applied;
        public DistributedInvalidationLocalApplyResult? LastResult => _counting.LastResult;

        public static NodeHarness Create(
            string nodeId,
            IReadOnlyList<string> nodeIds,
            string channel,
            string prefix,
            IConnectionMultiplexer redis,
            ServiceProvider services)
        {
            var memory = new MemoryCache(new MemoryCacheOptions());
            var localCache = new CacheLocalStore(memory, TimeProvider.System);
            var environment = Substitute.For<IWebHostEnvironment>();
            environment.ContentRootPath.Returns(Path.GetTempPath());
            environment.WebRootPath.Returns(Path.GetTempPath());
            var publicAotCache = new PublicAotFileShellCache(
                environment,
                redis,
                NullLogger<PublicAotFileShellCache>.Instance,
                configuration: new ConfigurationBuilder().Build(),
                publicArtifactStorage: Substitute.For<IPublicArtifactStorage>());
            var hotRead = new PublicHotReadStore();
            var delivery = new InMemoryPublicHotArtifactDeliveryStateStore();
            var queue = new PublicHotArtifactUpdateQueue(
                Options.Create(new PublicHotReadOptions { UpdateQueueCapacity = 8 }),
                delivery,
                delivery);
            var inner = new DistributedInvalidationLocalApplier(
                localCache,
                publicAotCache,
                new PublicAotInvalidationTracker(new InMemoryPublicAotInvalidationGenerationAuthority()),
                new PublicAotSsrRuntimeState(new ConfigurationBuilder().Build()),
                hotRead,
                queue,
                Substitute.For<IAotSeoConfigSnapshot>(),
                new CacheInvalidationRuntimeState(),
                NullLogger<DistributedInvalidationLocalApplier>.Instance);
            var counting = new CountingApplier(inner);
            var options = new DistributedInvalidationOptions
            {
                RuntimeMode = RuntimeModeKind.StaticRole,
                NodeId = nodeId,
                Channel = channel,
                Topology = DistributedInvalidationTopologyManifest.Create(channel, nodeIds),
                ApplyRetryCount = 2,
                ApplyRetryDelay = TimeSpan.FromMilliseconds(10),
                RecoveryReplayInterval = TimeSpan.FromMilliseconds(100),
                DedupeCapacity = 128
            };
            var scope = new PrefixRuntimeKeyScope(prefix);
            var bus = new DistributedInvalidationBus(
                new RedisDistributedInvalidationTransport(
                    redis,
                    scope,
                    options,
                    TimeProvider.System,
                    services.GetRequiredService<IServiceScopeFactory>()),
                counting,
                new DistributedInvalidationEventFactory(options, scope, TimeProvider.System),
                options,
                new DistributedInvalidationRuntimeState(TimeProvider.System),
                new CacheInvalidationRuntimeState(),
                NullLogger<DistributedInvalidationBus>.Instance,
                services.GetRequiredService<IServiceScopeFactory>());
            return new NodeHarness(memory, localCache, hotRead, counting, bus);
        }

        public void Seed(int[] articles, bool seedSeo, bool seedCategory)
        {
            var encoder = new AedsEncoder();
            var frames = new Dictionary<int, PublicBinaryArtifact>();
            foreach (int articleId in articles)
            {
                byte[] payload = [(byte)articleId];
                _articleBytes[articleId] = payload;
                SeedPolicy(CachePolicyId.ArticleDetail, articleId.ToString(), payload);
                frames[articleId] = new(
                    encoder.Encode(AedsFrameType.ArticleDetail, payload),
                    $"\"{articleId}\"",
                    "public,max-age=60",
                    1,
                    AedsFrameType.ArticleDetail);
            }

            if (seedSeo)
            {
                SeedPolicy(CachePolicyId.SystemSeo, "main", [9]);
            }

            if (seedCategory)
            {
                SeedPolicy(CachePolicyId.CategoryFrame, "all", [8]);
            }

            PublicBinaryArtifact category = seedCategory
                ? new(encoder.Encode(AedsFrameType.CategoryList, [1]), "\"cat\"", "public,max-age=60", 1, AedsFrameType.CategoryList)
                : default;
            HotRead.Publish(new PublicHotReadSnapshot(
                1,
                frames.ToFrozenDictionary(),
                FrozenDictionary<PublicListKey, PublicBinaryArtifact>.Empty,
                category,
                default,
                FrozenDictionary<string, PublicHtmlArtifact>.Empty,
                PublicHotReadPublicationEvidence.CreateVerified(1, DateTimeOffset.UtcNow)));
        }

        public byte[] ArticleBytes(int articleId)
            => _articleBytes[articleId];

        public void Dispose()
            => _memory.Dispose();

        private void SeedPolicy(CachePolicyId policyId, string identity, byte[] payload)
        {
            Assert.True(_policies.TryGet(policyId, out CachePolicy policy));
            LocalCache.Set(
                policy,
                CacheL1Key.ForString("default", policyId, identity),
                policy.BuildKey(identity),
                payload);
        }
    }

    private sealed class CountingApplier(IDistributedInvalidationLocalApplier inner) : IDistributedInvalidationLocalApplier
    {
        public int Applied
        {
            get;
            private set;
        }
        public DistributedInvalidationLocalApplyResult? LastResult
        {
            get;
            private set;
        }

        public async Task<DistributedInvalidationLocalApplyResult?> ApplyAsync(
            DistributedInvalidationEvent invalidation,
            CancellationToken cancellationToken = default)
        {
            DistributedInvalidationLocalApplyResult? result = await inner
                .ApplyAsync(invalidation, cancellationToken)
                .ConfigureAwait(false);
            LastResult = result;
            Applied++;
            return result;
        }
    }

    private sealed class PrefixRuntimeKeyScope(string prefix) : IRuntimeKeyScope
    {
        public string ScopeToken => prefix;
        public string PrefixKey(string key)
            => string.Concat(prefix, key);
    }
}
