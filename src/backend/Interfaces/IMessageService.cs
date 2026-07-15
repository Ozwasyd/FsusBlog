using FsusBlog.Core.Common;
using FsusBlog.Shared.Contracts.Outputs;
using FsusBlog.Shared.Contracts.NotificationStream;

namespace FsusBlog.Server.Interfaces;

public readonly record struct AdminMessageActor(long AdminPrincipalId, string AdminSessionId)
{
    public static AdminMessageActor System => new(0, string.Empty);

    public bool HasAdminPrincipal => AdminPrincipalId > 0 && !string.IsNullOrWhiteSpace(AdminSessionId);
}

public interface IMessageQueryService
{
    Task<PageResponse<ConversationListItemResponse>> GetAccountConversationsAsync(int accountId, int page, int size, string? filter);
    Task<ConversationDetailResponse?> GetAccountConversationDetailAsync(int accountId, long conversationId);
    Task<PageResponse<ConversationListItemResponse>> GetAdminConversationsAsync(int page, int size, string? filter);
    Task<ConversationDetailResponse?> GetAdminConversationDetailAsync(long conversationId);
}

public interface IMessageCommandService
{
    Task<Result<ConversationDetailResponse>> CreateAccountTicketAsync(int accountId, string subject, string body);
    Task<Result<ConversationMessageResponse>> ReplyAsAccountAsync(int accountId, long conversationId, string body);
    Task<Result> MarkConversationReadAsync(int accountId, long conversationId);
    Task<Result<ConversationMessageResponse>> ReplyAsAdminAsync(long conversationId, string body, AdminMessageActor adminActor);
    Task<Result> UpdateConversationStatusAsync(long conversationId, ConversationStatusValue status, AdminMessageActor adminActor);
    Task<Result<ConversationDetailResponse>> SendSystemMessageAsync(string subject, string body, long? targetAccountId, AdminMessageActor adminActor);

    // 治理通知聚合入口
    Task SendAccountTransactionalNoticeAsync(int accountId, string subject, string body);
    Task SendCommentDeletedNoticeAsync(int targetAccountId, string articleTitle, string commentSnippet, string reason);
    Task SendAccountBannedNoticeAsync(int accountId, string reason);
    Task SendAccountUnbannedNoticeAsync(int accountId);
}

public interface IMessageRealtimePublisher
{
    Task PushAccountStatusAsync(long accountId, int status, string? reason);
    Task PushCommentRemoveAsync(int articleId, long commentId, long? rootId, long? parentId);
    Task PushCommentAddAsync(CommentAddedNotifyDto payload);
    Task PushCacheControlAsync(CacheControlPayload payload);
    Task PushArticleChangedAsync(ArticleNoticeDto payload, string? idempotencyKey = null);
}
