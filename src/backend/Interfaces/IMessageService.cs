using FsusBlog.Core.Common;
using FsusBlog.Shared.Contracts.Outputs;
using FsusBlog.Shared.Contracts.NotificationStream;

namespace FsusBlog.Server.Interfaces;

public interface IMessageQueryService
{
    Task<PageResponse<ConversationListItemResponse>> GetUserConversationsAsync(int userId, int page, int size, string? filter);
    Task<ConversationDetailResponse?> GetUserConversationDetailAsync(int userId, long conversationId);
    Task<PageResponse<ConversationListItemResponse>> GetAdminConversationsAsync(int page, int size, string? filter);
    Task<ConversationDetailResponse?> GetAdminConversationDetailAsync(long conversationId);
}

public interface IMessageCommandService
{
    Task<Result<ConversationDetailResponse>> CreateUserTicketAsync(int userId, string subject, string body);
    Task<Result<ConversationMessageResponse>> ReplyAsUserAsync(int userId, long conversationId, string body);
    Task<Result> MarkConversationReadAsync(int userId, long conversationId);
    Task<Result<ConversationMessageResponse>> ReplyAsAdminAsync(long conversationId, string body, int adminUserId);
    Task<Result> UpdateConversationStatusAsync(long conversationId, ConversationStatusValue status, int adminUserId);
    Task<Result<ConversationDetailResponse>> SendSystemMessageAsync(string subject, string body, long? targetUserId, int adminUserId);

    // 治理通知聚合入口
    Task SendUserTransactionalNoticeAsync(int userId, string subject, string body);
    Task SendCommentDeletedNoticeAsync(int targetUserId, string articleTitle, string commentSnippet, string reason);
    Task SendUserBannedNoticeAsync(int userId, string reason);
    Task SendUserUnbannedNoticeAsync(int userId);
}

public interface IMessageRealtimePublisher
{
    Task PushUserStatusAsync(long userId, int status, string? reason);
    Task PushCommentRemoveAsync(int articleId, long commentId, long? rootId, long? parentId);
    Task PushCommentAddAsync(CommentAddedNotifyDto payload);
    Task PushCacheControlAsync(CacheControlPayload payload);
    Task PushArticleChangedAsync(ArticleNoticeDto payload);
}
