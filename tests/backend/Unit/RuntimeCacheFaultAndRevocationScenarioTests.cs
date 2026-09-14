using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Modules.Endpoints;

using StackExchange.Redis;

namespace FsusBlog.Server.Tests.Unit;

public sealed class RuntimeCacheFaultAndRevocationScenarioTests
{
    [Theory]
    [InlineData("security-atomic", RedisOperationPort.PerceptionChallenge, "fail-closed")]
    [InlineData("coordination-lease", RedisOperationPort.ClusterMembership, "fail-closed")]
    [InlineData("content-cache-read", RedisOperationPort.UnifiedCacheRead, "fail-open")]
    [InlineData("content-cache-write", RedisOperationPort.UnifiedCacheWrite, "fail-open")]
    [InlineData("optional-projection", RedisOperationPort.ArticleServiceOptionalProjection, "fail-open")]
    [InlineData("distributed-delivery", RedisOperationPort.PublicArtifactRevocation, "fail-open")]
    [InlineData("background-maintenance", RedisOperationPort.ProductionHealth, "fail-open")]
    public void RedisFaultProbe_UsesEveryBudgetClassAndStrictFailAction(
        string operationClass,
        RedisOperationPort expectedPort,
        string expectedClassification)
    {
        var catalog = new RedisOperationBudgetCatalog();

        Assert.True(RuntimeCacheFaultAndRevocationScenarioEndpoints.TryResolveProbePort(operationClass, out RedisOperationPort port));
        Assert.Equal(expectedPort, port);
        RedisOperationBudget budget = catalog.Get(catalog.Get(port).OperationClass);
        Assert.Equal(expectedClassification, RuntimeCacheFaultAndRevocationScenarioEndpoints.ClassifyFailAction(budget.FailAction));
    }

    [Fact]
    public void RedisFaultProbe_RejectsUnknownClassAndFailAction()
    {
        Assert.False(RuntimeCacheFaultAndRevocationScenarioEndpoints.TryResolveProbePort("garbage", out _));
        Assert.Throws<InvalidOperationException>(() =>
            RuntimeCacheFaultAndRevocationScenarioEndpoints.ClassifyFailAction("invented-fallback"));
    }

    [Theory]
    [InlineData(1)]
    [InlineData(10)]
    [InlineData(100)]
    [InlineData(1_000)]
    [InlineData(10_000)]
    [InlineData(100_000)]
    public void RevocationAuthority_BuildsEveryExactCatalogCardinality(int count)
    {
        PublicArtifactTombstone[] tombstones = RuntimeCacheRevocationScenarioAuthority.BuildTombstones(count, count + 100);

        Assert.Equal(count, tombstones.Length);
        Assert.Equal(count, tombstones.Select(static item => item.ArticleId).Distinct().Count());
        Assert.Equal(count, tombstones.Select(static item => item.Generation).Distinct().Count());
        Assert.All(tombstones, static item =>
        {
            Assert.True(item.PurgeConfirmed);
            Assert.False(item.TransitionPending);
            Assert.Equal(PublicArtifactRevocationTargetKind.ExactArticle, item.TargetKind);
        });
    }

    [Fact]
    public async Task PublicPipeline_EmitsOneClassificationAndOneTimedRevocationLookup()
    {
        using RuntimeCacheEvidenceObservation observation = RuntimeCacheEvidenceObservation.Begin(
            "revocation-event-request",
            HttpMethods.Get,
            "/api/binary/article/42.aeds");
        var context = new DefaultHttpContext();
        context.Request.Method = HttpMethods.Get;
        context.Request.Path = "/api/binary/article/42.aeds";
        context.Response.Body = new MemoryStream();
        Assert.True(PublicHotReadFastPath.TryCreateRequestFeatureForTests(
            context,
            out PublicHotReadRequestFeature? feature));
        context.Features.Set(Assert.IsType<PublicHotReadRequestFeature>(feature));

        await PublicArtifactRevocationMiddleware.TryHandleAsync(
            context,
            static _ => Task.CompletedTask,
            new PublicArtifactRevocationRegistry());
        RuntimeCacheRequestObservation completed = observation.Complete(
            StatusCodes.Status200OK,
            $"sha256:{new string('a', 64)}");

        RuntimeCacheBuildObservation classification = Assert.Single(
            completed.CacheEvents,
            static item => item.Family == "public-hot-read-classification");
        RuntimeCacheBuildObservation lookup = Assert.Single(
            completed.CacheEvents,
            static item => item.Family == "public-artifact-revocation-lookup");
        Assert.Equal("hit", classification.Outcome);
        Assert.Equal("negative", lookup.Outcome);
        Assert.Equal(classification.IdentityDigest, lookup.IdentityDigest);
        Assert.True(lookup.Sequence > classification.Sequence);
        Assert.True(lookup.ElapsedMilliseconds >= classification.ElapsedMilliseconds);
    }

    [Fact]
    [Trait("Dependency", "Docker")]
    public async Task RevocationAuthority_StoresAndConvergesRealRedisAtRequiredLargeCardinalities()
    {
        var redisFixture = new PublicHotDeliveryRedisFixture();
        await redisFixture.InitializeAsync();
        await using ConnectionMultiplexer connection = await redisFixture.ConnectAsync();
        string prefix = $"runtime-cache-revocation:{Guid.CreateVersion7():N}:";
        var keyScope = new PrefixRuntimeKeyScope(prefix);
        IRedisOperationExecutor redis = RedisOperationExecutor.ForTestConnection(connection);
        var registry = new PublicArtifactRevocationRegistry();
        var authority = new RuntimeCacheRevocationScenarioAuthority();

        try
        {
            foreach (int count in new[] { 1_000, 10_000, 100_000 })
            {
                RuntimeCacheRevocationScenarioResult result = await authority.PrepareAsync(
                    count,
                    "real-redis-large-cardinality",
                    redis,
                    keyScope,
                    registry,
                    CancellationToken.None);

                Assert.Equal(count, result.RequestedCount);
                Assert.Equal(count, result.RegistrySeededCount);
                Assert.Equal(count, result.RedisHashLengthDelta);
                Assert.Equal(count, registry.MetricsSnapshot().ActiveCount);
            }

            RuntimeCacheRevocationScenarioResult cleanup = await authority.PrepareAsync(
                0,
                "real-redis-large-cardinality",
                redis,
                keyScope,
                registry,
                CancellationToken.None);
            Assert.Equal(0, cleanup.RegistrySeededCount);
            Assert.Equal(0, registry.MetricsSnapshot().ActiveCount);
            Assert.Equal(
                0,
                await connection.GetDatabase().HashLengthAsync(
                    keyScope.PrefixKey("runtime-cache-evidence:real-redis-large-cardinality:revocation:tombstones")));
        }
        finally
        {
            await redisFixture.DeleteNamespaceAsync(prefix);
            await redisFixture.DisposeAsync();
        }
    }

    private sealed class PrefixRuntimeKeyScope(string prefix) : IRuntimeKeyScope
    {
        public string ScopeToken => prefix;
        public string PrefixKey(string key) => string.Concat(prefix, key);
    }
}
