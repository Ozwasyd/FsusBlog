using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Interfaces;

public interface ICommentEndpointService
{
    Task<bool> CreateCommentAsync(int userId, CommentDto dto);
    Task<CursorResponse<CommentThreadItemDto>> GetCommentThreadsByCursorAsync(int articleId, CursorPageRequest<long> request, int previewLimit = 3);
    Task<CursorResponse<CommentReplyItemDto>> GetThreadRepliesByCursorAsync(int articleId, long rootId, CursorPageRequest<long> request);
    Task<bool> DeleteCommentAsync(long id, int currentUserId, bool isAdmin, string reason = "违反社区管理条例");
}