using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Core.Services.Gateways;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services;

namespace FsusBlog.Server.Infrastructure.CoreBridge.Gateways;

public sealed class LegacyArticleGateway(ArticleService legacy, ICacheManager cacheManager) : ILegacyArticleGateway
{
    public async Task<CorePageResult<ArticleListCoreModel>> GetPageListAsync(int page, int size, int? categoryId, int? tagId, bool isDeleted)
    {
        string key = CacheKeyBuilder.ArticleList(page, size, categoryId, tagId, isDeleted);
        var result = await cacheManager.GetOrLoadAsync(
            key,
            PodBinaryCodec.TryDecodeArticlePage,
            PodBinaryCodec.EncodeArticlePage,
            _ => LoadPageListAsync(page, size, categoryId, tagId, isDeleted),
            TimeSpan.FromMinutes(10));

        return result.Value;
    }

    public async Task<ArticleDetailCoreModel?> GetByIdAsync(int id)
    {
        string key = CacheKeyBuilder.ArticleDetail(id);
        Result<ArticleDetailCoreModel> cache = await cacheManager.TryGetAsync<ArticleDetailCoreModel>(key, PodBinaryCodec.TryDecodeArticleDetail);
        if (cache.IsSuccess)
        {
            return cache.Value;
        }

        Article? entity = await legacy.GetByIdAsync(id);
        if (entity is null)
        {
            return null;
        }

        ArticleDetailCoreModel mapped = MapDetail(entity);
        _ = cacheManager.SetAsync(key, mapped, PodBinaryCodec.EncodeArticleDetail, TimeSpan.FromHours(1));
        return mapped;
    }

    public Task<int> CreateAsync(string title, string content, string? summary, int categoryId, IReadOnlyList<int> tagIds)
    {
        var dto = new ArticleDto
        {
            Title = title,
            Content = content,
            Summary = summary,
            CategoryId = categoryId,
            TagIds = [.. tagIds]
        };

        return legacy.CreateAsync(dto);
    }

    public Task<bool> UpdateAsync(int id, string title, string content, string? summary, int categoryId, IReadOnlyList<int> tagIds)
    {
        var dto = new ArticleDto
        {
            Title = title,
            Content = content,
            Summary = summary,
            CategoryId = categoryId,
            TagIds = [.. tagIds]
        };

        return legacy.UpdateAsync(id, dto);
    }

    public Task<bool> DeleteAsync(int id) => legacy.DeleteAsync(id);

    public Task<bool> RestoreAsync(int id) => legacy.RestoreAsync(id);

    public Task<bool> PermanentlyDeleteArticleAsync(int id) => legacy.PermanentlyDeleteArticleAsync(id);

    public Task<int> ClearTrashAsync() => legacy.ClearTrashAsync();

    public async Task<IReadOnlyList<ArticleListCoreModel>> SearchArticlesAsync(string keyword)
    {
        string key = CacheKeyBuilder.ArticleSearch(keyword);
        var result = await cacheManager.GetOrLoadAsync(
            key,
            PodBinaryCodec.TryDecodeArticleSearch,
            PodBinaryCodec.EncodeArticleSearch,
            _ => LoadSearchAsync(keyword),
            TimeSpan.FromMinutes(10));

        return result.Value ?? Array.Empty<ArticleListCoreModel>();
    }

    public async Task<IReadOnlyList<PopularArticleCoreModel>> GetHotArticlesAsync(int count)
    {
        string key = CacheKeyBuilder.ArticleHot(count);
        var result = await cacheManager.GetOrLoadAsync(
            key,
            PodBinaryCodec.TryDecodePopularArticles,
            PodBinaryCodec.EncodePopularArticles,
            _ => LoadHotArticlesAsync(count),
            TimeSpan.FromMinutes(10));

        return result.Value ?? Array.Empty<PopularArticleCoreModel>();
    }

    public ValueTask IncreaseViewCountAsync(int id) => legacy.IncreaseViewCountAsync(id);

    private async Task<CorePageResult<ArticleListCoreModel>> LoadPageListAsync(int page, int size, int? categoryId, int? tagId, bool isDeleted)
    {
        PageResultDto<ArticleListDto> source = await legacy.GetPageListAsync(page, size, categoryId, tagId, isDeleted);
        var items = new List<ArticleListCoreModel>(source.Items.Count);

        foreach (ArticleListDto item in source.Items)
        {
            items.Add(MapList(item));
        }

        return new CorePageResult<ArticleListCoreModel>(items, source.Total);
    }

    private async Task<IReadOnlyList<ArticleListCoreModel>> LoadSearchAsync(string keyword)
    {
        IReadOnlyList<ArticleListDto> source = await legacy.SearchArticlesAsync(keyword);
        var list = new List<ArticleListCoreModel>(source.Count);

        foreach (ArticleListDto item in source)
        {
            list.Add(MapList(item));
        }

        return list;
    }

    private async Task<IReadOnlyList<PopularArticleCoreModel>> LoadHotArticlesAsync(int count)
    {
        IReadOnlyList<PopularArticleDto> source = await legacy.GetHotArticlesAsync(count);
        var list = new List<PopularArticleCoreModel>(source.Count);

        foreach (PopularArticleDto item in source)
        {
            list.Add(new PopularArticleCoreModel(
                PodProjector.ProjectPopularArticle(item.Id, item.Title, item.Views),
                item.Id,
                item.Title,
                item.Views));
        }

        return list;
    }

    private static ArticleListCoreModel MapList(ArticleListDto item)
    {
        var pod = PodProjector.ProjectArticleList(
            item.Id,
            item.Views,
            item.CreateTime,
            item.Category.Id,
            item.Category.Name,
            item.Title,
            item.Summary,
            item.Snippet,
            item.IsDeleted,
            out _);

        var tags = new List<TagCoreModel>(item.Tags.Count);
        foreach (TagDto tag in item.Tags)
        {
            tags.Add(new TagCoreModel(tag.Id, tag.Name));
        }

        return new ArticleListCoreModel(
            pod,
            item.Id,
            item.Title,
            item.Summary,
            item.Snippet,
            item.Views,
            item.CreateTime,
            new ArticleCategoryCoreModel(item.Category.Id, item.Category.Name),
            tags,
            item.IsDeleted);
    }

    private static ArticleDetailCoreModel MapDetail(Article entity)
    {
        var pod = PodProjector.ProjectArticleDetail(
            entity.Id,
            entity.Views,
            entity.CreateTime,
            entity.CategoryId,
            entity.Category?.Name ?? "默认分类",
            entity.Title,
            entity.Content,
            entity.Summary,
            out _);

        var tags = new List<TagCoreModel>(entity.Tags.Count);
        foreach (Tag tag in entity.Tags)
        {
            tags.Add(new TagCoreModel(tag.Id, tag.Name));
        }

        return new ArticleDetailCoreModel(
            pod,
            entity.Id,
            entity.Title,
            entity.Content,
            entity.Summary,
            entity.Views,
            entity.CreateTime,
            new ArticleCategoryCoreModel(entity.CategoryId, entity.Category?.Name ?? "默认分类"),
            tags,
            entity.CategoryId,
            entity.IsDeleted);
    }
}
