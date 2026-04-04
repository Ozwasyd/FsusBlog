using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Core.Services.Gateways;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services;

namespace FsusBlog.Server.Infrastructure.CoreBridge.Gateways;

public sealed class LegacyCommentGateway(CommentService legacy, ICacheManager cacheManager) : ILegacyCommentGateway
{
    public Task<bool> CreateCommentAsync(int userId, int articleId, string content)
        => legacy.CreateCommentAsync(userId, new CommentDto { ArticleId = articleId, Content = content });

    public async Task<CoreCursorResult<CommentQueryCoreModel>> GetCommentsByCursorAsync(int articleId, long? cursor, int limit)
    {
        string key = CacheKeyBuilder.CommentCursor(articleId, cursor, limit);
        var result = await cacheManager.GetOrLoadAsync(
            key,
            PodBinaryCodec.TryDecodeCommentCursor,
            PodBinaryCodec.EncodeCommentCursor,
            _ => LoadCommentsByCursorAsync(articleId, cursor, limit),
            TimeSpan.FromMinutes(5));

        return result.Value;
    }

    public async Task<CoreCursorResult<UserCommentCoreModel>> GetUserCommentsAsync(int userId, long? cursor, int limit)
    {
        string key = CacheKeyBuilder.UserCommentCursor(userId, cursor, limit);
        var result = await cacheManager.GetOrLoadAsync(
            key,
            PodBinaryCodec.TryDecodeUserCommentCursor,
            PodBinaryCodec.EncodeUserCommentCursor,
            _ => LoadUserCommentsAsync(userId, cursor, limit),
            TimeSpan.FromMinutes(5));

        return result.Value;
    }

    public Task<bool> DeleteCommentAsync(long id, int currentUserId, bool isAdmin, string reason)
        => legacy.DeleteCommentAsync(id, currentUserId, isAdmin, reason);

    private async Task<CoreCursorResult<CommentQueryCoreModel>> LoadCommentsByCursorAsync(int articleId, long? cursor, int limit)
    {
        CursorResult<CommentQueryResultDto> source = await legacy.GetCommentsByCursorAsync(articleId, cursor, limit);
        var data = new List<CommentQueryCoreModel>(source.Data.Count);

        foreach (CommentQueryResultDto item in source.Data)
        {
            var pod = PodProjector.ProjectCommentItem(item.Id, item.CreateTime, item.UserName, item.Content, out _);
            data.Add(new CommentQueryCoreModel(pod, item.Id, item.Content, item.CreateTime, item.UserName));
        }

        return new CoreCursorResult<CommentQueryCoreModel>(data, source.NextCursor, source.HasMore);
    }

    private async Task<CoreCursorResult<UserCommentCoreModel>> LoadUserCommentsAsync(int userId, long? cursor, int limit)
    {
        CursorResult<UserCommentDto> source = await legacy.GetUserCommentsAsync(userId, cursor, limit);
        var data = new List<UserCommentCoreModel>(source.Data.Count);

        foreach (UserCommentDto item in source.Data)
        {
            var pod = PodProjector.ProjectUserComment(item.Id, item.ArticleId, item.CreateTime, item.Content, item.ArticleTitle, out _);
            data.Add(new UserCommentCoreModel(pod, item.Id, item.Content, item.CreateTime, item.ArticleId, item.ArticleTitle));
        }

        return new CoreCursorResult<UserCommentCoreModel>(data, source.NextCursor, source.HasMore);
    }
}
