using FsusBlog.Core.Mapping.Models;

namespace FsusBlog.Core.Services.Gateways;

public interface ILegacyArticleGateway
{
    Task<CorePageResult<ArticleListCoreModel>> GetPageListAsync(int page, int size, int? categoryId, int? tagId, bool isDeleted);
    Task<ArticleDetailCoreModel?> GetByIdAsync(int id);
    Task<int> CreateAsync(string title, string content, string? summary, int categoryId, IReadOnlyList<int> tagIds);
    Task<bool> UpdateAsync(int id, string title, string content, string? summary, int categoryId, IReadOnlyList<int> tagIds);
    Task<bool> DeleteAsync(int id);
    Task<bool> RestoreAsync(int id);
    Task<bool> PermanentlyDeleteArticleAsync(int id);
    Task<int> ClearTrashAsync();
    Task<IReadOnlyList<ArticleListCoreModel>> SearchArticlesAsync(string keyword);
    Task<IReadOnlyList<PopularArticleCoreModel>> GetHotArticlesAsync(int count);
    ValueTask IncreaseViewCountAsync(int id);
}
