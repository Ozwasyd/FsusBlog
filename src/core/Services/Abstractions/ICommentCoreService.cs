using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;

namespace FsusBlog.Core.Services.Abstractions;

public interface ICommentCoreService
{
    Task<Result> CreateCommentAsync(int userId, int articleId, string content);
    Task<Result<CoreCursorResult<CommentQueryCoreModel>>> GetCommentsByCursorAsync(int articleId, long? cursor, int limit);
    Task<Result<CoreCursorResult<UserCommentCoreModel>>> GetUserCommentsAsync(int userId, long? cursor, int limit);
    Task<Result<CoreCursorResult<UserCommentCoreModel>>> GetUserCommentsForArticleAsync(int userId, int articleId, long? cursor, int limit);
    Task<Result> DeleteCommentAsync(long id, int currentUserId, bool isAdmin, string reason);
}
