using System.Collections.Frozen;
using System.Globalization;
using System.Runtime.CompilerServices;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Testing;

using StackExchange.Redis;

namespace FsusBlog.Server.Modules.Endpoints;

internal static class RuntimeCacheFaultAndRevocationScenarioEndpoints
{
    internal const string RedisProbeRoute = "/_fsus/testing/runtime-cache/redis-fault/{operationClass}";
    internal const string RevocationPrepareRoute = "/_fsus/testing/runtime-cache/revocation/prepare/{count:int}";
    private static readonly FrozenDictionary<string, RedisOperationPort> s_probePorts =
        new Dictionary<string, RedisOperationPort>(StringComparer.Ordinal)
        {
            ["security-atomic"] = RedisOperationPort.PerceptionChallenge,
            ["coordination-lease"] = RedisOperationPort.ClusterMembership,
            ["content-cache-read"] = RedisOperationPort.UnifiedCacheRead,
            ["content-cache-write"] = RedisOperationPort.UnifiedCacheWrite,
            ["optional-projection"] = RedisOperationPort.ArticleServiceOptionalProjection,
            ["distributed-delivery"] = RedisOperationPort.PublicArtifactRevocation,
            ["background-maintenance"] = RedisOperationPort.ProductionHealth
        }.ToFrozenDictionary(StringComparer.Ordinal);
    private static readonly ConditionalWeakTable<PublicArtifactRevocationRegistry, RuntimeCacheRevocationScenarioAuthority>
        s_revocationAuthorities = new();

    internal static WebApplication MapRuntimeCacheFaultAndRevocationScenarioEndpoints(this WebApplication app)
    {
        app.MapGet(RedisProbeRoute, ProbeRedisAsync)
            .AllowAnonymous()
            .WithMetadata(new FsusRouteKindMetadata("testing"));
        app.MapPost(RevocationPrepareRoute, PrepareRevocationAsync)
            .AllowAnonymous()
            .WithMetadata(new FsusRouteKindMetadata("testing"));
        return app;
    }

    internal static bool TryResolveProbePort(string operationClass, out RedisOperationPort port)
        => s_probePorts.TryGetValue(operationClass, out port);

    internal static string ClassifyFailAction(string failAction)
        => failAction switch
        {
            "fail-closed" or "deny-origin-without-lease" => "fail-closed",
            "bounded-origin-gate" or "return-result-degraded" or "use-local-or-base-value"
                or "record-degraded-and-replay" or "defer-maintenance" => "fail-open",
            _ => throw new InvalidOperationException($"Unsupported Redis fail action: {failAction}")
        };

    private static async Task<IResult> ProbeRedisAsync(
        HttpContext context,
        string operationClass,
        IRedisOperationExecutor redis,
        RedisOperationBudgetCatalog catalog,
        CancellationToken cancellationToken)
    {
        if (!IsAuthenticated(context))
        {
            return Results.StatusCode(StatusCodes.Status403Forbidden);
        }

        if (!TryResolveProbePort(operationClass, out RedisOperationPort port))
        {
            return Results.BadRequest(new
            {
                error = "unsupported-redis-operation-class"
            });
        }

        RedisOperationPortDefinition definition = catalog.Get(port);
        RedisOperationBudget budget = catalog.Get(definition.OperationClass);
        try
        {
            TimeSpan elapsed = await redis.ExecuteAsync(
                    port,
                    static (multiplexer, _) => multiplexer.GetDatabase().PingAsync(CommandFlags.DemandMaster),
                    cancellationToken)
                .ConfigureAwait(false);
            RuntimeCacheEvidenceObservation.Current?.MarkLayerSource("redis");
            return Results.Ok(new RuntimeCacheRedisFaultProbeResult(
                budget.Id,
                budget.FailAction,
                "recovered",
                elapsed.TotalMilliseconds));
        }
        catch (RedisOperationUnavailableException exception)
            when (exception.Port.OperationClass == definition.OperationClass)
        {
            string classification = ClassifyFailAction(exception.Budget.FailAction);
            RuntimeCacheEvidenceObservation.Current?.MarkLayerSource(classification);
            return Results.Json(
                new RuntimeCacheRedisFaultProbeResult(
                    exception.Budget.Id,
                    exception.Budget.FailAction,
                    classification,
                    null,
                    exception.FailureKind.ToString()),
                statusCode: StatusCodes.Status503ServiceUnavailable);
        }
    }

