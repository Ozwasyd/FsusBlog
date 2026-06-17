using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.ReadModels;

namespace FsusBlog.Server.Infrastructure.CoreBridge.Adapters;

public sealed class CommentServiceCoreAdapter(ICommentCoreService core) : ICommentService
{
    private static readonly Int64CursorCodec CursorCodec = Int64CursorCodec.Instance;

    public Task<bool> CreateCommentAsync(int userId, CommentDto dto)
        => ExecuteBool(core.CreateCommentAsync(userId, dto.ArticleId, dto.Content));

    public async Task<CursorResponse<CommentQueryResultDto>> GetCommentsByCursorAsync(int articleId, CursorPageRequest<long> request)
    {
        var result = await core.GetCommentsByCursorAsync(articleId, request.Cursor, request.Limit);
        if (!result.IsSuccess)
        {
            return new CursorResponse<CommentQueryResultDto> { Data = [], HasMore = false, NextCursor = null };
        }

        return CursorInterop.FromCore(result.Value,
            item => new CommentQueryResultDto(item.Id, item.Content, item.CreateTime, item.UserName),
            CursorCodec);
    }

    public async Task<CursorResponse<UserCommentResponse>> GetUserCommentsAsync(int userId, CursorPageRequest<long> request)
    {
        var result = await core.GetUserCommentsAsync(userId, request.Cursor, request.Limit);
        if (!result.IsSuccess)
        {
            return new CursorResponse<UserCommentResponse> { Data = [], HasMore = false, NextCursor = null };
        }

        return CursorInterop.FromCore(result.Value,
            item => CommentProjection.ToResponse(new UserCommentReadModel
            {
                Id = item.Id,
                Content = item.Content,
                CreateTime = item.CreateTime,
                ArticleId = item.ArticleId,
                ArticleTitle = item.ArticleTitle,
                RootId = item.RootId,
                ReplyToUserName = item.ReplyToUserName,
                ModerationStatus = item.ModerationStatus,
                IsDeleted = item.VisibilityReasonCode == "deleted_by_user_or_admin",
                HasBlockedRegions = item.VisibilityReasonCode == "geo_limited"
            }),
            CursorCodec);
    }

    public Task<bool> DeleteCommentAsync(long id, int currentUserId, bool isAdmin, string reason = "违反社区管理条例")
        => ExecuteBool(core.DeleteCommentAsync(id, currentUserId, isAdmin, reason));

    private static async Task<bool> ExecuteBool(Task<FsusBlog.Core.Common.Result> task)
        => (await task).IsSuccess;
}
