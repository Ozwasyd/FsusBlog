using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Infrastructure.Cache;

namespace FsusBlog.Server.Infrastructure.CoreBridge.Caching;

public sealed class ArticleCoreQueryCache(IUnifiedCache cache, IHotArticlesCacheVersionProvider hotArticlesVersionProvider)
{
    public async Task<CorePageResult<ArticleListCoreModel>> GetOrLoadPageListAsync(
        int page,
        int size,
        int? categoryId,
        int? tagId,
        bool isDeleted,
        int? status,
        bool includePrivate,
        string keyword,
        long? listCacheVersion,
        Func<Task<CorePageResult<ArticleListCoreModel>>> loader)
    {
        long version = listCacheVersion ?? await GetListCacheVersionAsync();
        string scope = includePrivate ? "admin" : "public";
        string identity = $"core:v4:{scope}:{version}:{page}:{size}:{categoryId ?? 0}:{tagId ?? 0}:{(isDeleted ? 1 : 0)}:{status ?? -1}:{keyword}";
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

        CorePageResult<ArticleListCoreModel> loaded = await loader();
        await cache.SetRawAsync(CachePolicyId.ArticleList, identity, PodBinaryCodec.EncodeArticlePage(loaded), TimeSpan.FromMinutes(10));
        return loaded;
    }

    public async Task<ArticleDetailCoreModel?> GetOrLoadByIdAsync(int id, Func<Task<ArticleDetailCoreModel?>> loader)
    {
        string identity = $"core:v3:{id}";
        var cached = await cache.TryGetAsync(CachePolicyId.ArticleDetail, identity, DecodeArticleDetail);
        if (cached.Hit)
        {
            return cached.Value;
        }

        await using IAsyncDisposable guard = await cache.AcquireSingleFlightAsync(CachePolicyId.ArticleDetail, identity);
        cached = await cache.TryGetAsync(CachePolicyId.ArticleDetail, identity, DecodeArticleDetail);
        if (cached.Hit)
        {
            return cached.Value;
        }

        ArticleDetailCoreModel? loaded = await loader();
        if (loaded is null)
        {
            return null;
        }

        ArticleDetailCoreModel value = loaded.Value;
        await cache.SetRawAsync(CachePolicyId.ArticleDetail, identity, PodBinaryCodec.EncodeArticleDetail(value), TimeSpan.FromHours(1));
        return value;
    }

    public async Task<IReadOnlyList<ArticleListCoreModel>> GetOrLoadSearchAsync(string keyword, Func<Task<IReadOnlyList<ArticleListCoreModel>>> loader)
    {
        string identity = $"core:v2:{keyword}";
        var hit = await cache.TryGetAsync(CachePolicyId.ArticleSearch, identity, DecodeArticleSearch);
        if (hit.Hit)
        {
            return hit.Value ?? Array.Empty<ArticleListCoreModel>();
        }

        await using IAsyncDisposable guard = await cache.AcquireSingleFlightAsync(CachePolicyId.ArticleSearch, identity);
        hit = await cache.TryGetAsync(CachePolicyId.ArticleSearch, identity, DecodeArticleSearch);
        if (hit.Hit)
        {
            return hit.Value ?? Array.Empty<ArticleListCoreModel>();
        }

        IReadOnlyList<ArticleListCoreModel> loaded = await loader();
        await cache.SetRawAsync(CachePolicyId.ArticleSearch, identity, PodBinaryCodec.EncodeArticleSearch(loaded), TimeSpan.FromMinutes(10));
        return loaded;
    }

    public async Task<IReadOnlyList<PopularArticleCoreModel>> GetOrLoadHotArticlesAsync(int count, Func<Task<IReadOnlyList<PopularArticleCoreModel>>> loader)
    {
        string identity = hotArticlesVersionProvider.BuildVersionedHotArticlesIdentity($"core:v2:{count}");
        var hit = await cache.TryGetAsync(CachePolicyId.ArticleHot, identity, DecodePopularArticles);
        if (hit.Hit)
        {
            return hit.Value ?? Array.Empty<PopularArticleCoreModel>();
        }

        await using IAsyncDisposable guard = await cache.AcquireSingleFlightAsync(CachePolicyId.ArticleHot, identity);
        hit = await cache.TryGetAsync(CachePolicyId.ArticleHot, identity, DecodePopularArticles);
        if (hit.Hit)
        {
            return hit.Value ?? Array.Empty<PopularArticleCoreModel>();
        }

        IReadOnlyList<PopularArticleCoreModel> loaded = await loader();
        await cache.SetRawAsync(CachePolicyId.ArticleHot, identity, PodBinaryCodec.EncodePopularArticles(loaded), TimeSpan.FromMinutes(10));
        return loaded;
    }

    public async Task<IReadOnlyList<FeaturedArticleCoreModel>> GetOrLoadFeaturedArticlesAsync(int count, Func<Task<IReadOnlyList<FeaturedArticleCoreModel>>> loader)
    {
        string identity = $"core:v2:featured:{count}";
        var hit = await cache.TryGetAsync(CachePolicyId.TopArticles, identity, DecodeFeaturedArticles);
        if (hit.Hit)
        {
            return hit.Value ?? Array.Empty<FeaturedArticleCoreModel>();
        }

        await using IAsyncDisposable guard = await cache.AcquireSingleFlightAsync(CachePolicyId.TopArticles, identity);
        hit = await cache.TryGetAsync(CachePolicyId.TopArticles, identity, DecodeFeaturedArticles);
        if (hit.Hit)
        {
            return hit.Value ?? Array.Empty<FeaturedArticleCoreModel>();
        }

        IReadOnlyList<FeaturedArticleCoreModel> loaded = await loader();
        await cache.SetRawAsync(CachePolicyId.TopArticles, identity, PodBinaryCodec.EncodeFeaturedArticleCoreList(loaded), TimeSpan.FromHours(2));
        return loaded;
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

    private static (bool Success, IReadOnlyList<FeaturedArticleCoreModel>? Value) DecodeFeaturedArticles(ReadOnlyMemory<byte> bytes)
    {
        bool success = PodBinaryCodec.TryDecodeFeaturedArticleCoreList(bytes, out IReadOnlyList<FeaturedArticleCoreModel> value);
        return (success, success ? value : default);
    }

    private async ValueTask<long> GetListCacheVersionAsync()
    {
        string? version = await cache.GetStringAsync(CachePolicyId.ArticleListVersion, "main");
        return long.TryParse(version, out long parsed) ? parsed : 0;
    }
}
