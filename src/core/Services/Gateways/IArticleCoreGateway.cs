using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Articles;

namespace FsusBlog.Core.Services.Gateways;

public interface IArticleCoreGateway
{
    Task<CorePageResult<ArticleListCoreModel>> GetPageListAsync(ArticlePageQuery query, CancellationToken cancellationToken = default);
    Task<ArticleDetailCoreModel?> GetByIdAsync(ArticleDetailQuery query, CancellationToken cancellationToken = default);
    Task<int> CreateAsync(CreateArticleCommand command, CancellationToken cancellationToken = default);
    Task<bool> UpdateAsync(UpdateArticleCommand command, CancellationToken cancellationToken = default);
    Task<bool> DeleteAsync(ArticleIdCommand command, CancellationToken cancellationToken = default);
    Task<bool> RestoreAsync(ArticleIdCommand command, CancellationToken cancellationToken = default);
    Task<bool> PermanentlyDeleteArticleAsync(ArticleIdCommand command, CancellationToken cancellationToken = default);
    Task<int> ClearTrashAsync(CancellationToken cancellationToken = default);
    Task<IReadOnlyList<ArticleListCoreModel>> SearchArticlesAsync(ArticleSearchQuery query, CancellationToken cancellationToken = default);
    Task<IReadOnlyList<PopularArticleCoreModel>> GetHotArticlesAsync(ArticleCountQuery query, CancellationToken cancellationToken = default);
    Task<IReadOnlyList<FeaturedArticleCoreModel>> GetFeaturedArticlesAsync(ArticleCountQuery query, CancellationToken cancellationToken = default);
    ValueTask IncreaseViewCountAsync(ArticleViewCountCommand command, CancellationToken cancellationToken = default);
    ValueTask<IReadOnlySet<int>> IncreaseViewCountsAsync(ArticleViewCountBatchCommand command, CancellationToken cancellationToken = default);
}
