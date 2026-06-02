using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Models.Requests;

namespace FsusBlog.Server.Infrastructure.CoreBridge.Adapters;

public sealed class ArticleServiceCoreAdapter(IArticleCoreService core) : IArticleService
{
    public async Task<ArticleListPageReadModel> GetPageListAsync(int page, int size, int? categoryId, int? tagId, bool isDeleted = false, int? status = null, bool includePrivate = false, string? keyword = null)
    {
        var result = await core.GetPageListAsync(page, size, categoryId, tagId, isDeleted, status, includePrivate, keyword);
        if (!result.IsSuccess)
        {
            return new ArticleListPageReadModel { Items = [], Total = 0 };
        }

        return new ArticleListPageReadModel
        {
            Items = result.Value.Items.Select(ToArticleListReadModel).ToList(),
            Total = result.Value.Total
        };
    }

    public async Task<ArticleDetailReadModel?> GetByIdAsync(int id, bool includePrivate = false)
    {
        var result = await core.GetByIdAsync(id, includePrivate);
        if (!result.IsSuccess || result.Value is null)
        {
            return null;
        }

        return ToArticleDetailReadModel(result.Value.Value);
    }

    public async Task<int> CreateAsync(CreateArticleRequest dto)
    {
        var result = await core.CreateAsync(dto.Title, dto.Content, dto.Summary, dto.CoverImageUrl, dto.CategoryId, dto.TagIds, (int)dto.Status, dto.ScheduledPublishAt);
        return result.IsSuccess && result.Value > 0 ? result.Value : 0;
    }

    public async Task<bool> UpdateAsync(int id, UpdateArticleRequest dto)
        => (await core.UpdateAsync(id, dto.Title, dto.Content, dto.Summary, dto.CoverImageUrl, dto.CategoryId, dto.TagIds, (int)dto.Status, dto.ScheduledPublishAt)).IsSuccess;

    public async Task<bool> DeleteAsync(int id) => (await core.DeleteAsync(id)).IsSuccess;

    public async Task<bool> RestoreAsync(int id) => (await core.RestoreAsync(id)).IsSuccess;

    public async Task<bool> PermanentlyDeleteArticleAsync(int id) => (await core.PermanentlyDeleteArticleAsync(id)).IsSuccess;

    public async Task<int> ClearTrashAsync()
    {
        var result = await core.ClearTrashAsync();
        return result.IsSuccess ? result.Value : 0;
    }

    public async Task<List<ArticleListItemReadModel>> SearchArticlesAsync(string keyword)
    {
        var result = await core.SearchArticlesAsync(keyword);
        if (!result.IsSuccess || result.Value is null)
        {
            return [];
        }

        return result.Value.Select(ToArticleListReadModel).ToList();
    }

    public async Task<List<PopularArticleSummaryDto>> GetHotArticlesAsync(int count = 10)
    {
        var result = await core.GetHotArticlesAsync(count);
        if (!result.IsSuccess || result.Value is null)
        {
            return [];
        }

        return result.Value.Select(item => new PopularArticleSummaryDto(item.Id, item.Title, item.Views)).ToList();
    }

    public async Task<List<FeaturedArticleSummaryDto>> GetFeaturedArticlesAsync(int size)
    {
        int count = size switch
        {
            < 1 => 3,
            > 20 => 20,
            _ => size
        };
        var result = await core.GetFeaturedArticlesAsync(count);
        return result.IsSuccess && result.Value is not null
            ? result.Value.Select(ToFeaturedArticleSummaryDto).ToList()
            : [];
    }

    public async ValueTask IncreaseViewCountAsync(int id) => _ = await core.IncreaseViewCountAsync(id);

    public async ValueTask IncreaseViewCountAsync(int id, int count)
    {
        for (int i = 0; i < count; i++)
        {
            _ = await core.IncreaseViewCountAsync(id);
        }
    }

    public async ValueTask<IReadOnlySet<int>> IncreaseViewCountsAsync(
        IReadOnlyDictionary<int, int> articleCounts,
        CancellationToken cancellationToken = default)
    {
        var updated = new HashSet<int>();
        foreach ((int articleId, int count) in articleCounts)
        {
            cancellationToken.ThrowIfCancellationRequested();
            for (int i = 0; i < count; i++)
            {
                _ = await core.IncreaseViewCountAsync(articleId);
            }

            if (count > 0)
            {
                updated.Add(articleId);
            }
        }

        return updated;
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
            Tags = model.Tags.Select(t => new TagReadModel { Id = t.Id, Name = t.Name }).ToList(),
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
            Tags = model.Tags.Select(t => new TagReadModel { Id = t.Id, Name = t.Name }).ToList(),
            IsDeleted = model.IsDeleted,
            Status = ToArticleStatus(model.Status),
            ScheduledPublishAt = model.ScheduledPublishAt,
            PublishedAt = model.PublishedAt
        };
    }

    private static ArticleStatus ToArticleStatus(int status)
        => Enum.IsDefined(typeof(ArticleStatus), status) ? (ArticleStatus)status : ArticleStatus.Published;

    private static FeaturedArticleSummaryDto ToFeaturedArticleSummaryDto(FeaturedArticleCoreModel model)
        => new(
            model.Id,
            model.Title,
            model.CoverImageUrl,
            model.Views,
            model.CreateTime,
            new ArticleCategoryView(model.Category.Id, model.Category.Name));
}
