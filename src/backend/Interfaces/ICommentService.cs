using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Interfaces;

public interface ICommentService
{
    Task<bool> CreateCommentAsync(int userId, CommentDto dto);
    Task<CursorResponse<CommentQueryResultDto>> GetCommentsByCursorAsync(int articleId, CursorPageRequest<long> request);
    Task<CursorResponse<UserCommentResponse>> GetAttributableCommentsAsync(int userId, CursorPageRequest<long> request);
    Task<bool> DeleteCommentAsync(long id, int currentUserId, bool isAdmin, string reason = "违反社区管理条例");
}
