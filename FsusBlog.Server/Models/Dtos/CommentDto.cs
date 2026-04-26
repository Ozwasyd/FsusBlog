using FsusBlog.Server.Interfaces;
using System.ComponentModel.DataAnnotations;

namespace FsusBlog.Server.Models.Dtos;

// ==========================================
// 1. 输入 DTO (Request Models)
// ==========================================

public sealed record class CommentDto : ICheckableContent
{
    [Required]
    public int ArticleId { get; init; }

    [Required]
    [MaxLength(1000, ErrorMessage = "评论内容不能超过1000字")]
    public required string Content { get; init; }

    public string? ParentId { get; init; }
    public string? RootId { get; init; }
    public string? ReplyToCommentId { get; init; }
    public int? ReplyToUserId { get; init; }

    public string GetTextToCheck() => Content;
}

public readonly record struct DeleteCommentRequest(string? Reason);
