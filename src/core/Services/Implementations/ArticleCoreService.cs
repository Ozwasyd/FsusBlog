using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Core.Services.Gateways;

namespace FsusBlog.Core.Services.Implementations;

public sealed class ArticleCoreService(IArticleCoreGateway gateway) : IArticleCoreService
{
    public async Task<Result<CorePageResult<ArticleListCoreModel>>> GetPageListAsync(int page, int size, int? categoryId, int? tagId, bool isDeleted, int? status = null, bool includePrivate = false, string? keyword = null, long? listCacheVersion = null)
    {
        if (page <= 0 || size <= 0)
        {
            return Result<CorePageResult<ArticleListCoreModel>>.Failure(ErrorCode.Validation, "分页参数非法");
        }

        if (status is < 0 or > 4)
        {
            return Result<CorePageResult<ArticleListCoreModel>>.Failure(ErrorCode.Validation, "文章状态非法");
        }

        return Result<CorePageResult<ArticleListCoreModel>>.Success(await gateway.GetPageListAsync(page, size, categoryId, tagId, isDeleted, status, includePrivate, keyword, listCacheVersion));
    }

    public async Task<Result<ArticleDetailCoreModel?>> GetByIdAsync(int id, bool includePrivate = false)
    {
        if (id <= 0)
        {
            return Result<ArticleDetailCoreModel?>.Failure(ErrorCode.Validation, "文章ID非法");
        }

        var data = await gateway.GetByIdAsync(id, includePrivate);
        return data is null
            ? Result<ArticleDetailCoreModel?>.Failure(ErrorCode.NotFound, "文章不存在")
            : Result<ArticleDetailCoreModel?>.Success(data);
    }

    public async Task<Result<int>> CreateAsync(string title, string content, string? summary, string? coverImageUrl, int categoryId, IReadOnlyList<int> tagIds, int status = 2, DateTime? scheduledPublishAt = null)
    {
        if (string.IsNullOrWhiteSpace(title) || string.IsNullOrWhiteSpace(content) || categoryId <= 0)
        {
            return Result<int>.Failure(ErrorCode.Validation, "发布参数非法");
        }

        if (status is < 0 or > 4)
        {
            return Result<int>.Failure(ErrorCode.Validation, "文章状态非法");
        }

        var id = await gateway.CreateAsync(title, content, summary, coverImageUrl, categoryId, tagIds, status, scheduledPublishAt);
        return id > 0
            ? Result<int>.Success(id)
            : Result<int>.Failure(ErrorCode.InfraFailure, "文章创建失败");
    }

    public async Task<Result> UpdateAsync(int id, string title, string content, string? summary, string? coverImageUrl, int categoryId, IReadOnlyList<int> tagIds, int status = 2, DateTime? scheduledPublishAt = null)
    {
        if (id <= 0 || string.IsNullOrWhiteSpace(title) || string.IsNullOrWhiteSpace(content) || categoryId <= 0)
        {
            return Result.Failure(ErrorCode.Validation, "更新参数非法");
        }

        if (status is < 0 or > 4)
        {
            return Result.Failure(ErrorCode.Validation, "文章状态非法");
        }

        return await gateway.UpdateAsync(id, title, content, summary, coverImageUrl, categoryId, tagIds, status, scheduledPublishAt)
            ? Result.Success()
            : Result.Failure(ErrorCode.NotFound, "文章不存在或更新失败");
    }

    public async Task<Result> DeleteAsync(int id)
    {
        if (id <= 0)
        {
            return Result.Failure(ErrorCode.Validation, "文章ID非法");
        }

        return await gateway.DeleteAsync(id)
            ? Result.Success()
            : Result.Failure(ErrorCode.NotFound, "文章不存在或删除失败");
    }

    public async Task<Result> RestoreAsync(int id)
    {
        if (id <= 0)
        {
            return Result.Failure(ErrorCode.Validation, "文章ID非法");
        }

        return await gateway.RestoreAsync(id)
            ? Result.Success()
            : Result.Failure(ErrorCode.NotFound, "文章不存在或恢复失败");
    }

    public async Task<Result> PermanentlyDeleteArticleAsync(int id)
    {
        if (id <= 0)
        {
            return Result.Failure(ErrorCode.Validation, "文章ID非法");
        }

        return await gateway.PermanentlyDeleteArticleAsync(id)
            ? Result.Success()
            : Result.Failure(ErrorCode.NotFound, "文章不存在或彻底删除失败");
    }

    public async Task<Result<int>> ClearTrashAsync()
    {
        var count = await gateway.ClearTrashAsync();
        return Result<int>.Success(count);
    }

    public async Task<Result<IReadOnlyList<ArticleListCoreModel>>> SearchArticlesAsync(string keyword)
    {
        if (string.IsNullOrWhiteSpace(keyword))
        {
            return Result<IReadOnlyList<ArticleListCoreModel>>.Failure(ErrorCode.Validation, "关键词不能为空");
        }

        return Result<IReadOnlyList<ArticleListCoreModel>>.Success(await gateway.SearchArticlesAsync(keyword));
    }

    public async Task<Result<IReadOnlyList<PopularArticleCoreModel>>> GetHotArticlesAsync(int count = 10)
    {
        if (count <= 0)
        {
            return Result<IReadOnlyList<PopularArticleCoreModel>>.Failure(ErrorCode.Validation, "数量参数非法");
        }

        return Result<IReadOnlyList<PopularArticleCoreModel>>.Success(await gateway.GetHotArticlesAsync(count));
    }

    public async Task<Result<IReadOnlyList<FeaturedArticleCoreModel>>> GetFeaturedArticlesAsync(int count)
    {
        if (count <= 0)
        {
            return Result<IReadOnlyList<FeaturedArticleCoreModel>>.Failure(ErrorCode.Validation, "数量参数非法");
        }

        return Result<IReadOnlyList<FeaturedArticleCoreModel>>.Success(await gateway.GetFeaturedArticlesAsync(count));
    }

    public async ValueTask<Result> IncreaseViewCountAsync(int id)
    {
        if (id <= 0)
        {
            return Result.Failure(ErrorCode.Validation, "文章ID非法");
        }

        await gateway.IncreaseViewCountAsync(id);
        return Result.Success();
    }

    public async ValueTask<Result<IReadOnlySet<int>>> IncreaseViewCountsAsync(
        IReadOnlyDictionary<int, int> articleCounts,
        CancellationToken cancellationToken = default)
    {
        if (articleCounts is null || articleCounts.Count == 0)
        {
            return Result<IReadOnlySet<int>>.Success(new HashSet<int>());
        }

        Dictionary<int, int> normalized = new(articleCounts.Count);
        foreach ((int articleId, int count) in articleCounts)
        {
            if (articleId <= 0)
            {
                return Result<IReadOnlySet<int>>.Failure(ErrorCode.Validation, "文章ID非法");
            }

            if (count < 0)
            {
                return Result<IReadOnlySet<int>>.Failure(ErrorCode.Validation, "阅读量增量非法");
            }

            if (count == 0)
            {
                continue;
            }

            normalized[articleId] = normalized.TryGetValue(articleId, out int existing)
                ? checked(existing + count)
                : count;
        }

        if (normalized.Count == 0)
        {
            return Result<IReadOnlySet<int>>.Success(new HashSet<int>());
        }

        IReadOnlySet<int> updated = await gateway.IncreaseViewCountsAsync(normalized, cancellationToken);
        return Result<IReadOnlySet<int>>.Success(updated);
    }
}
