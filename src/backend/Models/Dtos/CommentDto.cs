using FsusBlog.Server.Interfaces;
using System.ComponentModel.DataAnnotations;

namespace FsusBlog.Server.Models.Dtos;

public static class CommentLimits
{
    public const int ContentMaxChars = 1000;
    public const int ContentMaxUtf8Bytes = 4096;
    public const int CreatePayloadMaxBytes = 16 * 1024;
    public const int ClientReplyRenderLimit = 300;
}

// ==========================================
// 1. 输入 DTO (Request Models)
// ==========================================

public sealed record class CommentDto : ICheckableContent
{
    [Required]
    public int ArticleId { get; init; }

    [Required]
    [MaxLength(CommentLimits.ContentMaxChars, ErrorMessage = "评论内容不能超过1000字")]
    public required string Content { get; init; }

    public string? ParentId { get; init; }
    public string? RootId { get; init; }
    public string? ReplyToCommentId { get; init; }
    public int? ReplyToUserId { get; init; }

    public string GetTextToCheck() => Content;
}

public readonly record struct DeleteCommentRequest(string? Reason);
