using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;

namespace FsusBlog.Server.Infrastructure.CoreBridge.Adapters;

public sealed class ArticleServiceCoreAdapter(IArticleCoreService core) : IArticleService
{
    public async Task<PageResultDto<ArticleListDto>> GetPageListAsync(int page, int size, int? categoryId, int? tagId, bool isDeleted = false)
    {
        var result = await core.GetPageListAsync(page, size, categoryId, tagId, isDeleted);
        if (!result.IsSuccess)
        {
            return new PageResultDto<ArticleListDto> { Items = [], Total = 0 };
        }

        var dtoItems = new List<ArticleListDto>(result.Value.Items.Count);
        foreach (var item in result.Value.Items)
        {
            dtoItems.Add(ToArticleListDto(item));
        }

        return new PageResultDto<ArticleListDto> { Items = dtoItems, Total = result.Value.Total };
    }

    public async Task<Article?> GetByIdAsync(int id)
    {
        var result = await core.GetByIdAsync(id);
        if (!result.IsSuccess || result.Value is null)
        {
            return null;
        }

        return ToArticleEntity(result.Value.Value);
    }

    public async Task<int> CreateAsync(ArticleDto dto)
    {
        var result = await core.CreateAsync(dto.Title, dto.Content, dto.Summary, dto.CategoryId, dto.TagIds);
        return result.IsSuccess && result.Value > 0 ? result.Value : 0;
    }

    public async Task<bool> UpdateAsync(int id, ArticleDto dto)
        => (await core.UpdateAsync(id, dto.Title, dto.Content, dto.Summary, dto.CategoryId, dto.TagIds)).IsSuccess;

    public async Task<bool> DeleteAsync(int id) => (await core.DeleteAsync(id)).IsSuccess;

    public async Task<bool> RestoreAsync(int id) => (await core.RestoreAsync(id)).IsSuccess;

    public async Task<bool> PermanentlyDeleteArticleAsync(int id) => (await core.PermanentlyDeleteArticleAsync(id)).IsSuccess;

    public async Task<int> ClearTrashAsync()
    {
        var result = await core.ClearTrashAsync();
        return result.IsSuccess ? result.Value : 0;
    }

    public async Task<List<ArticleListDto>> SearchArticlesAsync(string keyword)
    {
        var result = await core.SearchArticlesAsync(keyword);
        if (!result.IsSuccess)
        {
            return [];
        }

        var value = result.Value;
        if (value is null)
        {
            return [];
        }

        var list = new List<ArticleListDto>(value.Count);
        foreach (var item in value)
        {
            list.Add(ToArticleListDto(item));
        }

        return list;
    }

    public async Task<List<PopularArticleDto>> GetHotArticlesAsync(int count = 10)
    {
        var result = await core.GetHotArticlesAsync(count);
        if (!result.IsSuccess)
        {
            return [];
        }

        var value = result.Value;
        if (value is null)
        {
            return [];
        }

        var list = new List<PopularArticleDto>(value.Count);
        foreach (var item in value)
        {
            list.Add(new PopularArticleDto { Id = item.Id, Title = item.Title, Views = item.Views });
        }

        return list;
    }

    public async ValueTask IncreaseViewCountAsync(int id) => _ = await core.IncreaseViewCountAsync(id);

    private static ArticleListDto ToArticleListDto(ArticleListCoreModel model)
    {
        return new ArticleListDto
        {
            Id = model.Id,
            Title = model.Title,
            Summary = model.Summary,
            Snippet = model.Snippet,
            Views = model.Views,
            CreateTime = model.CreateTime,
            Category = new ArticleCategoryView(model.Category.Id, model.Category.Name),
            Tags = model.Tags.Select(t => new TagDto(t.Id, t.Name)).ToList(),
            IsDeleted = model.IsDeleted
        };
    }

    private static Article ToArticleEntity(ArticleDetailCoreModel model)
    {
        return new Article
        {
            Id = model.Id,
            Title = model.Title,
            Content = model.Content,
            Summary = model.Summary,
            Views = model.Views,
            CreateTime = model.CreateTime,
            CategoryId = model.CategoryId,
            IsDeleted = model.IsDeleted,
            Category = new Category { Id = model.Category.Id, Name = model.Category.Name },
            Tags = model.Tags.Select(t => new Tag { Id = t.Id, Name = t.Name }).ToList()
        };
    }
}
