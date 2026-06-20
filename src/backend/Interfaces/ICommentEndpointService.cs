using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Interfaces;

public interface ICommentEndpointService
{
    Task<bool> CreateCommentAsync(int userId, CommentDto dto);
    Task<bool> CreateAttributablePublicCommentAsync(int userId, CommentCreateV2RequestCoreModel request, RegionModerationDecision? regionDecision = null);
    Task<bool> CreateStrongAnonymousCommentAsync(AnonymousCommentCreateRequestCoreModel request, RegionModerationDecision? regionDecision = null, CancellationToken cancellationToken = default);
    Task<CursorResponse<CommentThreadItemDto>> GetCommentThreadsByCursorAsync(int articleId, CursorPageRequest<long> request, int previewLimit = 3, string viewerRegion = "GLOBAL");
    Task<CursorResponse<CommentReplyItemDto>> GetThreadRepliesByCursorAsync(int articleId, long rootId, CursorPageRequest<long> request, string viewerRegion = "GLOBAL");
    Task<bool> DeleteCommentAsync(long id, int currentUserId, bool isAdmin, string reason = "违反社区管理条例");
}
