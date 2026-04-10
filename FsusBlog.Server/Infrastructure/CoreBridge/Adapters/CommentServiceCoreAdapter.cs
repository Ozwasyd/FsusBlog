using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;

namespace FsusBlog.Server.Infrastructure.CoreBridge.Adapters;

public sealed class CommentServiceCoreAdapter(ICommentCoreService core) : ICommentService
{
    public Task<bool> CreateCommentAsync(int userId, CommentDto dto)
        => ExecuteBool(core.CreateCommentAsync(userId, dto.ArticleId, dto.Content));

    public async Task<CursorResult<CommentQueryResultDto>> GetCommentsByCursorAsync(int articleId, long? cursor, int limit)
    {
        var result = await core.GetCommentsByCursorAsync(articleId, cursor, limit);
        if (!result.IsSuccess)
        {
            return new CursorResult<CommentQueryResultDto> { Data = [], HasMore = false, NextCursor = null };
        }

        var data = new List<CommentQueryResultDto>(result.Value.Data.Count);
        foreach (var item in result.Value.Data)
        {
            data.Add(new CommentQueryResultDto(item.Id, item.Content, item.CreateTime, item.UserName));
        }

        return new CursorResult<CommentQueryResultDto>
        {
            Data = data,
            NextCursor = result.Value.NextCursor?.ToString(),
            HasMore = result.Value.HasMore
        };
    }

    public async Task<CursorResult<UserCommentDto>> GetUserCommentsAsync(int userId, long? cursor, int limit)
    {
        var result = await core.GetUserCommentsAsync(userId, cursor, limit);
        if (!result.IsSuccess)
        {
            return new CursorResult<UserCommentDto> { Data = [], HasMore = false, NextCursor = null };
        }

        var data = new List<UserCommentDto>(result.Value.Data.Count);
        foreach (var item in result.Value.Data)
        {
            data.Add(new UserCommentDto
            {
                Id = item.Id,
                Content = item.Content,
                CreateTime = item.CreateTime,
                ArticleId = item.ArticleId,
                ArticleTitle = item.ArticleTitle
            });
        }

        return new CursorResult<UserCommentDto>
        {
            Data = data,
            NextCursor = result.Value.NextCursor?.ToString(),
            HasMore = result.Value.HasMore
        };
    }

    public Task<bool> DeleteCommentAsync(long id, int currentUserId, bool isAdmin, string reason = "违反社区管理条例")
        => ExecuteBool(core.DeleteCommentAsync(id, currentUserId, isAdmin, reason));

    private static async Task<bool> ExecuteBool(Task<FsusBlog.Core.Common.Result> task)
        => (await task).IsSuccess;
}
