using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Infrastructure.Cache;
using System.Globalization;

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
        Func<CancellationToken, Task<CorePageResult<ArticleListCoreModel>>> loader,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        long version = listCacheVersion ?? await GetListCacheVersionAsync(cancellationToken);
        string scope = includePrivate ? "admin" : "public";
        string identity = BuildArticleListIdentity(scope, version, page, size, categoryId, tagId, isDeleted, status, keyword);
        var hit = await cache.TryGetAsync(CachePolicyId.ArticleList, identity, DecodeArticlePage, cancellationToken);
        if (hit.Hit && hit.Value is not null)
        {
            return hit.Value.GetValueOrDefault();
        }

        await using IAsyncDisposable guard = await cache.AcquireSingleFlightAsync(CachePolicyId.ArticleList, identity, cancellationToken);
        hit = await cache.TryGetAsync(CachePolicyId.ArticleList, identity, DecodeArticlePage, cancellationToken);
        if (hit.Hit && hit.Value is not null)
        {
            return hit.Value.GetValueOrDefault();
        }

        CorePageResult<ArticleListCoreModel> loaded = await loader(cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        byte[] encoded = PodBinaryCodec.EncodeArticlePage(loaded);
        cancellationToken.ThrowIfCancellationRequested();
        await cache.SetRawAsync(CachePolicyId.ArticleList, identity, encoded, TimeSpan.FromMinutes(10), cancellationToken);
        return loaded;
    }

    public async Task<ArticleDetailCoreModel?> GetOrLoadByIdAsync(
        int id,
        Func<CancellationToken, Task<ArticleDetailCoreModel?>> loader,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string identity = BuildArticleDetailIdentity(id);
        var cached = await cache.TryGetAsync(CachePolicyId.ArticleDetail, identity, DecodeArticleDetail, cancellationToken);
        if (cached.Hit)
        {
            return cached.Value;
        }

        await using IAsyncDisposable guard = await cache.AcquireSingleFlightAsync(CachePolicyId.ArticleDetail, identity, cancellationToken);
        cached = await cache.TryGetAsync(CachePolicyId.ArticleDetail, identity, DecodeArticleDetail, cancellationToken);
        if (cached.Hit)
        {
            return cached.Value;
        }

        ArticleDetailCoreModel? loaded = await loader(cancellationToken);
        if (loaded is null)
        {
            return null;
        }

        ArticleDetailCoreModel value = loaded.Value;
        cancellationToken.ThrowIfCancellationRequested();
        byte[] encoded = PodBinaryCodec.EncodeArticleDetail(value);
        cancellationToken.ThrowIfCancellationRequested();
        await cache.SetRawAsync(CachePolicyId.ArticleDetail, identity, encoded, TimeSpan.FromHours(1), cancellationToken);
        return value;
    }

    public async Task<IReadOnlyList<ArticleListCoreModel>> GetOrLoadSearchAsync(
        string keyword,
        Func<CancellationToken, Task<IReadOnlyList<ArticleListCoreModel>>> loader,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return await loader(cancellationToken).ConfigureAwait(false);
    }

    public async Task<IReadOnlyList<PopularArticleCoreModel>> GetOrLoadHotArticlesAsync(
        int count,
        Func<CancellationToken, Task<IReadOnlyList<PopularArticleCoreModel>>> loader,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string identity = hotArticlesVersionProvider.BuildVersionedHotArticlesIdentity(BuildHotArticlesBaseIdentity(count));
        var hit = await cache.TryGetAsync(CachePolicyId.ArticleHot, identity, DecodePopularArticles, cancellationToken);
        if (hit.Hit)
        {
            return hit.Value ?? Array.Empty<PopularArticleCoreModel>();
        }

        await using IAsyncDisposable guard = await cache.AcquireSingleFlightAsync(CachePolicyId.ArticleHot, identity, cancellationToken);
        hit = await cache.TryGetAsync(CachePolicyId.ArticleHot, identity, DecodePopularArticles, cancellationToken);
        if (hit.Hit)
        {
            return hit.Value ?? Array.Empty<PopularArticleCoreModel>();
        }

        IReadOnlyList<PopularArticleCoreModel> loaded = await loader(cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        byte[] encoded = PodBinaryCodec.EncodePopularArticles(loaded);
        cancellationToken.ThrowIfCancellationRequested();
        await cache.SetRawAsync(CachePolicyId.ArticleHot, identity, encoded, TimeSpan.FromMinutes(10), cancellationToken);
        return loaded;
    }

    public async Task<IReadOnlyList<FeaturedArticleCoreModel>> GetOrLoadFeaturedArticlesAsync(
        int count,
        Func<CancellationToken, Task<IReadOnlyList<FeaturedArticleCoreModel>>> loader,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string identity = BuildFeaturedArticlesIdentity(count);
        var hit = await cache.TryGetAsync(CachePolicyId.TopArticles, identity, DecodeFeaturedArticles, cancellationToken);
        if (hit.Hit)
        {
            return hit.Value ?? Array.Empty<FeaturedArticleCoreModel>();
        }

        await using IAsyncDisposable guard = await cache.AcquireSingleFlightAsync(CachePolicyId.TopArticles, identity, cancellationToken);
        hit = await cache.TryGetAsync(CachePolicyId.TopArticles, identity, DecodeFeaturedArticles, cancellationToken);
        if (hit.Hit)
        {
            return hit.Value ?? Array.Empty<FeaturedArticleCoreModel>();
        }

        IReadOnlyList<FeaturedArticleCoreModel> loaded = await loader(cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        byte[] encoded = PodBinaryCodec.EncodeFeaturedArticleCoreList(loaded);
        cancellationToken.ThrowIfCancellationRequested();
        await cache.SetRawAsync(CachePolicyId.TopArticles, identity, encoded, TimeSpan.FromHours(2), cancellationToken);
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

    private async ValueTask<long> GetListCacheVersionAsync(CancellationToken cancellationToken)
    {
        string? version = await cache.GetStringAsync(CachePolicyId.ArticleListVersion, "main", cancellationToken);
        return long.TryParse(version, out long parsed) ? parsed : 0;
    }

    internal static string BuildArticleListIdentity(
        string scope,
        long version,
        int page,
        int size,
        int? categoryId,
        int? tagId,
        bool isDeleted,
        int? status,
        string keyword)
        => string.Create(
            CultureInfo.InvariantCulture,
            $"core:v4:{scope}:{version}:{page}:{size}:{categoryId ?? 0}:{tagId ?? 0}:{(isDeleted ? 1 : 0)}:{status ?? -1}:{keyword}");

    internal static string BuildArticleDetailIdentity(int id)
        => string.Create(CultureInfo.InvariantCulture, $"core:v3:{id}");

    internal static string BuildHotArticlesBaseIdentity(int count)
        => string.Create(CultureInfo.InvariantCulture, $"core:v2:{count}");

    internal static string BuildFeaturedArticlesIdentity(int count)
        => string.Create(CultureInfo.InvariantCulture, $"core:v2:featured:{count}");
}
