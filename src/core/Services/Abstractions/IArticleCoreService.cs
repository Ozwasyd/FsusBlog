using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;

namespace FsusBlog.Core.Services.Abstractions;

public interface IArticleCoreService
{
    Task<Result<CorePageResult<ArticleListCoreModel>>> GetPageListAsync(int page, int size, int? categoryId, int? tagId, bool isDeleted, int? status = null, bool includePrivate = false, string? keyword = null, long? listCacheVersion = null, CancellationToken cancellationToken = default);
    Task<Result<ArticleDetailCoreModel?>> GetByIdAsync(int id, bool includePrivate = false, CancellationToken cancellationToken = default);
    Task<Result<int>> CreateAsync(string title, string content, string? summary, string? coverImageUrl, int categoryId, IReadOnlyList<int> tagIds, int status = 2, DateTime? scheduledPublishAt = null, CancellationToken cancellationToken = default);
    Task<Result> UpdateAsync(int id, string title, string content, string? summary, string? coverImageUrl, int categoryId, IReadOnlyList<int> tagIds, int status = 2, DateTime? scheduledPublishAt = null, CancellationToken cancellationToken = default);
    Task<Result> DeleteAsync(int id, CancellationToken cancellationToken = default);
    Task<Result> RestoreAsync(int id, CancellationToken cancellationToken = default);
    Task<Result> PermanentlyDeleteArticleAsync(int id, CancellationToken cancellationToken = default);
    Task<Result<int>> ClearTrashAsync(CancellationToken cancellationToken = default);
    Task<Result<IReadOnlyList<ArticleListCoreModel>>> SearchArticlesAsync(string keyword, CancellationToken cancellationToken = default);
    Task<Result<IReadOnlyList<PopularArticleCoreModel>>> GetHotArticlesAsync(int count = 10, CancellationToken cancellationToken = default);
    Task<Result<IReadOnlyList<FeaturedArticleCoreModel>>> GetFeaturedArticlesAsync(int count, CancellationToken cancellationToken = default);
    ValueTask<Result> IncreaseViewCountAsync(int id);
    ValueTask<Result<IReadOnlySet<int>>> IncreaseViewCountsAsync(
        IReadOnlyDictionary<int, int> articleCounts,
        CancellationToken cancellationToken = default);
}
