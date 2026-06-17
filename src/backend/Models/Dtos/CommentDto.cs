using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Moderation;
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
    public RegionModerationDecision? RegionDecision { get; init; }
    public string? AuthorMode { get; init; }
    public bool PublicSendExplicitlySelected { get; init; }
    public string? AnonymousScope { get; init; }
    public string? DisplayLanguage { get; init; }
    public string? ProofToken { get; init; }
    public byte[]? ZkProof { get; init; }

    public string GetTextToCheck() => Content;
}

public readonly record struct DeleteCommentRequest(string? Reason);
