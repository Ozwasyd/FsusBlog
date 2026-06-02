using FsusBlog.Core.Mapping.Models;

namespace FsusBlog.Core.Services.Gateways;

public interface IArticleCoreGateway
{
    Task<CorePageResult<ArticleListCoreModel>> GetPageListAsync(int page, int size, int? categoryId, int? tagId, bool isDeleted, int? status = null, bool includePrivate = false, string? keyword = null);
    Task<ArticleDetailCoreModel?> GetByIdAsync(int id, bool includePrivate = false);
    Task<int> CreateAsync(string title, string content, string? summary, string? coverImageUrl, int categoryId, IReadOnlyList<int> tagIds, int status = 2, DateTime? scheduledPublishAt = null);
    Task<bool> UpdateAsync(int id, string title, string content, string? summary, string? coverImageUrl, int categoryId, IReadOnlyList<int> tagIds, int status = 2, DateTime? scheduledPublishAt = null);
    Task<bool> DeleteAsync(int id);
    Task<bool> RestoreAsync(int id);
    Task<bool> PermanentlyDeleteArticleAsync(int id);
    Task<int> ClearTrashAsync();
    Task<IReadOnlyList<ArticleListCoreModel>> SearchArticlesAsync(string keyword);
    Task<IReadOnlyList<PopularArticleCoreModel>> GetHotArticlesAsync(int count);
    Task<IReadOnlyList<FeaturedArticleCoreModel>> GetFeaturedArticlesAsync(int count);
    ValueTask IncreaseViewCountAsync(int id);
}
