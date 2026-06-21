using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Interfaces;

public readonly record struct AdminPrincipalActor(long AdminPrincipalId, string AdminSessionId);

public interface ICommentEndpointService
{
    Task<bool> CreateCommentAsync(int userId, CommentDto dto);
    Task<bool> CreateAttributablePublicCommentAsync(AccountPrincipalContext account, CommentCreateV2RequestCoreModel request, RegionModerationDecision? regionDecision = null);
    Task<bool> CreateStrongAnonymousCommentAsync(AnonymousCommentCreateRequestCoreModel request, RegionModerationDecision? regionDecision = null, CancellationToken cancellationToken = default);
    Task<CursorResponse<CommentThreadItemDto>> GetCommentThreadsByCursorAsync(int articleId, CursorPageRequest<long> request, int previewLimit = 3, string viewerRegion = "GLOBAL");
    Task<CursorResponse<CommentReplyItemDto>> GetThreadRepliesByCursorAsync(int articleId, long rootId, CursorPageRequest<long> request, string viewerRegion = "GLOBAL");
    Task<bool> DeleteCommentAsAccountAsync(long id, int accountId, string reason = "违反社区管理条例");
    Task<bool> DeleteCommentAsAdminAsync(long id, AdminPrincipalActor actor, string reason = "违反社区管理条例");
}
