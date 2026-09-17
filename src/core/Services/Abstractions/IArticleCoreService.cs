using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Articles;

namespace FsusBlog.Core.Services.Abstractions;

public interface IArticleCoreService
{
    Task<Result<CorePageResult<ArticleListCoreModel>>> GetPageListAsync(ArticlePageQuery query, CancellationToken cancellationToken = default);
    Task<Result<ArticleDetailCoreModel?>> GetByIdAsync(ArticleDetailQuery query, CancellationToken cancellationToken = default);
    Task<Result<int>> CreateAsync(CreateArticleCommand command, CancellationToken cancellationToken = default);
    Task<Result> UpdateAsync(UpdateArticleCommand command, CancellationToken cancellationToken = default);
    Task<Result> DeleteAsync(ArticleIdCommand command, CancellationToken cancellationToken = default);
    Task<Result> RestoreAsync(ArticleIdCommand command, CancellationToken cancellationToken = default);
    Task<Result> PermanentlyDeleteArticleAsync(ArticleIdCommand command, CancellationToken cancellationToken = default);
    Task<Result<int>> ClearTrashAsync(CancellationToken cancellationToken = default);
    Task<Result<IReadOnlyList<ArticleListCoreModel>>> SearchArticlesAsync(ArticleSearchQuery query, CancellationToken cancellationToken = default);
    Task<Result<IReadOnlyList<PopularArticleCoreModel>>> GetHotArticlesAsync(ArticleCountQuery query, CancellationToken cancellationToken = default);
    Task<Result<IReadOnlyList<FeaturedArticleCoreModel>>> GetFeaturedArticlesAsync(ArticleCountQuery query, CancellationToken cancellationToken = default);
    ValueTask<Result> IncreaseViewCountAsync(ArticleViewCountCommand command, CancellationToken cancellationToken = default);
    ValueTask<Result<IReadOnlySet<int>>> IncreaseViewCountsAsync(ArticleViewCountBatchCommand command, CancellationToken cancellationToken = default);
}
