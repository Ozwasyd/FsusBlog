using System.Globalization;

using FsusBlog.Server.Infrastructure.Cache;

using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.PublicReadArtifacts;

// This is deliberately a separate durable obligation from the in-process channel.
// The channel is only a wake-up/latency mechanism; recovery is driven by this watermark.
public interface IPublicHotArtifactDeliveryStateStore
{
    Task<long> MarkDirtyAsync(PublicHotArtifactDeliveryClass deliveryClass, CancellationToken cancellationToken);
    Task<long> GetPendingGenerationAsync(CancellationToken cancellationToken);
    Task CompleteAsync(long generation, CancellationToken cancellationToken);
}

internal sealed class InMemoryPublicHotArtifactDeliveryStateStore : IPublicHotArtifactDeliveryStateStore
{
    private long _generation;
    private long _pending;

    public Task<long> MarkDirtyAsync(PublicHotArtifactDeliveryClass deliveryClass, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        long generation = Interlocked.Increment(ref _generation);
        InterlockedExtensions.Max(ref _pending, generation);
        return Task.FromResult(generation);
    }

    public Task<long> GetPendingGenerationAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(Volatile.Read(ref _pending));
    }

    public Task CompleteAsync(long generation, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        long pending = Volatile.Read(ref _pending);
        while (pending > 0 && pending <= generation)
        {
            long observed = Interlocked.CompareExchange(ref _pending, 0, pending);
            if (observed == pending)
            {
                break;
            }

            pending = observed;
        }

        return Task.CompletedTask;
    }
}

internal static class InterlockedExtensions
{
    public static void Max(ref long target, long value)
    {
        long observed = Volatile.Read(ref target);
        while (observed < value)
        {
            long prior = Interlocked.CompareExchange(ref target, value, observed);
            if (prior == observed)
            {
                return;
            }
            observed = prior;
        }
    }
}

public sealed class RedisPublicHotArtifactDeliveryStateStore(
    IConnectionMultiplexer redis,
    IRuntimeKeyScope runtimeKeyScope) : IPublicHotArtifactDeliveryStateStore
{
    // Keep both Lua keys in one Redis Cluster hash slot.
    private const string GenerationKey = "public-hot-read:{delivery}:generation";
    private const string PendingKey = "public-hot-read:{delivery}:pending-generation";
    private static readonly LuaScript s_markDirty = LuaScript.Prepare(
        "local generation = redis.call('INCR', @generation); " +
        "local pending = tonumber(redis.call('GET', @pending) or '0'); " +
        "if generation > pending then redis.call('SET', @pending, generation); end; " +
        "return generation;");
    private static readonly LuaScript s_complete = LuaScript.Prepare(
        "local pending = tonumber(redis.call('GET', @pending) or '0'); " +
        "if pending > 0 and pending <= tonumber(@generation) then redis.call('DEL', @pending); return 1; end; " +
        "return 0;");
    private readonly IDatabase _database = redis.GetDatabase();

    public async Task<long> MarkDirtyAsync(PublicHotArtifactDeliveryClass deliveryClass, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        RedisResult result = await _database.ScriptEvaluateAsync(
                s_markDirty,
                new
                {
                    generation = (RedisKey)runtimeKeyScope.PrefixKey(GenerationKey),
                    pending = (RedisKey)runtimeKeyScope.PrefixKey(PendingKey)
                })
            .ConfigureAwait(false);
        return (long)result;
    }

    public async Task<long> GetPendingGenerationAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        RedisValue value = await _database.StringGetAsync(runtimeKeyScope.PrefixKey(PendingKey)).ConfigureAwait(false);
        if (value.IsNullOrEmpty)
        {
            return 0;
        }

        return long.TryParse(value.ToString(), CultureInfo.InvariantCulture, out long generation) && generation > 0
            ? generation
            : throw new InvalidOperationException("public-hot delivery pending generation is corrupt");
    }

    public async Task CompleteAsync(long generation, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await _database.ScriptEvaluateAsync(
                s_complete,
                new
                {
                    pending = (RedisKey)runtimeKeyScope.PrefixKey(PendingKey),
                    generation
                })
            .ConfigureAwait(false);
    }
}
