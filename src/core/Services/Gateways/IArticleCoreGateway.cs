using FsusBlog.Core.Mapping.Models;

namespace FsusBlog.Core.Services.Gateways;

public interface IArticleCoreGateway
{
    Task<CorePageResult<ArticleListCoreModel>> GetPageListAsync(int page, int size, int? categoryId, int? tagId, bool isDeleted, int? status = null, bool includePrivate = false, string? keyword = null, long? listCacheVersion = null, CancellationToken cancellationToken = default);
    Task<ArticleDetailCoreModel?> GetByIdAsync(int id, bool includePrivate = false, CancellationToken cancellationToken = default);
    Task<int> CreateAsync(string title, string content, string? summary, string? coverImageUrl, int categoryId, IReadOnlyList<int> tagIds, int status = 2, DateTime? scheduledPublishAt = null);
    Task<bool> UpdateAsync(int id, string title, string content, string? summary, string? coverImageUrl, int categoryId, IReadOnlyList<int> tagIds, int status = 2, DateTime? scheduledPublishAt = null);
    Task<bool> DeleteAsync(int id);
    Task<bool> RestoreAsync(int id);
    Task<bool> PermanentlyDeleteArticleAsync(int id);
    Task<int> ClearTrashAsync();
    Task<IReadOnlyList<ArticleListCoreModel>> SearchArticlesAsync(string keyword, CancellationToken cancellationToken = default);
    Task<IReadOnlyList<PopularArticleCoreModel>> GetHotArticlesAsync(int count, CancellationToken cancellationToken = default);
    Task<IReadOnlyList<FeaturedArticleCoreModel>> GetFeaturedArticlesAsync(int count, CancellationToken cancellationToken = default);
    ValueTask IncreaseViewCountAsync(int id);
    ValueTask<IReadOnlySet<int>> IncreaseViewCountsAsync(
        IReadOnlyDictionary<int, int> articleCounts,
        CancellationToken cancellationToken = default);
}
