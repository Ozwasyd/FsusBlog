using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;

namespace FsusBlog.Core.Services.Abstractions;

public interface IArticleCoreService
{
    Task<Result<CorePageResult<ArticleListCoreModel>>> GetPageListAsync(int page, int size, int? categoryId, int? tagId, bool isDeleted);
    Task<Result<ArticleDetailCoreModel?>> GetByIdAsync(int id);
    Task<Result<int>> CreateAsync(string title, string content, string? summary, int categoryId, IReadOnlyList<int> tagIds);
    Task<Result> UpdateAsync(int id, string title, string content, string? summary, int categoryId, IReadOnlyList<int> tagIds);
    Task<Result> DeleteAsync(int id);
    Task<Result> RestoreAsync(int id);
    Task<Result> PermanentlyDeleteArticleAsync(int id);
    Task<Result<int>> ClearTrashAsync();
    Task<Result<IReadOnlyList<ArticleListCoreModel>>> SearchArticlesAsync(string keyword);
    Task<Result<IReadOnlyList<PopularArticleCoreModel>>> GetHotArticlesAsync(int count = 10);
    ValueTask<Result> IncreaseViewCountAsync(int id);
}
