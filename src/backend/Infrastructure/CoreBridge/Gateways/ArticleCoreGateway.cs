using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Core.Services.Gateways;
using FsusBlog.Server.Infrastructure.CoreBridge.Caching;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Services;

namespace FsusBlog.Server.Infrastructure.CoreBridge.Gateways;

public sealed class ArticleCoreGateway(ArticleService service, ArticleCoreQueryCache queryCache) : IArticleCoreGateway
{
    public async Task<CorePageResult<ArticleListCoreModel>> GetPageListAsync(int page, int size, int? categoryId, int? tagId, bool isDeleted, int? status = null, bool includePrivate = false, string? keyword = null, long? listCacheVersion = null, CancellationToken cancellationToken = default)
    {
        string normalizedKeyword = NormalizeArticleListKeyword(keyword);
        return await queryCache.GetOrLoadPageListAsync(
            page,
            size,
            categoryId,
            tagId,
            isDeleted,
            status,
            includePrivate,
            normalizedKeyword,
            listCacheVersion,
            ct => LoadPageListAsync(page, size, categoryId, tagId, isDeleted, status, includePrivate, normalizedKeyword, ct),
            cancellationToken);
    }

    public async Task<ArticleDetailCoreModel?> GetByIdAsync(
        int id,
        bool includePrivate = false,
        CancellationToken cancellationToken = default)
    {
        if (includePrivate)
        {
            ArticleDetailReadModel? privateEntity = await service.GetByIdAsync(id, includePrivate: true, cancellationToken: cancellationToken);
            return privateEntity is null ? null : ArticleProjection.ToCoreDetailModel(privateEntity);
        }

        return await queryCache.GetOrLoadByIdAsync(id, async ct =>
        {
            ArticleDetailReadModel? entity = await service.GetByIdAsync(id, cancellationToken: ct);
            return entity is null ? null : ArticleProjection.ToCoreDetailModel(entity);
        }, cancellationToken);
    }

    public Task<int> CreateAsync(string title, string content, string? summary, string? coverImageUrl, int categoryId, IReadOnlyList<int> tagIds, int status = 2, DateTime? scheduledPublishAt = null, CancellationToken cancellationToken = default)
        => service.CreateAsync(new CreateArticleRequest
        {
            Title = title,
            Content = content,
            Summary = summary,
            CoverImageUrl = coverImageUrl,
            CategoryId = categoryId,
            TagIds = CopyTagIds(tagIds),
            Status = ToArticleStatus(status),
            ScheduledPublishAt = scheduledPublishAt
        }, cancellationToken);

    public Task<bool> UpdateAsync(int id, string title, string content, string? summary, string? coverImageUrl, int categoryId, IReadOnlyList<int> tagIds, int status = 2, DateTime? scheduledPublishAt = null, CancellationToken cancellationToken = default)
        => service.UpdateAsync(id, new UpdateArticleRequest
        {
            Title = title,
            Content = content,
            Summary = summary,
            CoverImageUrl = coverImageUrl,
            CategoryId = categoryId,
            TagIds = CopyTagIds(tagIds),
            Status = ToArticleStatus(status),
            ScheduledPublishAt = scheduledPublishAt
        }, cancellationToken);

    public Task<bool> DeleteAsync(int id, CancellationToken cancellationToken = default) => service.DeleteAsync(id, cancellationToken);
    public Task<bool> RestoreAsync(int id, CancellationToken cancellationToken = default) => service.RestoreAsync(id, cancellationToken);
    public Task<bool> PermanentlyDeleteArticleAsync(int id, CancellationToken cancellationToken = default) => service.PermanentlyDeleteArticleAsync(id, cancellationToken);
    public Task<int> ClearTrashAsync(CancellationToken cancellationToken = default) => service.ClearTrashAsync(cancellationToken);

    public async Task<IReadOnlyList<ArticleListCoreModel>> SearchArticlesAsync(
        string keyword,
        CancellationToken cancellationToken = default)
    {
        return await queryCache.GetOrLoadSearchAsync(keyword, ct => LoadSearchAsync(keyword, ct), cancellationToken);
    }

