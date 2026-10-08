using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Interfaces;

public readonly record struct AdminPrincipalActor(long AdminPrincipalId, string AdminSessionId);

public readonly record struct CommentCreateResult(
    bool Created,
    long CommentId,
    long RootId,
    long? ParentId,
    DateTime CreatedAtUtc,
    CommentModerationStatus ModerationStatus,
    string VisibilityState,
    bool IsPubliclyVisible,
    bool IdempotencyReplay,
    string? FailureCode = null,
    string? ManagementSecret = null)
{
    public static CommentCreateResult Failed => new(false, 0, 0, null, default, CommentModerationStatus.Pending, "pending", false, false);

    public static CommentCreateResult Failure(string code)
        => new(false, 0, 0, null, default, CommentModerationStatus.Pending, "pending", false, false, code);
}

public interface ICommentCommandService
{
    Task<bool> CreateCommentAsync(int userId, CommentDto dto);

    Task<bool> DeleteCommentAsync(long id, int currentUserId, bool isAdmin, string reason = "违反社区管理条例");
}

public interface ICommentEndpointService
{
    Task<bool> CreateCommentAsync(int userId, CommentDto dto);
    Task<bool> CreateAttributablePublicCommentAsync(AccountPrincipalContext account, CommentCreateRequestCoreModel request, RegionModerationDecision? regionDecision = null);
    Task<bool> CreateStrongAnonymousCommentAsync(AnonymousCommentCreateRequestCoreModel request, RegionModerationDecision? regionDecision = null, CancellationToken cancellationToken = default);

    async Task<CommentCreateResult> CreateAttributablePublicCommentResultAsync(AccountPrincipalContext account, CommentCreateRequestCoreModel request, RegionModerationDecision? regionDecision = null)
        => await CreateAttributablePublicCommentAsync(account, request, regionDecision)
            ? new CommentCreateResult(true, 0, 0, null, DateTime.UtcNow, CommentModerationStatus.Pending, "pending", false, false)
            : CommentCreateResult.Failed;

    Task<CommentCreateResult> CreateAttributablePublicCommentResultAsync(
        AccountPrincipalContext account,
        CommentCreateRequestCoreModel request,
        string clientMutationId,
        RegionModerationDecision? regionDecision = null)
        => CreateAttributablePublicCommentResultAsync(account, request, regionDecision);

    async Task<CommentCreateResult> CreateStrongAnonymousCommentResultAsync(AnonymousCommentCreateRequestCoreModel request, RegionModerationDecision? regionDecision = null, CancellationToken cancellationToken = default)
        => await CreateStrongAnonymousCommentAsync(request, regionDecision, cancellationToken)
            ? new CommentCreateResult(true, 0, 0, null, DateTime.UtcNow, CommentModerationStatus.Pending, "pending", false, false)
            : CommentCreateResult.Failed;
    Task<bool> DeleteCommentAsAccountAsync(long id, int accountId, string reason = "违反社区管理条例");
    Task<bool> DeleteCommentAsAdminAsync(long id, AdminPrincipalActor actor, string reason = "违反社区管理条例");
}
