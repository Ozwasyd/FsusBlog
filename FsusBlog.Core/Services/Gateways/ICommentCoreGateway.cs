using FsusBlog.Core.Mapping.Models;

namespace FsusBlog.Core.Services.Gateways;

public interface ICommentCoreGateway
{
    Task<bool> CreateCommentAsync(int userId, int articleId, string content);
    Task<CoreCursorResult<CommentQueryCoreModel>> GetCommentsByCursorAsync(int articleId, long? cursor, int limit);
    Task<CoreCursorResult<UserCommentCoreModel>> GetUserCommentsAsync(int userId, long? cursor, int limit);
    Task<bool> DeleteCommentAsync(long id, int currentUserId, bool isAdmin, string reason);
}
