using FsusBlog.Server.Interfaces;
using System.ComponentModel.DataAnnotations;
using System.Text.Json.Serialization;

namespace FsusBlog.Server.Models.Dtos;

// ==========================================
// 1. 输入 DTO (Request Models)
// ==========================================

public class CommentDto : ICheckableContent
{
    [Required]
    public int ArticleId { get; set; }

    [Required]
    [MaxLength(1000, ErrorMessage = "评论内容不能超过1000字")]
    public string Content { get; set; } = null!;

    public string GetTextToCheck() => Content;
}

public record DeleteCommentRequest(string? Reason);

// ==========================================
// 2. 输出 DTO (Response Models)
// ==========================================

/// <summary>
/// 公开评论列表项 (零分配)
/// </summary>
public readonly record struct CommentItemDto(string id, string Content, DateTime CreateTime, string UserName);

/// <summary>
/// 公开评论列表响应 (零分配)
/// </summary>
public readonly record struct CommentListResponseDto(List<CommentItemDto> Data, long? NextCursor, bool HasMore);

/// <summary>
/// 用户个人历史评论视图 (零分配)
/// </summary>
public record struct UserCommentDto
{
    public long Id { get; set; }
    public string Content { get; set; }
    public DateTime CreateTime { get; set; }
    public int ArticleId { get; set; }
    public string ArticleTitle { get; set; }

    public UserCommentDto()
    {
        Content = string.Empty;
        ArticleTitle = string.Empty;
    }
}

// ==========================================
// 3. 通用容器
// ==========================================

public class CursorResult<T>
{
    public List<T> Data { get; set; } = [];
    public long? NextCursor { get; set; }
    public bool HasMore { get; set; }
}

/// <summary>
/// 评论查询结果模型 (用于 Service 层高性能返回)
/// </summary>
public readonly record struct CommentQueryResultDto(long Id, string Content, DateTime CreateTime, string UserName);

/// <summary>
/// 内部查询载体：用于创建评论时获取用户名 (零分配)
/// </summary>
public readonly record struct CommentUserQueryResult(string Username);

/// <summary>
/// 内部查询载体：用于删除评论时提取关联信息 (零分配)
/// </summary>
public readonly record struct CommentDeleteQueryResult(int UserId, int ArticleId, string Content, string ArticleTitle);