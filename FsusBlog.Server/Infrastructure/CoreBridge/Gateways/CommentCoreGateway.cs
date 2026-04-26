using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Core.Services.Gateways;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Services;

namespace FsusBlog.Server.Infrastructure.CoreBridge.Gateways;

public sealed class CommentCoreGateway(CommentService service, IUnifiedCache cache) : ICommentCoreGateway
{
    private static readonly Int64CursorCodec CursorCodec = Int64CursorCodec.Instance;

    public Task<bool> CreateCommentAsync(int userId, int articleId, string content)
        => service.CreateCommentAsync(userId, new CommentDto { ArticleId = articleId, Content = content });

    public async Task<CoreCursorResult<CommentQueryCoreModel>> GetCommentsByCursorAsync(int articleId, long? cursor, int limit)
    {
        string identity = $"core:{articleId}:{cursor?.ToString() ?? "null"}:{limit}";
        var hit = await cache.TryGetAsync(CachePolicyId.CommentCursor, identity, DecodeCommentCursor);
        if (hit.Hit && hit.Value is not null)
        {
            return hit.Value.GetValueOrDefault();
        }

        CoreCursorResult<CommentQueryCoreModel> loaded = await LoadCommentsByCursorAsync(articleId, cursor, limit);
        await cache.SetRawAsync(CachePolicyId.CommentCursor, identity, PodBinaryCodec.EncodeCommentCursor(loaded), TimeSpan.FromMinutes(5));
        return loaded;
    }

    public async Task<CoreCursorResult<UserCommentCoreModel>> GetUserCommentsAsync(int userId, long? cursor, int limit)
    {
        string identity = $"core:{userId}:{cursor?.ToString() ?? "null"}:{limit}";
        var hit = await cache.TryGetAsync(CachePolicyId.UserCommentCursor, identity, DecodeUserCommentCursor);
        if (hit.Hit && hit.Value is not null)
        {
            return hit.Value.GetValueOrDefault();
        }

        CoreCursorResult<UserCommentCoreModel> loaded = await LoadUserCommentsAsync(userId, cursor, limit);
        await cache.SetRawAsync(CachePolicyId.UserCommentCursor, identity, PodBinaryCodec.EncodeUserCommentCursor(loaded), TimeSpan.FromMinutes(5));
        return loaded;
    }

    public Task<bool> DeleteCommentAsync(long id, int currentUserId, bool isAdmin, string reason)
        => service.DeleteCommentAsync(id, currentUserId, isAdmin, reason);

    private async Task<CoreCursorResult<CommentQueryCoreModel>> LoadCommentsByCursorAsync(int articleId, long? cursor, int limit)
    {
        var request = new CursorPageRequest<long>(
            cursor.HasValue ? CursorCodec.Format(cursor.Value) : null,
            cursor,
            CommentCursorPolicies.Threads.NormalizeLimit(limit));
        CursorResponse<CommentQueryResultDto> source = await service.GetCommentsByCursorAsync(articleId, request);
        return CursorInterop.ToCore(source, item =>
        {
            var pod = PodProjector.ProjectCommentItem(item.Id, item.CreateTime, item.UserName, item.Content, out _);
            return new CommentQueryCoreModel(pod, item.Id, item.Content, item.CreateTime, item.UserName);
        }, CursorCodec);
    }

    private async Task<CoreCursorResult<UserCommentCoreModel>> LoadUserCommentsAsync(int userId, long? cursor, int limit)
    {
        var request = new CursorPageRequest<long>(
            cursor.HasValue ? CursorCodec.Format(cursor.Value) : null,
            cursor,
            CommentCursorPolicies.UserComments.NormalizeLimit(limit));
        CursorResponse<UserCommentResponse> source = await service.GetUserCommentsAsync(userId, request);
        return CursorInterop.ToCore(source, item => CommentProjection.ToCoreModel(new UserCommentReadModel
        {
            Id = item.Id,
            Content = item.Content,
            CreateTime = item.CreateTime,
            ArticleId = item.ArticleId,
            ArticleTitle = item.ArticleTitle,
            RootId = item.RootId,
            ReplyToUserName = item.ReplyToUserName
        }), CursorCodec);
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
