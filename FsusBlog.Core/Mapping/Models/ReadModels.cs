using FsusBlog.Shared.Contracts.Models;

namespace FsusBlog.Core.Mapping.Models;

public readonly record struct CorePageResult<T>(IReadOnlyList<T> Items, int Total);

public readonly record struct CoreCursorResult<T>(IReadOnlyList<T> Data, long? NextCursor, bool HasMore);

public readonly record struct ArticleCategoryCoreModel(int Id, string Name);

public readonly record struct TagCoreModel(int Id, string Name);

public readonly record struct ArticleListCoreModel(
    ArticleListItemPod Pod,
    int Id,
    string Title,
    string? Summary,
    string? Snippet,
    int Views,
    DateTime CreateTime,
    ArticleCategoryCoreModel Category,
    IReadOnlyList<TagCoreModel> Tags,
    bool? IsDeleted);

public readonly record struct ArticleDetailCoreModel(
    ArticleDetailPod Pod,
    int Id,
    string Title,
    string Content,
    string? Summary,
    int Views,
    int WordCount,
    int EstimatedReadingMinutes,
    bool ShowReadingNotice,
    DateTime CreateTime,
    ArticleCategoryCoreModel Category,
    IReadOnlyList<TagCoreModel> Tags,
    int CategoryId,
    bool IsDeleted);

public readonly record struct PopularArticleCoreModel(PopularArticlePod Pod, int Id, string Title, int Views);

public readonly record struct CommentQueryCoreModel(CommentItemPod Pod, long Id, string Content, DateTime CreateTime, string UserName);

public readonly record struct UserCommentCoreModel(
    UserCommentPod Pod,
    long Id,
    string Content,
    DateTime CreateTime,
    int ArticleId,
    string ArticleTitle,
    long? RootId,
    string? ReplyToUserName);

public readonly record struct RecentCommentCoreModel(RecentCommentPod Pod, int? UserId, string UserName, string Content, DateTime CreateTime);

public readonly record struct RegionDistributionCoreModel(RegionDistributionPod Pod, string Region, int Count);

public readonly record struct SiteStatsCoreModel(
    SiteStatsPod Pod,
    int TotalArticles,
    int TotalComments,
    int TrashCount,
    int TotalVisits,
    int RegisteredVisits,
    int AnonymousVisits,
    IReadOnlyList<PopularArticleCoreModel> PopularArticles,
    IReadOnlyList<RecentCommentCoreModel> RecentComments,
    IReadOnlyList<RegionDistributionCoreModel> RegionDistributions);
