using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Core.Services.Gateways;
using FsusBlog.Server.Infrastructure.CoreBridge.Caching;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Services;

namespace FsusBlog.Server.Infrastructure.CoreBridge.Gateways;

public sealed class CommentCoreGateway(
    CommentService service,
    CommentCoreQueryCache queryCache,
    ICommentCursorPolicyResolver cursorPolicies) : ICommentCoreGateway
{
    private static readonly Int64CursorCodec s_cursorCodec = Int64CursorCodec.Instance;

    public Task<bool> CreateCommentAsync(int userId, int articleId, string content)
        => service.CreateCommentAsync(userId, new CommentDto { ArticleId = articleId, Content = content });

    public async Task<CoreCursorResult<CommentQueryCoreModel>> GetCommentsByCursorAsync(int articleId, long? cursor, int limit)
    {
        return await queryCache.GetOrLoadCommentsByCursorAsync(articleId, cursor, limit, () => LoadCommentsByCursorAsync(articleId, cursor, limit));
    }

    public async Task<CoreCursorResult<UserCommentCoreModel>> GetUserCommentsAsync(int userId, long? cursor, int limit)
    {
        return await queryCache.GetOrLoadUserCommentsAsync(userId, cursor, limit, () => LoadUserCommentsAsync(userId, cursor, limit));
    }

    public Task<bool> DeleteCommentAsync(long id, int currentUserId, bool isAdmin, string reason)
        => service.DeleteCommentAsync(id, currentUserId, isAdmin, reason);

    private async Task<CoreCursorResult<CommentQueryCoreModel>> LoadCommentsByCursorAsync(int articleId, long? cursor, int limit)
    {
        var request = new CursorPageRequest<long>(
            cursor.HasValue ? s_cursorCodec.Format(cursor.Value) : null,
            cursor,
            cursorPolicies.Resolve(CommentCursorPolicyKind.Threads).NormalizeLimit(limit));
        CursorResponse<CommentQueryResultDto> source = await service.GetCommentsByCursorAsync(articleId, request);
        return CursorInterop.ToCore(source, item =>
        {
            var pod = PodProjector.ProjectCommentItem(item.Id, item.CreateTime, item.Author.Mode, item.Author.DisplayName, item.Content, out _);
            return new CommentQueryCoreModel(pod, item.Id, item.Content, item.CreateTime, item.Author);
        }, s_cursorCodec);
    }

    private async Task<CoreCursorResult<UserCommentCoreModel>> LoadUserCommentsAsync(int userId, long? cursor, int limit)
    {
        var request = new CursorPageRequest<long>(
            cursor.HasValue ? s_cursorCodec.Format(cursor.Value) : null,
            cursor,
            cursorPolicies.Resolve(CommentCursorPolicyKind.UserComments).NormalizeLimit(limit));
        CursorResponse<UserCommentResponse> source = await service.GetAttributableCommentsAsync(userId, request);
        return CursorInterop.ToCore(source, item => CommentProjection.ToCoreModel(new UserCommentReadModel
        {
            Id = item.Id,
            Content = item.Content,
            CreateTime = item.CreateTime,
            ArticleId = item.ArticleId,
            ArticleTitle = item.ArticleTitle,
            RootId = item.RootId,
            Author = item.Author,
            ReplyToAuthor = item.ReplyToAuthor,
            ModerationStatus = item.ModerationStatus,
            IsDeleted = item.VisibilityReasonCode == "deleted_by_user_or_admin",
            HasBlockedRegions = item.VisibilityReasonCode == "geo_limited"
        }), s_cursorCodec);
    }

}
