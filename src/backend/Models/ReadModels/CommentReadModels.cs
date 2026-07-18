using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Models.ReadModels;

public sealed record class UserCommentReadModel
{
    public long Id
    {
        get; init;
    }
    public string Content { get; init; } = string.Empty;
    public DateTime CreateTime
    {
        get; init;
    }
    public int ArticleId
    {
        get; init;
    }
    public string ArticleTitle { get; init; } = string.Empty;
    public long? RootId
    {
        get; init;
    }
    public CommentAuthorViewDto Author
    {
        get; init;
    }
    public CommentAuthorViewDto? ReplyToAuthor
    {
        get; init;
    }
    public int ModerationStatus { get; init; } = 1;
    public bool IsDeleted
    {
        get; init;
    }
    public bool HasBlockedRegions
    {
        get; init;
    }
}
