using FsusBlog.Server.Models.Dtos;

namespace FsusBlog.Server.Interfaces;

public interface ICommentService
{
    Task<bool> CreateCommentAsync(int userId, CommentDto dto);
    Task<CursorResult<CommentQueryResultDto>> GetCommentsByCursorAsync(int articleId, long? cursor, int limit);
    Task<CursorResult<UserCommentDto>> GetUserCommentsAsync(int userId, long? cursor, int limit);
    Task<bool> DeleteCommentAsync(long id, int currentUserId, bool isAdmin, string reason = "违反社区管理条例");
}
