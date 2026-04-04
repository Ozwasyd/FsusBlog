using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Core.Services.Gateways;

namespace FsusBlog.Core.Services.Implementations;

public sealed class CommentCoreService(ILegacyCommentGateway gateway) : ICommentCoreService
{
    public async Task<Result> CreateCommentAsync(int userId, int articleId, string content)
    {
        if (userId <= 0 || articleId <= 0 || string.IsNullOrWhiteSpace(content))
        {
            return Result.Failure(ErrorCode.Validation, "评论参数非法");
        }

        return await gateway.CreateCommentAsync(userId, articleId, content)
            ? Result.Success()
            : Result.Failure(ErrorCode.InfraFailure, "评论发布失败");
    }

    public async Task<Result<CoreCursorResult<CommentQueryCoreModel>>> GetCommentsByCursorAsync(int articleId, long? cursor, int limit)
    {
        if (articleId <= 0 || limit <= 0)
        {
            return Result<CoreCursorResult<CommentQueryCoreModel>>.Failure(ErrorCode.Validation, "评论查询参数非法");
        }

        return Result<CoreCursorResult<CommentQueryCoreModel>>.Success(await gateway.GetCommentsByCursorAsync(articleId, cursor, limit));
    }

    public async Task<Result<CoreCursorResult<UserCommentCoreModel>>> GetUserCommentsAsync(int userId, long? cursor, int limit)
    {
        if (userId <= 0 || limit <= 0)
        {
            return Result<CoreCursorResult<UserCommentCoreModel>>.Failure(ErrorCode.Validation, "用户评论查询参数非法");
        }

        return Result<CoreCursorResult<UserCommentCoreModel>>.Success(await gateway.GetUserCommentsAsync(userId, cursor, limit));
    }

    public async Task<Result> DeleteCommentAsync(long id, int currentUserId, bool isAdmin, string reason)
    {
        if (id <= 0 || currentUserId <= 0)
        {
            return Result.Failure(ErrorCode.Validation, "删除参数非法");
        }

        return await gateway.DeleteCommentAsync(id, currentUserId, isAdmin, reason)
            ? Result.Success()
            : Result.Failure(ErrorCode.NotFound, "评论不存在或删除失败");
    }
}
