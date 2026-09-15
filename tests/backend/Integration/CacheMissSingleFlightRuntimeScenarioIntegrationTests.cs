using System.Net;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.Distribution;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging.Abstractions;

using Npgsql;

using NSubstitute;

using SqlSugar;

using StackExchange.Redis;

namespace FsusBlog.Server.Tests;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class CacheMissSingleFlightRuntimeScenarioIntegrationTests(
    PublicHotDeliveryRedisFixture redis,
    PostgresSchemaMigrationFixture postgres) : IClassFixture<PublicHotDeliveryRedisFixture>
{
    private const string Secret = "cache-miss-singleflight-runtime-secret";

    [Fact]
    public async Task RealKestrelPostgresRedis_SameKey100And1000_RebuildOnceAndDrainKeyedState()
    {
        await using ScenarioHost host = await ScenarioHost.StartAsync(redis, postgres);
        Assert.Contains("Kestrel", host.ServerIdentity, StringComparison.Ordinal);

        await AssertBurstAsync(host, 100);
        await AssertBurstAsync(host, 1000);
    }

    private static async Task AssertBurstAsync(ScenarioHost host, int concurrency)
    {
        await host.ResetAsync();
        await using TableReadBlocker blocker = await TableReadBlocker.AcquireAsync(host.ConnectionString);
        string cohort = host.Barrier.Prepare(concurrency);
        string[] requestIds = Enumerable.Range(0, concurrency)
            .Select(index => $"singleflight-{concurrency}-{index + 1}-{Guid.NewGuid():N}")
            .ToArray();
        Task<HttpResponseMessage>[] requests = requestIds
            .Select((requestId, index) => host.SendAsync(requestId, cohort, index + 1))
            .ToArray();

        await host.Barrier.AllArrived.WaitAsync(TimeSpan.FromSeconds(30));
        host.Barrier.Release();
        await Task.Delay(TimeSpan.FromMilliseconds(250));
        await blocker.ReleaseAsync();

        HttpResponseMessage[] responses = await Task.WhenAll(requests)
            .WaitAsync(TimeSpan.FromSeconds(30));
        try
        {
            Assert.All(responses, response => Assert.Equal(HttpStatusCode.OK, response.StatusCode));
        }
        finally
        {
            foreach (HttpResponseMessage response in responses)
            {
                response.Dispose();
            }
        }

        RuntimeCacheRequestObservation[] observations = requestIds.Select(requestId =>
        {
            Assert.True(host.Store.TryTake(requestId, out RuntimeCacheRequestObservation? observation));
            return Assert.IsType<RuntimeCacheRequestObservation>(observation);
        }).ToArray();
        Assert.All(observations, observation => Assert.True(observation.DatabaseAttributionComplete));
        Assert.Single(observations.Select(static observation => observation.PayloadDigest).Distinct(StringComparer.Ordinal));

        var events = observations
            .SelectMany(observation => observation.CacheEvents.Select(cacheEvent => (observation, cacheEvent)))
            .Where(row => row.cacheEvent.Family == "cache-miss-singleflight")
            .ToArray();
        var built = Assert.Single(events, row => row.cacheEvent.Outcome == "built");
        Assert.All(events, row => Assert.Contains(
            row.cacheEvent.Outcome,
            new[] { "hit", "built", "negative", "invalidated", "published" }));

        RuntimeCacheRequestObservation databaseRequest = Assert.Single(
            observations,
            static observation => observation.DatabaseCommandCount > 0);
        Assert.Equal(built.observation.RequestId, databaseRequest.RequestId);
        Assert.Equal(1, observations.Sum(static observation => observation.DatabaseCommandCount));
        Assert.Equal(1, observations.Sum(static observation => observation.DatabaseFingerprints.Count));
        string[] redisCommands = observations.SelectMany(static observation => observation.RedisCommands).ToArray();
        Assert.Contains("GET", redisCommands);
        Assert.NotEmpty(redisCommands);
        Assert.Equal(0, host.SingleFlight.ActiveEntryCount);
        Assert.Equal(0, host.SingleFlight.RejectByCapCount);
        Assert.Equal(0, host.SingleFlight.RejectByTimeoutCount);
    }

    private sealed class ScenarioHost : IAsyncDisposable
    {
        private readonly WebApplication _app;
        private readonly HttpClient _client;
        private readonly SqlSugarClient _database;
        private readonly ConnectionMultiplexer _redis;
        private readonly UnifiedCache _cache;
        private readonly MemoryCache _memory;
        private readonly string _redisPrefix;
        private readonly PublicHotDeliveryRedisFixture _redisFixture;

        private ScenarioHost(
            WebApplication app,
            HttpClient client,
            SqlSugarClient database,
            ConnectionMultiplexer redisConnection,
            UnifiedCache cache,
            MemoryCache memory,
            CacheSingleFlightCoordinator singleFlight,
            RuntimeCacheEvidenceStore store,
            BurstBarrier barrier,
            int articleId,
            string connectionString,
            string redisPrefix,
            PublicHotDeliveryRedisFixture redisFixture)
        {
            _app = app;
            _client = client;
            _database = database;
            _redis = redisConnection;
            _cache = cache;
            _memory = memory;
            SingleFlight = singleFlight;
            Store = store;
            Barrier = barrier;
            ArticleId = articleId;
            ConnectionString = connectionString;
            _redisPrefix = redisPrefix;
            _redisFixture = redisFixture;
            ServerIdentity = app.Services
                .GetRequiredService<Microsoft.AspNetCore.Hosting.Server.IServer>()
                .GetType()
                .FullName ?? string.Empty;
        }

        internal CacheSingleFlightCoordinator SingleFlight
        {
            get;
        }
        internal RuntimeCacheEvidenceStore Store
        {
            get;
        }
        internal BurstBarrier Barrier
        {
            get;
        }
        internal int ArticleId
        {
            get;
        }
        internal string ConnectionString
        {
            get;
        }
        internal string ServerIdentity
        {
            get;
        }

        internal static async Task<ScenarioHost> StartAsync(
            PublicHotDeliveryRedisFixture redisFixture,
            PostgresSchemaMigrationFixture postgresFixture)
        {
            string connectionString = await PostgresSqlSugarTestClient
                .CreateConnectionStringAsync(postgresFixture);
            var database = PostgresSqlSugarTestClient.Create(connectionString);
            int articleId = await SeedArticleAsync(database);
            ConnectionMultiplexer redisConnection = await redisFixture.ConnectAsync();
            redisConnection.RegisterProfiler(static () =>
                CacheCoordinationObservation.Current?.RedisProfile
                ?? RuntimeCacheEvidenceObservation.Current?.RedisProfile!);
            string redisPrefix = $"test:runtime-singleflight:{Guid.CreateVersion7():N}:";
            var scope = new PrefixRuntimeKeyScope(redisPrefix);
            var policies = new CachePolicyRegistry();
            var memory = new MemoryCache(new MemoryCacheOptions());
            var local = new PolicyShardedCacheL1Store(policies, scope);
            var resolver = new CacheKeyResolver(policies, scope, NullLogger<CacheKeyResolver>.Instance);
            var singleFlight = new CacheSingleFlightCoordinator(resolver);
            var cache = new UnifiedCache(
                memory,
                local,
                redisConnection,
                policies,
                scope,
                resolver,
                singleFlight,
                new CacheTelemetry(),
                NullLogger<UnifiedCache>.Instance,
                RedisOperationExecutor.ForTestConnection(redisConnection));
            var miss = new CacheMissCoordinator(
                singleFlight,
                cache,
                policies,
                NullLogger<CacheMissCoordinator>.Instance);
            var articles = new ArticleService(
                _db: database,
                _searchIndex: Substitute.For<ISearchIndexService>(),
                _redisOperations: RedisOperationExecutor.ForTestConnection(redisConnection),
                _cacheReader: cache,
                _cacheWriter: cache,
                _stringReader: cache,
                _stringWriter: cache,
                _cacheMissCoordinator: miss,
                _dbConcurrencyGate: new ImmediateDbConcurrencyGate(),
                _runtimeKeyScope: scope,
                _httpContextAccessor: new HttpContextAccessor(),
                _logger: NullLogger<ArticleService>.Instance,
                _publicAotInvalidationService: Substitute.For<IPublicAotInvalidationService>(),
                _cacheInvalidationDispatcher: Substitute.For<ICacheInvalidationDispatcher>(),
                _mutationFence: Substitute.For<IArticlePublicMutationFence>(),
                _mutationSideEffects: Substitute.For<IArticleMutationSideEffectCoordinator>(),
                _viewWriteBuffer: Substitute.For<IArticleViewWriteBuffer>(),
                _publicationValidator: ArticlePublicationValidatorTestFactory.CreateAllowing(),
                _articleBodyRepairQueue: new ArticleBodyRepairQueue());
            var store = new RuntimeCacheEvidenceStore();
            var barrier = new BurstBarrier();

            WebApplicationBuilder builder = WebApplication.CreateBuilder(new WebApplicationOptions
            {
                EnvironmentName = "Test"
            });
            builder.Configuration[RuntimeCacheEvidenceMiddleware.SecretConfigurationKey] = Secret;
            builder.Configuration["AllowedHosts"] = "127.0.0.1;localhost";
            builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, 0));
            builder.Services.AddRouting();
            builder.Services.AddSingleton(articles);
            builder.Services.AddSingleton<ICacheInvalidationStore>(cache);
            builder.Services.AddSingleton<ICacheDiagnostics>(cache);
            builder.Services.AddSingleton<ICacheSingleFlightCoordinator>(singleFlight);
            builder.Services.AddSingleton(singleFlight);
            builder.Services.AddSingleton(store);
            builder.Services.AddSingleton(barrier);
            builder.Services.AddSingleton<PublicAotInvalidationTracker>();
            builder.Services.AddSingleton<SitemapArtifactCache>();

            WebApplication app = builder.Build();
            app.UseMiddleware<RuntimeCacheEvidenceMiddleware>();
            app.UseRouting();
            app.UseMiddleware<AnonymousGatewayHeaderGuardMiddleware>();
            app.Use(async (context, next) =>
            {
                if (HttpMethods.IsGet(context.Request.Method)
                    && context.Request.Path.StartsWithSegments(
                        "/_fsus/testing/runtime-cache/scenarios/cache-miss-singleflight"))
                {
                    await barrier.WaitAsync(
                        context.Request.Query["cohort"].ToString(),
                        context.RequestAborted);
                }
                await next(context);
            });
            app.MapRuntimeCacheEvidenceEndpoints();
            await app.StartAsync();

            string address = app.Services.GetRequiredService<Microsoft.AspNetCore.Hosting.Server.IServer>()
                .Features.Get<IServerAddressesFeature>()!.Addresses.Single();
            var handler = new SocketsHttpHandler
            {
                UseProxy = false,
                MaxConnectionsPerServer = CacheMissPathBudget.SingleFlightMaxWaitersPerKey
            };
            var client = new HttpClient(handler)
            {
                BaseAddress = new Uri(address),
                Timeout = TimeSpan.FromSeconds(45)
            };
            return new ScenarioHost(
                app,
                client,
                database,
                redisConnection,
                cache,
                memory,
                singleFlight,
                store,
                barrier,
                articleId,
                connectionString,
                redisPrefix,
                redisFixture);
        }

        internal async Task ResetAsync()
        {
            using var request = new HttpRequestMessage(
                HttpMethod.Delete,
                $"/_fsus/testing/runtime-cache/scenarios/cache-miss-singleflight/{ArticleId}");
            request.Headers.TryAddWithoutValidation(RuntimeCacheEvidenceMiddleware.SecretHeader, Secret);
            using HttpResponseMessage response = await _client.SendAsync(request);
            string body = await response.Content.ReadAsStringAsync();
            Assert.True(
                response.StatusCode == HttpStatusCode.NoContent,
                $"Reset returned {(int)response.StatusCode} {response.StatusCode}: {body}");
        }

        internal Task<HttpResponseMessage> SendAsync(string requestId, string cohort, int ordinal)
        {
            var request = new HttpRequestMessage(
                HttpMethod.Get,
                $"/_fsus/testing/runtime-cache/scenarios/cache-miss-singleflight/{ArticleId}?cohort={cohort}&ordinal={ordinal}");
            request.Headers.TryAddWithoutValidation(RuntimeCacheEvidenceMiddleware.RequestIdHeader, requestId);
            request.Headers.TryAddWithoutValidation(RuntimeCacheEvidenceMiddleware.SecretHeader, Secret);
            return SendAndDisposeRequestAsync(request);
        }

        private async Task<HttpResponseMessage> SendAndDisposeRequestAsync(HttpRequestMessage request)
        {
            using (request)
            {
                return await _client.SendAsync(request);
            }
        }

        public async ValueTask DisposeAsync()
        {
            _client.Dispose();
            await _app.StopAsync();
            await _app.DisposeAsync();
            _cache.Dispose();
            SingleFlight.Dispose();
            _memory.Dispose();
            _database.Dispose();
            await _redis.DisposeAsync();
            await _redisFixture.DeleteNamespaceAsync(_redisPrefix);
        }
    }

    private sealed class BurstBarrier
    {
        private readonly object _gate = new();
        private Cohort? _cohort;

        internal Task AllArrived
        {
            get
            {
                lock (_gate)
                {
                    return (_cohort ?? throw new InvalidOperationException("burst_barrier_not_prepared"))
                        .AllArrived.Task;
                }
            }
        }

        internal string Prepare(int expected)
        {
            string id = Guid.NewGuid().ToString("N");
            lock (_gate)
            {
                _cohort = new Cohort(id, expected);
            }
            return id;
        }

        internal async Task WaitAsync(string cohortId, CancellationToken cancellationToken)
        {
            Cohort cohort;
            lock (_gate)
            {
                cohort = _cohort ?? throw new InvalidOperationException("burst_barrier_not_prepared");
                if (!string.Equals(cohort.Id, cohortId, StringComparison.Ordinal))
                {
                    return;
                }
                cohort.Arrived++;
                if (cohort.Arrived == cohort.Expected)
                {
                    cohort.AllArrived.TrySetResult();
                }
            }
            await cohort.Release.Task.WaitAsync(cancellationToken);
        }

        internal void Release()
        {
            lock (_gate)
            {
                (_cohort ?? throw new InvalidOperationException("burst_barrier_not_prepared"))
                    .Release.TrySetResult();
            }
        }

        private sealed class Cohort(string id, int expected)
        {
            internal string Id { get; } = id;

            internal int Expected { get; } = expected;

            internal int Arrived
            {
                get; set;
            }

            internal TaskCompletionSource AllArrived { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

            internal TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        }
    }

    private sealed class TableReadBlocker(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction) : IAsyncDisposable
    {
        private bool _released;

        internal static async Task<TableReadBlocker> AcquireAsync(string connectionString)
        {
            var connection = new NpgsqlConnection(connectionString);
            await connection.OpenAsync();
            NpgsqlTransaction transaction = await connection.BeginTransactionAsync();
            await using NpgsqlCommand command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = "LOCK TABLE article IN ACCESS EXCLUSIVE MODE";
            await command.ExecuteNonQueryAsync();
            return new TableReadBlocker(connection, transaction);
        }

        internal async Task ReleaseAsync()
        {
            if (_released)
            {
                return;
            }
            _released = true;
            await transaction.CommitAsync();
        }

        public async ValueTask DisposeAsync()
        {
            if (!_released)
            {
                await transaction.RollbackAsync();
            }
            await transaction.DisposeAsync();
            await connection.DisposeAsync();
        }
    }

    private static async Task<int> SeedArticleAsync(SqlSugarClient database)
    {
        PostgresSqlSugarTestClient.InitTables(
            database,
            typeof(Article),
            typeof(ArticleBody),
            typeof(ArticleRevision),
            typeof(ArticleRevisionContentBlock),
            typeof(ArticlePublicationRecord),
            typeof(ArticleRightsSnapshot),
            typeof(ArticleRightsProof),
            typeof(ArticleTag),
            typeof(Category),
            typeof(Tag));
        int categoryId = await database.Insertable(new Category
        {
            Name = $"singleflight-{Guid.NewGuid():N}"
        }).ExecuteReturnIdentityAsync();
        const string Content = "# singleflight runtime evidence";
        long contentBlockId = await database.Insertable(new ArticleRevisionContentBlock
        {
            ContentHash = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(
                System.Text.Encoding.UTF8.GetBytes(Content))),
            MarkdownContent = Content,
            ByteLength = System.Text.Encoding.UTF8.GetByteCount(Content)
        }).ExecuteReturnBigIdentityAsync();
        DateTime now = DateTime.UtcNow;
        int articleId = await database.Insertable(new Article
        {
            Title = "singleflight article",
            Summary = "singleflight summary",
            CategoryId = categoryId,
            Status = ArticleStatus.Published,
            PublishedAt = now,
            LastPublishedAt = now,
            PublicUpdatedAt = now,
            MetadataUpdatedAt = now,
            CreateTime = now
        }).ExecuteReturnIdentityAsync();
        long revisionId = await database.Insertable(new ArticleRevision
        {
            ArticleId = articleId,
            RevisionNo = 1,
            Title = "singleflight article",
            Summary = "singleflight summary",
            CategoryId = categoryId,
            ContentBlockId = contentBlockId,
            MarkdownContent = string.Empty,
            TagIds = string.Empty,
            DiffSummary = "initial",
            CreatedAt = now
        }).ExecuteReturnBigIdentityAsync();
        long publicationId = await database.Insertable(new ArticlePublicationRecord
        {
            ArticleId = articleId,
            PublicationNo = 1,
            ArticleRevisionId = revisionId,
            RevisionNo = 1,
            RightsSnapshotId = 0,
            TransitionKind = "published",
            PublishedAt = now,
            CreatedAt = now
        }).ExecuteReturnBigIdentityAsync();
        await database.Updateable<Article>()
            .SetColumns(article => new Article
            {
                CurrentRevisionId = revisionId,
                CurrentPublicationId = publicationId
            })
            .Where(article => article.Id == articleId)
            .ExecuteCommandAsync();
        return articleId;
    }

    private sealed class PrefixRuntimeKeyScope(string prefix) : IRuntimeKeyScope
    {
        public string ScopeToken => prefix;
        public string PrefixKey(string key) => string.Concat(prefix, key);
    }
}
