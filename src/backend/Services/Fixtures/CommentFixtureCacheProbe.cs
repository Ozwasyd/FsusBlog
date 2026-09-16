using FsusBlog.Server.Infrastructure.Cache;

using StackExchange.Redis;

namespace FsusBlog.Server.Services.Fixtures;

/// <summary>
/// Reads the comment cursor-version counter that the production outbox dispatcher
/// increments. Background delivery has no request session, so the authoritative
/// counter key is intentionally read without the ambient test-session prefix.
/// </summary>
public sealed class CommentFixtureCacheProbe(
    IRedisOperationExecutor redis,
    ICachePolicyRegistry policies)
{
    public async Task<string?> ReadCursorGenerationAsync(string identity, CancellationToken cancellationToken)
    {
        if (!policies.TryGet(CachePolicyId.CommentCursorVersion, out CachePolicy? policy))
            return null;
        string key = policy.BuildKey(identity);
        RedisValue value = await redis.ExecuteAsync(
                RedisOperationPort.CommentFixture,
                (multiplexer, _) => multiplexer.GetDatabase().StringGetAsync(key),
                cancellationToken)
            .ConfigureAwait(false);
        return value.HasValue ? value.ToString() : null;
    }
}