    private static async Task<IResult> PrepareRevocationAsync(
        HttpContext context,
        int count,
        IRedisOperationExecutor redis,
        IRuntimeKeyScope keyScope,
        PublicArtifactRevocationRegistry registry,
        CancellationToken cancellationToken)
    {
        if (!IsAuthenticated(context))
        {
            return Results.StatusCode(StatusCodes.Status403Forbidden);
        }

        if (!RuntimeCacheRevocationScenarioAuthority.IsSupportedCount(count))
        {
            return Results.BadRequest(new
            {
                error = "unsupported-revocation-count"
            });
        }

        RuntimeCacheRevocationScenarioAuthority authority = s_revocationAuthorities.GetValue(
            registry,
            static _ => new RuntimeCacheRevocationScenarioAuthority());
        RuntimeCacheRevocationScenarioResult result = await authority
            .PrepareAsync(count, redis, keyScope, registry, cancellationToken)
            .ConfigureAwait(false);
        return Results.Ok(result);
    }

    private static bool IsAuthenticated(HttpContext context)
        => RuntimeCacheEvidenceMiddleware.AllowsAuthenticatedHeader(
            context,
            RuntimeCacheEvidenceMiddleware.SecretHeader);
}

internal sealed class RuntimeCacheRevocationScenarioAuthority
{
    internal const int ScenarioArticleIdBase = 2_000_000_000;
    internal const int MaximumCount = 100_000;
    private const int RedisBatchSize = 256;
    private static readonly FrozenSet<int> s_supportedCounts =
        new[] { 0, 1, 10, 100, 1_000, 10_000, 100_000 }.ToFrozenSet();
    private readonly SemaphoreSlim _gate = new(1, 1);
    private PublicArtifactTombstone[] _seeded = [];
    private bool _reservedFieldsScrubbed;

    internal static bool IsSupportedCount(int count) => s_supportedCounts.Contains(count);

    internal static PublicArtifactTombstone[] BuildTombstones(int count, long maximumGeneration)
    {
        if (!IsSupportedCount(count) || count == 0)
        {
            return count == 0
                ? []
                : throw new ArgumentOutOfRangeException(nameof(count));
        }

        if (maximumGeneration < count)
        {
            throw new ArgumentOutOfRangeException(nameof(maximumGeneration));
        }

        long firstGeneration = maximumGeneration - count + 1;
        long revokedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        return Enumerable.Range(0, count)
            .Select(index => new PublicArtifactTombstone(
                ScenarioArticleIdBase + index,
                firstGeneration + index,
                revokedAt,
                PurgeConfirmed: true))
            .ToArray();
    }

