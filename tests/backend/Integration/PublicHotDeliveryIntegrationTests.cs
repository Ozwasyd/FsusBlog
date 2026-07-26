using System.Collections.Frozen;
using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.Taxonomy;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

using NSubstitute;

using SqlSugar;

using StackExchange.Redis;
namespace FsusBlog.Server.Tests;

[CollectionDefinition(nameof(PublicHotDeliveryIntegrationCollection))]
public sealed class PublicHotDeliveryIntegrationCollection :
    ICollectionFixture<PostgresSchemaMigrationFixture>,
    ICollectionFixture<PublicHotDeliveryRedisFixture>;

[Collection(nameof(PublicHotDeliveryIntegrationCollection))]
[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
public sealed class PublicHotDeliveryIntegrationTests(
    PostgresSchemaMigrationFixture postgres,
    PublicHotDeliveryRedisFixture redis)
{
    [Fact]
    public async Task RedisDeliveryState_LuaAndBothCrashWindowsSurviveFreshConnections()
    {
        string prefix = $"test:public-hot:{Guid.CreateVersion7():N}:";
        try
        {
            await using ConnectionMultiplexer first = await redis.ConnectAsync();
            var firstScope = new PrefixRuntimeKeyScope(prefix);
            var firstStore = new RedisPublicHotArtifactDeliveryStateStore(first, firstScope);
            RedisKey generationKey = firstScope.PrefixKey("public-hot-read:{delivery}:generation");
            RedisKey pendingKey = firstScope.PrefixKey("public-hot-read:{delivery}:pending-generation");
            Assert.Equal(first.HashSlot(generationKey), first.HashSlot(pendingKey));

            long firstGeneration = await firstStore.MarkDirtyAsync(
                PublicHotArtifactDeliveryClass.RequiredContent,
                CancellationToken.None);
            long secondGeneration = await firstStore.MarkDirtyAsync(
                PublicHotArtifactDeliveryClass.RequiredContent,
                CancellationToken.None);
            Assert.True(secondGeneration > firstGeneration);
            await firstStore.CompleteAsync(firstGeneration, CancellationToken.None);
            Assert.Equal(secondGeneration, await firstStore.GetPendingGenerationAsync(CancellationToken.None));

            await using ConnectionMultiplexer afterCompareClear = await redis.ConnectAsync();
            var afterCompareClearStore =
                new RedisPublicHotArtifactDeliveryStateStore(afterCompareClear, new PrefixRuntimeKeyScope(prefix));
            long thirdGeneration = await afterCompareClearStore.MarkDirtyAsync(
                PublicHotArtifactDeliveryClass.RequiredContent,
                CancellationToken.None);
            Assert.True(thirdGeneration > secondGeneration);
            await afterCompareClearStore.CompleteAsync(secondGeneration, CancellationToken.None);
            Assert.Equal(
                thirdGeneration,
                await afterCompareClearStore.GetPendingGenerationAsync(CancellationToken.None));
            await afterCompareClearStore.CompleteAsync(thirdGeneration, CancellationToken.None);
            Assert.Equal(0, await afterCompareClearStore.GetPendingGenerationAsync(CancellationToken.None));

            string markerBeforeChannelPrefix = string.Concat(prefix, "marker-before-channel:");
            long markerBeforeChannelGeneration;
            await using (ConnectionMultiplexer crashedBeforeChannel = await redis.ConnectAsync())
            {
                var crashedStore = new RedisPublicHotArtifactDeliveryStateStore(
                    crashedBeforeChannel,
                    new PrefixRuntimeKeyScope(markerBeforeChannelPrefix));
                markerBeforeChannelGeneration = await crashedStore.MarkDirtyAsync(
                    PublicHotArtifactDeliveryClass.RequiredTaxonomy,
                    CancellationToken.None);
            }
            await RecoverWithFreshWorkerAsync(
                redis,
                markerBeforeChannelPrefix,
                markerBeforeChannelGeneration);

            string channelBeforePublishPrefix = string.Concat(prefix, "channel-before-publish:");
            long channelBeforePublishGeneration;
            await using (ConnectionMultiplexer crashedBeforePublish = await redis.ConnectAsync())
            {
                var crashedStore = new RedisPublicHotArtifactDeliveryStateStore(
                    crashedBeforePublish,
                    new PrefixRuntimeKeyScope(channelBeforePublishPrefix));
                var crashedQueue = CreateQueue(crashedStore);
                PublicHotArtifactEnqueueResult receipt = await crashedQueue.EnqueueAsync(
                    PublicHotArtifactDeliveryClass.RequiredContent,
                    42,
                    "article-updated");
                Assert.Equal(PublicHotArtifactDeliveryStatus.Accepted, receipt.Status);
                channelBeforePublishGeneration = receipt.DeliveryGeneration;
            }
            await RecoverWithFreshWorkerAsync(
                redis,
                channelBeforePublishPrefix,
                channelBeforePublishGeneration);
        }
        finally
        {
            await redis.DeleteNamespaceAsync(prefix);
        }
    }

    [Fact]
    public async Task RedisObligation_LuaCasRetainsTerminalEvidenceAcrossFreshConnections()
    {
        string prefix = $"test:public-hot-obligation:{Guid.CreateVersion7():N}:";
        try
        {
            string obligationId;
            await using (ConnectionMultiplexer writer = await redis.ConnectAsync())
            {
                var store = new RedisPublicHotArtifactDeliveryStateStore(writer, new PrefixRuntimeKeyScope(prefix));
                PublicHotArtifactObligation created = await store.MergeAsync(
                    new PublicHotArtifactUpdate(7, "article-updated", PublicHotArtifactDirtyReason.Content, 12),
                    CancellationToken.None);
                PublicHotArtifactObligation claim = (await store.ClaimEligibleAsync(DateTimeOffset.UtcNow, CancellationToken.None))!;
                PublicHotArtifactObligation terminal = await store.RecordFailureAsync(
                    created.ObligationId,
                    claim.AttemptNumber,
                    PublicHotArtifactAttemptStage.Projector,
                    new TimeoutException("injected"),
                    DateTimeOffset.UtcNow,
                    max: 1,
                    ct: CancellationToken.None);
                obligationId = terminal.ObligationId;
                Assert.Equal(PublicHotArtifactObligationState.FailedTerminal, terminal.State);
                Assert.Single(terminal.Attempts);
            }

            await using ConnectionMultiplexer reader = await redis.ConnectAsync();
            var restarted = new RedisPublicHotArtifactDeliveryStateStore(reader, new PrefixRuntimeKeyScope(prefix));
            PublicHotArtifactObligation persisted = (await restarted.GetActiveAsync(CancellationToken.None))!;
            Assert.Equal(obligationId, persisted.ObligationId);
            Assert.Equal(PublicHotArtifactObligationState.FailedTerminal, persisted.State);
            Assert.True(await restarted.HasTerminalFailureAsync(CancellationToken.None));
            PublicHotArtifactObligation replayable = await restarted.MergeAsync(
                new PublicHotArtifactUpdate(null, "taxonomy-updated", PublicHotArtifactDirtyReason.Content), CancellationToken.None);
            Assert.Equal(obligationId, replayable.ObligationId);
            Assert.Equal(PublicHotArtifactObligationState.Pending, replayable.State);
            Assert.True(replayable.RequiresFullRebuild);
            Assert.Contains(replayable.Attempts, static attempt => attempt.FailureKind == PublicHotArtifactFailureKind.ProjectorTransient);
            Assert.False(await restarted.HasTerminalFailureAsync(CancellationToken.None));
            PublicHotArtifactObligation replay = (await restarted.ClaimEligibleAsync(DateTimeOffset.UtcNow, CancellationToken.None))!;
            Assert.True(await restarted.CompletePublishedAsync(replay.ObligationId, replay.AttemptNumber, replay.TargetGeneration, CancellationToken.None));
        }
        finally
        {
            await redis.DeleteNamespaceAsync(prefix);
        }
    }

    [Fact]
    public async Task RedisObligation_ConcurrentMergeSurvivesFailureAndStaleCompletion()
    {
        string prefix = $"test:public-hot-interleave:{Guid.CreateVersion7():N}:";
        try
        {
            await using ConnectionMultiplexer connection = await redis.ConnectAsync();
            var state = new RedisPublicHotArtifactDeliveryStateStore(connection, new PrefixRuntimeKeyScope(prefix));
            PublicHotArtifactObligation initial = await state.MergeAsync(
                new PublicHotArtifactUpdate(41, "article-a", PublicHotArtifactDirtyReason.Content, 101), CancellationToken.None);
            PublicHotArtifactObligation claim = (await state.ClaimEligibleAsync(DateTimeOffset.UtcNow, CancellationToken.None))!;
            PublicHotArtifactObligation merged = await state.MergeAsync(
                new PublicHotArtifactUpdate(null, "global", PublicHotArtifactDirtyReason.Content), CancellationToken.None);
            merged = await state.MergeAsync(
                new PublicHotArtifactUpdate(42, "article-b", PublicHotArtifactDirtyReason.Content, 202), CancellationToken.None);

            PublicHotArtifactObligation failed = await state.RecordFailureAsync(
                initial.ObligationId, claim.AttemptNumber, PublicHotArtifactAttemptStage.Projector,
                new TimeoutException("injected"), DateTimeOffset.UtcNow, 3, CancellationToken.None);
            Assert.Equal(PublicHotArtifactObligationState.FailedRetryable, failed.State);
            Assert.Equal(merged.TargetGeneration, failed.TargetGeneration);
            Assert.True(failed.RequiresFullRebuild);
            Assert.Contains(41, failed.ArticleIds);
            Assert.Contains(42, failed.ArticleIds);
            Assert.Equal(202, failed.ExpectedReleaseIds[42]);

            PublicHotArtifactObligation replay = (await state.ClaimEligibleAsync(DateTimeOffset.MaxValue, CancellationToken.None))!;
            bool completed = await state.CompletePublishedAsync(
                replay.ObligationId, replay.AttemptNumber, initial.TargetGeneration, CancellationToken.None);
            PublicHotArtifactObligation pending = (await state.GetActiveAsync(CancellationToken.None))!;
            Assert.False(completed);
            Assert.Equal(PublicHotArtifactObligationState.Pending, pending.State);
            Assert.Equal(merged.TargetGeneration, pending.TargetGeneration);
            Assert.True(pending.RequiresFullRebuild);
            Assert.Contains(42, pending.ArticleIds);
        }
        finally
        {
            await redis.DeleteNamespaceAsync(prefix);
        }
    }

    [Fact]
    public async Task CategoryCreate_AdminBinaryEndpoint_CommitsRowThenReturnsAedsInfraFailure()
    {
        string databaseName = await postgres.CreateDatabaseAsync();
        string connectionString = postgres.BuildDatabaseConnectionString(databaseName);
        await postgres.ExecuteAsync(connectionString, """
            CREATE TABLE category (
                id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                name varchar(128) NOT NULL UNIQUE
            );
            """);
        string categoryName = $"delivery-failure-{Guid.CreateVersion7():N}";
        var invalidator = Substitute.For<IHttpCacheInvalidator>();
        invalidator.InvalidateAsync(Arg.Any<CacheTag[]>()).Returns(Task.CompletedTask);
        var taxonomyProjection = Substitute.For<ITaxonomyCountProjectionService>();
        taxonomyProjection.BumpFrameVersionAsync(Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(1L);
        var failedQueue = CreateQueue(new FailingDeliveryStateStore());
        using EndpointSecurityTestServer server = EndpointSecurityTestServer.Create(
            new EndpointSecurityTestServerOptions
            {
                ConfigureServices = services =>
                {
                    services.RemoveAll<ISqlSugarClient>();
                    services.AddScoped<ISqlSugarClient>(_ => CreateSqlSugar(connectionString));
                    services.RemoveAll<IHttpCacheInvalidator>();
                    services.AddSingleton(invalidator);
                    services.RemoveAll<ITaxonomyCountProjectionService>();
                    services.AddSingleton(taxonomyProjection);
                    services.RemoveAll<PublicHotArtifactUpdateQueue>();
                    services.AddSingleton(failedQueue);
                }
            });
        using HttpClient client = server.CreateClient();
        using HttpRequestMessage request = CreateCategoryRequest(categoryName);
        EndpointSecurityTestServer.AddAdminPrincipal(request, AdminPermissions.ArticleWrite);
        EndpointSecurityTestServer.AddPowProof(request);

        using HttpResponseMessage response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        ErrorDetail error = await EndpointSecurityTestServer.ReadErrorAsync(response);
        Assert.Equal(ErrorCode.InfraFailure, error.Code);
        Assert.Contains("已创建", error.Message, StringComparison.Ordinal);
        Assert.Equal(
            1,
            await postgres.QueryScalarAsync<int>(
                connectionString,
                $"SELECT COUNT(*) FROM category WHERE name = '{categoryName}';"));
        await taxonomyProjection.Received(1).BumpFrameVersionAsync(
            "taxonomy-category-created",
            CancellationToken.None);
        await invalidator.Received(1).InvalidateAsync(CacheTag.Category, CacheTag.ArticleList);
    }

    [Fact]
    public async Task CategoryCreate_AnonymousAndOrdinaryLoginNeverReachMutationHandler()
    {
        string databaseName = await postgres.CreateDatabaseAsync();
        string connectionString = postgres.BuildDatabaseConnectionString(databaseName);
        await postgres.ExecuteAsync(connectionString, """
            CREATE TABLE category (
                id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                name varchar(128) NOT NULL UNIQUE
            );
            """);
        using EndpointSecurityTestServer server = EndpointSecurityTestServer.Create(
            new EndpointSecurityTestServerOptions
            {
                ConfigureServices = services =>
                {
                    services.RemoveAll<ISqlSugarClient>();
                    services.AddScoped<ISqlSugarClient>(_ => CreateSqlSugar(connectionString));
                }
            });

        using HttpClient anonymousClient = server.CreateClient();
        using HttpRequestMessage anonymousRequest = CreateCategoryRequest("anonymous-must-not-write");
        using HttpResponseMessage anonymousResponse = await anonymousClient.SendAsync(anonymousRequest);
        Assert.Equal(HttpStatusCode.Unauthorized, anonymousResponse.StatusCode);
        Assert.Equal(AedsFrameType.ApiError, await ReadFrameTypeAsync(anonymousResponse));

        using HttpClient loginClient = server.CreateClient();
        using HttpRequestMessage loginRequest = CreateCategoryRequest("login-must-not-write");
        EndpointSecurityTestServer.AddAnonymousAccount(loginRequest);
        using HttpResponseMessage loginResponse = await loginClient.SendAsync(loginRequest);
        Assert.Equal(HttpStatusCode.Forbidden, loginResponse.StatusCode);
        Assert.Equal(AedsFrameType.ApiError, await ReadFrameTypeAsync(loginResponse));

        Assert.Equal(0, await postgres.QueryScalarAsync<int>(connectionString, "SELECT COUNT(*) FROM category;"));
    }

    private static PublicHotArtifactUpdateQueue CreateQueue(IPublicHotArtifactDeliveryStateStore state)
        => new(
            Options.Create(new PublicHotReadOptions
            {
                UpdateQueueCapacity = 1,
                UpdateDebounceMilliseconds = 0
            }),
            state);

    private static SqlSugarClient CreateSqlSugar(string connectionString)
        => new(new ConnectionConfig
        {
            ConnectionString = connectionString,
            DbType = DbType.PostgreSQL,
            IsAutoCloseConnection = true,
            InitKeyType = InitKeyType.Attribute,
            MoreSettings = new ConnMoreSettings
            {
                PgSqlIsAutoToLower = true,
                PgSqlIsAutoToLowerCodeFirst = true
            }
        });

    private static HttpRequestMessage CreateCategoryRequest(string name)
    {
        var encoder = new AedsEncoder();
        byte[] frame = encoder.Encode(
            AedsFrameType.CategoryWriteRequest,
            PodBinaryCodec.EncodeNameMutationRequest(name));
        var request = new HttpRequestMessage(HttpMethod.Post, "/api/binary/category")
        {
            Content = new ByteArrayContent(frame)
        };
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/octet-stream"));
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        return request;
    }

    private static async Task<AedsFrameType> ReadFrameTypeAsync(HttpResponseMessage response)
    {
        byte[] body = await response.Content.ReadAsByteArrayAsync();
        Result<AedsDecodeResult> decoded = new AedsEncoder().TryDecode(body);
        Assert.True(decoded.IsSuccess, decoded.Error.Message);
        return decoded.Value.FrameType;
    }

    private static async Task RecoverWithFreshWorkerAsync(
        PublicHotDeliveryRedisFixture fixture,
        string prefix,
        long expectedGeneration)
    {
        await using ConnectionMultiplexer restartedConnection = await fixture.ConnectAsync();
        var restartedState = new RedisPublicHotArtifactDeliveryStateStore(
            restartedConnection,
            new PrefixRuntimeKeyScope(prefix));
        Assert.Equal(
            expectedGeneration,
            await restartedState.GetPendingGenerationAsync(CancellationToken.None));
        var queue = CreateQueue(restartedState);
        var store = new PublicHotReadStore();
        await using ServiceProvider services = new ServiceCollection()
            .AddScoped<IPublicHotArtifactProjector, FixedProjector>()
            .BuildServiceProvider();
        using var worker = new PublicHotArtifactUpdateWorker(
            queue,
            store,
            new NoopRevocations(),
            services.GetRequiredService<IServiceScopeFactory>(),
            Options.Create(new PublicHotReadOptions { UpdateDebounceMilliseconds = 0 }),
            NullLogger<PublicHotArtifactUpdateWorker>.Instance);

        await worker.StartAsync(CancellationToken.None);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (await restartedState.GetPendingGenerationAsync(CancellationToken.None) != 0)
        {
            await Task.Delay(TimeSpan.FromMilliseconds(20), timeout.Token);
        }
        await worker.StopAsync(CancellationToken.None);

        Assert.Equal(1, store.Current.Version);
    }

    private sealed class PrefixRuntimeKeyScope(string prefix) : IRuntimeKeyScope
    {
        public string ScopeToken => prefix;
        public string PrefixKey(string key) => string.Concat(prefix, key);
    }

    private sealed class FailingDeliveryStateStore : IPublicHotArtifactDeliveryStateStore
    {
        public Task<long> MarkDirtyAsync(
            PublicHotArtifactDeliveryClass deliveryClass,
            CancellationToken cancellationToken)
            => throw new InvalidOperationException("injected delivery persistence failure");

        public Task<long> GetPendingGenerationAsync(CancellationToken cancellationToken)
            => Task.FromResult(0L);

        public Task CompleteAsync(long generation, CancellationToken cancellationToken)
            => Task.CompletedTask;
    }

    private sealed class FixedProjector : IPublicHotArtifactProjector
    {
        public Task<PublicHotReadSnapshot> BuildInitialSnapshotAsync(CancellationToken cancellationToken)
            => Task.FromResult(CreateSnapshot());

        public Task<PublicHotReadSnapshot> RebuildAfterArticleMutationAsync(
            PublicHotReadSnapshot current,
            int articleId,
            CancellationToken cancellationToken)
            => Task.FromResult(CreateSnapshot());

        public Task<PublicHotReadSnapshot> RebuildAfterViewProjectionAsync(
            PublicHotReadSnapshot current,
            IReadOnlyCollection<int> articleIds,
            CancellationToken cancellationToken)
            => Task.FromResult(CreateSnapshot());

        private static PublicHotReadSnapshot CreateSnapshot()
            => new(
                1,
                FrozenDictionary<int, PublicBinaryArtifact>.Empty,
                FrozenDictionary<PublicListKey, PublicBinaryArtifact>.Empty,
                default,
                default,
                FrozenDictionary<string, PublicHtmlArtifact>.Empty,
                PublicHotReadPublicationEvidence.CreateVerified(1, DateTimeOffset.UtcNow));
    }

    private sealed class NoopRevocations : IPublicArtifactRevocationCoordinator
    {
        public long CurrentGeneration => 0;
        public Task BeginArticleMutationFenceAsync(int articleId, CancellationToken cancellationToken = default)
            => Task.CompletedTask;
        public Task BeginGlobalMutationFenceAsync(CancellationToken cancellationToken = default)
            => Task.CompletedTask;
        public Task<bool> RecoverPendingMutationFenceAsync(
            PublicArtifactTombstone tombstone,
            CancellationToken cancellationToken = default)
            => Task.FromResult(false);
        public Task RevokeArticleAsync(int articleId, CancellationToken cancellationToken = default)
            => Task.CompletedTask;
        public Task RevokeAllAsync(CancellationToken cancellationToken = default)
            => Task.CompletedTask;
        public Task CompleteRebuildAsync(
            IReadOnlyCollection<int>? articleIds,
            long maximumGeneration,
            CancellationToken cancellationToken = default)
            => Task.CompletedTask;
    }
}

public sealed class PublicHotDeliveryRedisFixture : IAsyncLifetime
{
    private string? _containerName;
    private string? _connectionString;

    public async Task InitializeAsync()
    {
        _containerName = $"fsus-public-hot-redis-{Environment.ProcessId}-{Guid.NewGuid():N}";
        string testRunId = Environment.GetEnvironmentVariable("FSUSBLOG_TEST_RUN_ID") ?? "local";
        _ = await RunDockerAsync(
            "run",
            "--rm",
            "-d",
            "--name",
            _containerName,
            "--label",
            "com.fsusblog.test.kind=public-hot-delivery",
            "--label",
            $"com.fsusblog.test.owner-pid={Environment.ProcessId}",
            "--label",
            $"com.fsusblog.test.run-id={testRunId}",
            "-p",
            "127.0.0.1::6379",
            "redis:7-alpine",
            "redis-server",
            "--save",
            "",
            "--appendonly",
            "no");
        string port = await RunDockerAsync("port", _containerName, "6379/tcp");
        int separator = port.LastIndexOf(':');
        if (separator < 0 || !int.TryParse(port[(separator + 1)..].Trim(), out int mappedPort))
        {
            throw new InvalidOperationException($"Unable to parse Redis mapped port: {port}");
        }

        _connectionString =
            $"127.0.0.1:{mappedPort},abortConnect=true,connectTimeout=1000,syncTimeout=5000,asyncTimeout=5000";
        Exception? lastError = null;
        DateTime deadline = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                await using ConnectionMultiplexer connection = await ConnectAsync();
                if (await connection.GetDatabase().PingAsync() >= TimeSpan.Zero)
                {
                    return;
                }
            }
            catch (Exception ex)
            {
                lastError = ex;
            }

            await Task.Delay(TimeSpan.FromMilliseconds(100));
        }

        throw new InvalidOperationException("Disposable Redis did not become ready.", lastError);
    }

    public async Task DisposeAsync()
    {
        if (!string.IsNullOrWhiteSpace(_containerName))
        {
            try
            {
                _ = await RunDockerAsync("rm", "-f", "-v", _containerName);
            }
            catch
            {
                // Container cleanup is best effort after the test outcome is already known.
            }
        }
    }

    public Task<ConnectionMultiplexer> ConnectAsync()
        => ConnectionMultiplexer.ConnectAsync(
            _connectionString ?? throw new InvalidOperationException("Redis fixture is not initialized."));

    public async Task DeleteNamespaceAsync(string prefix)
    {
        await using ConnectionMultiplexer connection = await ConnectAsync();
        EndPoint endpoint = Assert.Single(connection.GetEndPoints());
        RedisKey[] keys = connection.GetServer(endpoint).Keys(pattern: string.Concat(prefix, "*")).ToArray();
        if (keys.Length > 0)
        {
            await connection.GetDatabase().KeyDeleteAsync(keys);
        }
    }

    private static async Task<string> RunDockerAsync(params string[] arguments)
    {
        var startInfo = new ProcessStartInfo("docker")
        {
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false
        };
        foreach (string argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Failed to start docker.");
        Task<string> stdout = process.StandardOutput.ReadToEndAsync();
        Task<string> stderr = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        string output = await stdout;
        string error = await stderr;
        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException(
                $"docker {string.Join(' ', arguments)} failed ({process.ExitCode}): {error}");
        }

        return output.Trim();
    }
}
