using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Moderation;

namespace FsusBlog.Server.Services;

public interface ICommentNotificationService
{
    Task PublishRemovedAsync(int articleId, long commentId, long rootId, long? parentId);

    Task NotifyDeletionAsync(int userId, string articleTitle, string commentSnippet, string reason);

    Task NotifyModelRiskHiddenAsync(Comment comment, CommentModerationDisposition disposition);
}

public sealed class CommentNotificationService(
    IMessageRealtimePublisher realtime,
    IMessageCommandService commands,
    ILogger<CommentNotificationService> logger) : ICommentNotificationService
{
    public Task PublishRemovedAsync(int articleId, long commentId, long rootId, long? parentId)
        => realtime.PushCommentRemoveAsync(articleId, commentId, rootId, parentId);

    public Task NotifyDeletionAsync(int userId, string articleTitle, string commentSnippet, string reason)
        => BoundaryExecutor.ExecuteAsync(
            () => commands.SendCommentDeletedNoticeAsync(userId, articleTitle, commentSnippet, reason),
            logger,
            $"comment-notify-delete:{userId}",
            LogLevel.Error);

    public async Task NotifyModelRiskHiddenAsync(Comment comment, CommentModerationDisposition disposition)
    {
        if (comment.UserId is not > 0)
        {
            logger.LogInformation(
                "模型审核隐藏匿名评论，跳过站内信提醒 | CommentId: {CommentId} | Reason: {Reason}",
                comment.Id,
                disposition.Reason);
            return;
        }

        string commentSnippet = BuildCommentNoticeSnippet(comment.Content);
        string body = string.Concat(
            "您的评论已由自动审核隐藏，原因是模型命中了内容风险信号。",
            "评论片段：「",
            commentSnippet,
            "」。",
            "本提醒不构成账号处罚，不会触发封禁、限流、信誉扣分或匿名凭证处理。",
            disposition.RequiresHumanReview ? "该评论会进入人工复核队列。" : "如有疑问，可通过站内信联系管理员。");
        await BoundaryExecutor.ExecuteAsync(
            () => commands.SendAccountTransactionalNoticeAsync(
                comment.UserId.Value,
                "评论审核提醒",
                body),
            logger,
            $"comment-model-risk-warning:{comment.UserId.Value}:{comment.Id}",
            LogLevel.Error);
    }

    private static string BuildCommentNoticeSnippet(string content)
    {
        string normalized = content.ReplaceLineEndings(" ").Trim();
        return normalized.Length <= 60 ? normalized : string.Concat(normalized[..60], "...");
    }
}
