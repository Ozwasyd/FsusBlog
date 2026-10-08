using System.ComponentModel.DataAnnotations;

using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Moderation;

namespace FsusBlog.Server.Models.Dtos;

public static class CommentLimits
{
    public const int ContentMinChars = 100;
    public const int ContentMinUtf8Bytes = 1024;
    public const int DefaultContentMaxChars = 1000;
    public const int DefaultContentMaxUtf8Bytes = 4096;
    public const int HardContentMaxChars = 3000;
    public const int HardContentMaxUtf8Bytes = 12288;
    public const int ContentMaxChars = DefaultContentMaxChars;
    public const int ContentMaxUtf8Bytes = DefaultContentMaxUtf8Bytes;
    public const int CreatePayloadMaxBytes = 16 * 1024;
    public const int ClientReplyRenderLimit = 300;

    public static int NormalizeMaxChars(int? value)
        => value is >= ContentMinChars and <= HardContentMaxChars
            ? value.Value
            : DefaultContentMaxChars;

    public static int NormalizeMaxUtf8Bytes(int? value)
        => value is >= ContentMinUtf8Bytes and <= HardContentMaxUtf8Bytes
            ? value.Value
            : DefaultContentMaxUtf8Bytes;

    public static void ValidateMaxChars(int value)
    {
        if (value is < ContentMinChars or > HardContentMaxChars)
        {
            throw new ArgumentOutOfRangeException(nameof(CommentMaxChars));
        }
    }

    public static void ValidateMaxUtf8Bytes(int value)
    {
        if (value is < ContentMinUtf8Bytes or > HardContentMaxUtf8Bytes)
        {
            throw new ArgumentOutOfRangeException(nameof(CommentMaxUtf8Bytes));
        }
    }

    public const string CommentMaxChars = nameof(CommentMaxChars);
    public const string CommentMaxUtf8Bytes = nameof(CommentMaxUtf8Bytes);
}

// ==========================================
// 1. 输入 DTO (Request Models)
// ==========================================

public sealed record class CommentDto : ICheckableContent
{
    [Required]
    public int ArticleId
    {
        get; init;
    }

    [Required]
    [MaxLength(CommentLimits.ContentMaxChars, ErrorMessage = "评论内容不能超过1000字")]
    public required string Content
    {
        get; init;
    }

    public string? ParentId
    {
        get; init;
    }
    public string? RootId
    {
        get; init;
    }
    public string? ReplyToCommentId
    {
        get; init;
    }
    public RegionModerationDecision? RegionDecision
    {
        get; init;
    }
    public string? AuthorMode
    {
        get; init;
    }
    public bool PublicSendExplicitlySelected
    {
        get; init;
    }
    public string? AnonymousScope
    {
        get; init;
    }
    public string? DisplayLanguage
    {
        get; init;
    }
    public string? ProofToken
    {
        get; init;
    }
    public byte[]? ZkProof
    {
        get; init;
    }

    public string GetTextToCheck() => Content;
}
