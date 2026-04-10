using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Interfaces;

public interface IMessageService
{
    /// <summary>发送事务性通知 (点对点)</summary>
    Task SendPrivateNoticeAsync(long userId, string title, string content);

    /// <summary>发布全站公告 (广播)</summary>
    Task PublishGlobalNoticeAsync(string title, string content);

    /// <summary>标记单条消息已读</summary>
    Task MarkAsReadAsync(long userId, long messageId);

    Task MarkAllAsReadAsync(long userId);

    Task<List<MessageInboxDto>> GetInboxAsync(long userId, int pageIndex, int pageSize);

    /// <summary>删除单条消息 (物理删除关联记录)</summary>
    Task DeleteMessageAsync(long userId, long messageId);

    // --- 实时指令推送 ---
    Task PushUserStatusAsync(long userId, int status, string? reason);
    Task PushCommentRemoveAsync(int articleId, long commentId);
    Task PushCommentAddAsync(CommentAddedNotifyDto payload);

    // --- 治理与通知集成 ---
    Task SendCommentDeletedNoticeAsync(int targetUserId, string articleTitle, string commentSnippet, string reason);
    Task SendUserBannedNoticeAsync(int userId, string reason);
    Task SendUserUnbannedNoticeAsync(int userId);


    /// <summary>获取管理员发出的消息记录</summary>
    Task<List<MessageInboxDto>> GetAdminSentMessagesAsync(int pageIndex, int pageSize);
    /// <summary>管理员物理撤回消息 (全站公告或私信)</summary>
    Task RevokeMessageAsync(long messageId);
    Task PushArticleChangedAsync(ArticleNoticeDto payload);
}
