using System.Text.Json.Serialization;

namespace FsusBlog.Server.Models.Dtos;

/// <summary>
/// 收件箱消息视图
/// 优化：record struct。高频列表项，在内存中连续存储以提升 CPU 缓存命中率。
/// </summary>
public record struct MessageInboxDto
{
    public string Id { get; init; }
    public string Title { get; init; }
    public string Content { get; init; }
    public string CategoryName { get; init; }
    public int Category { get; init; }
    public bool IsRead { get; init; }
    public DateTime CreateTime { get; init; }
}

/// <summary>
/// 评论推送视图 (SignalR)
/// 优化：readonly record struct。作为不可变数据载体。
/// </summary>
public readonly record struct CommentPushDto
{
    [JsonPropertyName("id")]
    public string Id { get; init; }

    [JsonPropertyName("content")]
    public string Content { get; init; }

    [JsonPropertyName("createTime")]
    public DateTime CreateTime { get; init; }

    [JsonPropertyName("userName")]
    public string UserName { get; init; }
}

/// <summary>
/// 评论新增通知 (SignalR)
/// 优化：readonly record struct。因为其内部字段 Comment 也是 struct，保持一致性可避免装箱。
/// </summary>
public readonly record struct CommentAddedNotifyDto
{
    [JsonPropertyName("articleId")]
    public int ArticleId { get; init; }

    [JsonPropertyName("comment")]
    public CommentPushDto Comment { get; init; }

    [JsonPropertyName("time")]
    public DateTime Time { get; init; }
}

// 零分配 SignalR 载荷

public readonly record struct GlobalNoticePayload(string id, string title, DateTime time);
public readonly record struct MessageRevokedPayload(string messageId);
public readonly record struct UserStatusPayload(int status, string? reason, DateTime time);
public readonly record struct NoticePayload(string title, int unreadCount, DateTime time);
public readonly record struct CommentRemovedPayload(int articleId, string commentId, DateTime time);