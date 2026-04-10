using System.Text.Json.Serialization;

namespace FsusBlog.Shared.Contracts.Outputs;

public readonly record struct ArticleCategoryView(int Id, string Name);
public readonly record struct TagDto(int Id, string Name);
public readonly record struct TagWithCountDto(int Id, string Name, int ArticleCount);
public readonly record struct ArticleMutationResponseDto(int Id);
public readonly record struct TrashClearResponseDto(int Count);
public readonly record struct ArticleNoticeDto(int ArticleId, string Action, DateTime EventTime);

public record struct ArticleListDto
{
    public int Id { get; set; }
    public string Title { get; set; }
    public string? Summary { get; set; }
    public string? Snippet { get; set; }
    public int Views { get; set; }
    public DateTime CreateTime { get; set; }
    public ArticleCategoryView Category { get; set; }
    public List<TagDto> Tags { get; set; }
    public bool? IsDeleted { get; set; }

    public ArticleListDto()
    {
        Title = string.Empty;
        Tags = [];
    }
}

public record struct CategoryDto
{
    public int Id { get; set; }
    public required string Name { get; set; }
    public int ArticleCount { get; set; }
}

public sealed record class PageResultDto<T>
{
    public List<T> Items { get; set; } = [];
    public int Total { get; set; }
}

public record struct ArticleDetailDto
{
    public int Id { get; set; }
    public string Title { get; set; }
    public string Content { get; set; }
    public string? Summary { get; set; }
    public int Views { get; set; }
    public DateTime CreateTime { get; set; }
    public ArticleCategoryView Category { get; set; }
    public List<TagDto> Tags { get; set; }

    public ArticleDetailDto()
    {
        Title = string.Empty;
        Content = string.Empty;
        Tags = [];
    }
}

public readonly record struct CommentItemDto(string Id, string Content, DateTime CreateTime, string UserName);
public readonly record struct CommentListResponseDto(List<CommentItemDto> Data, string? NextCursor, bool HasMore);

public record struct UserCommentDto
{
    public long Id { get; init; }
    public string Content { get; init; }
    public DateTime CreateTime { get; init; }
    public int ArticleId { get; init; }
    public string ArticleTitle { get; init; }

    public UserCommentDto()
    {
        Content = string.Empty;
        ArticleTitle = string.Empty;
    }
}

public sealed record class CursorResult<T>
{
    public List<T> Data { get; init; } = [];
    public string? NextCursor { get; init; }
    public bool HasMore { get; init; }
}

public readonly record struct CommentQueryResultDto(long Id, string Content, DateTime CreateTime, string UserName);
public readonly record struct CommentUserQueryResult(string Username);
public readonly record struct CommentDeleteQueryResult(int UserId, int ArticleId, string Content, string ArticleTitle);

public sealed record class SiteStatsDto
{
    public int TotalArticles { get; init; }
    public int TotalComments { get; init; }
    public int TrashCount { get; init; }
    public int TotalVisits { get; init; }
    public int RegisteredVisits { get; init; }
    public int AnonymousVisits { get; init; }
    public List<PopularArticleDto> PopularArticles { get; init; } = [];
    public List<RecentCommentDto> RecentComments { get; init; } = [];
    public List<RegionDistributionDto> RegionDistributions { get; init; } = [];
}

public readonly record struct PopularArticleDto(int Id, string Title, int Views);
public readonly record struct RecentCommentDto(int? UserId, string UserName, string Content, DateTime CreateTime);
public readonly record struct RegionDistributionDto(string Region, int Count);

public readonly record struct TokenResponseDto(string AccessToken, string RefreshToken);
public readonly record struct LoginResponseDto(int Id, string Username, string Role);
public readonly record struct UserInfoDto(int Id, string Username, string Role, int Status, string? BanReason);
public readonly record struct UserListDto(
    int Id,
    string Username,
    string Role,
    int Status,
    DateTime CreateTime,
    string? LastLoginIp,
    DateTime? LastLoginTime);

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

public readonly record struct CommentAddedNotifyDto
{
    [JsonPropertyName("articleId")]
    public int ArticleId { get; init; }

    [JsonPropertyName("comment")]
    public CommentPushDto Comment { get; init; }

    [JsonPropertyName("time")]
    public DateTime Time { get; init; }
}

public readonly record struct GlobalNoticePayload(string id, string title, DateTime time);
public readonly record struct MessageRevokedPayload(string messageId);
public readonly record struct UserStatusPayload(int status, string? reason, DateTime time);
public readonly record struct NoticePayload(string title, int unreadCount, DateTime time);
public readonly record struct CommentRemovedPayload(int articleId, string commentId, DateTime time);

public record struct FileUploadResult
{
    public bool Success { get; set; }
    public string Message { get; set; } = string.Empty;
    public string? RelativeUrl { get; set; }
    public string? Url { get; set; }
    public string? PhysicalPath { get; set; }
    public FileUploadResult() { }
}

public readonly record struct FileUploadOutputDto(string Url, string RelativeUrl, string Message);

public readonly record struct PowChallenge(
    string Salt,
    int Difficulty,
    long Timestamp,
    string Signature
);

public readonly record struct SeoConfigDto
{
    public string Title { get; init; }
    public string Description { get; init; }
    public string Keywords { get; init; }
    public string Author { get; init; }
    public string OgImage { get; init; }
    public string BaseUrl { get; init; }

    public SeoConfigDto()
    {
        Title = "Fsus's Blog";
        Description = "FORWARD";
        Keywords = "记录";
        Author = "Fsu";
        OgImage = "";
        BaseUrl = "https://blog.fsus.blog";
    }
}

public readonly record struct PageContentDto
{
    public string? Slug { get; init; }
    public string? Content { get; init; }
}
