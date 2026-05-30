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
        string identity = $"core:{articleId}:{cursor?.ToString() ?? "null"}:{limit}";
        var hit = await cache.TryGetAsync(CachePolicyId.CommentCursor, identity, DecodeCommentCursor);
        if (hit.Hit && hit.Value is not null)
        {
            return hit.Value.GetValueOrDefault();
        }

        CoreCursorResult<CommentQueryCoreModel> loaded = await loader();
        await cache.SetRawAsync(CachePolicyId.CommentCursor, identity, PodBinaryCodec.EncodeCommentCursor(loaded), TimeSpan.FromMinutes(5));
        return loaded;
    }

    public async Task<CoreCursorResult<UserCommentCoreModel>> GetOrLoadUserCommentsAsync(
        int userId,
        long? cursor,
        int limit,
        Func<Task<CoreCursorResult<UserCommentCoreModel>>> loader)
    {
        string identity = $"core:{userId}:{cursor?.ToString() ?? "null"}:{limit}";
        var hit = await cache.TryGetAsync(CachePolicyId.UserCommentCursor, identity, DecodeUserCommentCursor);
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
}