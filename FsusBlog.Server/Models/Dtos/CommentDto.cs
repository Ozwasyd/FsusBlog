using FsusBlog.Server.Interfaces;
using System.ComponentModel.DataAnnotations;
using System.Text.Json.Serialization;

namespace FsusBlog.Server.Models.Dtos;

public class CommentDto : IPowRequest
{
    [Required]
    public int ArticleId { get; set; }

    [Required]
    [MaxLength(1000, ErrorMessage = "评论内容不能超过1000字")]
    public string Content { get; set; } = null!;

    // ==========================================
    // 🌟 PoW 验证字段 (实现 IPowRequest)
    // 使用 JsonPropertyName 确保前端传来的 JSON 字段能对上
    // ==========================================

    [JsonPropertyName("powSalt")]
    public string PowSalt { get; set; } = string.Empty;

    [JsonPropertyName("powNonce")]
    public string PowNonce { get; set; } = string.Empty;

    [JsonPropertyName("powSignature")]
    public string PowSignature { get; set; } = string.Empty;

    [JsonPropertyName("powTimestamp")]
    public long PowTimestamp { get; set; }

    [JsonPropertyName("difficulty")]
    public int Difficulty { get; set; }

    [JsonPropertyName("browserFp")]
    public string BrowserFp { get; set; } = string.Empty;
}

public class CursorResult<T>
{
    public List<T> Data { get; set; } = [];
    public long? NextCursor { get; set; }
    public bool HasMore { get; set; }
}

public class UserCommentDto
{
    public long Id { get; set; }
    public string Content { get; set; } = null!;
    public DateTime CreateTime { get; set; }
    public int ArticleId { get; set; }
    public string ArticleTitle { get; set; } = null!;
}