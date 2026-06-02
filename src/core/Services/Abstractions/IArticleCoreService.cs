using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;

namespace FsusBlog.Core.Services.Abstractions;

public interface IArticleCoreService
{
    Task<Result<CorePageResult<ArticleListCoreModel>>> GetPageListAsync(int page, int size, int? categoryId, int? tagId, bool isDeleted, int? status = null, bool includePrivate = false, string? keyword = null);
    Task<Result<ArticleDetailCoreModel?>> GetByIdAsync(int id, bool includePrivate = false);
    Task<Result<int>> CreateAsync(string title, string content, string? summary, string? coverImageUrl, int categoryId, IReadOnlyList<int> tagIds, int status = 2, DateTime? scheduledPublishAt = null);
    Task<Result> UpdateAsync(int id, string title, string content, string? summary, string? coverImageUrl, int categoryId, IReadOnlyList<int> tagIds, int status = 2, DateTime? scheduledPublishAt = null);
    Task<Result> DeleteAsync(int id);
    Task<Result> RestoreAsync(int id);
    Task<Result> PermanentlyDeleteArticleAsync(int id);
    Task<Result<int>> ClearTrashAsync();
    Task<Result<IReadOnlyList<ArticleListCoreModel>>> SearchArticlesAsync(string keyword);
    Task<Result<IReadOnlyList<PopularArticleCoreModel>>> GetHotArticlesAsync(int count = 10);
    Task<Result<IReadOnlyList<FeaturedArticleCoreModel>>> GetFeaturedArticlesAsync(int count);
    ValueTask<Result> IncreaseViewCountAsync(int id);
}