    public async Task<IReadOnlyList<PopularArticleCoreModel>> GetHotArticlesAsync(
        int count,
        CancellationToken cancellationToken = default)
    {
        return await queryCache.GetOrLoadHotArticlesAsync(count, ct => LoadHotArticlesAsync(count, ct), cancellationToken);
    }

    public async Task<IReadOnlyList<FeaturedArticleCoreModel>> GetFeaturedArticlesAsync(
        int count,
        CancellationToken cancellationToken = default)
    {
        return await queryCache.GetOrLoadFeaturedArticlesAsync(count, async ct =>
        {
            IReadOnlyList<FeaturedArticleSummaryDto> source = await service.GetFeaturedArticlesAsync(count, ct);
            return ToFeaturedCoreModels(source);
        }, cancellationToken);
    }

    public ValueTask IncreaseViewCountAsync(int id) => service.IncreaseViewCountAsync(id);

    public ValueTask<IReadOnlySet<int>> IncreaseViewCountsAsync(
        IReadOnlyDictionary<int, int> articleCounts,
        CancellationToken cancellationToken = default)
        => service.IncreaseViewCountsAsync(articleCounts, cancellationToken);

    private async Task<CorePageResult<ArticleListCoreModel>> LoadPageListAsync(
        int page,
        int size,
        int? categoryId,
        int? tagId,
        bool isDeleted,
        int? status,
        bool includePrivate,
        string keyword,
        CancellationToken cancellationToken)
    {
        ArticleListPageReadModel source = await service.GetPageListAsync(page, size, categoryId, tagId, isDeleted, status, includePrivate, keyword, cancellationToken);
        return new CorePageResult<ArticleListCoreModel>(ToCoreListModels(source.Items), source.Total);
    }

    private async Task<IReadOnlyList<ArticleListCoreModel>> LoadSearchAsync(string keyword, CancellationToken cancellationToken)
    {
        IReadOnlyList<ArticleListItemReadModel> source = await service.SearchArticlesAsync(keyword, cancellationToken);
        return ToCoreListModels(source);
    }

    private async Task<IReadOnlyList<PopularArticleCoreModel>> LoadHotArticlesAsync(int count, CancellationToken cancellationToken)
    {
        IReadOnlyList<PopularArticleSummaryDto> source = await service.GetHotArticlesAsync(count, cancellationToken);
        return source.Select(item => new PopularArticleCoreModel(
            PodProjector.ProjectPopularArticle(item.Id, item.Title, item.Views),
            item.Id,
            item.Title,
            item.Views)).ToList();
    }

    private static FeaturedArticleCoreModel ToFeaturedCoreModel(FeaturedArticleSummaryDto item)
        => new(
            item.Id,
            item.Title,
            item.CoverImageUrl,
            item.Views,
            item.CreateTime,
            new ArticleCategoryCoreModel(item.Category.Id, item.Category.Name));

    private static ArticleStatus ToArticleStatus(int status)
        => ArticleStatusProjection.Normalize(status);

    private static string NormalizeArticleListKeyword(string? keyword)
        => string.IsNullOrWhiteSpace(keyword) ? string.Empty : keyword.Trim()[..Math.Min(keyword.Trim().Length, 80)];

    private static List<int>? CopyTagIds(IReadOnlyList<int> tagIds)
    {
        if (tagIds.Count == 0)
        {
            return null;
        }

        var copy = new List<int>(tagIds.Count);
        for (int i = 0; i < tagIds.Count; i++)
        {
            copy.Add(tagIds[i]);
        }

        return copy;
    }

    private static List<ArticleListCoreModel> ToCoreListModels(IReadOnlyList<ArticleListItemReadModel> source)
    {
        var items = new List<ArticleListCoreModel>(source.Count);
        for (int i = 0; i < source.Count; i++)
        {
            items.Add(ArticleProjection.ToCoreListModel(source[i]));
        }

        return items;
    }

    private static List<FeaturedArticleCoreModel> ToFeaturedCoreModels(IReadOnlyList<FeaturedArticleSummaryDto> source)
    {
        var items = new List<FeaturedArticleCoreModel>(source.Count);
        for (int i = 0; i < source.Count; i++)
        {
            items.Add(ToFeaturedCoreModel(source[i]));
        }

        return items;
    }
}
