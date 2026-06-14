using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Models.Requests;

namespace FsusBlog.Server.Infrastructure.CoreBridge.Adapters;

public sealed class ArticleServiceCoreAdapter(IArticleCoreService core) : IArticleService
{
    public async Task<ArticleListPageReadModel> GetPageListAsync(int page, int size, int? categoryId, int? tagId, bool isDeleted = false, int? status = null, bool includePrivate = false, string? keyword = null, CancellationToken cancellationToken = default)
    {
        var result = await core.GetPageListAsync(page, size, categoryId, tagId, isDeleted, status, includePrivate, keyword, cancellationToken: cancellationToken);
        if (!result.IsSuccess)
        {
            return new ArticleListPageReadModel { Items = [], Total = 0 };
        }

        return new ArticleListPageReadModel
        {
            Items = ToArticleListReadModels(result.Value.Items),
            Total = result.Value.Total
        };
    }

    public async Task<ArticleDetailReadModel?> GetByIdAsync(int id, bool includePrivate = false, CancellationToken cancellationToken = default)
    {
        var result = await core.GetByIdAsync(id, includePrivate, cancellationToken);
        if (!result.IsSuccess || result.Value is null)
        {
            return null;
        }

        return ToArticleDetailReadModel(result.Value.Value);
    }

    public async Task<int> CreateAsync(CreateArticleRequest dto)
    {
        var result = await core.CreateAsync(dto.Title, dto.Content, dto.Summary, dto.CoverImageUrl, dto.CategoryId, TagIdsOrEmpty(dto.TagIds), (int)dto.Status, dto.ScheduledPublishAt);
        return result.IsSuccess && result.Value > 0 ? result.Value : 0;
    }

    public async Task<bool> UpdateAsync(int id, UpdateArticleRequest dto)
        => (await core.UpdateAsync(id, dto.Title, dto.Content, dto.Summary, dto.CoverImageUrl, dto.CategoryId, TagIdsOrEmpty(dto.TagIds), (int)dto.Status, dto.ScheduledPublishAt)).IsSuccess;

    public async Task<bool> DeleteAsync(int id) => (await core.DeleteAsync(id)).IsSuccess;

    public async Task<bool> RestoreAsync(int id) => (await core.RestoreAsync(id)).IsSuccess;

    public async Task<bool> PermanentlyDeleteArticleAsync(int id) => (await core.PermanentlyDeleteArticleAsync(id)).IsSuccess;

    public async Task<int> ClearTrashAsync()
    {
        var result = await core.ClearTrashAsync();
        return result.IsSuccess ? result.Value : 0;
    }

    public async Task<List<ArticleListItemReadModel>> SearchArticlesAsync(string keyword, CancellationToken cancellationToken = default)
    {
        var result = await core.SearchArticlesAsync(keyword, cancellationToken);
        if (!result.IsSuccess || result.Value is null)
        {
            return [];
        }

        return ToArticleListReadModels(result.Value);
    }

    public async Task<List<PopularArticleSummaryDto>> GetHotArticlesAsync(int count = 10, CancellationToken cancellationToken = default)
    {
        var result = await core.GetHotArticlesAsync(count, cancellationToken);
        if (!result.IsSuccess || result.Value is null)
        {
            return [];
        }

        var items = new List<PopularArticleSummaryDto>(result.Value.Count);
        for (int i = 0; i < result.Value.Count; i++)
        {
            PopularArticleCoreModel item = result.Value[i];
            items.Add(new PopularArticleSummaryDto(item.Id, item.Title, item.Views));
        }

        return items;
    }

    public async Task<List<FeaturedArticleSummaryDto>> GetFeaturedArticlesAsync(int size, CancellationToken cancellationToken = default)
    {
        int count = size switch
        {
            < 1 => 3,
            > 20 => 20,
            _ => size
        };
        var result = await core.GetFeaturedArticlesAsync(count, cancellationToken);
        return result.IsSuccess && result.Value is not null
            ? ToFeaturedArticleSummaryDtos(result.Value)
            : [];
    }

    public async ValueTask IncreaseViewCountAsync(int id) => _ = await core.IncreaseViewCountAsync(id);

