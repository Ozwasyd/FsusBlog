using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Interfaces;

public readonly record struct AdminPrincipalActor(long AdminPrincipalId, string AdminSessionId);

public interface ICommentCommandService
{
    Task<bool> CreateCommentAsync(int userId, CommentDto dto);

    Task<bool> DeleteCommentAsync(long id, int currentUserId, bool isAdmin, string reason = "违反社区管理条例");
}

public interface ICommentEndpointService
{
    Task<bool> CreateCommentAsync(int userId, CommentDto dto);
    Task<bool> CreateAttributablePublicCommentAsync(AccountPrincipalContext account, CommentCreateV2RequestCoreModel request, RegionModerationDecision? regionDecision = null);
    Task<bool> CreateStrongAnonymousCommentAsync(AnonymousCommentCreateRequestCoreModel request, RegionModerationDecision? regionDecision = null, CancellationToken cancellationToken = default);
    Task<bool> DeleteCommentAsAccountAsync(long id, int accountId, string reason = "违反社区管理条例");
    Task<bool> DeleteCommentAsAdminAsync(long id, AdminPrincipalActor actor, string reason = "违反社区管理条例");
}
