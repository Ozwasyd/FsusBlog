using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Core.Services.Gateways;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Services;

public partial class ArticleService
{
    async Task<CorePageResult<ArticleListCoreModel>> IArticleCoreGateway.GetPageListAsync(
        ArticlePageQuery query,
        CancellationToken cancellationToken)
    {
        if (query.Page < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(query), query.Page, "Article list page must be greater than zero.");
        }

        if (query.Size < 1 || query.Size > MaxPageSize)
        {
            throw new ArgumentOutOfRangeException(nameof(query), query.Size, $"Article list size must be between 1 and {MaxPageSize}.");
        }

        ArticleListPageReadModel source;
        bool isPublicList = !query.IsDeleted && !query.IncludePrivate && !query.Status.HasValue;
        if (isPublicList && ((query.Page == 1) == query.Cursor.HasValue))
        {
            throw new ArgumentException("Public article list page/cursor shape is invalid.", nameof(query));
        }

        string normalizedKeyword = NormalizeArticleListKeyword(query.Keyword);
        if (!Enum.IsDefined(query.Sort)
            || (!isPublicList && query.Sort != ArticleListSortMode.Latest)
            || (normalizedKeyword.Length == 0 && query.Sort != ArticleListSortMode.Latest))
        {
            throw new ArgumentException("Article list sort is invalid for this query.", nameof(query));
        }

        if (query.UseSourceCache && !query.Cursor.HasValue && !isPublicList)
        {
            source = await GetPageListAsync(
                query.Page,
                query.Size,
                query.CategoryId,
                query.TagId,
                query.IsDeleted,
                query.Status,
                query.IncludePrivate,
                query.Keyword,
                cancellationToken);
        }
        else
        {
            CancellationToken effectiveCt = ResolveCancellationToken(cancellationToken);
            long version = query.ListCacheVersion ?? await GetListCacheVersionAsync(effectiveCt);
            source = await _dbConcurrencyGate.ExecuteAsync(
                "article-list-frame-source",
                gateCt => LoadArticleListPageFromDbAsync(
                    version,
                    query.Page,
                    query.Size,
                    query.CategoryId,
                    query.TagId,
                    query.IsDeleted,
                    query.Status,
                    query.IncludePrivate,
                    normalizedKeyword,
                    query.Cursor,
                    query.Sort,
                    gateCt),
                _ => Task.FromException<ArticleListPageReadModel>(
                    new TimeoutException($"db-gate-timeout:article-list-frame-source:{query.Page}:{query.Size}")),
                effectiveCt);
        }

        return new CorePageResult<ArticleListCoreModel>(
            ToCoreListModels(source.Items),
            source.Total,
            source.NextCursor,
            source.HasMore);
    }

    async Task<ArticleDetailCoreModel?> IArticleCoreGateway.GetByIdAsync(
        ArticleDetailQuery query,
        CancellationToken cancellationToken)
    {
        ArticleDetailReadModel? source = await GetByIdAsync(query.Id, query.IncludePrivate, cancellationToken);
        return source is null ? null : ArticleProjection.ToCoreDetailModel(source);
    }

    Task<int> IArticleCoreGateway.CreateAsync(CreateArticleCommand command, CancellationToken cancellationToken)
        => CreateAsync(command.Article, cancellationToken);

    async Task<bool> IArticleCoreGateway.UpdateAsync(UpdateArticleCommand command, CancellationToken cancellationToken)
        => await UpdateAsync(
                command.Id,
                command.Article,
                command.Intent == ArticleUpdateIntent.Rollback ? ArticlePublicationTransitionKinds.Rollback : null,
                command.Force,
                command.Rollback,
                captureExecution: null,
                cancellationToken)
            .ConfigureAwait(false);

    Task<bool> IArticleCoreGateway.DeleteAsync(ArticleIdCommand command, CancellationToken cancellationToken)
        => DeleteAsync(command.Id, cancellationToken);

    Task<bool> IArticleCoreGateway.RestoreAsync(ArticleIdCommand command, CancellationToken cancellationToken)
        => RestoreAsync(command.Id, cancellationToken);

    Task<bool> IArticleCoreGateway.PermanentlyDeleteArticleAsync(ArticleIdCommand command, CancellationToken cancellationToken)
        => PermanentlyDeleteArticleAsync(command.Id, cancellationToken);

    Task<int> IArticleCoreGateway.ClearTrashAsync(CancellationToken cancellationToken)
        => ClearTrashAsync(cancellationToken);

    async Task<IReadOnlyList<ArticleListCoreModel>> IArticleCoreGateway.SearchArticlesAsync(
        ArticleSearchQuery query,
        CancellationToken cancellationToken)
        => ToCoreListModels(await SearchArticlesAsync(query.Keyword, cancellationToken));

    async Task<IReadOnlyList<PopularArticleCoreModel>> IArticleCoreGateway.GetHotArticlesAsync(
        ArticleCountQuery query,
        CancellationToken cancellationToken)
    {
        IReadOnlyList<PopularArticleSummaryDto> source = await GetHotArticlesAsync(query.Count, cancellationToken);
        return source.Select(static item => new PopularArticleCoreModel(
            PodProjector.ProjectPopularArticle(item.Id, item.Title, item.Views),
            item.Id,
            item.Title,
            item.Views)).ToArray();
    }

    async Task<IReadOnlyList<FeaturedArticleCoreModel>> IArticleCoreGateway.GetFeaturedArticlesAsync(
        ArticleCountQuery query,
        CancellationToken cancellationToken)
    {
        IReadOnlyList<FeaturedArticleSummaryDto> source = await GetFeaturedArticlesAsync(query.Count, cancellationToken);
        return source.Select(static item => new FeaturedArticleCoreModel(
            item.Id,
            item.Title,
            item.CoverImageUrl,
            item.Views,
            item.CreateTime,
            new ArticleCategoryCoreModel(item.Category.Id, item.Category.Name))).ToArray();
    }

    ValueTask IArticleCoreGateway.IncreaseViewCountAsync(
        ArticleViewCountCommand command,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return IncreaseViewCountAsync(command.ArticleId, command.Count);
    }

    ValueTask<IReadOnlySet<int>> IArticleCoreGateway.IncreaseViewCountsAsync(
        ArticleViewCountBatchCommand command,
        CancellationToken cancellationToken)
        => IncreaseViewCountsAsync(command.ArticleCounts, cancellationToken);

    private static IReadOnlyList<ArticleListCoreModel> ToCoreListModels(IReadOnlyList<ArticleListItemReadModel> source)
    {
        var items = new ArticleListCoreModel[source.Count];
        for (int i = 0; i < source.Count; i++)
        {
            items[i] = ArticleProjection.ToCoreListModel(source[i]);
        }

        return items;
    }
}
