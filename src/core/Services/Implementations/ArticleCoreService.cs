using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Core.Services.Gateways;

namespace FsusBlog.Core.Services.Implementations;

public sealed class ArticleCoreService(
    IArticleCoreGateway gateway,
    TimeProvider? timeProvider = null) : IArticleCoreService
{
    private const int MaxPageSize = 100;
    private readonly TimeProvider _timeProvider = timeProvider ?? TimeProvider.System;

    public async Task<Result<CorePageResult<ArticleListCoreModel>>> GetPageListAsync(ArticlePageQuery query, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (query.Page <= 0 || query.Size <= 0 || query.Size > MaxPageSize)
        {
            return Result<CorePageResult<ArticleListCoreModel>>.Failure(ErrorCode.Validation, "分页参数非法");
        }

        if (query.Status is < 0 or > 4)
        {
            return Result<CorePageResult<ArticleListCoreModel>>.Failure(ErrorCode.Validation, "文章状态非法");
        }

        return Result<CorePageResult<ArticleListCoreModel>>.Success(await gateway.GetPageListAsync(query, cancellationToken));
    }

    public async Task<Result<ArticleDetailCoreModel?>> GetByIdAsync(ArticleDetailQuery query, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (query.Id <= 0)
        {
            return Result<ArticleDetailCoreModel?>.Failure(ErrorCode.Validation, "文章ID非法");
        }

        var data = await gateway.GetByIdAsync(query, cancellationToken);
        return data is null
            ? Result<ArticleDetailCoreModel?>.Failure(ErrorCode.NotFound, "文章不存在")
            : Result<ArticleDetailCoreModel?>.Success(data);
    }

    public async Task<Result<int>> CreateAsync(CreateArticleCommand command, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArticleWriteRequestCoreModel article = command.Article;
        if (string.IsNullOrWhiteSpace(article.Title) || string.IsNullOrWhiteSpace(article.Content) || article.CategoryId <= 0)
        {
            return Result<int>.Failure(ErrorCode.Validation, "发布参数非法");
        }

        ArticleStatusTransitionValidation? statusValidation = ArticleStatusTransitionPolicy.ValidateTarget(
            article.Status,
            article.ScheduledPublishAt,
            _timeProvider.GetUtcNow().UtcDateTime);
        if (statusValidation.HasValue)
        {
            return Result<int>.Failure(ToError(statusValidation.Value));
        }

        int id;
        try
        {
            id = await gateway.CreateAsync(command, cancellationToken);
        }
        catch (ArticleStatusTransitionValidationException ex)
        {
            return Result<int>.Failure(ToError(ex.Validation));
        }
        return id > 0
            ? Result<int>.Success(id)
            : Result<int>.Failure(ErrorCode.InfraFailure, "文章创建失败");
    }

    public async Task<Result> UpdateAsync(UpdateArticleCommand command, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArticleWriteRequestCoreModel article = command.Article;
        if (command.Id <= 0 || string.IsNullOrWhiteSpace(article.Title) || string.IsNullOrWhiteSpace(article.Content) || article.CategoryId <= 0)
        {
            return Result.Failure(ErrorCode.Validation, "更新参数非法");
        }

        ArticleStatusTransitionValidation? statusValidation = ArticleStatusTransitionPolicy.ValidateTarget(
            article.Status,
            article.ScheduledPublishAt,
            _timeProvider.GetUtcNow().UtcDateTime);
        if (statusValidation.HasValue)
        {
            return Result.Failure(ToError(statusValidation.Value));
        }

        try
        {
            return await gateway.UpdateAsync(command, cancellationToken)
                ? Result.Success()
                : Result.Failure(ErrorCode.NotFound, "文章不存在或更新失败");
        }
        catch (ArticleStatusTransitionValidationException ex)
        {
            return Result.Failure(ToError(ex.Validation));
        }
    }

    public async Task<Result> DeleteAsync(ArticleIdCommand command, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (command.Id <= 0)
        {
            return Result.Failure(ErrorCode.Validation, "文章ID非法");
        }

        return await gateway.DeleteAsync(command, cancellationToken)
            ? Result.Success()
            : Result.Failure(ErrorCode.NotFound, "文章不存在或删除失败");
    }

    public async Task<Result> RestoreAsync(ArticleIdCommand command, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (command.Id <= 0)
        {
            return Result.Failure(ErrorCode.Validation, "文章ID非法");
        }

        try
        {
            return await gateway.RestoreAsync(command, cancellationToken)
                ? Result.Success()
                : Result.Failure(ErrorCode.NotFound, "文章不存在或恢复失败");
        }
        catch (ArticleStatusTransitionValidationException ex)
        {
            return Result.Failure(ToError(ex.Validation));
        }
    }

    public async Task<Result> PermanentlyDeleteArticleAsync(ArticleIdCommand command, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (command.Id <= 0)
        {
            return Result.Failure(ErrorCode.Validation, "文章ID非法");
        }

        return await gateway.PermanentlyDeleteArticleAsync(command, cancellationToken)
            ? Result.Success()
            : Result.Failure(ErrorCode.NotFound, "文章不存在或彻底删除失败");
    }

    public async Task<Result<int>> ClearTrashAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var count = await gateway.ClearTrashAsync(cancellationToken);
        return Result<int>.Success(count);
    }

    private static ErrorDetail ToError(ArticleStatusTransitionValidation validation)
        => ErrorDetail.Create(
            ErrorCode.Validation,
            validation.Message,
            details: validation.Code);

    public async Task<Result<IReadOnlyList<ArticleListCoreModel>>> SearchArticlesAsync(ArticleSearchQuery query, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(query.Keyword))
        {
            return Result<IReadOnlyList<ArticleListCoreModel>>.Failure(ErrorCode.Validation, "关键词不能为空");
        }

        return Result<IReadOnlyList<ArticleListCoreModel>>.Success(await gateway.SearchArticlesAsync(query, cancellationToken));
    }

    public async Task<Result<IReadOnlyList<PopularArticleCoreModel>>> GetHotArticlesAsync(ArticleCountQuery query, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (query.Count <= 0)
        {
            return Result<IReadOnlyList<PopularArticleCoreModel>>.Failure(ErrorCode.Validation, "数量参数非法");
        }

        return Result<IReadOnlyList<PopularArticleCoreModel>>.Success(await gateway.GetHotArticlesAsync(query, cancellationToken));
    }

    public async Task<Result<IReadOnlyList<FeaturedArticleCoreModel>>> GetFeaturedArticlesAsync(ArticleCountQuery query, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (query.Count <= 0)
        {
            return Result<IReadOnlyList<FeaturedArticleCoreModel>>.Failure(ErrorCode.Validation, "数量参数非法");
        }

        return Result<IReadOnlyList<FeaturedArticleCoreModel>>.Success(await gateway.GetFeaturedArticlesAsync(query, cancellationToken));
    }

    public async ValueTask<Result> IncreaseViewCountAsync(ArticleViewCountCommand command, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (command.ArticleId <= 0 || command.Count <= 0)
        {
            return Result.Failure(ErrorCode.Validation, "文章ID非法");
        }

        await gateway.IncreaseViewCountAsync(command, cancellationToken);
        return Result.Success();
    }

    public async ValueTask<Result<IReadOnlySet<int>>> IncreaseViewCountsAsync(ArticleViewCountBatchCommand command, CancellationToken cancellationToken = default)
    {
        IReadOnlyDictionary<int, int> articleCounts = command.ArticleCounts;
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

        IReadOnlySet<int> updated = await gateway.IncreaseViewCountsAsync(new ArticleViewCountBatchCommand(normalized), cancellationToken);
        return Result<IReadOnlySet<int>>.Success(updated);
    }
}