    public async ValueTask IncreaseViewCountAsync(int id, int count)
    {
        if (count <= 0)
        {
            return;
        }

        _ = await core.IncreaseViewCountsAsync(new Dictionary<int, int> { [id] = count });
    }

    public async ValueTask<IReadOnlySet<int>> IncreaseViewCountsAsync(
        IReadOnlyDictionary<int, int> articleCounts,
        CancellationToken cancellationToken = default)
    {
        if (articleCounts.Count == 0)
        {
            return new HashSet<int>();
        }

        var result = await core.IncreaseViewCountsAsync(articleCounts, cancellationToken);
        return result.IsSuccess && result.Value is not null
            ? result.Value
            : new HashSet<int>();
    }

    private static ArticleListItemReadModel ToArticleListReadModel(ArticleListCoreModel model)
    {
        return new ArticleListItemReadModel
        {
            Id = model.Id,
            Title = model.Title,
            Summary = model.Summary,
            Snippet = model.Snippet,
            CoverImageUrl = model.CoverImageUrl,
            Views = model.Views,
            CreateTime = model.CreateTime,
            CategoryId = model.Category.Id,
            CategoryName = model.Category.Name,
            Tags = ToTagReadModels(model.Tags),
            IsDeleted = model.IsDeleted,
            Status = ToArticleStatus(model.Status),
            ScheduledPublishAt = model.ScheduledPublishAt,
            PublishedAt = model.PublishedAt
        };
    }

    private static ArticleDetailReadModel ToArticleDetailReadModel(ArticleDetailCoreModel model)
    {
        return new ArticleDetailReadModel
        {
            Id = model.Id,
            Title = model.Title,
            Content = model.Content,
            Summary = model.Summary,
            CoverImageUrl = model.CoverImageUrl,
            Views = model.Views,
            WordCount = model.WordCount,
            EstimatedReadingMinutes = model.EstimatedReadingMinutes,
            ShowReadingNotice = model.ShowReadingNotice,
            CreateTime = model.CreateTime,
            CategoryId = model.CategoryId,
            CategoryName = model.Category.Name,
            Tags = ToTagReadModels(model.Tags),
            IsDeleted = model.IsDeleted,
            Status = ToArticleStatus(model.Status),
            ScheduledPublishAt = model.ScheduledPublishAt,
            PublishedAt = model.PublishedAt
        };
    }

    private static ArticleStatus ToArticleStatus(int status)
        => ArticleStatusProjection.Normalize(status);

    private static IReadOnlyList<int> TagIdsOrEmpty(List<int>? tagIds)
        => tagIds is null ? Array.Empty<int>() : tagIds;

    private static FeaturedArticleSummaryDto ToFeaturedArticleSummaryDto(FeaturedArticleCoreModel model)
        => new(
            model.Id,
            model.Title,
            model.CoverImageUrl,
            model.Views,
            model.CreateTime,
            new ArticleCategoryView(model.Category.Id, model.Category.Name));

    private static List<ArticleListItemReadModel> ToArticleListReadModels(IReadOnlyList<ArticleListCoreModel> source)
    {
        var items = new List<ArticleListItemReadModel>(source.Count);
        for (int i = 0; i < source.Count; i++)
        {
            items.Add(ToArticleListReadModel(source[i]));
        }

        return items;
    }

    private static List<FeaturedArticleSummaryDto> ToFeaturedArticleSummaryDtos(IReadOnlyList<FeaturedArticleCoreModel> source)
    {
        var items = new List<FeaturedArticleSummaryDto>(source.Count);
        for (int i = 0; i < source.Count; i++)
        {
            items.Add(ToFeaturedArticleSummaryDto(source[i]));
        }

        return items;
    }

    private static IReadOnlyList<TagReadModel> ToTagReadModels(IReadOnlyList<TagCoreModel> source)
    {
        if (source.Count == 0)
        {
            return ArticleReadModelCollections.EmptyTags;
        }

        var tags = new TagReadModel[source.Count];
        for (int i = 0; i < source.Count; i++)
        {
            TagCoreModel tag = source[i];
            tags[i] = new TagReadModel { Id = tag.Id, Name = tag.Name };
        }

        return tags;
    }
}
