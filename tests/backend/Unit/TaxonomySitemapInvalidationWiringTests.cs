using System.Diagnostics;
using System.Reflection;

using FsusBlog.Core.Cache;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.Distribution;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

using NSubstitute;

using StackExchange.Redis;

namespace FsusBlog.Server.Tests.Unit;

public sealed class TaxonomySitemapInvalidationWiringTests
{
    [Theory]
    [InlineData("/api/binary/category", "POST")]
    [InlineData("/api/binary/category/{id:int}", "PUT")]
    [InlineData("/api/binary/category/{id:int}", "DELETE")]
    [InlineData("/api/binary/tag", "POST")]
    [InlineData("/api/binary/tag/{id:int}", "PUT")]
    [InlineData("/api/binary/tag/{id:int}", "DELETE")]
    [Trait("ShardAffinity", "EndpointContractApplication")]
    public async Task ProductionMutationHandlers_InjectDispatcherAndReachExactlyOneSitemapInvalidation(
        string route,
        string method)
    {
        await using EndpointContractSnapshot app = EndpointContractApplication.CreateSnapshot();
        RouteEndpoint endpoint = EndpointContractApplication.Find(app, route, method);
        MethodInfo handler = Assert.IsAssignableFrom<MethodInfo>(endpoint.Metadata.GetMetadata<MethodInfo>());

        Assert.Single(
            handler.GetParameters(),
            static parameter => parameter.ParameterType == typeof(ICacheInvalidationDispatcher));

        string runtimeShape = RuntimeMetadataInspection.DescribeMethods(handler.DeclaringType!, handler.Name);
        int fullInvalidationCalls = CountOccurrences(
            runtimeShape,
            $"{nameof(ICacheInvalidationDispatcher)}.{nameof(ICacheInvalidationDispatcher.InvalidateCategoryTagAsync)}");
        int metadataInvalidationCalls = CountOccurrences(
            runtimeShape,
            $"{nameof(ICacheInvalidationDispatcher)}.{nameof(ICacheInvalidationDispatcher.InvalidateTaxonomyMetadataAsync)}");
        if (method == "PUT")
        {
            Assert.Equal(1, fullInvalidationCalls);
            Assert.Equal(1, metadataInvalidationCalls);
        }
        else
        {
            Assert.Equal(1, fullInvalidationCalls);
            Assert.Equal(0, metadataInvalidationCalls);
        }
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task SuccessfulCategoryOrTagUpdate_InvalidatesSitemapExactlyOnce(bool isCategory)
    {
        ICacheInvalidationStore cache = Substitute.For<ICacheInvalidationStore>();
        ICacheInvalidationDispatcher dispatcher = Substitute.For<ICacheInvalidationDispatcher>();
        IPublicAotInvalidationService publicAot = Substitute.For<IPublicAotInvalidationService>();

        await BinaryEndpoints.DispatchTaxonomyUpdateSideEffectsAsync(
            new BinaryEndpoints.TaxonomyUpdateApplyResult(
                BinaryEndpoints.TaxonomyUpdateOutcome.Updated,
                NameChanged: true,
                DescriptionChanged: false),
            isCategory ? 7 : 11,
            isCategory,
            cache,
            dispatcher,
            publicAot,
            isCategory ? "taxonomy-category-updated" : "taxonomy-tag-updated",
            CancellationToken.None);

        await dispatcher.Received(1).InvalidateCategoryTagAsync(Arg.Any<CancellationToken>());
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task NoOpCategoryOrTagUpdate_DoesNotInvalidateSitemap(bool isCategory)
    {
        ICacheInvalidationStore cache = Substitute.For<ICacheInvalidationStore>();
        ICacheInvalidationDispatcher dispatcher = Substitute.For<ICacheInvalidationDispatcher>();
        IPublicAotInvalidationService publicAot = Substitute.For<IPublicAotInvalidationService>();

        await BinaryEndpoints.DispatchTaxonomyUpdateSideEffectsAsync(
            new BinaryEndpoints.TaxonomyUpdateApplyResult(
                BinaryEndpoints.TaxonomyUpdateOutcome.NoOp,
                NameChanged: false,
                DescriptionChanged: false),
            isCategory ? 7 : 11,
            isCategory,
            cache,
            dispatcher,
            publicAot,
            isCategory ? "taxonomy-category-updated" : "taxonomy-tag-updated",
            CancellationToken.None);

        await dispatcher.DidNotReceive().InvalidateCategoryTagAsync(Arg.Any<CancellationToken>());
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task DescriptionOnlyCategoryOrTagUpdate_PreservesPreciseNonSitemapInvalidation(bool isCategory)
    {
        ICacheInvalidationStore cache = Substitute.For<ICacheInvalidationStore>();
        ICacheInvalidationDispatcher dispatcher = Substitute.For<ICacheInvalidationDispatcher>();
        IPublicAotInvalidationService publicAot = Substitute.For<IPublicAotInvalidationService>();
        string routeKey = isCategory
            ? PublicRouteIdentity.BuildCategoryRouteKey(7)
            : PublicRouteIdentity.BuildTagIdRouteKey(11);

        await BinaryEndpoints.DispatchTaxonomyUpdateSideEffectsAsync(
            new BinaryEndpoints.TaxonomyUpdateApplyResult(
                BinaryEndpoints.TaxonomyUpdateOutcome.Updated,
                NameChanged: false,
                DescriptionChanged: true),
            isCategory ? 7 : 11,
            isCategory,
            cache,
            dispatcher,
            publicAot,
            isCategory ? "taxonomy-category-updated" : "taxonomy-tag-updated",
            CancellationToken.None);

        await dispatcher.DidNotReceive().InvalidateCategoryTagAsync(Arg.Any<CancellationToken>());
        await publicAot.Received(1).InvalidateFilterRouteFamilyAsync(
            routeKey,
            Arg.Any<string>(),
            Arg.Any<CancellationToken>());
        await dispatcher.Received(1).InvalidateTaxonomyMetadataAsync(
            routeKey,
            Arg.Any<string>(),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    [Trait("Category", "Integration")]
    [Trait("Dependency", "Docker")]
    public async Task RedisServerStopStart_PreservesDurableSitemapGenerationAndHotHit()
    {
        string containerName = $"fsus-sitemap-generation-{Environment.ProcessId}-{Guid.NewGuid():N}";
        string scopePrefix = $"test:sitemap-server-restart:{Guid.NewGuid():N}:";
        try
        {
            _ = await RunDockerAsync(
                "run",
                "-d",
                "--name",
                containerName,
                "--label",
                "com.fsusblog.test.kind=sitemap-generation-restart",
                "-p",
                "127.0.0.1::6379",
                "redis:7-alpine",
                "redis-server",
                "--appendonly",
                "yes",
                "--appendfsync",
                "always");
            string connectionString = await GetRedisConnectionStringAsync(containerName);
            await WaitForRedisAsync(connectionString);

            await using ConnectionMultiplexer sourceConnection = await ConnectionMultiplexer.ConnectAsync(connectionString);
            var source = new PublicAotInvalidationTracker(CreateAuthority(sourceConnection, scopePrefix));
            await source.InitializeAsync(CancellationToken.None);
            var sourceArtifacts = new SitemapArtifactCache(source);
            _ = await sourceArtifacts.GetOrBuildAsync(
                _ => Task.FromResult(BuildArtifact("generation-zero")),
                CancellationToken.None);
            _ = await source.MarkSitemapAsync("taxonomy:before-redis-server-restart");
            SitemapArtifactSet durableArtifact = await sourceArtifacts.GetOrBuildAsync(
                _ => Task.FromResult(BuildArtifact("durable-current")),
                CancellationToken.None);
            long durableGeneration = source.GetSitemapGeneration();
            Assert.True(durableGeneration > 0);

            _ = await RunDockerAsync("stop", "--timeout", "10", containerName);
            SitemapArtifactSet outageHit = await sourceArtifacts.GetOrBuildAsync(
                _ => Task.FromException<SitemapArtifactBuildResult>(new InvalidOperationException("hot-hit-rebuilt")),
                CancellationToken.None);
            Assert.Same(durableArtifact, outageHit);
            using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5)))
            {
                _ = await Assert.ThrowsAsync<RedisOperationUnavailableException>(
                    () => source.MarkSitemapAsync("taxonomy:during-redis-server-outage", timeout.Token));
            }

            _ = await RunDockerAsync("start", containerName);
            connectionString = await GetRedisConnectionStringAsync(containerName);
            await WaitForRedisAsync(connectionString);
            await using ConnectionMultiplexer restartedConnection = await ConnectionMultiplexer.ConnectAsync(connectionString);
            var restarted = new PublicAotInvalidationTracker(CreateAuthority(restartedConnection, scopePrefix));
            await restarted.InitializeAsync(CancellationToken.None);
            var restartedArtifacts = new SitemapArtifactCache(restarted);
            SitemapArtifactSet afterRestart = await restartedArtifacts.GetOrBuildAsync(
                _ => Task.FromResult(BuildArtifact("after-server-restart")),
                CancellationToken.None);

            Assert.Equal(durableGeneration, restarted.GetSitemapGeneration());
            Assert.Equal(durableGeneration, afterRestart.Generation);
            Assert.NotEqual(0, afterRestart.Generation);
            Assert.NotEqual(durableArtifact.RootDocument, afterRestart.RootDocument);
        }
        finally
        {
            try
            {
                _ = await RunDockerAsync("rm", "-f", "-v", containerName);
            }
            catch
            {
                // Cleanup is best effort after preserving the test outcome.
            }
        }
    }

    private static RedisPublicAotInvalidationGenerationAuthority CreateAuthority(
        IConnectionMultiplexer connection,
        string scopePrefix)
        => new(
            RedisOperationExecutor.ForTestConnection(connection),
            new PrefixRuntimeKeyScope(scopePrefix),
            Substitute.For<IPublicAotInvalidationGenerationBootstrapGuard>());

    private static SitemapArtifactBuildResult BuildArtifact(string identity)
        => new(new SitemapArtifactSet($"root:{identity}", [$"page:{identity}"]), AllocationBytes: 1);

    private static async Task<string> GetRedisConnectionStringAsync(string containerName)
    {
        string portOutput = await RunDockerAsync("port", containerName, "6379/tcp");
        int separator = portOutput.LastIndexOf(':');
        int port = 0;
        Assert.True(
            separator >= 0 && int.TryParse(portOutput[(separator + 1)..].Trim(), out port),
            $"Unable to parse Redis port: {portOutput}");
        return $"127.0.0.1:{port},abortConnect=true,connectTimeout=500,syncTimeout=1000,asyncTimeout=1000,connectRetry=0";
    }

    private static async Task WaitForRedisAsync(string connectionString)
    {
        Exception? lastError = null;
        DateTime deadline = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                await using ConnectionMultiplexer connection = await ConnectionMultiplexer.ConnectAsync(connectionString);
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

        throw new InvalidOperationException("Redis server did not become ready.", lastError);
    }

    private static async Task<string> RunDockerAsync(params string[] arguments)
    {
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = "docker",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
        };
        foreach (string argument in arguments)
        {
            process.StartInfo.ArgumentList.Add(argument);
        }

        Assert.True(process.Start(), "Failed to start Docker.");
        Task<string> outputTask = process.StandardOutput.ReadToEndAsync();
        Task<string> errorTask = process.StandardError.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(60));
        await process.WaitForExitAsync(timeout.Token);
        string output = await outputTask;
        string error = await errorTask;
        Assert.True(process.ExitCode == 0, $"docker {string.Join(' ', arguments)} failed: {error}");
        return output.Trim();
    }

    private static int CountOccurrences(string value, string token)
    {
        int count = 0;
        for (int offset = 0; (offset = value.IndexOf(token, offset, StringComparison.Ordinal)) >= 0; offset += token.Length)
        {
            count++;
        }

        return count;
    }

    private sealed class PrefixRuntimeKeyScope(string prefix) : IRuntimeKeyScope
    {
        public string ScopeToken => prefix;
        public string PrefixKey(string key) => string.Concat(prefix, key);
    }
}