    internal async Task<RuntimeCacheRevocationScenarioResult> PrepareAsync(
        int count,
        IRedisOperationExecutor redis,
        IRuntimeKeyScope keyScope,
        PublicArtifactRevocationRegistry registry,
        CancellationToken cancellationToken)
    {
        if (!IsSupportedCount(count))
        {
            throw new ArgumentOutOfRangeException(nameof(count));
        }

        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            RedisKey hashKey = keyScope.PrefixKey(RedisPublicArtifactRevocationStateStore.TombstoneHashKey);
            RedisKey generationKey = keyScope.PrefixKey(RedisPublicArtifactRevocationStateStore.GenerationKey);
            if (!_reservedFieldsScrubbed)
            {
                await DeleteReservedFieldsAsync(redis, hashKey, cancellationToken).ConfigureAwait(false);
                _reservedFieldsScrubbed = true;
            }

            await RemoveSeededAsync(redis, hashKey, registry, cancellationToken).ConfigureAwait(false);
            long redisHashLengthBefore = await HashLengthAsync(redis, hashKey, cancellationToken).ConfigureAwait(false);
            if (count == 0)
            {
                return new RuntimeCacheRevocationScenarioResult(0, 0, redisHashLengthBefore, redisHashLengthBefore, 0, registry.CurrentGeneration);
            }

            for (int index = 0; index < count; index++)
            {
                if (registry.TryGet(ScenarioArticleIdBase + index, out _))
                {
                    throw new InvalidOperationException("runtime revocation scenario reserved article range is already active");
                }
            }

            long maximumGeneration = await redis.ExecuteAsync(
                    RedisOperationPort.PublicArtifactRevocation,
                    (multiplexer, _) => multiplexer.GetDatabase().StringIncrementAsync(generationKey, count),
                    cancellationToken)
                .ConfigureAwait(false);
            PublicArtifactTombstone[] tombstones = BuildTombstones(count, maximumGeneration);
            var applied = new List<PublicArtifactTombstone>(count);
            try
            {
                foreach (PublicArtifactTombstone[] batch in tombstones.Chunk(RedisBatchSize))
                {
                    HashEntry[] entries = batch
                        .Select(static tombstone => new HashEntry(
                            tombstone.ArticleId.ToString(CultureInfo.InvariantCulture),
                            JsonSerializer.Serialize(tombstone)))
                        .ToArray();
                    await redis.ExecuteAsync(
                            RedisOperationPort.PublicArtifactRevocation,
                            (multiplexer, _) => multiplexer.GetDatabase().HashSetAsync(hashKey, entries),
                            cancellationToken)
                        .ConfigureAwait(false);
                    foreach (PublicArtifactTombstone tombstone in batch)
                    {
                        registry.Apply(tombstone);
                        applied.Add(tombstone);
                    }
                }
            }
            catch
            {
                _seeded = [.. applied];
                throw;
            }

            _seeded = tombstones;
            long redisHashLengthAfter = await HashLengthAsync(redis, hashKey, cancellationToken).ConfigureAwait(false);
            int registrySeededCount = tombstones.Count(tombstone =>
                registry.TryGet(tombstone.ArticleId, out PublicArtifactTombstone observed)
                && observed.Generation == tombstone.Generation);
            return new RuntimeCacheRevocationScenarioResult(
                count,
                registrySeededCount,
                redisHashLengthBefore,
                redisHashLengthAfter,
                redisHashLengthAfter - redisHashLengthBefore,
                maximumGeneration);
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task RemoveSeededAsync(
        IRedisOperationExecutor redis,
        RedisKey hashKey,
        PublicArtifactRevocationRegistry registry,
        CancellationToken cancellationToken)
    {
        foreach (PublicArtifactTombstone[] batch in _seeded.Chunk(RedisBatchSize))
        {
            RedisValue[] fields = batch
                .Select(static tombstone => (RedisValue)tombstone.ArticleId.ToString(CultureInfo.InvariantCulture))
                .ToArray();
            _ = await redis.ExecuteAsync(
                    RedisOperationPort.PublicArtifactRevocation,
                    (multiplexer, _) => multiplexer.GetDatabase().HashDeleteAsync(hashKey, fields),
                    cancellationToken)
                .ConfigureAwait(false);
        }

        foreach (PublicArtifactTombstone tombstone in _seeded)
        {
            registry.Clear(tombstone);
        }
        _seeded = [];
    }

    private static async Task DeleteReservedFieldsAsync(
        IRedisOperationExecutor redis,
        RedisKey hashKey,
        CancellationToken cancellationToken)
    {
        for (int offset = 0; offset < MaximumCount; offset += RedisBatchSize)
        {
            int length = Math.Min(RedisBatchSize, MaximumCount - offset);
            RedisValue[] fields = Enumerable.Range(ScenarioArticleIdBase + offset, length)
                .Select(static articleId => (RedisValue)articleId.ToString(CultureInfo.InvariantCulture))
                .ToArray();
            _ = await redis.ExecuteAsync(
                    RedisOperationPort.PublicArtifactRevocation,
                    (multiplexer, _) => multiplexer.GetDatabase().HashDeleteAsync(hashKey, fields),
                    cancellationToken)
                .ConfigureAwait(false);
        }
    }

    private static Task<long> HashLengthAsync(
        IRedisOperationExecutor redis,
        RedisKey hashKey,
        CancellationToken cancellationToken)
        => redis.ExecuteAsync(
            RedisOperationPort.PublicArtifactRevocation,
            (multiplexer, _) => multiplexer.GetDatabase().HashLengthAsync(hashKey),
            cancellationToken);
}

internal sealed record RuntimeCacheRedisFaultProbeResult(
    string OperationClass,
    string FailAction,
    string Classification,
    double? RedisLatencyMilliseconds,
    string? FailureKind = null);

internal sealed record RuntimeCacheRevocationScenarioResult(
    int RequestedCount,
    int RegistrySeededCount,
    long RedisHashLengthBefore,
    long RedisHashLengthAfter,
    long RedisHashLengthDelta,
    long MaximumGeneration);
