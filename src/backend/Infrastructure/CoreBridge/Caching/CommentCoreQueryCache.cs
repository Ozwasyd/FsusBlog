using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Infrastructure.Cache;

namespace FsusBlog.Server.Infrastructure.CoreBridge.Caching;

public sealed class CommentCoreQueryCache(IUnifiedCache cache)
{
    public async Task<CoreCursorResult<CommentQueryCoreModel>> GetOrLoadCommentsByCursorAsync(
        int articleId,
        long? cursor,
        int limit,
        Func<Task<CoreCursorResult<CommentQueryCoreModel>>> loader)
    {
        string version = await ReadCommentCursorVersionAsync(CachePolicyId.CommentCursorVersion, $"article:{articleId}");
        string identity = $"article:{articleId}:v:{version}:roots:{cursor?.ToString() ?? "0"}:{limit}:1";
        var hit = await cache.TryGetAsync(CachePolicyId.CommentCursor, identity, DecodeCommentCursor);
        if (hit.Hit && hit.Value is not null)
        {
            return hit.Value.GetValueOrDefault();
        }

        await using IAsyncDisposable guard = await cache.AcquireSingleFlightAsync(CachePolicyId.CommentCursor, identity);
        hit = await cache.TryGetAsync(CachePolicyId.CommentCursor, identity, DecodeCommentCursor);
        if (hit.Hit && hit.Value is not null)
        {
            return hit.Value.GetValueOrDefault();
        }

        CoreCursorResult<CommentQueryCoreModel> loaded = await loader();
        await cache.SetRawAsync(CachePolicyId.CommentCursor, identity, PodBinaryCodec.EncodeCommentCursor(loaded), TimeSpan.FromMinutes(5));
        return loaded;
    }

    public async Task<CoreCursorResult<UserCommentCoreModel>> GetOrLoadUserCommentsAsync(
        int accountId,
        long? cursor,
        int limit,
        Func<Task<CoreCursorResult<UserCommentCoreModel>>> loader)
    {
        string version = await ReadCommentCursorVersionAsync(CachePolicyId.UserCommentCursorVersion, $"account:{accountId}");
        string identity = $"account:{accountId}:v:{version}:comments:{cursor?.ToString() ?? "0"}:{limit}";
        var hit = await cache.TryGetAsync(CachePolicyId.UserCommentCursor, identity, DecodeUserCommentCursor);
        if (hit.Hit && hit.Value is not null)
        {
            return hit.Value.GetValueOrDefault();
        }

        await using IAsyncDisposable guard = await cache.AcquireSingleFlightAsync(CachePolicyId.UserCommentCursor, identity);
        hit = await cache.TryGetAsync(CachePolicyId.UserCommentCursor, identity, DecodeUserCommentCursor);
        if (hit.Hit && hit.Value is not null)
        {
            return hit.Value.GetValueOrDefault();
        }

        CoreCursorResult<UserCommentCoreModel> loaded = await loader();
        await cache.SetRawAsync(CachePolicyId.UserCommentCursor, identity, PodBinaryCodec.EncodeUserCommentCursor(loaded), TimeSpan.FromMinutes(5));
        return loaded;
    }

    private static (bool Success, CoreCursorResult<CommentQueryCoreModel>? Value) DecodeCommentCursor(ReadOnlyMemory<byte> bytes)
    {
        bool success = PodBinaryCodec.TryDecodeCommentCursor(bytes, out CoreCursorResult<CommentQueryCoreModel> value);
        return (success, success ? value : default);
    }

    private static (bool Success, CoreCursorResult<UserCommentCoreModel>? Value) DecodeUserCommentCursor(ReadOnlyMemory<byte> bytes)
    {
        bool success = PodBinaryCodec.TryDecodeUserCommentCursor(bytes, out CoreCursorResult<UserCommentCoreModel> value);
        return (success, success ? value : default);
    }

    private async Task<string> ReadCommentCursorVersionAsync(CachePolicyId policyId, string identity)
    {
        long global = await ReadVersionAsync(policyId, "global");
        long scoped = await ReadVersionAsync(policyId, identity);
        return $"{policyId}:{global}:{scoped}";
    }

    private async Task<long> ReadVersionAsync(CachePolicyId policyId, string identity)
    {
        string? value = await cache.GetStringAsync(policyId, identity);
        return long.TryParse(value, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out long version)
            ? version
            : 0;
    }
}
