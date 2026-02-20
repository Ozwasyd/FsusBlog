using System.Text.Json.Serialization;

namespace FsusBlog.Server.Models.Dtos;

public record MessageInboxDto
{
    public string Id { get; init; } = string.Empty;
    public string Title { get; init; } = string.Empty;
    public string Content { get; init; } = string.Empty; // 补全正文
    public string CategoryName { get; init; } = string.Empty;
    public int Category { get; init; } // 补全类型枚举，方便前端判断样式
    public bool IsRead { get; init; }
    public DateTime CreateTime { get; init; }
}

public class CommentPushDto
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("content")]
    public string Content { get; set; } = string.Empty;

    [JsonPropertyName("createTime")]
    public DateTime CreateTime { get; set; }

    [JsonPropertyName("userName")]
    public string UserName { get; set; } = string.Empty;
}

public class CommentAddedNotifyDto
{
    [JsonPropertyName("articleId")]
    public int ArticleId { get; set; }

    [JsonPropertyName("comment")]
    public CommentPushDto Comment { get; set; } = new();

    [JsonPropertyName("time")]
    public DateTime Time { get; set; } = DateTime.UtcNow;
}