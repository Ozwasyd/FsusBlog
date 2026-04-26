using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Core.Services.Gateways;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Services;

namespace FsusBlog.Server.Infrastructure.CoreBridge.Gateways;

public sealed class ArticleCoreGateway(ArticleService service, IUnifiedCache cache) : IArticleCoreGateway
{
    public async Task<CorePageResult<ArticleListCoreModel>> GetPageListAsync(int page, int size, int? categoryId, int? tagId, bool isDeleted)
    {
        string identity = $"core:{page}:{size}:{categoryId ?? 0}:{tagId ?? 0}:{(isDeleted ? 1 : 0)}";
        var hit = await cache.TryGetAsync(CachePolicyId.ArticleList, identity, DecodeArticlePage);
        if (hit.Hit && hit.Value is not null)
        {
            return hit.Value.GetValueOrDefault();
        }

        await using IAsyncDisposable guard = await cache.AcquireSingleFlightAsync(CachePolicyId.ArticleList, identity);
        hit = await cache.TryGetAsync(CachePolicyId.ArticleList, identity, DecodeArticlePage);
        if (hit.Hit && hit.Value is not null)
        {
            return hit.Value.GetValueOrDefault();
        }

        CorePageResult<ArticleListCoreModel> loaded = await LoadPageListAsync(page, size, categoryId, tagId, isDeleted);
        await cache.SetRawAsync(CachePolicyId.ArticleList, identity, PodBinaryCodec.EncodeArticlePage(loaded), TimeSpan.FromMinutes(10));
        return loaded;
    }

    public async Task<ArticleDetailCoreModel?> GetByIdAsync(int id)
    {
        string identity = $"core:{id}";
        var cached = await cache.TryGetAsync(CachePolicyId.ArticleDetail, identity, DecodeArticleDetail);
        if (cached.Hit)
        {
            return cached.Value;
        }

        ArticleDetailReadModel? entity = await service.GetByIdAsync(id);
        if (entity is null)
        {
            return null;
        }

        ArticleDetailCoreModel mapped = ArticleProjection.ToCoreDetailModel(entity);
        await cache.SetRawAsync(CachePolicyId.ArticleDetail, identity, PodBinaryCodec.EncodeArticleDetail(mapped), TimeSpan.FromHours(1));
        return mapped;
    }

    public Task<int> CreateAsync(string title, string content, string? summary, int categoryId, IReadOnlyList<int> tagIds)
        => service.CreateAsync(new CreateArticleRequest
        {
            Title = title,
            Content = content,
            Summary = summary,
            CategoryId = categoryId,
            TagIds = [.. tagIds]
        });

    public Task<bool> UpdateAsync(int id, string title, string content, string? summary, int categoryId, IReadOnlyList<int> tagIds)
        => service.UpdateAsync(id, new UpdateArticleRequest
        {
            Title = title,
            Content = content,
            Summary = summary,
            CategoryId = categoryId,
            TagIds = [.. tagIds]
        });

    public Task<bool> DeleteAsync(int id) => service.DeleteAsync(id);
    public Task<bool> RestoreAsync(int id) => service.RestoreAsync(id);
    public Task<bool> PermanentlyDeleteArticleAsync(int id) => service.PermanentlyDeleteArticleAsync(id);
    public Task<int> ClearTrashAsync() => service.ClearTrashAsync();

    public async Task<IReadOnlyList<ArticleListCoreModel>> SearchArticlesAsync(string keyword)
    {
        string identity = $"core:{keyword}";
        var hit = await cache.TryGetAsync(CachePolicyId.ArticleSearch, identity, DecodeArticleSearch);
        if (hit.Hit)
        {
            return hit.Value ?? Array.Empty<ArticleListCoreModel>();
        }

        IReadOnlyList<ArticleListCoreModel> loaded = await LoadSearchAsync(keyword);
        await cache.SetRawAsync(CachePolicyId.ArticleSearch, identity, PodBinaryCodec.EncodeArticleSearch(loaded), TimeSpan.FromMinutes(10));
        return loaded;
    }

    public async Task<IReadOnlyList<PopularArticleCoreModel>> GetHotArticlesAsync(int count)
    {
        string identity = $"core:{count}";
        var hit = await cache.TryGetAsync(CachePolicyId.ArticleHot, identity, DecodePopularArticles);
        if (hit.Hit)
        {
            return hit.Value ?? Array.Empty<PopularArticleCoreModel>();
        }

        IReadOnlyList<PopularArticleCoreModel> loaded = await LoadHotArticlesAsync(count);
        await cache.SetRawAsync(CachePolicyId.ArticleHot, identity, PodBinaryCodec.EncodePopularArticles(loaded), TimeSpan.FromMinutes(10));
        return loaded;
    }

    public ValueTask IncreaseViewCountAsync(int id) => service.IncreaseViewCountAsync(id);

    private async Task<CorePageResult<ArticleListCoreModel>> LoadPageListAsync(int page, int size, int? categoryId, int? tagId, bool isDeleted)
    {
        ArticleListPageReadModel source = await service.GetPageListAsync(page, size, categoryId, tagId, isDeleted);
        return new CorePageResult<ArticleListCoreModel>(source.Items.Select(ArticleProjection.ToCoreListModel).ToList(), source.Total);
    }

    private async Task<IReadOnlyList<ArticleListCoreModel>> LoadSearchAsync(string keyword)
    {
        IReadOnlyList<ArticleListItemReadModel> source = await service.SearchArticlesAsync(keyword);
        return source.Select(ArticleProjection.ToCoreListModel).ToList();
    }

    private async Task<IReadOnlyList<PopularArticleCoreModel>> LoadHotArticlesAsync(int count)
    {
        IReadOnlyList<PopularArticleSummaryDto> source = await service.GetHotArticlesAsync(count);
        return source.Select(item => new PopularArticleCoreModel(
            PodProjector.ProjectPopularArticle(item.Id, item.Title, item.Views),
            item.Id,
            item.Title,
            item.Views)).ToList();
    }

    private static (bool Success, CorePageResult<ArticleListCoreModel>? Value) DecodeArticlePage(ReadOnlyMemory<byte> bytes)
    {
        bool success = PodBinaryCodec.TryDecodeArticlePage(bytes, out CorePageResult<ArticleListCoreModel> value);
        return (success, success ? value : default);
    }

    private static (bool Success, ArticleDetailCoreModel? Value) DecodeArticleDetail(ReadOnlyMemory<byte> bytes)
    {
        bool success = PodBinaryCodec.TryDecodeArticleDetail(bytes, out ArticleDetailCoreModel value);
        return (success, success ? value : default);
    }

    private static (bool Success, IReadOnlyList<ArticleListCoreModel>? Value) DecodeArticleSearch(ReadOnlyMemory<byte> bytes)
    {
        bool success = PodBinaryCodec.TryDecodeArticleSearch(bytes, out IReadOnlyList<ArticleListCoreModel> value);
        return (success, success ? value : default);
    }

    private static (bool Success, IReadOnlyList<PopularArticleCoreModel>? Value) DecodePopularArticles(ReadOnlyMemory<byte> bytes)
    {
        bool success = PodBinaryCodec.TryDecodePopularArticles(bytes, out IReadOnlyList<PopularArticleCoreModel> value);
        return (success, success ? value : default);
    }
}
